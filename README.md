# Goosey

Website: [getgoosey.vercel.app](https://getgoosey.vercel.app).

**Solana work in progress:** the requested free, transferable, non-cash-redeemable feather system is being implemented for localnet/devnet. The current website's trades are still database-backed, not on-chain. See [the migration scope, implemented foundations, and remaining gates](docs/solana-migration.md).

Goosey is a working play-money prediction market for a University of Waterloo and Hack the North-inspired hackathon experience. Its unit is the feather (`🪶`). Feathers are free, have no promised cash value, and cannot be purchased or redeemed for money or prizes through Goosey. The Solana implementation will support user-to-user feather transfers without introducing a cash-out feature.

> **Independent project.** Goosey is not affiliated with, endorsed by, sponsored by, or operated by the University of Waterloo, Hack the North, Kalshi, or Timbermarket. “University of Waterloo,” “Hack the North,” “Kalshi,” and “Timbermarket” are used only to describe inspiration or context. Do not use third-party logos, protected brand assets, proprietary copy, or language implying official status without written permission.

## Repository status

This repository is a **working local, single-process implementation** with real SQLite-backed account, market, trading, comment/moderation, watchlist, suggestion review, notification, automatic leaderboard, and administrator flows. It is not production-ready.

| Area | Current repository state |
| --- | --- |
| Framework | Next.js, React, TypeScript, Prisma, Zod, Recharts, and Vitest are configured. |
| Application UI | Home, browse/search, multi-range probability charts, market detail/trading, portfolio, community, automatic leaderboard, rules, complete signup/verification/login/password-recovery flows, suggestions, private-by-default editable profiles, dedicated watchlist, persisted notifications, comment reporting, and an admin market/moderation desk are implemented. |
| API routes | Auth/session management/me, profile, health/readiness, discovery rails, grouped events, unified search, calendar, markets/history, slug-based quote/trade/complete-set redemption, versioned public order-book depth/trade tape and private order/fill-history reads, atomic order placement/cancel/replace/bulk-cancel, comments/replies/reports, portfolio, leaderboard, watchlist, suggestions, notifications, invitations, and admin market, resolution-approval, settlement-run, suggestion-review, and moderation endpoints are implemented. |
| Authentication | Signup creates a usable session and grants welcome feathers atomically, without requiring email verification. Email ownership remains unverified until a real confirmation. Existing unverified accounts receive any missing grant on their next login. Set `REQUIRE_EMAIL_VERIFICATION=true` only to opt back into the verification gate. Password checks, persistent rate limits, session revocation, one-time recovery tokens, and SMTP-based password reset remain in place. |
| Trading | Existing markets use LMSR quote/trade execution. The `ORDER_BOOK` engine has deterministic price-time matching, exact YES/NO normalization, bigint pricing/accounting, durable transactional placement/cancel/replace/bulk-cancel, sequenced GTC expiration, reservations, fills, commands/events, public trade tape, and cursor-paginated private history APIs. Existing LMSR markets are never converted in place. Atomic complete-set redemption and two-person, lease-fenced settlement remain implemented. Bounded PostgreSQL tests verify competing wallet reservations and simultaneous placement/cancellation retries. Production supervision and high-load verification remain outstanding. |
| Ledger | Registration, trades, market funding, settlement, and collateral return use journal postings in application transactions. `npm run reconcile` checks persisted journal/account/user/market aggregates and currently passes the seeded database. Database-enforced balancing/immutability, complete foreign keys, scheduling, and exhaustive independent reconciliation remain gaps. |
| Database | Runtime selection is explicit through `DATABASE_PROVIDER=sqlite|postgresql`. SQLite remains the local default outside production; production fails closed without an explicit provider. PostgreSQL uses its own generated Prisma client, schema twin, and checked-in migrations. An isolated PostgreSQL 16 run passed migration, serializable-spend, and exchange checks locally; the CI workflow now includes a disposable PostgreSQL service. |
| Seed data | `prisma/seed.ts` and a local `prisma/dev.db` provide deterministic event markets and local administrator setup. Seed credentials are local-only. |
| Tests | Unit coverage includes LMSR, ledger/recovery/security, deterministic and randomized CLOB matching, CLOB pricing, CLOB accounting, strict cursor-paginated read services, transactional placement/cancel/replace/bulk-cancel, and price-history integrity. Real isolated database suites cover reservations, replay, complementary minting, fills, public/private histories, journals, snapshots, expiration, and settlement. Desktop/mobile browser journeys cover participant/admin flows, probability-chart interactions, and password recovery. Live PostgreSQL concurrency remains opt-in. |
| Deployment | CI defines static checks, provider-contract tests, production build, isolated SQLite API/order-book/settlement/reconciliation jobs, the offline PostgreSQL schema/migration contract, and a PostgreSQL runtime/exchange job. The new PostgreSQL job has not yet been observed passing on hosted CI. No application container, hosting definition, cache, telemetry backend, or supervised production worker configuration exists. |

Do not expose the SQLite configuration to untrusted public traffic or use Goosey to account for real value.

### Hack the North account linking

Goosey accounts are independent; HTN account/profile synchronization is not enabled. Public-source review on September 19, 2026 found HTN-service authentication and Google sign-in described in [HTN's privacy policy](https://hackthenorth.com/privacy/), but did not establish a supported third-party client registration or profile API. This is not evidence that a private organizer integration is impossible.

Before implementation, obtain organizer approval and the supported protocol/API documentation, client registration, permitted profile scopes and stable identity identifier, localhost and production callback registrations, and consent/linking/unlinking rules. HTN lists `hello@hackthenorth.com` as its contact. Never collect HTN passwords, reuse portal session cookies, or equate an independently verified email/Google account with an authorized HTN profile link.

## Prerequisites

- Node.js 20.9 or newer. Node.js 22 LTS is recommended.
- npm, using the checked-in `package-lock.json`.
- SQLite for local-only development through Prisma.
- PostgreSQL for any future shared, multi-process, staging, or production deployment.

## Local setup

From the repository root:

```bash
npm ci
cp .env.example .env
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

`db:push` creates or updates the local SQLite database at `prisma/dev.db`. It is intentionally a local bootstrap path because no migration history is checked in. Do not use it in staging or production.

The offline PostgreSQL contract can be checked without a server:

```bash
npm run db:validate
npm run db:generate:postgres
npm run db:baseline:postgres
npm run db:migrations:check:postgres
```

These commands validate both schemas, enforce logical parity, generate an isolated client under `node_modules`, reproduce `prisma/postgresql/baseline.generated.sql`, and prove that the checked-in initial migration is identical to that baseline. Runtime imports, `DATABASE_URL`, `db:push`, and local development continue to use SQLite.

The initial migration lives at `prisma/postgresql/migrations/00000000000000_baseline/migration.sql`. Deployment operators must supply a TLS-protected `POSTGRES_DATABASE_URL` and a non-PgBouncer `POSTGRES_DIRECT_DATABASE_URL`, then run `npm run db:migrate:deploy:postgres`. Set `DATABASE_PROVIDER=postgresql` for the web and worker runtime. Startup selects the separately generated PostgreSQL client and verifies database identity/version before serving work. Rehearse migrations and `npm run test:postgres` against a disposable PostgreSQL database before deployment.

The development command binds Goosey to `0.0.0.0:8080`; open [http://localhost:8080](http://localhost:8080). The active project heartbeat also checks `/api/health` on that port and restores the development server when needed.

Verify the current local candidate:

```bash
npm run check
npm run test:e2e
npm run test:settlement
npm run test:worker
npm run reconcile
npm run worker:settlement:continuous
```

Run the continuous settlement worker beside the web process. It persists a singleton heartbeat and cycle outcome in `WorkerState`, isolates failures by entity, and stops between atomic operations on `SIGINT`/`SIGTERM`. It only closes elapsed markets and processes settlement runs created by the existing two-person approval flow; it never proposes or approves outcomes. Worker code is not hot-reloaded: follow [the worker restart runbook](docs/settlement-worker-operations.md) after backend changes.

`GET /api/health` is a database liveness probe. `GET /api/ready` is the deployment readiness probe and returns `503` when the settlement worker is missing, stopped, stale, has an uncleared failed cycle, has an expired lease, or work exceeds the configured lag budget. Restart or repair the worker and investigate its sanitized persisted `lastError`; do not bypass settlement or fabricate an outcome to clear readiness.

The API E2E script requires `zsh`, `curl`, `jq`, `openssl`, and `sqlite3`; it applies the current schema and seed to a fresh temporary SQLite database, starts the latest production build on `127.0.0.1:3100`, verifies a live backup/restore with accounting reconciliation, and removes the temporary server/database on exit. It does not copy local participant data. The settlement test uses isolated SQLite databases to exercise mixed-side accounting, sells, distinct proposal/approval, exact payouts, 100/100/5 bounded batches, expired-lease recovery, stale-token fencing, zero-share exclusion, replay, terminal state, notifications, and balanced journals. Run `npm run check` first so `.next` matches the source.

Optional visual QA:

```bash
zsh scripts/visual-qa.sh
```

The visual script starts the built app and refreshes desktop/mobile screenshots under `output/playwright/`. Its Playwright wrapper path is currently machine-specific, so it is local tooling rather than a portable CI test. The checked-in screenshots have been visually inspected, but they are evidence snapshots, not automated accessibility or cross-browser proof.

## Synthetic data for development and agent testing

Start with the checked-in [three-month dataset](fixtures/synthetic/three-months/README.md). It contains 24 fictional traders with handles such as `orbitotter`, `maplebyte`, and `ctrlaltduck`, three administrators, 12 campus/project/weather markets, and over 2,600 executed trades with probability history, portfolios, comments, watchlists, and completed settlements.

```sh
npm ci
npm run db:generate
npm run data:fixture -- import --name shared
npm run data:dev -- serve --name shared
```

Open **http://localhost:8082**. Read `output/development-sandbox/shared/credentials.json` locally for the generated password and account list. For example, Maple Byte signs in with `simulation-trader-01@example.test`. Administrator emails are `simulation-admin-1@example.test` through `simulation-admin-3@example.test`; use separate administrators for market creation, resolution proposal, and approval. Passwords and secrets are generated per import and never published in GitHub.

`serve` starts the app and settlement worker together; Ctrl-C stops both. The isolated database, credentials, and build files live under `output/development-sandbox/` and are gitignored. The normal development database is untouched. Use one sandbox server per checkout. These are local copies; teammates' changes do not automatically sync.

Import shifts every timestamp by the same duration so the saved capture time becomes today. This preserves the three-month history and correct market/trade/settlement order while keeping open markets available for testing. Add `--preserve-dates` on import for exact historical UTC timestamps. Import refuses an existing destination; choose another name to try a fresh copy.

### Create, contribute, verify, and refresh

To generate a new dataset instead of importing the saved one:

```sh
npm run data:dev -- create --name team
npm run data:dev -- serve --name team
# Optional reproducible scenario: add --seed 42 --as-of 2026-09-19T12:00:00Z to create.
```

The generator executes real LMSR buys/sells and settlement services. Probability snapshots, fees, balances, volumes, and payouts come from those executions. Markets cover open, paused, awaiting-resolution, resolved YES/NO, void, and draft states, with quiet periods, reversals, and denser recent activity. Synthetic status is disclosed in market descriptions and rules. This fixture covers SQLite/Prisma LMSR behavior; it does not simulate the order-book engine, MongoDB, or Solana transactions.

Agents and teammates can sign in and trade, comment, or manage markets through the normal UI/APIs; their activity persists. Stop the sandbox server before using these CLI commands:

```sh
npm run data:dev -- contribute --name shared --count 20
npm run data:dev -- verify --name shared
npm run data:dev -- refresh-profiles --name shared
npm run data:dev -- serve --name shared
```

`contribute` adds actual trades without rebuilding history. `verify` checks market windows, probability/trade linkage, volumes, positions, settlement timing, balanced journals, and wallet reconciliation. `refresh-profiles` updates the known fictional account names and scenario wording while preserving login emails, passwords, IDs, trading history, financial values, and dates. It also works on older imports with numbered trader names.

### Share data and reset before launch

Export a sanitized snapshot for the team, then review and commit its folder:

```sh
npm run data:fixture -- export --name shared
git diff -- fixtures/synthetic/three-months
```

The export uses a consistent database transaction and can run while the source server is active. The folder contains one JSONL file per supported model plus a manifest with counts, schema fingerprint, and SHA-256 checksums. Monetary big integers are decimal strings, timestamps are UTC ISO strings, and probabilities use basis points (`10000` = 100%). Import validates checksums, relationships, chronology, and accounting. Authentication secrets, sessions, tokens, audit logs, and operational caches are excluded. Keep real identities and secrets out of fictional comments and other free-text fields; review those before publishing.

To discard local testing changes and generate a fresh baseline, stop `serve`, then run:

```sh
npm run data:dev -- reset --name shared
npm run data:dev -- serve --name shared
```

Reset archives the previous sandbox under `output/development-sandbox/shared-archive-*` and generates new local credentials. To restore the exact published baseline instead, import it with a new `--name`. For launch, use a separate empty production database and real onboarding; never deploy these fixtures, local credentials, or archives. See the [sandbox guide](docs/development-sandbox.md) and [fixture format and coverage](fixtures/synthetic/three-months/README.md) for details.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env` or production secrets.

| Variable | Current example | Purpose and constraints |
| --- | --- | --- |
| `DATABASE_URL` | `file:./dev.db?connection_limit=1` | SQLite-only runtime URL. Startup rejects non-`file:` values and connection limits other than one. PostgreSQL runtime URLs belong only in `POSTGRES_DATABASE_URL`. |
| `DATABASE_PROVIDER` | `sqlite` | Explicit runtime provider: `sqlite` or `postgresql`. Non-production defaults to SQLite for backwards-compatible local development; production refuses to start when this is absent or invalid. |
| `POSTGRES_DATABASE_URL` | empty | PostgreSQL application/pool URL and Prisma schema input. Required when `DATABASE_PROVIDER=postgresql`; non-loopback production URLs must use `sslmode=require`, `verify-ca`, or `verify-full`. |
| `POSTGRES_DIRECT_DATABASE_URL` | empty | Direct PostgreSQL migration URL. It must bypass PgBouncer; production preflight requires a secure `sslmode` for non-loopback hosts. Store it as a deployment secret, not in `.env`. |
| `POSTGRES_TEST_DATABASE_URL` | empty | Opt-in test-only URL with permission to create/drop a uniquely named schema. `npm run test:postgres` never uses it unless explicitly supplied. |
| `SESSION_COOKIE_NAME` | `goosey_session` | Implemented opaque-session cookie name. Code sets `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production; production should configure a `__Host-` prefixed name. |
| `SESSION_TTL_DAYS` | `14` | Absolute session lifetime; expiry is checked server-side. Idle expiry is not implemented. |
| `STARTING_FEATHERS` | `1000` | One-time welcome grant in whole feathers, posted at signup through a unique balanced journal and matching user/wallet cache updates; deferred to verification only when explicitly required. |
| `ADMIN_EMAIL` | empty | When paired with `ADMIN_PASSWORD`, local seed creates a new `ADMIN`; it refuses to promote an existing email. |
| `ADMIN_PASSWORD` | empty | Local seed requires at least 12 characters. Do not keep a bootstrap credential in production; rotate it and require step-up authentication. |
| `GOOSEY_ADMIN_EMAIL` | empty | Email consumed only by `npm run admin:create`; it is normalized before a create-only uniqueness check. |
| `GOOSEY_ADMIN_USERNAME` | empty | Username consumed only by `npm run admin:create`; use 3–24 lowercase letters, numbers, or underscores. |
| `GOOSEY_ADMIN_DISPLAY_NAME` | empty | Display name consumed only by `npm run admin:create`; use 2–40 printable characters. |
| `GOOSEY_ADMIN_PASSWORD` | empty | Password consumed only by `npm run admin:create`; use a generated 16–72-byte value or a unique passphrase. It is hashed with bcrypt cost 12 and never printed. |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:8080` | Public canonical origin. It must match the deployed HTTPS origin and must not contain secrets. |
| `APP_URL` | `http://localhost:8080` | Server-side allowed origin. Set the exact HTTPS canonical origin in production. |
| `RATE_LIMIT_KEY_SECRET` | empty | HMAC secret for private rate-limit keys. Production requests fail closed if both this and `AUTH_SECRET` are absent. Use an independent random secret. |
| `GOOSEY_TOKEN_SECRET` | empty | HMAC secret for retry-safe one-time invitation token derivation. Production invite issuance fails closed if both this and `AUTH_SECRET` are absent. |
| `EMAIL_VERIFICATION_URL` | `http://localhost:8080/verify-email` | Public verification page URL. The mailer adds the one-time token as a URL fragment so it is not sent in the initial HTTP request. Must use HTTPS in production. |
| `EMAIL_VERIFICATION_TTL_MINUTES` | `60` | Verification-token lifetime, constrained to 5–1440 minutes. |
| `PASSWORD_RESET_URL` | `http://localhost:8080/reset-password` | Public password-reset page URL. The mailer adds the one-time token as a URL fragment so it is not sent in the initial HTTP request. Must use HTTPS in production. |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Password-reset token lifetime, constrained to 5–240 minutes. |
| `SMTP_HOST`, `SMTP_PORT` | empty, `587` | SMTP endpoint. Recovery request endpoints return `503` when mail delivery is not fully configured. |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS` | `false`, `true` | Use implicit TLS and/or require STARTTLS. Certificate validation is always enabled. |
| `SMTP_USER`, `SMTP_PASSWORD` | empty | Optional SMTP authentication; configure both or neither. Values are read only from the runtime environment. |
| `SMTP_FROM`, `SMTP_REPLY_TO` | empty | Required sender identity and optional reply-to address. |
| `TRUST_PROXY` | `0` | Set to `1` only behind a proxy that overwrites and sanitizes forwarding headers. |

The code also observes these runtime variables, which are not user-configured in `.env.example`:

| Variable | Current behavior | Production requirement |
| --- | --- | --- |
| `AUTH_SECRET` | Secondary fallback for rate-limit key hashing only. | Do not rely on the fallback; use purpose-specific secrets. |
| `NODE_ENV` | Controls secure cookies, logging, and development-origin behavior. | Build and run production with `production`; normally set by the platform. |
| `VERCEL` | Presence enables forwarded-address trust. | Platform-provided; verify the forwarding-header trust boundary. |

Future Redis, telemetry, and key-management variables must be added to `.env.example` when their integrations are implemented. Documentation must never invent variables that the code does not consume.

## Available scripts

| Command | Intended purpose | Present caveat |
| --- | --- | --- |
| `npm run dev` | Run Next.js in development. | Uses local SQLite and seeded data. |
| `npm run build` | Create a production Next.js build. | Currently passes. |
| `npm start` | Serve a completed production build. | Requires a successful build. |
| `npm run lint` | Lint the repository. | Useful now; coverage grows with source files. |
| `npm run typecheck` | Run TypeScript without emitting files. | Currently passes. |
| `npm test` | Run Vitest once (requires `sqlite3` for snapshot integration tests). | The 2026-09-19 verification run passed 653 tests with one intentional skip across 83 files; use current output for subsequent changes. |
| `npm run test:e2e` | Run the local API smoke flow. | Currently passes; requires a current build plus `zsh`, `curl`, `jq`, and `openssl`. |
| `npm run test:email:onboarding` | Exercise real TLS verification/reset email delivery, participant grants, matching and session recovery through HTTP. | Passed locally with a disposable database and private loopback SMTP receiver; no token injection or external mail. Requires a current build and OpenSSL. See [verification evidence and limits](docs/email-onboarding-qa-2026-09-19.md). |
| `npm run test:settlement` | Run the isolated settlement integration flow. | SQLite-only; verifies mixed-side accounting, bounded resumable batches, lease recovery/fencing, replay, terminal state, and balanced journals, but not PostgreSQL concurrency. |
| `npm run test:orderbook:settlement` | Exercise order-book close/drain and YES, NO and VOID settlement. | Disposable SQLite database; includes payout/replay checks, backup/restore comparison and full reconciliation. Requires `sqlite3`. |
| `npm run test:sqlite-startup` | Verify local SQLite startup hardening. | Uses disposable databases under the operating-system temporary directory; it never opens `prisma/dev.db`. |
| `npm run reconcile` | Check persisted ledger/account/user/market aggregates. | CI creates a fresh schema and seeded fixture before reconciliation; this path passed locally. Not a supervised production reconciliation schedule. |
| `npm run admin:create` | Create one active administrator from explicit `GOOSEY_ADMIN_*` environment variables. | Local/out-of-band only; refuses existing emails/usernames and does not grant feathers. Production requires managed identity and MFA. |
| `npm run worker:settlement` | Close elapsed open markets and process one bounded batch for each already-approved settlement run. | Run under a supervised worker service; add `-- --continuous` for a persistent local worker. It never chooses or approves outcomes. |
| `npm run test:watch` | Run Vitest in watch mode. | Unit coverage only. |
| `npm run db:generate` | Generate both provider-specific Prisma clients. | Runs automatically before development and production builds. |
| `npm run db:validate` | Validate both schemas, enforce logical parity, and verify the checked-in PostgreSQL migration contract. | Does not connect to PostgreSQL or prove runtime support. |
| `npm run db:generate:postgres` | Generate the isolated PostgreSQL runtime client. | Writes below ignored `node_modules/@goosey/postgresql-client`. |
| `npm run db:baseline:postgres` | Reproduce the offline PostgreSQL baseline SQL. | Regeneration must be reviewed and followed by an intentional migration update. |
| `npm run db:migrations:check:postgres` | Verify migration naming/provider rules and exact baseline reproducibility. | Offline contract only; it does not apply SQL. |
| `npm run db:preflight:postgres` | Validate PostgreSQL deployment URLs without connecting. | Requires explicit PostgreSQL environment variables. |
| `npm run db:migrate:deploy:postgres` | Preflight and apply checked-in migrations with Prisma. | Use only with an approved migration role in a rehearsed PostgreSQL environment. |
| `npm run test:postgres` | Apply all migrations in an isolated random schema, detect schema drift, probe the runtime, test concurrent spending and real exchange placement/cancellation, and run the shared exchange integration suite. | Two fresh-schema runs passed locally against PostgreSQL 16 on 2026-09-19, including independent fixture ledger checks. Skips without `POSTGRES_TEST_DATABASE_URL`; CI supplies a disposable service. This is bounded concurrency coverage, not a load-test claim. |
| `npm run db:push` | Push schema without migration history. | Local prototyping only; prohibited for staging/production. |
| `npm run db:migrate` | Create/apply local SQLite development migrations. | Do not use this generic command for PostgreSQL deployment. |
| `npm run db:seed` | Run `prisma/seed.ts`. | Local-only seed; see security caveats. |
| `npm run db:studio` | Open Prisma Studio. | Local trusted use only. Never expose it publicly. |
| `npm run db:backup:sqlite -- --source /absolute/source.db --output /absolute/new-backup.db` | Create a private, integrity-checked live SQLite snapshot. | Requires `sqlite3`; refuses overwrite. See [local recovery instructions](docs/sqlite-recovery.md). Not a PostgreSQL backup mechanism. |
| `npm run db:verify-restore:sqlite -- --source /absolute/archive.db --restored /absolute/copy.db` | Compare logical schema and records without exposing row contents. | Bounded local snapshot verification; run before opening the restored copy for writes. Both API and order-book E2E use this before reconciliation. |
| `npm run check` | Lint, typecheck, unit tests, and build. | Currently passes; this is not sufficient for production release. |

## Out-of-band administrator provisioning

Goosey's resolution control can require three distinct administrators: a market creator, a different proposer, and a third approver. Provision each local administrator out of band with the create-only command below. Supply credentials through these exact environment variables; the command rejects positional arguments and never prints a credential. Read the password interactively or inject it from an approved secret store so it does not appear in shell history:

```bash
export GOOSEY_ADMIN_EMAIL='operator@example.com'
export GOOSEY_ADMIN_USERNAME='operator_one'
export GOOSEY_ADMIN_DISPLAY_NAME='Operator One'
read -r -s GOOSEY_ADMIN_PASSWORD
export GOOSEY_ADMIN_PASSWORD
npm run admin:create
unset GOOSEY_ADMIN_EMAIL GOOSEY_ADMIN_USERNAME GOOSEY_ADMIN_DISPLAY_NAME GOOSEY_ADMIN_PASSWORD
```

The command normalizes and validates identity fields, hashes the password with bcrypt cost 12, creates an `ACTIVE` `ADMIN` with no feather grant, and records an audit event in the same transaction. If either email or username already exists, it fails without promoting, overwriting, or otherwise changing that account. Run it once per independent local operator. Do not persist provisioning credentials in `.env`; remove the variables from the shell immediately after each attempt.

This command is a local bootstrap mechanism, not a production identity system. Production administration requires managed identity, phishing-resistant MFA or equivalent step-up authentication, individually attributable accounts, lifecycle/revocation controls, and audited privileged access.

## Database policy

SQLite is permitted only for local, single-process development. The Node startup hook and settlement worker now constrain Prisma to one SQLite connection, enable and verify foreign-key enforcement, require a 5-second busy timeout, and require WAL for file-backed databases before accepting work. A true in-memory datasource may report `MEMORY` because WAL is unavailable there. Startup fails closed when any effective setting is unsafe. This does not make SQLite safe for multiple Goosey processes: one API process must own the database file, the settlement worker must not run concurrently against that file outside the same supervised local setup, and the file must not live on a network filesystem. Keep transactions short. Explicit `BEGIN IMMEDIATE` coverage for every economic mutation remains separate work.

PostgreSQL is mandatory for production. Runtime switching is now explicit and provider-specific, with fail-closed URL/provider checks, a PostgreSQL startup probe, provider-neutral Prisma error recognition, and an opt-in live migration/concurrency runner. This is not production approval: the live suite has not run in hosted CI, and production still requires review of custom constraints, broader PostgreSQL concurrency/load tests, deterministic lock ordering, restricted roles, deployment rehearsal, backup/restore evidence, and reconciliation. `prisma db push` is never a production deployment mechanism.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the target model and [SECURITY.md](./SECURITY.md) for required controls.

## Product and API routes

Implemented product pages:

- `/` discovery
- `/markets` browse/search
- `/markets/[slug]` market detail, chart, rules, discussion, and trading
- Order-book tickets include GTC, IOC, FOK, post-only and optional local-time expiration under **Advanced order options**, with exact retry identity and fill/cancellation-aware feedback. See [order semantics and verification](docs/advanced-orders.md); existing LMSR markets retain their quote-based ticket.
- `/portfolio/activity` private order/fill history with all/open/closed order filters, participant-side NO prices, and direct cancellation or replacement of remaining order quantities. The shared **Edit remaining order** form also appears on market pages. Replacement uses exact outcome prices, a displayed version, and retry-stable request identity; completed fills remain unchanged, queue priority is reset, and orders/balances refresh after confirmation. Rejected replacements preserve the original order; stale versions close the editor and refresh authoritative state. Desktop/mobile browser checks covered partial fills, NO conversion, a lost committed response followed by replay, insufficient backing, and stale-version recovery.
- `/portfolio` positions, value, and history
- `/leaderboard` automatic rankings for all active players
- `/watchlist` account-private saved markets
- `/community` public discussion activity with stable cursor pagination, privacy/moderation filters, and links to individual discussion threads.
- `/login`, `/signup`, `/verify-email`, `/reset-password`
- `/search`, `/rules`
- `/markets/suggest` redirects to the external market-suggestion form
- `/users/[username]` public forecaster profiles
- `/notifications` persisted trade, reply, and resolution notifications with read state and cursor-paginated older history. Order-book matches notify both participants atomically with each fill; NO contracts use their own execution price, not the canonical YES price. Resting orders do not generate trade confirmations.
- `/settings/profile`, `/settings/privacy` editable profile/visibility, active-session revocation, and privacy information. Profile saves refresh the account heading. Browser-session controls include loading, refresh, expired-session guidance, and revocation failure recovery; revoking other browsers preserves the current session. Session reads and errors use private no-store responses without exposing token hashes.
- `/admin` administrator market desk, participant invitations, two-person resolution queue, suggestion review, and comment-report moderation. Lifecycle controls adopt confirmed market versions immediately and refresh after uncertain responses; proposal and approval retries retain their request identity. Proposal creation, review, and settlement processing refresh the other desk panels without a manual page reload. Network failures remain retryable and overlapping operations are blocked within each panel.

After registration or login, the frontend inspects `emailVerification.required`; when true, it gates protected navigation and exposes resend, token-confirmation, and logout controls. Verification and password-reset links keep one-time tokens in URL fragments so the initial page request does not disclose them. Protected APIs return HTTP 403 with `error.code = "EMAIL_VERIFICATION_REQUIRED"` plus `error.details.allowedActions`. Registration returns `balanceMilli: "0"` and `pendingWelcomeGrantMilli`; confirmation reports whether the welcome grant was newly issued. Notifications are persisted and displayed, but there is no realtime push delivery. Moderation currently covers comment reports and admin review; blocking, sanctions, appeals, and dedicated moderator roles remain unimplemented.

Implemented API routes are:

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/email-verification/request`
- `POST /api/auth/email-verification/confirm`
- `POST /api/auth/password-reset/request`
- `POST /api/auth/password-reset/confirm`
- `GET /api/auth/session`
- `GET /api/me`
- `GET /api/health`
- `GET /api/ready`
- `GET /api/discovery`
- `GET /api/search`
- `GET /api/calendar`
- `GET /api/events`
- `GET /api/events/[slug]`
- `GET /api/markets`
- `GET /api/markets/[slug]`
- `GET /api/markets/[slug]/history`
- `POST /api/markets/[slug]/quote`
- `POST /api/markets/[slug]/trades`
- `GET /api/v1/markets/[slug]/orderbook`
- `GET /api/v1/markets/[slug]/trades`
- `GET`, `POST`, `DELETE /api/v1/orders`
- `PATCH`, `DELETE /api/v1/orders/[id]`
- `GET /api/v1/fills`
- `GET`, `POST /api/markets/[slug]/comments` — GET also accepts `comment=<id>` for a bounded focused thread, mutually exclusive with a page cursor. A linked reply starts the reply window at that reply, rather than requiring every older page to be loaded. Community links and new reply notifications preserve this selection through sign-in. Hidden or unrelated comments are not returned.
- `GET /api/comments/[id]/replies` (ascending, parent-scoped cursor pagination; 25 replies by default, at most 100). Initial discussion pages include 25 replies per thread, a readable-reply count, and a continuation cursor. Deleted replies remain as tombstones; hidden replies are excluded. The discussion UI can load remaining replies, refresh explicitly, and preserve loaded replies when editing a parent comment.
- `PATCH`, `DELETE /api/comments/[id]`
- `POST /api/comments/[id]/report`
- `GET /api/portfolio` — `cashMilli` is spendable cash; `reservedCashMilli` is cash held in order escrow; `totalCashMilli` includes both. Equity includes escrow plus positions. Cash, escrow, and positions are read in one serializable snapshot; resting orders must not lower total equity merely by reserving funds.
- `GET /api/portfolio/history` — private unified execution history from LMSR trades and order-book fills. Accepts `limit` (1–100, default 30) and an opaque `cursor`; returns `items` and `nextCursor`. Entries are newest first with stable source/ID tie-breaking, the participant's own YES/NO side, gross `amountMilli`, and separate `feeMilli`. Unfilled orders are not executions. `/portfolio` uses the same history with older-page navigation; `/portfolio/activity` retains order management and detailed fills. The existing portfolio API's `trades` field remains legacy-only for compatibility.
- Order-book holdings use a conservative liquidation estimate: cancel own resting orders, redeem complete YES/NO pairs at their collateral value, then sweep external non-expired depth for remaining contracts and subtract cumulative execution fees. Unfilled contracts contribute zero sale proceeds and are explicitly reported as `unfilledYesShares` / `unfilledNoShares`; this is not a prediction of their eventual payout. Complete-set collateral is split between side rows for attribution, not treated as a market price. Portfolio forecasts use a qualified two-sided midpoint or the last execution, and are null when neither exists. Paused or closed markets have no single-side executable proceeds. Resolved/void holdings use contractual payouts.
- `GET /api/leaderboard`
- Leaderboard and public-profile trade totals count completed executions from both trading engines, including both maker and taker participation. Multiple fills count separately; submitted, canceled-unfilled, and resting-unfilled orders do not. Leaderboard markets-traded totals count distinct markets across both engines. Public-profile markets-held totals exclude positions with no remaining contracts.
- Order-book reads and matching exclude expired orders even before worker cleanup. An expired original order cannot be revived through replacement; canceling it or worker cleanup releases its remaining backing. Paused, closed, past-close, or non-accepting markets return no executable public depth. Book ETags identify the visible payload, since expiry can remove depth without advancing the command sequence.
- Market-page depth and private open orders refresh every five seconds while visible, with focus/reconnect refresh, bounded request timeouts, and retry backoff. Refresh preserves ticket drafts, pauses during order edits/mutations, and aborts obsolete reads. Failed updates retain the last known data with an explicit stale-data notice. This is polling, not a streaming feed; a displayed price is not an execution guarantee.
- Resting orders are executable only while their owner is an active participant (`ACTIVE` / `USER`). Orders belonging to inactive or privileged accounts are excluded from matching, public depth, and liquidation estimates; their backing remains reserved until cancellation or market lifecycle cleanup.
- Order entry preserves the selected YES/NO side and BUY/SELL action through deep links and sign-in. Decimal prices are parsed exactly to milli-feathers, quantities must be whole and within engine limits, and displayed BUY reserves include the rounded fee (SELL proceeds are net of fees). An unchanged in-page retry reuses both its idempotency key and client order ID, including after a lost response; changing the ticket starts a new attempt. Once an order is accepted, a failed book refresh is reported separately from placement.
- Organizer creation accepts `pricingModel: "LMSR" | "ORDER_BOOK"`; omitted API values retain LMSR compatibility, while the market-desk form explicitly defaults to order books. Order-book creation issues no treasury subsidy, financial transfer journal, synthetic price snapshot, or starter orders. It records an audit event and a durable principal-scoped creation response. Collateral is funded by participant matching. LMSR creation retains its balanced treasury subsidy and initial price. The model cannot be changed after creation.
- Public market forecasts use one batch-loaded pricing policy across market lists/details, discovery, search, events, and calendar APIs. Responses include nullable `probabilityYesBps`, `probabilitySource` (`LMSR`, `MID`, `LAST`, `SETTLEMENT`, or `NONE`), and `probabilityStale`. Order books use a qualified two-sided midpoint, then the last actual fill; an empty/unpriced book is `null`, never an invented 50%. Terminal markets use settlement outcomes. CLOB charts and sparklines show actual execution prices normalized by contractual payout, not legacy market-maker inventories or seed snapshots. Midpoints are indicative, not executable quotes.
- `GET`, `POST`, `DELETE /api/watchlist`
- `GET`, `POST /api/suggestions`
- `PATCH /api/profile`
- `GET`, `PATCH /api/notifications` — GET accepts `limit` (1–100, default 50) and an opaque `cursor`, returning `items`, total `unreadCount`, and `nextCursor` (null at the end). History is ordered by creation time and ID descending; cursors do not depend on the referenced row remaining present. PATCH marks only the current user's notifications read.
- `PATCH /api/notifications/[id]`
- `POST /api/admin/markets`
- `POST /api/admin/events` (idempotent event creation)
- `PATCH /api/admin/events/[id]` (versioned metadata update)
- `POST /api/admin/events/[id]/markets/[marketId]/attach` (requires `expectedMarketVersion` and `expectedEventVersion`)
- `POST /api/admin/events/[id]/markets/[marketId]/detach` (requires `expectedMarketVersion` and `expectedEventVersion`)
- `POST /api/admin/markets/[id]/pause`
- `POST /api/admin/markets/[id]/resume`
- `POST /api/admin/markets/[id]/close`
- `POST /api/admin/markets/[id]/resolve` (creates a resolution proposal)
- `GET /api/admin/resolution-proposals`
- `POST /api/admin/resolution-proposals/[id]` (approve or reject; approval must be by a different eligible administrator)
- `GET /api/admin/reports`
- `PATCH /api/admin/reports/[id]`
- `GET /api/admin/audit-logs` (active-admin-only, cursor-paginated JSON or CSV export)
- `GET /api/admin/suggestions`
- `PATCH /api/admin/suggestions/[id]`

Unlisted endpoints in `ARCHITECTURE.md` are target contracts. Existing endpoints are unversioned and may need contract changes before production.

The audit export accepts exact `actor` (user ID or username), `action`, `entityType`, and `entityId` filters; inclusive RFC 3339 `from`/`to` instants; a maximum `limit` of 100; and an opaque `cursor`. Set `format=csv` for a CSV download and continue with the `X-Next-Cursor` response header. JSON returns `nextCursor` in the body. Responses are never cached, metadata is recursively redacted for known credential/secret keys, malformed metadata is not returned raw, and CSV cells are quoted and neutralized against spreadsheet-formula execution.

The planned API contract and implementation status are documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development principles

1. Server calculations and database state are authoritative; the browser never supplies trusted prices, fees, payouts, roles, or balances.
2. All feather values use integer milli-feathers. `1 feather = 1,000 milli-feathers`; one binary contract pays `100,000` milli-feathers when correct.
3. Every financial mutation is idempotent, transactional, auditable, and represented by a balanced immutable journal entry.
4. Market solvency, non-negative balances, non-negative positions, and exact settlement are release-blocking invariants.
5. Use real integrations and deterministic test fixtures. Do not ship fake APIs, silent fallbacks, filler markets, or fabricated history.
6. Leaderboards include all active player accounts and are derived from authoritative wallet and executable-position values. The current implementation subtracts the configured welcome grant; production must exclude all non-qualifying grants/adjustments and add versioned snapshot provenance.
7. Markets must have objective rules, a public resolution source, and moderation. Prohibit markets about personal harm, identifiable students' grades or private conduct, harassment, and outcomes participants can trivially manipulate.
8. Build an original Goosey identity. Reproduce useful interaction patterns, not third-party trade dress or assets.

## Quality gates

Before any public deployment, all release gates in [TESTING.md](./TESTING.md) and [SECURITY.md](./SECURITY.md) must pass against PostgreSQL in a production-like environment. At minimum:

- No open critical/high security finding.
- Ledger reconciliation reports zero discrepancies.
- Property and concurrency tests preserve every economic invariant.
- Settlement is idempotent and exact.
- Critical browser journeys pass on Chromium, Firefox, WebKit, iOS Safari, and Android Chrome.
- WCAG 2.2 AA automated and manual checks pass.
- Backups have been restored and reconciled successfully.
- The deployed commit, migrations, environment, and test evidence are recorded together.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md): current state, target architecture, invariants, data model, routes, and deployment.
- [SECURITY.md](./SECURITY.md): threat model, controls, security gaps, and response process.
- [TESTING.md](./TESTING.md): test strategy, reconciliation, browser/accessibility coverage, and release gates.
- [AGENT_PROMPTS.md](./AGENT_PROMPTS.md): reusable orchestration prompts for implementation and independent review.
