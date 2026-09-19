# Goosey security model

## Scope and current posture

Goosey is designed as a play-money system. Feathers have no monetary value, but account integrity, fair competition, personal data, and market results still require financial-system discipline.

The current repository is a credible local, single-process implementation. It has authentication, retry-safe single-use participant invitations and revocation, email verification and password recovery, session revocation, market, quote/trade/complete-set redemption, comment/reply/report, private watchlist, suggestion/admin review, persisted notifications, editable private-by-default profiles, opt-in leaderboard, admin lifecycle/moderation routes, and two-person resolution followed by bounded resumable settlement. It still lacks PostgreSQL migrations/concurrency proof, supervised automatic settlement workers, phishing-resistant MFA, comprehensive moderation/sanctions/appeals, exhaustive independent/scheduled reconciliation, CI, and operational observability. No production deployment exists. Nothing in this document is a claim that a control is implemented unless listed under “Current controls.” Public deployment is unsafe until the release requirements are complete.

Goosey is independent and is not affiliated with or endorsed by the University of Waterloo, Hack the North, Kalshi, or Timbermarket. Never use their credentials, identity systems, logos, or protected assets without authorization.

## Security objectives

1. No user can create feathers, contracts, P&L, grants, or rank without an authorized, balanced, immutable event.
2. No user can read or mutate another user's private resources.
3. Administrative and moderation powers are deny-by-default, audited, revocable, and separated.
4. Trading and settlement remain correct under retries, races, crashes, stale clients, and malicious input.
5. Passwords, sessions, reset links, private account data, and operational secrets do not leak.
6. User content cannot execute code, deceive users through unsafe markup, or exhaust the service.
7. Every authoritative aggregate can be reconstructed and reconciled.

## Current controls and known gaps

### Present in the repository

- `.env` and local SQLite files are ignored by `.gitignore`.
- `next.config.ts` removes `X-Powered-By` and sets `nosniff`, `DENY` framing, referrer policy, permissions policy, and a CSP.
- The Prisma schema uses unique session token hashes, idempotency keys, settlement keys, and trade keys in several models.
- Monetary columns are generally `BigInt`, not floating point.
- Ledger, rate-limit, session, audit, notification, report, and resolution-proposal models are persisted locally.
- Registration/login/logout/session/current-user routes exist. Sessions use 32 random bytes, store SHA-256 token hashes, check active users and expiry, and set `HttpOnly`, production-`Secure`, `SameSite=Lax` cookies.
- `npm run admin:create` provides create-only local/out-of-band administrator provisioning from explicitly named environment variables. It validates identities and a 16–72-byte password, hashes with bcrypt cost 12, creates an active administrator without feathers, records an audit event, rejects CLI credential arguments, and refuses any existing email or username rather than promoting an account.
- Registration and login canonicalize identities, require 12–72-byte passwords, use bcrypt cost 12, return generic credential errors, check mutation origins, and apply database-backed limits.
- Production registration requires a database-backed, bounded, expiring participant invitation and consumes it transactionally with account creation. The shared environment code is a development-only convenience. Users must accept the code of conduct.
- Registration creates a zero-balance participant wallet. Email confirmation posts the balanced, uniquely keyed welcome-grant journal and updates wallet/user caches in the same serializable transaction.
- Verification and reset links use 256-bit random bearer tokens stored only as SHA-256 hashes, bounded expiry, purpose binding, one-time compare-and-set consumption, generic request responses, and persistent account/network rate limits. Password reset updates the bcrypt hash and revokes every session in the same transaction without marking the email verified. SMTP credentials and sender configuration come only from environment variables; failed delivery removes the newly issued token. Unverified participants receive a restricted session but protected APIs deny access until verification.
- Trading code validates typed input, persists quotes, uses request-hash idempotency, consumes quotes conditionally, checks slippage/holdings/collateral, and writes balanced journals in a serializable Prisma transaction.
- Admin routes require the current `ADMIN` role, use idempotency where implemented, audit lifecycle actions, and use a persisted proposal plus distinct-approver workflow. Creators, traders, and the proposer are excluded from approving settlement; approval creates an immutable settlement run after `resolvesAt`.
- Settlement claims use expiring database leases and compare-and-swap fencing, process at most 100 nonzero positions per transaction, reconcile exact counts and payouts before terminal finalization, zero terminal quantities and cost basis, and create account notifications for affected users.
- Comments support bounded plain-text bodies, one-level replies, persistent create idempotency, ownership-checked edits, tombstone deletion, reporting, and admin review. Watchlist and suggestion mutations require an active session, same-origin request, validation, and rate limits where implemented; administrators can approve/reject pending suggestions.
- Profiles are editable and public profile/leaderboard participation flags default to false. The leaderboard includes only opted-in users and uses wallet cash plus executable LMSR liquidation value, subtracting the configured welcome grant rather than marking holdings at displayed probability.
- Notifications are account-scoped, persisted, and support individual/all-read updates; there is no realtime or external delivery channel.
- Production HSTS, frame denial, MIME/referrer/permissions headers, a CSP, request body byte limits, a database health route, and fail-closed production rate-limit secret checks exist.
- Forty-four tests currently run across market math, selected security helpers, transactional account-token consumption/session revocation, audit-export hardening, and invariant helpers; 43 pass and one is intentionally skipped.
- The local API E2E script covers registration, authorization, quote/trade/idempotent replay, portfolio, persisted notifications, threaded replies, comment reporting, private-by-default profile controls, watchlist, suggestions, origin rejection, and malformed JSON using a temporary SQLite copy.
- `npm run test:settlement` is an isolated SQLite integration runner for mixed-side accounting, distinct proposal/approval, exact payout, 100/100/5 batching, lease recovery, stale-token fencing, zero-share exclusion, replay, terminal quantities/cost basis, notifications, and journal balance.
- `npm run reconcile` currently passes the seeded SQLite database and checks balanced journals, cached account sums, non-negative accounts, user-wallet equality, market-position totals, and open-market collateral. It is not yet scheduled, exhaustive, or independent of all production math.

