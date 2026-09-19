//! Standalone matcher measurement and test harness; not a Goosey instruction.
//! Host: rustc --edition 2021 -O matching-bench.rs -o /tmp/matching-bench
//! Tests: rustc --edition 2021 --test matching-bench.rs -o /tmp/matching-tests
//!
//! Also builds as a separate SBPFv3 cdylib with the already-built anchor_lang
//! rlib. This file does not alter lib.rs, Cargo.toml, escrow, or its deployed API.
//! The SBF harness requires its own ephemeral program/account; do NOT deploy it
//! over Goosey's foundation. Main owns validator deployment/execution.
//!
//! Host nanoseconds and Work counters are NOT validator compute units. Use a
//! real benchmark-program transaction's meta.computeUnitsConsumed to measure CU.
//! One plan per instruction is the initial supported envelope: Solana's bump
//! allocator does not reclaim dropped Vec buffers, so multiple placements in a
//! single invocation need a reusable scratch arena or an explicitly measured
//! budget. Separate top-level instructions have separate VM heap lifetimes.
//!
//! Measurement checkpoint, 2026-09-19 (optimized host; NOT validator CU):
//! - Persistent bytes: 80-byte header + 1024*64-byte slots + two 1024*u16 heaps
//!   = 69,712, excluding a future Anchor discriminator. Borrow this account;
//!   do not deserialize/copy it onto stack or heap. Provision it separately
//!   (larger than the per-instruction account-growth allowance).
//! - 16-touch plan: exactly 3 allocations, 9,824 allocated/peak scratch bytes,
//!   unchanged across 16/128/1024-order books; validate/commit: zero allocations.
//! - Host Plan value 352 bytes, Effect 368 bytes. Target compile-time assertion
//!   separately bounds the three buffer capacities to <=16 KiB on SBPF.
//! - 1024-order/16-fill sample: 107 heap patches, 16 slot patches, 286 price
//!   comparisons, 30,073 overlay probes. Expiry/STP sample: 30,091 probes.
//!   Linear sparse-overlay lookup is bounded; see actual CU checkpoint below.
//!   16 touches is a ceiling, not a claim that default transaction CU suffices.
//! - SBPFv3 compile succeeds with platform-tools 1.54/Rust 1.89; ELF flags 0x3.
//!   No compiler stack diagnostics; direct r10-relative offsets are <=4096.
//!   This static check does NOT replace validator execution/compute testing.
//!
//! Reproduce separate harness build with the existing main-owned dependencies:
//! platform-tools/rust/bin/rustc --edition 2021 --crate-name matching_bench 
//!   --crate-type cdylib --target sbpfv3-solana-solana -C opt-level=3 -C panic=abort
//!   -L dependency=chain/target/sbpfv3-solana-solana/release/deps
//!   -L dependency=chain/target/release/deps
//!   --extern anchor_lang=chain/target/sbpfv3-solana-solana/release/deps/libanchor_lang-<hash>.rlib
//!   -o <temporary-directory>/matching_bench.so chain/benchmarks/matching-bench.rs
//!
//! Integration gate: main can deploy this separate benchmark locally, create a
//! rent-exempt 69,712-byte owned account, initialize opcode 0, then fill via
//! opcode 1. Measure transaction meta.computeUnitsConsumed for 1/8/16 fills at
//! 16/128/1024 resting orders, full-capacity rejection, FOK failure and success.
//! The optional 47-byte wire extends timestamps/STP/options for RPC benchmarks.
//! Add escrow/seat/event
//! overhead before selecting production touch/CU limits. The economic adapter
//! must aggregate and validate ALL seat/reserve/collateral changes before either
//! commit. This is not yet a deployable exchange or a replacement for its API.
//!
//! Actual validator checkpoint, 2026-09-19: Agave 4.2.2, unmodified features,
//! separate disposable ledger/RPC 28999 (not Goosey18999 or Hypatia24999).
//! Benchmark program: EWo3uGC4cjXiKAHsWtZdbM3EyZHUnE54CS7jUXJ65SHp
//! Genesis: 3WsKfnbw5syRLof67oDG9x1Ncm8BkvZ8hw3ruoqxVwmF
//! ELF SHA256: 0ab51b44d5d74e23da15f9f359bd98969d7744886267c24342360db7b416b531
//! Reproducer: matching-rpc.ts; all resting orders entered through program
//! instructions; CU from confirmed transaction meta, not simulation/host timing.
//! Book size       1-fill FOK      8-fill FOK      16-fill FOK
//! 16                 6,536          40,484           69,831
//! 128                8,268          78,929          186,698
//! 1024              10,334         128,672          381,066
//! Each measured fill is followed by real replenishment, so these are successive
//! valid heap states, not the same pristine heap snapshot. Not an exhaustive
//! upper bound over every possible heap/history.
//! 1024 orders: FOK17 touch-limit rejection 346,947; expiry FOK rollback 311,214;
//! STP FOK rollback 311,458; expiry IOC16 316,375; STP IOC16 316,619.
//! Post-only crossing 2,539; full-capacity rejection 1,525. Byte-for-byte account
//! checks verify all rejected commands leave the complete book unchanged.
//! Incoming quantity 10m over 16 fills: transferYES 70,707; mint 79,142;
//! burn 61,225; transferNO 69,628. These validate matcher arithmetic, NOT funded
//! exchange accounting: this benchmark deliberately has no cash/position state.
//! 24 measured transactions total. Raw logs/signatures/slots are retained at
//! /tmp/goosey-matcher-cu.FIT2D8/{measurements,economics}.json.
//! Implication: retain bounded16 support with an explicit measured CU budget;
//! 8 touches can be the smaller client option. Neither is a final integrated
//! budget: seat staging, collateral checks, nonces, events and Anchor add cost.

