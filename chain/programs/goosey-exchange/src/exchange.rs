//! Account-state placement adapter, wired to the place_order instruction.
//! Uses the EXISTING escrow Market/Seats/SeatLocator; never synthesizes credit.
//! YES/NO fields are total holdings; reserved_YES/NO encumber those totals.
//! The adapter stages <=17 actual seats on the heap, never copies Seats or book.
//! All fallible work precedes a single exclusive-borrow, infallible commit.
//!
//! Integration contract: initialize exactly one canonical order_book PDA per
//! market, with BOOK_TAG followed by runtime Header/Slot/two u16 heaps. Its
//! header.domain is the market public key. Large PDA creation needs bounded
//! realloc/setup instructions before trading; book-bootstrap.rs implements that
//! lifecycle without changing the foundation Market/Seats layouts. No other
//! instruction may mutate this book without advancing its revision. All order
//! reserves must originate through this adapter (empty book starts at zero).
//! Cancellation/replacement/lifecycle instructions must preserve that induction.
//! No matching token CPI: available cash was previously deposited into the vault.
//! Seat scanning below is bounded at 256; book planning remains bounded at16.
//! Memory: 17*136 = 2,312 seat-staging bytes, plus the measured 9,824-byte
//! maximum matcher buffers (12,136 combined host scratch, excluding Anchor and
//! event serialization). No array of 256 seats lives on stack or scratch heap.
//! The 8-touch default is conservative versus standalone measured 128,672 CU;
//! 16 measured 381,066 CU. Full adapter CU is NOT yet measured; clients must
//! simulate/set an explicit budget after integration rather than assume200k.
//! New placements start a new fee chain; replacement must carry the old chain
//! explicitly and cannot be implemented by silently reusing this new-order API.
//! Indexing: TradeExecuted/RestingOrderRemoved in matcher order, then the command
//! event; identify events by transaction signature plus log position. Seat nonce
//! rejects replays, but durable command receipts/idempotent replay are not added.

use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use crate::{Config, escrow::{Market, Seat, SeatLocator, Seats, SEAT_CAPACITY}};
use crate::matching::{self, runtime::{Header, Plan, Slot, Storage}, Action, Disposition,
    Effect, Incoming, Intent, Outcome, Reserve, SelfTrade, TimeInForce};

pub const DEFAULT_TOUCHES: u8 = 8;
pub const MAX_STAGED_SEATS: usize = matching::MAX_TOUCHES + 1;
pub const BOOK_TAG: [u8; 8] = *b"GOOSEYB1";
pub const BOOK_BYTES: usize = 8 + core::mem::size_of::<Header>()
    + matching::MAX_ORDERS * (core::mem::size_of::<Slot>() + 4);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Binding, Closed, Nonce, Overflow, InsufficientCash, InsufficientPosition,
    InvalidReserves, Accounting, VaultUnderfunded, SeatLimit, FokRejected,
    PostOnlyRejected, InvalidOptions, Matcher(matching::Error),
}
type Checked<T> = core::result::Result<T, Fault>;
impl From<matching::Error> for Fault { fn from(value: matching::Error) -> Self { Self::Matcher(value) } }

/// Wire values are explicit integers, not Rust enum discriminants. Zero touches
/// selects the 8-touch client default; 16 is supported with explicit CU budget.
/// No client-supplied owner, order ID, sequence, fee rate, or lifetime notional.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PlaceOrderArgs {
    pub expected_nonce: u64,
    pub price: u64,
    pub quantity: u64,
    pub outcome: u8, // 0 YES, 1 NO
    pub action: u8, // 0 buy, 1 sell
    pub time_in_force: u8, // 0 GTC, 1 IOC, 2 FOK
    pub self_trade: u8, // 0 cancel aggressor, 1 cancel resting, 2 cancel both
    pub post_only: bool,
    pub expires_at: Option<i64>,
    pub touches: u8,
}

pub struct Execution { pub plan: Plan, pub order_id: u64, pub nonce: u64 }

struct SeatPatch { index: usize, after: Seat }
struct Staged { patches: Vec<SeatPatch> }
impl Staged {
    fn new() -> Self { Self { patches: Vec::with_capacity(MAX_STAGED_SEATS) } }
    fn seat<'a>(&'a mut self, seats: &Seats, owner: u64) -> Checked<&'a mut Seat> {
        let index = usize::try_from(owner).map_err(|_| Fault::Binding)?;
        if index >= seats.count as usize || index >= SEAT_CAPACITY { return Err(Fault::Binding); }
        if let Some(position) = self.patches.iter().position(|p| p.index == index) {
            return Ok(&mut self.patches[position].after);
        }
        if self.patches.len() == MAX_STAGED_SEATS { return Err(Fault::SeatLimit); }
        let seat = seats.entries[index];
        if seat.wallet == Pubkey::default() || seat.enrollment == Pubkey::default() { return Err(Fault::Binding); }
        self.patches.push(SeatPatch { index, after: seat });
        Ok(&mut self.patches.last_mut().unwrap().after)
    }
}

