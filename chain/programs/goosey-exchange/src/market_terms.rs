//! Immutable on-chain commitment to the canonical off-chain market manifest.
//!
//! This module deliberately has no update, reset, close, reviewer replacement,
//! or fallback instruction. The fixed account commits the manifest digest and
//! byte length at creation; designated reviewers can only add their own
//! acceptance bit, and the creator can only seal a still-pristine market.

use anchor_lang::prelude::*;

use crate::{escrow, matching, Config, Enrollment};

pub const MARKET_TERMS_SEED: &[u8] = b"market_terms";
pub const MARKET_TERMS_VERSION: u8 = 1;
pub const MARKET_TERMS_MAX_MANIFEST_LEN: u32 = 24_576;
pub const PROPOSER_ACCEPTED: u8 = 1;
pub const APPROVER_ACCEPTED: u8 = 2;
pub const ALL_ACCEPTED: u8 = PROPOSER_ACCEPTED | APPROVER_ACCEPTED;
const ZERO_DIGEST: [u8; 32] = [0; 32];

pub type Checked<T> = core::result::Result<T, Fault>;

/// Exact 232-byte Borsh payload; Anchor's discriminator makes the account 240B.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct MarketTerms {
    pub version: u8,
    pub market: Pubkey,
    pub creator: Pubkey,
    pub digest: [u8; 32],
    pub manifest_len: u32,
    pub proposer_wallet: Pubkey,
    pub proposer_enrollment: Pubkey,
    pub approver_wallet: Pubkey,
    pub approver_enrollment: Pubkey,
    pub acceptance_bits: u8,
    pub sealed: bool,
    pub bump: u8,
}

impl MarketTerms {
    pub const SPACE: usize = 232;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        version: u8,
        market: Pubkey,
        creator: Pubkey,
        digest: [u8; 32],
        manifest_len: u32,
        proposer_wallet: Pubkey,
        proposer_enrollment: Pubkey,
        approver_wallet: Pubkey,
        approver_enrollment: Pubkey,
        bump: u8,
    ) -> Checked<Self> {
        if version != MARKET_TERMS_VERSION
            || market == Pubkey::default()
            || creator == Pubkey::default()
            || digest == ZERO_DIGEST
            || manifest_len == 0
            || manifest_len > MARKET_TERMS_MAX_MANIFEST_LEN
            || proposer_wallet == Pubkey::default()
            || proposer_enrollment == Pubkey::default()
            || approver_wallet == Pubkey::default()
            || approver_enrollment == Pubkey::default()
            || proposer_wallet == creator
            || approver_wallet == creator
            || proposer_wallet == approver_wallet
            || proposer_enrollment == approver_enrollment
        {
            return Err(Fault::InvalidConfiguration);
        }
        Ok(Self {
            version,
            market,
            creator,
            digest,
            manifest_len,
            proposer_wallet,
            proposer_enrollment,
            approver_wallet,
            approver_enrollment,
            acceptance_bits: 0,
            sealed: false,
            bump,
        })
    }

    /// A signer can add only the bit for the immutable wallet/enrollment role.
    pub fn accept(
        &mut self,
        reviewer_wallet: Pubkey,
        reviewer_enrollment: Pubkey,
        expected_digest: [u8; 32],
        eligible: bool,
    ) -> Checked<()> {
        self.validate_content()?;
        if self.sealed {
            return Err(Fault::AlreadySealed);
        }
        if expected_digest != self.digest {
            return Err(Fault::DigestMismatch);
        }
        if !eligible {
            return Err(Fault::ReviewerTraded);
        }
        let bit = if reviewer_wallet == self.proposer_wallet
            && reviewer_enrollment == self.proposer_enrollment
        {
            PROPOSER_ACCEPTED
        } else if reviewer_wallet == self.approver_wallet
            && reviewer_enrollment == self.approver_enrollment
        {
            APPROVER_ACCEPTED
        } else {
            return Err(Fault::UnauthorizedReviewer);
        };
        if self.acceptance_bits & bit != 0 {
            return Err(Fault::AlreadyAccepted);
        }
        self.acceptance_bits |= bit;
        Ok(())
    }

    pub fn seal(
        &mut self,
        creator: Pubkey,
        expected_digest: [u8; 32],
    ) -> Checked<()> {
        self.validate_content()?;
        if self.sealed {
            return Err(Fault::AlreadySealed);
        }
        if creator != self.creator {
            return Err(Fault::UnauthorizedCreator);
        }
        if expected_digest != self.digest {
            return Err(Fault::DigestMismatch);
        }
        if self.acceptance_bits != ALL_ACCEPTED {
            return Err(Fault::MissingAcceptance);
        }
        self.sealed = true;
        Ok(())
    }

    fn validate_content(&self) -> Checked<()> {
        if self.version != MARKET_TERMS_VERSION
            || self.market == Pubkey::default()
            || self.creator == Pubkey::default()
            || self.digest == ZERO_DIGEST
            || self.manifest_len == 0
            || self.manifest_len > MARKET_TERMS_MAX_MANIFEST_LEN
            || self.proposer_wallet == Pubkey::default()
            || self.proposer_enrollment == Pubkey::default()
            || self.approver_wallet == Pubkey::default()
            || self.approver_enrollment == Pubkey::default()
            || self.proposer_wallet == self.creator
            || self.approver_wallet == self.creator
            || self.proposer_wallet == self.approver_wallet
            || self.proposer_enrollment == self.approver_enrollment
            || self.acceptance_bits & !ALL_ACCEPTED != 0
            || (self.sealed && self.acceptance_bits != ALL_ACCEPTED)
        {
            return Err(Fault::InvalidConfiguration);
        }
        Ok(())
    }
}

