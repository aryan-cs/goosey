//! Bounded owner cancellation and permissionless expired/closed-order cleanup.
//! Existing account layouts and matching rules unchanged.
//! A caller-supplied heap index is a verified HINT, never authorization: match
//! the current order ID, owner seat and canonical side before any mutation.
//! Stale hints fail without consuming a nonce; clients refresh and retry.
//! Root cleanup after close needs no owner cooperation. Each invocation removes
//! exactly one order with <=10 heap levels and <=12 fixed-size cell patches.
//! No book scan/copy, no heap allocation in the transition, no token CPI.
//! All fallible work precedes the first write. Cash release moves reserved to
//! available; share release only removes encumbrances from TOTAL YES/NO holdings.
//! Positions, fees, collateral, accounted vault and ever_traded are untouched.
//! The consumed slot is recycled but IDs/sequences are never reused. Prior fill
//! events/history are immutable; the removal event records residual fee notional.

use anchor_lang::prelude::*;
use crate::{Config, escrow::{Market, SeatLocator, Seats, SEAT_CAPACITY}};
use crate::exchange::{BOOK_BYTES, BOOK_TAG};
use crate::matching::{self, runtime::{Header, Slot, Storage}, Order, Reserve, Side};

const NONE: u16 = u16::MAX;
const MAX_PATCHES: usize = 12;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct OrderTarget {
    pub order_id: u64,
    /// 0 canonical YES bid; 1 canonical YES ask.
    pub side: u8,
    pub heap_index: u16,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CancelOrderArgs { pub target: OrderTarget, pub expected_nonce: u64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault { Binding, StaleTarget, NotOwner, Nonce, NotEligible, Overflow,
    InvalidReserves, InvalidBook, PatchCapacity, Matcher(matching::Error) }
type Checked<T> = core::result::Result<T, Fault>;
impl From<matching::Error> for Fault { fn from(e: matching::Error) -> Self { Self::Matcher(e) } }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Reason { Owner = 0, Expired = 1, MarketClosed = 2 }
#[derive(Clone, Copy, Debug)]
pub struct Removed {
    pub order: Order,
    pub wallet: Pubkey,
    pub released: Reserve,
    pub reason: Reason,
    /// Present ONLY for owner-signed cancellation; keeper never consumes nonce.
    pub nonce: Option<u64>,
    pub revision: u64,
    pub heap_writes: usize,
}
enum Authority<'a> { Owner { wallet: Pubkey, locator: &'a SeatLocator, nonce: u64 }, Keeper { now: i64 } }

#[derive(Clone, Copy, Default)]
struct CellPatch { index: usize, before: u16, after: u16 }
struct RemovalPlan { cells: [CellPatch; MAX_PATCHES], count: usize }
impl RemovalPlan {
    fn new() -> Self { Self { cells: [CellPatch::default(); MAX_PATCHES], count: 0 } }
    fn set(&mut self, heap: &[u16], index: usize, value: u16) -> Checked<()> {
        // Paths do not repeat, but coalesce defensively (tail==target case).
        if let Some(p) = self.cells[..self.count].iter_mut().find(|p| p.index == index) { p.after = value; return Ok(()); }
        if self.count == MAX_PATCHES { return Err(Fault::PatchCapacity); }
        let before = *heap.get(index).ok_or(Fault::InvalidBook)?;
        self.cells[self.count] = CellPatch { index, before, after: value }; self.count += 1;
        Ok(())
    }
    fn validate(&self, heap: &[u16]) -> Checked<()> {
        for p in &self.cells[..self.count] {
            if heap.get(p.index) != Some(&p.before) { return Err(Fault::InvalidBook); }
        }
        Ok(())
    }
    fn apply(&self, heap: &mut [u16]) {
        for p in &self.cells[..self.count] { heap[p.index] = p.after; }
    }
}

