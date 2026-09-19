# Goosey architecture

## Document status

This file separates **current repository facts** from the **target production architecture**. Unless a section explicitly says “current,” it is a design requirement and must not be interpreted as implemented.

## Current repository

The checked-in working local, single-process implementation contains:

- `package.json` with Next.js 16, React 19, Prisma 6, TypeScript, Zod, Recharts, `bcryptjs`, and Vitest dependencies.
- `DATABASE_PROVIDER` selects separate generated SQLite or PostgreSQL Prisma clients. Local non-production use defaults to SQLite; production requires an explicit provider and matching URL. The PostgreSQL twin uses explicit `timestamptz(3)` timestamps, strict parity checks, a checked-in migration, and an opt-in live smoke/concurrency runner.
- `next.config.ts` with baseline response headers and a development-compatible Content Security Policy.
- `.env.example`, TypeScript, and ESLint configuration.
- `src/lib/market-maker.ts` and `src/lib/trading.ts` with legacy LMSR pricing, quote storage, transaction/idempotency logic, executable valuation, and application-level journal balancing.
- `src/lib/order-book.ts`, `src/lib/order-book-pricing.ts`, and `src/lib/order-book-accounting.ts` with deterministic price-time matching, exact binary normalization, market marks/depth sweeps, reservation calculations, fill classification, and balanced fill-journal plans. The additive database schema and versioned read APIs are present; transactional order placement is still being integrated.
- registration/login/logout/session-management/current-user, editable profile, health, market/history, slug quote/trade/complete-set redemption, comment/reply/report, portfolio, canonical opt-in leaderboard, watchlist, suggestion, notification, participant-invitation, and admin market/moderation APIs.
- server-rendered home, market browse/detail, portfolio, community, leaderboard, search, rules, login/signup, suggestions, private-by-default public-profile views, dedicated watchlist, persisted notification/account, and admin pages.
- request-hash idempotency for trades and comment creation; one-level comment replies with ownership-checked edit/tombstone delete and a report queue.
- canonical open-position valuation by complete-set value plus executable LMSR liquidation value; leaderboard P&L subtracts each account's persisted welcome-grant journal.
- `scripts/api-e2e.sh`, `scripts/settlement-e2e.sh`, `scripts/settlement-worker.ts`, `scripts/visual-qa.sh`, `scripts/reconcile.ts`, and desktop/mobile QA screenshots under `output/playwright/`.
- thirteen unit test files with 112 passing tests and one intentional skip at the time of this documentation update, plus an isolated real-database CLOB integration runner.

Local verification includes `npm run check`, isolated API/order-book/settlement E2E suites, worker-readiness tests, and `npm run reconcile` against the seed database. CI runs those SQLite checks plus lint, typecheck, production build, provider-contract tests, and the offline PostgreSQL schema/migration contract. Reconciliation queries persisted journals, postings, account/user caches, market/position totals, non-negative accounts, and open-market collateral; it does not cover every business reference/settlement/leaderboard invariant and reuses the production collateral helper. Email verification and password reset are implemented with environment-configured SMTP. A continuous settlement worker records durable liveness/readiness state, closes elapsed markets, and processes only already-approved settlement runs, but production process supervision remains external. PostgreSQL runtime selection, a generated provider-specific client, strict parity checks, reproducible migrations, startup probing, and an opt-in live smoke/concurrency runner are present; hosted CI does not execute the live PostgreSQL suite, and realtime push plus a production deployment definition remain absent. Complete-set redemption is atomic and journaled. Admin resolution requires an evidence-bearing proposal and approval by a distinct eligible administrator with fresh-password step-up, creates an immutable settlement run, and processes positions in lease-fenced batches of at most 100 before exact final reconciliation.

## Target system context

