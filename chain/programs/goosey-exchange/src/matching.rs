//! Bounded binary-outcome CLOB engine used by the Anchor placement adapter.
//!
//! Run standalone: `rustc --edition 2021 --test matching.rs -o <temporary-path>`.
//! `Book` is the snapshot reference model. `runtime` is the persistent-storage
//! path: borrowed POD-layout slots/heaps, bounded write-ahead patches, read-only
//! planning, complete prewrite validation, and infallible commit. No full-book
//! cloning or sorting occurs in that path. See matching-bench.rs for measurements.
//! Authentication, collateral sufficiency, persistent nonces, and assignment of
//! globally unique acceptance sequences belong to that adapter, not this model.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[path = "arithmetic.rs"]
mod fee_math;

pub const MAX_ORDERS: usize = 1_024;
pub const MAX_TOUCHES: usize = 16;
pub const MAX_QUANTITY: u64 = 10_000_000;
pub const MAX_PAYOUT: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome { Yes, No }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action { Buy, Sell }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Bid, Ask }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeInForce { Gtc, Ioc, Fok }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelfTrade { CancelAggressor, CancelResting, CancelBoth }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EconomicKind { Mint, Burn, TransferYes, TransferNo }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intent { pub outcome: Outcome, pub action: Action }

impl Intent {
    pub fn side(self) -> Side {
        match (self.outcome, self.action) {
            (Outcome::Yes, Action::Buy) | (Outcome::No, Action::Sell) => Side::Bid,
            _ => Side::Ask,
        }
    }

    pub fn canonical_price(self, user_price: u64, payout: u64) -> Result<u64, Error> {
        validate_price(user_price, payout)?;
        Ok(match self.outcome { Outcome::Yes => user_price, Outcome::No => payout - user_price })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    /// Never reuse an ID/sequence within the same market's persistent history.
    pub id: u64,
    /// Canonical enrolled identity, not a caller-selected self-trade bypass ID.
    pub owner: u64,
    pub intent: Intent,
    /// Original user-outcome price, not normalized YES price.
    pub limit_price: u64,
    pub remaining: u64,
    pub sequence: u64,
    pub expires_at: Option<i64>,
    /// Retained across atomic replacements and maker/taker role changes.
    pub chain_notional: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Incoming {
    pub order: Order,
    pub time_in_force: TimeInForce,
    pub post_only: bool,
    pub self_trade: SelfTrade,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ranked { order: Order, price: u64 }

impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> Ordering {
        let price = match self.order.intent.side() {
            Side::Bid => self.price.cmp(&other.price),
            Side::Ask => other.price.cmp(&self.price),
        };
        price.then_with(|| other.order.sequence.cmp(&self.order.sequence))
            .then_with(|| other.order.id.cmp(&self.order.id))
    }
}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) }
}

#[derive(Clone, Debug)]
pub struct Book {
    payout: u64,
    fee_bps: u16,
    capacity: usize,
    bids: BinaryHeap<Ranked>,
    asks: BinaryHeap<Ranked>,
}

impl Book {
    pub fn new(payout: u64, fee_bps: u16, capacity: usize) -> Result<Self, Error> {
        validate_payout(payout)?;
        if fee_bps > 10_000 || capacity == 0 || capacity > MAX_ORDERS { return Err(Error::InvalidConfiguration); }
        Ok(Self { payout, fee_bps, capacity, bids: BinaryHeap::new(), asks: BinaryHeap::new() })
    }

    pub fn len(&self) -> usize { self.bids.len() + self.asks.len() }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    pub fn payout(&self) -> u64 { self.payout }

    /// Canonical deterministic snapshot for indexing and parity comparisons.
    pub fn orders(&self) -> Vec<Order> {
        let mut bids = self.bids.clone();
        let mut asks = self.asks.clone();
        let mut result = Vec::with_capacity(self.len());
        while let Some(entry) = bids.pop() { result.push(entry.order); }
        while let Some(entry) = asks.pop() { result.push(entry.order); }
        result
    }

    fn heap(&self, side: Side) -> &BinaryHeap<Ranked> {
        match side { Side::Bid => &self.bids, Side::Ask => &self.asks }
    }
    fn heap_mut(&mut self, side: Side) -> &mut BinaryHeap<Ranked> {
        match side { Side::Bid => &mut self.bids, Side::Ask => &mut self.asks }
    }
    fn insert(&mut self, order: Order) -> Result<(), Error> {
        if self.len() >= self.capacity { return Err(Error::BookFull); }
        let price = order.intent.canonical_price(order.limit_price, self.payout)?;
        self.heap_mut(order.intent.side()).push(Ranked { order, price });
        Ok(())
    }

