//! Immutable attestations for settlements performed by Goosey's database
//! engine. This module commits to an off-chain settlement result; it never
//! reads or mutates feather mints, token accounts, exchange markets, seats,
//! books, vaults, or participant wallets.

use anchor_lang::prelude::*;

use crate::Config;

pub const DATABASE_SETTLEMENT_CONFIG_SEED: &[u8] = b"db_settlement_config";
pub const DATABASE_SETTLEMENT_SEED: &[u8] = b"db_settlement";
const VERSION: u8 = 1;
const ZERO_DIGEST: [u8; 32] = [0; 32];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum DatabaseSettlementOutcome {
    Yes = 0,
    No = 1,
    Void = 2,
}

#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct DatabaseSettlementAttestationConfig {
    pub version: u8,
    pub config: Pubkey,
    pub authority: Pubkey,
    /// Public nonzero deployment domain used by the server when hashing database
    /// market identifiers. Raw database identifiers never go on chain.
    pub database_domain: [u8; 32],
    pub bump: u8,
}

impl DatabaseSettlementAttestationConfig {
    fn initialize(
        config: Pubkey,
        admin: Pubkey,
        enrollment_authority: Pubkey,
        authority: Pubkey,
        database_domain: [u8; 32],
        bump: u8,
    ) -> Checked<Self> {
        if config == Pubkey::default()
            || authority == Pubkey::default()
            || authority == admin
            || authority == enrollment_authority
            || database_domain == ZERO_DIGEST
        {
            return Err(Fault::InvalidConfiguration);
        }
        Ok(Self { version: VERSION, config, authority, database_domain, bump })
    }
}

#[account]
#[derive(Debug, PartialEq, Eq)]
pub struct DatabaseSettlementAttestation {
    pub version: u8,
    pub config: Pubkey,
    pub authority: Pubkey,
    /// SHA-256 over the domain-separated database market identity.
    pub database_market_digest: [u8; 32],
    /// SHA-256 over the canonical completed settlement payload.
    pub settlement_digest: [u8; 32],
    pub outcome: DatabaseSettlementOutcome,
    pub total_positions: u64,
    pub total_payout_milli: u64,
    pub resolved_at: i64,
    pub bump: u8,
}

impl DatabaseSettlementAttestation {
    /// Exact Borsh payload size, excluding Anchor's discriminator.
    pub const SPACE: usize = 155;

    #[allow(clippy::too_many_arguments)]
    fn initialize(
        config: Pubkey,
        authority: Pubkey,
        database_market_digest: [u8; 32],
        settlement_digest: [u8; 32],
        outcome: DatabaseSettlementOutcome,
        total_positions: u64,
        total_payout_milli: u64,
        resolved_at: i64,
        bump: u8,
    ) -> Checked<Self> {
        if config == Pubkey::default() || authority == Pubkey::default() {
            return Err(Fault::InvalidConfiguration);
        }
        if database_market_digest == ZERO_DIGEST
            || settlement_digest == ZERO_DIGEST
            || database_market_digest == settlement_digest
        {
            return Err(Fault::InvalidDigest);
        }
        if resolved_at <= 0 {
            return Err(Fault::InvalidTimestamp);
        }
        Ok(Self {
            version: VERSION,
            config,
            authority,
            database_market_digest,
            settlement_digest,
            outcome,
            total_positions,
            total_payout_milli,
            resolved_at,
            bump,
        })
    }

    /// `init_if_needed` makes exact retries idempotent. Every persisted field is
    /// compared, so the same market digest can never be rebound to a different
    /// result, aggregate, authority, or completion time.
    fn require_exact_replay(&self, expected: &Self) -> Checked<()> {
        if self == expected { Ok(()) } else { Err(Fault::ConflictingAttestation) }
    }
}

