//! Deterministic result approval and payout state plus the concrete Anchor
//! adapters for the retained escrow market, seat array and canonical CLOB.
//!
//! The adapter below never accepts caller-computed book
//! counts or reserves: it derives both from `matching::runtime::Storage` and
//! reconciles every order reserve to its canonical seat before close/claim/finalize.

use anchor_lang::prelude::*;
use crate::{escrow, matching};

pub type Identity = [u8; 32];
pub type Digest = [u8; 32];

const ZERO: [u8; 32] = [0; 32];

pub const RESOLUTION_SEED: &[u8] = b"resolution";
pub const RESOLUTION_PROPOSAL_SEED: &[u8] = b"resolution_proposal";
pub const RESOLUTION_CLAIM_SEED: &[u8] = b"resolution_claim";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum Outcome {
    Yes = 0,
    No = 1,
    Void = 2,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ResolutionPhase {
    Open = 0,
    Closed = 1,
    ProposalPending = 2,
    Resolved = 3,
    Finalized = 4,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum ProposalStatus {
    Vacant = 0,
    Pending = 1,
    Approved = 2,
    Rejected = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleIdentity {
    pub wallet: Identity,
    pub enrollment: Identity,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reviewer {
    pub identity: OracleIdentity,
    /// Must come from the permanent market seat history, not current holdings.
    pub ever_traded: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProposalFingerprint {
    pub sequence: u64,
    pub outcome: Outcome,
    pub reason_digest: Digest,
    pub evidence_digest: Digest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementSnapshot {
    pub open_orders: u64,
    pub available_cash: u128,
    pub reserved_cash: u128,
    pub yes: u128,
    pub no: u128,
    pub reserved_yes: u128,
    pub reserved_no: u128,
}

impl SettlementSnapshot {
    fn require_drained(self) -> Checked<()> {
        if self.open_orders != 0 {
            return Err(Fault::OrdersRemain);
        }
        if self.reserved_cash != 0 || self.reserved_yes != 0 || self.reserved_no != 0 {
            return Err(Fault::ReservesRemain);
        }
        Ok(())
    }
}

/// Adapter for the retained escrow `Market` fields. The account address is
/// supplied by the eventual wrapper because the current struct does not store it.
pub trait MarketAccount {
    fn market_key(&self) -> Identity;
    fn creator(&self) -> Identity;
    fn payout_milli(&self) -> u64;
    fn closes_at(&self) -> i64;
    fn resolves_at(&self) -> i64;
    fn accounted_vault(&self) -> u64;
    fn collateral(&self) -> u64;
    fn fee_revenue(&self) -> u64;
    fn set_collateral(&mut self, value: u64);
    fn set_fee_revenue(&mut self, value: u64);
}

/// Adapter for the retained escrow `Seat`. YES/NO are total holdings;
/// `reserved_yes`/`reserved_no` are encumbrances, not additional balances.
pub trait SeatAccount {
    fn wallet(&self) -> Identity;
    fn available_cash(&self) -> u64;
    fn reserved_cash(&self) -> u64;
    fn yes(&self) -> u64;
    fn no(&self) -> u64;
    fn reserved_yes(&self) -> u64;
    fn reserved_no(&self) -> u64;
    fn set_available_cash(&mut self, value: u64);
    fn set_yes(&mut self, value: u64);
    fn set_no(&mut self, value: u64);
}

/// Concrete view over the retained Anchor market account. Its address is kept
/// alongside the account because `escrow::Market` deliberately does not store
/// its own PDA.
pub struct AnchorMarketAdapter<'a> {
    pub key: Pubkey,
    pub account: &'a mut escrow::Market,
}

impl MarketAccount for AnchorMarketAdapter<'_> {
    fn market_key(&self) -> Identity { self.key.to_bytes() }
    fn creator(&self) -> Identity { self.account.creator.to_bytes() }
    fn payout_milli(&self) -> u64 { self.account.payout_milli }
    fn closes_at(&self) -> i64 { self.account.closes_at }
    fn resolves_at(&self) -> i64 { self.account.resolves_at }
    fn accounted_vault(&self) -> u64 { self.account.accounted_vault }
    fn collateral(&self) -> u64 { self.account.collateral }
    fn fee_revenue(&self) -> u64 { self.account.fee_revenue }
    fn set_collateral(&mut self, value: u64) { self.account.collateral = value; }
    fn set_fee_revenue(&mut self, value: u64) { self.account.fee_revenue = value; }
}

pub struct AnchorSeatAdapter<'a> {
    pub account: &'a mut escrow::Seat,
}

impl SeatAccount for AnchorSeatAdapter<'_> {
    fn wallet(&self) -> Identity { self.account.wallet.to_bytes() }
    fn available_cash(&self) -> u64 { self.account.available_cash }
    fn reserved_cash(&self) -> u64 { self.account.reserved_cash }
    fn yes(&self) -> u64 { self.account.yes }
    fn no(&self) -> u64 { self.account.no }
    fn reserved_yes(&self) -> u64 { self.account.reserved_yes }
    fn reserved_no(&self) -> u64 { self.account.reserved_no }
    fn set_available_cash(&mut self, value: u64) { self.account.available_cash = value; }
    fn set_yes(&mut self, value: u64) { self.account.yes = value; }
    fn set_no(&mut self, value: u64) { self.account.no = value; }
}

#[derive(Clone, Copy, Default)]
struct ReserveTotal {
    cash: u64,
    yes: u64,
    no: u64,
}

impl ReserveTotal {
    fn add(&mut self, reserve: matching::Reserve) -> Checked<()> {
        self.cash = self.cash.checked_add(reserve.cash).ok_or(Fault::Overflow)?;
        self.yes = self.yes.checked_add(reserve.yes).ok_or(Fault::Overflow)?;
        self.no = self.no.checked_add(reserve.no).ok_or(Fault::Overflow)?;
        Ok(())
    }
}

fn add_u128(total: &mut u128, value: u64) -> Checked<()> {
    *total = total.checked_add(u128::from(value)).ok_or(Fault::Overflow)?;
    Ok(())
}

/// Derive the only snapshot accepted by the Anchor integration. Every live
/// order is mapped to its permanent seat index and its matcher-computed reserve
/// must exactly equal that seat's stored reserve totals. Expired orders remain
/// live until Carson's permissionless cleanup removes them and unlocks reserves.
pub fn canonical_snapshot(
    market_key: Pubkey,
    market: &escrow::Market,
    seats: &escrow::Seats,
    book: &matching::runtime::Storage<'_>,
) -> Checked<SettlementSnapshot> {
    let header = book.header();
    let seat_count = usize::try_from(seats.count).map_err(|_| Fault::CanonicalBook)?;
    if market_key == Pubkey::default()
        || seats.market != market_key
        || seat_count > escrow::SEAT_CAPACITY
        || header.domain != market_key.to_bytes()
        || header.payout != market.payout_milli
        || header.fee_bps != market.fee_bps
        || usize::from(header.active_len) != book.len()
    {
        return Err(Fault::CanonicalBook);
    }

    let mut expected = vec![ReserveTotal::default(); seat_count];
    let mut order_count = 0usize;
    for order in book.orders() {
        let owner = usize::try_from(order.owner).map_err(|_| Fault::CanonicalBook)?;
        if owner >= seat_count || order.remaining == 0 {
            return Err(Fault::CanonicalBook);
        }
        let reserve = matching::reserve(order, market.fee_bps)
            .map_err(|_| Fault::CanonicalBook)?;
        expected[owner].add(reserve)?;
        order_count = order_count.checked_add(1).ok_or(Fault::Overflow)?;
    }
    if order_count != book.len() {
        return Err(Fault::CanonicalBook);
    }

    let mut snapshot = SettlementSnapshot {
        open_orders: u64::try_from(order_count).map_err(|_| Fault::Overflow)?,
        available_cash: 0,
        reserved_cash: 0,
        yes: 0,
        no: 0,
        reserved_yes: 0,
        reserved_no: 0,
    };
    for (index, expected_reserve) in expected.into_iter().enumerate() {
        let seat = &seats.entries[index];
        if seat.wallet == Pubkey::default()
            || seat.enrollment == Pubkey::default()
            || seat.reserved_cash != expected_reserve.cash
            || seat.reserved_yes != expected_reserve.yes
            || seat.reserved_no != expected_reserve.no
            || seat.reserved_yes > seat.yes
            || seat.reserved_no > seat.no
        {
            return Err(Fault::CanonicalBook);
        }
        add_u128(&mut snapshot.available_cash, seat.available_cash)?;
        add_u128(&mut snapshot.reserved_cash, seat.reserved_cash)?;
        add_u128(&mut snapshot.yes, seat.yes)?;
        add_u128(&mut snapshot.no, seat.no)?;
        add_u128(&mut snapshot.reserved_yes, seat.reserved_yes)?;
        add_u128(&mut snapshot.reserved_no, seat.reserved_no)?;
    }
    Ok(snapshot)
}

/// Admission barrier for placement and replacement. Cancellation and the
/// permissionless expired/post-close cleanup intentionally do not call this.
pub fn require_anchor_order_admission(
    resolution: &ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    chain_time: i64,
) -> Checked<()> {
    let adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.require_market(&adapter)?;
    if resolution.phase != ResolutionPhase::Open || chain_time >= resolution.closes_at {
        return Err(Fault::TradingClosed);
    }
    Ok(())
}

/// Resolve reviewer eligibility from the permanent seat record. The Anchor
/// context must additionally constrain the supplied enrollment account to the
/// canonical `[b"enrollment", config, wallet]` PDA owned by this program.
pub fn reviewer_from_accounts(
    wallet: Pubkey,
    enrollment: Pubkey,
    seats: &escrow::Seats,
) -> Checked<Reviewer> {
    if wallet == Pubkey::default() || enrollment == Pubkey::default() {
        return Err(Fault::UnauthorizedReviewer);
    }
    let seat_count = usize::try_from(seats.count).map_err(|_| Fault::InvalidSeat)?;
    if seat_count > escrow::SEAT_CAPACITY {
        return Err(Fault::InvalidSeat);
    }
    let mut ever_traded = false;
    for seat in seats.entries[..seat_count].iter() {
        if seat.wallet == wallet {
            if seat.enrollment != enrollment {
                return Err(Fault::UnauthorizedReviewer);
            }
            ever_traded |= seat.ever_traded != 0;
        }
    }
    Ok(Reviewer {
        identity: OracleIdentity { wallet: wallet.to_bytes(), enrollment: enrollment.to_bytes() },
        ever_traded,
    })
}

#[account]
#[derive(Copy, Debug, PartialEq, Eq)]
pub struct ResolutionState {
    pub market: Identity,
    pub creator: Identity,
    pub payout_milli: u64,
    pub closes_at: i64,
    pub resolves_at: i64,
    pub proposer: OracleIdentity,
    pub approver: OracleIdentity,
    pub phase: ResolutionPhase,
    pub next_proposal_sequence: u64,
    pub active_proposal_sequence: Option<u64>,
    pub outcome: Option<Outcome>,
    pub outstanding_yes: u64,
    pub outstanding_no: u64,
    pub claims_processed: u64,
}

impl ResolutionState {
    /// Exact Borsh payload size, excluding Anchor's 8-byte discriminator.
    pub const SPACE: usize = 260;

    /// Must be called in the same market-initialization flow that freezes the
    /// rules and before an order can be accepted.
    pub fn initialize<M: MarketAccount>(
        market: &M,
        proposer: OracleIdentity,
        approver: OracleIdentity,
    ) -> Checked<Self> {
        if market.market_key() == ZERO
            || market.creator() == ZERO
            || market.payout_milli() < 2
            || market.resolves_at() < market.closes_at()
            || proposer.wallet == ZERO
            || proposer.enrollment == ZERO
            || approver.wallet == ZERO
            || approver.enrollment == ZERO
        {
            return Err(Fault::InvalidConfiguration);
        }
        if proposer.wallet == market.creator()
            || approver.wallet == market.creator()
            || proposer.wallet == approver.wallet
            || proposer.enrollment == approver.enrollment
        {
            return Err(Fault::ReviewerConflict);
        }
        Ok(Self {
            market: market.market_key(),
            creator: market.creator(),
            payout_milli: market.payout_milli(),
            closes_at: market.closes_at(),
            resolves_at: market.resolves_at(),
            proposer,
            approver,
            phase: ResolutionPhase::Open,
            next_proposal_sequence: 1,
            active_proposal_sequence: None,
            outcome: None,
            outstanding_yes: 0,
            outstanding_no: 0,
            claims_processed: 0,
        })
    }

    pub fn market(&self) -> Identity { self.market }
    pub fn proposer(&self) -> OracleIdentity { self.proposer }
    pub fn approver(&self) -> OracleIdentity { self.approver }
    pub fn phase(&self) -> ResolutionPhase { self.phase }
    pub fn outcome(&self) -> Option<Outcome> { self.outcome }
    pub fn outstanding_yes(&self) -> u64 { self.outstanding_yes }
    pub fn outstanding_no(&self) -> u64 { self.outstanding_no }
    pub fn claims_processed(&self) -> u64 { self.claims_processed }
    pub fn next_proposal_sequence(&self) -> u64 { self.next_proposal_sequence }

    /// Finalize CLOSED only after the canonical book and every seat have been
    /// scanned. Trading integration must also reject new orders at `closes_at`
    /// even before this keeper transition is recorded.
    pub fn close<M: MarketAccount>(
        &mut self,
        market: &M,
        snapshot: SettlementSnapshot,
        vault_amount: u64,
        chain_time: i64,
    ) -> Checked<()> {
        self.require_market(market)?;
        if self.phase != ResolutionPhase::Open {
            return Err(Fault::InvalidPhase);
        }
        if chain_time < market.closes_at() {
            return Err(Fault::TooEarly);
        }
        snapshot.require_drained()?;
        if snapshot.yes != snapshot.no {
            return Err(Fault::Accounting);
        }
        let outstanding = u64::try_from(snapshot.yes).map_err(|_| Fault::Overflow)?;
        let expected_collateral = snapshot.yes
            .checked_mul(u128::from(market.payout_milli()))
            .ok_or(Fault::Overflow)?;
        if expected_collateral != u128::from(market.collateral()) {
            return Err(Fault::Accounting);
        }
        verify_vault(market, snapshot.available_cash, vault_amount)?;

        self.outstanding_yes = outstanding;
        self.outstanding_no = outstanding;
        self.phase = ResolutionPhase::Closed;
        Ok(())
    }

    pub fn propose<M: MarketAccount>(
        &mut self,
        market: &M,
        proposal: &mut ProposalAccount,
        reviewer: Reviewer,
        outcome: Outcome,
        reason_digest: Digest,
        evidence_digest: Digest,
        chain_time: i64,
    ) -> Checked<ProposalFingerprint> {
        self.require_market(market)?;
        if self.phase != ResolutionPhase::Closed || self.active_proposal_sequence.is_some() {
            return Err(Fault::InvalidPhase);
        }
        require_resolution_time(market, chain_time)?;
        require_reviewer(reviewer, self.proposer)?;
        require_digest(reason_digest)?;
        require_digest(evidence_digest)?;
        if proposal.market != self.market
            || proposal.sequence != self.next_proposal_sequence
            || proposal.status != ProposalStatus::Vacant
        {
            return Err(Fault::ProposalMismatch);
        }
        let next_sequence = self.next_proposal_sequence.checked_add(1).ok_or(Fault::Overflow)?;
        let fingerprint = ProposalFingerprint {
            sequence: proposal.sequence,
            outcome,
            reason_digest,
            evidence_digest,
        };

        proposal.outcome = Some(outcome);
        proposal.reason_digest = reason_digest;
        proposal.evidence_digest = evidence_digest;
        proposal.proposer = reviewer.identity;
        proposal.proposed_at = chain_time;
        proposal.status = ProposalStatus::Pending;
        self.next_proposal_sequence = next_sequence;
        self.active_proposal_sequence = Some(proposal.sequence);
        self.phase = ResolutionPhase::ProposalPending;
        Ok(fingerprint)
    }

    pub fn approve<M: MarketAccount>(
        &mut self,
        market: &M,
        proposal: &mut ProposalAccount,
        reviewer: Reviewer,
        expected: ProposalFingerprint,
        chain_time: i64,
    ) -> Checked<()> {
        self.require_pending(market, proposal, expected, chain_time)?;
        require_reviewer(reviewer, self.approver)?;
        if reviewer.identity == proposal.proposer {
            return Err(Fault::ReviewerConflict);
        }

        proposal.reviewer = Some(reviewer.identity);
        proposal.decided_at = Some(chain_time);
        proposal.status = ProposalStatus::Approved;
        self.outcome = proposal.outcome;
        self.active_proposal_sequence = None;
        self.phase = ResolutionPhase::Resolved;
        Ok(())
    }

    pub fn reject<M: MarketAccount>(
        &mut self,
        market: &M,
        proposal: &mut ProposalAccount,
        reviewer: Reviewer,
        expected: ProposalFingerprint,
        review_digest: Digest,
        chain_time: i64,
    ) -> Checked<()> {
        self.require_pending(market, proposal, expected, chain_time)?;
        require_reviewer(reviewer, self.approver)?;
        require_digest(review_digest)?;
        if reviewer.identity == proposal.proposer {
            return Err(Fault::ReviewerConflict);
        }

        proposal.reviewer = Some(reviewer.identity);
        proposal.review_digest = review_digest;
        proposal.decided_at = Some(chain_time);
        proposal.status = ProposalStatus::Rejected;
        self.active_proposal_sequence = None;
        self.phase = ResolutionPhase::Closed;
        Ok(())
    }

    /// Permissionless execution: no caller identity is accepted. The canonical
    /// receipt binds the market, seat index and seat wallet and consumes all
    /// total holdings once. It credits internal feather cash already in escrow.
    pub fn claim<M: MarketAccount, S: SeatAccount>(
        &mut self,
        market: &mut M,
        seat_index: u32,
        seat: &mut S,
        receipt: &mut ClaimReceipt,
        snapshot: SettlementSnapshot,
        vault_amount: u64,
        chain_time: i64,
    ) -> Checked<u64> {
        self.require_market(market)?;
        if self.phase != ResolutionPhase::Resolved {
            return Err(Fault::InvalidPhase);
        }
        if receipt.market != self.market
            || receipt.seat_index != seat_index
            || receipt.wallet != seat.wallet()
            || seat.wallet() == ZERO
        {
            return Err(Fault::InvalidSeat);
        }
        if receipt.claimed {
            return Err(Fault::AlreadyClaimed);
        }
        snapshot.require_drained()?;
        if snapshot.yes != u128::from(self.outstanding_yes)
            || snapshot.no != u128::from(self.outstanding_no)
            || seat.reserved_cash() != 0
            || seat.reserved_yes() != 0
            || seat.reserved_no() != 0
        {
            return Err(Fault::Accounting);
        }
        verify_vault(market, snapshot.available_cash, vault_amount)?;

        let yes = seat.yes();
        let no = seat.no();
        let payout = payout(self.outcome.ok_or(Fault::InvalidPhase)?, market.payout_milli(), yes, no)?;
        let available_after = seat.available_cash().checked_add(payout).ok_or(Fault::Overflow)?;
        let collateral_after = market.collateral().checked_sub(payout).ok_or(Fault::CollateralInsufficient)?;
        let outstanding_yes = self.outstanding_yes.checked_sub(yes).ok_or(Fault::Accounting)?;
        let outstanding_no = self.outstanding_no.checked_sub(no).ok_or(Fault::Accounting)?;
        let claims_processed = self.claims_processed.checked_add(1).ok_or(Fault::Overflow)?;
        let cash_after = snapshot.available_cash.checked_add(u128::from(payout)).ok_or(Fault::Overflow)?;
        verify_accounting(
            market.accounted_vault(),
            cash_after,
            collateral_after,
            market.fee_revenue(),
        )?;

        seat.set_available_cash(available_after);
        seat.set_yes(0);
        seat.set_no(0);
        market.set_collateral(collateral_after);
        self.outstanding_yes = outstanding_yes;
        self.outstanding_no = outstanding_no;
        self.claims_processed = claims_processed;
        receipt.claimed = true;
        receipt.yes = yes;
        receipt.no = no;
        receipt.payout_milli = payout;
        receipt.claimed_at = chain_time;
        Ok(payout)
    }

    /// Once every nonzero position has been consumed, only VOID per-seat
    /// rounding dust may remain. It becomes explicit fee/treasury revenue;
    /// `accounted_vault` and actual SPL custody remain unchanged.
    pub fn finalize<M: MarketAccount>(
        &mut self,
        market: &mut M,
        snapshot: SettlementSnapshot,
        vault_amount: u64,
    ) -> Checked<u64> {
        self.require_market(market)?;
        if self.phase != ResolutionPhase::Resolved {
            return Err(Fault::InvalidPhase);
        }
        snapshot.require_drained()?;
        if self.outstanding_yes != 0
            || self.outstanding_no != 0
            || snapshot.yes != 0
            || snapshot.no != 0
        {
            return Err(Fault::ClaimsRemain);
        }
        verify_vault(market, snapshot.available_cash, vault_amount)?;
        let residual = market.collateral();
        if self.outcome != Some(Outcome::Void) && residual != 0 {
            return Err(Fault::Accounting);
        }
        let revenue_after = market.fee_revenue().checked_add(residual).ok_or(Fault::Overflow)?;
        verify_accounting(market.accounted_vault(), snapshot.available_cash, 0, revenue_after)?;

        market.set_collateral(0);
        market.set_fee_revenue(revenue_after);
        self.phase = ResolutionPhase::Finalized;
        Ok(residual)
    }

    fn require_market<M: MarketAccount>(&self, market: &M) -> Checked<()> {
        if market.market_key() != self.market
            || market.creator() != self.creator
            || market.payout_milli() != self.payout_milli
            || market.closes_at() != self.closes_at
            || market.resolves_at() != self.resolves_at
        {
            return Err(Fault::Binding);
        }
        Ok(())
    }

    fn require_pending<M: MarketAccount>(
        &self,
        market: &M,
        proposal: &ProposalAccount,
        expected: ProposalFingerprint,
        chain_time: i64,
    ) -> Checked<()> {
        self.require_market(market)?;
        if self.phase != ResolutionPhase::ProposalPending {
            return Err(Fault::InvalidPhase);
        }
        require_resolution_time(market, chain_time)?;
        if proposal.status != ProposalStatus::Pending {
            return Err(Fault::AlreadyReviewed);
        }
        if proposal.market != self.market
            || self.active_proposal_sequence != Some(proposal.sequence)
            || proposal.proposer != self.proposer
            || proposal.reason_digest == ZERO
            || proposal.evidence_digest == ZERO
            || proposal.fingerprint() != Some(expected)
        {
            return Err(Fault::ProposalMismatch);
        }
        Ok(())
    }
}

pub fn close_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &escrow::Seats,
    book: &matching::runtime::Storage<'_>,
    vault_amount: u64,
    chain_time: i64,
) -> Checked<()> {
    let snapshot = canonical_snapshot(market_key, market, seats, book)?;
    let adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.close(&adapter, snapshot, vault_amount, chain_time)
}

pub fn propose_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &escrow::Seats,
    proposal: &mut ProposalAccount,
    wallet: Pubkey,
    enrollment: Pubkey,
    outcome: Outcome,
    reason_digest: Digest,
    evidence_digest: Digest,
    chain_time: i64,
) -> Checked<ProposalFingerprint> {
    let reviewer = reviewer_from_accounts(wallet, enrollment, seats)?;
    let adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.propose(
        &adapter,
        proposal,
        reviewer,
        outcome,
        reason_digest,
        evidence_digest,
        chain_time,
    )
}