    /// Real order admission is always through matching, never arbitrary book injection.
    pub fn execute(&self, incoming: Incoming, now: i64, touch_limit: usize) -> Result<MatchResult, Error> {
        validate_order(incoming.order, self.payout)?;
        if touch_limit == 0 || touch_limit > MAX_TOUCHES { return Err(Error::InvalidWorkLimit); }
        if (incoming.post_only || incoming.order.expires_at.is_some()) && incoming.time_in_force != TimeInForce::Gtc {
            return Err(Error::InvalidOptions);
        }
        if incoming.order.expires_at.is_some_and(|expiry| now >= expiry) { return Err(Error::ExpiredIncoming); }
        for maker in self.bids.iter().chain(self.asks.iter()) {
            if maker.order.id == incoming.order.id { return Err(Error::DuplicateOrder); }
            if maker.order.sequence == incoming.order.sequence { return Err(Error::DuplicateSequence); }
        }
        let mut next = self.clone();
        let mut taker = incoming.order;
        let side = taker.intent.side();
        let opposing = match side { Side::Bid => Side::Ask, Side::Ask => Side::Bid };
        let limit = taker.intent.canonical_price(taker.limit_price, self.payout)?;
        let mut effects = Vec::with_capacity(touch_limit);
        let mut touched = 0;
        let mut stopped_by_stp = false;

        while taker.remaining > 0 {
            let Some(mut maker) = next.heap(opposing).peek().copied() else { break; };
            let expired = maker.order.expires_at.is_some_and(|expiry| now >= expiry);
            let crosses = match side { Side::Bid => limit >= maker.price, Side::Ask => limit <= maker.price };
            if !expired && !crosses { break; }
            if touched == touch_limit {
                if incoming.time_in_force == TimeInForce::Ioc { break; }
                return Err(Error::MatchLimitExceeded);
            }
            touched += 1;
            if expired {
                next.heap_mut(opposing).pop();
                effects.push(Effect::Removed { order: maker.order, reason: Removal::Expired });
                continue;
            }
            if incoming.post_only {
                return Ok(self.rejected(incoming.order, Disposition::PostOnlyWouldTrade, touched));
            }
            if maker.order.owner == taker.owner {
                if incoming.self_trade != SelfTrade::CancelAggressor {
                    next.heap_mut(opposing).pop();
                    effects.push(Effect::Removed { order: maker.order, reason: Removal::SelfTrade });
                }
                if incoming.self_trade != SelfTrade::CancelResting { stopped_by_stp = true; break; }
                continue;
            }
            let quantity = taker.remaining.min(maker.order.remaining);
            let principals = principals(maker.price, quantity, self.payout)?;
            let maker_notional = principals.for_outcome(maker.order.intent.outcome);
            let taker_notional = principals.for_outcome(taker.intent.outcome);
            let maker_fee = fee_math::fee_delta(maker.order.chain_notional, maker_notional, self.fee_bps).ok_or(Error::ArithmeticOverflow)?;
            let taker_fee = fee_math::fee_delta(taker.chain_notional, taker_notional, self.fee_bps).ok_or(Error::ArithmeticOverflow)?;
            let economics = economics(maker.order.intent, taker.intent, maker.price, quantity, self.payout, maker_fee, taker_fee)?;
            let maker_before = maker.order;
            let taker_before = taker;
            maker.order.remaining -= quantity;
            taker.remaining -= quantity;
            maker.order.chain_notional = maker.order.chain_notional.checked_add(maker_notional).ok_or(Error::ArithmeticOverflow)?;
            taker.chain_notional = taker.chain_notional.checked_add(taker_notional).ok_or(Error::ArithmeticOverflow)?;
            let maker_reserve_after = reserve(maker.order, self.fee_bps)?;
            let taker_reserve_after = reserve(taker, self.fee_bps)?;
            effects.push(Effect::Fill(Fill {
                maker_before, taker_before, quantity, canonical_yes_price: maker.price,
                maker_fee, taker_fee, economics, maker_reserve_after, taker_reserve_after,
            }));
            next.heap_mut(opposing).pop();
            if maker.order.remaining > 0 { next.heap_mut(opposing).push(maker); }
        }

        if incoming.time_in_force == TimeInForce::Fok && taker.remaining > 0 {
            return Ok(self.rejected(incoming.order, Disposition::FokNotFillable, touched));
        }
        let filled = incoming.order.remaining - taker.remaining;
        let mut canceled = 0;
        let mut rested = 0;
        let disposition = if taker.remaining == 0 {
            Disposition::Filled
        } else if stopped_by_stp {
            canceled = taker.remaining;
            if filled > 0 { Disposition::PartiallyFilledAndCanceled } else { Disposition::SelfTradePrevented }
        } else if incoming.time_in_force == TimeInForce::Gtc {
            // Capacity errors discard all speculative fills/removals, as do FOK rejections.
            next.insert(taker)?;
            rested = taker.remaining;
            if filled > 0 { Disposition::PartiallyFilledAndResting } else { Disposition::Resting }
        } else {
            canceled = taker.remaining;
            if filled > 0 { Disposition::PartiallyFilledAndCanceled } else { Disposition::Canceled }
        };
        let final_reserve = if rested > 0 { reserve(taker, self.fee_bps)? } else { Reserve::default() };
        Ok(MatchResult { book: next, disposition, effects, filled, canceled, rested, touched, taker_chain_notional: taker.chain_notional, final_reserve })
    }