/// Read-only check intended for future placement/replacement and resolution
/// admission. Callers must supply the account key from the same account batch.
pub fn validate_canonical_sealed_terms(
    terms_key: Pubkey,
    terms: &MarketTerms,
    market_key: Pubkey,
    market: &escrow::Market,
) -> Checked<()> {
    terms.validate_content()?;
    let (expected, canonical_bump) = Pubkey::find_program_address(
        &[MARKET_TERMS_SEED, market_key.as_ref()],
        &crate::ID,
    );
    if terms_key != expected
        || terms.bump != canonical_bump
        || terms.market != market_key
        || terms.creator != market.creator
        || market.config == Pubkey::default()
        || terms.acceptance_bits != ALL_ACCEPTED
        || !terms.sealed
    {
        return Err(Fault::Binding);
    }
    Ok(())
}

fn reviewer_has_never_traded(
    seats: &escrow::Seats,
    wallet: Pubkey,
    enrollment: Pubkey,
) -> Checked<bool> {
    let count = usize::try_from(seats.count).map_err(|_| Fault::InvalidSeats)?;
    if count > escrow::SEAT_CAPACITY {
        return Err(Fault::InvalidSeats);
    }
    for seat in &seats.entries[..count] {
        if seat.wallet == wallet || seat.enrollment == enrollment {
            if seat.wallet != wallet || seat.enrollment != enrollment {
                return Err(Fault::InvalidSeats);
            }
            return Ok(seat.ever_traded == 0);
        }
    }
    Ok(true)
}

/// Validates the initialized ready-book header without taking a writable data
/// borrow. A pristine ready book has never assigned an order sequence; deposits
/// live in seats and therefore remain permitted.
fn validate_pristine_book(data: &[u8], market_key: Pubkey, market: &escrow::Market) -> Checked<()> {
    use crate::exchange::{BOOK_BYTES, BOOK_TAG};
    use matching::runtime::Header;

    if data.len() != BOOK_BYTES || data[..8] != BOOK_TAG {
        return Err(Fault::InvalidBook);
    }
    let pointer = data[8..].as_ptr();
    if (pointer as usize) % core::mem::align_of::<Header>() != 0 {
        return Err(Fault::InvalidBook);
    }
    // Header is repr(C), fixed-width and aligned by the canonical book layout.
    let header = unsafe { &*pointer.cast::<Header>() };
    if header.domain != market_key.to_bytes()
        || header.version != 1
        || header.payout != market.payout_milli
        || header.fee_bps != market.fee_bps
        || usize::from(header.capacity) != matching::MAX_ORDERS
        || header.revision != 0
        || header.next_sequence != 1
        || header.bid_len != 0
        || header.ask_len != 0
        || header.active_len != 0
        || header.free_head != 0
        || header.padding != [0; 4]
    {
        return Err(Fault::AlreadyTrading);
    }
    Ok(())
}