#[allow(dead_code)]
#[path = "../programs/goosey-exchange/src/matching.rs"]
mod matching;
use matching::*;
use matching::runtime::{Header, Slot, Storage};

const CAPACITY: usize = 1_024;
pub const STORAGE_BYTES: usize = std::mem::size_of::<Header>()
    + CAPACITY * std::mem::size_of::<Slot>() + 2 * CAPACITY * std::mem::size_of::<u16>();

fn incoming(sequence: u64, owner: u64, side: Action, price: u64, quantity: u64, tif: TimeInForce) -> Incoming {
    Incoming { order: Order { id: sequence, owner, intent: Intent { outcome: Outcome::Yes, action: side },
        limit_price: price, remaining: quantity, sequence, expires_at: None, chain_notional: 0 },
        time_in_force: tif, post_only: false, self_trade: SelfTrade::CancelAggressor }
}

#[cfg(not(target_os = "solana"))]
mod host {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub struct Meter;
    static LIVE: AtomicUsize = AtomicUsize::new(0);
    static PEAK: AtomicUsize = AtomicUsize::new(0);
    static TOTAL: AtomicUsize = AtomicUsize::new(0);
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    unsafe impl GlobalAlloc for Meter {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            let ptr = unsafe { System.alloc(layout) };
            if !ptr.is_null() {
                let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
                PEAK.fetch_max(live, Ordering::Relaxed);
                TOTAL.fetch_add(layout.size(), Ordering::Relaxed);
                COUNT.fetch_add(1, Ordering::Relaxed);
            }
            ptr
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            unsafe { System.dealloc(ptr, layout); }
        }
    }

    pub struct Backing {
        pub header: Header,
        pub slots: Vec<Slot>,
        pub bids: Vec<u16>,
        pub asks: Vec<u16>,
    }
    impl Backing {
        pub fn new(capacity: usize) -> Self {
            let mut b = Self { header: Header::default(), slots: vec![Slot::default(); capacity],
                bids: vec![0; capacity], asks: vec![0; capacity] };
            Storage::initialize([1; 32], 100_000, 100, &mut b.header, &mut b.slots, &mut b.bids, &mut b.asks).unwrap();
            b
        }
        pub fn view(&mut self) -> Storage<'_> {
            Storage::attach(&mut self.header, &mut self.slots, &mut self.bids, &mut self.asks).unwrap()
        }
        pub fn admit(&mut self, i: Incoming, now: i64) {
            let mut s = self.view();
            let p = s.plan(i, now, MAX_TOUCHES).unwrap();
            s.validate(&p).unwrap().commit();
        }
        #[cfg(test)]
        pub fn fingerprint(&self) -> (Header, Vec<Slot>, Vec<u16>, Vec<u16>) {
            (self.header, self.slots.clone(), self.bids.clone(), self.asks.clone())
        }
    }

    pub fn populated(n: usize, mode: &str) -> Backing {
        let mut b = Backing::new(n);
        for index in 0..n {
            let id = (index + 1) as u64;
            // Actual admissions through the planner, not raw fabricated book entries.
            let mut i = incoming(id, if mode == "stp" { 9_999 } else { id }, Action::Sell,
                20_000 + (id * 37 % 97) * 100, 1, TimeInForce::Gtc);
            if mode == "expiry" { i.order.expires_at = Some(10); }
            b.admit(i, 0);
        }
        b
    }

    pub fn run() {
        println!("PERSISTENT header={} slot={} book_1024={} plan_stack_value={} effect={}",
            std::mem::size_of::<Header>(), std::mem::size_of::<Slot>(), STORAGE_BYTES,
            std::mem::size_of::<runtime::Plan>(), std::mem::size_of::<Effect>());
        for n in [16, 128, 1_024] {
            for mode in ["fills", "fok_reject", "expiry", "stp"] {
                let mut b = populated(n, mode);
                let mut s = b.view();
                let qty = if mode == "fok_reject" { 17 } else { 16 };
                let tif = if mode == "fok_reject" { TimeInForce::Fok } else { TimeInForce::Ioc };
                let mut i = incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, qty, tif);
                if mode == "stp" { i.self_trade = SelfTrade::CancelResting; }
                let live = LIVE.load(Ordering::Relaxed);
                PEAK.store(live, Ordering::Relaxed);
                let total = TOTAL.load(Ordering::Relaxed);
                let count = COUNT.load(Ordering::Relaxed);
                let start = std::time::Instant::now();
                let result = s.plan(i, 10, MAX_TOUCHES);
                let elapsed = start.elapsed().as_nanos();
                let allocated = TOTAL.load(Ordering::Relaxed) - total;
                let peak = PEAK.load(Ordering::Relaxed) - live;
                let allocations = COUNT.load(Ordering::Relaxed) - count;
                match result {
                    Ok(p) => {
                        let before = COUNT.load(Ordering::Relaxed);
                        s.validate(&p).unwrap().commit();
                        assert_eq!(COUNT.load(Ordering::Relaxed), before, "validation/commit allocated");
                        println!("n={n} mode={mode} result={:?} scratch={} heap_patches={} slot_patches={} allocs={allocations} bytes={allocated} peak={peak} ns={elapsed} work={:?}",
                            p.disposition(), p.scratch_bytes(), p.patch_counts().0, p.patch_counts().1, p.work());
                    }
                    Err(error) => println!("n={n} mode={mode} error={error:?} allocs={allocations} bytes={allocated} peak={peak} ns={elapsed}"),
                }
            }
        }
    }
}

