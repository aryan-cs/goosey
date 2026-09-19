# Goosey testing and reconciliation

## Current test status

The local verification run on 2026-09-19 passed 520 tests with one intentional skip across 72 Vitest files. Coverage includes LMSR pricing, CLOB matching/accounting and lifecycle operations, private activity pagination, valuation, market marks, notifications, settings, account recovery, and database-backed rate-limit thresholds/resets. These counts describe that run, not a permanent release guarantee. `package.json` declares:

```bash
npm test
npm run test:e2e
npm run test:settlement
npm run test:orderbook
npm run test:watch
npm run check
```

`npm run check` covers lint, typecheck, the unit suite, and a production build; supply the intended `DATABASE_PROVIDER` explicitly for the build. `npm run test:e2e` creates a fresh temporary SQLite database from the current schema, seeds the catalog and a dedicated test administrator, and starts a separate local production server. It does not copy development participants or sessions. It covers grouped event reads, registration and verification, invitation administration, authorization, quotes, atomic buys, idempotent trade replay, portfolio, persisted notifications, threaded comments, reporting, privacy controls, watchlist, suggestions, origin rejection, and malformed JSON.

`npm run test:settlement` creates isolated SQLite databases and verifies mixed-side cost basis, partial/full sells, authorization/idempotency, distinct proposal/approval, exact payout, terminal replay, rejection, bounded 100/100/5 batches, expired-lease recovery, stale-token fencing, zero-share exclusion, settlement notifications, and balanced journals.

`npm run test:orderbook` creates an isolated SQLite database and executes genuine CLOB placement, exact cash reservation, permanent replay/conflict idempotency, complementary YES/NO minting, immutable fill/journal creation, equal contract issuance, exact collateral, transactional price snapshotting, resting-order cancellation, reservation release, and cancellation replay. It does not substitute for the required PostgreSQL concurrency suite.

`npm run test:sqlite-startup` exercises the executable SQLite startup gate against a newly created database under the operating-system temporary directory. It verifies foreign-key enforcement, the 5-second busy timeout, WAL, single-connection URL normalization, the in-memory compatibility rule, and fail-closed behavior. The suite never opens or changes `prisma/dev.db`.

This is a meaningful local and CI smoke baseline, not a production release signal. There is no production deployment to certify. The suite now covers participant email verification policy, worker liveness/readiness, and a hostile authorization matrix, but it does not cover quote expiry/contention, truly concurrent database requests, full admin lifecycle, process crashes between separate worker invocations, post-mutation independent reconciliation, PostgreSQL locking/runtime behavior, admin MFA, or the broader moderation lifecycle. The sections below define the remaining release gates.

`scripts/visual-qa.sh` captures desktop/mobile home and market pages. Current artifacts include `goosey-home-desktop.png`, `goosey-home-mobile.png`, `goosey-market-desktop.png`, `goosey-market-mobile.png`, and an earlier signup-mobile capture under `output/playwright/`. The home and market screenshots have been visually inspected. These images are point-in-time evidence, not automated cross-browser or accessibility assertions; the script also contains a machine-specific Playwright wrapper path.

## Test environments

### Local fast loop

- SQLite at `file:./dev.db`.
- One API process only.
- Deterministic local markets and system/admin setup from `prisma/seed.ts`; the API smoke test creates a unique participant in a temporary database copy.
- No fabricated production history or silent fallback services.
- Unit, component, schema-validation, and basic integration tests.

### PostgreSQL integration

- `npm run test:postgres` now runs `scripts/postgres-exchange-concurrency.ts` inside its generated schema. The actual exchange service is exercised with simultaneous orders in different markets sharing one last wallet balance, duplicate placement requests, and duplicate cancellation requests. Assertions check one reservation/command, exact cash/refund, no failed-operation residue, balanced journals, and cached accounts against independently summed postings. The fixture grant itself is journaled; checks are scoped to fixture accounts, not unrelated pre-funded integration records. Two fresh-schema local runs passed on 2026-09-19 and their schema cleanup was verified. These two-request races do not establish the 100-request staging targets below.
- After migration deployment, a read-only Prisma drift check compares the full applied migration chain with the current datamodel. Historical baseline files are not regenerated to represent subsequent migrations.
- Same PostgreSQL major version and relevant extensions/configuration as production.
- Fresh database per test worker or isolated schema with reliable cleanup.
- Real migrations applied with `prisma migrate deploy`.
- Concurrency, row-lock, idempotency, settlement, migration, backup/restore, and reconciliation tests.
- SQLite success never substitutes for PostgreSQL concurrency evidence.

### Production-like staging

- HTTPS, secure cookies, trusted proxy behavior, Redis-backed limits, SMTP test mailbox, workers, monitoring, and production CSP.
- No production credentials or user data.
- Browser, mobile, accessibility, load, degraded-network, security, and operational drills.