fn validate_pristine_market(
    market_key: Pubkey,
    market: &escrow::Market,
    seats: &escrow::Seats,
    book_data: &[u8],
) -> Checked<()> {
    if seats.market != market_key {
        return Err(Fault::Binding);
    }
    validate_pristine_book(book_data, market_key, market)?;
    let count = usize::try_from(seats.count).map_err(|_| Fault::InvalidSeats)?;
    if count > escrow::SEAT_CAPACITY {
        return Err(Fault::InvalidSeats);
    }
    if market.collateral != 0 || market.fee_revenue != 0 {
        return Err(Fault::AlreadyTrading);
    }
    let mut available_cash = 0u64;
    for seat in &seats.entries[..count] {
        if seat.wallet == Pubkey::default()
            || seat.enrollment == Pubkey::default()
            || seat.yes != 0
            || seat.no != 0
            || seat.reserved_cash != 0
            || seat.reserved_yes != 0
            || seat.reserved_no != 0
            || seat.ever_traded != 0
        {
            return Err(Fault::AlreadyTrading);
        }
        available_cash = available_cash
            .checked_add(seat.available_cash)
            .ok_or(Fault::InvalidSeats)?;
    }
    if available_cash != market.accounted_vault {
        return Err(Fault::InvalidSeats);
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(version: u8, digest: [u8; 32], manifest_len: u32)]
pub struct InitializeMarketTerms<'info> {
    #[account(mut, address = market.creator)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: canonical ready-book PDA, owner, tag, layout and pristine header are checked below.
    #[account(seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(
        seeds = [b"enrollment", config.key().as_ref(), proposer_enrollment.wallet.as_ref()],
        bump = proposer_enrollment.bump,
        has_one = config,
    )]
    pub proposer_enrollment: Account<'info, Enrollment>,
    #[account(
        seeds = [b"enrollment", config.key().as_ref(), approver_enrollment.wallet.as_ref()],
        bump = approver_enrollment.bump,
        has_one = config,
    )]
    pub approver_enrollment: Account<'info, Enrollment>,
    #[account(init, payer = creator, seeds = [MARKET_TERMS_SEED, market.key().as_ref()], bump,
        space = 8 + MarketTerms::SPACE)]
    pub terms: Account<'info, MarketTerms>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_market_terms(
    ctx: Context<InitializeMarketTerms>,
    version: u8,
    digest: [u8; 32],
    manifest_len: u32,
) -> Result<()> {
    require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, MarketTermsError::Closed);
    let market_key = ctx.accounts.market.key();
    let book_data = ctx.accounts.book.try_borrow_data()?;
    let seats = ctx.accounts.seats.load()?;
    validate_pristine_market(market_key, &ctx.accounts.market, &seats, &book_data)
        .map_err(instruction_error)?;
    let proposer_wallet = ctx.accounts.proposer_enrollment.wallet;
    let approver_wallet = ctx.accounts.approver_enrollment.wallet;
    require!(reviewer_has_never_traded(&seats, proposer_wallet, ctx.accounts.proposer_enrollment.key())
        .map_err(instruction_error)?, MarketTermsError::ReviewerTraded);
    require!(reviewer_has_never_traded(&seats, approver_wallet, ctx.accounts.approver_enrollment.key())
        .map_err(instruction_error)?, MarketTermsError::ReviewerTraded);
    let terms = MarketTerms::initialize(
        version,
        market_key,
        ctx.accounts.creator.key(),
        digest,
        manifest_len,
        proposer_wallet,
        ctx.accounts.proposer_enrollment.key(),
        approver_wallet,
        ctx.accounts.approver_enrollment.key(),
        ctx.bumps.terms,
    )
    .map_err(instruction_error)?;
    ctx.accounts.terms.set_inner(terms);
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptMarketTerms<'info> {
    pub reviewer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    #[account(seeds = [b"enrollment", config.key().as_ref(), reviewer.key().as_ref()],
        bump = enrollment.bump, has_one = config,
        constraint = enrollment.wallet == reviewer.key() @ MarketTermsError::UnauthorizedReviewer)]
    pub enrollment: Account<'info, Enrollment>,
    #[account(mut, seeds = [MARKET_TERMS_SEED, market.key().as_ref()], bump = terms.bump,
        constraint = terms.market == market.key() @ MarketTermsError::Binding)]
    pub terms: Account<'info, MarketTerms>,
}

pub fn accept_market_terms(ctx: Context<AcceptMarketTerms>, expected_digest: [u8; 32]) -> Result<()> {
    let seats = ctx.accounts.seats.load()?;
    let eligible = reviewer_has_never_traded(
        &seats,
        ctx.accounts.reviewer.key(),
        ctx.accounts.enrollment.key(),
    )
    .map_err(instruction_error)?;
    ctx.accounts.terms.accept(
        ctx.accounts.reviewer.key(),
        ctx.accounts.enrollment.key(),
        expected_digest,
        eligible,
    )
    .map_err(instruction_error)
}

