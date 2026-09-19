use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, Token, TokenAccount},
};

pub mod arithmetic;
pub mod escrow;
use escrow::*;

declare_id!("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");

pub const FEATHER_DECIMALS: u8 = 3;
pub const DEFAULT_PAYOUT_MILLI: u64 = 100_000;

#[program]
pub mod goosey_exchange {
    use super::*;

    pub fn create_market(ctx: Context<CreateMarket>, market_id: u64, payout_milli: u64, fee_bps: u16, closes_at: i64, resolves_at: i64) -> Result<()> {
        escrow::create_market(ctx, market_id, payout_milli, fee_bps, closes_at, resolves_at)
    }

    pub fn register_seat(ctx: Context<RegisterSeat>) -> Result<()> {
        escrow::register_seat(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, expected_nonce: u64) -> Result<()> {
        escrow::deposit(ctx, amount, expected_nonce)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64, expected_nonce: u64) -> Result<()> {
        escrow::withdraw(ctx, amount, expected_nonce)
    }

    /// Bootstrap is restricted to this deployment's actual upgrade authority.
    /// Environment/genesis is a deployment domain, not an onchain network oracle.
    pub fn initialize(
        ctx: Context<Initialize>,
        environment: u8,
        genesis_domain: [u8; 32],
        enrollment_authority: Pubkey,
        per_wallet_cap: u64,
        campaign_cap: u64,
    ) -> Result<()> {
        require!(environment == 1 || environment == 2, GooseyError::UnsupportedEnvironment);
        require!(genesis_domain != [0; 32], GooseyError::InvalidDomain);
        require!(enrollment_authority != Pubkey::default(), GooseyError::InvalidAuthority);
        require!(per_wallet_cap > 0 && campaign_cap >= per_wallet_cap, GooseyError::InvalidCap);
        ctx.accounts.config.set_inner(Config {
            version: 1,
            environment,
            bump: ctx.bumps.config,
            mint_authority_bump: ctx.bumps.mint_authority,
            genesis_domain,
            admin: ctx.accounts.admin.key(),
            enrollment_authority,
            feather_mint: ctx.accounts.feather_mint.key(),
            per_wallet_cap,
            campaign_cap,
            total_authorized: 0,
            total_minted: 0,
        });
        emit!(Configured {
            config: ctx.accounts.config.key(),
            mint: ctx.accounts.feather_mint.key(),
            environment,
            genesis_domain,
        });
        Ok(())
    }

    /// Both the identity digest and wallet get permanent unique PDA records.
    /// Neither a web session reset nor an ATA recreation grants a second claim.
    pub fn authorize_enrollment(
        ctx: Context<AuthorizeEnrollment>,
        wallet: Pubkey,
        identity_digest: [u8; 32],
        allowance: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(wallet != Pubkey::default(), GooseyError::InvalidAuthority);
        require!(identity_digest != [0; 32], GooseyError::InvalidDomain);
        require!(allowance > 0 && allowance <= ctx.accounts.config.per_wallet_cap, GooseyError::InvalidCap);
        require!(expires_at > Clock::get()?.unix_timestamp, GooseyError::ExpiredGrant);
        let authorized = ctx.accounts.config.total_authorized.checked_add(allowance)
            .ok_or(GooseyError::ArithmeticOverflow)?;
        require!(authorized <= ctx.accounts.config.campaign_cap, GooseyError::CampaignCapExceeded);
        ctx.accounts.config.total_authorized = authorized;
        ctx.accounts.enrollment.set_inner(Enrollment {
            config: ctx.accounts.config.key(), wallet, identity_digest, allowance,
            claimed: 0, expires_at, bump: ctx.bumps.enrollment,
        });
        ctx.accounts.identity.set_inner(EnrollmentIdentity {
            config: ctx.accounts.config.key(), wallet, identity_digest,
        });
        emit!(EnrollmentAuthorized {
            wallet, enrollment: ctx.accounts.enrollment.key(), allowance, expires_at,
        });
        Ok(())
    }

    /// Mints only the authorized unpaid amount to the signing wallet's ATA.
    /// The issuer and transaction fee payer cannot spend that wallet's tokens.
    pub fn claim_feathers(ctx: Context<ClaimFeathers>) -> Result<()> {
        let amount = ctx.accounts.enrollment.allowance
            .checked_sub(ctx.accounts.enrollment.claimed)
            .ok_or(GooseyError::ArithmeticOverflow)?;
        // A retry after success is idempotent, including after grant expiry.
        if amount == 0 { return Ok(()); }
        require!(Clock::get()?.unix_timestamp < ctx.accounts.enrollment.expires_at, GooseyError::ExpiredGrant);
        let minted = ctx.accounts.config.total_minted.checked_add(amount)
            .ok_or(GooseyError::ArithmeticOverflow)?;
        require!(minted <= ctx.accounts.config.campaign_cap, GooseyError::CampaignCapExceeded);
        let config_key = ctx.accounts.config.key();
        let bump = [ctx.accounts.config.mint_authority_bump];
        let seeds: &[&[u8]] = &[b"mint_authority", config_key.as_ref(), &bump];
        let signer = [seeds];
        token::mint_to(
            CpiContext::new(ctx.accounts.token_program.key(), MintTo {
                mint: ctx.accounts.feather_mint.to_account_info(),
                to: ctx.accounts.wallet_tokens.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            }).with_signer(&signer),
            amount,
        )?;
        ctx.accounts.config.total_minted = minted;
        ctx.accounts.enrollment.claimed = ctx.accounts.enrollment.allowance;
        emit!(FeathersClaimed {
            wallet: ctx.accounts.wallet.key(), amount,
            lifetime_minted: minted,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ GooseyError::Unauthorized)]
    pub program: Program<'info, crate::program::GooseyExchange>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ GooseyError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = admin, seeds = [b"config"], bump, space = 8 + Config::INIT_SPACE)]
    pub config: Account<'info, Config>,
    /// CHECK: Only used as a PDA signing authority, bound to this configuration.
    #[account(seeds = [b"mint_authority", config.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(init, payer = admin, seeds = [b"feather_mint", config.key().as_ref()], bump,
        mint::decimals = FEATHER_DECIMALS, mint::authority = mint_authority)]
    pub feather_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey, identity_digest: [u8; 32])]