fn add(a: u64, b: u64) -> Checked<u64> { a.checked_add(b).ok_or(Fault::Overflow) }
fn delta(value: u64, change: i128) -> Checked<u64> {
    let result = i128::from(value).checked_add(change).ok_or(Fault::Overflow)?;
    u64::try_from(result).map_err(|_| Fault::Accounting)
}
fn check_seat(s: &Seat) -> Checked<()> {
    if s.reserved_yes > s.yes || s.reserved_no > s.no { return Err(Fault::InvalidReserves); }
    Ok(())
}
fn lock(s: &mut Seat, r: Reserve) -> Checked<()> {
    check_seat(s)?;
    s.available_cash = s.available_cash.checked_sub(r.cash).ok_or(Fault::InsufficientCash)?;
    s.reserved_cash = add(s.reserved_cash, r.cash)?;
    s.reserved_yes = add(s.reserved_yes, r.yes)?;
    s.reserved_no = add(s.reserved_no, r.no)?;
    if s.reserved_yes > s.yes || s.reserved_no > s.no { return Err(Fault::InsufficientPosition); }
    Ok(())
}
fn unlock(s: &mut Seat, r: Reserve) -> Checked<()> {
    s.reserved_cash = s.reserved_cash.checked_sub(r.cash).ok_or(Fault::InvalidReserves)?;
    s.available_cash = add(s.available_cash, r.cash)?;
    s.reserved_yes = s.reserved_yes.checked_sub(r.yes).ok_or(Fault::InvalidReserves)?;
    s.reserved_no = s.reserved_no.checked_sub(r.no).ok_or(Fault::InvalidReserves)?;
    Ok(())
}
fn settle(s: &mut Seat, before: Reserve, after: Reserve, reserved_cash: i128,
    available_cash: i128, yes: i64, no: i64) -> Checked<()> {
    // Temporarily unlock only THIS order, not the party's other resting orders.
    // Charge executed principal/fee, then lock the exact telescoping remaining
    // reserve. The difference becomes available price-improvement credit.
    unlock(s, before)?;
    s.available_cash = delta(s.available_cash, reserved_cash.checked_add(available_cash).ok_or(Fault::Overflow)?)?;
    s.yes = delta(s.yes, i128::from(yes))?;
    s.no = delta(s.no, i128::from(no))?;
    lock(s, after)?;
    s.ever_traded = 1;
    Ok(())
}

#[derive(Default, Clone, Copy)]
struct Totals { cash: u128, yes: u128, no: u128 }
impl Totals {
    fn seat(s: &Seat) -> Self { Self { cash: u128::from(s.available_cash) + u128::from(s.reserved_cash),
        yes: u128::from(s.yes), no: u128::from(s.no) } }
    fn collect(seats: &Seats) -> Checked<Self> {
        if seats.count as usize > SEAT_CAPACITY { return Err(Fault::Binding); }
        let mut total = Self::default();
        // <=256 seats * two u64 cash buckets fits u128 without overflow.
        for s in &seats.entries[..seats.count as usize] {
            check_seat(s)?;
            let t = Self::seat(s); total.cash += t.cash; total.yes += t.yes; total.no += t.no;
        }
        Ok(total)
    }
    fn verify(&self, accounted: u64, collateral: u64, revenue: u64, payout: u64) -> Checked<()> {
        if self.cash + u128::from(collateral) + u128::from(revenue) != u128::from(accounted)
            || self.yes != self.no || self.yes.checked_mul(u128::from(payout)) != Some(u128::from(collateral)) {
            return Err(Fault::Accounting);
        }
        Ok(())
    }
}