```text
Browser/PWA
    |
    | HTTPS + secure server-side session + CSRF token
    v
Next.js web/API service
    |-- authentication and authorization
    |-- market reads and comments
    |-- quote/trade transaction service
    |-- admin and moderation service
    |
    +---- PostgreSQL (authority: users, ledger, markets, positions, trades)
    +---- Redis (distributed limits, ephemeral fan-out; never financial authority)
    +---- SMTP provider (verification and recovery)
    +---- worker process (outbox, settlement batches, snapshots, reconciliation)
    +---- observability (redacted logs, metrics, traces, alerts)
```

PostgreSQL is the source of truth. Caches, browser state, WebSocket messages, charts, and leaderboard snapshots are projections that can be rebuilt.

## Money and market model

### Exact units

- Store all feather amounts as signed 64-bit integer **milli-feathers**.
- `1 feather = 1,000 milli-feathers`.
- A winning binary contract pays `100 feathers = 100,000 milli-feathers`.
- Quantities are whole contracts in the first release.
- JavaScript `number` is not authoritative for balances, fees, costs, collateral, or settlement. Serialize 64-bit values as decimal strings across JSON boundaries and perform exact integer/decimal math on the server.

The current Prisma schema uses `BigInt` for monetary fields and `Int` for quantities, but it has not yet added the complete database checks described here.

### Coexisting market engines

`Market.pricingModel` selects exactly one engine. Existing seeded markets are `LMSR`; new order-book markets are `ORDER_BOOK`. An active market is never converted in place, and the two engines never execute against the same market. The complete CLOB contract, accounting invariants, API plan, lifecycle barrier, migration strategy, and release gates are in [ORDER_BOOK_ARCHITECTURE.md](./ORDER_BOOK_ARCHITECTURE.md).

### Legacy automated market maker

The current seeded markets use a binary logarithmic market scoring rule (LMSR):

```text
C(qYes, qNo) = b * payout * ln(exp(qYes / b) + exp(qNo / b))
P(YES) = exp(qYes / b) / (exp(qYes / b) + exp(qNo / b))
```

Use stable log-sum-exp and a pinned arbitrary-precision decimal implementation. Convert only the final result to integer milli-feathers:

```text
buy gross  = ceil(C(after) - C(before))
sell gross = floor(C(before) - C(after))
fee        = ceil(gross * feeBps / 10,000)
```

Rounding favors the collateral pool. A displayed marginal probability is not a quantity-specific execution price; each order requires a short-lived quote and a user-provided maximum debit or minimum credit.

Initial market subsidy is `ceil(b * payout * ln(2))`. The collateral requirement after every mutation is:

```text
collateral balance >= payout * max(qYes, qNo)
```

The present repository has two LMSR-related modules and unit vectors, but it uses JavaScript floating-point internally before conservative integer rounding and does not include an arbitrary-precision decimal dependency. A local seed subsidy exists; production-grade subsidy provenance and database-level invariant enforcement do not.

### Complete sets and resolution

One YES plus one NO contract can be redeemed for exactly one contract payout before resolution. Redemption reduces both position and market quantities atomically and transfers the payout from market collateral to the user.

Resolution payouts are:

- YES: `payout * yes quantity`
- NO: `payout * no quantity`
- VOID: `payout / 2 * (yes quantity + no quantity)`

Settlement must be idempotent and resumable in deterministic user batches. Each `(marketId, userId)` can be settled once. Any collateral remaining after verified completion returns to treasury through a journal entry.

## Ledger model

`JournalEntry` and `LedgerPosting` are intended as an append-only double-entry ledger. `LedgerAccount.balanceMilli` and `User.balanceMilli` may exist only as transactionally maintained projections; postings are authoritative.

Positive postings credit an account and negative postings debit it. Each posted journal entry must sum to zero. Required accounts include user feathers, market collateral, protocol revenue, treasury, and issuance. `allowsNegative` is reserved for explicitly defined system contra-accounts; user and market accounts may not be negative.

### Non-negotiable invariants

Every transaction and every reconciliation run must prove:

1. Each posted journal entry sums exactly to zero.
2. Posted entries and postings are immutable; corrections use compensating entries.
3. Cached account balances equal the sum of posted postings.
4. A user's cached feather balance equals the designated user ledger account.
5. User balances, position quantities, and market outstanding quantities never become negative.
6. `market.yesShares` equals the sum of position YES shares; the same holds for NO.
7. Market collateral covers YES, NO, and VOID liabilities.
8. Each trade references exactly one posted journal entry in the production schema.
9. A trade, welcome grant, redemption, adjustment, and settlement is business-idempotent.
10. The same idempotency key with a different request hash is rejected.
11. A quote is unexpired, version-bound, user-bound, and consumed at most once.
12. A position is settled at most once.
13. Only OPEN, not-past-close markets can trade.
14. Cached counters and leaderboard values are derivable from authoritative rows.
15. Competitive P&L excludes welcome grants, promotions, and administrative adjustments.

The current trade service creates a journal and returns its ID, but the `Trade` model does not persist a foreign key to `JournalEntry`; this must be corrected before trading can be considered durably auditable.

## Transaction boundaries

All feather and position mutations occur in one database transaction. For PostgreSQL, acquire locks in a single documented order:

1. idempotency request;
2. market;
3. position;
4. ledger accounts sorted by ID;
5. quote.

Execution recomputes the quote under lock. It does not trust browser totals or an earlier indicative calculation. Update the market, position, ledger projections, immutable trade, price snapshot, audit data, and outbox event atomically.

Current SQLite trading is supported only in one local process. `src/instrumentation.ts` and `src/lib/sqlite-startup.ts` now initialize and verify `PRAGMA foreign_keys = ON`, a 5-second busy timeout, and WAL mode before the Node server accepts work; the settlement worker runs the same gate. Prisma is constrained to one connection because foreign-key and timeout pragmas are connection-local. Unsupported or unsafe effective values stop startup. This remains local-only hardening, not a concurrency or deployment claim: explicit `BEGIN IMMEDIATE` mutation semantics are not yet implemented, multiple application/worker processes must not share the file, and SQLite must never be used for horizontal scaling or a network filesystem.

## State machines

Target market states:

```text
DRAFT -> OPEN <-> PAUSED -> CLOSED -> RESOLVING -> RESOLVED
                                        \-------> VOID
```

Transitions are server-authoritative, version checked, authorized, and audited. Closing uses server UTC. Resolution requires an evidence-bearing proposal and a different authorized approver in production. Resolved and void markets are terminal; corrections use an explicit audited reversal process, not field edits.

The current admin path stores an evidence-bearing resolution proposal from an active `ADMIN` who did not create or trade the market. A different active, conflict-free administrator must re-enter their password and approve it; the proposer cannot self-approve. Approval enforces close/resolution times and creates an immutable settlement run. An admin request or `npm run worker:settlement` then claims expiring leases, settles at most 100 nonzero positions per transaction, and uses compare-and-swap fencing against stale workers. Finalization verifies the exact settlement count and payout total before returning collateral and making the market terminal. The flow is resumable and idempotent, but it still has no dispute window or phishing-resistant MFA.

Session target states are active, expired, or revoked. User target states are pending verification, active, suspended, banned, or deleted. String fields in the current SQLite schema must become constrained enums/checks in the PostgreSQL schema.

## Data model review

### Present models

The current Prisma schema declares:

- Identity: `User`, `Session`, `AccountToken`, `RegistrationInvite`, `RegistrationInviteClaim`
- Markets: `MarketEvent`, `MarketEventCreationRequest`, `Market`, `MarketPriceSnapshot`, `WatchlistEntry`, `MarketSuggestion`, `MarketResolutionProposal`, `MarketSettlementRun`
- Trading: `Position`, `Trade`, `TradeQuote`, `IdempotencyRequest`, `PositionSettlement`
- Accounting: `LedgerAccount`, `JournalEntry`, `LedgerPosting`
- Community/operations: `Comment`, `CommentReport`, `Notification`, `RateLimitBucket`, `AuditLog`

