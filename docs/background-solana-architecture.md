# Background Solana architecture for Goosey

Status: proposed design, 2026-09-19. This document describes localnet and devnet only. Goosey feathers remain free, nonredeemable game tokens. Nothing here authorizes mainnet, real-money deposits, withdrawals, or a claim that feathers have monetary value.

## Decision

Goosey should keep its existing email/password account experience and existing `/markets`, `/api/markets`, order, portfolio, comment, leaderboard, and admin surfaces. Solana becomes an internal execution and settlement dependency. Users do not connect a wallet, manage SOL, approve transactions, see a separate chain catalog, or need to understand token accounts.

The first implementable cutover should use one server-managed Solana Ed25519 authority per Goosey user and a separate server-managed fee sponsor. This preserves the current program's wallet-bound enrollment, seat, escrow, order, cancellation, transfer, and claim authorization model while moving signing behind the authenticated application service. It is a custodial design: Goosey can act on behalf of a user, and that trust boundary must be stated internally and enforced rigorously even though the product has no real value.

The alternative—a single operator signer controlling user PDAs—would reduce the number of keys but would require a broad program rewrite and would give one hot key authority over every participant. It is not the recommended first cutover. A later program version may separate stable user PDAs from rotatable custody authorities, but that is not required to remove wallet UX.

The chain is the authoritative financial state after cutover. SQL remains authoritative for accounts, sessions, market metadata, comments, moderation, notifications, and idempotent command orchestration. SQL balance, position, order, trade, and leaderboard rows become finalized-event projections, never an independently writable financial ledger.

## What exists today

The repository already contains more of the required foundation than a typical migration starts with:

- `chain/programs/goosey-exchange` implements free feather enrollment and claims, SPL escrow, fixed-capacity market seats, a bounded central limit order book, cancellation and cleanup, market terms, reviewer approval, resolution, claims, and accounting checks.
- The program presently requires the participant `wallet` to sign enrollment claims, seat registration, deposits, withdrawals, orders, and owner cancellations. Current browser helpers such as `prepare-order.ts` also make that participant the fee payer.
- The program has hard capacity limits: 256 seats per market, 1,024 live orders per market, and at most 16 matched order touches per placement. These are release gates, not implementation details. A market exceeding any capacity must not be cut over until a larger/sharded program design is implemented and benchmarked.
- `SolanaMarketBinding` already binds a SQL market to cluster, genesis hash, program address, market PDA, and chain market ID.
- The event journal, transaction receipts, finalized indexer, ingestion cursor, coverage reporting, catalog reader, trade tape, portfolio reader, and release-readiness tooling already establish useful fail-closed patterns.
- The product is currently split. Conventional pages and APIs filter for `executionBackend = DATABASE`; chain markets live under `/chain` and `/api/solana`; browser wallet linking lives in `SolanaWalletLinkChallenge` and `SolanaWalletLink`.
- `Market.executionBackend` and collateral consistency are intentionally immutable in the reviewed migrations. A safe cutover must replace that invariant with an execution-epoch model or perform one explicit, audited migration. It must not bypass the trigger ad hoc.
- The conventional product supports both LMSR and order-book markets. The chain program supports an order book. LMSR requests therefore need a real order-book execution policy, not a claim that the on-chain matcher implements LMSR.

## Target topology

```text
browser
  | existing session cookie + CSRF + idempotency key
  v
Next.js account/market API
  | authenticate, authorize, validate, hash request
  | create/replay ChainCommand
  v
command worker ---------------------> signer service
  | lease + build exact message       | per-user authority
  | finalized snapshot + simulation   | fee sponsor
  | write signed bytes before send    | role-separated admin/reviewer keys
  v                                  |
Solana RPC <--------------------------+
  | local validator or devnet only
  v
Goosey exchange program + SPL Token Program
  |
  | finalized signatures/events
  v
finalized indexer -> append-only event journal -> SQL read projections
  |                                             |
  +---------------- reconciliation ------------+
```

