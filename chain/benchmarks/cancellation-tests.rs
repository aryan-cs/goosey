//! Standalone checks against the real foundation account types. Compile like
//! exchange-tests.rs, including CARGO_MANIFEST_DIR and existing dependency rlibs.
//! Test-only deposit fixtures; all outcome positions originate from adapter fills.
//! 2026-09-19: host suite and SBPFv3 handler/generated-account codegen pass with
//! -D warnings. Compile probe is NOT an instruction-dispatched deployment.
//! Main owns actual integrated cancellation/cleanup RPC and CU validation.
#[path = "exchange-tests.rs"]
mod adapter_tests;
pub use adapter_tests::*;
#[path = "../programs/goosey-exchange/src/cancellation.rs"]
pub mod cancellation;

// Compile both concrete Anchor handlers AND their generated account validators
// for SBPF, without wiring a program entrypoint or touching foundation lib.rs.
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn cancel_probe(ctx: anchor_lang::context::Context<cancellation::CancelOrder>,
    args: cancellation::CancelOrderArgs) -> anchor_lang::Result<()> { cancellation::cancel_order(ctx, args) }
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn cleanup_probe(ctx: anchor_lang::context::Context<cancellation::CleanupOrder>,
    target: cancellation::OrderTarget) -> anchor_lang::Result<()> { cancellation::cleanup_order(ctx, target) }
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn cancel_accounts_probe<'info>(program: &anchor_lang::prelude::Pubkey,
    accounts: &mut &'info [anchor_lang::prelude::AccountInfo<'info>], data: &[u8],
    bumps: &mut cancellation::CancelOrderBumps, reallocs: &mut std::collections::BTreeSet<anchor_lang::prelude::Pubkey>)
    -> anchor_lang::Result<cancellation::CancelOrder<'info>> {
    <cancellation::CancelOrder as anchor_lang::Accounts<cancellation::CancelOrderBumps>>::try_accounts(program, accounts, data, bumps, reallocs)
}
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn cleanup_accounts_probe<'info>(program: &anchor_lang::prelude::Pubkey,
    accounts: &mut &'info [anchor_lang::prelude::AccountInfo<'info>], data: &[u8],
    bumps: &mut cancellation::CleanupOrderBumps, reallocs: &mut std::collections::BTreeSet<anchor_lang::prelude::Pubkey>)
    -> anchor_lang::Result<cancellation::CleanupOrder<'info>> {
    <cancellation::CleanupOrder as anchor_lang::Accounts<cancellation::CleanupOrderBumps>>::try_accounts(program, accounts, data, bumps, reallocs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{prelude::*, AccountSerialize};
    use escrow::{Market, Seats, SeatLocator};
    use matching::{runtime::{Header, Slot, Storage}, Order};
    use exchange::PlaceOrderArgs;
    use cancellation::{OrderTarget, CancelOrderArgs, Fault, Reason};

    struct Fixture { key: Pubkey, market: Market, seats: Box<Seats>, header: Header,
        slots: Vec<Slot>, bids: Vec<u16>, asks: Vec<u16>, vault: u64 }
    fn args(action: u8, outcome: u8, price: u64, quantity: u64, tif: u8) -> PlaceOrderArgs {
        PlaceOrderArgs { expected_nonce: 0, price, quantity, action, outcome, time_in_force: tif,
            self_trade: 0, post_only: false, expires_at: None, touches: 16 }
    }
    impl Fixture {
        fn new(capacity: usize, fee: u16) -> Self {
            let key = Pubkey::new_unique();
            let mut seats = Box::<Seats>::new_uninit();
            unsafe { core::ptr::write_bytes(seats.as_mut_ptr(), 0, 1); }
            let mut seats = unsafe { seats.assume_init() };
            seats.market = key; seats.count = 4;
            for s in &mut seats.entries[..4] { s.wallet = Pubkey::new_unique(); s.enrollment = Pubkey::new_unique(); }
            let mut f = Self { key, market: Market { config: Pubkey::new_unique(), creator: Pubkey::new_unique(),
                seats: Pubkey::new_unique(), vault: Pubkey::new_unique(), market_id: 1, payout_milli: 100_000,
                closes_at: 100, resolves_at: 200, accounted_vault: 0, collateral: 0, fee_revenue: 0, fee_bps: fee, bump: 0 },
                seats, header: Header::default(), slots: vec![Slot::default(); capacity],
                bids: vec![0; capacity], asks: vec![0; capacity], vault: 0 };
            Storage::initialize(key.to_bytes(), 100_000, fee, &mut f.header, &mut f.slots, &mut f.bids, &mut f.asks).unwrap();
            // Explicit unit-test deposits; cancellation never creates balances.
            for s in &mut f.seats.entries[..4] { s.available_cash = 100_000_000; s.next_nonce = 1; }
            f.market.accounted_vault = 400_000_000; f.vault = 400_000_000;
            f
        }
        fn book(&mut self) -> Storage<'_> { Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap() }
        fn locator(&self, owner: usize) -> SeatLocator {
            SeatLocator { market: self.key, wallet: self.seats.entries[owner].wallet, index: owner as u32, bump: 0 }
        }
        fn place(&mut self, owner: usize, mut a: PlaceOrderArgs) -> u64 {
            a.expected_nonce = self.seats.entries[owner].next_nonce;
            let locator = self.locator(owner);
            let mut b = Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap();
            exchange::execute(self.key, locator.wallet, &locator, &mut self.market, &mut self.seats,
                self.vault, &mut b, a, 0).unwrap().order_id
        }
        fn target(&self, id: u64) -> OrderTarget {
            for (side, heap, len) in [(0, &self.bids, self.header.bid_len), (1, &self.asks, self.header.ask_len)] {
                for index in 0..usize::from(len) {
                    if self.slots[usize::from(heap[index])].order().unwrap().id == id {
                        return OrderTarget { order_id: id, side, heap_index: index as u16 };
                    }
                }
            }
            panic!("test order absent")
        }
        fn cancel(&mut self, owner: usize, target: OrderTarget, nonce: u64) -> core::result::Result<cancellation::Removed, Fault> {
            let locator = self.locator(owner);
            let mut b = Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap();
            cancellation::execute_owner(self.key, locator.wallet, &locator, &self.market, &mut self.seats,
                &mut b, CancelOrderArgs { target, expected_nonce: nonce })
        }
        fn cleanup(&mut self, target: OrderTarget, now: i64) -> core::result::Result<cancellation::Removed, Fault> {
            let mut b = Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap();
            cancellation::execute_cleanup(self.key, &self.market, &mut self.seats, &mut b, target, now)
        }
        fn snapshot(&self) -> (Vec<u8>, Vec<u8>, Header, Vec<Slot>, Vec<u16>, Vec<u16>) {
            let mut m = Vec::new(); self.market.try_serialize(&mut m).unwrap();
            (m, bytemuck::bytes_of(&*self.seats).to_vec(), self.header, self.slots.clone(), self.bids.clone(), self.asks.clone())
        }
        fn orders(&mut self) -> Vec<Order> { self.book().orders().collect() }
        fn invariants(&mut self) {
            let mut r = [matching::Reserve::default(); 4];
            for o in self.orders() {
                let v = matching::reserve(o, self.market.fee_bps).unwrap();
                r[o.owner as usize].cash += v.cash; r[o.owner as usize].yes += v.yes; r[o.owner as usize].no += v.no;
            }
            for (s, r) in self.seats.entries[..4].iter().zip(r) {
                assert_eq!((s.reserved_cash, s.reserved_yes, s.reserved_no), (r.cash, r.yes, r.no));
            }
            for (side, heap, len) in [(matching::Side::Bid, &self.bids, self.header.bid_len), (matching::Side::Ask, &self.asks, self.header.ask_len)] {
                let rank = |index: usize| {
                    let o = self.slots[usize::from(heap[index])].order().unwrap();
                    assert_eq!(o.intent.side(), side);
                    let p = o.intent.canonical_price(o.limit_price, 100_000).unwrap();
                    (if side == matching::Side::Bid { 100_000 - p } else { p }, o.sequence)
                };
                for i in 1..usize::from(len) { assert!(rank((i - 1) / 2) <= rank(i)); }
            }
        }
        fn mint(&mut self, qty: u64) {
            self.place(1, args(0, 1, 60_000, qty, 0)); self.place(0, args(0, 0, 40_000, qty, 2));
        }
    }

    #[test]
    fn exact_cash_yes_no_release_and_history_unchanged() {
        let mut f = Fixture::new(64, 17); f.mint(4);
        let ids = [(0, f.place(0, args(0, 0, 10_000, 3, 0))),
            (1, f.place(1, args(0, 1, 10_000, 3, 0))),
            (0, f.place(0, args(1, 0, 70_000, 2, 0))),
            (1, f.place(1, args(1, 1, 70_000, 2, 0)))];
        let financial = (f.market.accounted_vault, f.market.collateral, f.market.fee_revenue);
        for (owner, id) in ids {
            let before = f.seats.entries[owner]; let sequence = f.header.next_sequence;
            let r = f.cancel(owner, f.target(id), before.next_nonce).unwrap();
            let after = f.seats.entries[owner];
            assert_eq!(r.reason, Reason::Owner); assert_eq!(r.nonce, Some(before.next_nonce));
            assert_eq!(after.next_nonce, before.next_nonce + 1);
            assert_eq!(after.available_cash, before.available_cash + r.released.cash);
            assert_eq!(after.reserved_cash, before.reserved_cash - r.released.cash);
            assert_eq!((after.yes, after.no, after.ever_traded), (before.yes, before.no, before.ever_traded));
            assert_eq!((f.market.accounted_vault, f.market.collateral, f.market.fee_revenue), financial);
            assert_eq!(f.header.next_sequence, sequence); f.invariants();
        }
        assert!(f.orders().is_empty());
    }

    #[test]
    fn partial_fill_fee_chain_releases_exact_residual_not_original_reserve() {
        let mut f = Fixture::new(64, 1); f.mint(3);
        f.place(0, args(1, 0, 33_333, 1, 0));
        let id = f.place(2, args(0, 0, 40_001, 3, 0));
        f.place(0, args(1, 0, 40_001, 1, 2));
        let fees = f.market.fee_revenue;
        let r = f.cancel(2, f.target(id), f.seats.entries[2].next_nonce).unwrap();
        assert_eq!(r.order.remaining, 1); assert_eq!(r.order.chain_notional, 73_334);
        assert_eq!(r.released.cash, 40_005);
        assert_eq!(f.seats.entries[2].yes, 2); assert_eq!(f.market.fee_revenue, fees);
        f.invariants();
    }

    #[test]
    fn ownership_nonce_hint_replays_and_late_failures_are_atomic() {
        let mut f = Fixture::new(64, 100);
        let id = f.place(0, args(0, 0, 30_000, 3, 0)); let target = f.target(id);
        let nonce = f.seats.entries[0].next_nonce;
        let before = f.snapshot();
        assert!(matches!(f.cancel(1, target, f.seats.entries[1].next_nonce), Err(Fault::NotOwner)));
        assert!(matches!(f.cancel(0, target, nonce - 1), Err(Fault::Nonce)));
        let mut stale = target; stale.order_id += 1;
        assert!(matches!(f.cancel(0, stale, nonce), Err(Fault::StaleTarget)));
        assert_eq!(f.snapshot(), before);
        f.header.revision = u64::MAX;
        let corrupted = f.snapshot();
        assert!(matches!(f.cancel(0, target, nonce), Err(Fault::Overflow))); assert_eq!(f.snapshot(), corrupted);
        f.header.revision = before.2.revision;
        f.seats.entries[0].reserved_cash -= 1;
        let corrupted = f.snapshot();
        assert!(matches!(f.cancel(0, target, nonce), Err(Fault::InvalidReserves))); assert_eq!(f.snapshot(), corrupted);
        f.seats.entries[0].reserved_cash += 1;
        f.cancel(0, target, nonce).unwrap();
        let after = f.snapshot();
        assert!(matches!(f.cancel(0, target, nonce), Err(Fault::StaleTarget))); assert_eq!(f.snapshot(), after);
        let new_id = f.place(0, args(0, 0, 30_000, 3, 0)); assert!(new_id > id);
        let after = f.snapshot();
        assert!(matches!(f.cancel(0, target, f.seats.entries[0].next_nonce), Err(Fault::StaleTarget)));
        assert_eq!(f.snapshot(), after); f.invariants();
    }

    #[test]
    fn cleanup_requires_expiry_or_close_and_never_consumes_owner_nonce() {
        let mut f = Fixture::new(64, 100);
        let mut a = args(0, 0, 20_000, 1, 0); a.expires_at = Some(10);
        let expired = f.place(0, a); let live = f.place(1, args(0, 1, 20_000, 1, 0));
        let before = f.snapshot();
        assert!(matches!(f.cleanup(f.target(expired), 9), Err(Fault::NotEligible)));
        assert!(matches!(f.cleanup(f.target(live), 99), Err(Fault::NotEligible))); assert_eq!(f.snapshot(), before);
        f.seats.entries[0].next_nonce = u64::MAX; // Keeper must work even with exhausted signing nonce.
        let r = f.cleanup(f.target(expired), 10).unwrap();
        assert_eq!(r.reason, Reason::Expired); assert_eq!(r.nonce, None);
        assert_eq!(f.seats.entries[0].next_nonce, u64::MAX);
        let nonce = f.seats.entries[1].next_nonce;
        let r = f.cleanup(f.target(live), 100).unwrap();
        assert_eq!(r.reason, Reason::MarketClosed); assert_eq!(r.nonce, None);
        assert_eq!(f.seats.entries[1].next_nonce, nonce); f.invariants();
    }

    #[test]
    fn arbitrary_heap_removals_preserve_price_time_and_recycled_slots() {
        for side in [0, 1] {
            let mut f = Fixture::new(1_024, 17);
            let mut ids = Vec::new();
            for i in 0..1_024 { ids.push(f.place(i % 4, args(0, side, 1 + ((i * 37) % 999) as u64, 1, 0))); }
            let mut random = 0xabcdef_u64;
            for _ in 0..1_024 {
                random = random.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
                let index = (random as usize) % ids.len(); let id = ids.swap_remove(index);
                let target = f.target(id);
                let owner = f.slots[usize::from(if target.side == 0 { f.bids[usize::from(target.heap_index)] }
                    else { f.asks[usize::from(target.heap_index)] })].order().unwrap().owner as usize;
                let r = f.cancel(owner, target, f.seats.entries[owner].next_nonce).unwrap();
                assert!(r.heap_writes <= 12); f.invariants();
            }
            assert!(f.orders().is_empty());
            for _ in 0..128 {
                let id = f.place(0, args(0, side, 40_000, 1, 0));
                f.cancel(0, f.target(id), f.seats.entries[0].next_nonce).unwrap();
            }
            f.invariants();
        }
    }

    #[test]
    fn permissionless_root_drain_after_close_needs_no_owner_return() {
        let mut f = Fixture::new(1_024, 100);
        for i in 0..1_024 { f.place(i % 4, args(0, (i % 2) as u8, 10_000, 1, 0)); }
        let nonces: Vec<_> = f.seats.entries[..4].iter().map(|s| s.next_nonce).collect();
        while f.header.active_len > 0 {
            let side = if f.header.bid_len > 0 { 0 } else { 1 };
            let slot = if side == 0 { f.bids[0] } else { f.asks[0] };
            let id = f.slots[usize::from(slot)].order().unwrap().id;
            let r = f.cleanup(OrderTarget { order_id: id, side, heap_index: 0 }, 100).unwrap();
            assert_eq!(r.reason, Reason::MarketClosed); assert!(r.heap_writes <= 12);
        }
        f.invariants();
        for (s, nonce) in f.seats.entries[..4].iter().zip(nonces) {
            assert_eq!(s.next_nonce, nonce); assert_eq!((s.reserved_cash, s.reserved_yes, s.reserved_no), (0, 0, 0));
        }
    }

    #[test]
    fn closed_market_share_cleanup_and_owner_cancel_preserve_positions() {
        let mut f = Fixture::new(64, 100); f.mint(4);
        let yes = f.place(0, args(1, 0, 70_000, 3, 0));
        let no = f.place(1, args(1, 1, 70_000, 2, 0));
        let (yes_nonce, no_nonce) = (f.seats.entries[0].next_nonce, f.seats.entries[1].next_nonce);
        let collateral = f.market.collateral;
        let fees = f.market.fee_revenue;
        let yes_removed = f.cleanup(f.target(yes), 100).unwrap();
        assert_eq!((yes_removed.released.yes, yes_removed.released.no, yes_removed.released.cash), (3, 0, 0));
        assert_eq!(f.seats.entries[0].next_nonce, yes_nonce);
        // Mark market already closed; the owner path deliberately has no close
        // gate, so it still works after matching has become unavailable.
        f.market.closes_at = -1;
        let no_removed = f.cancel(1, f.target(no), no_nonce).unwrap();
        assert_eq!((no_removed.released.yes, no_removed.released.no), (0, 2));
        assert_eq!((f.seats.entries[0].yes, f.seats.entries[1].no), (4, 4));
        assert_eq!((f.market.collateral, f.market.fee_revenue), (collateral, fees));
        assert_eq!((f.seats.entries[0].ever_traded, f.seats.entries[1].ever_traded), (1, 1));
        f.invariants();
    }

    #[test]
    fn cancellation_invalidates_older_placement_plans() {
        let mut f = Fixture::new(64, 100);
        let id = f.place(0, args(0, 0, 30_000, 1, 0));
        let sequence = f.header.next_sequence;
        let plan = f.book().plan(matching::Incoming { order: Order { id: sequence, sequence, owner: 1,
            intent: matching::Intent { outcome: matching::Outcome::Yes, action: matching::Action::Buy },
            limit_price: 20_000, remaining: 1, expires_at: None, chain_notional: 0 },
            time_in_force: matching::TimeInForce::Gtc, post_only: false, self_trade: matching::SelfTrade::CancelAggressor }, 0, 8).unwrap();
        f.cancel(0, f.target(id), f.seats.entries[0].next_nonce).unwrap();
        assert!(matches!(f.book().validate(&plan), Err(matching::Error::StalePlan)));
        f.invariants();
    }
}