pub struct AuthorizeEnrollment<'info> {
    #[account(mut)]
    pub enrollment_authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = enrollment_authority)]
    pub config: Account<'info, Config>,
    #[account(init, payer = enrollment_authority,
        seeds = [b"enrollment", config.key().as_ref(), wallet.as_ref()], bump,
        space = 8 + Enrollment::INIT_SPACE)]
    pub enrollment: Account<'info, Enrollment>,
    #[account(init, payer = enrollment_authority,
        seeds = [b"identity", config.key().as_ref(), identity_digest.as_ref()], bump,
        space = 8 + EnrollmentIdentity::INIT_SPACE)]
    pub identity: Account<'info, EnrollmentIdentity>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFeathers<'info> {
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = feather_mint)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"enrollment", config.key().as_ref(), wallet.key().as_ref()],
        bump = enrollment.bump, has_one = config, has_one = wallet)]
    pub enrollment: Account<'info, Enrollment>,
    /// CHECK: Seed constraint fixes the sole mint signing authority.
    #[account(seeds = [b"mint_authority", config.key().as_ref()], bump = config.mint_authority_bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(mut, mint::decimals = FEATHER_DECIMALS, mint::authority = mint_authority)]
    pub feather_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = feather_mint, associated_token::authority = wallet,
        associated_token::token_program = token_program)]
    pub wallet_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    /// 1 = localnet, 2 = devnet. Enforced RPC/genesis checking remains a client responsibility.
    pub environment: u8,
    pub bump: u8,
    pub mint_authority_bump: u8,
    pub genesis_domain: [u8; 32],
    pub admin: Pubkey,
    pub enrollment_authority: Pubkey,
    pub feather_mint: Pubkey,
    pub per_wallet_cap: u64,
    pub campaign_cap: u64,
    pub total_authorized: u64,
    /// Lifetime counter: token burning never opens up new claim capacity.
    pub total_minted: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Enrollment {
    pub config: Pubkey,
    pub wallet: Pubkey,
    pub identity_digest: [u8; 32],
    pub allowance: u64,
    pub claimed: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EnrollmentIdentity {
    pub config: Pubkey,
    pub wallet: Pubkey,
    pub identity_digest: [u8; 32],
}

#[event]
pub struct Configured {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub environment: u8,
    pub genesis_domain: [u8; 32],
}

#[event]
pub struct EnrollmentAuthorized {
    pub wallet: Pubkey,
    pub enrollment: Pubkey,
    pub allowance: u64,
    pub expires_at: i64,
}

#[event]
pub struct FeathersClaimed {
    pub wallet: Pubkey,
    pub amount: u64,
    pub lifetime_minted: u64,
}

#[error_code]
pub enum GooseyError {
    #[msg("Only localnet and devnet deployment domains are supported")]
    UnsupportedEnvironment,
    #[msg("A nonzero deployment or enrollment domain is required")]
    InvalidDomain,
    #[msg("An authority must be a nonzero public key")]
    InvalidAuthority,
    #[msg("The configured allowance or cap is invalid")]
    InvalidCap,
    #[msg("The campaign's lifetime issuance limit would be exceeded")]
    CampaignCapExceeded,
    #[msg("The enrollment grant has expired")]
    ExpiredGrant,
    #[msg("Checked arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("The signer is not authorized for this deployment")]
    Unauthorized,
    #[msg("Invalid market payout, fees, or contractual times")]
    InvalidMarket,
    #[msg("The market's seat capacity has been reached")]
    SeatCapacity,
    #[msg("The supplied seat does not belong to this wallet and market")]
    InvalidSeat,
    #[msg("The instruction nonce does not match the seat's next nonce")]
    StaleNonce,
    #[msg("Amount must be positive and covered by available feathers")]
    InsufficientAvailable,
    #[msg("The SPL vault does not cover the market's accounted balance")]
    VaultUnderfunded,
}