The request path and indexer are deliberately separate. An RPC `sendTransaction` success only means the node accepted the signed bytes; it does not prove processing or confirmation. The command reaches `FINALIZED_SUCCESS` only after finalized signature status and the expected decoded program event/state transition agree. The indexer independently observes the same finalized transaction and updates read projections.

## Managed account and signer design

### User custody accounts

Each active Goosey user receives one managed Solana address per deployment domain:

```text
(userId, cluster, genesisHash) -> walletAddress + versioned encrypted key envelope
```

The first localnet/devnet implementation stores only AES-256-GCM ciphertext, nonce, authentication tag, and key identifier in Prisma. Its 32-byte wrapping key lives outside the database in server configuration. Plaintext key bytes must never reach application logs, API responses, browser bundles, transaction metadata, or database backups, and are zeroed after signer construction. Database backups are unusable without the independently protected wrapping key.

This envelope implementation is a deployable foundation for the requested free localnet/devnet product, but the application process remains part of the custody trust boundary because it can unwrap a key. Before any broader or higher-risk deployment, replace the envelope adapter with a backend signer/KMS boundary that signs exact Ed25519 messages while preventing private-key export. Solana's current production guidance recommends backend signing or key-management services and lists Keychain integrations for memory, Vault, AWS KMS, GCP KMS, and other providers. HashiCorp Vault Transit is one concrete primary-source option with non-exportable Ed25519 signing and ACLs.

Expose a narrow internal interface rather than importing key files throughout the app:

```ts
interface ManagedSigner {
  address(keyRef: string): Promise<Address>;
  signMessage(keyRef: string, exactMessage: Uint8Array): Promise<Uint8Array>;
}
```

The transaction coordinator must independently verify every returned signature against the frozen message bytes and expected public key before assembly. A signer request includes command ID, deployment domain, message digest, expected address, operation type, and expiry; signer audit logs must not include secrets or session cookies.

### Role separation

Use distinct managed keys and policies for:

- participant custody accounts;
- the SOL fee/rent sponsor;
- enrollment authority;
- market creator/publisher;
- resolution proposer;
- resolution approver;
- permissionless keeper/cleanup worker;
- program upgrade authority.

The proposer and approver must remain distinct and must not trade in markets they review, matching the current program's terms and resolution constraints. The program upgrade authority should not be online in the normal web or worker runtime. A compromise of the sponsor must spend only devnet/localnet SOL and must not authorize feather movement. A compromise of one participant key must not expose other participants.

### Provisioning

Provision lazily at the first financial action, with an optional asynchronous warm-up after verified account creation:

1. Idempotently create `SolanaCustodyIdentity` with a unique deployment-domain constraint, sealing the generated key before it is written.
2. Return only its public identity DTO. A later account-provisioning record tracks enrollment readiness separately from custody material.
3. Verify the address and signer proof, then store the reference.
4. Submit issuer-authorized enrollment for a digest derived from the stable Goosey user ID and a deployment-specific secret/domain separator. Do not use email directly on-chain.
5. Create the feather ATA with `CreateIdempotent`; the sponsor pays account storage and the transaction fee.
6. Claim the user's free allowance with the managed user signer and sponsor.
7. Mark the account `READY` only after finalized account reads verify config, enrollment, identity, mint, ATA owner/mint, and claimed amount.

An ATA is deterministic for one owner, token program, and mint. Its storage payer may differ from both its owner and transaction fee payer. Use the Associated Token Program's idempotent creation instruction and query rent requirements rather than hard-coding them.

Key loss is an account-recovery event, not an instruction retry. The current program binds seats and enrollment to a wallet, so devnet keys require backed-up signer infrastructure. Before any broader deployment, add and test an admin-governed `rotate_custody_authority` path that moves the user's unlocked ATA balance and rebinds every market seat without altering economic totals. Until that exists, recovery is operationally limited and must be disclosed to administrators.