pub fn approve_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &escrow::Seats,
    proposal: &mut ProposalAccount,
    wallet: Pubkey,
    enrollment: Pubkey,
    expected: ProposalFingerprint,
    chain_time: i64,
) -> Checked<()> {
    let reviewer = reviewer_from_accounts(wallet, enrollment, seats)?;
    let adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.approve(&adapter, proposal, reviewer, expected, chain_time)
}

pub fn reject_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &escrow::Seats,
    proposal: &mut ProposalAccount,
    wallet: Pubkey,
    enrollment: Pubkey,
    expected: ProposalFingerprint,
    review_digest: Digest,
    chain_time: i64,
) -> Checked<()> {
    let reviewer = reviewer_from_accounts(wallet, enrollment, seats)?;
    let adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.reject(
        &adapter,
        proposal,
        reviewer,
        expected,
        review_digest,
        chain_time,
    )
}

pub fn claim_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &mut escrow::Seats,
    book: &matching::runtime::Storage<'_>,
    seat_index: u32,
    receipt: &mut ClaimReceipt,
    vault_amount: u64,
    chain_time: i64,
) -> Checked<u64> {
    let snapshot = canonical_snapshot(market_key, market, seats, book)?;
    let index = usize::try_from(seat_index).map_err(|_| Fault::InvalidSeat)?;
    if index >= usize::try_from(seats.count).map_err(|_| Fault::InvalidSeat)?
        || index >= escrow::SEAT_CAPACITY
    {
        return Err(Fault::InvalidSeat);
    }
    let seat = &mut seats.entries[index];
    let mut market_adapter = AnchorMarketAdapter { key: market_key, account: market };
    let mut seat_adapter = AnchorSeatAdapter { account: seat };
    resolution.claim(
        &mut market_adapter,
        seat_index,
        &mut seat_adapter,
        receipt,
        snapshot,
        vault_amount,
        chain_time,
    )
}

