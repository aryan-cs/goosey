# Local on-chain market bootstrap

This operator creates one durable, genuine Goosey market on the retained Solana
local validator used by `localhost:8080`. It does not seed a database balance,
order, fill, position or probability. The participant receives feathers through
the Goosey program's real enrollment and SPL-token claim instructions, then
registers a real market seat and deposits real SPL feathers into program escrow.

The workflow is deliberately constrained to the already-running retained ledger
at `http://127.0.0.1:20999`. It verifies that ledger's retained genesis, deployed
program/config admin and enrollment authority before any mutation. It cannot be
pointed at devnet, testnet or mainnet and never starts, resets or replaces the
validator.

## What is retained

The new bootstrap state directory is created with mode `0700`. It contains three
dedicated local-only keys (two independent reviewers and one participant), an
immutable deployment/market record, and exact signed-wire receipts for local SOL
fee funding, reviewer acceptances, the participant feather claim, seat
registration and escrow deposit. Existing enrollment and publication operators
retain their own exact receipts. Keys and signed wire bytes are never logged.

If a finalized enrollment account exists after an interrupted enrollment command
but its signed receipt is unavailable, resumption does not replace or resend it.
It verifies both program-owned enrollment PDAs byte-for-byte and retains an
explicit state-recovery record that discloses the missing transaction receipt.

The creator is the retained localnet admin key and enrollment is performed by the
separate retained enrollment-authority key. Creator, both distinct reviewers and
the participant receive independent on-chain enrollments. Only the participant
claims feathers. Local transaction-fee SOL is transferred from the retained
localnet admin; no faucet or public network is contacted.

Canonical terms ask whether this exact HTN-themed market records a matched Goosey
trade before close. The two reviewer keys submit separate real acceptance
transactions before the creator can seal terms and initialize resolution. The
participant is then registered and deposits half of its claimed balance. No fill
is manufactured: the first match must come from later real orders.

The configured serving terms directory must be the same private directory used by
the localhost app. After activation, the finalized program history is indexed
from the creator-enrollment receipt boundary. The shipping catalog service first
registers a verified SOLANA draft and then publishes that same entry. Both actions
require the supplied existing active admin user and preserve the SQL/chain finance
boundary.

If the application database already has a different immutable coverage boundary
for this deployment, the bootstrap preserves it and reports
`retain-existing-boundary`; it does not reset or silently advance indexer coverage.
The market is still registered from verified chain state. Its activity surfaces
remain explicitly partial until an operator establishes a new audited coverage
policy.

## Safe run command

Do not run a second copy concurrently. Do not delete a receipt after an ambiguous
stop. Rerun this exact command to reconcile and resume:

```sh
NODE_ENV=development \
DATABASE_PROVIDER=sqlite \
DATABASE_URL='file:./dev.db' \
node --import tsx scripts/solana-local-development-bootstrap.ts run \
  --operator-directory /Users/aryan/.local/share/goosey-localnet-20260919 \
  --state /Users/aryan/.local/share/goosey-local-market-bootstrap-20260919 \
  --terms-directory /Users/aryan/.local/share/goosey-market-terms-20260919 \
  --actor-user-id goosey-market-publisher-v1
```

Run it from `/Users/aryan/Desktop/projects/goosey`. The state path must not exist
on the first run; its parent must already be canonical. The terms store must
already exist, be owned by the current user and have mode `0700`. The active
database is never reset or migrated. An existing catalog identity/metadata
conflict, changed genesis, exhausted issuance cap, missing history, uncertain
receipt, or incomplete reviewer acceptance stops safely for inspection.

The final log includes only the local cluster/RPC, public market ID, catalog slug
and participant public address. It never includes any private key or signed wire.

## Internal-custody retained-localnet matched trade

After the primary bootstrap reports `goosey_local_market_ready`, a separate
resumable companion can create the first real match:

```sh
NODE_ENV=development \
DATABASE_PROVIDER=sqlite \
DATABASE_URL='file:./dev.db' \
node --import tsx scripts/solana-local-matched-trade-bootstrap.ts run \
  --operator-directory /Users/aryan/.local/share/goosey-localnet-20260919 \
  --market-state /Users/aryan/.local/share/goosey-local-market-bootstrap-20260919 \
  --trade-state /Users/aryan/.local/share/goosey-local-matched-trade-20260919
```

This is internal custody/relayer infrastructure, not user wallet UX. Users do
not connect Phantom or handle these keys. The private operator owns the two
local-only participant signers and is responsible for access control, signing
policy, and secure key storage. Nothing in this companion should be exposed as
a browser wallet flow.

The primary bootstrap reserves issuance capacity for five equal grants: its four
creator/reviewer/participant actors and one additional matched-trade
counterparty. The companion reuses the primary dedicated participant as maker
and creates an independent, dedicated counterparty. It then performs actual
chain operations in order:

1. Funds only the counterparty's local transaction fees from the retained-localnet admin.
2. Enrolls the counterparty through the configured enrollment authority and claims its real SPL feathers.
3. Registers a real market seat and deposits three quarters of its claimed feathers into the market vault.
4. Freezes a one-time trade plan only after proving both dedicated seats and the full order book are pristine.
5. Signs and submits a post-only 10-contract YES bid at 400, then a complementary IOC NO buy at 600.
6. Verifies both finalized seats received their respective positions and that the matched orders no longer rest.

Every transaction's exact signed wire bytes are written with exclusive creation
before submission. On rerun, the companion reconstructs and verifies the exact
message and signature; observed state without its retained receipt is a hard
failure. It never resets or starts a validator, switches cluster, recreates an
ambiguous transaction, or inserts balances, orders, fills, or positions into
SQL. Keep the trade-state directory private and never delete a receipt to force
progress.

The companion deliberately does not update the shared indexer cursor. Indexing
is a separate backend concern whose retained-history coverage policy must be
resolved independently; a successful custody proof must not silently redefine
or overstate that coverage.