## Fee sponsorship and rent

The sponsor is the fee payer and funds ATA/account creation. The managed participant remains the authority signer for participant-owned instructions. Both signatures cover the same frozen message. This follows Solana's fee-sponsorship primitive: the sponsor pays SOL while the sender separately authorizes token movement.

Rules:

- Set the sponsor as fee payer before serializing or collecting any signature.
- Enforce localnet/devnet plus exact genesis and program IDs before signing and again before sending.
- Simulate with the same commitment used for preflight, but never treat simulation as execution.
- Cap compute-unit limits, priority fee, rent spend per command, and total sponsor spend per user/day.
- Allowlist program IDs, instruction discriminators, writable accounts, token mint, and derived PDAs in the coordinator and signer policy.
- Reject arbitrary recipient token accounts. Derive and verify the canonical ATA or program PDA internally.
- Alert on low sponsor balance, fee spikes, unexpected instructions, repeated failed signatures, and rent-account creation bursts.
- Never airdrop as part of a request path. Localnet bootstrap and devnet operator funding are separate operational jobs.

Failed transactions may still charge fees. Therefore a rejected on-chain instruction is a finalized command failure, not a reason to hide sponsor spend or endlessly retry.

## Transaction lifetime, idempotency, and recovery

### Normal requests use recent blockhashes

Server-side signing should normally finish well inside the recent-blockhash window. Use a finalized `getLatestBlockhash` response, retain its `lastValidBlockHeight`, freeze the complete message, sign it, persist the exact signed wire bytes, then submit. The only automatic retransmission is the identical signed wire transaction with the identical signature while that lifetime remains valid.

Do not use durable nonces as the default queue mechanism. They add a nonce account, a nonce authority, serialization pressure, and failure semantics in which the nonce advances even when program execution fails. Solana also documents that durable nonces may be deprecated in a future release. They are appropriate only for deliberately delayed/offline admin operations, if any, with one leased nonce account per in-flight operation and separate reconciliation.

### Three idempotency layers

1. **HTTP command identity.** Require the existing `Idempotency-Key`. Uniqueness is `(userId, routeScope, key)`. Store a canonical request hash; the same key with different content is `409`.
2. **Program replay guard.** Bind every participant mutation to the current on-chain seat nonce or a dedicated operation PDA. Existing order/deposit/withdraw builders already carry expected nonces. Extend transfer, claim, migration, and administrative operations with equivalent replay-safe identifiers where missing.
3. **Signed-transaction identity.** Persist the signature, message hash, signed wire bytes, blockhash/nonce information, last valid height, expected event fingerprint, and deployment domain before the first send. Re-sending the same bytes is safe; building a replacement is a new attempt under the same logical command only after the old signature is reconciled as finalized failed or definitely unable to land.

`sendTransaction` returning a signature is `SUBMITTED`, not success. A timeout is `UNKNOWN`, not failure. Poll `getSignatureStatuses` with history search and inspect `getTransaction`/program state when necessary. A recent blockhash passing `lastValidBlockHeight` proves the old bytes can no longer land now, but pruned history can still make the historical outcome uncertain. Never issue a new state-changing transaction solely because one RPC forgot an old signature.

### Command state machine

```text
ACCEPTED
  -> LEASED
  -> PREPARED
  -> SIGNED_AND_JOURNALED
  -> SUBMITTED | UNKNOWN
  -> CONFIRMED
  -> FINALIZED_SUCCESS | FINALIZED_FAILED
  -> PROJECTED

PREPARED may return to ACCEPTED after blockhash expiry because no signature was sent.
SIGNED_AND_JOURNALED never returns to PREPARED until reconciliation proves replacement is safe.
```

The public API may wait briefly for finalization and return a completed result, but it must fall back to `202 Accepted` with an operation ID rather than pretend an uncertain command failed. The existing UI should show a neutral “processing” state and poll the operation endpoint; it need not mention Solana.