/// Core works directly on borrowed real account objects. Caller authenticates
/// program ownership and canonical addresses; this function also verifies all
/// semantic bindings. It never credits a deposit or constructs starting funds.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
pub fn execute(market_key: Pubkey, wallet: Pubkey, locator: &SeatLocator,
    market: &mut Market, seats: &mut Seats, vault_amount: u64,
    book: &mut Storage<'_>, args: PlaceOrderArgs, now: i64) -> Checked<Execution> {
    let h = book.header();
    let index = locator.index as usize;
    if seats.market != market_key || locator.market != market_key || locator.wallet != wallet
        || index >= seats.count as usize || index >= SEAT_CAPACITY
        || seats.entries[index].wallet != wallet || wallet == Pubkey::default()
        || h.domain != market_key.to_bytes() || h.payout != market.payout_milli || h.fee_bps != market.fee_bps {
        return Err(Fault::Binding);
    }
    if now >= market.closes_at { return Err(Fault::Closed); }
    if vault_amount < market.accounted_vault { return Err(Fault::VaultUnderfunded); }
    if seats.entries[index].next_nonce != args.expected_nonce { return Err(Fault::Nonce); }
    let nonce_after = args.expected_nonce.checked_add(1).ok_or(Fault::Overflow)?;
    let touches = if args.touches == 0 { DEFAULT_TOUCHES } else { args.touches };
    let outcome = match args.outcome { 0 => Outcome::Yes, 1 => Outcome::No, _ => return Err(Fault::InvalidOptions) };
    let action = match args.action { 0 => Action::Buy, 1 => Action::Sell, _ => return Err(Fault::InvalidOptions) };
    let tif = match args.time_in_force { 0 => TimeInForce::Gtc, 1 => TimeInForce::Ioc, 2 => TimeInForce::Fok, _ => return Err(Fault::InvalidOptions) };
    let stp = match args.self_trade { 0 => SelfTrade::CancelAggressor, 1 => SelfTrade::CancelResting,
        2 => SelfTrade::CancelBoth, _ => return Err(Fault::InvalidOptions) };
    let mut totals = Totals::collect(seats)?;
    totals.verify(market.accounted_vault, market.collateral, market.fee_revenue, market.payout_milli)?;
    let input = Incoming { order: matching::Order { id: h.next_sequence, sequence: h.next_sequence,
        owner: index as u64, intent: Intent { outcome, action }, limit_price: args.price,
        remaining: args.quantity, expires_at: args.expires_at, chain_notional: 0 },
        time_in_force: tif, self_trade: stp, post_only: args.post_only };
    let plan = book.plan(input, now, usize::from(touches))?;
    match plan.disposition() {
        Disposition::FokNotFillable => return Err(Fault::FokRejected),
        Disposition::PostOnlyWouldTrade => return Err(Fault::PostOnlyRejected),
        _ => (),
    }
    let mut staged = Staged::new();
    let mut taker_reserve = plan.required_reserve();
    lock(staged.seat(seats, index as u64)?, taker_reserve)?;
    let mut collateral = market.collateral;
    let mut revenue = market.fee_revenue;
    for effect in plan.effects() {
        match effect {
            Effect::Removed { order, .. } => {
                unlock(staged.seat(seats, order.owner)?, matching::reserve(*order, market.fee_bps)?)?;
            }
            Effect::Fill(fill) => {
                if fill.maker_before.owner == index as u64 || fill.taker_before.owner != index as u64 { return Err(Fault::Binding); }
                let e = fill.economics;
                settle(staged.seat(seats, fill.maker_before.owner)?, matching::reserve(fill.maker_before, market.fee_bps)?,
                    fill.maker_reserve_after, e.maker_reserved_cash, e.maker_available_cash, e.maker_yes, e.maker_no)?;
                settle(staged.seat(seats, index as u64)?, taker_reserve,
                    fill.taker_reserve_after, e.taker_reserved_cash, e.taker_available_cash, e.taker_yes, e.taker_no)?;
                taker_reserve = fill.taker_reserve_after;
                collateral = delta(collateral, e.collateral)?;
                revenue = delta(revenue, e.revenue)?;
            }
        }
    }
    let taker = staged.seat(seats, index as u64)?;
    unlock(taker, taker_reserve)?;
    lock(taker, plan.final_reserve())?;
    taker.next_nonce = nonce_after;
    for patch in &staged.patches {
        check_seat(&patch.after)?;
        let old = Totals::seat(&seats.entries[patch.index]);
        let new = Totals::seat(&patch.after);
        totals.cash = totals.cash.checked_sub(old.cash).and_then(|v| v.checked_add(new.cash)).ok_or(Fault::Accounting)?;
        totals.yes = totals.yes.checked_sub(old.yes).and_then(|v| v.checked_add(new.yes)).ok_or(Fault::Accounting)?;
        totals.no = totals.no.checked_sub(old.no).and_then(|v| v.checked_add(new.no)).ok_or(Fault::Accounting)?;
    }
    totals.verify(market.accounted_vault, collateral, revenue, market.payout_milli)?;
    // Exclusive mutable borrows of all accounts have been held throughout.
    // No fallible operation, allocation, arithmetic, or CPI follows this guard.
    let validated = book.validate(&plan)?;
    validated.commit();
    for patch in staged.patches { seats.entries[patch.index] = patch.after; }
    market.collateral = collateral;
    market.fee_revenue = revenue;
    Ok(Execution { plan, order_id: h.next_sequence, nonce: args.expected_nonce })
}

