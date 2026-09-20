# Goosey chain foundation

Program ID: `CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q`.

This is an executable currency/escrow foundation with an integrated placement adapter, **not yet the full prediction exchange**. Runtime-verified: upgrade-authority bootstrap, classic SPL feather mint, unique authorized enrollment, capped PDA-issued claims, market vaults, 256 market-local seats, deposits and withdrawals. The source now also compiles bounded book setup and order placement with actual-seat reserves, fees and collateral accounting; actual placement execution tests remain pending. Cancellation/replacement, complete order receipts, oracle review, market lifecycle, and position redemption remain implementation stages in [the design](../docs/solana-program-design.md).

No keypair is committed. The provided deployment key and newly generated local admin wallet are private ephemeral artifacts outside the repository. Do not run a deployment command against an implicit CLI default cluster or wallet.

## Verified build

On 2026-09-19:

- `cargo test --manifest-path chain/Cargo.toml`: 3 exact-arithmetic tests passed.
- `cargo-build-sbf --manifest-path chain/programs/goosey-exchange/Cargo.toml`: compilation passed, but the default SBPFv0 artifact was rejected by the local validator's deployment feature policy. Successful compilation alone did not establish runtime compatibility.
- Host Rust 1.98.1; platform-tools v1.54 / SBF Rust 1.89 supplied by main; Solana CLI 4.2.2; cargo-build-sbf 4.1.0; Anchor crates 1.2.0. Cargo.lock is committed for reproducibility.
- The explicit v3 artifact was deployed and the real initialize/enroll/claim/transfer RPC suite passed. The expanded 53-case suite also verifies market creation, deposits, withdrawals, donation surplus, rollback, and the shipping finalized escrow reader. See [artifact, signatures and verification limits](../docs/solana-foundation-qa.md). Matching and the full exchange lifecycle remain outstanding.
- `cargo fmt --check` could not run because the isolated host toolchain has no rustfmt component. No tooling was installed for formatting.

## Repeatable isolated execution

After compiling the actual program artifact, run:

```sh
GOOSEY_SOLANA_BIN_DIR=/path/to/solana/bin npm run test:chain:isolated
```

The runner creates a fresh loopback validator with a private ledger and fresh local-only upgrade key, reserves a random port block, snapshots/hashes the loaded ELF, and executes the real suite. It never resets or adopts the shared validator, reads a personal CLI wallet, or uses public testnets. Its help documents an optional validator executable and artifact override. It stops only its own child processes on success, failure, interruption or timeout; mode-0700 temporary directories retain private local-test keys and diagnostic logs. Do not fund these keys on any public network.

## Integrated book setup and placement (runtime verification pending)

The canonical book PDA uses `["order_book", market_pubkey]` and occupies 69,720 bytes. `create_book()` creates a 10,240-byte draft; each `grow_book(expected_size: u32)` adds at most 10,240 bytes and funds real rent through the admin signer. Send each growth as a separate confirmed transaction, rereading size after ambiguous submission. `finalize_book()` initializes exact matcher storage and publishes `GOOSEYB1` only at the final size. A ready book cannot be reset or resized by these instructions. All three contexts require the configured admin, config, canonical market, book PDA and System Program.

`place_order(PlaceOrderArgs)` uses wallet, config, market, seats, locator, vault and book accounts in that order. The wallet signs; market/seats/book are writable. Fields and explicit wire enum values are documented in `exchange.rs`. The program assigns owner, sequence, order ID, fee rate and lifetime notional; the client supplies none of those. Eight touches is the default; sixteen requires an appropriately measured transaction budget. Integrated CU is not yet measured, so standalone matcher measurements must not be treated as the full instruction's cost.

Anchor 1.2.0's `CpiContext::new` takes the program **public key**. The mint-init macro references Token-2022 helpers, so the crate enables the corresponding compile-time features. Runtime accounts are explicitly classic `Program<Token>`/`Account<Mint>`/`Account<TokenAccount>`; this program does not accept Token-2022 mints. Bytemuck is pinned to 1.25.2 to satisfy the resolved SPL interfaces.

### Required SBPF architecture for this validator

Build from the repository root with an explicit architecture:

```sh
cargo-build-sbf --arch v3 --manifest-path chain/programs/goosey-exchange/Cargo.toml
```

The binary is written to `chain/target/deploy/goosey_exchange.so`. The main integration task built and deployed the v3 artifact successfully without changing validator features. The [runtime evidence](../docs/solana-foundation-qa.md) records its exact hash and deployment receipt; a later rebuilt artifact must be verified again.

Read-only `solana --url http://127.0.0.1:18999 feature status --display-all` established both features active since epoch 0:

| Feature address | Runtime policy |
| --- | --- |
| `B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g` | SIMD-0500: disables **new deployment** of SBPFv0, v1, and v2 |
| `5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC` | Enables deployment/execution of SBPFv3 |

The installed cargo-build-sbf 4.1.0 defaults to `--arch v0`, explaining the original `Detected sbpf_version required by the executable which are not enabled` deployment error. Anza's [official build-tool documentation](https://github.com/anza-xyz/cargo-build-sbf#sbfpv3-migration) prescribes `--arch v3`; its release-scheduling prose is not a substitute for this validator's actual feature state. The [official ELF loader](https://github.com/anza-xyz/sbpf/blob/main/src/elf.rs) checks the executable's SBPF version against the enabled version set before loading it.

Verify the artifact header with the supplied LLVM `llvm-readelf --file-header`: ELF `Flags: 0x3` identifies SBPFv3. Rebuilding for SBPFv3 is distinct from selecting Solana **transaction** version 3 (there is no such choice here); clients may continue sending legacy/v0 transactions. Do not add experimental `--abi-v2`, disable features, or reset the validator to accommodate the older artifact. Preserve the pinned genesis and existing test state. Sources and feature state checked 2026-09-19.

## Stable instruction interface

Instruction data uses Anchor's discriminator followed by Borsh-encoded arguments in the listed order. All integers are little-endian. Existing instruction APIs below are the foundation handoff; use generated IDL when available rather than maintaining a separate handwritten client in production.

| Instruction | Arguments | Accounts in order |
| --- | --- | --- |
| `initialize` | `environment: u8`, `genesis_domain: [u8;32]`, `enrollment_authority: Pubkey`, `per_wallet_cap: u64`, `campaign_cap: u64` | admin (writable signer), program (read), program_data (read), config (write/new), mint_authority (read), feather_mint (write/new), token_program, system_program, rent |
| `authorize_enrollment` | `wallet: Pubkey`, `identity_digest: [u8;32]`, `allowance: u64`, `expires_at: i64` | enrollment_authority (writable signer), config (write), enrollment (write/new), identity (write/new), system_program |
| `claim_feathers` | none | wallet (signer), config (write), enrollment (write), mint_authority, feather_mint (write), wallet_tokens (write), token_program, associated_token_program |
| `create_market` | `market_id: u64`, `payout_milli: u64`, `fee_bps: u16`, `closes_at: i64`, `resolves_at: i64` | admin (writable signer), config, market (write/new), seats (write/uninitialized), feather_mint, vault (write/new), token_program, associated_token_program, system_program |
| `register_seat` | none | wallet (signer), rent_payer (writable signer), config, enrollment, market, seats (write), locator (write/new), system_program |
| `deposit` | `amount: u64`, `expected_nonce: u64` | wallet (signer), config, market (write), seats (write), locator, feather_mint, wallet_tokens (write), vault (write), token_program |
| `withdraw` | `amount: u64`, `expected_nonce: u64` | wallet (signer), config, market (write), seats (write), locator, feather_mint, wallet_tokens (write), vault (write), token_program |

The transaction fee payer may be separate from the wallet signer. Account-creation payers are explicit above. Seat registration requires `rent_payer` to differ from `wallet`; the participant wallet authorizes the seat while the server-managed sponsor funds the locator account and may also pay the transaction fee. This account-list change is an ABI break for pre-upgrade `register_seat` transaction messages. `initialize` requires that `program_data` is this program's upgradeable-loader ProgramData account and `admin` is its actual upgrade authority. Environment 1 = localnet, 2 = devnet; use the 32-byte SHA-256 digest of the actual genesis hash's UTF-8 base58 string as domain (not its base58-decoded bytes). This is the convention checked by the shipping configuration reader and actual RPC suite. Program state cannot prove which RPC network a caller chose; clients must pin genesis before submission.

PDA seeds (all under this program ID):

| Address | Seeds |
| --- | --- |
| config | UTF-8 `config` |
| mint_authority | UTF-8 `mint_authority`, config public-key bytes |
| feather_mint | UTF-8 `feather_mint`, config public-key bytes |
| enrollment | UTF-8 `enrollment`, config bytes, wallet bytes |
| identity | UTF-8 `identity`, config bytes, identity digest |
| market | UTF-8 `market`, config bytes, market ID as 8 little-endian bytes |
| locator | UTF-8 `seat`, market bytes, wallet bytes |

`program_data` is derived under the upgradeable loader from program-ID bytes. `wallet_tokens` is the classic feather ATA for the signing wallet; `vault` is the classic feather ATA for the market PDA. Create the wallet ATA with a real idempotent Associated Token instruction before claiming/depositing/withdrawing; claim does not create it. Mint decimals are always 3; no freeze authority is set. Market payout 100,000 base units is the existing default, not an issuance balance.

### Seats allocation

Before `create_market`, include a top-level System `CreateAccount` instruction for a **new ephemeral account**, space **32,816 bytes**, rent obtained from the local RPC, owner = Goosey program ID. The new account signs only creation. `create_market` initializes/binds it in the same transaction. No large PDA `init` CPI is used. Seats data is fixed and compile-time asserted:

```text
8-byte discriminator
32-byte market key
u32 count, 4 bytes padding
256 entries, each 128 bytes:
  wallet Pubkey; enrollment Pubkey;
  available_cash u64; reserved_cash u64;
  yes u64; no u64; reserved_yes u64; reserved_no u64;
  next_nonce u64; ever_traded u8; 7 bytes padding
```

Each wallet gets one permanent locator per market. No seat or grant close/reset instruction exists. All cash and position fields begin at zero; only real token deposits credit available cash. Future matcher work must reserve/debit these fields and preserve the vault invariant, rather than replacing them with database balances. The Market header will need a versioned migration/layout extension for the full book/lifecycle fields; do not interpret a foundation market as open for prediction trading.

### Replay and grant semantics

Enrollment reserves campaign allowance upfront, capped per wallet and campaign. One enrollment identity and one wallet can each appear only once for this config. The authorization record has a claim deadline; it does not expire wallet token ownership or claw back transfers. There is no grant renewal/relinking mechanism in this initial version. Claim pays the entire allowance once; repeated claims return successfully with no mint, even after expiry. Lifetime minted is separate from actual SPL supply, so a burn cannot restore issuance capacity.

Seat nonce starts at zero. Each successful deposit or withdrawal increments it once; an outdated nonce fails with no token/balance effect. This prevents duplicate economic effects but is not yet the richer replay-result receipt proposed for order commands. After an ambiguous RPC response, inspect transaction status and seat nonce rather than automatically submitting the operation with a new nonce.

Withdrawals can only use the owner's available cash and return to their feather ATA. Admin cannot redirect them. Vault amount may exceed accounted cash after an unsolicited SPL transfer; surplus creates no seat credit. No arbitrary cash, position, or supply setters exist. Fees/positions remain zero until their actual matching instructions are implemented.

## Runtime acceptance handoff

Main is coordinating a separate real-RPC test for initialization/enrollment/claim and an independent classic-SPL transfer test. Escrow tests must additionally create the real seat account, register a wallet, deposit through Token CPI, verify exact vault/seat/token balances, reject nonce replay and excessive withdrawals, then withdraw to the owner ATA. Include wrong-owner/destination cases, unsolicited vault donation without credit, and a failed transfer with unchanged seat accounting. The independently minted token-transfer test validates wallet transfers; it must not be presented as proof of Goosey's PDA mint or escrow behavior.

The local validator supplied for this run is `http://127.0.0.1:18999`, genesis `Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm`. This is an ephemeral test context, not a permanent deployment address/configuration. No mainnet actions are part of this work.