fn read_order(slots: &[Slot], index: u16, side: Side, payout: u64) -> Checked<Order> {
    let order = slots.get(usize::from(index)).ok_or(Fault::InvalidBook)?.order()?;
    if order.intent.side() != side || order.id == 0 || order.id != order.sequence
        || order.remaining == 0 || order.remaining > matching::MAX_QUANTITY { return Err(Fault::InvalidBook); }
    order.intent.canonical_price(order.limit_price, payout)?;
    Ok(order)
}
fn better(slots: &[Slot], a: u16, b: u16, side: Side, payout: u64) -> Checked<bool> {
    let a = read_order(slots, a, side, payout)?;
    let b = read_order(slots, b, side, payout)?;
    let ap = a.intent.canonical_price(a.limit_price, payout)?;
    let bp = b.intent.canonical_price(b.limit_price, payout)?;
    Ok(if ap != bp { if side == Side::Bid { ap > bp } else { ap < bp } }
        else { (a.sequence, a.id) < (b.sequence, b.id) })
}

/// Arbitrary heap removal, choosing up OR down repair of the final element.
/// Reads backing storage only; no writes occur until every ledger check passes.
fn plan_removal(heap: &[u16], len: usize, index: usize, slots: &[Slot], side: Side, payout: u64) -> Checked<RemovalPlan> {
    if len == 0 || len > heap.len() || index >= len { return Err(Fault::StaleTarget); }
    let mut p = RemovalPlan::new();
    let last_index = len - 1;
    let last = heap[last_index];
    read_order(slots, last, side, payout)?;
    p.set(heap, last_index, NONE)?;
    if index == last_index { return Ok(p); }
    if last == heap[index] { return Err(Fault::InvalidBook); }
    let mut hole = index;
    let upward = hole > 0 && better(slots, last, heap[(hole - 1) / 2], side, payout)?;
    if upward {
        while hole > 0 {
            let parent = (hole - 1) / 2;
            if !better(slots, last, heap[parent], side, payout)? { break; }
            p.set(heap, hole, heap[parent])?;
            hole = parent;
        }
    } else {
        loop {
            let left = hole * 2 + 1;
            if left >= last_index { break; }
            let mut child = left;
            if left + 1 < last_index && better(slots, heap[left + 1], heap[left], side, payout)? { child += 1; }
            if !better(slots, heap[child], last, side, payout)? { break; }
            p.set(heap, hole, heap[child])?;
            hole = child;
        }
    }
    p.set(heap, hole, last)?;
    Ok(p)
}

/// Caller must authenticate canonical account ownership/addresses. The Anchor
/// context below does so. Core also verifies semantic bindings and owner nonce.
pub fn execute_owner(market_key: Pubkey, wallet: Pubkey, locator: &SeatLocator,
    market: &Market, seats: &mut Seats, book: &mut Storage<'_>, args: CancelOrderArgs) -> Checked<Removed> {
    remove(market_key, market, seats, book, args.target,
        Authority::Owner { wallet, locator, nonce: args.expected_nonce })
}

/// No signing nonce and no artificial time supplied by clients: Anchor passes
/// Clock. Core permits only objectively expired orders or a closed market.
pub fn execute_cleanup(market_key: Pubkey, market: &Market, seats: &mut Seats,
    book: &mut Storage<'_>, target: OrderTarget, now: i64) -> Checked<Removed> {
    remove(market_key, market, seats, book, target, Authority::Keeper { now })
}