#[derive(Accounts)]
pub struct SealMarketTerms<'info> {
    #[account(address = market.creator)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(has_one = config, has_one = seats)]
    pub market: Account<'info, escrow::Market>,
    pub seats: AccountLoader<'info, escrow::Seats>,
    /// CHECK: canonical ready-book PDA, owner, tag, layout and pristine header are checked below.
    #[account(seeds = [b"order_book", market.key().as_ref()], bump, owner = crate::ID)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [MARKET_TERMS_SEED, market.key().as_ref()], bump = terms.bump,
        constraint = terms.market == market.key() @ MarketTermsError::Binding)]
    pub terms: Account<'info, MarketTerms>,
}

pub fn seal_market_terms(ctx: Context<SealMarketTerms>, expected_digest: [u8; 32]) -> Result<()> {
    require!(Clock::get()?.unix_timestamp < ctx.accounts.market.closes_at, MarketTermsError::Closed);
    let market_key = ctx.accounts.market.key();
    let book_data = ctx.accounts.book.try_borrow_data()?;
    let seats = ctx.accounts.seats.load()?;
    validate_pristine_market(market_key, &ctx.accounts.market, &seats, &book_data)
        .map_err(instruction_error)?;
    ctx.accounts.terms.seal(ctx.accounts.creator.key(), expected_digest)
        .map_err(instruction_error)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Binding,
    InvalidConfiguration,
    InvalidBook,
    InvalidSeats,
    AlreadyTrading,
    UnauthorizedCreator,
    UnauthorizedReviewer,
    ReviewerTraded,
    DigestMismatch,
    AlreadyAccepted,
    MissingAcceptance,
    AlreadySealed,
}

#[error_code(offset = 7600)]
pub enum MarketTermsError {
    #[msg("Market terms account binding is invalid")]
    Binding,
    #[msg("Market terms version, digest, length, or reviewer configuration is invalid")]
    InvalidConfiguration,
    #[msg("Canonical order book is invalid or not ready")]
    InvalidBook,
    #[msg("Permanent market seats are invalid")]
    InvalidSeats,
    #[msg("Market terms can only be attached and sealed before any trading history")]
    AlreadyTrading,
    #[msg("Only the immutable market creator can seal these terms")]
    UnauthorizedCreator,
    #[msg("Signer is not one of the immutable designated reviewers")]
    UnauthorizedReviewer,
    #[msg("A designated reviewer has historical trading activity in this market")]
    ReviewerTraded,
    #[msg("Expected manifest digest does not match the immutable commitment")]
    DigestMismatch,
    #[msg("This reviewer already accepted the immutable commitment")]
    AlreadyAccepted,
    #[msg("Both designated reviewers must accept before sealing")]
    MissingAcceptance,
    #[msg("Market terms are already sealed and immutable")]
    AlreadySealed,
    #[msg("Market terms must be initialized and sealed before market close")]
    Closed,
}

