//! Standalone host compilation harness for the real Anchor resolution adapter.
//! It deliberately does not wire the module into the deployable program.

pub use ::goosey_exchange::*;

// Keep the source-level harness within one crate so resolution's intentional
// `pub(crate)` admission bridge is exercised exactly as it is in the program.
#[path = "../programs/goosey-exchange/src/market_terms.rs"]
pub mod market_terms;

#[path = "../programs/goosey-exchange/src/resolution.rs"]
pub mod resolution;

#[cfg(test)]
mod economic_regressions {
    use super::resolution::{
        ClaimReceipt, Digest, Fault, Identity, MarketAccount, OracleIdentity, Outcome,
        ProposalAccount, ProposalFingerprint, ProposalStatus, ResolutionPhase,
        ResolutionState, Reviewer, SeatAccount, SettlementSnapshot,
    };

    fn id(value: u8) -> Identity { [value; 32] }
    fn digest(value: u8) -> Digest { [value; 32] }
    fn oracle(wallet: u8, enrollment: u8) -> OracleIdentity {
        OracleIdentity { wallet: id(wallet), enrollment: id(enrollment) }
    }
    fn reviewer(identity: OracleIdentity) -> Reviewer {
        Reviewer { identity, ever_traded: false }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Market {
        key: Identity,
        creator: Identity,
        payout: u64,
        closes: i64,
        resolves: i64,
        accounted: u64,
        collateral: u64,
        revenue: u64,
    }

    impl MarketAccount for Market {
        fn market_key(&self) -> Identity { self.key }
        fn creator(&self) -> Identity { self.creator }
        fn payout_milli(&self) -> u64 { self.payout }
        fn closes_at(&self) -> i64 { self.closes }
        fn resolves_at(&self) -> i64 { self.resolves }
        fn accounted_vault(&self) -> u64 { self.accounted }
        fn collateral(&self) -> u64 { self.collateral }
        fn fee_revenue(&self) -> u64 { self.revenue }
        fn set_collateral(&mut self, value: u64) { self.collateral = value; }
        fn set_fee_revenue(&mut self, value: u64) { self.revenue = value; }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct Seat {
        wallet: Identity,
        available: u64,
        reserved_cash: u64,
        yes: u64,
        no: u64,
        reserved_yes: u64,
        reserved_no: u64,
    }

    impl SeatAccount for Seat {
        fn wallet(&self) -> Identity { self.wallet }
        fn available_cash(&self) -> u64 { self.available }
        fn reserved_cash(&self) -> u64 { self.reserved_cash }
        fn yes(&self) -> u64 { self.yes }
        fn no(&self) -> u64 { self.no }
        fn reserved_yes(&self) -> u64 { self.reserved_yes }
        fn reserved_no(&self) -> u64 { self.reserved_no }
        fn set_available_cash(&mut self, value: u64) { self.available = value; }
        fn set_yes(&mut self, value: u64) { self.yes = value; }
        fn set_no(&mut self, value: u64) { self.no = value; }
    }

    fn market(payout: u64, cash: u64, pairs: u64, revenue: u64) -> Market {
        let collateral = payout.checked_mul(pairs).unwrap();
        Market {
            key: id(1), creator: id(2), payout, closes: 100, resolves: 120,
            accounted: cash.checked_add(collateral).unwrap().checked_add(revenue).unwrap(),
            collateral, revenue,
        }
    }

    fn snapshot(cash: u128, yes: u128, no: u128) -> SettlementSnapshot {
        SettlementSnapshot {
            open_orders: 0, available_cash: cash, reserved_cash: 0,
            yes, no, reserved_yes: 0, reserved_no: 0,
        }
    }

    fn state(market: &Market) -> ResolutionState {
        ResolutionState::initialize(market, oracle(3, 4), oracle(5, 6)).unwrap()
    }

    fn resolve(state: &mut ResolutionState, market: &Market, outcome: Outcome) -> ProposalAccount {
        let pairs = market.collateral / market.payout;
        let cash = market.accounted - market.collateral - market.revenue;
        state.close(market, snapshot(u128::from(cash), u128::from(pairs), u128::from(pairs)),
            market.accounted, market.closes).unwrap();
        let mut proposal = ProposalAccount::vacant(market.key, 1).unwrap();
        let fingerprint = state.propose(market, &mut proposal, reviewer(oracle(3, 4)),
            outcome, digest(7), digest(8), market.resolves).unwrap();
        state.approve(market, &mut proposal, reviewer(oracle(5, 6)),
            fingerprint, market.resolves).unwrap();
        proposal
    }

    #[test]
    fn close_and_finalize_failures_are_atomic_and_terminal_transitions_do_not_replay() {
        let market = market(3, 100, 10, 2);
        let mut state = state(&market);
        let initial = state;
        let mut blocked = snapshot(100, 10, 10);
        for field in 0..4 {
            blocked.open_orders = 0;
            blocked.reserved_cash = 0;
            blocked.reserved_yes = 0;
            blocked.reserved_no = 0;
            match field {
                0 => blocked.open_orders = 1,
                1 => blocked.reserved_cash = 1,
                2 => blocked.reserved_yes = 1,
                _ => blocked.reserved_no = 1,
            }
            let expected = if field == 0 { Fault::OrdersRemain } else { Fault::ReservesRemain };
            assert_eq!(state.close(&market, blocked, market.accounted, 100), Err(expected));
            assert_eq!(state, initial, "failed close mutated lifecycle state");
        }
        state.close(&market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        let closed = state;
        assert_eq!(state.close(&market, snapshot(100, 10, 10), market.accounted, 100),
            Err(Fault::InvalidPhase));
        assert_eq!(state, closed, "close replay mutated lifecycle state");

        let mut proposal = ProposalAccount::vacant(market.key, 1).unwrap();
        let fingerprint = state.propose(&market, &mut proposal, reviewer(oracle(3, 4)),
            Outcome::Yes, digest(7), digest(8), 120).unwrap();
        state.approve(&market, &mut proposal, reviewer(oracle(5, 6)), fingerprint, 120).unwrap();
        let resolved = state;
        let mut market_after = market;
        let original_market = market_after;

        let mut orders = snapshot(100, 10, 10); orders.open_orders = 1;
        assert_eq!(state.finalize(&mut market_after, orders, market.accounted), Err(Fault::OrdersRemain));
        assert_eq!((state, market_after), (resolved, original_market));
        let mut reserves = snapshot(100, 10, 10); reserves.reserved_no = 1;
        assert_eq!(state.finalize(&mut market_after, reserves, market.accounted), Err(Fault::ReservesRemain));
        assert_eq!((state, market_after), (resolved, original_market));
        assert_eq!(state.finalize(&mut market_after, snapshot(100, 0, 0), market.accounted),
            Err(Fault::ClaimsRemain));
        assert_eq!((state, market_after), (resolved, original_market));
    }

    #[test]
    fn rejected_proposal_sequences_and_stale_fingerprints_cannot_change_active_review() {
        let market = market(3, 100, 10, 2);
        let mut state = state(&market);
        state.close(&market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        let mut first = ProposalAccount::vacant(market.key, 1).unwrap();
        let first_fingerprint = state.propose(&market, &mut first, reviewer(oracle(3, 4)),
            Outcome::No, digest(7), digest(8), 120).unwrap();
        let pending = (state, first);

        let mut second_while_pending = ProposalAccount::vacant(market.key, 2).unwrap();
        assert_eq!(state.propose(&market, &mut second_while_pending, reviewer(oracle(3, 4)),
            Outcome::Yes, digest(9), digest(10), 121), Err(Fault::InvalidPhase));
        assert_eq!((state, first), pending);
        assert_eq!(second_while_pending.status, ProposalStatus::Vacant);

        let stale = ProposalFingerprint { sequence: 2, ..first_fingerprint };
        assert_eq!(state.approve(&market, &mut first, reviewer(oracle(5, 6)), stale, 121),
            Err(Fault::ProposalMismatch));
        assert_eq!((state, first), pending);
        state.reject(&market, &mut first, reviewer(oracle(5, 6)), first_fingerprint,
            digest(11), 121).unwrap();
        let rejected = (state, first);
        assert_eq!(state.approve(&market, &mut first, reviewer(oracle(5, 6)),
            first_fingerprint, 122), Err(Fault::InvalidPhase));
        assert_eq!((state, first), rejected, "review replay mutated rejected state");

        let mut reused_sequence = ProposalAccount::vacant(market.key, 1).unwrap();
        assert_eq!(state.propose(&market, &mut reused_sequence, reviewer(oracle(3, 4)),
            Outcome::Yes, digest(12), digest(13), 122), Err(Fault::ProposalMismatch));
        assert_eq!(state.next_proposal_sequence(), 2);
        let mut second = ProposalAccount::vacant(market.key, 2).unwrap();
        let second_fingerprint = state.propose(&market, &mut second, reviewer(oracle(3, 4)),
            Outcome::Yes, digest(12), digest(13), 122).unwrap();
        let second_pending = (state, second);
        assert_eq!(state.approve(&market, &mut second, reviewer(oracle(5, 6)),
            first_fingerprint, 123), Err(Fault::ProposalMismatch));
        assert_eq!((state, second), second_pending);
        state.approve(&market, &mut second, reviewer(oracle(5, 6)),
            second_fingerprint, 123).unwrap();
        assert_eq!((state.phase(), state.outcome()), (ResolutionPhase::Resolved, Some(Outcome::Yes)));
    }

    #[test]
    fn stale_claim_snapshots_cross_seat_receipts_and_multi_seat_void_dust_are_exact() {
        let mut market = market(5, 0, 2, 0);
        let mut state = state(&market);
        resolve(&mut state, &market, Outcome::Void);
        let vault = market.accounted;
        let mut seats = [
            Seat { wallet: id(10), available: 0, reserved_cash: 0, yes: 1, no: 0, reserved_yes: 0, reserved_no: 0 },
            Seat { wallet: id(11), available: 0, reserved_cash: 0, yes: 1, no: 0, reserved_yes: 0, reserved_no: 0 },
            Seat { wallet: id(12), available: 0, reserved_cash: 0, yes: 0, no: 1, reserved_yes: 0, reserved_no: 0 },
            Seat { wallet: id(13), available: 0, reserved_cash: 0, yes: 0, no: 1, reserved_yes: 0, reserved_no: 0 },
        ];
        let mut receipts = [
            ClaimReceipt::initialize(market.key, 0, id(10)).unwrap(),
            ClaimReceipt::initialize(market.key, 1, id(11)).unwrap(),
            ClaimReceipt::initialize(market.key, 2, id(12)).unwrap(),
            ClaimReceipt::initialize(market.key, 3, id(13)).unwrap(),
        ];

        let before_wrong_receipt = (state, market, seats[0], receipts[1]);
        assert_eq!(state.claim(&mut market, 0, &mut seats[0], &mut receipts[1],
            snapshot(0, 2, 2), vault, 130), Err(Fault::InvalidSeat));
        assert_eq!((state, market, seats[0], receipts[1]), before_wrong_receipt);

        assert_eq!(state.claim(&mut market, 0, &mut seats[0], &mut receipts[0],
            snapshot(0, 2, 2), vault, 130), Ok(2));
        let before_stale = (state, market, seats[1], receipts[1]);
        assert_eq!(state.claim(&mut market, 1, &mut seats[1], &mut receipts[1],
            snapshot(0, 2, 2), vault, 131), Err(Fault::Accounting));
        assert_eq!((state, market, seats[1], receipts[1]), before_stale,
            "stale pre-claim snapshot changed economic state");

        assert_eq!(state.claim(&mut market, 1, &mut seats[1], &mut receipts[1],
            snapshot(2, 1, 2), vault, 131), Ok(2));
        assert_eq!(state.claim(&mut market, 2, &mut seats[2], &mut receipts[2],
            snapshot(4, 0, 2), vault, 132), Ok(2));
        let before_early_finalize = (state, market);
        assert_eq!(state.finalize(&mut market, snapshot(6, 0, 0), vault), Err(Fault::ClaimsRemain));
        assert_eq!((state, market), before_early_finalize);
        assert_eq!(state.claim(&mut market, 3, &mut seats[3], &mut receipts[3],
            snapshot(6, 0, 1), vault, 133), Ok(2));

        let accounted = market.accounted;
        assert_eq!(state.finalize(&mut market, snapshot(8, 0, 0), vault), Ok(2));
        assert_eq!((state.phase(), state.claims_processed(), market.collateral,
            market.revenue, market.accounted), (ResolutionPhase::Finalized, 4, 0, 2, accounted));
        let finalized = (state, market);
        assert_eq!(state.finalize(&mut market, snapshot(8, 0, 0), vault), Err(Fault::InvalidPhase));
        assert_eq!((state, market), finalized, "finalization replay changed fee or collateral state");
    }
}