## Layered test suite

### Static and build checks

```bash
npm ci
npm run db:generate
npm run db:validate
npm run db:generate:postgres
npm run test:postgres
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:settlement
npm run test:orderbook
npm run test:worker
```

`npm run db:validate` validates both provider-specific schemas, runs the logical parity checker, and checks the PostgreSQL migration contract. Provider-contract tests require explicit production selection, reject mismatched URLs, verify TLS policy, and test the PostgreSQL startup probe without credentials. `npm run test:postgres` creates a random isolated schema when `POSTGRES_TEST_DATABASE_URL` is supplied, applies real migrations, probes the generated runtime client, races two serializable spends, and runs the shared exchange integration suite. It drops only its generated schema. This passed locally against PostgreSQL 16 on 2026-09-19, including a serialization retry and the expected notification-failure rollback. The workflow now defines a disposable PostgreSQL service job; a hosted run has not yet been verified. This is bounded integration evidence, not high-load or production approval.

`npm run test:worker` covers fresh/missing/stale/failing readiness, backlog-age and expired-lease rejection, per-market failure isolation, continued processing of already-approved runs, and bounded sanitized persisted errors. Operational staging must additionally exercise real concurrent workers and send `SIGTERM` during a database transaction to verify graceful drain under the deployment supervisor.

CI must fail on warnings designated by policy, uncommitted generated Prisma drift, missing migrations, secrets, vulnerable reachable dependencies, or a dirty generated artifact. Run from a clean checkout.

### Unit tests

- Exact milli-feather parsing/formatting and JSON string serialization.
- Stable LMSR log-sum-exp, marginal probability, cost delta, conservative rounding, and boundary vectors.
- Deterministic price-time matching, maker-price execution, partial-fill priority, GTC/IOC/FOK/post-only/STP behavior, canonical YES/NO normalization, replay determinism, and input immutability.
- Exact CLOB cash/share reservations, cumulative fee deltas independent of fill splitting, four fill economic kinds, balanced journal plans, depth sweeps, top-of-book, spreads, sparse-book marks, and settlement marks.
- Fee, subsidy, collateral liability, complete-set redemption, payout, and canonical liquidation valuation.
- Password/session/token helpers, request hashing, cursor signing, and authorization decisions.
- Market/user state transitions and role matrix.
- Markdown/link sanitization and Unicode edge cases.
- Zod schemas for every request, response, environment variable, and realtime event.

Golden pricing vectors must be produced independently and reviewed. Do not derive expected values by calling the implementation under test.

### Repository/service integration tests

The list below is the target integration suite. The current API and settlement E2E scripts cover only the subsets called out in “Current test status” and do not run the complete independent reconciliation suite.

- Registration and one-time entitlement/journal grant.
- Login, session rotation, logout, reset, all-session revocation, and expiry.
- Quote creation, expiry, ownership, version binding, one-time consumption, and slippage rejection.
- Buy, sell, complete-set redemption, and every failure rollback.
- Market pause/close/resolution/void transitions and authorization.
- Settlement batching, crash/retry, exact liability, and collateral return.
- Comment create/edit/delete/report/moderate permissions and sanitizer behavior.
- Leaderboard snapshot derivation, tie-breaking, opt-in privacy, and grant-adjusted P&L.
- Outbox publication after commit and REST resync after event-sequence gaps.

Each financial integration test runs reconciliation after the operation, including expected failures.

## Property-based economic tests

Use a property-testing library such as `fast-check` when added. Generate at least 10,000 operation sequences per release candidate and retain failing seeds as permanent regression cases.

Generate valid and invalid combinations of registration/grant, buy, sell, redeem, pause, resume, close, resolve, void, retry, rollback, and worker restart. After every step assert:

1. each posted journal balances to zero;
2. no user or market account that disallows debt is negative;
3. no position or market quantity is negative;
4. market quantities equal summed positions;
5. cached balances equal posted ledger sums;
6. collateral covers YES, NO, and VOID liabilities;
7. selected-outcome buys move probability in the expected direction and sells reverse it;
8. an immediate buy/sell round trip cannot mint feathers;
9. splitting orders cannot exploit rounding or fees;
10. complete-set redemption pays exactly one payout per pair;
11. resolution conserves feathers according to the documented issuance/treasury model;
12. repeating an idempotency key returns the original result with no new mutation;
13. changing a payload under the same key is rejected;
14. rebuilding all projections from immutable records exactly matches stored state.