fn instruction_error(fault: Fault) -> anchor_lang::error::Error {
    let code = match fault {
        Fault::Binding => MarketTermsError::Binding,
        Fault::InvalidConfiguration => MarketTermsError::InvalidConfiguration,
        Fault::InvalidBook => MarketTermsError::InvalidBook,
        Fault::InvalidSeats => MarketTermsError::InvalidSeats,
        Fault::AlreadyTrading => MarketTermsError::AlreadyTrading,
        Fault::UnauthorizedCreator => MarketTermsError::UnauthorizedCreator,
        Fault::UnauthorizedReviewer => MarketTermsError::UnauthorizedReviewer,
        Fault::ReviewerTraded => MarketTermsError::ReviewerTraded,
        Fault::DigestMismatch => MarketTermsError::DigestMismatch,
        Fault::AlreadyAccepted => MarketTermsError::AlreadyAccepted,
        Fault::MissingAcceptance => MarketTermsError::MissingAcceptance,
        Fault::AlreadySealed => MarketTermsError::AlreadySealed,
    };
    error!(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Pubkey { Pubkey::new_unique() }
    fn digest(byte: u8) -> [u8; 32] { [byte; 32] }
    fn terms() -> MarketTerms {
        MarketTerms::initialize(1, key(), key(), digest(7), 1_234, key(), key(), key(), key(), 9).unwrap()
    }

    #[test]
    fn fixed_layout_matches_documented_240_byte_account() {
        assert_eq!(MarketTerms::INIT_SPACE, MarketTerms::SPACE);
        assert_eq!(8 + MarketTerms::SPACE, 240);
    }

    #[test]
    fn initialization_rejects_ambiguous_or_unbounded_commitments() {
        let market = key(); let creator = key(); let proposer = key(); let proposer_enrollment = key();
        let approver = key(); let approver_enrollment = key();
        let make = |version, digest, length, p, pe, a, ae| MarketTerms::initialize(
            version, market, creator, digest, length, p, pe, a, ae, 1);
        assert_eq!(make(0, digest(1), 1, proposer, proposer_enrollment, approver, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, ZERO_DIGEST, 1, proposer, proposer_enrollment, approver, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, digest(1), 0, proposer, proposer_enrollment, approver, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, digest(1), MARKET_TERMS_MAX_MANIFEST_LEN + 1, proposer, proposer_enrollment, approver, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, digest(1), 1, creator, proposer_enrollment, approver, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, digest(1), 1, proposer, proposer_enrollment, proposer, approver_enrollment), Err(Fault::InvalidConfiguration));
        assert_eq!(make(1, digest(1), 1, proposer, proposer_enrollment, approver, proposer_enrollment), Err(Fault::InvalidConfiguration));
    }

    #[test]
    fn only_exact_eligible_role_can_add_its_acceptance_bit() {
        let mut value = terms();
        let before = value.clone();
        assert_eq!(value.accept(key(), key(), value.digest, true), Err(Fault::UnauthorizedReviewer));
        assert_eq!(value, before);
        assert_eq!(value.accept(value.proposer_wallet, value.proposer_enrollment, digest(8), true), Err(Fault::DigestMismatch));
        assert_eq!(value.accept(value.proposer_wallet, value.proposer_enrollment, value.digest, false), Err(Fault::ReviewerTraded));
        let proposer = (value.proposer_wallet, value.proposer_enrollment, value.digest);
        value.accept(proposer.0, proposer.1, proposer.2, true).unwrap();
        assert_eq!(value.acceptance_bits, PROPOSER_ACCEPTED);
        assert_eq!(value.accept(proposer.0, proposer.1, proposer.2, true), Err(Fault::AlreadyAccepted));
        let approver = (value.approver_wallet, value.approver_enrollment, value.digest);
        value.accept(approver.0, approver.1, approver.2, true).unwrap();
        assert_eq!(value.acceptance_bits, ALL_ACCEPTED);
    }

    #[test]
    fn seal_is_one_way_and_requires_creator_digest_and_both_signatures() {
        let mut value = terms();
        let creator = value.creator; let expected_digest = value.digest;
        assert_eq!(value.seal(creator, expected_digest), Err(Fault::MissingAcceptance));
        value.accept(value.proposer_wallet, value.proposer_enrollment, expected_digest, true).unwrap();
        value.accept(value.approver_wallet, value.approver_enrollment, expected_digest, true).unwrap();
        assert_eq!(value.seal(key(), expected_digest), Err(Fault::UnauthorizedCreator));
        assert_eq!(value.seal(creator, digest(9)), Err(Fault::DigestMismatch));
        value.seal(creator, expected_digest).unwrap();
        assert!(value.sealed);
        assert_eq!(value.seal(creator, expected_digest), Err(Fault::AlreadySealed));
        assert_eq!(value.accept(value.proposer_wallet, value.proposer_enrollment, expected_digest, true), Err(Fault::AlreadySealed));
    }

    #[test]
    fn canonical_helper_requires_exact_pda_binding_and_sealed_state() {
        let market_key = key(); let creator = key();
        let (terms_key, bump) = Pubkey::find_program_address(&[MARKET_TERMS_SEED, market_key.as_ref()], &crate::ID);
        let mut value = MarketTerms::initialize(1, market_key, creator, digest(1), 50, key(), key(), key(), key(), bump).unwrap();
        value.acceptance_bits = ALL_ACCEPTED; value.sealed = true;
        let market = escrow::Market { config: key(), creator, seats: key(), vault: key(), market_id: 1,
            payout_milli: 100_000, closes_at: 100, resolves_at: 200, accounted_vault: 0,
            collateral: 0, fee_revenue: 0, fee_bps: 10, bump: 1 };
        assert_eq!(validate_canonical_sealed_terms(terms_key, &value, market_key, &market), Ok(()));
        assert_eq!(validate_canonical_sealed_terms(key(), &value, market_key, &market), Err(Fault::Binding));
        value.bump = value.bump.wrapping_sub(1);
        assert_eq!(validate_canonical_sealed_terms(terms_key, &value, market_key, &market), Err(Fault::Binding));
        value.bump = bump;
        value.sealed = false;
        assert_eq!(validate_canonical_sealed_terms(terms_key, &value, market_key, &market), Err(Fault::Binding));
    }

    #[test]
    fn pure_validation_rejects_unreachable_zero_or_incoherent_serialized_state() {
        let mut value = terms();
        value.proposer_wallet = Pubkey::default();
        assert_eq!(value.accept(key(), key(), value.digest, true), Err(Fault::InvalidConfiguration));
        let mut value = terms();
        value.sealed = true;
        assert_eq!(value.seal(value.creator, value.digest), Err(Fault::InvalidConfiguration));
    }

    fn foundation() -> (Pubkey, escrow::Market, Box<escrow::Seats>, Vec<u8>) {
        use crate::exchange::{BOOK_BYTES, BOOK_TAG};
        use matching::runtime::{Header, Slot, Storage};

        let market_key = key();
        let mut seats = Box::<escrow::Seats>::new_uninit();
        unsafe { core::ptr::write_bytes(seats.as_mut_ptr(), 0, 1); }
        let mut seats = unsafe { seats.assume_init() };
        seats.market = market_key;
        seats.count = 1;
        seats.entries[0].wallet = key();
        seats.entries[0].enrollment = key();
        // A real pre-trade deposit is expressly allowed by the terms lifecycle.
        seats.entries[0].available_cash = 90_000;
        let market = escrow::Market {
            config: key(), creator: key(), seats: key(), vault: key(), market_id: 1,
            payout_milli: 100_000, closes_at: 100, resolves_at: 200,
            accounted_vault: 90_000, collateral: 0, fee_revenue: 0, fee_bps: 10, bump: 1,
        };
        let mut bytes = vec![0u8; BOOK_BYTES];
        bytes[..8].copy_from_slice(&BOOK_TAG);
        let pointer = bytes[8..].as_mut_ptr();
        assert_eq!((pointer as usize) % core::mem::align_of::<Header>(), 0);
        unsafe {
            let slots_pointer = pointer.add(core::mem::size_of::<Header>());
            let bids_pointer = slots_pointer.add(matching::MAX_ORDERS * core::mem::size_of::<Slot>());
            let asks_pointer = bids_pointer.add(matching::MAX_ORDERS * 2);
            Storage::initialize(
                market_key.to_bytes(), market.payout_milli, market.fee_bps,
                &mut *pointer.cast::<Header>(),
                core::slice::from_raw_parts_mut(slots_pointer.cast::<Slot>(), matching::MAX_ORDERS),
                core::slice::from_raw_parts_mut(bids_pointer.cast::<u16>(), matching::MAX_ORDERS),
                core::slice::from_raw_parts_mut(asks_pointer.cast::<u16>(), matching::MAX_ORDERS),
            ).unwrap();
        }
        (market_key, market, seats, bytes)
    }

    #[test]
    fn pristine_validation_allows_deposits_but_rejects_any_trade_history() {
        use matching::runtime::Header;

        let (market_key, market, mut seats, mut book) = foundation();
        assert_eq!(validate_pristine_market(market_key, &market, &seats, &book), Ok(()));
        seats.entries[0].ever_traded = 1;
        assert_eq!(validate_pristine_market(market_key, &market, &seats, &book), Err(Fault::AlreadyTrading));
        seats.entries[0].ever_traded = 0;
        let header = unsafe { &mut *book[8..].as_mut_ptr().cast::<Header>() };
        header.revision = 2;
        header.next_sequence = 3;
        assert_eq!(validate_pristine_market(market_key, &market, &seats, &book), Err(Fault::AlreadyTrading));
    }

    #[test]
    fn reviewer_eligibility_uses_permanent_seat_history_and_exact_pairing() {
        let (_, _, mut seats, _) = foundation();
        let seat = seats.entries[0];
        assert_eq!(reviewer_has_never_traded(&seats, seat.wallet, seat.enrollment), Ok(true));
        assert_eq!(reviewer_has_never_traded(&seats, key(), key()), Ok(true));
        assert_eq!(reviewer_has_never_traded(&seats, seat.wallet, key()), Err(Fault::InvalidSeats));
        seats.entries[0].ever_traded = 1;
        assert_eq!(reviewer_has_never_traded(&seats, seat.wallet, seat.enrollment), Ok(false));
    }
}