### Release-blocking gaps

- Production CSP removes `'unsafe-eval'` but still permits `'unsafe-inline'` scripts and styles. Move to nonce/hash-based policy before public deployment.
- The intended cookie name in `.env.example` lacks the `__Host-` prefix. Secure attributes exist, but session-bound CSRF does not.
- Idle expiry, automatic rotation of existing sessions outside password reset, phishing-resistant admin MFA, and account lockout are absent. Verified users can revoke other active sessions, and resolution approval requires fresh password verification.
- The local administrator provisioning command is not a production identity lifecycle. Production must use managed identity, phishing-resistant MFA or equivalent step-up, individual operator attribution, centralized revocation, and audited joiner/mover/leaver controls.
- A participant invitation limits starter-grant claims but is not email ownership or identity verification; organizers must issue invitations one per eligible participant.
- Current endpoints include active-session, comment ownership, and `ADMIN` checks plus a distinct second approver for resolution, but there is no complete role matrix, moderator separation, or admin step-up/MFA.
- Ledger rows are not enforced as balanced or immutable.
- `User.balanceMilli` can drift from `LedgerAccount.balanceMilli` and postings. The reconciliation command detects that mismatch, but database constraints do not prevent it and no scheduler/alert automatically runs the check.
- Trading service code is exposed by quote/trade routes but is not database integration/concurrency tested. SQLite cannot provide production lock semantics, and the schema does not persist a trade-to-journal foreign key.
- Current resolution uses distinct proposal/approval, fresh-password step-up, a durable run, and bounded resumable batches after `resolvesAt`. It still has no dispute window or automatic worker. Zero-payout results are audit/settlement records without a false empty financial journal.
- Production PostgreSQL schema/migrations and restricted database roles do not exist.
- Comments render as React text and have create/edit/delete/reply/report controls plus admin report review, but edit history, blocking, dedicated moderator roles, sanctions, durable evidence retention, and appeals do not exist.
- The local API and settlement E2E tests are valuable smoke tests, but there are no PostgreSQL integration/concurrency, process-crash fault injection, exhaustive hostile authorization-matrix, cross-browser, or full accessibility automation suites beyond them and the 44 tests.
- No structured logging, monitoring, alerting, backup, restore, or incident process is implemented.
- Request bodies are capped after reading, but an upstream server/proxy limit is still required to reject oversized streams before buffering.
- Production rate-limit secret configuration fails closed, but forwarding-header trust still needs deployment-specific verification. Limits are database-backed rather than distributed, and limits inside rolled-back business transactions may not charge failed attempts.
- The seeded system principal is an `ACTIVE` `User` with a random unknown password; production should model non-human principals separately and ensure they can never authenticate through user flows.
- Several user/reference IDs are scalar strings without foreign keys, and roles/states/actions remain unconstrained strings.

## Threat model

### Assets

- User credentials, sessions, email addresses, profile/privacy preferences, and recovery tokens.
- Feather balances, immutable ledger, positions, trades, market collateral, settlement, and leaderboard state.
- Market rules, resolution evidence, moderation records, and audit history.
- Administrator/moderator privileges, deployment credentials, database access, and signing/encryption secrets.
- Availability during a time-bounded hackathon event.