### Required production additions or changes

- Verification/reset tokens are implemented as purpose-bound hashes with expiry and one-time consumption; production still needs key-rotation policy and PostgreSQL concurrency evidence.
- Session CSRF secret/hash, last-seen time, revocation time, and session rotation metadata.
- A future explicit entitlement table may replace the current unique welcome-grant journal key if eligibility grows beyond one verification-triggered grant.
- Constrained roles, states, trade sides/actions, and account purposes.
- A unique journal reference on each financial business event, including trades and settlements.
- Resumable settlement-run and batch status; proposal/approval records already exist locally.
- Sanctions, appeals, dedicated moderator roles, edit history, and broader safe-deletion/evidence retention; basic comment reports and admin review already exist.
- Outbox events with per-aggregate sequences for reliable realtime delivery.
- Leaderboard snapshots and rows with documented scoring provenance.
- PostgreSQL checks/triggers for journal balance and aggregate constraints where practical.
- Migration-controlled defaults; production must not rely on a mutable `STARTING_FEATHERS` value to initialize `User.balanceMilli` directly.

## Web route map

The current server-rendered route surface is:

| Route | Current behavior |
| --- | --- |
| `/` | Discovery, featured markets, trending, movers, categories |
| `/markets` | Search, filter, and sort markets |
| `/markets/[slug]` | Detail, probability history, ticket, rules, activity, comments |
| `/markets/suggest` | Authenticated market suggestion form |
| `/portfolio` | Cash, executable position value, realized/unrealized P&L |
| `/leaderboard` | Rankings for active users who explicitly enable `leaderboardVisible`, using grant-adjusted executable equity |
| `/community` | Public feed of visible market comments |
| `/users/[username]` | Public profile statistics and recent visible comments only when the user enables `profilePublic` |
| `/watchlist` | Private saved-market list for the signed-in account |
| `/notifications` | Persisted account notifications with unread count and per-item/all-read controls; no realtime transport |
| `/login`, `/signup` | Password login and access-code-aware registration |
| `/settings/profile`, `/settings/privacy` | Editable display name, bio, profile/leaderboard visibility, privacy information, and other-session revocation |
| `/rules`, `/search` | Rules and market search |
| `/admin` | `ADMIN`-restricted market lifecycle, resolution approval, suggestion review, and comment-report moderation console |

Frontend verification/recovery pages, realtime notification transport, sanctions/appeals, dedicated moderator roles, and automatic settlement workers remain targets.

## API contract map

Most legacy APIs are unversioned; the CLOB surface begins at `/api/v1`. Cookie-authenticated mutations enforce the configured `Origin`; trade, order, comment-create, market-create, and resolution paths use persistent idempotency keys where implemented. Session-bound CSRF tokens are not implemented.

| Area | Implemented endpoints |
| --- | --- |
| Authentication | `POST /api/auth/register`, `/login`, `/logout`, `/email-verification/request`, `/email-verification/confirm`, `/password-reset/request`, `/password-reset/confirm`; `GET /api/auth/session`, `GET/DELETE /api/auth/sessions`, `/api/me` |
| Health | `GET /api/health` (database liveness), `GET /api/ready` (settlement-worker liveness and backlog readiness) |
| Events | `GET /api/events`, `GET /api/events/[slug]` |
| Discovery | `GET /api/discovery`, `GET /api/search`, `GET /api/calendar` |
| Markets | `GET /api/markets`, `GET /api/markets/[slug]`, `GET /api/markets/[slug]/history` |
| Trading | `POST /api/markets/[slug]/quote`, `POST /api/markets/[slug]/trades`, `POST /api/markets/[slug]/redeem` |
| Order book | `GET /api/v1/markets/[slug]/orderbook`, `GET/POST /api/v1/orders`, `DELETE /api/v1/orders/[id]` |
| Portfolio and ranking | `GET /api/portfolio`, `GET /api/leaderboard` |
| Community | `GET/POST /api/markets/[slug]/comments`, `PATCH/DELETE /api/comments/[id]`, `POST /api/comments/[id]/report` |
| Personalization | `PATCH /api/profile`, `GET/POST/DELETE /api/watchlist`, `GET/POST /api/suggestions`, `GET/PATCH /api/notifications`, `PATCH /api/notifications/[id]` |
| Admin | Idempotent event creation, versioned event updates, event-market attach/detach; market create/lifecycle/proposal routes; resolution proposal review and settlement-run progress/batch processing; registration invite issuance/revocation; report and suggestion review |

