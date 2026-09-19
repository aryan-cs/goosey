# Solana implementation track

User-confirmed scope, 2026-09-19: free feathers, **transferable** between users through real Solana transactions, never purchasable or redeemable for cash through Goosey. Develop on localnet/devnet only. No mainnet deployment, real-value collateral, fiat ramps, paid SOL purchase, or import of existing wallet secrets is authorized.

## Current state versus target

The existing website uses the Prisma exchange and journal ledger. It is **not on-chain**. Existing database orders, positions, fills and synthetic history must not be presented as blockchain transactions. This is a substantial exchange implementation and integration, not a payment-provider toggle.

Polymarket's current [trading overview](https://docs.polymarket.com/trading/overview) describes signed CLOB orders and Polygon settlement, while its [quickstart](https://docs.polymarket.com/trading/quickstart) explicitly waits for asynchronous on-chain settlement after matching. Its [contract registry](https://docs.polymarket.com/resources/contracts) identifies Polygon, not Solana. Goosey's requested fully on-chain Solana order book goes beyond copying that hybrid architecture.

Target responsibilities:

- SPL feather mint with three decimals, user-owned associated token accounts, explicit wallet-authorized transfers. Transfers move existing supply; they do not award new feathers. No cash-out instruction or bridge to money.
- Program-controlled issuance under capped, one-time enrollment authorization. Creating a second wallet must not automatically produce a second participant grant. Identity eligibility is an explicit off-chain trust boundary; opaque hashes, not email addresses, belong on-chain.
- Real on-chain market state, price/time ordering, escrow, complete-set backing, fills, cancellations, expiry, bounded matching, fees, independent result approval, and redemption **to feathers**, not money.
- Signed wallet transactions; no server possession of participant private keys. Any optional fee sponsor has a narrow budget and instruction allowlist rather than unrestricted signing.
- The database becomes an index/read model for chain-backed financial state. It may still own comments, moderation, account preferences and search. No dual-write that spends both a database balance and a token balance.
- Explicit submitted/confirmed/finalized/failed/expired/unknown states, chain identity pinning, recovery from uncertain submission, and event replay/reconciliation. Submission is not settlement.

Transferability does not make a promise about third-party behavior: Goosey does not offer monetary value or redemption, but cannot guarantee no one attempts an external trade. Localnet/devnet assets and no mainnet mode keep this development scope explicit.

## Implemented foundation