/// Actual Anchor account constraints, ready for main's instruction integration.
/// Canonical book PDA initialization is a separate required integration step.
#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = config.environment == 1 || config.environment == 2)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config, has_one = seats, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub seats: AccountLoader<'info, Seats>,
    #[account(seeds = [b"seat", market.key().as_ref(), wallet.key().as_ref()], bump = locator.bump,
        has_one = market, has_one = wallet)]
    pub locator: Account<'info, SeatLocator>,
    #[account(constraint = vault.mint == config.feather_mint,
        constraint = vault.owner == market.key())]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: canonical PDA/owner plus exact tag, size/alignment/domain below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(seeds = [crate::resolution::RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes())]
    pub resolution: Account<'info, crate::resolution::ResolutionState>,
    #[account(seeds = [crate::market_terms::MARKET_TERMS_SEED, market.key().as_ref()], bump,
        constraint = terms.market == market.key())]
    pub terms: Account<'info, crate::market_terms::MarketTerms>,
}

pub fn place_order(ctx: Context<PlaceOrder>, args: PlaceOrderArgs) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let now = Clock::get()?.unix_timestamp;
    crate::resolution::require_anchor_order_admission(&ctx.accounts.resolution, market_key,
        &mut ctx.accounts.market, now).map_err(|_| error!(ExchangeError::Closed))?;
    let resolution = &ctx.accounts.resolution;
    crate::market_terms::validate_market_admission(ctx.accounts.terms.key(), &ctx.accounts.terms,
        market_key, &ctx.accounts.market,
        [(Pubkey::new_from_array(resolution.proposer.wallet), Pubkey::new_from_array(resolution.proposer.enrollment)),
         (Pubkey::new_from_array(resolution.approver.wallet), Pubkey::new_from_array(resolution.approver.enrollment))],
        Some(ctx.accounts.wallet.key())).map_err(crate::market_terms::instruction_error)?;
    let mut data = ctx.accounts.book.try_borrow_mut_data()?;
    require!(data.len() == BOOK_BYTES && data[..8] == BOOK_TAG, ExchangeError::InvalidBook);
    let ptr = data[8..].as_mut_ptr();
    require!((ptr as usize) % core::mem::align_of::<Header>() == 0, ExchangeError::InvalidBook);
    // Safety: validated exact length/alignment; Header/Slot contain integer
    // fields only, repr(C), with asserted sizes. Disjoint exclusive regions.
    let (header, slots, bids, asks) = unsafe {
        let slots_ptr = ptr.add(core::mem::size_of::<Header>());
        let bids_ptr = slots_ptr.add(matching::MAX_ORDERS * core::mem::size_of::<Slot>());
        let asks_ptr = bids_ptr.add(matching::MAX_ORDERS * 2);
        (&mut *ptr.cast::<Header>(), core::slice::from_raw_parts_mut(slots_ptr.cast::<Slot>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(bids_ptr.cast::<u16>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(asks_ptr.cast::<u16>(), matching::MAX_ORDERS))
    };
    let mut book = Storage::attach(header, slots, bids, asks).map_err(|_| error!(ExchangeError::InvalidBook))?;
    let mut seats = ctx.accounts.seats.load_mut()?;
    let result = execute(market_key, ctx.accounts.wallet.key(), &ctx.accounts.locator,
        &mut ctx.accounts.market, &mut seats, ctx.accounts.vault.amount, &mut book, args, now)
        .map_err(instruction_error)?;
    let (filled, canceled, rested) = result.plan.quantities();
    for effect in result.plan.effects() {
        match effect {
            Effect::Fill(fill) => emit!(TradeExecuted { market: market_key,
                maker_order_id: fill.maker_before.id, taker_order_id: result.order_id,
                maker_seat: fill.maker_before.owner, taker_seat: fill.taker_before.owner,
                quantity: fill.quantity, yes_price: fill.canonical_yes_price,
                maker_fee: fill.maker_fee, taker_fee: fill.taker_fee,
                maker_outcome: outcome_code(fill.maker_before.intent.outcome),
                maker_action: action_code(fill.maker_before.intent.action),
                taker_outcome: outcome_code(fill.taker_before.intent.outcome),
                taker_action: action_code(fill.taker_before.intent.action) }),
            Effect::Removed { order, reason } => emit!(RestingOrderRemoved { market: market_key,
                order_id: order.id, seat: order.owner, remaining: order.remaining,
                reason: match reason { matching::Removal::Expired => 0, matching::Removal::SelfTrade => 1 } }),
        }
    }
    emit!(OrderExecuted { market: market_key, wallet: ctx.accounts.wallet.key(), order_id: result.order_id,
        nonce: result.nonce, filled, canceled, rested, disposition: disposition_code(result.plan.disposition()),
        outcome: args.outcome, action: args.action, price: args.price });
    Ok(())
}

fn outcome_code(outcome: Outcome) -> u8 { match outcome { Outcome::Yes => 0, Outcome::No => 1 } }
fn action_code(action: Action) -> u8 { match action { Action::Buy => 0, Action::Sell => 1 } }
fn disposition_code(disposition: Disposition) -> u8 {
    match disposition {
        Disposition::Filled => 0, Disposition::Resting => 1, Disposition::PartiallyFilledAndResting => 2,
        Disposition::Canceled => 3, Disposition::PartiallyFilledAndCanceled => 4,
        Disposition::SelfTradePrevented => 5, Disposition::PostOnlyWouldTrade => 6, Disposition::FokNotFillable => 7,
    }
}

// Separate range from the foundation's default 6000-series errors.
#[error_code(offset = 7000)]
pub enum ExchangeError {
    #[msg("Invalid canonical order book")] InvalidBook,
    #[msg("Invalid exchange account binding")] Binding,
    #[msg("Market is closed")] Closed,
    #[msg("Stale command nonce")] Nonce,
    #[msg("Checked arithmetic failed")] Overflow,
    #[msg("Insufficient available cash")] InsufficientCash,
    #[msg("Insufficient unreserved position")] InsufficientPosition,
    #[msg("Invalid order reserves")] InvalidReserves,
    #[msg("Exchange accounting invariant failed")] Accounting,
    #[msg("Escrow vault is underfunded")] VaultUnderfunded,
    #[msg("Seat staging limit exceeded")] SeatLimit,
    #[msg("FOK could not fill atomically")] FokRejected,
    #[msg("Post-only order would trade")] PostOnlyRejected,
    #[msg("Invalid order options")] InvalidOptions,
    #[msg("Matcher rejected command; no account changes")] MatcherRejected,
}
fn instruction_error(f: Fault) -> anchor_lang::error::Error {
    let code = match f {
        Fault::Binding => ExchangeError::Binding, Fault::Closed => ExchangeError::Closed,
        Fault::Nonce => ExchangeError::Nonce, Fault::Overflow => ExchangeError::Overflow,
        Fault::InsufficientCash => ExchangeError::InsufficientCash, Fault::InsufficientPosition => ExchangeError::InsufficientPosition,
        Fault::InvalidReserves => ExchangeError::InvalidReserves, Fault::Accounting => ExchangeError::Accounting,
        Fault::VaultUnderfunded => ExchangeError::VaultUnderfunded, Fault::SeatLimit => ExchangeError::SeatLimit,
        Fault::FokRejected => ExchangeError::FokRejected, Fault::PostOnlyRejected => ExchangeError::PostOnlyRejected,
        Fault::InvalidOptions => ExchangeError::InvalidOptions, Fault::Matcher(_) => ExchangeError::MatcherRejected,
    };
    code.into()
}
#[event]
pub struct OrderExecuted { pub market: Pubkey, pub wallet: Pubkey, pub order_id: u64, pub nonce: u64,
    pub filled: u64, pub canceled: u64, pub rested: u64, pub disposition: u8,
    pub outcome: u8, pub action: u8, pub price: u64 }
#[event]
pub struct TradeExecuted { pub market: Pubkey, pub maker_order_id: u64, pub taker_order_id: u64,
    pub maker_seat: u64, pub taker_seat: u64, pub quantity: u64, pub yes_price: u64,
    pub maker_fee: u64, pub taker_fee: u64, pub maker_outcome: u8, pub maker_action: u8,
    pub taker_outcome: u8, pub taker_action: u8 }
#[event]
pub struct RestingOrderRemoved { pub market: Pubkey, pub order_id: u64, pub seat: u64, pub remaining: u64, pub reason: u8 }

const _: () = assert!(core::mem::size_of::<SeatPatch>() * MAX_STAGED_SEATS <= 4_096);
const _: () = assert!(core::mem::size_of::<Header>() == 80 && core::mem::size_of::<Slot>() == 64);
