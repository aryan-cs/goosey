# Deployed Solana foundation: verification checkpoint

Date: 2026-09-19. This verifies free feather issuance and transfers on a **real isolated local validator**. It does not certify a finished on-chain exchange or web-wallet integration.

## Artifact and deployment

- Source foundation: commit `009f11e`; Anchor 1.2.0; locked Rust dependencies.
- Host Rust 1.98.1; SBF compiler Rust 1.89 / platform-tools v1.54; cargo-build-sbf 4.1.0; Agave validator/CLI 4.2.2, feature set 565236538.
- Command: `cargo-build-sbf --manifest-path chain/programs/goosey-exchange/Cargo.toml --arch v3`.
- ELF SHA-256: `e5161c7aa327fd3048f27f03c1b2c3b22555c54b05efb9d38428a9cb8438864b`.
- Program: `CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q`.
- Genesis: `Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm`.
- Actual loader deployment transaction: `5BDbBDw5pnPJSsDjdJT3U3ViYXTcZfnb1U8c2jm5Gaz1mCbYzPNFGcDJsaKG4naK1cL7NPcKdG9eHgwNRQHDTXUe`.

The initial default-v0 build compiled but deployment failed: this validator has SIMD-0500 active, disabling new v0/v1/v2 deployments. Explicit SBPF v3 fixed deployment. No validator features were disabled, no ledger was reset, and no failed deployment was counted as a success.

The finalized read-only preflight subsequently passed. It still reports `exchangeVerified: false`, correctly: an executable program is not evidence that every exchange requirement works.

## Real instruction results

`scripts/solana-program-e2e.ts` passed all 22 executed instruction cases, including:

- Only the actual upgrade authority can initialize. Unsupported environment, zero caps and repeat initialization fail without replacing state.
- Initialization creates a real classic SPL mint with three decimals, no freeze authority and a program-derived mint authority.
- Wrong issuer, excessive allowance and expired authorization fail atomically.
- Both wallet and opaque identity have unique permanent enrollment records. Neither can be reused to authorize a second grant.
- The wallet claims the exact allowance through program-signed Token CPI. Another wallet cannot claim it.
- A repeated claim with a fresh signature is a no-op; sending claimed feathers away does not replenish eligibility.
- The application transfer helper sends **123.456 feathers** from the claimed supply into another wallet's real ATA.
- An unpaid claim fails after the actual validator clock reaches its deadline. No clock sysvar or account balance was fabricated.
- Lifetime campaign authorization stops exactly at its cap.

Evidence examples:

| Action | Actual signature |
| --- | --- |
| Initialize | `36YHc8CteU6oNHaJmxnM9CTDzFRjjTRvUHRb9bGSoHt1eJN7XAzrveL4NuSUSViYbA6KszP56VbrQtaxpZSGs3kW` |
| Claim | `biqXHWhAZvT51j5n2J13Qu8YxLaqL7D1AJi8HNbp7qY7E2njfAuJBkkdmTjAxTDtrFvKxf2ga8L7Xh9xKDaYjHQ` |
| Transfer claimed feathers | `BFX8s4esYTezWw6u6ufADfamoPo4mg5xHNpXM7fnHV7LJNfxRuxbJKLLFnCceD2i5HmC2E2WR6mgy6wE9tS69rR` |

Mint: `EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw`. Final minted supply: 1,000,000 base units; sender 876,544 and recipient 123,456. Authorized lifetime allowance: 2,000,000 units, including unpaid/expired authorization. No burning or sending reopens the cap. All transaction fees were local faucet SOL, separately accounted from feather supply.

The independent SPL token suite also passed twice with fresh ephemeral mints, covering exact signed-byte replay, wrong decimals/mint/owner, insufficient balance, missing/corrupted signatures, unauthorized minting and atomic ATA rollback. See [token evidence](solana-verification-plan.md#executed-token-integration-evidence).

### Finality tracker follow-up

A subsequent live RPC check reproduced `Minimum context slot has not been reached` when a finalized block-height request used the moving processed slot returned by signature status. The tracker now reads finalized height without that incompatible minimum and still rechecks signature history before declaring the signing lifetime expired. Nineteen tracker contract tests pass, including a lagging-finality regression. A live absent-history/past-height probe now returns `expired` with `historicalOutcome: unknown`, rather than starving until timeout. This does **not** establish that the original transfer failed: the local node no longer returned its historical status. Expiration never authorizes an automatic freshly signed replacement or a database refund; persisted receipts/reconciliation remain necessary.

## Reproduction and limitations

Run `npm run test:chain:program` only against a fresh, already deployed and uninitialized program on a dedicated loopback validator. It requires explicit `GOOSEY_SOLANA_RPC_URL`, the actual `GOOSEY_SOLANA_GENESIS_HASH`, and `GOOSEY_SOLANA_TEST_ADMIN_KEYPAIR` pointing to a newly generated `goosey-admin-keypair.json` in a dedicated `/tmp/goosey-solana-*` directory. It checks the real loader upgrade authority before using that key. Do not use personal wallets. The script deliberately exhausts this test campaign and refuses to reinitialize an existing config; use a new isolated ledger for another full run, never reset the shared website/sandbox.

Only this dedicated test upgrade key is read from disk; participant and issuer keys exist only in memory and are discarded. No private keys are committed. Public signatures refer to this local ledger, not devnet or mainnet explorers.

Not yet proven here: market vault deposit/withdrawal, CLOB matching, oracle and feather payout, account/wallet linking with durable one-use nonces, browser signing/rejection flows, indexer rebuild, restart/fork recovery, or devnet execution. The foundation's escrow code is compiled but not covered by this suite. The website remains database-backed until those integrations are implemented and tested.