### Trust boundaries

- Untrusted browser to public Next.js endpoints.
- Public web process to PostgreSQL, Redis, SMTP, and telemetry providers.
- Ordinary user to moderator/market-admin/super-admin functions.
- Synchronous API transaction to asynchronous outbox/worker processing.
- SQLite developer environment to PostgreSQL production behavior.
- Public market/community data to private portfolio/session/moderation data.

### Threat actors

- Curious or competitive participants attempting feather, rank, or probability manipulation.
- Automated account farmers, spammers, credential stuffers, and denial-of-service actors.
- Malicious users posting XSS, phishing links, impersonation, or abusive content.
- Compromised user, moderator, administrator, dependency, CI, or hosting account.
- Well-meaning operators making unsafe manual adjustments or resolution mistakes.

## Authorization model

Target roles are `USER`, `MODERATOR`, `MARKET_ADMIN`, and `SUPERADMIN`. Enforce authorization server-side for every route, server action, WebSocket subscription, worker command, and direct business-service call.

| Capability | User | Moderator | Market admin | Superadmin |
| --- | ---: | ---: | ---: | ---: |
| Trade own account | Yes | Yes | Yes | Yes |
| Read another user's private portfolio/session | No | No | No | No, except explicit support workflow |
| Moderate comments/reports | No | Yes | No by default | Yes |
| Create/pause/close market | No | No | Yes | Yes |
| Propose resolution | No | No | Yes | Yes |
| Approve own proposal | No | No | No | No |
| Adjust balance directly | No | No | No | Never; compensating ledger entry only |
| Grant/revoke roles | No | No | No | Yes, with step-up and audit |
| Alter/delete audit or posted ledger history | Never | Never | Never | Never |

Suspension, mute, and ban checks belong in authoritative services, not only the UI. Privilege changes revoke or rotate sessions immediately.

## Authentication and sessions

Required production design:

- Normalize email using one documented policy and enforce uniqueness at the database boundary.
- Require at least 12 password characters, allow password-manager output and long passphrases, and reject only at a documented high maximum.
- Passwords currently use `bcryptjs` at cost 12. Before production, benchmark and either document that choice or migrate to Argon2id calibrated to the deployment host.
- Generate at least 256 random bits for opaque session tokens; store only SHA-256 token hashes.
- Set `__Host-goosey_session` with `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without `Domain`.
- Store sessions server-side with idle/absolute expiry, `lastSeenAt`, `revokedAt`, and rotation on login, password change/reset, privilege change, and step-up.
- Bind CSRF tokens to sessions and require them plus trusted `Origin`/`Referer` checks on every cookie-authenticated mutation. Reject unsupported content types.
- Store verification/reset tokens only as hashes with purpose, account, expiry, and one-time consumption. Reset revokes all sessions.
- Use generic registration/login/recovery responses and rate limits to limit account enumeration.
- Require phishing-resistant MFA (preferred WebAuthn) or TOTP plus fresh password confirmation for high-risk administration.
- Never store browser session credentials in `localStorage`, URLs, analytics, or logs. Do not use long-lived browser JWTs when revocable opaque sessions suffice.

One welcome grant is awarded only after the configured eligibility/verification step through a unique entitlement and balanced journal transaction. Registration retries and email aliases must not mint duplicate grants.

## Request security

Every endpoint must use Zod or equivalent validation for path, query, headers, body, and response shape. Reject unknown privileged fields to prevent mass assignment. Cap body size, collection size, string length, nesting depth, numeric precision, and pagination.

State-changing routes require:

- authenticated active session where applicable;
- role/resource authorization;
- session-bound CSRF token and trusted origin;
- strict JSON content type unless explicitly designed otherwise;
- idempotency key for grants, trades, comments, administrative actions, and job starts where retries matter;
- an exact request hash so a reused key with another payload returns `409`;
- server-authoritative timestamps, prices, fees, owner IDs, roles, status, and payouts.

Use parameterized Prisma queries. Any raw SQL must use parameter binding, explicit schema qualification, code review, and dedicated tests. Never interpolate sort fields, identifiers, or filters.

## Trading and ledger threats

| Threat | Required defense |
| --- | --- |
| Double spend / concurrent sell | Database transaction, fixed lock order, row locks in PostgreSQL, non-negative constraints |
| Duplicate request / lost response | Persistent idempotency request with payload hash and stored response |
| Quote replay or stale price | User/market/version-bound quote, short expiry, one-time consumption, execution-time recomputation and slippage bound |
| Client price/fee tampering | Ignore client totals; calculate with pinned exact arithmetic on the server |
| Rounding mint | Conservative integer rounding and property tests over micro-orders and split orders |
| Market insolvency | Subsidy journal entry and post-mutation collateral invariant |
| Double settlement | Unique position settlement and journal reference; resumable idempotent batches |
| Ledger tampering | Append-only entries/postings, restricted DB role, compensating entries, reconciliation |
| Leaderboard manipulation | Executable liquidation value, grant-adjusted P&L, stable snapshots, self-trade/abuse detection |
| Unsafe manual correction | No direct balance/position edits; reasoned compensating journal and audit event |

### Order-book-specific threats

`ORDER_BOOK` markets add durable reservations and peer matching. They remain locally gated until the release criteria in `ORDER_BOOK_ARCHITECTURE.md` pass.

| Threat | Required defense |
| --- | --- |
| Cross-market reservation reuse | Atomically move spendable cash to an order-owned reserve; reserve owned contracts for sells; reconcile aggregate and per-order reserves |
| Cancel/fill or amend/fill race | Place, match, cancel, amend, lifecycle, and expiry commands share one authoritative per-market sequence and transaction boundary |
| Self-match and wash volume | Server-derived beneficial-owner STP, linked-account surveillance, no self-associated rewards, and abuse-adjusted public volume |
| Queue manipulation | Price-time priority from engine sequence, never client time or transaction completion time; same-price size increases and price changes lose priority |
| FOK/post-only bypass | Side-effect-free FOK preflight uses identical STP/eligibility rules; post-only checks all crossing liquidity, including self-owned liquidity |
| Order/fill enumeration | Owner-scoped queries with uniform not-found responses; public depth exposes aggregated levels only |
| Sequence gap/replay | Transactional event log and outbox, absolute-level deltas, consumer deduplication, and mandatory snapshot recovery on gaps |
| Close/settlement race | Sequenced non-matchable barrier, deterministic cancellation, zero-reservation proof, then settlement position snapshot |
| Arithmetic overflow | Checked integer limits and bigint monetary/pricing arithmetic; no floating point in matching, reserves, fees, or journals |
| Thin-book manipulation | Distinguish executable prices, qualified display marks, last trades, portfolio liquidation value, and realized leaderboard P&L |

Mutations must fail closed if an invariant cannot be verified. The reconciliation worker pauses affected markets and alerts operators; it does not silently “repair” authoritative history.

## Market resolution and administration

- A market has objective rules, source, close time, resolver policy, void conditions, and edge-case language before opening.
- Closing and resolution use server UTC and optimistic market versions.
- Trading stops before resolution begins.
- Resolution requires a proposal with evidence and a different authorized approver. Emergency single-operator mode, if ever allowed for an event, is explicit, time-limited, and prominently audited.
- Settlement computes expected liability before payment, posts at most one settlement per user, verifies paid total, and then returns surplus collateral through the ledger.
- A resolved result cannot be overwritten. Correction requires a designed reversal and re-settlement workflow.
- High-risk actions require step-up authentication, a typed confirmation/reason, and an immutable audit event.

## Content and community security

- Treat market text, usernames, comments, bios, URLs, source metadata, and moderation notes as untrusted.
- Prefer plain text. If Markdown is supported, disallow raw HTML and sanitize through a strict allowlist. Permit only `http`/`https` links; add safe `rel` attributes.
- Never pass untrusted content to `dangerouslySetInnerHTML`, script/style contexts, DOM HTML setters, or executable URL attributes.
- Limit body length, reply depth, mentions, link count, and posting frequency. Preserve reported evidence and version/edit history.
- Implement report, block, mute, quarantine, hide, tombstone, sanction, and appeal workflows. Users cannot write moderation fields.
- Display position badges only with explicit per-user opt-in. Public feeds must not reveal private holdings.
- Normalize or visibly handle bidirectional controls, zero-width impersonation, and confusable usernames.

## Rate limits and abuse controls

Initial limits are policy targets to tune from observed traffic. Several matching limits are implemented in current database-backed routes, but this table is not a guarantee that every flow or distributed instance shares one enforced bucket:

| Flow | Initial limit |
| --- | --- |
| Registration | 5/hour/network, 2/day/normalized email |
| Login | 10/15 minutes/account, 30/15 minutes/network |
| Password reset | 3/hour/account/network |
| Quote | 60/minute/user |
| Trade | 20/minute/user with small documented burst |
| Comment | 5/minute and 50/day/user |
| Report | 10/day/user |
| WebSocket | 3 connections/user and 10/network |
| Admin mutation | 30/minute/admin plus step-up for high risk |

Use Redis or a database-backed distributed limiter in production. Trust forwarding headers only from configured proxies. Account limits and network limits must work together so one attacker cannot evade controls and a shared campus NAT does not unnecessarily lock out all participants. Limit payload bytes, pagination, search complexity, WebSocket frames/subscriptions, and third-party email cost as well as request counts.

## Browser, headers, and cross-origin policy

- Serve only over HTTPS and enable HSTS after verifying all subdomains in scope.
- Replace the current development CSP with a nonce/hash-based production policy and remove `'unsafe-eval'`; avoid `'unsafe-inline'` wherever possible.
- Keep `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, a strict referrer policy, and a minimal permissions policy.
- Do not enable credentialed CORS for arbitrary origins. Prefer same-origin APIs.
- Set authenticated and personal responses to an appropriate private/no-store cache policy.
- Validate redirects against an allowlist and block `javascript:`, unsafe `data:`, private-network SSRF targets, and redirect-based SSRF if remote fetches are introduced.