For `ORDER_BOOK` markets also generate place, partial fill, cancel, decrease, cancel-replace, IOC, FOK, post-only, STP, expiry, and sequence-gap operations. The isolated order-book E2E now covers one sequenced expiry with atomic backing release and a private terminal event; broader generated expiry/contention coverage remains a release gate. Require an uncrossed residual book, price-time ordering, `original = filled + canceled + remaining`, exact reservation coverage, equal aggregate YES/NO issuance, collateral equal to complete sets times payout, one journal per fill, and snapshot-plus-replay equivalence.

Include zero, negative, boundary, oversized, excess-precision, scientific notation, unsafe-integer, Unicode digit/minus, null, array, object, boolean, `NaN`, and infinity-shaped inputs at the HTTP validation boundary.

## Concurrency and fault tests

Run on real PostgreSQL with at least 100 synchronized requests at critical boundaries:

- two or more buys spending the same final balance;
- simultaneous sells of the same contracts;
- simultaneous trades across markets sharing one wallet;
- quote execution racing quote expiry, market version change, pause, and close;
- sell or redemption racing settlement;
- duplicate idempotency requests across separate API instances;
- conflicting resolution proposals/approvals;
- two settlement workers claiming the same batch;
- worker crash after posting but before acknowledging;
- database disconnect/timeout at each transaction stage;
- lost HTTP response after commit followed by same-key retry;
- stale/reordered WebSocket events and reconnect gaps.

The acceptable outcome is a legal serializable business state, not a particular winning request. All losing operations fail safely and reconciliation remains exact.

## Reconciliation

`npm run reconcile` queries persisted state and checks journal sums, account caches/non-negativity, user-wallet equality, market-position quantities, collateral, order quantities, position reservations, terminal orders and fill/journal linkage. It independently compares cash reservations with their escrow account balances and ownership. Both API and order-book E2E now run it on restored snapshots after exact logical-record comparison; CI also checks a fresh seeded fixture. It is not a supervised production schedule, still omits some business-reference/settlement/leaderboard checks below, and reuses production helpers for several invariants. Production reconciliation must be broader and independently implemented so the same defect cannot validate itself.

### Required checks

1. For every posted journal entry, `SUM(postings.amountMilli) = 0`.
2. Every cached ledger account balance equals summed posted postings.
3. Every user cached balance equals their designated user-feather account.
4. Every market YES/NO total equals summed positions.
5. Every trade/redemption/grant/settlement/adjustment has exactly one expected journal reference.
6. No business idempotency key maps to multiple operations.
7. No quote is consumed more than once or by another user.
8. Market collateral is at least `payout * max(qYes, qNo)` and covers void liability.
9. Each `(market, user)` settles at most once; paid total equals the settlement run's expected liability.
10. Resolved-market surplus is returned exactly once.
11. Leaderboard rows recompute from ledger/positions under the recorded scoring version.
12. Materialized counters (volume, traders, comments) equal their authoritative records.

### Operational behavior

Reconciliation outputs machine-readable discrepancy records with check name, entity ID, expected/actual values, request/run ID, and timestamp, without secrets or unnecessary personal data. Any financial discrepancy:

- fails CI or the deployment gate;
- alerts operators;
- pauses affected markets or settlement paths;
- preserves all evidence;
- requires investigation and a compensating transaction if correction is authorized;
- is never silently repaired by overwriting a balance.

## API and authorization security tests

Release-blocking cases include:

- CSRF against every mutation using forms, simple content types, missing/wrong token, wrong origin, and another session's token.
- IDOR/BOLA across portfolio, trade, quote, session, comment, notification, moderation, resolution, and audit IDs.
- direct invocation of every admin/moderator route as anonymous and ordinary users.
- mass assignment of role, owner, balance, status, result, fee, price, payout, and moderation fields.
- SQL injection payloads in body, path, query, cursor, sort, search, and raw-query paths.
- stored/reflected/DOM XSS in all text/URL fields and every downstream render location.
- account enumeration, credential stuffing, session fixation, token replay, reset replay, stale session after role/status change, and cache leakage after logout.
- CORS, redirect, content-type/method confusion, duplicate parameters, oversized payloads, pagination/search complexity, proxy-header spoofing, and WebSocket subscription authorization.
- production errors and logs leaking stacks, SQL, secrets, tokens, paths, internal hosts, or personal data.

Adversarial tests must use explicitly authorized environments and test accounts.

## End-to-end browser journeys

Automate critical journeys with Playwright when configured, then independently verify API/database/ledger state:

1. Register, verify, receive exactly one grant, discover a market, trade, and view portfolio.
2. Two users trade; one partially exits/redeems; balances, positions, chart, and activity reconcile.
3. Admin creates, opens, pauses, resumes, closes, proposes/approves resolution, and settlement retries safely.
4. Void a traded market and verify the documented payout/refund policy.
5. Drop responses after committed grant/trade/comment/job actions; retry without duplication.
6. Reset a password; reject token replay and every old HTTP/WebSocket session.
7. Attempt cross-user and cross-role access through guessed/replaced identifiers.
8. Post/edit/reply/report/moderate/delete safe and hostile community content.
9. Complete the core flow with keyboard and screen reader only.
10. Trade and comment under latency, packet loss, offline transition, response reordering, reconnect, refresh, and back/forward navigation.