#[inline(never)]
fn remove(market_key: Pubkey, market: &Market, seats: &mut Seats, book: &mut Storage<'_>,
    target: OrderTarget, auth: Authority<'_>) -> Checked<Removed> {
    let h = book.header();
    if h.domain != market_key.to_bytes() || h.payout != market.payout_milli || h.fee_bps != market.fee_bps
        || seats.market != market_key || seats.count as usize > SEAT_CAPACITY { return Err(Fault::Binding); }
    let side = match target.side { 0 => Side::Bid, 1 => Side::Ask, _ => return Err(Fault::StaleTarget) };
    let (header, slots, bids, asks) = book.parts_mut();
    let (heap, len) = match side { Side::Bid => (bids, usize::from(h.bid_len)), Side::Ask => (asks, usize::from(h.ask_len)) };
    let index = usize::from(target.heap_index);
    if index >= len { return Err(Fault::StaleTarget); }
    let slot_index = *heap.get(index).ok_or(Fault::InvalidBook)?;
    let order = read_order(slots, slot_index, side, h.payout)?;
    if order.id != target.order_id { return Err(Fault::StaleTarget); }
    let owner = usize::try_from(order.owner).map_err(|_| Fault::Binding)?;
    if owner >= seats.count as usize || owner >= SEAT_CAPACITY { return Err(Fault::Binding); }
    let before = seats.entries[owner];
    if before.wallet == Pubkey::default() || before.enrollment == Pubkey::default() { return Err(Fault::Binding); }
    let (reason, nonce, next_nonce) = match auth {
        Authority::Owner { wallet, locator, nonce } => {
            if wallet != before.wallet || locator.wallet != wallet || locator.market != market_key
                || locator.index as usize != owner { return Err(Fault::NotOwner); }
            if before.next_nonce != nonce { return Err(Fault::Nonce); }
            (Reason::Owner, Some(nonce), nonce.checked_add(1).ok_or(Fault::Overflow)?)
        }
        Authority::Keeper { now } => {
            let reason = if now >= market.closes_at { Reason::MarketClosed }
                else if order.expires_at.is_some_and(|expiry| now >= expiry) { Reason::Expired }
                else { return Err(Fault::NotEligible); };
            (reason, None, before.next_nonce)
        }
    };
    let release = matching::reserve(order, h.fee_bps)?;
    if before.reserved_yes > before.yes || before.reserved_no > before.no { return Err(Fault::InvalidReserves); }
    let mut after = before;
    after.reserved_cash = before.reserved_cash.checked_sub(release.cash).ok_or(Fault::InvalidReserves)?;
    after.available_cash = before.available_cash.checked_add(release.cash).ok_or(Fault::Overflow)?;
    after.reserved_yes = before.reserved_yes.checked_sub(release.yes).ok_or(Fault::InvalidReserves)?;
    after.reserved_no = before.reserved_no.checked_sub(release.no).ok_or(Fault::InvalidReserves)?;
    after.next_nonce = next_nonce;
    let mut next_header = h;
    next_header.revision = h.revision.checked_add(1).ok_or(Fault::Overflow)?;
    next_header.active_len = h.active_len.checked_sub(1).ok_or(Fault::InvalidBook)?;
    match side { Side::Bid => next_header.bid_len = h.bid_len.checked_sub(1).ok_or(Fault::InvalidBook)?,
        Side::Ask => next_header.ask_len = h.ask_len.checked_sub(1).ok_or(Fault::InvalidBook)? }
    next_header.free_head = slot_index;
    let freed = Slot::freed(h.free_head);
    let plan = plan_removal(heap, len, index, slots, side, h.payout)?;
    plan.validate(heap)?;
    // The same exclusive book/seat borrows are held throughout. All indices,
    // arithmetic and authorization are now proved; no fallible work follows.
    plan.apply(heap);
    slots[usize::from(slot_index)] = freed;
    seats.entries[owner] = after;
    *header = next_header;
    Ok(Removed { order, wallet: before.wallet, released: release, reason, nonce,
        revision: next_header.revision, heap_writes: plan.count })
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config, has_one = seats)]
    pub market: Account<'info, Market>,
    #[account(mut)] pub seats: AccountLoader<'info, Seats>,
    #[account(seeds = [b"seat", market.key().as_ref(), wallet.key().as_ref()], bump = locator.bump,
        has_one = market, has_one = wallet)]
    pub locator: Account<'info, SeatLocator>,
    /// CHECK: canonical owner/PDA plus tag, length, alignment and domain below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CleanupOrder<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config, has_one = seats)]
    pub market: Account<'info, Market>,
    #[account(mut)] pub seats: AccountLoader<'info, Seats>,
    /// CHECK: same canonical validation; no owner signature needed for cleanup.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
}