## Secrets and privacy

- Store production secrets in the hosting platform's secret manager, not `.env` files in images or source control.
- Separate keys for sessions, CSRF, email links, telemetry, and third-party integrations. Support rotation and versioning.
- Use separate development, preview, staging, and production resources and credentials.
- Redact authorization headers, cookies, tokens, passwords, reset links, email addresses where unnecessary, request bodies, and sensitive metadata from logs/traces.
- Minimize retention of IP/device signals; store truncated or keyed hashes for abuse review, never expose them to ordinary moderators.
- Document exported, deleted, retained, and public profile data before launch.

## Supply chain and operations

- Use `npm ci` from the lockfile and review dependency updates.
- Run static analysis, dependency audit, secret scan, and license review in CI.
- Generate private source maps or omit them from public artifacts.
- Use a non-root, least-privilege runtime where applicable and a database runtime role without migration or superuser power.
- Back up PostgreSQL with point-in-time recovery. Test restore and run full reconciliation on the restored copy.
- Alert on repeated login failures, authorization denials, trade failures, invariant violations, reconciliation discrepancies, settlement failures, worker lag, unusual grants, and database saturation.

## Verification and release blockers

The detailed suite is in `TESTING.md`. Security release blockers include:

- any way to mint/lose feathers or positions outside balanced authorized ledger events;
- an unbalanced journal or unreconciled cached balance;
- IDOR/BOLA, privilege escalation, CSRF on a mutation, SQL injection, or executable XSS;
- session fixation, reusable reset token, or failure to revoke compromised sessions;
- duplicate trade/grant/settlement after retry or concurrent request;
- insolvent market or incorrect/duplicate settlement;
- exposed secret, credential, session token, reset token, or private portfolio;
- unmitigated critical/high reachable dependency finding;
- inability to restore backups and reconcile to zero discrepancies.

## Vulnerability reporting and response

Before public launch, publish a monitored private security contact and a coordinated disclosure policy. Do not ask reporters to test against other users or production financial state.

On a credible report:

1. acknowledge and preserve evidence without copying secrets into tickets;
2. classify affected assets, users, markets, and environments;
3. contain by revoking credentials/sessions, pausing affected markets, or disabling a route;
4. reconcile ledger, positions, collateral, and settlement independently;
5. fix with a regression test and peer review;
6. rotate exposed secrets and restore from known-good state only when needed;
7. notify affected users and organizers with accurate impact and remediation;
8. document timeline, root cause, and prevention without erasing audit history.

Only conduct adversarial testing against systems and accounts for which the tester has explicit authorization.
## Email verification enforcement

- Only active `USER` accounts with `emailVerifiedAt` may use protected application APIs. The shared `requireUser` boundary returns HTTP 403 and `EMAIL_VERIFICATION_REQUIRED`; trading, order-entry, and redemption services repeat the check to prevent internal-call bypasses.
- Unverified participants may authenticate so they can inspect `/api/auth/session`, request or confirm verification, recover a password, and log out. Password reset revokes sessions but does not verify ownership for the separate email-verification purpose.
- New participants start with a zero wallet. Confirmation posts the balanced `WELCOME_GRANT` journal and updates wallet/user caches in the same serializable transaction. The journal's `(idempotencyScope, idempotencyKey)` uniqueness prevents duplicate grants, while previously granted legacy users are not granted twice.
- `ADMIN` and `SYSTEM` accounts are exempt from the participant gate to preserve seeded and out-of-band operations. Seed and provisioning paths still mark these accounts verified. Privileged accounts cannot trade.