## Data-model changes

Add equivalent models to both SQLite and PostgreSQL schemas and migration tests.

### `SolanaCustodyIdentity` and managed-account readiness

```text
SolanaCustodyIdentity:
id, userId, chainId, genesisHash, walletAddress
encryptionAlgorithm, keyVersion, keyId
encryptedSecretKey, encryptionNonce, encryptionAuthTag
createdAt, updatedAt

ManagedSolanaAccount (next provisioning layer):
id, custodyIdentityId, programAddress
status: PROVISIONING | READY | SUSPENDED | RECOVERY_REQUIRED
enrollmentAddress, identityAddress, featherAta
provisionedAt, verifiedSlot, createdAt, updatedAt
```

Unique constraints:

- `(userId, genesisHash, programAddress)`
- `(genesisHash, programAddress, walletAddress)`
- `(chainId, genesisHash, walletAddress)`

Ciphertext fields and key identifiers are sensitive operational metadata. The public DTO allowlists identity, user, domain, address, and creation time only.

### `ChainCommand`

```text
id, userId?, marketId?, operation, routeScope
idempotencyKey, requestHash, status, revision
genesisHash, programAddress, walletAddress?
expectedNonce?, expectedEventKind?, expectedEventHash?
messageHash?, signature?, signedWireBase64?
recentBlockhash?, lastValidBlockHeight?
attempt, leaseOwner?, leaseExpiresAt?, nextAttemptAt?
failureCode?, failureDetail?, finalizedSlot?, projectedAt?
createdAt, updatedAt
```

Use compare-and-swap revision/lease updates. Signed bytes are not private keys, but they are executable while valid; restrict access, integrity-protect them, cap their size, and never expose them through user APIs. Unique constraints cover `(userId, routeScope, idempotencyKey)` and `(genesisHash, signature)` when present.

### Projections

Keep the existing append-only `SolanaTransactionReceipt` and `SolanaProgramEvent`. Add explicit projection tables rather than writing financial truth back into `User.balanceMilli` or the legacy ledger:

- `ChainUserBalanceProjection`: finalized ATA amount, escrow cash, reserved cash, slot, event key.
- `ChainPositionProjection`: user, market, YES/NO holdings and reserves, realized reporting values, slot, event key.
- `ChainOrderProjection`: chain order ID, owner, status, remaining/fills, priority, slot, event key.
- `ChainFillProjection`: maker/taker identities, price, quantity, fees, signature/log index, finalized slot.
- `ChainMarketProjection`: lifecycle, book revision, volume, trader count, result, finalized slot.

Each projector write is idempotent by `eventKey`, transactional with its checkpoint, and rebuildable from the retained event journal plus canonical account reads. If coverage is partial, the API must expose stale/unavailable internally and fail financial mutations closed; it must not quietly merge legacy SQL balances.

### Execution epochs and migration records

Replace the single immutable backend flag with an append-only `MarketExecutionEpoch`:

```text
id, marketId, generation
backend: DATABASE | SOLANA
status: PREPARING | ACTIVE | SEALED | ABORTED
effectiveAt, sealedAt
snapshotDigest?, chainBindingId?
```

Only one epoch may be active. Legacy `Market.executionBackend` remains a temporary denormalized compatibility field until all callers use the active epoch. Add `MarketMigrationBatch` and `MarketMigrationItem` for exported snapshot digests, reconciliation totals, chain signatures, and operator approvals. Do not mutate today's backend trigger until the epoch migration, service routing, and rollback rules are in the same reviewed change.

After cutover, the legacy `Position`, `Trade`, `MarketOrder`, `OrderFill`, `OrderReservation`, `JournalEntry`, and `LedgerPosting` rows for a sealed database epoch are historical and immutable. New economic writes must be rejected at the database and service layers.

## Service boundaries

Introduce these server-only modules:

- `chain-account-service`: managed-account provisioning and verification.
- `chain-command-service`: canonical request hashing, idempotency, command creation, status reads.
- `chain-transaction-coordinator`: finalized snapshot reads, allowlisted message construction, simulation, exact-message signing, journal-before-send, and reconciliation.
- `chain-signer`: provider-neutral Ed25519 signing adapter.
- `chain-projector`: finalized event/account projections and rebuild tooling.
- `unified-market-repository`: metadata plus chain projection reads behind current view models.
- `chain-reconciler`: vault/seat/book/mint invariants, event gaps, and command/event correlation.

Do not call browser-oriented `prepare-*` helpers directly from route handlers. Extract their deterministic instruction builders and account validation into shared code, then implement server coordinators that use separate participant and sponsor signers. Keep browser wallet code during migration only for tests and rollback; it is not the target runtime.

Workers require database leases and fencing tokens. Run at most one active command for a given managed wallet/market nonce domain to avoid avoidable nonce races. Matching can change between preparation and execution; such program rejections are ordinary terminal command failures that the UI translates into a refreshed quote/order-book message.

## Existing-route cutover

The user-facing URL contract stays stable.

| Existing surface | Background implementation after cutover |
| --- | --- |
| `GET /api/markets`, discovery, search, calendar, events | Read all active markets through the unified repository; no `DATABASE_MARKET_FILTER`. |
| `GET /api/markets/[slug]` | Join SQL metadata with finalized chain market/book projection. Keep comments and creator metadata in SQL. |
| `POST /api/markets/[slug]/quote` | Return a short-lived, nonbinding quote from a finalized book snapshot and slippage limit. |
| `POST /api/markets/[slug]/trades` | Translate the simple buy/sell ticket into a sponsored IOC/FOK chain order under the managed user authority. |
| `GET/POST /api/v1/orders` | Read chain order projections; enqueue limit-order commands while retaining current validation and idempotency headers. |
| `DELETE/PATCH /api/v1/orders/[id]` | Enqueue owner cancellation/replacement against the canonical chain order ID and expected nonce. |
| order-book and trade-history endpoints | Read finalized projections, with freshness/coverage checked server-side. |
| `GET /api/portfolio` and history | Read managed ATA plus finalized chain position/order/fill projections. Never sum legacy and chain balances for the same active epoch. |
| feather transfers | Add an authenticated username/recipient endpoint that resolves both managed accounts server-side and submits a sponsored SPL transfer. Never accept a raw destination account from the browser. |
| admin market create/pause/close/resolve | Enqueue role-separated sponsored commands; retain SQL metadata workflows and audit logs. |
| comments/chat/watchlist/notifications | Unchanged except position badges use finalized projections. |
| leaderboard | Derive from finalized fills and projections; preserve profile visibility policy. |

The simple market ticket can remain visually unchanged. For former LMSR markets, it becomes an IOC/FOK order against a real funded liquidity-provider account. A market-making worker may compute LMSR-like quotes off-chain, but every quote must be represented by actual funded on-chain resting orders and remains subject to fills/cancellation. Goosey must not label the on-chain CLOB itself as LMSR.

### Removing the separate chain product

After the unified routes pass cutover gates:

1. Stop linking `/chain`, `/chain/markets/[marketId]`, `/leaderboard/chain`, and reviewer pages from navigation.
2. Redirect known chain market URLs to `/markets/[slug]`; unknown IDs return 404.
3. Remove wallet-connect UI, Wallet Standard code, and `/api/solana/wallet/*` challenges after an observation period.
4. Retain read-only internal health/readiness endpoints behind admin authorization; do not market “on-chain” as a separate product feature.
5. Remove `SolanaWalletLink*` only after no service references them and a migration preserves any audit data required for debugging. Managed accounts are not wallet links.
6. Keep explorer signatures in internal audit views. User responses may expose an operation ID but should not require explorer use.

## Migrating existing database markets