fn attach(data: &mut [u8]) -> Result<Storage<'_>> {
    require!(data.len() == BOOK_BYTES && data[..8] == BOOK_TAG, CancelError::InvalidBook);
    let ptr = data[8..].as_mut_ptr();
    require!((ptr as usize) % core::mem::align_of::<Header>() == 0, CancelError::InvalidBook);
    // Same canonical typed representation used by exchange/bootstrap. No slot
    // field offsets or copied Slot layout. All bit patterns are valid integers.
    let (header, slots, bids, asks) = unsafe {
        let sp = ptr.add(core::mem::size_of::<Header>());
        let bp = sp.add(matching::MAX_ORDERS * core::mem::size_of::<Slot>());
        let ap = bp.add(matching::MAX_ORDERS * 2);
        (&mut *ptr.cast::<Header>(), core::slice::from_raw_parts_mut(sp.cast::<Slot>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(bp.cast::<u16>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(ap.cast::<u16>(), matching::MAX_ORDERS))
    };
    Storage::attach(header, slots, bids, asks).map_err(|_| error!(CancelError::InvalidBook))
}

pub fn cancel_order(ctx: Context<CancelOrder>, args: CancelOrderArgs) -> Result<()> {
    let key = ctx.accounts.market.key();
    let mut data = ctx.accounts.book.try_borrow_mut_data()?;
    let mut book = attach(&mut data)?;
    let mut seats = ctx.accounts.seats.load_mut()?;
    let receipt = execute_owner(key, ctx.accounts.wallet.key(), &ctx.accounts.locator, &ctx.accounts.market,
        &mut seats, &mut book, args).map_err(instruction_error)?;
    emit_removed(key, receipt);
    Ok(())
}
pub fn cleanup_order(ctx: Context<CleanupOrder>, target: OrderTarget) -> Result<()> {
    let key = ctx.accounts.market.key();
    let now = Clock::get()?.unix_timestamp;
    let mut data = ctx.accounts.book.try_borrow_mut_data()?;
    let mut book = attach(&mut data)?;
    let mut seats = ctx.accounts.seats.load_mut()?;
    let receipt = execute_cleanup(key, &ctx.accounts.market, &mut seats, &mut book, target, now).map_err(instruction_error)?;
    emit_removed(key, receipt);
    Ok(())
}
fn emit_removed(market: Pubkey, r: Removed) {
    emit!(OrderCanceled { market, wallet: r.wallet, seat: r.order.owner, order_id: r.order.id,
        reason: r.reason as u8, owner_nonce: r.nonce, book_revision: r.revision,
        remaining: r.order.remaining, chain_notional: r.order.chain_notional,
        released_cash: r.released.cash, released_yes: r.released.yes, released_no: r.released.no });
}
#[event]
pub struct OrderCanceled { pub market: Pubkey, pub wallet: Pubkey, pub seat: u64, pub order_id: u64,
    pub reason: u8, pub owner_nonce: Option<u64>, pub book_revision: u64, pub remaining: u64,
    pub chain_notional: u64, pub released_cash: u64, pub released_yes: u64, pub released_no: u64 }

#[error_code(offset = 7200)]
pub enum CancelError {
    #[msg("Invalid cancellation account binding")] Binding,
    #[msg("Stale order ID or heap-position hint")] StaleTarget,
    #[msg("Only the resting order owner may cancel a live order")] NotOwner,
    #[msg("Stale cancellation nonce")] Nonce,
    #[msg("Order is not expired and market is still open")] NotEligible,
    #[msg("Checked cancellation arithmetic overflow")] Overflow,
    #[msg("Order reserve ledger is inconsistent")] InvalidReserves,
    #[msg("Invalid canonical book storage")] InvalidBook,
    #[msg("Cancellation patch bound exceeded")] PatchCapacity,
}
fn instruction_error(f: Fault) -> anchor_lang::error::Error {
    let e = match f { Fault::Binding => CancelError::Binding, Fault::StaleTarget => CancelError::StaleTarget,
        Fault::NotOwner => CancelError::NotOwner, Fault::Nonce => CancelError::Nonce,
        Fault::NotEligible => CancelError::NotEligible, Fault::Overflow => CancelError::Overflow,
        Fault::InvalidReserves => CancelError::InvalidReserves, Fault::InvalidBook | Fault::Matcher(_) => CancelError::InvalidBook,
        Fault::PatchCapacity => CancelError::PatchCapacity };
    e.into()
}
const _: () = assert!(core::mem::size_of::<RemovalPlan>() <= 256);