#[derive(Accounts)]
#[instruction(authority: Pubkey, database_domain: [u8; 32])]
pub struct InitializeDatabaseSettlementAttestationConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        seeds = [DATABASE_SETTLEMENT_CONFIG_SEED, config.key().as_ref()],
        bump,
        space = 8 + DatabaseSettlementAttestationConfig::INIT_SPACE,
    )]
    pub attestation_config: Account<'info, DatabaseSettlementAttestationConfig>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_database_settlement_attestation_config(
    ctx: Context<InitializeDatabaseSettlementAttestationConfig>,
    authority: Pubkey,
    database_domain: [u8; 32],
) -> Result<()> {
    let value = DatabaseSettlementAttestationConfig::initialize(
        ctx.accounts.config.key(),
        ctx.accounts.config.admin,
        ctx.accounts.config.enrollment_authority,
        authority,
        database_domain,
        ctx.bumps.attestation_config,
    ).map_err(instruction_error)?;
    ctx.accounts.attestation_config.set_inner(value);
    emit!(DatabaseSettlementAttestationConfigured {
        config: ctx.accounts.config.key(),
        authority,
        database_domain,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(database_market_digest: [u8; 32])]
pub struct AttestDatabaseSettlement<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        seeds = [DATABASE_SETTLEMENT_CONFIG_SEED, config.key().as_ref()],
        bump = attestation_config.bump,
        has_one = config,
        has_one = authority @ DatabaseSettlementAttestationError::UnauthorizedAuthority,
        constraint = attestation_config.version == VERSION @ DatabaseSettlementAttestationError::InvalidConfiguration,
    )]
    pub attestation_config: Account<'info, DatabaseSettlementAttestationConfig>,
    #[account(
        init_if_needed,
        payer = authority,
        seeds = [DATABASE_SETTLEMENT_SEED, attestation_config.key().as_ref(), database_market_digest.as_ref()],
        bump,
        space = 8 + DatabaseSettlementAttestation::SPACE,
    )]
    pub attestation: Account<'info, DatabaseSettlementAttestation>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn attest_database_settlement(
    ctx: Context<AttestDatabaseSettlement>,
    database_market_digest: [u8; 32],
    settlement_digest: [u8; 32],
    outcome: DatabaseSettlementOutcome,
    total_positions: u64,
    total_payout_milli: u64,
    resolved_at: i64,
) -> Result<()> {
    let expected = DatabaseSettlementAttestation::initialize(
        ctx.accounts.config.key(),
        ctx.accounts.authority.key(),
        database_market_digest,
        settlement_digest,
        outcome,
        total_positions,
        total_payout_milli,
        resolved_at,
        ctx.bumps.attestation,
    ).map_err(instruction_error)?;
    let replayed = ctx.accounts.attestation.version != 0;
    if replayed {
        ctx.accounts.attestation.require_exact_replay(&expected).map_err(instruction_error)?;
    } else {
        ctx.accounts.attestation.set_inner(expected);
    }
    emit!(DatabaseSettlementAttested {
        attestation: ctx.accounts.attestation.key(),
        authority: ctx.accounts.authority.key(),
        database_market_digest,
        settlement_digest,
        outcome,
        total_positions,
        total_payout_milli,
        resolved_at,
        replayed,
    });
    Ok(())
}

#[event]
pub struct DatabaseSettlementAttestationConfigured {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub database_domain: [u8; 32],
}

#[event]
pub struct DatabaseSettlementAttested {
    pub attestation: Pubkey,
    pub authority: Pubkey,
    pub database_market_digest: [u8; 32],
    pub settlement_digest: [u8; 32],
    pub outcome: DatabaseSettlementOutcome,
    pub total_positions: u64,
    pub total_payout_milli: u64,
    pub resolved_at: i64,
    pub replayed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    InvalidConfiguration,
    InvalidDigest,
    InvalidTimestamp,
    ConflictingAttestation,
}

type Checked<T> = core::result::Result<T, Fault>;

#[error_code(offset = 7700)]
pub enum DatabaseSettlementAttestationError {
    #[msg("Database settlement attestation configuration is invalid")]
    InvalidConfiguration,
    #[msg("Database market and settlement digests must be distinct and nonzero")]
    InvalidDigest,
    #[msg("Database settlement completion time must be a positive Unix timestamp")]
    InvalidTimestamp,
    #[msg("The immutable database settlement attestation conflicts with this request")]
    ConflictingAttestation,
    #[msg("Signer is not the configured database settlement attestation authority")]
    UnauthorizedAuthority,
}