    fn rejected(&self, order: Order, disposition: Disposition, touched: usize) -> MatchResult {
        MatchResult { book: self.clone(), disposition, effects: Vec::new(), filled: 0,
            canceled: order.remaining, rested: 0, touched, taker_chain_notional: order.chain_notional, final_reserve: Reserve::default() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidConfiguration, InvalidPrice, InvalidQuantity, InvalidWorkLimit, InvalidOptions,
    ExpiredIncoming, DuplicateOrder, DuplicateSequence, MatchLimitExceeded, BookFull,
    SameBookSide, ArithmeticOverflow, FeeExceedsProceeds,
    InvalidStorage, StalePlan, InvalidSequence, PatchCapacity,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Filled, Resting, PartiallyFilledAndResting, Canceled, PartiallyFilledAndCanceled,
    SelfTradePrevented, PostOnlyWouldTrade, FokNotFillable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal { Expired, SelfTrade }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect { Fill(Fill), Removed { order: Order, reason: Removal } }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fill {
    pub maker_before: Order,
    pub taker_before: Order,
    pub quantity: u64,
    pub canonical_yes_price: u64,
    pub maker_fee: u64,
    pub taker_fee: u64,
    pub economics: Economics,
    /// Reserve immediately after this fill. Terminal taker cancellation releases it.
    pub maker_reserve_after: Reserve,
    pub taker_reserve_after: Reserve,
}
#[derive(Clone, Debug)]
pub struct MatchResult {
    pub book: Book,
    pub disposition: Disposition,
    pub effects: Vec<Effect>,
    pub filled: u64,
    pub canceled: u64,
    pub rested: u64,
    /// Includes expired makers, STP encounters, and post-only cross inspection.
    pub touched: usize,
    pub taker_chain_notional: u64,
    pub final_reserve: Reserve,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Reserve { pub cash: u64, pub yes: u64, pub no: u64 }

pub fn reserve(order: Order, fee_bps: u16) -> Result<Reserve, Error> {
    if fee_bps > 10_000 { return Err(Error::InvalidConfiguration); }
    Ok(match (order.intent.action, order.intent.outcome) {
        (Action::Buy, _) => Reserve { cash: fee_math::buy_reserve(order.limit_price, order.remaining, order.chain_notional, fee_bps).ok_or(Error::ArithmeticOverflow)?, ..Reserve::default() },
        (Action::Sell, Outcome::Yes) => Reserve { yes: order.remaining, ..Reserve::default() },
        (Action::Sell, Outcome::No) => Reserve { no: order.remaining, ..Reserve::default() },
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Principals { pub yes: u64, pub no: u64, pub pair: u64 }
impl Principals {
    pub fn for_outcome(self, outcome: Outcome) -> u64 { match outcome { Outcome::Yes => self.yes, Outcome::No => self.no } }
}
pub fn principals(yes_price: u64, quantity: u64, payout: u64) -> Result<Principals, Error> {
    validate_price(yes_price, payout)?;
    if quantity == 0 || quantity > MAX_QUANTITY { return Err(Error::InvalidQuantity); }
    Ok(Principals {
        yes: yes_price.checked_mul(quantity).ok_or(Error::ArithmeticOverflow)?,
        no: (payout - yes_price).checked_mul(quantity).ok_or(Error::ArithmeticOverflow)?,
        pair: payout.checked_mul(quantity).ok_or(Error::ArithmeticOverflow)?,
    })
}

/// Signed journal deltas, not mutable wallet balances. Positive means credit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Economics {
    pub kind: EconomicKind,
    pub maker_reserved_cash: i128,
    pub maker_available_cash: i128,
    pub taker_reserved_cash: i128,
    pub taker_available_cash: i128,
    pub collateral: i128,
    pub revenue: i128,
    pub maker_yes: i64,
    pub maker_no: i64,
    pub taker_yes: i64,
    pub taker_no: i64,
}

pub fn economics(maker: Intent, taker: Intent, yes_price: u64, quantity: u64, payout: u64, maker_fee: u64, taker_fee: u64) -> Result<Economics, Error> {
    if maker.side() == taker.side() { return Err(Error::SameBookSide); }
    let principal = principals(yes_price, quantity, payout)?;
    let kind = match (maker.action, taker.action) {
        (Action::Buy, Action::Buy) => EconomicKind::Mint,
        (Action::Sell, Action::Sell) => EconomicKind::Burn,
        _ if maker.outcome == Outcome::Yes => EconomicKind::TransferYes,
        _ => EconomicKind::TransferNo,
    };
    let cash = |intent: Intent, fee: u64| -> Result<(i128, i128), Error> {
        let amount = principal.for_outcome(intent.outcome);
        match intent.action {
            Action::Buy => Ok((-i128::from(amount.checked_add(fee).ok_or(Error::ArithmeticOverflow)?), 0)),
            Action::Sell => Ok((0, i128::from(amount.checked_sub(fee).ok_or(Error::FeeExceedsProceeds)?))),
        }
    };
    let (maker_reserved_cash, maker_available_cash) = cash(maker, maker_fee)?;
    let (taker_reserved_cash, taker_available_cash) = cash(taker, taker_fee)?;
    let position = |intent: Intent| {
        let q = quantity as i64 * if intent.action == Action::Buy { 1 } else { -1 };
        match intent.outcome { Outcome::Yes => (q, 0), Outcome::No => (0, q) }
    };
    let (maker_yes, maker_no) = position(maker);
    let (taker_yes, taker_no) = position(taker);
    let collateral = match kind { EconomicKind::Mint => i128::from(principal.pair), EconomicKind::Burn => -i128::from(principal.pair), _ => 0 };
    let revenue = i128::from(maker_fee.checked_add(taker_fee).ok_or(Error::ArithmeticOverflow)?);
    Ok(Economics { kind, maker_reserved_cash, maker_available_cash, taker_reserved_cash, taker_available_cash,
        collateral, revenue, maker_yes, maker_no, taker_yes, taker_no })
}

fn validate_payout(payout: u64) -> Result<(), Error> {
    if !(2..=MAX_PAYOUT).contains(&payout) { return Err(Error::InvalidConfiguration); }
    Ok(())
}
fn validate_price(price: u64, payout: u64) -> Result<(), Error> {
    validate_payout(payout)?;
    if price == 0 || price >= payout { return Err(Error::InvalidPrice); }
    Ok(())
}
fn validate_order(order: Order, payout: u64) -> Result<(), Error> {
    validate_price(order.limit_price, payout)?;
    if order.remaining == 0 || order.remaining > MAX_QUANTITY { return Err(Error::InvalidQuantity); }
    Ok(())
}

/// Allocation-bounded, account-backed matcher preparation. Persisted structs
/// contain only fixed-width scalars, never native Rust enums, pointers or Vecs.
pub mod runtime {
    use super::*;

    const NONE: u16 = u16::MAX;
    // A root removal clears the old tail and writes <=10 ancestors + final hole.
    // 16 removals and one insertion therefore need at most 16*12+11 = 203 cells.
    pub const MAX_HEAP_PATCHES: usize = MAX_TOUCHES * 12 + 11;
    pub const MAX_SLOT_PATCHES: usize = MAX_TOUCHES + 1;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Header {
        pub domain: [u8; 32],
        pub version: u64,
        pub payout: u64,
        pub revision: u64,
        pub next_sequence: u64,
        pub capacity: u16,
        pub bid_len: u16,
        pub ask_len: u16,
        pub active_len: u16,
        pub free_head: u16,
        pub fee_bps: u16,
        pub padding: [u8; 4],
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Slot {
        id: u64,
        owner: u64,
        limit_price: u64,
        remaining: u64,
        sequence: u64,
        expires_at: i64,
        chain_notional: u64,
        // bit 0 occupied; bit 1 NO; bit 2 SELL; bit 3 has expiry.
        flags: u16,
        next_free: u16,
        padding: [u8; 4],
    }
    const _: () = assert!(std::mem::size_of::<Header>() == 80);
    const _: () = assert!(std::mem::size_of::<Slot>() == 64);

    impl Slot {
        fn occupied(order: Order) -> Self {
            Self { id: order.id, owner: order.owner, limit_price: order.limit_price,
                remaining: order.remaining, sequence: order.sequence,
                expires_at: order.expires_at.unwrap_or(0), chain_notional: order.chain_notional,
                flags: 1 | if order.intent.outcome == Outcome::No { 2 } else { 0 }
                    | if order.intent.action == Action::Sell { 4 } else { 0 }
                    | if order.expires_at.is_some() { 8 } else { 0 },
                next_free: NONE, padding: [0; 4] }
        }
        fn order(self) -> Result<Order, Error> {
            if self.flags & 1 == 0 || self.flags & !15 != 0 { return Err(Error::InvalidStorage); }
            Ok(Order { id: self.id, owner: self.owner, limit_price: self.limit_price,
                remaining: self.remaining, sequence: self.sequence, chain_notional: self.chain_notional,
                expires_at: if self.flags & 8 != 0 { Some(self.expires_at) } else { None },
                intent: Intent { outcome: if self.flags & 2 != 0 { Outcome::No } else { Outcome::Yes },
                    action: if self.flags & 4 != 0 { Action::Sell } else { Action::Buy } } })
        }
    }

    /// Slices must borrow validated, aligned, program-owned account storage.
    /// Header and records have explicit repr(C) and no implicit padding. The
    /// integration adapter must verify ownership, discriminator, and domain.
    /// Every book mutation must advance header.revision; validation checks that
    /// revision and the write set, not an independent snapshot of every read.
    pub struct Storage<'a> {
        header: &'a mut Header,
        slots: &'a mut [Slot],
        bids: &'a mut [u16],
        asks: &'a mut [u16],
    }

    impl<'a> Storage<'a> {
        pub fn initialize(domain: [u8; 32], payout: u64, fee_bps: u16, header: &'a mut Header,
            slots: &'a mut [Slot], bids: &'a mut [u16], asks: &'a mut [u16]) -> Result<Self, Error> {
            validate_payout(payout)?;
            let capacity = slots.len();
            if domain == [0; 32] || capacity == 0 || capacity > MAX_ORDERS || bids.len() != capacity
                || asks.len() != capacity || fee_bps > 10_000 { return Err(Error::InvalidConfiguration); }
            // One-time initialization, never part of a matching instruction.
            for (index, slot) in slots.iter_mut().enumerate() {
                *slot = Slot { next_free: if index + 1 < capacity { (index + 1) as u16 } else { NONE }, ..Slot::default() };
            }
            bids.fill(NONE);
            asks.fill(NONE);
            *header = Header { domain, version: 1, payout, revision: 0, next_sequence: 1,
                capacity: capacity as u16, free_head: 0, fee_bps, ..Header::default() };
            Ok(Self { header, slots, bids, asks })
        }

        pub fn attach(header: &'a mut Header, slots: &'a mut [Slot], bids: &'a mut [u16], asks: &'a mut [u16]) -> Result<Self, Error> {
            validate_payout(header.payout)?;
            let n = usize::from(header.capacity);
            if header.version != 1 || header.domain == [0; 32] || n == 0 || n > MAX_ORDERS
                || slots.len() != n || bids.len() != n || asks.len() != n || header.fee_bps > 10_000
                || usize::from(header.bid_len) + usize::from(header.ask_len) != usize::from(header.active_len)
                || usize::from(header.active_len) > n
                || (header.free_head != NONE && usize::from(header.free_head) >= n) { return Err(Error::InvalidStorage); }
            Ok(Self { header, slots, bids, asks })
        }

        pub fn header(&self) -> Header { *self.header }
        pub fn next_sequence(&self) -> u64 { self.header.next_sequence }
        pub fn len(&self) -> usize { usize::from(self.header.active_len) }
        pub fn is_empty(&self) -> bool { self.len() == 0 }

        /// Read-only planner. All potential failures happen before writes.
        #[inline(never)]
        pub fn plan(&self, incoming: Incoming, now: i64, touch_limit: usize) -> Result<Plan, Error> {
            validate_order(incoming.order, self.header.payout)?;
            if incoming.order.sequence != self.header.next_sequence || incoming.order.id != incoming.order.sequence {
                return Err(Error::InvalidSequence);
            }
            if touch_limit == 0 || touch_limit > MAX_TOUCHES { return Err(Error::InvalidWorkLimit); }
            if (incoming.post_only || incoming.order.expires_at.is_some()) && incoming.time_in_force != TimeInForce::Gtc { return Err(Error::InvalidOptions); }
            if incoming.order.expires_at.is_some_and(|expiry| now >= expiry) { return Err(Error::ExpiredIncoming); }
            // Persistent strictly monotone IDs remove the O(N) duplicate scan.
            let mut p = Plan::new(*self.header, incoming.order, touch_limit)?;
            let mut taker = incoming.order;
            let opposing = if taker.intent.side() == Side::Bid { Side::Ask } else { Side::Bid };
            let limit = taker.intent.canonical_price(taker.limit_price, self.header.payout)?;
            let mut stp = false;
            while taker.remaining > 0 && p.side_len(opposing) > 0 {
                let index = p.cell(self, opposing, 0)?;
                let maker = p.slot(self, index)?.order()?;
                validate_order(maker, p.after.payout)?;
                if maker.intent.side() != opposing { return Err(Error::InvalidStorage); }
                let price = maker.intent.canonical_price(maker.limit_price, p.after.payout)?;
                let expired = maker.expires_at.is_some_and(|expiry| now >= expiry);
                let crosses = if taker.intent.side() == Side::Bid { limit >= price } else { limit <= price };
                if !expired && !crosses { break; }
                if p.touched == touch_limit {
                    if incoming.time_in_force == TimeInForce::Ioc { break; }
                    return Err(Error::MatchLimitExceeded);
                }
                p.touched += 1;
                if expired {
                    p.pop(self, opposing)?;
                    p.effects.push(Effect::Removed { order: maker, reason: Removal::Expired });
                    continue;
                }
                if incoming.post_only { return Ok(p.reject(incoming.order, Disposition::PostOnlyWouldTrade)); }
                if maker.owner == taker.owner {
                    if incoming.self_trade != SelfTrade::CancelAggressor {
                        p.pop(self, opposing)?;
                        p.effects.push(Effect::Removed { order: maker, reason: Removal::SelfTrade });
                    }
                    if incoming.self_trade != SelfTrade::CancelResting { stp = true; break; }
                    continue;
                }
                let fill = plan_fill(maker, taker, price, p.after.payout, p.after.fee_bps)?;
                taker.remaining -= fill.quantity;
                taker.chain_notional = taker.chain_notional.checked_add(principals(price, fill.quantity, p.after.payout)?.for_outcome(taker.intent.outcome)).ok_or(Error::ArithmeticOverflow)?;
                let mut maker_after = maker;
                maker_after.remaining -= fill.quantity;
                maker_after.chain_notional = maker.chain_notional.checked_add(principals(price, fill.quantity, p.after.payout)?.for_outcome(maker.intent.outcome)).ok_or(Error::ArithmeticOverflow)?;
                if maker_after.remaining == 0 { p.pop(self, opposing)?; }
                else { p.set_slot(self, index, Slot::occupied(maker_after))?; }
                p.effects.push(Effect::Fill(fill));
            }
            if incoming.time_in_force == TimeInForce::Fok && taker.remaining > 0 {
                return Ok(p.reject(incoming.order, Disposition::FokNotFillable));
            }
            p.filled = incoming.order.remaining - taker.remaining;
            p.taker_chain_notional = taker.chain_notional;
            p.disposition = if taker.remaining == 0 { Disposition::Filled }
                else if stp {
                    p.canceled = taker.remaining;
                    if p.filled > 0 { Disposition::PartiallyFilledAndCanceled } else { Disposition::SelfTradePrevented }
                } else if incoming.time_in_force == TimeInForce::Gtc {
                    p.insert(self, taker)?;
                    p.rested = taker.remaining;
                    p.final_reserve = reserve(taker, p.after.fee_bps)?;
                    if p.filled > 0 { Disposition::PartiallyFilledAndResting } else { Disposition::Resting }
                } else {
                    p.canceled = taker.remaining;
                    if p.filled > 0 { Disposition::PartiallyFilledAndCanceled } else { Disposition::Canceled }
                };
            p.after.revision = p.after.revision.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            p.after.next_sequence = p.after.next_sequence.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
            Ok(p)
        }

        /// Must follow seat/collateral reservation validation in the program
        /// adapter. This guard borrows BOTH storage and plan until commit, so
        /// neither can change between validation and writes in safe Rust.
        pub fn validate<'s, 'p>(&'s mut self, p: &'p Plan) -> Result<Validated<'s, 'p, 'a>, Error> {
            if *self.header != p.before { return Err(Error::StalePlan); }
            for patch in &p.heap_patches {
                let heap = if patch.side == Side::Bid { &self.bids } else { &self.asks };
                if heap.get(usize::from(patch.index)) != Some(&patch.before) { return Err(Error::StalePlan); }
            }
            for patch in &p.slot_patches {
                if self.slots.get(usize::from(patch.index)) != Some(&patch.before) { return Err(Error::StalePlan); }
            }
            Ok(Validated { storage: self, plan: p })
        }

        /// Diagnostic/test iterator; runtime planning never scans all slots.
        pub fn orders(&self) -> impl Iterator<Item = Order> + '_ {
            self.slots.iter().filter_map(|slot| slot.order().ok())
        }
    }

    pub struct Validated<'s, 'p, 'a> { storage: &'s mut Storage<'a>, plan: &'p Plan }
    impl Validated<'_, '_, '_> {
        /// No arithmetic, allocation, token CPI, or fallible calls after the
        /// first write. Index bounds were proved by validate while exclusively
        /// borrowing the same slices. The adapter must make its economic commit
        /// equally infallible or propagate any failure as a transaction error.
        pub fn commit(self) {
            for patch in &self.plan.heap_patches {
                let heap = if patch.side == Side::Bid { &mut self.storage.bids } else { &mut self.storage.asks };
                heap[usize::from(patch.index)] = patch.after;
            }
            for patch in &self.plan.slot_patches { self.storage.slots[usize::from(patch.index)] = patch.after; }
            *self.storage.header = self.plan.after;
        }
    }

    #[derive(Clone, Copy, Debug)]
    struct HeapPatch { side: Side, index: u16, before: u16, after: u16 }
    #[derive(Clone, Copy, Debug)]
    struct SlotPatch { index: u16, before: Slot, after: Slot }

    // Checked on the actual target as well as the host: bounded heap buffers,
    // excluding allocator alignment/entrypoint/adapter overhead.
    const _: () = assert!(MAX_HEAP_PATCHES * std::mem::size_of::<HeapPatch>()
        + MAX_SLOT_PATCHES * std::mem::size_of::<SlotPatch>()
        + MAX_TOUCHES * std::mem::size_of::<Effect>() <= 16_384);

    /// Counts are measured deterministic operations, NOT Solana compute units.
    #[derive(Clone, Copy, Debug, Default)]
    pub struct Work {
        pub heap_reads: u32,
        pub slot_reads: u32,
        pub comparisons: u32,
        pub overlay_probes: u32,
        pub heap_write_requests: u32,
        pub slot_write_requests: u32,
    }

    #[derive(Debug)]
    pub struct Plan {
        before: Header,
        after: Header,
        heap_patches: Vec<HeapPatch>,
        slot_patches: Vec<SlotPatch>,
        effects: Vec<Effect>,
        disposition: Disposition,
        filled: u64,
        canceled: u64,
        rested: u64,
        touched: usize,
        taker_chain_notional: u64,
        required_reserve: Reserve,
        final_reserve: Reserve,
        work: Work,
    }

    impl Plan {
        fn new(header: Header, order: Order, limit: usize) -> Result<Self, Error> {
            Ok(Self { before: header, after: header,
                heap_patches: Vec::with_capacity(limit * 12 + 11),
                slot_patches: Vec::with_capacity(limit + 1), effects: Vec::with_capacity(limit),
                disposition: Disposition::Canceled, filled: 0, canceled: 0, rested: 0,
                touched: 0, taker_chain_notional: order.chain_notional,
                required_reserve: reserve(order, header.fee_bps)?, final_reserve: Reserve::default(), work: Work::default() })
        }
        pub fn disposition(&self) -> Disposition { self.disposition }
        pub fn quantities(&self) -> (u64, u64, u64) { (self.filled, self.canceled, self.rested) }
        pub fn effects(&self) -> &[Effect] { &self.effects }
        pub fn touched(&self) -> usize { self.touched }
        pub fn required_reserve(&self) -> Reserve { self.required_reserve }
        pub fn final_reserve(&self) -> Reserve { self.final_reserve }
        pub fn work(&self) -> Work { self.work }
        pub fn patch_counts(&self) -> (usize, usize) { (self.heap_patches.len(), self.slot_patches.len()) }
        pub fn scratch_bytes(&self) -> usize {
            self.heap_patches.capacity() * std::mem::size_of::<HeapPatch>()
                + self.slot_patches.capacity() * std::mem::size_of::<SlotPatch>()
                + self.effects.capacity() * std::mem::size_of::<Effect>()
        }
        fn reject(mut self, order: Order, disposition: Disposition) -> Self {
            self.after = self.before;
            self.heap_patches.clear(); self.slot_patches.clear(); self.effects.clear();
            self.disposition = disposition; self.filled = 0; self.rested = 0;
            self.canceled = order.remaining; self.taker_chain_notional = order.chain_notional;
            self.final_reserve = Reserve::default();
            self
        }
        fn side_len(&self, side: Side) -> u16 { if side == Side::Bid { self.after.bid_len } else { self.after.ask_len } }
        fn set_len(&mut self, side: Side, len: u16) { if side == Side::Bid { self.after.bid_len = len; } else { self.after.ask_len = len; } }

        // Tiny overlays are searched linearly; the benchmark reports every
        // probe, so the CPU cost isn't hidden behind an O(log N) heap claim.
        fn cell(&mut self, s: &Storage<'_>, side: Side, index: u16) -> Result<u16, Error> {
            self.work.heap_reads += 1;
            for patch in &self.heap_patches {
                self.work.overlay_probes += 1;
                if patch.side == side && patch.index == index { return Ok(patch.after); }
            }
            let heap = if side == Side::Bid { &s.bids } else { &s.asks };
            heap.get(usize::from(index)).copied().ok_or(Error::InvalidStorage)
        }
        fn slot(&mut self, s: &Storage<'_>, index: u16) -> Result<Slot, Error> {
            self.work.slot_reads += 1;
            for patch in &self.slot_patches {
                self.work.overlay_probes += 1;
                if patch.index == index { return Ok(patch.after); }
            }
            s.slots.get(usize::from(index)).copied().ok_or(Error::InvalidStorage)
        }
        fn set_cell(&mut self, s: &Storage<'_>, side: Side, index: u16, after: u16) -> Result<(), Error> {
            self.work.heap_write_requests += 1;
            for patch in &mut self.heap_patches {
                self.work.overlay_probes += 1;
                if patch.side == side && patch.index == index { patch.after = after; return Ok(()); }
            }
            if self.heap_patches.len() == self.heap_patches.capacity() { return Err(Error::PatchCapacity); }
            let heap = if side == Side::Bid { &s.bids } else { &s.asks };
            let before = *heap.get(usize::from(index)).ok_or(Error::InvalidStorage)?;
            self.heap_patches.push(HeapPatch { side, index, before, after });
            Ok(())
        }
        fn set_slot(&mut self, s: &Storage<'_>, index: u16, after: Slot) -> Result<(), Error> {
            self.work.slot_write_requests += 1;
            for patch in &mut self.slot_patches {
                self.work.overlay_probes += 1;
                if patch.index == index { patch.after = after; return Ok(()); }
            }
            if self.slot_patches.len() == self.slot_patches.capacity() { return Err(Error::PatchCapacity); }
            let before = *s.slots.get(usize::from(index)).ok_or(Error::InvalidStorage)?;
            self.slot_patches.push(SlotPatch { index, before, after });
            Ok(())
        }
        fn better(&mut self, s: &Storage<'_>, side: Side, a: u16, b: u16) -> Result<bool, Error> {
            self.work.comparisons += 1;
            let a = self.slot(s, a)?.order()?;
            let b = self.slot(s, b)?.order()?;
            if a.intent.side() != side || b.intent.side() != side { return Err(Error::InvalidStorage); }
            let a_price = a.intent.canonical_price(a.limit_price, self.after.payout)?;
            let b_price = b.intent.canonical_price(b.limit_price, self.after.payout)?;
            Ok(if a_price != b_price {
                if side == Side::Bid { a_price > b_price } else { a_price < b_price }
            } else { (a.sequence, a.id) < (b.sequence, b.id) })
        }
        fn pop(&mut self, s: &Storage<'_>, side: Side) -> Result<(), Error> {
            let len = self.side_len(side);
            if len == 0 { return Err(Error::InvalidStorage); }
            let removed = self.cell(s, side, 0)?;
            let last = self.cell(s, side, len - 1)?;
            let new_len = len - 1;
            self.set_len(side, new_len);
            self.set_cell(s, side, new_len, NONE)?;
            if new_len > 0 {
                let mut hole = 0u16;
                loop {
                    let left = hole * 2 + 1;
                    if left >= new_len { break; }
                    let mut child = left;
                    if left + 1 < new_len {
                        let right_slot = self.cell(s, side, left + 1)?;
                        let left_slot = self.cell(s, side, left)?;
                        if self.better(s, side, right_slot, left_slot)? { child += 1; }
                    }
                    let child_slot = self.cell(s, side, child)?;
                    if !self.better(s, side, child_slot, last)? { break; }
                    self.set_cell(s, side, hole, child_slot)?;
                    hole = child;
                }
                self.set_cell(s, side, hole, last)?;
            }
            self.set_slot(s, removed, Slot { next_free: self.after.free_head, ..Slot::default() })?;
            self.after.free_head = removed;
            self.after.active_len = self.after.active_len.checked_sub(1).ok_or(Error::InvalidStorage)?;
            Ok(())
        }
        fn insert(&mut self, s: &Storage<'_>, order: Order) -> Result<(), Error> {
            if self.after.active_len >= self.after.capacity { return Err(Error::BookFull); }
            let index = self.after.free_head;
            let free = self.slot(s, index)?;
            if free.flags != 0 { return Err(Error::InvalidStorage); }
            self.after.free_head = free.next_free;
            self.set_slot(s, index, Slot::occupied(order))?;
            let side = order.intent.side();
            let len = self.side_len(side);
            let mut hole = len;
            while hole > 0 {
                let parent = (hole - 1) / 2;
                let parent_slot = self.cell(s, side, parent)?;
                if !self.better(s, side, index, parent_slot)? { break; }
                self.set_cell(s, side, hole, parent_slot)?;
                hole = parent;
            }
            self.set_cell(s, side, hole, index)?;
            self.set_len(side, len + 1);
            self.after.active_len += 1;
            Ok(())
        }
    }

    #[inline(never)]
    fn plan_fill(maker: Order, taker: Order, price: u64, payout: u64, fee_bps: u16) -> Result<Fill, Error> {
        let quantity = maker.remaining.min(taker.remaining);
        let principals = principals(price, quantity, payout)?;
        let maker_notional = principals.for_outcome(maker.intent.outcome);
        let taker_notional = principals.for_outcome(taker.intent.outcome);
        let maker_fee = fee_math::fee_delta(maker.chain_notional, maker_notional, fee_bps).ok_or(Error::ArithmeticOverflow)?;
        let taker_fee = fee_math::fee_delta(taker.chain_notional, taker_notional, fee_bps).ok_or(Error::ArithmeticOverflow)?;
        let mut maker_after = maker;
        let mut taker_after = taker;
        maker_after.remaining -= quantity;
        taker_after.remaining -= quantity;
        maker_after.chain_notional = maker.chain_notional.checked_add(maker_notional).ok_or(Error::ArithmeticOverflow)?;
        taker_after.chain_notional = taker.chain_notional.checked_add(taker_notional).ok_or(Error::ArithmeticOverflow)?;
        Ok(Fill { maker_before: maker, taker_before: taker, quantity, canonical_yes_price: price,
            maker_fee, taker_fee, economics: economics(maker.intent, taker.intent, price, quantity, payout, maker_fee, taker_fee)?,
            maker_reserve_after: reserve(maker_after, fee_bps)?, taker_reserve_after: reserve(taker_after, fee_bps)? })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(outcome: Outcome, action: Action) -> Intent { Intent { outcome, action } }
    fn order(id: u64, owner: u64, outcome: Outcome, action: Action, price: u64, quantity: u64) -> Order {
        Order { id, owner, intent: intent(outcome, action), limit_price: price, remaining: quantity,
            sequence: id, expires_at: None, chain_notional: 0 }
    }
    fn incoming(order: Order, tif: TimeInForce) -> Incoming {
        Incoming { order, time_in_force: tif, post_only: false, self_trade: SelfTrade::CancelAggressor }
    }
    fn empty() -> Book { Book::new(100_000, 100, 32).unwrap() }
    fn rest(book: Book, order: Order) -> Book {
        let result = book.execute(incoming(order, TimeInForce::Gtc), 0, MAX_TOUCHES).unwrap();
        assert_eq!(result.disposition, Disposition::Resting);
        result.book
    }
    fn fills(result: &MatchResult) -> Vec<&Fill> {
        result.effects.iter().filter_map(|effect| if let Effect::Fill(fill) = effect { Some(fill) } else { None }).collect()
    }

    #[test]
    fn better_price_precedes_fifo_and_executes_maker_price() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Sell, 50_000, 2));
        let b = rest(b, order(2, 2, Outcome::Yes, Action::Sell, 40_000, 2));
        let b = rest(b, order(3, 3, Outcome::Yes, Action::Sell, 40_000, 2));
        let snapshot = b.orders();
        let r = b.execute(incoming(order(4, 4, Outcome::Yes, Action::Buy, 60_000, 5), TimeInForce::Gtc), 0, 16).unwrap();
        assert_eq!(fills(&r).iter().map(|f| (f.maker_before.id, f.canonical_yes_price, f.quantity)).collect::<Vec<_>>(), vec![(2, 40_000, 2), (3, 40_000, 2), (1, 50_000, 1)]);
        assert_eq!((r.filled, r.rested, r.canceled), (5, 0, 0));
        assert_eq!(r.book.orders()[0].remaining, 1);
        assert_eq!(b.orders(), snapshot);
    }

