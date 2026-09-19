# Synthetic development sandbox

This is an explicitly fictional, local development dataset for rendering,
manual testing, and agent-driven testing. It is separate from `prisma/dev.db`
and from any hosted database. It does not implement MongoDB, Solana, or shared
cloud hosting. The current replay exercises Goosey's real SQLite/Prisma LMSR
services. It is not historical Kalshi or Polymarket data, and does not exercise
on-chain settlement or the order-book engine.

## Start using it

```sh
npm run db:generate
npm run data:dev -- create
npm run data:dev -- serve
```

Open `http://localhost:8082`. `serve` runs both Next.js and the settlement worker;
Ctrl-C stops both. The normal app on port 8080 can remain running. The sandbox
has a separate build directory, cookie name, database, and private credentials.
Run one sandbox server per checkout. The server binds to all interfaces for
local team testing; use the canonical localhost origin for browser automation.
For access from other devices, a properly configured shared deployment/origin
is still required; this tool does not establish cloud synchronization.

The login email, password and 27 interactive accounts are in
`output/development-sandbox/team/credentials.json` (owner-only file permissions).
Use `simulation-trader-01@example.test` through
`simulation-trader-24@example.test` for participants. Three distinct
`simulation-admin-N@example.test` accounts exercise creation, proposal and
approval. A separate non-interactive SYSTEM account supports the worker.
Participant accounts are already verified and have a real ledger-backed
100,000-feather development grant. Outbound SMTP is disabled in this sandbox.
Do not use its credentials outside the development environment.

## Dataset coverage

The default scenario has 3 events, 12 markets, 24 participants, 3 administrators,
and a system worker identity. It generates 2,600 buy/sell executions and 2,615
price snapshots over up to 90 days, plus positions, accounting journals,
notifications, comments and watchlists. Five markets remain open, one is
paused, two are closed awaiting resolution, two resolve YES/NO, one is voided,
and one is a draft. The three completed markets produce real payout records.

Older history is sampled daily with deliberate quiet periods. The recent week,
day and hour have progressively denser trading, including roughly one-minute
activity during the final hour. Scenario trajectories contain trends,
reversals, fictional information shocks and short-term variation. The planner
chooses target probabilities; actual trades move the existing LMSR model
toward them. Chart points are persisted by the trading service, not separately
invented. Fees, volume, balances, positions and payouts come from those trades.

The time-series examples were informed by the explicit interval and timestamp
conventions in [Kalshi's candlestick API](https://docs.kalshi.com/api-reference/market/get-market-candlesticks)
and [Polymarket's public data guide](https://institute.polymarket.com/data).
No external trade histories or real participant identities are imported.

All dates are absolute UTC instants anchored to generation time by default.
Market `createdAt` is its trading start; grouped events also have `startsAt` and
`endsAt`. Trades occur after creation and before closing. Resolution follows
closing, and settlement follows the resolution schedule. Historical services
run inside the isolated database with temporary future trading deadlines;
their resulting timestamps are moved to the scenario time after each action.
Original deadlines are restored before lifecycle/settlement processing.
Production pricing, authorization and payout checks remain unchanged.

For repeatable scenario paths, specify both seed and anchor:

```sh
npm run data:dev -- create --name regression --seed 42 --as-of 2026-09-19T12:00:00Z
```

The anchor must not be in the future. Old anchors eventually leave no open
markets relative to real time; reset with a current anchor for interactive
trading. IDs, passwords and generated technical identifiers are intentionally
not deterministic. The manifest records the anchor, seed and generated accounts.

## Agent contributions

Agents should log in to the running sandbox with a dedicated participant and
use the normal UI or authenticated APIs to trade, comment and manage watchlists.
These actions persist alongside the historical baseline. They must not write
chart snapshots or balances directly, submit actions to production, or reset
another agent's ongoing session. Close browser tabs after testing.

When the sandbox server is stopped, a CLI can also append actual trades:

```sh
npm run data:dev -- contribute --count 20
npm run data:dev -- verify
```

The contribution command uses fresh idempotency keys, real quotes and the same
trade execution service. It only selects open, unexpired simulation markets.
Each invocation intentionally adds new activity; it does not regenerate history.
The fixture CLI clears sandbox rate-limit buckets to accelerate bulk replay;
normal agent/UI activity still uses the application's request limits.

## Reset and live launch

```sh
# Stop serve with Ctrl-C first.
npm run data:dev -- reset
npm run data:dev -- serve
```

Reset archives the entire previous sandbox beneath
`output/development-sandbox/team-archive-*`, then creates a fresh baseline with
new credentials. It refuses an active tool/server lock, missing ownership
markers, unsafe names, symlinks and production/hosted environments. An incomplete
build is never marked ready. All generated files and archives are gitignored.

Before a live launch, configure a separate, empty production database and real
participant onboarding. Do not copy or migrate this sandbox, its snapshots,
credentials or archives into production. Resetting development data is not a
production migration. No mainnet tokens or external accounts are created here.

## Verification

`create` and `reset` validate chronology and ledger consistency before marking
the dataset ready. `verify` independently checks trading windows, probabilities,
trade-to-snapshot linkage, volumes, distinct trader counts, share totals,
settlement timing, journal balance and wallet caches, then runs the existing
`scripts/reconcile.ts`. `contribute` performs the same checks after appending.

```sh
npx vitest run scripts/lib/development-sandbox.test.ts
npm run data:dev -- verify
```

These checks cover the current LMSR fixture. They are not evidence of MongoDB,
Solana, order-book, public deployment or high-concurrency correctness.