fn instruction_error(fault: Fault) -> anchor_lang::error::Error {
    let error = match fault {
        Fault::InvalidConfiguration => DatabaseSettlementAttestationError::InvalidConfiguration,
        Fault::InvalidDigest => DatabaseSettlementAttestationError::InvalidDigest,
        Fault::InvalidTimestamp => DatabaseSettlementAttestationError::InvalidTimestamp,
        Fault::ConflictingAttestation => DatabaseSettlementAttestationError::ConflictingAttestation,
    };
    error!(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Pubkey { Pubkey::new_unique() }
    fn digest(value: u8) -> [u8; 32] { [value; 32] }

    fn record() -> DatabaseSettlementAttestation {
        DatabaseSettlementAttestation::initialize(
            key(), key(), digest(2), digest(3), DatabaseSettlementOutcome::Yes,
            17, 1_234_567, 1_800_000_000, 254,
        ).unwrap()
    }

    #[test]
    fn fixed_account_layouts_match_their_documented_sizes() {
        use anchor_lang::AccountSerialize;

        assert_eq!(DatabaseSettlementAttestationConfig::INIT_SPACE, 98);
        assert_eq!(DatabaseSettlementAttestation::SPACE, 155);
        let config = DatabaseSettlementAttestationConfig {
            version: VERSION,
            config: key(),
            authority: key(),
            database_domain: digest(1),
            bump: 252,
        };
        let record = record();
        let mut config_bytes = Vec::new();
        let mut record_bytes = Vec::new();
        config.try_serialize(&mut config_bytes).unwrap();
        record.try_serialize(&mut record_bytes).unwrap();
        assert_eq!(config_bytes.len(), 8 + DatabaseSettlementAttestationConfig::INIT_SPACE);
        assert_eq!(record_bytes.len(), 8 + DatabaseSettlementAttestation::SPACE);
        assert_eq!(
            (
                DatabaseSettlementOutcome::Yes as u8,
                DatabaseSettlementOutcome::No as u8,
                DatabaseSettlementOutcome::Void as u8,
            ),
            (0, 1, 2),
        );
    }

    #[test]
    fn configuration_requires_a_distinct_dedicated_authority_and_domain() {
        let config = key(); let admin = key(); let enrollment = key(); let authority = key();
        assert!(DatabaseSettlementAttestationConfig::initialize(
            config, admin, enrollment, authority, digest(1), 7).is_ok());
        for invalid in [Pubkey::default(), admin, enrollment] {
            assert_eq!(DatabaseSettlementAttestationConfig::initialize(
                config, admin, enrollment, invalid, digest(1), 7), Err(Fault::InvalidConfiguration));
        }
        assert_eq!(DatabaseSettlementAttestationConfig::initialize(
            config, admin, enrollment, authority, ZERO_DIGEST, 7), Err(Fault::InvalidConfiguration));
    }

    #[test]
    fn settlement_commitment_rejects_ambiguous_inputs() {
        let config = key(); let authority = key();
        let make = |market, settlement, resolved_at| DatabaseSettlementAttestation::initialize(
            config, authority, market, settlement, DatabaseSettlementOutcome::Void,
            0, 0, resolved_at, 1);
        assert_eq!(make(ZERO_DIGEST, digest(2), 1), Err(Fault::InvalidDigest));
        assert_eq!(make(digest(1), ZERO_DIGEST, 1), Err(Fault::InvalidDigest));
        assert_eq!(make(digest(1), digest(1), 1), Err(Fault::InvalidDigest));
        assert_eq!(make(digest(1), digest(2), 0), Err(Fault::InvalidTimestamp));
        assert_eq!(make(digest(1), digest(2), -1), Err(Fault::InvalidTimestamp));
    }

    #[test]
    fn exact_replay_is_idempotent_and_any_changed_commitment_conflicts() {
        let value = record();
        assert_eq!(value.require_exact_replay(&value), Ok(()));
        let conflicts = [
            DatabaseSettlementAttestation { settlement_digest: digest(9), ..record_from(&value) },
            DatabaseSettlementAttestation { outcome: DatabaseSettlementOutcome::No, ..record_from(&value) },
            DatabaseSettlementAttestation { total_positions: value.total_positions + 1, ..record_from(&value) },
            DatabaseSettlementAttestation { total_payout_milli: value.total_payout_milli + 1, ..record_from(&value) },
            DatabaseSettlementAttestation { resolved_at: value.resolved_at + 1, ..record_from(&value) },
            DatabaseSettlementAttestation { authority: key(), ..record_from(&value) },
        ];
        for conflict in conflicts {
            assert_eq!(value.require_exact_replay(&conflict), Err(Fault::ConflictingAttestation));
        }
    }

    fn record_from(value: &DatabaseSettlementAttestation) -> DatabaseSettlementAttestation {
        DatabaseSettlementAttestation {
            version: value.version,
            config: value.config,
            authority: value.authority,
            database_market_digest: value.database_market_digest,
            settlement_digest: value.settlement_digest,
            outcome: value.outcome,
            total_positions: value.total_positions,
            total_payout_milli: value.total_payout_milli,
            resolved_at: value.resolved_at,
            bump: value.bump,
        }
    }

    #[test]
    fn pda_identity_is_scoped_by_attestation_configuration_and_market_digest() {
        let config_a = key(); let config_b = key();
        let derive = |config: Pubkey, market: [u8; 32]| Pubkey::find_program_address(
            &[DATABASE_SETTLEMENT_SEED, config.as_ref(), market.as_ref()], &crate::ID).0;
        let first = derive(config_a, digest(1));
        assert_ne!(first, derive(config_b, digest(1)));
        assert_ne!(first, derive(config_a, digest(2)));
    }
}