    #[test]
    fn bids_descend_and_no_orders_share_the_yes_book() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Buy, 60_000, 1));
        let b = rest(b, order(2, 2, Outcome::No, Action::Sell, 30_000, 1));
        let r = b.execute(incoming(order(3, 3, Outcome::No, Action::Buy, 45_000, 2), TimeInForce::Ioc), 0, 16).unwrap();
        assert_eq!(fills(&r).iter().map(|f| (f.maker_before.id, f.canonical_yes_price, f.economics.kind)).collect::<Vec<_>>(), vec![(2, 70_000, EconomicKind::TransferNo), (1, 60_000, EconomicKind::Mint)]);
        assert_eq!(r.taker_chain_notional, 70_000);
    }

    #[test]
    fn all_four_economics_balance_in_both_maker_directions() {
        let yb = intent(Outcome::Yes, Action::Buy);
        let nb = intent(Outcome::No, Action::Buy);
        let ys = intent(Outcome::Yes, Action::Sell);
        let ns = intent(Outcome::No, Action::Sell);
        for (a, b, kind, collateral) in [(yb, nb, EconomicKind::Mint, 300_000), (ys, ns, EconomicKind::Burn, -300_000), (yb, ys, EconomicKind::TransferYes, 0), (nb, ns, EconomicKind::TransferNo, 0)] {
            for (maker, taker) in [(a, b), (b, a)] {
                let e = economics(maker, taker, 40_000, 3, 100_000, 7, 11).unwrap();
                assert_eq!(e.kind, kind);
                assert_eq!(e.collateral, collateral);
                assert_eq!(e.revenue, 18);
                assert_eq!(e.maker_reserved_cash + e.maker_available_cash + e.taker_reserved_cash + e.taker_available_cash + e.collateral + e.revenue, 0);
                assert_eq!(e.maker_yes + e.taker_yes, match kind { EconomicKind::Mint => 3, EconomicKind::Burn => -3, _ => 0 });
                assert_eq!(e.maker_no + e.taker_no, match kind { EconomicKind::Mint => 3, EconomicKind::Burn => -3, _ => 0 });
            }
        }
    }

    #[test]
    fn gtc_rests_ioc_cancels_and_fok_rolls_back_all_effects() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Sell, 40_000, 2));
        let o = order(2, 2, Outcome::Yes, Action::Buy, 50_000, 3);
        let g = b.execute(incoming(o, TimeInForce::Gtc), 0, 16).unwrap();
        assert_eq!((g.disposition, g.filled, g.rested, g.final_reserve.cash), (Disposition::PartiallyFilledAndResting, 2, 1, 50_500));
        let i = b.execute(incoming(o, TimeInForce::Ioc), 0, 16).unwrap();
        assert_eq!((i.filled, i.canceled, i.rested, i.final_reserve.cash), (2, 1, 0, 0));
        let f = b.execute(incoming(o, TimeInForce::Fok), 0, 16).unwrap();
        assert_eq!(f.disposition, Disposition::FokNotFillable);
        assert!(f.effects.is_empty());
        assert_eq!(f.book.orders(), b.orders());
    }

    #[test]
    fn fok_full_fill_is_atomic_and_post_only_rejects_same_owner_cross() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Sell, 40_000, 2));
        let r = b.execute(incoming(order(2, 2, Outcome::Yes, Action::Buy, 40_000, 2), TimeInForce::Fok), 0, 16).unwrap();
        assert_eq!(r.disposition, Disposition::Filled);
        assert!(r.book.is_empty());
        let mut p = incoming(order(2, 1, Outcome::Yes, Action::Buy, 40_000, 1), TimeInForce::Gtc);
        p.post_only = true;
        p.self_trade = SelfTrade::CancelResting;
        let r = b.execute(p, 0, 16).unwrap();
        assert_eq!(r.disposition, Disposition::PostOnlyWouldTrade);
        assert!(r.effects.is_empty());
        assert_eq!(r.book.orders(), b.orders());
    }

    #[test]
    fn self_trade_modes_cancel_correct_parties() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Sell, 40_000, 1));
        let b = rest(b, order(2, 2, Outcome::Yes, Action::Sell, 45_000, 1));
        for (mode, makers_left, filled) in [(SelfTrade::CancelAggressor, 2, 0), (SelfTrade::CancelBoth, 1, 0), (SelfTrade::CancelResting, 0, 1)] {
            let mut i = incoming(order(3, 1, Outcome::Yes, Action::Buy, 50_000, 1), TimeInForce::Gtc);
            i.self_trade = mode;
            let r = b.execute(i, 0, 16).unwrap();
            assert_eq!((r.book.len(), r.filled), (makers_left, filled));
            assert_eq!(r.rested, 0);
        }
        let mut f = incoming(order(3, 1, Outcome::Yes, Action::Buy, 50_000, 2), TimeInForce::Fok);
        f.self_trade = SelfTrade::CancelResting;
        let r = b.execute(f, 0, 16).unwrap();
        assert_eq!(r.book.orders(), b.orders());
        assert!(r.effects.is_empty());
    }

    #[test]
    fn expiry_and_stp_consume_work_without_skipping_priority() {
        let mut expired = order(1, 1, Outcome::Yes, Action::Sell, 30_000, 1);
        expired.expires_at = Some(10);
        let b = rest(empty(), expired);
        let b = rest(b, order(2, 2, Outcome::Yes, Action::Sell, 40_000, 1));
        let o = order(3, 3, Outcome::Yes, Action::Buy, 50_000, 1);
        assert_eq!(b.execute(incoming(o, TimeInForce::Gtc), 10, 1).unwrap_err(), Error::MatchLimitExceeded);
        let i = b.execute(incoming(o, TimeInForce::Ioc), 10, 1).unwrap();
        assert_eq!((i.touched, i.filled, i.canceled), (1, 0, 1));
        assert_eq!(i.book.orders()[0].id, 2);
        let r = b.execute(incoming(o, TimeInForce::Gtc), 10, 2).unwrap();
        assert_eq!(fills(&r)[0].maker_before.id, 2);
        assert_eq!(r.touched, 2);
        let mut stp = incoming(order(3, 1, Outcome::Yes, Action::Buy, 50_000, 1), TimeInForce::Gtc);
        stp.self_trade = SelfTrade::CancelResting;
        assert_eq!(b.execute(stp, 0, 1).unwrap_err(), Error::MatchLimitExceeded);
    }

    #[test]
    fn bounded_ioc_prefix_and_gtc_fok_never_rest_crossed() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Sell, 40_000, 1));
        let b = rest(b, order(2, 2, Outcome::Yes, Action::Sell, 41_000, 1));
        let o = order(3, 3, Outcome::Yes, Action::Buy, 50_000, 2);
        for tif in [TimeInForce::Gtc, TimeInForce::Fok] {
            assert_eq!(b.execute(incoming(o, tif), 0, 1).unwrap_err(), Error::MatchLimitExceeded);
        }
        let r = b.execute(incoming(o, TimeInForce::Ioc), 0, 1).unwrap();
        assert_eq!((r.filled, r.canceled, r.rested), (1, 1, 0));
        assert_eq!(fills(&r)[0].maker_before.id, 1);
        assert_eq!(b.len(), 2);
    }

    #[test]
    fn capacity_rejection_is_atomic_and_full_book_can_still_fill() {
        let b = rest(Book::new(100_000, 0, 1).unwrap(), order(1, 1, Outcome::Yes, Action::Buy, 40_000, 1));
        let o = order(2, 2, Outcome::Yes, Action::Buy, 50_000, 1);
        assert_eq!(b.execute(incoming(o, TimeInForce::Gtc), 0, 16).unwrap_err(), Error::BookFull);
        let r = b.execute(incoming(order(2, 2, Outcome::Yes, Action::Sell, 40_000, 1), TimeInForce::Gtc), 0, 16).unwrap();
        assert!(r.book.is_empty());
    }

    #[test]
    fn fees_use_prior_chain_notional_and_reserve_releases_improvement() {
        let b = rest(Book::new(100_000, 1, 8).unwrap(), order(1, 1, Outcome::Yes, Action::Sell, 1, 1));
        let mut o = order(2, 2, Outcome::Yes, Action::Buy, 2, 2);
        o.chain_notional = 1;
        let r = b.execute(incoming(o, TimeInForce::Gtc), 0, 16).unwrap();
        assert_eq!(fills(&r)[0].taker_fee, 0);
        assert_eq!(r.taker_chain_notional, 2);
        assert_eq!(r.final_reserve.cash, 2);
        assert_eq!(reserve(o, 1).unwrap().cash - 1 - r.final_reserve.cash, 1);
    }

    #[test]
    fn rejects_invalid_options_identity_collisions_and_overflow() {
        let b = rest(empty(), order(1, 1, Outcome::Yes, Action::Buy, 40_000, 1));
        assert_eq!(b.execute(incoming(order(1, 2, Outcome::Yes, Action::Buy, 30_000, 1), TimeInForce::Gtc), 0, 16).unwrap_err(), Error::DuplicateOrder);
        let mut o = order(2, 2, Outcome::Yes, Action::Buy, 30_000, 1);
        o.sequence = 1;
        assert_eq!(b.execute(incoming(o, TimeInForce::Gtc), 0, 16).unwrap_err(), Error::DuplicateSequence);
        o.sequence = 2;
        o.expires_at = Some(1);
        assert_eq!(b.execute(incoming(o, TimeInForce::Ioc), 0, 16).unwrap_err(), Error::InvalidOptions);
        assert_eq!(b.execute(incoming(o, TimeInForce::Gtc), 1, 16).unwrap_err(), Error::ExpiredIncoming);
        o.expires_at = None;
        o.chain_notional = u64::MAX;
        assert_eq!(b.execute(incoming(o, TimeInForce::Gtc), 0, 16).unwrap_err(), Error::ArithmeticOverflow);
        assert_eq!(economics(intent(Outcome::Yes, Action::Sell), intent(Outcome::Yes, Action::Buy), 1, 1, 100_000, 2, 0), Err(Error::FeeExceedsProceeds));
        assert_eq!(principals(0, 1, 100_000), Err(Error::InvalidPrice));
        assert_eq!(principals(1, MAX_QUANTITY + 1, 100_000), Err(Error::InvalidQuantity));
    }

    #[test]
    fn rejection_preserves_prior_notional_and_all_expiry_effects_roll_back() {
        let mut first = order(1, 1, Outcome::Yes, Action::Sell, 30_000, 1);
        first.expires_at = Some(10);
        let b = rest(empty(), first);
        let b = rest(b, order(2, 2, Outcome::Yes, Action::Sell, 40_000, 1));
        let mut o = order(3, 3, Outcome::Yes, Action::Buy, 50_000, 2);
        o.chain_notional = 123;
        for tif in [TimeInForce::Gtc, TimeInForce::Fok] {
            let mut i = incoming(o, tif);
            i.post_only = tif == TimeInForce::Gtc;
            let r = b.execute(i, 10, 16).unwrap();
            assert_eq!(r.taker_chain_notional, 123);
            assert!(r.effects.is_empty());
            assert_eq!(r.book.orders(), b.orders());
        }
    }

    #[test]
    fn heap_order_matches_independent_sort_across_many_price_levels() {
        // Deterministic permutation exercises insertion order, tied prices, and
        // several bounded IOC sweeps on each side. All book state is admitted
        // through execute; no arbitrary balance or fill state is injected.
        for side in [Action::Buy, Action::Sell] {
            let mut b = Book::new(100_000, 37, 128).unwrap();
            let mut reference = Vec::new();
            for index in 0..96u64 {
                let seq = (index * 37) % 96 + 1;
                let o = order(seq, seq, Outcome::Yes, side, 20_000 + (seq % 11) * 100, 1);
                reference.push(o);
                b = rest(b, o);
            }
            reference.sort_by(|a, b| {
                let price = if side == Action::Buy { b.limit_price.cmp(&a.limit_price) } else { a.limit_price.cmp(&b.limit_price) };
                price.then(a.sequence.cmp(&b.sequence))
            });
            assert_eq!(b.orders(), reference);
            let mut actual = Vec::new();
            for batch in 0..6u64 {
                let action = if side == Action::Buy { Action::Sell } else { Action::Buy };
                let price = if action == Action::Buy { 99_999 } else { 1 };
                let r = b.execute(incoming(order(1_000 + batch, 1_000, Outcome::Yes, action, price, 16), TimeInForce::Ioc), 0, 16).unwrap();
                assert_eq!((r.touched, r.filled), (16, 16));
                actual.extend(fills(&r).iter().map(|fill| fill.maker_before.id));
                b = r.book;
            }
            assert_eq!(actual, reference.iter().map(|o| o.id).collect::<Vec<_>>());
            assert!(b.is_empty());
        }
    }

    #[test]
    fn full_fee_and_maximum_quantity_remain_exact_and_balanced() {
        let b = rest(Book::new(MAX_PAYOUT, 10_000, 2).unwrap(), order(1, 1, Outcome::No, Action::Sell, 1, MAX_QUANTITY));
        let r = b.execute(incoming(order(2, 2, Outcome::No, Action::Buy, 2, MAX_QUANTITY), TimeInForce::Fok), 0, 16).unwrap();
        let f = fills(&r)[0];
        assert_eq!((f.maker_fee, f.taker_fee), (MAX_QUANTITY, MAX_QUANTITY));
        assert_eq!(f.economics.maker_available_cash, 0);
        assert_eq!(f.economics.taker_reserved_cash, -20_000_000);
        assert_eq!(f.economics.revenue, 20_000_000);
        assert_eq!(f.economics.collateral, 0);
        assert!(r.book.is_empty());
    }
}