pub fn finalize_from_accounts(
    resolution: &mut ResolutionState,
    market_key: Pubkey,
    market: &mut escrow::Market,
    seats: &escrow::Seats,
    book: &matching::runtime::Storage<'_>,
    vault_amount: u64,
) -> Checked<u64> {
    let snapshot = canonical_snapshot(market_key, market, seats, book)?;
    let mut adapter = AnchorMarketAdapter { key: market_key, account: market };
    resolution.finalize(&mut adapter, snapshot, vault_amount)
}

#[account]
#[derive(Copy, Debug, PartialEq, Eq)]
pub struct ProposalAccount {
    pub market: Identity,
    pub sequence: u64,
    pub outcome: Option<Outcome>,
    pub reason_digest: Digest,
    pub evidence_digest: Digest,
    pub proposer: OracleIdentity,
    pub proposed_at: i64,
    pub status: ProposalStatus,
    pub reviewer: Option<OracleIdentity>,
    pub review_digest: Digest,
    pub decided_at: Option<i64>,
}

impl ProposalAccount {
    /// Exact Borsh payload size, excluding Anchor's 8-byte discriminator.
    pub const SPACE: usize = 285;

    pub fn vacant(market: Identity, sequence: u64) -> Checked<Self> {
        if market == ZERO || sequence == 0 {
            return Err(Fault::InvalidConfiguration);
        }
        Ok(Self {
            market,
            sequence,
            outcome: None,
            reason_digest: ZERO,
            evidence_digest: ZERO,
            proposer: OracleIdentity { wallet: ZERO, enrollment: ZERO },
            proposed_at: 0,
            status: ProposalStatus::Vacant,
            reviewer: None,
            review_digest: ZERO,
            decided_at: None,
        })
    }

