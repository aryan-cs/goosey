# Finalized chain event journal

The journal is a derived record of chain transactions, not a financial ledger.
It never credits application balances, matches orders or pays settlements.

`readFinalizedProgramEvents` requests finalized RPC receipts, validates the exact
signed wire transaction, verifies Ed25519 signatures, bounds and attributes
logs, pins genesis and verifies the current program/configuration/mint snapshot.
This trusts the configured RPC's execution and consensus reporting; it is not a
light-client proof or a historical program-binary attestation. Configuration
slot records a current observation, not account state at transaction execution.

Terminal results distinguish success, failed execution, and a transaction that
loads but never invokes the program. Failed transactions produce no events.
Successful transactions with no events still receive a durable receipt.
Missing/pruned history, unknown successful event layouts, truncated logs and
inconsistent metadata stop ingestion instead of silently advancing coverage.

`ingestFinalizedProgramTransaction` reads before beginning a serializable
database transaction. `persistFinalizedProgramReceipt` inserts a receipt and
all events atomically and can also participate in a future page transaction.
Replay compares immutable payloads and metadata exactly; conflicting history is
an error, never an overwrite. Bigint event values remain decimal strings,
including u64 values exceeding SQL signed BIGINT. Slots must fit nonnegative
signed BIGINT. Later configuration snapshots do not rewrite the first record.

The three models exist in both Prisma schemas. Their only foreign key is
event-to-receipt; no user or application-market record is required. SQLite uses
the additive `20260919220000_solana_event_journal.sql` manual upgrade; PostgreSQL
has the matching Prisma migration. **Neither has been applied to shared or
participant databases by this development change.** Follow the existing backup
and maintenance procedure before enabling an ingestion worker.

`ingestFinalizedProgramPage` now implements bounded signature discovery, verified
receipt reads and atomic journal/cursor commit. It freezes a window head, walks
backward to an explicit inclusive coverage boundary (or the previous head), and
only advances the committed head when that boundary is verified. Up to four
receipt reads run concurrently; any failure aborts and awaits sibling reads,
without persisting part of the page. Cursor compare-and-swap rejects concurrent
or stale page commits. A new `SolanaIngestionVisit` table records per-window
membership, so same-slot cross-page cycles are rejected after a restart without
mistaking independently pre-ingested receipts for repeated scan entries.
Its second additive migration is `20260919230000_solana_ingestion_visits` in
both providers; the previously published journal migration is unchanged.

After both reviewed upgrades are applied and explicit database and Solana
environment variables are configured, run:

```sh
npm run chain:index -- --coverage-start=SIGNATURE --page-size=25
```

Default execution processes one page and exits. `--continuous` resumes saved
progress until stopped, suppresses repeated idle logs, and exits on verification
or history failures instead of skipping them. No migrations, chain transactions
or financial writes occur in this command. No worker has been enabled against
the shared application database by this change. Missing history is never proof
of completed backfill; same-slot signatures are not execution-order evidence.

Verification includes actual disposable SQLite persistence/rollback tests and
bounded reader unit tests. The compiled-program exchange suite also verifies
seven actual finalized receipts against executed grants, escrow movements,
orders and fills, including a failed FOK with zero published events. These are
decoder runtime checks. A subsequent actual RPC-to-journal run retained all
153 exchange cases and persisted seven finalized receipts/seven events into a
private SQLite database. Reopening Prisma and replaying all seven inserted
nothing new; the failed FOK remained VERIFIED_FAILED with no events. Evidence:
`/tmp/goosey-solana-runner-pYjucL`, genesis
`4f43GrZKe91u7SYh2d8NY4FrYgV9hPMWTDQoKcYz64si`, compiled artifact SHA-256
`d2f3e57d090ab54369068a450c9f2d2f9b4bf6e629a06eb826672d824c770a82`.
SQLite integrity and foreign-key checks passed after the run. This is a
single-transaction ingestion/reopen proof, not the scanner's whole-window
runtime proof or an operating-system crash durability proof. Scanner runtime,
browser integration and web financial backend cutover remain unfinished.