The settlement worker is started with `npm run worker:settlement:continuous`. A singleton `WorkerState` records ownership, heartbeat, cycle counters, sanitized failure state, and graceful shutdown. Each cycle isolates one automatic-close or approved-run failure from the remaining work. Readiness fails closed after a 30-second heartbeat gap, any uncleared failed cycle, a 120-second expired-market or active-settlement lag, or any expired settlement lease. Thresholds can be overridden with `SETTLEMENT_WORKER_STALE_AFTER_MS`, `EXPIRED_MARKET_READY_LAG_MS`, and `SETTLEMENT_RUN_READY_LAG_MS`. The worker never creates resolution proposals or approvals.

Participant email verification is enforced at the shared authenticated-API boundary and repeated inside financial services. Unverified participants retain a restricted session only for session-state inspection, verification resend/confirmation, password recovery, and logout. They receive no welcome grant and cannot trade, place or cancel orders, redeem contracts, comment, report, edit profiles, manage watchlists, submit suggestions, or mutate other application state. Verification atomically records the verified timestamp and posts the idempotent welcome-grant journal; password reset never marks an email verified. `ADMIN` and `SYSTEM` roles are exempt from the participant gate for compatibility with out-of-band provisioned and seeded operators, while current provisioning explicitly marks their email verified. Target additions include broader moderation/sanctions/appeals, production process supervision, and authenticated realtime notification delivery. A future production API should be versioned before external clients depend on it.

Use opaque cursor pagination. Error responses use a stable code, safe message, and request ID. Use `409` for stale version/idempotency conflicts, `422` for invalid trading conditions, `429` for limits, and `403` for authorization failures.

## Portfolio and leaderboard valuation

Current portfolio and leaderboard code does not use `quantity * displayed probability`. Its canonical open-position value is:

1. redeem complete YES/NO pairs;
2. simulate selling the remaining one-sided position into the current LMSR;
3. subtract the normal fee.

Positions persist YES and NO cost basis separately, so mixed-side holdings do not attribute the entire net cost to either side. The current leaderboard considers only active `USER` accounts with `leaderboardVisible = true`, reads wallet cash, adds executable position value, subtracts the configured welcome grant, sorts by P&L, and uses username as a deterministic tie-break. Public profile routes likewise require `profilePublic = true`; both flags default to false. Production still needs entitlement-aware subtraction of every non-qualifying grant/adjustment, persisted/versioned snapshots, and independent recomputation.

## Realtime and background work

Write outbox events in the same transaction as the mutation. A worker publishes only committed events. Events include an ID, topic, aggregate sequence, type, data, and UTC timestamp. Clients refetch the REST resource when a sequence gap appears.

Workers also close elapsed markets, execute settlement batches, generate leaderboard snapshots, expire tokens/sessions, and reconcile the ledger. Jobs must be version-aware and idempotent. Redis may coordinate delivery and distributed rate limits, but losing Redis must never lose or alter financial truth.

## SQLite and PostgreSQL constraints

### Local SQLite

