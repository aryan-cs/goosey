//! Compile against the existing real foundation rlib; no mock account structs.
//! No lib.rs changes required. Unit account fixtures below model explicit
//! deposits; they do not claim to exercise SPL CPI (that is main's RPC suite).
//! Positions are generated ONLY through actual adapter mint fills, never seeded.
//!
//! Reproduction (existing toolchain/dependencies, no install or manifest edit):
//! Set CARGO_MANIFEST_DIR to chain/programs/goosey-exchange (absolute), so
//! Anchor's serde macro can resolve its dependency through the real manifest.
//! Host rustc --edition 2021 -D warnings --test chain/benchmarks/exchange-tests.rs
//!   -L dependency=chain/target/debug/deps
//!   --extern goosey_exchange=chain/target/debug/deps/libgoosey_exchange.rlib
//!   --extern anchor_lang=<matching-host-rlib> --extern anchor_spl=<host-rlib>
//!   --extern bytemuck=<host-rlib> -o <temporary-directory>/tests
//! Run that executable. SBPF codegen: use platform-tools1.54 rustc, --crate-type
//! cdylib --target sbpfv3-solana-solana -C opt-level=3 -C panic=abort, release
//! SBF rlibs and BOTH -L dependency=chain/target/sbpfv3-solana-solana/release/deps
//! and -L dependency=chain/target/release/deps. Do not deploy the compile probe.
//! Checkpoint 2026-09-19: 26 tests pass (9 adapter, 17 shared matcher/arithmetic),
//! including 3,000 account-state commands. SBPF handler AND derived Accounts
//! codegen pass with -D warnings, no stack diagnostics, direct frame offsets
//! <=4096. Actual integrated CU/RPC and PDA setup remain main's integration gate.
pub use ::goosey_exchange::*;
#[allow(dead_code)]
#[path = "../programs/goosey-exchange/src/matching.rs"]
pub mod matching;
#[path = "../programs/goosey-exchange/src/exchange.rs"]
pub mod exchange;

// Force code generation for the actual Anchor handler in an isolated SBPFv3
// compile check. This is NOT an instruction entrypoint or deployable test ABI.
#[cfg(target_os = "solana")]
#[no_mangle]
pub fn adapter_compile_probe(ctx: anchor_lang::context::Context<exchange::PlaceOrder>,
    args: exchange::PlaceOrderArgs) -> anchor_lang::Result<()> { exchange::place_order(ctx, args) }

