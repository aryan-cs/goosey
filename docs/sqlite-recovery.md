# Local SQLite backup and recovery

This procedure is for local SQLite installations, not PostgreSQL production
recovery. It requires `sqlite3` on PATH (SQLite 3.27 or newer), Node and installed
project dependencies. Backups contain private account/session data: store them
in a restricted, encrypted location and never commit, upload or share them.

## Create a snapshot

Choose explicit absolute paths. The output parent directory must already exist;
the output file must not exist. Example from this checkout:

```sh
npm run db:backup:sqlite -- --source /Users/aryan/Desktop/projects/goosey/prisma/dev.db --output /private/tmp/goosey-backup-2026-09-19.db
```

Use a unique output name each time. The command does not infer a database from
`.env`, does not overwrite previous backups, and does not modify the source's
logical data. It reports the final path, byte size and SHA-256 digest only after
integrity validation and publication. Save that digest separately if you need
to detect later archive corruption; it is not an authenticity signature.

The implementation uses [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html),
which produces a consistent snapshot including committed WAL data. Do not copy
only a live `.db` file: recent commits may still be in its `-wal` file. Snapshots
use database reads and disk space and can contend with application activity;
schedule larger backups at quiet times. A timeout fails rather than publishing
an unverified file. Incomplete staging files from a machine crash are not valid
archives and must not be selected for recovery.

## Rehearse a restore without touching the running app

1. Compare the archive SHA-256 with its saved digest.
2. Run the same command using the archive as `--source` and a **new**, absolute
   `--output` path. This creates a separate working copy and leaves the archive
   unchanged.
3. Compare logical records before opening the copy in a writing process:

```sh
npm run db:verify-restore:sqlite -- --source /private/tmp/goosey-backup-2026-09-19.db --restored /private/tmp/goosey-restored.db
```

   Require `status: matched`. This bounded, read-only local tool compares schema
   and table contents, including exact large integers, blobs and sequence state.
   It ignores internal SQLite statistics and has a 32 MiB output / 15-second
   per-query limit. Use quiescent archives/copies, not a changing live database.
   Logical matching does not require the two files' byte-level hashes to match:
   snapshotting may repack physical pages. This is not a large production
   database verification service.

4. Point an isolated process at the restored working copy, never the archive:

```sh
env -u POSTGRES_DATABASE_URL -u POSTGRES_DIRECT_DATABASE_URL \
  DATABASE_PROVIDER=sqlite DATABASE_URL=file:/private/tmp/goosey-restored.db \
  node --import tsx scripts/reconcile.ts
```

5. Require `ok: true`; investigate any discrepancy before using the copy. Run
   appropriate account, portfolio, order and settlement checks against the
   restored copy using the matching application/schema version. Database
   integrity alone does not establish that business balances are correct.

For an actual recovery, stop **both** the web process and settlement worker
before changing their database path. Preserve the old database and its WAL/SHM
files for investigation. Configure both processes to use the verified new path;
do not overwrite a running database or combine sidecar files from different
databases. Use a reviewed migration procedure if recovering to a newer schema.
Restart and verify readiness and reconciliation. This script deliberately does
not automate destructive replacement or production cutover.

## Verification and limits

`npm test` exercises real SQLite snapshots, including WAL data, large exact
values, existing-target refusal and concurrent publication. `npm run test:e2e`
also snapshots its running isolated app after account/trade/comment operations,
restores to a separate file, and runs accounting reconciliation.

These are local recovery checks. They do not establish a production retention
policy, encrypted off-host storage, PostgreSQL recovery, recovery point/time
objectives, or a completed disaster-recovery rehearsal.

On 2026-09-19, the full API journey's live snapshot and restored copy passed
reconciliation: 7 journals, 9 accounts, 2 participants, 5 markets. That journey
exercised market-maker trading; this particular restore did not contain resting
orders or order-book fills. Temporary archives were removed by the test cleanup.

The subsequent order-book recovery rehearsal also passed exact logical-record
comparison and reconciliation: 56 journals, 59 accounts, 13 participants, 6
markets, 29 orders, 29 reservations and 7 fills. Starting fixture funds are now
backed by journal postings rather than unjournaled balance caches. Reconciliation
independently compares reserved principal/fees with each order's escrow account,
including ownership, shared-account and orphan-cash checks. All rehearsal files
were disposable and removed by the runner after completion.