    pub fn fingerprint(&self) -> Option<ProposalFingerprint> {
        Some(ProposalFingerprint {
            sequence: self.sequence,
            outcome: self.outcome?,
            reason_digest: self.reason_digest,
            evidence_digest: self.evidence_digest,
        })
    }
}

#[account]
#[derive(Copy, Debug, PartialEq, Eq)]
pub struct ClaimReceipt {
    pub market: Identity,
    pub seat_index: u32,
    pub wallet: Identity,
    pub claimed: bool,
    pub yes: u64,
    pub no: u64,
    pub payout_milli: u64,
    pub claimed_at: i64,
}

impl ClaimReceipt {
    /// Exact Borsh payload size, excluding Anchor's 8-byte discriminator.
    pub const SPACE: usize = 101;

    pub fn initialize(market: Identity, seat_index: u32, wallet: Identity) -> Checked<Self> {
        if market == ZERO || wallet == ZERO {
            return Err(Fault::InvalidConfiguration);
        }
        Ok(Self {
            market,
            seat_index,
            wallet,
            claimed: false,
            yes: 0,
            no: 0,
            payout_milli: 0,
            claimed_at: 0,
        })
    }
}

#[derive(Accounts)]
pub struct InitializeResolution<'info> {
    #[account(mut, address = market.creator)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, crate::Config>,
    #[account(mut, has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: constrained to the canonical book PDA and parsed below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(
        seeds = [b"enrollment", config.key().as_ref(), proposer_enrollment.wallet.as_ref()],
        bump = proposer_enrollment.bump,
        has_one = config,
    )]
    pub proposer_enrollment: Account<'info, crate::Enrollment>,
    #[account(
        seeds = [b"enrollment", config.key().as_ref(), approver_enrollment.wallet.as_ref()],
        bump = approver_enrollment.bump,
        has_one = config,
    )]
    pub approver_enrollment: Account<'info, crate::Enrollment>,
    #[account(
        init,
        payer = creator,
        seeds = [RESOLUTION_SEED, market.key().as_ref()],
        bump,
        space = 8 + ResolutionState::SPACE,
    )]
    pub resolution: Account<'info, ResolutionState>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [crate::market_terms::MARKET_TERMS_SEED, market.key().as_ref()], bump,
        constraint = terms.market == market.key())]
    pub terms: Account<'info, crate::market_terms::MarketTerms>,
}

#[derive(Accounts)]
pub struct CloseResolution<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = seats, has_one = vault)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: constrained to the canonical book PDA and parsed below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes() @ ResolutionError::Binding)]
    pub resolution: Account<'info, ResolutionState>,
    #[account(address = market.vault)]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct ProposeResolution<'info> {
    #[account(mut)]
    pub reviewer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, crate::Config>,
    #[account(mut, has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    #[account(seeds = [b"enrollment", config.key().as_ref(), reviewer.key().as_ref()],
        bump = enrollment.bump, has_one = config, has_one = wallet,
        constraint = enrollment.key().to_bytes() == resolution.proposer.enrollment @ ResolutionError::UnauthorizedReviewer)]
    pub enrollment: Account<'info, crate::Enrollment>,
    /// CHECK: address-only companion for `Enrollment::has_one`; signer is the same key.
    #[account(address = reviewer.key())]
    pub wallet: UncheckedAccount<'info>,
    #[account(mut, seeds = [RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes() @ ResolutionError::Binding)]
    pub resolution: Account<'info, ResolutionState>,
    #[account(init, payer = reviewer,
        seeds = [RESOLUTION_PROPOSAL_SEED, market.key().as_ref(), &sequence.to_le_bytes()], bump,
        space = 8 + ProposalAccount::SPACE)]
    pub proposal: Account<'info, ProposalAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct ReviewResolution<'info> {
    pub reviewer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, crate::Config>,
    #[account(mut, has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    #[account(seeds = [b"enrollment", config.key().as_ref(), reviewer.key().as_ref()],
        bump = enrollment.bump, has_one = config, has_one = wallet,
        constraint = enrollment.key().to_bytes() == resolution.approver.enrollment @ ResolutionError::UnauthorizedReviewer)]
    pub enrollment: Account<'info, crate::Enrollment>,
    /// CHECK: address-only companion for `Enrollment::has_one`; signer is the same key.
    #[account(address = reviewer.key())]
    pub wallet: UncheckedAccount<'info>,
    #[account(mut, seeds = [RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes() @ ResolutionError::Binding)]
    pub resolution: Account<'info, ResolutionState>,
    #[account(mut,
        seeds = [RESOLUTION_PROPOSAL_SEED, market.key().as_ref(), &sequence.to_le_bytes()], bump,
        constraint = proposal.market == market.key().to_bytes() @ ResolutionError::ProposalMismatch,
        constraint = proposal.sequence == sequence @ ResolutionError::ProposalMismatch)]
    pub proposal: Account<'info, ProposalAccount>,
}

#[derive(Accounts)]
#[instruction(seat_index: u32)]
pub struct ClaimResolution<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, has_one = seats, has_one = vault)]
    pub market: Account<'info, escrow::Market>,
    #[account(mut)]
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: constrained to the canonical book PDA and parsed below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes() @ ResolutionError::Binding)]
    pub resolution: Account<'info, ResolutionState>,
    #[account(init, payer = payer,
        seeds = [RESOLUTION_CLAIM_SEED, market.key().as_ref(), &seat_index.to_le_bytes()], bump,
        space = 8 + ClaimReceipt::SPACE)]
    pub receipt: Account<'info, ClaimReceipt>,
    #[account(address = market.vault)]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeResolution<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, has_one = seats, has_one = vault)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: constrained to the canonical book PDA and parsed below.
    #[account(mut, seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [RESOLUTION_SEED, market.key().as_ref()], bump,
        constraint = resolution.market == market.key().to_bytes() @ ResolutionError::Binding)]
    pub resolution: Account<'info, ResolutionState>,
    #[account(address = market.vault)]
    pub vault: Account<'info, anchor_spl::token::TokenAccount>,
}

fn attach_canonical_book(data: &mut [u8]) -> Result<matching::runtime::Storage<'_>> {
    use crate::exchange::{BOOK_BYTES, BOOK_TAG};
    use matching::runtime::{Header, Slot, Storage};

    require!(data.len() == BOOK_BYTES && data[..8] == BOOK_TAG, ResolutionError::CanonicalBook);
    let pointer = data[8..].as_mut_ptr();
    require!((pointer as usize) % core::mem::align_of::<Header>() == 0, ResolutionError::CanonicalBook);
    let (header, slots, bids, asks) = unsafe {
        let slots_pointer = pointer.add(core::mem::size_of::<Header>());
        let bids_pointer = slots_pointer.add(matching::MAX_ORDERS * core::mem::size_of::<Slot>());
        let asks_pointer = bids_pointer.add(matching::MAX_ORDERS * 2);
        (
            &mut *pointer.cast::<Header>(),
            core::slice::from_raw_parts_mut(slots_pointer.cast::<Slot>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(bids_pointer.cast::<u16>(), matching::MAX_ORDERS),
            core::slice::from_raw_parts_mut(asks_pointer.cast::<u16>(), matching::MAX_ORDERS),
        )
    };
    Storage::attach(header, slots, bids, asks).map_err(|_| error!(ResolutionError::CanonicalBook))
}

