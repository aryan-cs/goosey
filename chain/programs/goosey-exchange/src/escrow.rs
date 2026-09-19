//! SPL-backed market-local cash. No admin withdrawal path and no synthetic balances.
use crate::*;
use anchor_spl::token::TransferChecked;

pub const SEAT_CAPACITY: usize = 256;

pub fn create_market(ctx: Context<CreateMarket>, market_id: u64, payout_milli: u64, fee_bps: u16, closes_at: i64, resolves_at: i64) -> Result<()> {
    require!((2..=1_000_000).contains(&payout_milli) && fee_bps <= 10_000
        && closes_at > Clock::get()?.unix_timestamp && resolves_at >= closes_at, GooseyError::InvalidMarket);
    ctx.accounts.market.set_inner(Market {
        config: ctx.accounts.config.key(), creator: ctx.accounts.admin.key(), market_id,
        seats: ctx.accounts.seats.key(), vault: ctx.accounts.vault.key(),
        payout_milli, fee_bps, closes_at, resolves_at,
        accounted_vault: 0, collateral: 0, fee_revenue: 0,
        bump: ctx.bumps.market,
    });
    let mut seats = ctx.accounts.seats.load_init()?;
    seats.market = ctx.accounts.market.key();
    seats.count = 0;
    emit!(MarketCreated { market: ctx.accounts.market.key(), vault: ctx.accounts.vault.key(), payout_milli });
    Ok(())
}

pub fn register_seat(ctx: Context<RegisterSeat>) -> Result<()> {
    let mut seats = ctx.accounts.seats.load_mut()?;
    require!(seats.market == ctx.accounts.market.key(), GooseyError::InvalidSeat);
    let index = usize::try_from(seats.count).map_err(|_| GooseyError::SeatCapacity)?;
    require!(index < SEAT_CAPACITY, GooseyError::SeatCapacity);
    // Registration records are permanent; indices cannot be recycled by closing a locator.
    let seat = &mut seats.entries[index];
    require!(seat.wallet == Pubkey::default(), GooseyError::InvalidSeat);
    seat.wallet = ctx.accounts.wallet.key();
    seat.enrollment = ctx.accounts.enrollment.key();
    ctx.accounts.locator.set_inner(SeatLocator {
        market: ctx.accounts.market.key(), wallet: ctx.accounts.wallet.key(),
        index: index as u32, bump: ctx.bumps.locator,
    });
    seats.count += 1;
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64, expected_nonce: u64) -> Result<()> {
    require!(amount > 0, GooseyError::InsufficientAvailable);
    require!(ctx.accounts.vault.amount >= ctx.accounts.market.accounted_vault, GooseyError::VaultUnderfunded);
    let mut seats = ctx.accounts.seats.load_mut()?;
    let seat = checked_seat(&mut seats, &ctx.accounts.locator, ctx.accounts.market.key(), ctx.accounts.wallet.key())?;
    require!(seat.next_nonce == expected_nonce, GooseyError::StaleNonce);
    let available = seat.available_cash.checked_add(amount).ok_or(GooseyError::ArithmeticOverflow)?;
    let accounted = ctx.accounts.market.accounted_vault.checked_add(amount).ok_or(GooseyError::ArithmeticOverflow)?;
    let nonce = seat.next_nonce.checked_add(1).ok_or(GooseyError::ArithmeticOverflow)?;
    token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
        from: ctx.accounts.wallet_tokens.to_account_info(), mint: ctx.accounts.feather_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.wallet.to_account_info(),
    }), amount, FEATHER_DECIMALS)?;
    seat.available_cash = available;
    seat.next_nonce = nonce;
    ctx.accounts.market.accounted_vault = accounted;
    emit!(CashMoved { market: ctx.accounts.market.key(), wallet: ctx.accounts.wallet.key(), amount, deposit: true, nonce: expected_nonce });
    Ok(())
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64, expected_nonce: u64) -> Result<()> {
    require!(amount > 0, GooseyError::InsufficientAvailable);
    require!(ctx.accounts.vault.amount >= ctx.accounts.market.accounted_vault, GooseyError::VaultUnderfunded);
    let mut seats = ctx.accounts.seats.load_mut()?;
    let seat = checked_seat(&mut seats, &ctx.accounts.locator, ctx.accounts.market.key(), ctx.accounts.wallet.key())?;
    require!(seat.next_nonce == expected_nonce, GooseyError::StaleNonce);
    let available = seat.available_cash.checked_sub(amount).ok_or(GooseyError::InsufficientAvailable)?;
    let accounted = ctx.accounts.market.accounted_vault.checked_sub(amount).ok_or(GooseyError::ArithmeticOverflow)?;
    let nonce = seat.next_nonce.checked_add(1).ok_or(GooseyError::ArithmeticOverflow)?;
    let config_key = ctx.accounts.config.key();
    let market_id = ctx.accounts.market.market_id.to_le_bytes();
    let bump = [ctx.accounts.market.bump];
    let seeds: &[&[u8]] = &[b"market", config_key.as_ref(), &market_id, &bump];
    let signer = [seeds];
    token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), TransferChecked {
        from: ctx.accounts.vault.to_account_info(), mint: ctx.accounts.feather_mint.to_account_info(),
        to: ctx.accounts.wallet_tokens.to_account_info(), authority: ctx.accounts.market.to_account_info(),
    }).with_signer(&signer), amount, FEATHER_DECIMALS)?;
    seat.available_cash = available;
    seat.next_nonce = nonce;
    ctx.accounts.market.accounted_vault = accounted;
    emit!(CashMoved { market: ctx.accounts.market.key(), wallet: ctx.accounts.wallet.key(), amount, deposit: false, nonce: expected_nonce });
    Ok(())
}