Historical resolved markets do not need their already-completed economics replayed onto a disposable chain. Preserve them as sealed database epochs and historical records. “All markets on-chain” should mean every market that can still accept, cancel, transfer, resolve, or settle value uses the chain. Rewriting history would create misleading transactions rather than stronger settlement.

For every open or unresolved market:

1. **Capacity audit.** Count distinct participants, live orders, and expected book depth. Block migration above 256 participants or 1,024 live orders until the program is scaled. Also verify all monetary values fit the program's `u64` units.
2. **Prepare chain market.** Create terms, book, resolution, reviewers, vault, and binding while the database epoch remains active. Do not expose it in the catalog.
3. **Provision participants.** Create managed accounts, enroll, create ATAs, claim/mint the reconciled free feather allocation, and register seats.
4. **Pause writes.** Set the market to maintenance, reject new quotes/orders/trades, drain workers, and wait for all database commands to become terminal.
5. **Cancel open orders.** Release all SQL reservations through the real legacy service. Do not copy resting orders with invented priority. Users may replace them after cutover; a designated market-maker may place new, genuinely funded liquidity.
6. **Freeze and reconcile.** Export canonical user cash, YES/NO holdings, fees, market collateral, and supply. Require a balanced legacy ledger, no pending settlement, and a deterministic signed snapshot digest.
7. **Import economic state.** Add a narrowly scoped, one-time migration instruction to a new program version. It accepts a committed migration root, initializes each registered seat's available cash and positions exactly once, and funds the market vault with matching minted free feathers. Every item is proof-bound to user, market, amounts, epoch, and genesis; aggregate counters must equal the committed snapshot before sealing. The instruction is disabled permanently after the batch is sealed.
8. **Verify independently.** Compare every seat, vault, collateral, fee total, mint supply, and snapshot leaf from finalized account reads. The indexer must observe complete coverage from before migration.
9. **Activate atomically in SQL.** Seal the database epoch, activate the Solana epoch, disable legacy financial writes, and enable existing routes against chain projections in one migration transaction.
10. **Observe.** Keep the database snapshot immutable for audit and rollback analysis. Once a chain command is accepted after activation, rollback means a new explicit epoch/migration—not switching the flag back.

The one-time importer is preferable to manufacturing trades against a privileged account: manufactured trades distort volume, cost basis, priority, and history. It also makes migration state distinguishable from normal market activity. Because assets have no real value, operators may choose to start with only newly created markets on chain while this importer is implemented, but they must not run both engines for one market.

## Threat boundaries and controls

| Boundary / failure | Required control |
| --- | --- |
| Stolen web session | Existing session, CSRF, verified-email and mutation checks; rate limits; reauthentication for transfers/admin actions; command binds user/session context and request hash. |
| Compromised web process | In the initial envelope design it is inside the custody trust boundary, so route handlers must never accept raw instructions and the coordinator must allowlist deployment, program, instruction type, amount/price limits, derived accounts, and command IDs. Isolating signing behind KMS removes plaintext-key access from the web process. |
| Compromised signer credential | Least-privilege identity, short-lived machine auth, per-role ACLs, per-user or derived-key isolation, audit logging, and emergency suspension. |
| Compromised sponsor | Sponsor can lose only capped local/devnet SOL; it cannot authorize participant token movement. |
| Malicious RPC / wrong cluster | Pin cluster, genesis hash, program ID, mint, config, account owners, executable bit, and finalized commitment before build and send; cross-check providers in devnet rehearsal. |
| Duplicate HTTP request | Canonical request hash plus unique idempotency scope returns the original command/result. |
| Ambiguous send | Persist signed bytes before send, query by signature, retransmit only identical bytes while valid, and never assume timeout means failure. |
| Worker crash / concurrency | Leases with fencing revision, one active wallet/market nonce lane, resumable state machine, no secret in job payload. |
| Indexer gap / pruned RPC history | Retained RPC/local ledger, explicit coverage boundary, fail-closed mutations, account reconciliation, and no claim of full history when unavailable. |
| SQL tampering | Chain accounts are economic authority; projections are rebuildable and event-keyed; reconciliation alarms on mismatch. |
| Chain/program bug | Local isolated-validator suites, arithmetic/property tests, capacity tests, upgrade rollback rehearsal, paused activation, and no mainnet path. |
| Custodial insider abuse | Separate signer/admin/reviewer duties, immutable audit events, two-person approval for migration/resolution/key recovery, and amount/rate caps. |
| Free-token sybil abuse | Existing verified account/invite policy, one enrollment identity per deployment, campaign/per-user on-chain caps, application rate limits. |
| Raw recipient injection | Resolve usernames to managed accounts internally and verify canonical ATA owner/mint. Never sign browser-supplied instructions. |
| Devnet reset | Genesis pinning makes the deployment unavailable; create a new execution epoch and explicit migration. Never silently reconnect old SQL projections. |