#[cfg(target_os = "solana")]
#[no_mangle]
pub fn adapter_accounts_probe<'info>(program: &anchor_lang::prelude::Pubkey,
    accounts: &mut &'info [anchor_lang::prelude::AccountInfo<'info>], data: &[u8],
    bumps: &mut exchange::PlaceOrderBumps, reallocs: &mut std::collections::BTreeSet<anchor_lang::prelude::Pubkey>)
    -> anchor_lang::Result<exchange::PlaceOrder<'info>> {
    <exchange::PlaceOrder as anchor_lang::Accounts<exchange::PlaceOrderBumps>>::try_accounts(program, accounts, data, bumps, reallocs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{prelude::*, AccountSerialize};
    use escrow::{Market, SeatLocator, Seats};
    use exchange::{execute, Fault, PlaceOrderArgs};
    use matching::{runtime::{Header, Slot, Storage}, Disposition};

    struct Fixture { key: Pubkey, market: Market, seats: Box<Seats>, header: Header,
        slots: Vec<Slot>, bids: Vec<u16>, asks: Vec<u16>, vault: u64 }
    fn args(action: u8, outcome: u8, price: u64, quantity: u64, tif: u8) -> PlaceOrderArgs {
        PlaceOrderArgs { expected_nonce: 0, price, quantity, action, outcome, time_in_force: tif,
            self_trade: 0, post_only: false, expires_at: None, touches: 16 }
    }
    impl Fixture {
        fn new(capacity: usize, wallets: usize, fee: u16) -> Self {
            let key = Pubkey::new_unique();
            // Allocate the actual large zero-copy account off-stack.
            let mut seats = Box::<Seats>::new_uninit();
            unsafe { core::ptr::write_bytes(seats.as_mut_ptr(), 0, 1); }
            let mut seats = unsafe { seats.assume_init() };
            seats.market = key; seats.count = wallets as u32;
            for s in &mut seats.entries[..wallets] { s.wallet = Pubkey::new_unique(); s.enrollment = Pubkey::new_unique(); }
            let mut f = Self { key, market: Market { config: Pubkey::new_unique(), creator: Pubkey::new_unique(),
                seats: Pubkey::new_unique(), vault: Pubkey::new_unique(), market_id: 1, payout_milli: 100_000,
                closes_at: 100, resolves_at: 200, accounted_vault: 0, collateral: 0, fee_revenue: 0, fee_bps: fee, bump: 0 },
                seats, header: Header::default(), slots: vec![Slot::default(); capacity],
                bids: vec![0; capacity], asks: vec![0; capacity], vault: 0 };
            Storage::initialize(key.to_bytes(), 100_000, fee, &mut f.header, &mut f.slots, &mut f.bids, &mut f.asks).unwrap();
            f
        }
        /// Mirrors the existing deposit ledger transition, for unit isolation.
        /// This test setup is not part of the adapter or public instruction API.
        fn deposited(&mut self, owner: usize, amount: u64) {
            self.seats.entries[owner].available_cash += amount;
            self.seats.entries[owner].next_nonce += 1;
            self.market.accounted_vault += amount; self.vault += amount;
        }
        fn send(&mut self, owner: usize, mut a: PlaceOrderArgs) -> core::result::Result<exchange::Execution, Fault> {
            a.expected_nonce = self.seats.entries[owner].next_nonce;
            self.raw(owner, a, 0)
        }
        fn raw(&mut self, owner: usize, a: PlaceOrderArgs, now: i64) -> core::result::Result<exchange::Execution, Fault> {
            let wallet = self.seats.entries[owner].wallet;
            let locator = SeatLocator { market: self.key, wallet, index: owner as u32, bump: 0 };
            let mut book = Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap();
            execute(self.key, wallet, &locator, &mut self.market, &mut self.seats, self.vault, &mut book, a, now)
        }
        fn snapshot(&self) -> (Vec<u8>, Vec<u8>, Header, Vec<Slot>, Vec<u16>, Vec<u16>) {
            let mut m = Vec::new(); self.market.try_serialize(&mut m).unwrap();
            (m, bytemuck::bytes_of(&*self.seats).to_vec(), self.header, self.slots.clone(), self.bids.clone(), self.asks.clone())
        }
        fn invariants(&mut self) {
            let book = Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap();
            let mut cash = 0u128; let mut yes = 0u128; let mut no = 0u128;
            let mut reserves = vec![matching::Reserve::default(); self.seats.count as usize];
            for order in book.orders() {
                let r = matching::reserve(order, self.market.fee_bps).unwrap();
                let sum = &mut reserves[order.owner as usize]; sum.cash += r.cash; sum.yes += r.yes; sum.no += r.no;
            }
            for (s, r) in self.seats.entries.iter().zip(&reserves) {
                assert_eq!((s.reserved_cash, s.reserved_yes, s.reserved_no), (r.cash, r.yes, r.no));
                assert!(s.reserved_yes <= s.yes && s.reserved_no <= s.no);
                cash += u128::from(s.available_cash) + u128::from(s.reserved_cash);
                yes += u128::from(s.yes); no += u128::from(s.no);
            }
            assert_eq!(yes, no);
            assert_eq!(yes * 100_000, u128::from(self.market.collateral));
            assert_eq!(cash + u128::from(self.market.collateral) + u128::from(self.market.fee_revenue), u128::from(self.market.accounted_vault));
            assert!(self.vault >= self.market.accounted_vault);
        }
        fn mint(&mut self, yes_owner: usize, no_owner: usize, qty: u64) {
            self.send(no_owner, args(0, 1, 60_000, qty, 0)).unwrap();
            self.send(yes_owner, args(0, 0, 40_000, qty, 2)).unwrap();
            self.invariants();
        }
    }

    #[test]
    fn mint_transfer_both_outcomes_and_burn_use_real_seat_state() {
        let mut f = Fixture::new(64, 4, 100);
        for i in 0..4 { f.deposited(i, 2_000_000); }
        f.mint(0, 1, 4);
        assert_eq!((f.seats.entries[0].yes, f.seats.entries[1].no, f.market.collateral), (4, 4, 400_000));
        f.send(0, args(1, 0, 50_000, 2, 0)).unwrap();
        f.send(2, args(0, 0, 60_000, 2, 2)).unwrap(); f.invariants();
        assert_eq!((f.seats.entries[0].yes, f.seats.entries[2].yes), (2, 2));
        f.send(1, args(1, 1, 30_000, 2, 0)).unwrap();
        f.send(3, args(0, 1, 40_000, 2, 2)).unwrap(); f.invariants();
        assert_eq!((f.seats.entries[1].no, f.seats.entries[3].no), (2, 2));
        f.send(2, args(1, 0, 50_000, 2, 0)).unwrap();
        f.send(3, args(1, 1, 50_000, 2, 2)).unwrap(); f.invariants();
        assert_eq!((f.seats.entries[2].yes, f.seats.entries[3].no, f.market.collateral), (0, 0, 200_000));
        assert!(f.seats.entries[..4].iter().all(|s| s.ever_traded == 1));
    }

    #[test]
    fn gtc_partial_reserve_and_lifetime_fee_survive_maker_taker_transition() {
        let mut f = Fixture::new(64, 4, 1);
        for i in 0..4 { f.deposited(i, 2_000_000); }
        f.mint(0, 1, 5);
        f.send(0, args(1, 0, 33_333, 1, 0)).unwrap();
        let p = f.send(2, args(0, 0, 40_001, 3, 0)).unwrap();
        assert_eq!(p.plan.disposition(), Disposition::PartiallyFilledAndResting);
        assert_eq!(f.seats.entries[2].reserved_cash, 80_010); // 80,002 principal + fee delta 8
        f.invariants();
        let before_fees = f.market.fee_revenue;
        f.send(0, args(1, 0, 40_001, 1, 2)).unwrap();
        f.invariants();
        assert_eq!(f.seats.entries[2].reserved_cash, 40_005);
        f.send(0, args(1, 0, 40_001, 1, 2)).unwrap(); f.invariants();
        assert_eq!(f.seats.entries[2].reserved_cash, 0);
        // Buyer lifetime ceil((33333+40001+40001)/10000)=12, first fill 4,
        // two subsequent maker fills charge only 8 total, not 10.
        assert_eq!(f.market.fee_revenue - before_fees, 8 + 5 + 5);
    }

    #[test]
    fn failed_commands_preserve_all_accounts_and_nonce() {
        let mut f = Fixture::new(32, 3, 100);
        for i in 0..3 { f.deposited(i, 1_000_000); }
        f.mint(0, 1, 2);
        f.send(0, args(1, 0, 40_000, 1, 0)).unwrap();
        let before = f.snapshot();
        assert!(matches!(f.send(2, args(0, 0, 40_000, 2, 2)), Err(Fault::FokRejected)));
        assert_eq!(f.snapshot(), before);
        let mut post = args(0, 0, 40_000, 1, 0); post.post_only = true;
        assert!(matches!(f.send(2, post), Err(Fault::PostOnlyRejected))); assert_eq!(f.snapshot(), before);
        assert!(matches!(f.send(2, args(0, 0, 99_999, 100, 0)), Err(Fault::InsufficientCash))); assert_eq!(f.snapshot(), before);
        assert!(matches!(f.send(2, args(1, 0, 10, 1, 0)), Err(Fault::InsufficientPosition))); assert_eq!(f.snapshot(), before);
        let mut stale = args(0, 0, 40_000, 1, 2); stale.expected_nonce = 99;
        assert!(matches!(f.raw(2, stale, 0), Err(Fault::Nonce))); assert_eq!(f.snapshot(), before);
        let mut closed = args(0, 0, 40_000, 1, 2); closed.expected_nonce = f.seats.entries[2].next_nonce;
        assert!(matches!(f.raw(2, closed, 100), Err(Fault::Closed))); assert_eq!(f.snapshot(), before);
        f.send(2, closed).unwrap(); f.invariants();
        let after = f.snapshot();
        assert!(matches!(f.raw(2, closed, 0), Err(Fault::Nonce))); assert_eq!(f.snapshot(), after);
    }

    #[test]
    fn sixteen_makers_touch_seventeen_seats_and_keep_untouched_seats_exact() {
        let mut f = Fixture::new(1_024, 19, 100);
        for i in 0..19 { f.deposited(i, 3_000_000); }
        for i in 0..16 { f.send(i, args(0, 1, 60_000, 1, 0)).unwrap(); }
        let untouched = bytemuck::bytes_of(&f.seats.entries[18]).to_vec();
        let p = f.send(16, args(0, 0, 40_000, 16, 2)).unwrap();
        assert_eq!(p.plan.effects().len(), 16); f.invariants();
        assert_eq!(bytemuck::bytes_of(&f.seats.entries[18]), untouched);
        assert_eq!(f.seats.entries[16].yes, 16);
    }

    #[test]
    fn stp_and_expiry_release_only_the_removed_orders_reserves() {
        let mut f = Fixture::new(64, 3, 100);
        for i in 0..3 { f.deposited(i, 2_000_000); }
        f.send(0, args(0, 1, 60_000, 2, 0)).unwrap();
        let mut cancel = args(0, 0, 40_000, 1, 1); cancel.self_trade = 1;
        f.send(0, cancel).unwrap(); f.invariants();
        assert_eq!(f.seats.entries[0].reserved_cash, 0);
        assert_eq!(f.seats.entries[0].available_cash, 2_000_000);
        let mut expiry = args(0, 1, 60_000, 2, 0); expiry.expires_at = Some(5);
        f.send(1, expiry).unwrap();
        f.send(1, args(0, 1, 50_000, 3, 0)).unwrap();
        let mut clean = args(0, 0, 40_000, 1, 1); clean.expected_nonce = f.seats.entries[2].next_nonce;
        f.raw(2, clean, 5).unwrap(); f.invariants();
        assert_eq!(f.seats.entries[1].reserved_cash, 151_500);
        assert_eq!(f.market.collateral, 0);
    }

    #[test]
    fn late_bad_maker_reserve_rolls_back_previously_staged_fill() {
        let mut f = Fixture::new(64, 4, 100);
        for i in 0..4 { f.deposited(i, 2_000_000); }
        f.mint(0, 1, 1); f.mint(2, 1, 1);
        f.send(0, args(1, 0, 30_000, 1, 0)).unwrap();
        f.send(2, args(1, 0, 40_000, 1, 0)).unwrap();
        // Deliberate invariant corruption, not a production funding mechanism.
        // First maker is valid; second maker fails only after staging first fill.
        f.seats.entries[2].reserved_yes = 0;
        let before = f.snapshot();
        assert!(matches!(f.send(3, args(0, 0, 40_000, 2, 2)), Err(Fault::InvalidReserves)));
        assert_eq!(f.snapshot(), before);
    }

    #[test]
    fn invalid_backing_domain_nonce_overflow_and_default_bound_are_atomic() {
        let mut f = Fixture::new(64, 18, 100);
        for i in 0..18 { f.deposited(i, 2_000_000); }
        for i in 0..16 { f.send(i, args(0, 1, 60_000, 1, 0)).unwrap(); }
        let before = f.snapshot();
        let mut input = args(0, 0, 40_000, 16, 2); input.touches = 0;
        assert!(matches!(f.send(16, input), Err(Fault::Matcher(matching::Error::MatchLimitExceeded))));
        assert_eq!(f.snapshot(), before);
        f.vault -= 1;
        assert!(matches!(f.send(16, input), Err(Fault::VaultUnderfunded))); assert_eq!(f.snapshot(), before);
        f.vault += 1;
        f.header.domain = Pubkey::new_unique().to_bytes();
        let changed = f.snapshot();
        assert!(matches!(f.send(16, input), Err(Fault::Binding))); assert_eq!(f.snapshot(), changed);
        f.header.domain = f.key.to_bytes();
        f.seats.entries[16].next_nonce = u64::MAX;
        let changed = f.snapshot();
        assert!(matches!(f.send(16, input), Err(Fault::Overflow))); assert_eq!(f.snapshot(), changed);
        f.seats.entries[16].next_nonce = 1;
        input.touches = 16;
        f.send(16, input).unwrap(); f.invariants();
    }

    #[test]
    fn thousands_of_account_commands_preserve_all_reserve_and_backing_invariants() {
        let mut f = Fixture::new(128, 12, 17);
        for i in 0..12 { f.deposited(i, 10_000_000); }
        for pair in 0..6 { f.mint(pair * 2, pair * 2 + 1, 10); }
        let mut rng = 0x5eed_u64;
        let mut accepted = 0; let mut rejected = 0;
        for step in 0..3_000 {
            rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let owner = ((rng >> 7) % 12) as usize;
            let mut a = args(((rng >> 5) & 1) as u8, ((rng >> 9) & 1) as u8,
                1 + (rng >> 13) % 99_999, 1 + (rng >> 21) % 4, ((rng >> 29) % 3) as u8);
            a.self_trade = ((rng >> 33) % 3) as u8;
            a.post_only = a.time_in_force == 0 && rng & 128 == 0;
            if a.time_in_force == 0 && rng & 256 == 0 { a.expires_at = Some(step / 40 + 2); }
            a.expected_nonce = f.seats.entries[owner].next_nonce;
            let before = f.snapshot();
            match f.raw(owner, a, step / 40) {
                Ok(_) => { accepted += 1; f.invariants(); }
                Err(_) => { rejected += 1; assert_eq!(f.snapshot(), before); }
            }
        }
        assert!(accepted > 100 && rejected > 100);
    }

    #[test]
    fn zero_and_full_fee_rates_and_unsolicited_vault_surplus() {
        for fee in [0, 10_000] {
            let mut f = Fixture::new(32, 3, fee);
            for i in 0..3 { f.deposited(i, 1_000_000); }
            f.vault += 99; // Uncredited donation: must not create user credit.
            f.mint(0, 1, 2);
            f.send(0, args(1, 0, 50_000, 2, 0)).unwrap();
            f.send(2, args(0, 0, 50_000, 2, 2)).unwrap(); f.invariants();
            f.send(2, args(1, 0, 50_000, 2, 0)).unwrap();
            f.send(1, args(1, 1, 50_000, 2, 2)).unwrap(); f.invariants();
            assert_eq!(f.market.accounted_vault, 3_000_000);
            assert_eq!(f.vault - f.market.accounted_vault, 99);
            assert_eq!(f.market.collateral, 0);
        }
    }
}