fn checked_seat<'a>(seats: &'a mut Seats, locator: &SeatLocator, market: Pubkey, wallet: Pubkey) -> Result<&'a mut Seat> {
    require!(seats.market == market && locator.market == market && locator.wallet == wallet, GooseyError::InvalidSeat);
    let index = locator.index as usize;
    require!(index < SEAT_CAPACITY && index < seats.count as usize, GooseyError::InvalidSeat);
    let seat = &mut seats.entries[index];
    require!(seat.wallet == wallet, GooseyError::InvalidSeat);
    Ok(seat)
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin, has_one = feather_mint)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, seeds = [b"market", config.key().as_ref(), &market_id.to_le_bytes()],
        bump, space = 8 + Market::INIT_SPACE)]
    pub market: Account<'info, Market>,
    /// Created with a top-level System create-account instruction, owned by this program.
    #[account(zero)]
    pub seats: AccountLoader<'info, Seats>,
    #[account(mint::decimals = FEATHER_DECIMALS)]
    pub feather_mint: Account<'info, Mint>,
    #[account(init, payer = admin, associated_token::mint = feather_mint,
        associated_token::authority = market, associated_token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterSeat<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"enrollment", config.key().as_ref(), wallet.key().as_ref()], bump = enrollment.bump,
        has_one = config, has_one = wallet)]
    pub enrollment: Account<'info, Enrollment>,
    #[account(has_one = config, has_one = seats)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub seats: AccountLoader<'info, Seats>,
    #[account(init, payer = wallet, seeds = [b"seat", market.key().as_ref(), wallet.key().as_ref()],
        bump, space = 8 + SeatLocator::INIT_SPACE)]
    pub locator: Account<'info, SeatLocator>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = feather_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config, has_one = seats, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub seats: AccountLoader<'info, Seats>,
    #[account(seeds = [b"seat", market.key().as_ref(), wallet.key().as_ref()], bump = locator.bump,
        has_one = market, has_one = wallet)]
    pub locator: Account<'info, SeatLocator>,
    #[account(mint::decimals = FEATHER_DECIMALS)]
    pub feather_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = feather_mint, associated_token::authority = wallet,
        associated_token::token_program = token_program)]
    pub wallet_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = feather_mint, associated_token::authority = market,
        associated_token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// Separate context gives generated clients the correct instruction account list.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub wallet: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = feather_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", config.key().as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump, has_one = config, has_one = seats, has_one = vault)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub seats: AccountLoader<'info, Seats>,
    #[account(seeds = [b"seat", market.key().as_ref(), wallet.key().as_ref()], bump = locator.bump,
        has_one = market, has_one = wallet)]
    pub locator: Account<'info, SeatLocator>,
    #[account(mint::decimals = FEATHER_DECIMALS)]
    pub feather_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = feather_mint, associated_token::authority = wallet,
        associated_token::token_program = token_program)]
    pub wallet_tokens: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = feather_mint, associated_token::authority = market,
        associated_token::token_program = token_program)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub seats: Pubkey,
    pub vault: Pubkey,
    pub market_id: u64,
    pub payout_milli: u64,
    pub closes_at: i64,
    pub resolves_at: i64,
    pub accounted_vault: u64,
    pub collateral: u64,
    pub fee_revenue: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SeatLocator {
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub index: u32,
    pub bump: u8,
}

#[account(zero_copy)]
pub struct Seats {
    pub market: Pubkey,
    pub count: u32,
    pub padding: [u8; 4],
    pub entries: [Seat; SEAT_CAPACITY],
}

#[zero_copy]
pub struct Seat {
    pub wallet: Pubkey,
    pub enrollment: Pubkey,
    pub available_cash: u64,
    pub reserved_cash: u64,
    pub yes: u64,
    pub no: u64,
    pub reserved_yes: u64,
    pub reserved_no: u64,
    pub next_nonce: u64,
    pub ever_traded: u8,
    pub padding: [u8; 7],
}

const _: () = assert!(core::mem::size_of::<Seat>() == 128);
const _: () = assert!(core::mem::size_of::<Seats>() == 32_808);

#[event]
pub struct MarketCreated { pub market: Pubkey, pub vault: Pubkey, pub payout_milli: u64 }

#[event]
pub struct CashMoved { pub market: Pubkey, pub wallet: Pubkey, pub amount: u64, pub deposit: bool, pub nonce: u64 }