#[cfg(not(target_os = "solana"))]
#[global_allocator]
static ALLOCATOR: host::Meter = host::Meter;

#[cfg(not(target_os = "solana"))]
fn main() { host::run(); }

// Separate benchmark program, never wired into the Goosey foundation.
#[cfg(target_os = "solana")]
mod sbf {
    use super::*;
    use anchor_lang::solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
        program_error::ProgramError, pubkey::Pubkey, msg};
    entrypoint!(process);

    /// Accounts: writable program-owned scratch account, signing operator.
    /// Opcode 0 initializes 69,712 bytes, bound to this benchmark program.
    /// Opcode 1 submits: owner u64, price u64, quantity u64, action u8 (0 buy/1 sell),
    /// tif u8 (0 GTC/1 IOC/2 FOK), all little-endian; uses next onchain sequence.
    /// Setup uses actual opcode-1 admissions, one plan per instruction. Matching
    /// here changes ONLY benchmark orders, never foundation cash or positions.
    pub fn process(program: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        if accounts.len() != 2 || !accounts[1].is_signer || !accounts[0].is_writable || accounts[0].owner != program {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut bytes = accounts[0].try_borrow_mut_data()?;
        if bytes.len() != STORAGE_BYTES || (bytes.as_ptr() as usize) % std::mem::align_of::<Header>() != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        // Safety: exact length and alignment checked; repr(C) types contain only
        // integer/byte fields, accepting every bit pattern. Regions are disjoint,
        // in-bounds, and exclusively borrowed until the instruction returns.
        let (header, slots, bids, asks) = unsafe {
            let ptr = bytes.as_mut_ptr();
            let header = &mut *ptr.cast::<Header>();
            let slot_ptr = ptr.add(std::mem::size_of::<Header>());
            let bids_ptr = slot_ptr.add(CAPACITY * std::mem::size_of::<Slot>());
            let asks_ptr = bids_ptr.add(CAPACITY * 2);
            (header, std::slice::from_raw_parts_mut(slot_ptr.cast::<Slot>(), CAPACITY),
                std::slice::from_raw_parts_mut(bids_ptr.cast::<u16>(), CAPACITY),
                std::slice::from_raw_parts_mut(asks_ptr.cast::<u16>(), CAPACITY))
        };
        if data == [0] {
            if header.version != 0 { return Err(ProgramError::AccountAlreadyInitialized); }
            Storage::initialize(program.to_bytes(), 100_000, 100, header, slots, bids, asks)
                .map_err(|_| ProgramError::InvalidAccountData)?;
            return Ok(());
        }
        if ![27, 47].contains(&data.len()) || data[0] != 1 || data[25] > 1 || data[26] > 2 || header.domain != program.to_bytes() {
            return Err(ProgramError::InvalidInstructionData);
        }
        let read = |offset| u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
        let action = if data[25] == 0 { Action::Buy } else { Action::Sell };
        let tif = match data[26] { 0 => TimeInForce::Gtc, 1 => TimeInForce::Ioc, _ => TimeInForce::Fok };
        let mut storage = Storage::attach(header, slots, bids, asks).map_err(|_| ProgramError::InvalidAccountData)?;
        let mut input = incoming(storage.next_sequence(), read(1), action, read(9), read(17), tif);
        let (mut now, mut touches) = (0, MAX_TOUCHES);
        // Benchmark-only extended wire: expiry i64 (-1 means absent), now i64,
        // STP (0 aggressor/1 resting/2 both), post-only, touches, outcome (0 YES/1 NO).
        if data.len() == 47 {
            let expiry = read(27) as i64;
            input.order.expires_at = if expiry == -1 { None } else { Some(expiry) };
            now = read(35) as i64;
            input.self_trade = match data[43] { 0 => SelfTrade::CancelAggressor, 1 => SelfTrade::CancelResting,
                2 => SelfTrade::CancelBoth, _ => return Err(ProgramError::InvalidInstructionData) };
            if data[44] > 1 || data[46] > 1 { return Err(ProgramError::InvalidInstructionData); }
            input.post_only = data[44] == 1;
            input.order.intent.outcome = if data[46] == 0 { Outcome::Yes } else { Outcome::No };
            touches = usize::from(data[45]);
        }
        let plan = storage.plan(input, now, touches).map_err(|_| ProgramError::InvalidInstructionData)?;
        // Log static markers only; detailed host accounting isn't mixed with CU measurements.
        msg!("matching-bench: plan-ready");
        storage.validate(&plan).map_err(|_| ProgramError::InvalidAccountData)?.commit();
        msg!("matching-bench: committed");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::host::{Backing, populated};

    #[test]
    fn persistent_layout_and_bounded_scratch() {
        assert_eq!(STORAGE_BYTES, 69_712);
        for capacity in [16, 128, 1_024] {
            let mut b = populated(capacity, "fills");
            let s = b.view();
            let p = s.plan(incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, 16, TimeInForce::Fok), 0, 16).unwrap();
            assert!(p.scratch_bytes() < 16_384);
            assert_eq!(p.quantities(), (16, 0, 0));
            assert!(p.patch_counts().0 <= runtime::MAX_HEAP_PATCHES);
            assert!(p.patch_counts().1 <= runtime::MAX_SLOT_PATCHES);
        }
    }

    #[test]
    fn rejected_fok_post_only_and_errors_leave_every_byte_unchanged() {
        let mut b = populated(16, "fills");
        for tif in [TimeInForce::Fok, TimeInForce::Gtc] {
            let before = b.fingerprint();
            let mut s = b.view();
            let mut i = incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, 17, tif);
            i.post_only = tif == TimeInForce::Gtc;
            let p = s.plan(i, 0, 16).unwrap();
            assert!(p.effects().is_empty());
            assert_eq!(p.patch_counts(), (0, 0));
            s.validate(&p).unwrap().commit();
            assert_eq!(b.fingerprint(), before);
        }
        let before = b.fingerprint();
        let s = b.view();
        assert_eq!(s.plan(incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, 16, TimeInForce::Fok), 0, 1).unwrap_err(), Error::MatchLimitExceeded);
        assert_eq!(b.fingerprint(), before);
    }

    #[test]
    fn stale_plan_rejected_before_any_write_and_next_id_is_monotone() {
        let mut b = populated(16, "fills");
        let mut s = b.view();
        let i = incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, 1, TimeInForce::Ioc);
        let p = s.plan(i, 0, 16).unwrap();
        let competing = s.plan(i, 0, 16).unwrap();
        s.validate(&competing).unwrap().commit();
        assert!(matches!(s.validate(&p), Err(Error::StalePlan)));
        assert_eq!(s.len(), 15);
        assert_eq!(s.plan(i, 0, 16).unwrap_err(), Error::InvalidSequence);
    }

    #[test]
    fn runtime_capacity_and_late_revision_overflow_are_atomic() {
        let mut b = populated(16, "fills");
        let before = b.fingerprint();
        {
            let s = b.view();
            assert_eq!(s.plan(incoming(s.next_sequence(), 9_999, Action::Sell,
                99_999, 1, TimeInForce::Gtc), 0, 16).unwrap_err(), Error::BookFull);
        }
        assert_eq!(b.fingerprint(), before);
        // Exercise failure AFTER fills have been fully planned, before commit.
        b.header.revision = u64::MAX;
        let before = b.fingerprint();
        {
            let s = b.view();
            assert_eq!(s.plan(incoming(s.next_sequence(), 9_999, Action::Buy,
                99_999, 16, TimeInForce::Fok), 0, 16).unwrap_err(), Error::ArithmeticOverflow);
        }
        assert_eq!(b.fingerprint(), before);
    }

    #[test]
    fn corrupted_before_value_rejected_without_partial_apply() {
        let mut b = populated(16, "fills");
        let p = {
            let s = b.view();
            s.plan(incoming(s.next_sequence(), 9_999, Action::Buy, 99_999, 16, TimeInForce::Ioc), 0, 16).unwrap()
        };
        // Intentionally corrupt nonfinancial heap metadata to test validation.
        b.asks[0] = u16::MAX;
        let before = b.fingerprint();
        assert!(matches!(b.view().validate(&p), Err(Error::StalePlan)));
        assert_eq!(b.fingerprint(), before);
    }

    #[test]
    fn mixed_orders_match_snapshot_reference_for_2000_commands() {
        let mut b = Backing::new(128);
        let mut reference = Book::new(100_000, 100, 128).unwrap();
        let mut rng = 0x12345678u64;
        for tick in 0..2_000 {
            rng = rng.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let sequence = b.header.next_sequence;
            let action = if rng & 1 == 0 { Action::Buy } else { Action::Sell };
            let tif = match rng % 5 { 0 => TimeInForce::Fok, 1 => TimeInForce::Ioc, _ => TimeInForce::Gtc };
            let mut i = incoming(sequence, (rng >> 7) % 9, action, 30_000 + (rng >> 11) % 40_000, (rng >> 17) % 5 + 1, tif);
            i.order.intent.outcome = if rng & 4 == 0 { Outcome::Yes } else { Outcome::No };
            i.self_trade = match rng % 3 { 0 => SelfTrade::CancelAggressor, 1 => SelfTrade::CancelResting, _ => SelfTrade::CancelBoth };
            i.post_only = tif == TimeInForce::Gtc && rng & 32 == 0;
            if tif == TimeInForce::Gtc && rng & 64 == 0 { i.order.expires_at = Some(tick + 5); }
            let expected = reference.execute(i, tick, 16);
            let before = b.fingerprint();
            let mut s = b.view();
            let actual = s.plan(i, tick, 16);
            match (expected, actual) {
                (Ok(e), Ok(p)) => {
                    assert_eq!(p.disposition(), e.disposition);
                    assert_eq!(p.quantities(), (e.filled, e.canceled, e.rested));
                    assert_eq!(p.effects(), e.effects);
                    assert_eq!(p.final_reserve(), e.final_reserve);
                    s.validate(&p).unwrap().commit();
                    let mut actual_orders: Vec<_> = s.orders().collect();
                    actual_orders.sort_by_key(|o| o.id);
                    let mut expected_orders = e.book.orders();
                    expected_orders.sort_by_key(|o| o.id);
                    assert_eq!(actual_orders, expected_orders);
                    reference = e.book;
                }
                (Err(e), Err(a)) => { assert_eq!(e, a); assert_eq!(b.fingerprint(), before); }
                pair => panic!("reference/runtime mismatch at tick {tick}: {pair:?}"),
            }
        }
    }

    #[test]
    fn repeated_slot_reuse_partial_fills_and_expiry_stay_bounded() {
        let mut b = Backing::new(4);
        for round in 0..100 {
            let id = b.header.next_sequence;
            b.admit(incoming(id, 1, Action::Sell, 40_000, 3, TimeInForce::Gtc), 0);
            let id = b.header.next_sequence;
            b.admit(incoming(id, 2, Action::Buy, 40_000, 1, TimeInForce::Fok), 0);
            assert_eq!(b.view().orders().next().unwrap().remaining, 2);
            let id = b.header.next_sequence;
            b.admit(incoming(id, 2, Action::Buy, 40_000, 2, TimeInForce::Fok), 0);
            assert!(b.view().is_empty(), "round {round}");
        }
        let mut expired = incoming(b.header.next_sequence, 1, Action::Sell, 1, 1, TimeInForce::Gtc);
        expired.order.expires_at = Some(10);
        b.admit(expired, 0);
        let before = b.fingerprint();
        let mut s = b.view();
        let p = s.plan(incoming(s.next_sequence(), 2, Action::Buy, 1, 1, TimeInForce::Fok), 10, 16).unwrap();
        assert_eq!(p.disposition(), Disposition::FokNotFillable);
        s.validate(&p).unwrap().commit();
        assert_eq!(b.fingerprint(), before);
    }
}