- Development only; one process and one database file.
- No claim of production concurrency safety.
- No horizontal scaling or network filesystem.
- Node and settlement-worker startup enable and verify foreign keys, a 5-second busy timeout, and WAL on a single Prisma connection. Tests use disposable temporary databases. Immediate writer locking remains unimplemented.
- Run the same economic test vectors as PostgreSQL, while recognizing dialect/locking differences.

### PostgreSQL preparation and production target

- The PostgreSQL schema twin, generated runtime client, reproducible baseline, and byte-identical checked-in initial migration exist. Web, worker, administrator provisioning, and reconciliation use the selected provider through `src/lib/db.ts`.
- `npm run db:migrate:deploy:postgres` validates TLS/direct-connection requirements before running `prisma migrate deploy`; use it only through an approved migration role after rehearsal.
- Review and add required checks, composite foreign keys, partial indexes, and journal-balance enforcement as immutable follow-up migrations before any deployment.
- Use a restricted runtime role and a separate migration role.
- Enforce TLS, backups, point-in-time recovery, connection limits, statement/lock timeouts, and monitoring.
- Test real row-level concurrency with the same PostgreSQL major version used in production.
- Apply transaction isolation and explicit row locks appropriate to the trade and settlement paths.
- Do not use `prisma db push` or automatic schema drift repair.
- Do not describe schema validation or offline SQL generation as PostgreSQL runtime or production support.

## Deployment checklist

Nothing should be deployed publicly until all items are complete:

### Build and provenance

- [ ] Application source, migrations, seed tooling, tests, and CI exist.
- [ ] `npm ci` and `npm run check` pass from a clean checkout.
- [ ] Dependency and secret scans have no unresolved critical/high finding.
- [ ] Artifact is built once and promoted; commit SHA and lockfile are recorded.

### Data

- [ ] PostgreSQL schema and reviewed migrations exist; migration dry run succeeds on a restored production-like copy.
- [ ] Restricted runtime/migration roles are verified.
- [ ] Backup, point-in-time recovery, and a full restore/reconciliation drill pass.
- [ ] Ledger, market, and settlement reconciliation return zero discrepancies.

### Security and identity

- [ ] HTTPS-only canonical origin, HSTS, production CSP without `unsafe-eval`, and secure cookies are verified.
- [ ] Verification/recovery email, rate limits, CSRF, origin checks, session rotation, revocation, and admin MFA/step-up work; verify the locally implemented dual-control resolution flow under PostgreSQL concurrency and failure recovery.
- [ ] No bootstrap/default administrator secret remains.
- [ ] Threat-model and authorized red-team release gates in `SECURITY.md` pass.

### Operations

- [x] Local health/readiness endpoints verify database liveness plus settlement-worker heartbeat, failures, leases, and backlog without exposing persisted exception messages.
- [ ] Logs redact credentials, cookies, tokens, personal data, and request bodies where sensitive.
- [ ] Metrics and alerts cover auth attacks, failed trades, invariant/reconciliation failures, settlement, database saturation, and worker lag.
- [ ] Runbooks exist for rollback, credential rotation, market pause, settlement recovery, data restore, and incident response.
- [ ] Capacity and failure tests cover expected event traffic and campus NAT behavior.

### Product and legal clarity

- [ ] Play-money and non-affiliation disclaimers are visible in onboarding, rules, and footer.
- [ ] Market policy, code of conduct, privacy notice, terms, moderation, and appeal paths are published.
- [ ] No unauthorized Waterloo, Hack the North, Kalshi, or Timbermarket branding/assets are shipped.
- [ ] Every initial market has objective rules, source, close time, resolver, and edge-case handling.

### Release evidence

- [ ] Test matrix in `TESTING.md` passes against the exact candidate.
- [ ] Browser and accessibility evidence is attached.
- [ ] An independent release integrator confirms docs match implementation.
- [ ] Go/no-go owner records the deployed SHA, migration set, environment fingerprint, and rollback point.