- `src/lib/solana/runtime.ts`: explicit localnet/devnet configuration; local loopback and devnet TLS constraints; pinned genesis; read-only finalized executable-program probe. The probe deliberately returns `exchangeVerified: false`: connectivity is not exchange readiness.
- `src/lib/solana/feather-transfer.ts`: exact u64 base-unit parsing and actual SPL idempotent recipient-account creation plus `TransferChecked` instruction construction. This does not sign or submit transactions by itself.
- Solana Kit 8.3.0 and compatible generated Token/System clients pinned in npm; Node minimum 20.18.0 matches Kit.
- Unit tests distinguish instruction/configuration checks from real chain execution. A successful unit test is not a deployed program or completed wallet journey.
- `npm run test:chain:tokens` now executes real transfers using the application helper on a pinned loopback validator. Two independent runs passed recipient ATA creation/reuse, exact-wire replay, invalid decimals/mint/authority/signature, insufficient balance, atomic rollback, and supply conservation. This proves SPL transfer integration, not the custom exchange program or website wallet flow.
- The custom Anchor foundation is now compiled and deployed locally. Its initialize/enroll/claim suite and transfer of program-issued feathers passed against actual chain accounts. [Program artifact and transaction evidence](solana-foundation-qa.md) records the limits: on-chain matching, escrow runtime, oracle, and website integration remain unfinished.
- Browser-compatible program instruction builders and server-side Ed25519 wallet-challenge verification have unit coverage. The challenge verifier is **not** a complete login/link endpoint: durable nonce storage and atomic one-time consumption are required before exposing it.
- `configuration.ts` reads config and mint in one finalized RPC snapshot after genesis/deployment checks, verifies canonical PDAs/domain/owners/authorities/precision/caps, and preserves exact bigint counters. Its 23 codec tests pass; an independent read against the deployed local program verified slot 1919, 2,000,000 authorized base units and 1,000,000 minted/supply. Burning can reduce supply but never resets issuance. This read deliberately still reports `exchangeVerified: false`.
- `prepare-transfer.ts` prepares an unsigned user-funded wallet transaction after verifying chain configuration, the finalized sender ATA balance/owner/mint/state, and a fresh network-bound blockhash. It has 15 mocked-RPC contract tests. It does not sign, submit, sponsor fees, or silently replace uncertain transactions; browser signing and runtime coverage of this higher-level preparation flow remain separate gates.
- The expanded real-validator suite passed 53 instruction cases, including the shipping escrow builders and finalized reader. Deposit/withdrawal, nonce replay, authority/account substitution, failed-CPI rollback and donation surplus are now covered. Matching and payout remain unimplemented integration gates; see [escrow evidence](solana-foundation-qa.md#escrow-execution-follow-up).
- `GET /api/solana/status` exposes only verified public network/mint/cap fields, never the private RPC URL or raw provider errors. It reports `disabled` when chain configuration is absent and `foundation_verified` only after finalized reads. Both explicitly retain `financialBackend: database` and `exchangeVerified: false`. The Next.js route was checked through localhost for the disabled state and directly against the real configured validator for the verified state.
- Durable wallet-link service and twin SQLite/PostgreSQL migrations are implemented. Real disposable SQLite tests cover one-time session-bound consumption, concurrent consumers, conflicts/rollback, expiry and unchanged balances/journals. Public route integration and deployed database upgrades remain separate gates; linking itself never grants feathers or authorizes spending.
- `submit-transfer.ts` verifies the wallet's exact message and Ed25519 signature, pins the network again, records the signed receipt through a required caller callback, and performs one preflight-enabled submission. Transport ambiguity returns `unknown` with the original signed bytes/signature, not an automatic replacement or settlement claim. Ten real-signature/mock-RPC tests pass. Preparation and submission also passed independently on a real isolated validator; browser receipt persistence remains pending.
- Authenticated wallet APIs now provide `POST /api/solana/wallet/challenge` (`{walletAddress}` → `{id, challenge}`), `POST /api/solana/wallet/verify` (`{challengeId, challenge, signedMessageBase64, signatureBase64}` → `{wallet}`), and `GET /api/solana/wallet` (`{items}` for the current user/genesis). POSTs require canonical origin, verified chain configuration, rate/body limits, and a current session; responses are private/no-store. Seventeen route contract tests pass, including production HTTPS enforcement. `npm run test:chain:wallet-api` independently passed real direct-handler integration with disposable SQLite, actual cookie auth/Ed25519 signatures, and read-only pinned local RPC at finalized slot 4023. Replay, user/session/origin isolation, signature failures, conflicts, disabled/network errors, and unchanged database economics are verified. This is not HTTP-server or browser-extension proof.
- The bounded matcher has 24 independently rerun host tests, including 2,000 differential commands, and a separate benchmark program measured on an isolated validator. A 1,024-order book used 10,334 CU for one fill, 128,672 for eight, and 381,066 for sixteen. These observed stress measurements are not an exhaustive CU bound and exclude the still-pending real-seat/escrow adapter. The matcher is not wired into the deployed Goosey program yet.
- `transfer-receipts.ts` supplies the write-before-send callback with an immutable local recovery journal, scoped by network/genesis/program/wallet and keyed per signature. It verifies the stored transaction's actual Ed25519 signature, refuses conflicting writes, and reports corrupt records without deleting them. Nine signature-backed storage-port tests cover reload recovery, separate-record writes, wrong-wallet/tampered-wire rejection and quota failure. Wiring it to browser storage and exercising an actual browser reload remain pending. Stored signed bytes are recovery evidence, not confirmation, and no recovery operation automatically sends or re-signs.

The public website has not switched financial authorities. Do not turn on an on-chain badge, publish fabricated transaction signatures, migrate balances by directly editing program accounts, or declare completion from these foundation checks.

## Configuration

`npm run chain:preflight` is read-only. Supply:

```text
GOOSEY_SOLANA_CLUSTER=localnet
GOOSEY_SOLANA_RPC_URL=http://127.0.0.1:18999
GOOSEY_SOLANA_PROGRAM_ID=<actual deployed Goosey program address>
GOOSEY_SOLANA_GENESIS_HASH=<actual genesis hash of this validator>
```

For devnet, use an HTTPS endpoint and the fixed devnet genesis identity; the code does not support mainnet. Never put RPC provider secrets in public frontend configuration. Local validator resets change genesis and invalidate old accounts/signatures; do not silently reconnect stale cached state.

## Completion gates (pending until evidenced)

1. Compiled real program with a reviewed instruction/account interface and checked integer arithmetic; no fake accounts standing in for executed lifecycle operations.
2. Local-validator execution: initialization, enrollment, mint/transfer, market creation, deposit/withdrawal, matching, cancel/replace, expired/IOC/FOK/post-only orders, resolution, and feather redemption.
3. Conservation and isolation: wallet + vault + fee balances reconcile with supply; positions remain collateralized; retries cannot duplicate grants/fills/redemptions; wrong mint/owner/market/network/signature and unauthorized instructions fail atomically.
4. Wallet/account linking, transfer form, market trade ticket, portfolio, admin actions and explorer links use actual chain state, including rejected signing, dropped/expired transactions and RPC failures.
5. Finality-aware indexer with persisted cursors, replays, restart recovery, stale-state handling and independent reconciliation. Off-chain result evidence is documented with its authority and challenge policy.
6. Repeatable local runner and CI program/runtime tests; explicit devnet rehearsal only with test assets and fresh dedicated keys. No production-readiness claim from a localhost pass.

References: [Solana token transfers](https://solana.com/docs/tokens/basics/transfer-tokens), [atomic transactions](https://solana.com/docs/core/transactions), [Anchor local validator workflow](https://www.anchor-lang.com/docs/quickstart/local), and [compiled-program VM testing](https://www.anchor-lang.com/docs/testing/litesvm).