Close all browser contexts after each suite. Preserve screenshots/traces only for failed tests or explicitly retained release evidence, and ensure they contain no secrets.

## Accessibility acceptance

Target WCAG 2.2 AA. Automated tooling is necessary but not sufficient.

- Keyboard-only signup, login, discovery, trade review/confirmation, portfolio, comments, and logout.
- Logical visible focus; dialogs/sheets trap and restore focus; sticky UI does not obscure focus.
- Unique accessible names, associated labels/errors, status announcements, and non-color YES/NO meaning.
- Trade review announces side, quantity, average price, maximum debit/minimum credit, fee, payout, and result.
- Charts provide a textual summary and accessible data table; probability information is not color-only.
- AA text/non-text contrast, 320 CSS-pixel reflow, 200% zoom, touch targets, text spacing, and reduced motion.
- Manual VoiceOver/Safari, NVDA/Firefox or Chrome, and one mobile screen-reader pass.
- Axe (or equivalent) reports zero serious/critical issues on primary states, followed by manual verification.

## Responsive and browser matrix

Test latest and previous Chromium, Firefox, and Safari desktop; current iOS Safari; current Android Chrome; and at least 320, 390, 768, 1024, 1280, and 1440 CSS-pixel widths.

Verify long real market titles/usernames, large feather values, localized dates, safe areas, rotation, mobile keyboard, 200% zoom, no document overflow, usable trade sheet/ticket, no hydration mismatch, clear loading/empty/error/offline/stale states, and browser-console/network cleanliness.

Visual regression baselines must use deterministic real test fixtures, not filler text or random values. Pixel comparison may catch stable component regressions, but responsive correctness also requires semantic assertions and human inspection; fixed pixel coordinates are not a sufficient oracle.

## Performance and resilience

- Define budgets for server latency, page interaction, bundle size, database queries, worker lag, and WebSocket recovery before release.
- Load test shared-campus NAT patterns, browse/search reads, quote/trade bursts, comments, and leaderboard refresh separately.
- Bound body parsing, pagination, search/filter complexity, chart history, subscriptions, and worker batch size.
- Confirm graceful degradation when Redis, SMTP, realtime delivery, or telemetry is unavailable. Trading must fail closed if an authoritative dependency or invariant check is unavailable.
- Confirm database pool exhaustion, lock timeout, deadlock retry, process restart, and rolling deployment do not duplicate business operations.

## Migration, backup, and restore tests

Local SQLite evidence (2026-09-19): 12 real-sqlite snapshot tests cover WAL
commits, exact large values, private permissions, corruption/refusal cases,
quoted paths and concurrent no-overwrite publication. The API E2E now backs up
its running isolated application, restores a separate working copy and runs
reconciliation. It passed with 7 journals, 9 accounts, 2 participants and 5
markets; this fixture uses market-maker trading, not order-book fills. See
[the recovery runbook](docs/sqlite-recovery.md). This is not PostgreSQL recovery
or a production disaster-recovery claim.

- Run `npm run db:validate` and `npm run db:preflight:postgres` before any migration rehearsal. The preflight rejects missing/non-PostgreSQL URLs, pooled direct migration URLs, and insecure non-loopback production connections without printing credentials.
- Apply all PostgreSQL migrations from an empty database and from the previous release snapshot.
- Verify no migration truncates precision, invalidates constraints, rewrites large tables without a plan, or grants excessive privileges.
- Test forward recovery from a failed migration; never rely on `prisma db push` in production.
- Restore a backup into an isolated environment, apply required logs/migrations, and run the complete independent reconciliation.
- Record recovery point objective and recovery time objective evidence.

## Release gate

A release is eligible only when:

- `npm ci` and `npm run check` pass from a clean checkout;
- all P0/P1 functional, economic, security, accessibility, and browser cases pass against the exact candidate;
- property and concurrency suites find no invariant violation;
- PostgreSQL reconciliation reports zero discrepancies;
- settlement retry/restore scenarios are exact;
- no unresolved reachable critical/high vulnerability remains;
- backup restore and post-restore reconciliation pass;
- docs, schema, migrations, environment contract, and observed UI/API behavior agree;
- an independent release integrator records candidate SHA, migration set, environment fingerprint, test evidence, known P2 issues, rollback point, and explicit go/no-go decision.

Any waived lower-severity issue needs an owner, rationale, user impact, mitigation, and deadline. Financial integrity, authorization, settlement, secret exposure, and critical accessibility failures cannot be waived for launch.
