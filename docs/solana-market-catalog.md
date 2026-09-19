# Chain market catalog boundary

`Market.executionBackend` is immutable: existing markets default to `DATABASE`.
Database markets retain required SQL collateral accounts; `SOLANA` markets have
no SQL collateral account. A chain catalog entry must be inserted atomically with
its immutable `SolanaMarketBinding` (cluster, full genesis, program, canonical
market address and decimal u64 chain-market ID). The shared Market identity keeps
comments and watchlists usable without manufacturing a second financial ledger.

These fields describe execution authority, not a cached spendable chain balance.
Never convert an existing database market or user balance into chain credit.
SQL constraints reject unknown backends and inconsistent collateral. Binding
identity is unique per deployment and cannot be updated or deleted/replaced.
Creation must verify real finalized chain accounts and the exact retained terms.

## Migration evidence and status

The reviewed `20260919233000_market_execution_backend` SQLite migration rebuilds
Market inside one immediate transaction, preserves all old columns, validates
recognized column/FK/index metadata, and checks row counts plus bidirectional
EXCEPT before replacing the table. Thirty-one disposable SQLite tests cover
preservation, schema drift, rollback, backend/collateral checks and immutable
bindings. The matching PostgreSQL migration is present but has **not** been run
against a live PostgreSQL server.

Local rehearsal used a verified copy of the actual development database and
compared every old column in all 38 tables in both directions: no changed rows.
A warm legacy Prisma connection read identical 19-market results after migration
and subsequently executed a write statement. A held Prisma transaction caused
the attempted migration to refuse with database-locked, without partial changes;
the rehearsal succeeded after that transaction ended.

The local development database was then upgraded on 2026-09-19 under SQLite's
bounded immediate writer lock while the application remained running in WAL mode.
This was a specifically rehearsed local path, not a general zero-downtime promise;
use stopped writers for deployments without equivalent compatibility evidence.
Backup: `/Users/aryan/.local/share/goosey-backend-upgrade-HbX0tC/live-before.sqlite`,
SHA-256 `37fad12dbe9cf9dcf50c3c448011cbcd367dc5cbd576b29eb8e5797e973bc386`.
Integrity/FK checks passed. All 19 existing markets remain DATABASE, and user
balances and ledger-account rows matched the backup in both directions. HTTP8080
remained healthy. No SOLANA catalog entries were created.

**Do not enable chain catalog creation yet:** financial service guards, catalog
registration and chain-aware UI integration remain in progress. Regenerate clients
only after the database upgrade; nullable collateral must never reach a legacy
financial service without explicit DATABASE validation and type narrowing.

## Registration service

`registerSolanaMarket` now verifies a real complete finalized market snapshot and
sealed two-reviewer terms, then loads the exact retained manifest against that
snapshot. It rechecks genesis, preserves u64 IDs as strings and rejects timestamps
outside JavaScript/SQL catalog representability. Active administrator status is
checked both before RPC work and inside the insertion transaction.

Catalog title, resolution rules, source URLs, payout, fee and times come from the
verified market/manifest. Slug, short title, description and category are explicit
editorial metadata. The service atomically inserts a hidden DRAFT SOLANA Market,
its canonical binding, and an audit record. `acceptingOrders` is false and SQL
collateral is null; no financial delegates are called. Repeating identical
registration returns the existing entry. Different metadata or unique-identity
conflicts are rejected, never adopted or overwritten. Registration does not
publish, deploy or sign anything and is not yet exposed through a public route.

Twenty orchestration tests cover authorization, full publication prerequisites,
network/errors, exact values, idempotency and conflicts using explicitly mocked
chain/store boundaries. Real SQL rollback and full chain-to-catalog runtime
verification are separate gates; unit fixtures are not deployment evidence.
# Administrator HTTP registration

`POST /api/admin/solana/markets` accepts only a canonical unsigned-u64
`chainMarketId` string and `metadata` containing `slug`, `shortTitle`,
`description`, and `category`. It requires the existing active administrator
session and same-origin mutation checks. Requests are bounded JSON and limited
to ten per administrator per minute. Neither actor identity, runtime, terms
directory, balances nor publication status may be supplied in the JSON.

The server requires all four explicit Solana runtime variables and
`GOOSEY_SOLANA_TERMS_DIRECTORY`. It revalidates the session and administrator
privilege before RPC work and again inside the catalog write transaction.
Revocation during the RPC/manifest checks therefore prevents the write.
An exact existing identity/metadata replay returns 200; a new draft returns 201.
Conflicts return 409. Responses are private/no-store and expose only catalog
identity, visibility, execution backend and the canonical public chain binding.

This endpoint does not deploy or activate a program market, sign a transaction,
open a public listing, create collateral, or convert database feathers. Financial
operations remain exclusively in the market's immutable execution backend.
