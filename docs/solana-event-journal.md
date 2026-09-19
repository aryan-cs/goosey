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

The cursor schema is preparation, not a running scanner. Do not advance a head
after ingesting one transaction. A scanner must freeze a signature window,
include an explicit initial coverage boundary, walk signature pagination (not
slot alone), and commit page receipts plus cursor revision atomically. Missing
history must not be mistaken for completed backfill. Same-slot signatures do
not establish transaction execution ordering for future financial projections.

Verification includes actual disposable SQLite persistence/rollback tests and
bounded reader unit tests. The compiled-program exchange suite also verifies
seven actual finalized receipts against executed grants, escrow movements,
orders and fills, including a failed FOK with zero published events. These are
decoder runtime checks; full RPC-to-journal runtime integration and a resumable
scanner remain separate pending gates. Browser integration and web financial
backend cutover are also unfinished.