pub fn initialize_resolution(ctx: Context<InitializeResolution>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.market.closes_at, ResolutionError::TradingClosed);
    let market_key = ctx.accounts.market.key();
    crate::market_terms::validate_market_admission(ctx.accounts.terms.key(), &ctx.accounts.terms,
        market_key, &ctx.accounts.market,
        [(ctx.accounts.proposer_enrollment.wallet, ctx.accounts.proposer_enrollment.key()),
         (ctx.accounts.approver_enrollment.wallet, ctx.accounts.approver_enrollment.key())],
        None).map_err(crate::market_terms::instruction_error)?;
    let mut book_data = ctx.accounts.book.try_borrow_mut_data()?;
    let book = attach_canonical_book(&mut book_data)?;
    let seats = ctx.accounts.seats.load()?;
    let snapshot = canonical_snapshot(market_key, &ctx.accounts.market, &seats, &book)
        .map_err(instruction_error)?;
    let seat_count = usize::try_from(seats.count).map_err(|_| error!(ResolutionError::InvalidSeat))?;
    require!(seat_count <= escrow::SEAT_CAPACITY, ResolutionError::InvalidSeat);
    require!(snapshot.open_orders == 0
        && snapshot.reserved_cash == 0
        && snapshot.reserved_yes == 0
        && snapshot.reserved_no == 0
        && snapshot.yes == 0
        && snapshot.no == 0
        && ctx.accounts.market.collateral == 0
        && ctx.accounts.market.fee_revenue == 0
        && seats.entries[..seat_count].iter().all(|seat| seat.ever_traded == 0),
        ResolutionError::AlreadyTrading);
    let proposer = reviewer_from_accounts(
        ctx.accounts.proposer_enrollment.wallet,
        ctx.accounts.proposer_enrollment.key(),
        &seats,
    ).map_err(instruction_error)?;
    let approver = reviewer_from_accounts(
        ctx.accounts.approver_enrollment.wallet,
        ctx.accounts.approver_enrollment.key(),
        &seats,
    ).map_err(instruction_error)?;
    require!(!proposer.ever_traded && !approver.ever_traded, ResolutionError::ReviewerTraded);
    let adapter = AnchorMarketAdapter { key: market_key, account: &mut ctx.accounts.market };
    let resolution = ResolutionState::initialize(&adapter, proposer.identity, approver.identity)
        .map_err(instruction_error)?;
    ctx.accounts.resolution.set_inner(resolution);
    Ok(())
}

pub fn close_resolution(ctx: Context<CloseResolution>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let mut book_data = ctx.accounts.book.try_borrow_mut_data()?;
    let book = attach_canonical_book(&mut book_data)?;
    let seats = ctx.accounts.seats.load()?;
    close_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &seats,
        &book,
        ctx.accounts.vault.amount,
        Clock::get()?.unix_timestamp,
    ).map_err(instruction_error)
}

#[allow(clippy::too_many_arguments)]
pub fn propose_resolution(
    ctx: Context<ProposeResolution>,
    sequence: u64,
    outcome: Outcome,
    reason_digest: Digest,
    evidence_digest: Digest,
) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    ctx.accounts.proposal.set_inner(ProposalAccount::vacant(market_key.to_bytes(), sequence)
        .map_err(instruction_error)?);
    let seats = ctx.accounts.seats.load()?;
    propose_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &seats,
        &mut ctx.accounts.proposal,
        ctx.accounts.reviewer.key(),
        ctx.accounts.enrollment.key(),
        outcome,
        reason_digest,
        evidence_digest,
        Clock::get()?.unix_timestamp,
    ).map(|_| ()).map_err(instruction_error)
}

pub fn approve_resolution(
    ctx: Context<ReviewResolution>,
    _sequence: u64,
    expected: ProposalFingerprint,
) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let seats = ctx.accounts.seats.load()?;
    approve_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &seats,
        &mut ctx.accounts.proposal,
        ctx.accounts.reviewer.key(),
        ctx.accounts.enrollment.key(),
        expected,
        Clock::get()?.unix_timestamp,
    ).map_err(instruction_error)
}

pub fn reject_resolution(
    ctx: Context<ReviewResolution>,
    _sequence: u64,
    expected: ProposalFingerprint,
    review_digest: Digest,
) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let seats = ctx.accounts.seats.load()?;
    reject_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &seats,
        &mut ctx.accounts.proposal,
        ctx.accounts.reviewer.key(),
        ctx.accounts.enrollment.key(),
        expected,
        review_digest,
        Clock::get()?.unix_timestamp,
    ).map_err(instruction_error)
}

pub fn claim_resolution(ctx: Context<ClaimResolution>, seat_index: u32) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let mut book_data = ctx.accounts.book.try_borrow_mut_data()?;
    let book = attach_canonical_book(&mut book_data)?;
    let mut seats = ctx.accounts.seats.load_mut()?;
    let index = usize::try_from(seat_index).map_err(|_| error!(ResolutionError::InvalidSeat))?;
    require!(index < seats.count as usize && index < escrow::SEAT_CAPACITY, ResolutionError::InvalidSeat);
    let wallet = seats.entries[index].wallet;
    ctx.accounts.receipt.set_inner(ClaimReceipt::initialize(market_key.to_bytes(), seat_index, wallet.to_bytes())
        .map_err(instruction_error)?);
    let payout_milli = claim_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &mut seats,
        &book,
        seat_index,
        &mut ctx.accounts.receipt,
        ctx.accounts.vault.amount,
        Clock::get()?.unix_timestamp,
    ).map_err(instruction_error)?;
    emit!(ResolutionClaimed { market: market_key, seat_index, wallet, payout_milli });
    Ok(())
}

pub fn finalize_resolution(ctx: Context<FinalizeResolution>) -> Result<()> {
    let market_key = ctx.accounts.market.key();
    let mut book_data = ctx.accounts.book.try_borrow_mut_data()?;
    let book = attach_canonical_book(&mut book_data)?;
    let seats = ctx.accounts.seats.load()?;
    let residual_milli = finalize_from_accounts(
        &mut ctx.accounts.resolution,
        market_key,
        &mut ctx.accounts.market,
        &seats,
        &book,
        ctx.accounts.vault.amount,
    ).map_err(instruction_error)?;
    emit!(ResolutionFinalized { market: market_key, residual_milli });
    Ok(())
}

#[event]
pub struct ResolutionClaimed {
    pub market: Pubkey,
    pub seat_index: u32,
    pub wallet: Pubkey,
    pub payout_milli: u64,
}

#[event]
pub struct ResolutionFinalized {
    pub market: Pubkey,
    pub residual_milli: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    InvalidConfiguration,
    Binding,
    InvalidPhase,
    TradingClosed,
    TooEarly,
    CanonicalBook,
    OrdersRemain,
    ReservesRemain,
    Accounting,
    VaultUnderfunded,
    UnauthorizedReviewer,
    ReviewerConflict,
    ReviewerTraded,
    InvalidDigest,
    ProposalMismatch,
    AlreadyReviewed,
    AlreadyClaimed,
    InvalidSeat,
    Overflow,
    CollateralInsufficient,
    ClaimsRemain,
}

pub type Checked<T> = core::result::Result<T, Fault>;

#[error_code(offset = 7400)]
pub enum ResolutionError {
    #[msg("Invalid resolution configuration")]
    InvalidConfiguration,
    #[msg("Resolution account binding mismatch")]
    Binding,
    #[msg("Resolution transition is invalid in the current phase")]
    InvalidPhase,
    #[msg("Trading is closed for this market")]
    TradingClosed,
    #[msg("Resolution transition is too early")]
    TooEarly,
    #[msg("Canonical order book or seat reserve ledger is inconsistent")]
    CanonicalBook,
    #[msg("Open orders must be drained before resolution")]
    OrdersRemain,
    #[msg("Order reserves must be released before resolution")]
    ReservesRemain,
    #[msg("Market accounting invariant failed")]
    Accounting,
    #[msg("SPL vault is below its accounted balance")]
    VaultUnderfunded,
    #[msg("Reviewer is not the frozen authority")]
    UnauthorizedReviewer,
    #[msg("Proposer and approver must be independent of each other and the creator")]
    ReviewerConflict,
    #[msg("A reviewer that traded this market is ineligible")]
    ReviewerTraded,
    #[msg("Evidence and reason digests must be nonzero")]
    InvalidDigest,
    #[msg("Proposal does not match the active immutable proposal")]
    ProposalMismatch,
    #[msg("Proposal was already reviewed")]
    AlreadyReviewed,
    #[msg("Seat payout was already claimed")]
    AlreadyClaimed,
    #[msg("Invalid market seat")]
    InvalidSeat,
    #[msg("Checked resolution arithmetic overflow")]
    Overflow,
    #[msg("Resolution collateral is insufficient")]
    CollateralInsufficient,
    #[msg("Outstanding claims remain")]
    ClaimsRemain,
    #[msg("Resolution must be initialized before any trading history exists")]
    AlreadyTrading,
}