This design cannot be noncustodial without user-held keys. The security goal is therefore not “the server cannot trade for users”; it is “only authenticated, authorized, idempotent Goosey commands can cause the isolated signer to produce an allowlisted transaction, and every result is finalized, journaled, projected, and reconciled.”

## Localnet and devnet operating constraints

- Mainnet remains rejected in runtime configuration and CI. No mainnet URL, genesis, mint, or program ID is accepted.
- Localnet is the deterministic development and destructive-test environment. Retain its ledger from genesis when testing complete indexer history; a validator reset creates a new deployment domain.
- Devnet tokens are not real and devnet may reset. Public RPC endpoints are rate-limited and have no production SLA. Use a dedicated provider only if reliability is needed for a public demo, but continue pinning genesis and program identity.
- Faucet/airdrop behavior is bootstrap-only. Monitor and pre-fund the sponsor; never make user requests depend on faucet availability.
- Keep different localnet and devnet signer references. Never copy a local key into the devnet signer service or vice versa.
- Database snapshots and synthetic fixtures must not contain signer material. The existing development sandbox remains isolated from any public deployment.

## Phased implementation plan

### Phase 0: freeze the contract

- Record existing route response contracts and browser journeys.
- Add capacity/readiness reports for every current market.
- Decide which historical markets are sealed and which unresolved markets require migration.
- Make full event retention a launch requirement for a fresh localnet deployment.

Exit: documented inventory, no market silently exceeds program limits, and baseline tests pass.

### Phase 1: invisible managed accounts

- Add signer adapter, managed-account model, provisioning worker, sponsor, and role-separated service keys.
- Extract server-safe instruction/account validation from browser `prepare-*` modules.
- Provision test users and execute claim, transfer, seat, deposit, order, cancel, withdraw, and resolution entirely server-side.
- Keep all existing UI on the database engine.

Exit: no browser key or wallet is involved in a full isolated-validator lifecycle; signer audit and compromise tests pass.

### Phase 2: durable command pipeline

- Add `ChainCommand`, worker leasing/fencing, write-before-send journal, status endpoint, and exact-byte recovery.
- Integrate finalized status and expected-event verification.
- Add chaos tests for duplicate requests, worker crashes at every transition, RPC timeout after send, expired blockhash, stale nonce, malformed signer response, and reorg/confirmed disappearance.

Exit: no tested failure can duplicate a mutation or report unfinalized success.

### Phase 3: projections behind current APIs

- Add projector tables, rebuild tooling, coverage gates, and unified repositories.
- Point read-only staging versions of market, book, history, portfolio, leaderboard, and position badges at finalized chain data.
- Compare projected views with canonical account reads continuously.

Exit: projections rebuild deterministically and stale/gap conditions are visible and fail closed.

### Phase 4: newly created markets

- Make admin creation publish one chain market and normal SQL metadata record.
- Route existing simple trades and order APIs through `ChainCommand` for those markets.
- Add a funded liquidity-provider service for LMSR-like simple-ticket UX where desired.
- Remove public navigation to separate chain pages for these markets.

