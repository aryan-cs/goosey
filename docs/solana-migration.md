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