fn instruction_error(fault: Fault) -> anchor_lang::error::Error {
    let error = match fault {
        Fault::InvalidConfiguration => ResolutionError::InvalidConfiguration,
        Fault::Binding => ResolutionError::Binding,
        Fault::InvalidPhase => ResolutionError::InvalidPhase,
        Fault::TradingClosed => ResolutionError::TradingClosed,
        Fault::TooEarly => ResolutionError::TooEarly,
        Fault::CanonicalBook => ResolutionError::CanonicalBook,
        Fault::OrdersRemain => ResolutionError::OrdersRemain,
        Fault::ReservesRemain => ResolutionError::ReservesRemain,
        Fault::Accounting => ResolutionError::Accounting,
        Fault::VaultUnderfunded => ResolutionError::VaultUnderfunded,
        Fault::UnauthorizedReviewer => ResolutionError::UnauthorizedReviewer,
        Fault::ReviewerConflict => ResolutionError::ReviewerConflict,
        Fault::ReviewerTraded => ResolutionError::ReviewerTraded,
        Fault::InvalidDigest => ResolutionError::InvalidDigest,
        Fault::ProposalMismatch => ResolutionError::ProposalMismatch,
        Fault::AlreadyReviewed => ResolutionError::AlreadyReviewed,
        Fault::AlreadyClaimed => ResolutionError::AlreadyClaimed,
        Fault::InvalidSeat => ResolutionError::InvalidSeat,
        Fault::Overflow => ResolutionError::Overflow,
        Fault::CollateralInsufficient => ResolutionError::CollateralInsufficient,
        Fault::ClaimsRemain => ResolutionError::ClaimsRemain,
    };
    error.into()
}

fn require_reviewer(actual: Reviewer, expected: OracleIdentity) -> Checked<()> {
    if actual.identity != expected {
        return Err(Fault::UnauthorizedReviewer);
    }
    if actual.ever_traded {
        return Err(Fault::ReviewerTraded);
    }
    Ok(())
}

fn require_digest(digest: Digest) -> Checked<()> {
    if digest == ZERO { Err(Fault::InvalidDigest) } else { Ok(()) }
}

fn require_resolution_time<M: MarketAccount>(market: &M, chain_time: i64) -> Checked<()> {
    if chain_time < market.closes_at() || chain_time < market.resolves_at() {
        Err(Fault::TooEarly)
    } else {
        Ok(())
    }
}

fn verify_accounting(
    accounted_vault: u64,
    available_cash: u128,
    collateral: u64,
    fee_revenue: u64,
) -> Checked<()> {
    let total = available_cash
        .checked_add(u128::from(collateral))
        .and_then(|value| value.checked_add(u128::from(fee_revenue)))
        .ok_or(Fault::Overflow)?;
    if total != u128::from(accounted_vault) {
        return Err(Fault::Accounting);
    }
    Ok(())
}

fn verify_vault<M: MarketAccount>(
    market: &M,
    available_cash: u128,
    vault_amount: u64,
) -> Checked<()> {
    if vault_amount < market.accounted_vault() {
        return Err(Fault::VaultUnderfunded);
    }
    verify_accounting(
        market.accounted_vault(),
        available_cash,
        market.collateral(),
        market.fee_revenue(),
    )
}