Exit: an email-only user can use the ordinary Goosey UI for the entire lifecycle and all economics finalize on localnet/devnet.

### Phase 5: migrate unresolved legacy markets

- Implement and audit the one-time snapshot importer and execution epochs.
- Rehearse pause/export/import/verify/activate/abort on a copy of the development sandbox.
- Migrate one low-activity market, observe, then migrate the remainder in bounded batches.

Exit: every mutable market has an active Solana epoch; legacy financial tables are write-protected.

### Phase 6: remove split/wallet product paths

- Redirect or remove `/chain` pages and wallet APIs.
- Delete browser signing dependencies once rollback no longer uses them.
- Keep admin health, release-readiness, reconciliation, and audit tools.

Exit: one product surface, no external-wallet prerequisite, no dual financial authority.

## Verification gates

Before declaring the background integration complete, require:

- full TypeScript, lint, unit, integration, Rust host/SBF, and actual-validator suites;
- real server-managed lifecycle tests for two or more users, crossed orders, partial fills, all time-in-force/STP modes, transfer, cancel, cleanup, close, YES/NO/VOID resolution, claims, and finalization;
- conservation: minted supply, user ATAs, market vaults, escrow cash, collateral, fees, and claims reconcile exactly;
- idempotency under parallel duplicate requests and crash/restart at every command state;
- negative tests for wrong user, session, signer, mint, genesis, program, market, nonce, recipient, reviewer, request hash, and stale projection;
- program-capacity boundary tests at 256 seats, 1,024 orders, and 16 touches, plus an explicit product response when capacity is exhausted;
- indexer rebuild from retained genesis and honest partial-coverage behavior when history is unavailable;
- visual/browser regression proving the same account, market, trade, order, portfolio, transfer, comment, leaderboard, and admin journeys work without wallet prompts or chain-specific navigation;
- a clean localnet reset/new-domain rehearsal and a separate devnet rehearsal with fresh dedicated keys;
- confirmation that no mainnet endpoint, value-bearing token, redemption promise, or cash bridge exists.

## Source basis

Primary sources consulted for this design:

- [Solana production readiness: key management, backend signing, RPC security, and monitoring](https://solana.com/docs/tools/production-readiness)
- [Solana fee sponsorship](https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction)
- [Solana fee structure](https://solana.com/docs/core/fees/fee-structure)
- [Solana transaction pipeline and replay/status-cache behavior](https://solana.com/docs/core/transactions/transaction-pipeline)
- [Solana partial signing and exact-message rules](https://solana.com/docs/core/transactions/partial-signing)
- [Solana durable nonce semantics](https://solana.com/docs/core/transactions/durable-nonces)
- [Solana `sendTransaction` semantics](https://solana.com/docs/rpc/http/sendtransaction)
- [Solana `getSignatureStatuses`](https://solana.com/docs/rpc/http/getsignaturestatuses)
- [Solana token accounts, ATAs, payer rules, and idempotent creation](https://solana.com/docs/tokens/basics/create-token-account)
- [Solana cluster and devnet constraints](https://solana.com/docs/references/clusters)
- [HashiCorp Vault Transit Ed25519 signing and ACL boundary](https://developer.hashicorp.com/vault/docs/secrets/transit)

Repository evidence consulted:

- `prisma/schema.prisma`
- `src/lib/market-backend.ts`
- `src/lib/order-service.ts` and `src/lib/order-exchange.ts`
- `src/lib/solana/*`, especially runtime, preparation, escrow, transaction-status, event-journal, ingestion, and projection readers
- `src/app/api/markets/*`, `src/app/api/v1/orders/*`, `src/app/api/portfolio/*`, and `src/app/api/solana/*`
- `chain/programs/goosey-exchange/src/*`
- the existing `docs/solana-*` research, program, migration, retention, catalog, and verification documents