pub fn payout(outcome: Outcome, payout_milli: u64, yes: u64, no: u64) -> Checked<u64> {
    if payout_milli < 2 {
        return Err(Fault::InvalidConfiguration);
    }
    let amount = match outcome {
        Outcome::Yes => u128::from(payout_milli).checked_mul(u128::from(yes)),
        Outcome::No => u128::from(payout_milli).checked_mul(u128::from(no)),
        Outcome::Void => u128::from(payout_milli)
            .checked_mul(u128::from(yes) + u128::from(no))
            .map(|value| value / 2),
    }
    .ok_or(Fault::Overflow)?;
    u64::try_from(amount).map_err(|_| Fault::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(byte: u8) -> Identity { [byte; 32] }
    fn digest(byte: u8) -> Digest { [byte; 32] }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct TestMarket {
        key: Identity,
        creator: Identity,
        payout: u64,
        closes: i64,
        resolves: i64,
        accounted: u64,
        collateral: u64,
        revenue: u64,
    }
    impl MarketAccount for TestMarket {
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
    struct TestSeat {
        wallet: Identity,
        available: u64,
        reserved_cash: u64,
        yes: u64,
        no: u64,
        reserved_yes: u64,
        reserved_no: u64,
    }
    impl SeatAccount for TestSeat {
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

    fn oracle(wallet: u8, enrollment: u8) -> OracleIdentity {
        OracleIdentity { wallet: id(wallet), enrollment: id(enrollment) }
    }
    fn reviewer(identity: OracleIdentity) -> Reviewer { Reviewer { identity, ever_traded: false } }
    fn market(payout: u64, cash: u64, pairs: u64, revenue: u64) -> TestMarket {
        let collateral = payout.checked_mul(pairs).unwrap();
        TestMarket {
            key: id(1), creator: id(2), payout, closes: 100, resolves: 120,
            accounted: cash + collateral + revenue, collateral, revenue,
        }
    }
    fn snapshot(cash: u128, yes: u128, no: u128) -> SettlementSnapshot {
        SettlementSnapshot {
            open_orders: 0, available_cash: cash, reserved_cash: 0,
            yes, no, reserved_yes: 0, reserved_no: 0,
        }
    }
    fn state(market: &TestMarket) -> ResolutionState {
        ResolutionState::initialize(market, oracle(3, 4), oracle(5, 6)).unwrap()
    }
    fn resolve(state: &mut ResolutionState, market: &TestMarket, outcome: Outcome) -> ProposalAccount {
        state.close(market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        let mut proposal = ProposalAccount::vacant(id(1), 1).unwrap();
        let fingerprint = state.propose(
            market, &mut proposal, reviewer(oracle(3, 4)), outcome, digest(7), digest(8), 120,
        ).unwrap();
        state.approve(market, &mut proposal, reviewer(oracle(5, 6)), fingerprint, 120).unwrap();
        proposal
    }

    #[test]
    fn freezes_two_distinct_non_creator_oracle_identities() {
        let market = market(3, 100, 10, 2);
        assert_eq!(
            ResolutionState::initialize(&market, oracle(3, 4), oracle(3, 5)),
            Err(Fault::ReviewerConflict),
        );
        assert_eq!(
            ResolutionState::initialize(&market, oracle(2, 4), oracle(5, 6)),
            Err(Fault::ReviewerConflict),
        );
        assert_eq!(
            ResolutionState::initialize(&market, oracle(3, 4), oracle(5, 4)),
            Err(Fault::ReviewerConflict),
        );
        let mut valid = state(&market);
        assert_eq!(valid.proposer(), oracle(3, 4));
        assert_eq!(valid.approver(), oracle(5, 6));
        assert_eq!(valid.phase(), ResolutionPhase::Open);
        let mut altered = market;
        altered.payout = 4;
        assert_eq!(valid.close(&altered, snapshot(100, 10, 10), altered.accounted, 100), Err(Fault::Binding));
    }

    #[test]
    fn close_uses_chain_time_and_requires_a_fully_drained_conserved_snapshot() {
        let market = market(3, 100, 10, 2);
        let mut state = state(&market);
        assert_eq!(state.close(&market, snapshot(100, 10, 10), market.accounted, 99), Err(Fault::TooEarly));
        let mut orders = snapshot(100, 10, 10); orders.open_orders = 1;
        assert_eq!(state.close(&market, orders, market.accounted, 100), Err(Fault::OrdersRemain));
        let mut reserves = snapshot(100, 10, 10); reserves.reserved_yes = 1;
        assert_eq!(state.close(&market, reserves, market.accounted, 100), Err(Fault::ReservesRemain));
        assert_eq!(state.close(&market, snapshot(100, 10, 9), market.accounted, 100), Err(Fault::Accounting));
        assert_eq!(state.close(&market, snapshot(100, 10, 10), market.accounted - 1, 100), Err(Fault::VaultUnderfunded));
        assert_eq!(state.phase(), ResolutionPhase::Open);
        state.close(&market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        assert_eq!((state.phase(), state.outstanding_yes(), state.outstanding_no()), (ResolutionPhase::Closed, 10, 10));
    }

    #[test]
    fn proposal_requires_exact_frozen_authorities_evidence_and_second_party_review() {
        let market = market(3, 100, 10, 2);
        let mut state = state(&market);
        state.close(&market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        let mut proposal = ProposalAccount::vacant(id(1), 1).unwrap();
        assert_eq!(state.propose(&market, &mut proposal, reviewer(oracle(3, 4)), Outcome::Yes, digest(7), digest(8), 119), Err(Fault::TooEarly));
        assert_eq!(state.propose(&market, &mut proposal, reviewer(oracle(9, 9)), Outcome::Yes, digest(7), digest(8), 120), Err(Fault::UnauthorizedReviewer));
        assert_eq!(state.propose(&market, &mut proposal, Reviewer { identity: oracle(3, 4), ever_traded: true }, Outcome::Yes, digest(7), digest(8), 120), Err(Fault::ReviewerTraded));
        assert_eq!(state.propose(&market, &mut proposal, reviewer(oracle(3, 4)), Outcome::Yes, ZERO, digest(8), 120), Err(Fault::InvalidDigest));
        let fingerprint = state.propose(&market, &mut proposal, reviewer(oracle(3, 4)), Outcome::Yes, digest(7), digest(8), 120).unwrap();
        let altered = ProposalFingerprint { evidence_digest: digest(9), ..fingerprint };
        assert_eq!(state.approve(&market, &mut proposal, reviewer(oracle(5, 6)), altered, 121), Err(Fault::ProposalMismatch));
        let mut substituted = proposal;
        substituted.proposer = oracle(9, 10);
        assert_eq!(state.approve(&market, &mut substituted, reviewer(oracle(5, 6)), fingerprint, 121), Err(Fault::ProposalMismatch));
        assert_eq!(state.approve(&market, &mut proposal, Reviewer { identity: oracle(5, 6), ever_traded: true }, fingerprint, 121), Err(Fault::ReviewerTraded));
        state.approve(&market, &mut proposal, reviewer(oracle(5, 6)), fingerprint, 121).unwrap();
        assert_eq!(state.outcome(), Some(Outcome::Yes));
        assert_eq!(proposal.status, ProposalStatus::Approved);
        assert_eq!(state.approve(&market, &mut proposal, reviewer(oracle(5, 6)), fingerprint, 122), Err(Fault::InvalidPhase));
    }

    #[test]
    fn rejection_is_durable_and_allows_only_a_new_sequence() {
        let market = market(3, 100, 10, 2);
        let mut state = state(&market);
        state.close(&market, snapshot(100, 10, 10), market.accounted, 100).unwrap();
        let mut first = ProposalAccount::vacant(id(1), 1).unwrap();
        let fingerprint = state.propose(&market, &mut first, reviewer(oracle(3, 4)), Outcome::No, digest(7), digest(8), 120).unwrap();
        state.reject(&market, &mut first, reviewer(oracle(5, 6)), fingerprint, digest(9), 121).unwrap();
        assert_eq!((state.phase(), first.status, first.review_digest), (ResolutionPhase::Closed, ProposalStatus::Rejected, digest(9)));
        assert_eq!(state.next_proposal_sequence(), 2);
        assert_eq!(state.propose(&market, &mut first, reviewer(oracle(3, 4)), Outcome::Yes, digest(7), digest(8), 122), Err(Fault::ProposalMismatch));
        let mut second = ProposalAccount::vacant(id(1), 2).unwrap();
        assert!(state.propose(&market, &mut second, reviewer(oracle(3, 4)), Outcome::Yes, digest(10), digest(11), 122).is_ok());
    }

    #[test]
    fn yes_resolution_consumes_total_holdings_once_and_conserves_escrow() {
        let mut market = market(3, 100, 10, 2);
        let mut state = state(&market);
        resolve(&mut state, &market, Outcome::Yes);
        let mut first = TestSeat { wallet: id(10), available: 40, reserved_cash: 0, yes: 6, no: 2, reserved_yes: 0, reserved_no: 0 };
        let mut second = TestSeat { wallet: id(11), available: 60, reserved_cash: 0, yes: 4, no: 8, reserved_yes: 0, reserved_no: 0 };
        let mut first_receipt = ClaimReceipt::initialize(id(1), 0, id(10)).unwrap();
        let mut second_receipt = ClaimReceipt::initialize(id(1), 1, id(11)).unwrap();
        let vault = market.accounted;

        assert_eq!(state.claim(&mut market, 0, &mut first, &mut first_receipt, snapshot(100, 10, 10), vault, 130).unwrap(), 18);
        assert_eq!((first.available, first.yes, first.no, market.collateral), (58, 0, 0, 12));
        let replay_state = state;
        let replay_market = market;
        let replay_seat = first;
        assert_eq!(state.claim(&mut market, 0, &mut first, &mut first_receipt, snapshot(118, 4, 8), vault, 131), Err(Fault::AlreadyClaimed));
        assert_eq!((state, market, first), (replay_state, replay_market, replay_seat));
        assert_eq!(state.claim(&mut market, 1, &mut second, &mut second_receipt, snapshot(118, 4, 8), vault, 132).unwrap(), 12);
        assert_eq!((second.available, second.yes, second.no, market.collateral), (72, 0, 0, 0));
        assert_eq!(state.finalize(&mut market, snapshot(130, 0, 0), vault).unwrap(), 0);
        assert_eq!((state.phase(), market.accounted, market.revenue), (ResolutionPhase::Finalized, 132, 2));
    }

    #[test]
    fn no_and_void_payouts_use_checked_exact_integer_rules() {
        assert_eq!(payout(Outcome::Yes, 3, 6, 2), Ok(18));
        assert_eq!(payout(Outcome::No, 3, 6, 2), Ok(6));
        assert_eq!(payout(Outcome::Void, 3, 1, 1), Ok(3));
        assert_eq!(payout(Outcome::Void, 3, 1, 0), Ok(1));
        assert_eq!(payout(Outcome::Yes, u64::MAX, 2, 0), Err(Fault::Overflow));

        let mut market = market(3, 0, 1, 0);
        let mut state = state(&market);
        state.close(&market, snapshot(0, 1, 1), market.accounted, 100).unwrap();
        let mut proposal = ProposalAccount::vacant(id(1), 1).unwrap();
        let fingerprint = state.propose(&market, &mut proposal, reviewer(oracle(3, 4)), Outcome::Void, digest(7), digest(8), 120).unwrap();
        state.approve(&market, &mut proposal, reviewer(oracle(5, 6)), fingerprint, 120).unwrap();
        let mut yes = TestSeat { wallet: id(10), available: 0, reserved_cash: 0, yes: 1, no: 0, reserved_yes: 0, reserved_no: 0 };
        let mut no = TestSeat { wallet: id(11), available: 0, reserved_cash: 0, yes: 0, no: 1, reserved_yes: 0, reserved_no: 0 };
        let mut yes_receipt = ClaimReceipt::initialize(id(1), 0, id(10)).unwrap();
        let mut no_receipt = ClaimReceipt::initialize(id(1), 1, id(11)).unwrap();
        let vault = market.accounted;
        assert_eq!(state.claim(&mut market, 0, &mut yes, &mut yes_receipt, snapshot(0, 1, 1), vault, 130).unwrap(), 1);
        assert_eq!(state.claim(&mut market, 1, &mut no, &mut no_receipt, snapshot(1, 0, 1), vault, 131).unwrap(), 1);
        assert_eq!(state.finalize(&mut market, snapshot(2, 0, 0), vault).unwrap(), 1);
        assert_eq!((market.collateral, market.revenue, market.accounted), (0, 1, 3));
    }

    #[test]
    fn no_resolution_credits_no_holders_and_consumes_losing_yes_holdings() {
        let mut market = market(3, 100, 10, 2);
        let mut state = state(&market);
        resolve(&mut state, &market, Outcome::No);
        let mut first = TestSeat { wallet: id(10), available: 40, reserved_cash: 0, yes: 6, no: 2, reserved_yes: 0, reserved_no: 0 };
        let mut second = TestSeat { wallet: id(11), available: 60, reserved_cash: 0, yes: 4, no: 8, reserved_yes: 0, reserved_no: 0 };
        let mut first_receipt = ClaimReceipt::initialize(id(1), 0, id(10)).unwrap();
        let mut second_receipt = ClaimReceipt::initialize(id(1), 1, id(11)).unwrap();
        let vault = market.accounted;

        assert_eq!(state.claim(&mut market, 0, &mut first, &mut first_receipt, snapshot(100, 10, 10), vault, 130).unwrap(), 6);
        assert_eq!((first.available, first.yes, first.no, market.collateral), (46, 0, 0, 24));
        assert_eq!(state.claim(&mut market, 1, &mut second, &mut second_receipt, snapshot(106, 4, 8), vault, 131).unwrap(), 24);
        assert_eq!((second.available, second.yes, second.no, market.collateral), (84, 0, 0, 0));
        assert_eq!(state.finalize(&mut market, snapshot(130, 0, 0), vault).unwrap(), 0);
        assert_eq!((state.phase(), market.revenue, market.accounted), (ResolutionPhase::Finalized, 2, 132));
    }

    #[test]
    fn failed_claims_leave_all_accounts_unchanged() {
        let mut market = market(3, 100, 10, 2);
        let mut state = state(&market);
        resolve(&mut state, &market, Outcome::No);
        let mut seat = TestSeat { wallet: id(10), available: 40, reserved_cash: 0, yes: 6, no: 2, reserved_yes: 0, reserved_no: 0 };
        let mut receipt = ClaimReceipt::initialize(id(1), 0, id(10)).unwrap();
        let before = (state, market, seat, receipt);
        let vault = market.accounted;
        let mut open = snapshot(100, 10, 10); open.open_orders = 1;
        assert_eq!(state.claim(&mut market, 0, &mut seat, &mut receipt, open, vault, 130), Err(Fault::OrdersRemain));
        assert_eq!((state, market, seat, receipt), before);
        let mut dirty = snapshot(100, 10, 10); dirty.reserved_cash = 1;
        assert_eq!(state.claim(&mut market, 0, &mut seat, &mut receipt, dirty, vault, 130), Err(Fault::ReservesRemain));
        assert_eq!((state, market, seat, receipt), before);
        assert_eq!(state.claim(&mut market, 0, &mut seat, &mut receipt, snapshot(99, 10, 10), vault, 130), Err(Fault::Accounting));
        assert_eq!((state, market, seat, receipt), before);
    }

    struct AnchorFixture {
        key: Pubkey,
        market: escrow::Market,
        seats: Box<escrow::Seats>,
        header: matching::runtime::Header,
        slots: Vec<matching::runtime::Slot>,
        bids: Vec<u16>,
        asks: Vec<u16>,
    }

    impl AnchorFixture {
        fn new() -> Self {
            let key = Pubkey::new_unique();
            let mut seats = Box::<escrow::Seats>::new_uninit();
            // `Seats` is POD zero-copy account data; allocate it off-stack.
            unsafe { core::ptr::write_bytes(seats.as_mut_ptr(), 0, 1); }
            let mut seats = unsafe { seats.assume_init() };
            seats.market = key;
            seats.count = 1;
            seats.entries[0].wallet = Pubkey::new_unique();
            seats.entries[0].enrollment = Pubkey::new_unique();
            seats.entries[0].available_cash = 1_000;
            let market = escrow::Market {
                config: Pubkey::new_unique(),
                creator: Pubkey::new_unique(),
                seats: Pubkey::new_unique(),
                vault: Pubkey::new_unique(),
                market_id: 1,
                payout_milli: 100,
                closes_at: 100,
                resolves_at: 120,
                accounted_vault: 1_000,
                collateral: 0,
                fee_revenue: 0,
                fee_bps: 0,
                bump: 0,
            };
            let mut fixture = Self {
                key,
                market,
                seats,
                header: matching::runtime::Header::default(),
                slots: vec![matching::runtime::Slot::default(); 4],
                bids: vec![0; 4],
                asks: vec![0; 4],
            };
            matching::runtime::Storage::initialize(
                key.to_bytes(),
                100,
                0,
                &mut fixture.header,
                &mut fixture.slots,
                &mut fixture.bids,
                &mut fixture.asks,
            )
            .unwrap();
            fixture
        }

    }

    #[test]
    fn anchor_snapshot_uses_real_book_count_and_reconciles_exact_seat_reserves() {
        let mut fixture = AnchorFixture::new();
        {
            let AnchorFixture { key, market, seats, header, slots, bids, asks } = &mut fixture;
            let book = matching::runtime::Storage::attach(header, slots, bids, asks).unwrap();
            let snapshot = canonical_snapshot(*key, market, seats, &book).unwrap();
            assert_eq!(snapshot, SettlementSnapshot {
                open_orders: 0,
                available_cash: 1_000,
                reserved_cash: 0,
                yes: 0,
                no: 0,
                reserved_yes: 0,
                reserved_no: 0,
            });
        }

        let wallet = fixture.seats.entries[0].wallet;
        let locator = escrow::SeatLocator { market: fixture.key, wallet, index: 0, bump: 0 };
        let args = crate::exchange::PlaceOrderArgs {
            expected_nonce: 0,
            price: 40,
            quantity: 2,
            outcome: 0,
            action: 0,
            time_in_force: 0,
            self_trade: 0,
            post_only: false,
            expires_at: None,
            touches: 1,
        };
        {
            let AnchorFixture { key, market, seats, header, slots, bids, asks } = &mut fixture;
            let mut book = matching::runtime::Storage::attach(header, slots, bids, asks).unwrap();
            crate::exchange::execute(
                *key,
                wallet,
                &locator,
                market,
                seats,
                1_000,
                &mut book,
                args,
                1,
            )
            .unwrap();
        }
        {
            let AnchorFixture { key, market, seats, header, slots, bids, asks } = &mut fixture;
            let book = matching::runtime::Storage::attach(header, slots, bids, asks).unwrap();
            let snapshot = canonical_snapshot(*key, market, seats, &book).unwrap();
            assert_eq!((snapshot.open_orders, snapshot.available_cash, snapshot.reserved_cash), (1, 920, 80));
        }

        fixture.seats.entries[0].reserved_cash -= 1;
        let AnchorFixture { key, market, seats, header, slots, bids, asks } = &mut fixture;
        let book = matching::runtime::Storage::attach(header, slots, bids, asks).unwrap();
        assert_eq!(
            canonical_snapshot(*key, market, seats, &book),
            Err(Fault::CanonicalBook),
        );
    }

    #[test]
    fn anchor_admission_barrier_blocks_at_close_and_after_phase_transition() {
        let mut fixture = AnchorFixture::new();
        let proposer = OracleIdentity {
            wallet: Pubkey::new_unique().to_bytes(),
            enrollment: Pubkey::new_unique().to_bytes(),
        };
        let approver = OracleIdentity {
            wallet: Pubkey::new_unique().to_bytes(),
            enrollment: Pubkey::new_unique().to_bytes(),
        };
        let adapter = AnchorMarketAdapter { key: fixture.key, account: &mut fixture.market };
        let mut resolution = ResolutionState::initialize(&adapter, proposer, approver).unwrap();
        drop(adapter);

        assert_eq!(
            require_anchor_order_admission(&resolution, fixture.key, &mut fixture.market, 99),
            Ok(()),
        );
        assert_eq!(
            require_anchor_order_admission(&resolution, fixture.key, &mut fixture.market, 100),
            Err(Fault::TradingClosed),
        );
        {
            let AnchorFixture { key, market, seats, header, slots, bids, asks } = &mut fixture;
            let book = matching::runtime::Storage::attach(header, slots, bids, asks).unwrap();
            close_from_accounts(
                &mut resolution,
                *key,
                market,
                seats,
                &book,
                1_000,
                100,
            )
            .unwrap();
        }
        assert_eq!(resolution.phase(), ResolutionPhase::Closed);
        assert_eq!(
            require_anchor_order_admission(&resolution, fixture.key, &mut fixture.market, 99),
            Err(Fault::TradingClosed),
        );
    }

    #[test]
    fn anchor_account_borsh_sizes_are_stable() {
        use anchor_lang::AccountSerialize;

        let market = market(3, 100, 10, 2);
        let mut resolution = state(&market);
        resolution.active_proposal_sequence = Some(1);
        resolution.outcome = Some(Outcome::Void);
        let mut proposal = ProposalAccount::vacant(id(1), 1).unwrap();
        proposal.outcome = Some(Outcome::Void);
        proposal.reviewer = Some(oracle(5, 6));
        proposal.decided_at = Some(123);
        let receipt = ClaimReceipt::initialize(id(1), 7, id(9)).unwrap();
        let mut resolution_bytes = Vec::new();
        let mut proposal_bytes = Vec::new();
        let mut receipt_bytes = Vec::new();
        resolution.try_serialize(&mut resolution_bytes).unwrap();
        proposal.try_serialize(&mut proposal_bytes).unwrap();
        receipt.try_serialize(&mut receipt_bytes).unwrap();
        assert_eq!(resolution_bytes.len(), 8 + ResolutionState::SPACE);
        assert_eq!(proposal_bytes.len(), 8 + ProposalAccount::SPACE);
        assert_eq!(receipt_bytes.len(), 8 + ClaimReceipt::SPACE);
        assert_eq!(
            (Outcome::Yes as u8, Outcome::No as u8, Outcome::Void as u8),
            (0, 1, 2),
        );
        assert_eq!(
            (
                ResolutionPhase::Open as u8,
                ResolutionPhase::Closed as u8,
                ResolutionPhase::ProposalPending as u8,
                ResolutionPhase::Resolved as u8,
                ResolutionPhase::Finalized as u8,
            ),
            (0, 1, 2, 3, 4),
        );
    }
}
