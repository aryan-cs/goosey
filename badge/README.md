# Goosey badge 0.9.0

## Website snapshot build

The deployed backend is now https://getgoosey.vercel.app. To build the badge
browser using its actual public markets, prices, volume, closing timestamps and
up to 32 database history samples per market:

```sh
python3 badge/scripts/build.py --cloud-url https://getgoosey.vercel.app --output badge/dist-cloud
BADGE_OUTPUT=badge/dist-cloud python3 badge/tests/test_cloud.py
```

If a Python.org macOS install lacks its certificate bundle, configure its
trusted CA store first (for example `SSL_CERT_FILE=/etc/ssl/cert.pem` on macOS).
Certificate verification must remain enabled.

Import `badge/dist-cloud/goosey.lua` and use the accompanying repository logo.
The same `goosey_base` slug preserves private app saves. This build does not
write any private save data, read website sessions, display a fake balance,
or execute local trades. The header explicitly shows **Saved snapshot** with
its UTC capture time; it does not auto-refresh. Empty history stays empty and
one sample is a dot. A on a market opens the website sign-in instructions;
it does not submit an order. Public snapshots contain no account information
and can be shared. Rebuild/reinstall to refresh this snapshot.

The production snapshot path is intentionally separate from the legacy local
practice build below. A USB transport that can safely deliver responses to a
running Lua app, plus authenticated device linking, is still required for live
accounts and trading. The current official guide exposes no HTTP client,
inbound USB callback, Socials email, or cryptographic API. No wireless relay
is available with only one badge. Do not mistake these host-tested snapshots
for a completed live transport or hardware-tested release.

## Legacy local build

The installable app is an offline practice app using the six requested
markets in `prisma/selected-markets.json`, shared with the web database seed.
Arm wrestling is deferred. Version 0.8.0 uses a separate `paper_v2` save and
fresh 1,000 local balance; the old `paper_v1` wallet and holdings stay untouched.
It does not transfer old positions into unrelated questions or modify cloud
accounts. All six start at a neutral 50%, not a researched probability.
Existing valid `paper_v2` balances and holdings are preserved, including wallets
created with the previous 10,000 starting balance.
Database-backed history/account integration remains pending.

## First-launch username

On first launch, choose a 3–12 character display name using the D-pad keyboard.
A selects, B deletes, and DONE saves. Lowercase letters, digits and underscore
are supported. The name appears above the balance in the top-right header on
every normal screen. Account → Edit username opens the picker again; Start
cancels an edit. Initial setup cannot be skipped with Start.

The name is stored under the app-scoped `username_v1` key. It is local, not a
verified login or a globally reserved username. Existing balances and holdings
are unaffected. Native app sharing excludes personal save data, so recipients
choose their own names. Cloud uniqueness and account linking remain pending.
A failed save keeps the picker open rather than pretending setup succeeded.

## Build and install

```sh
python3 badge/scripts/build.py
# Optional: python3 badge/scripts/build.py --output /absolute/release/path
```

Import `badge/dist/goosey.lua` into https://badge.hackthenorth.com/ide/.
Choose image → select `goosey-logo.png` from the build output (the original
`public/brand/goosey-mark.png` logo). The IDE converts it to the required 42×42,
5,304-byte `icon.bin`. This separate asset overrides the GSY text fallback.
Connect → choose the badge's serial device → Push → open Goosey on the badge.
Use the existing `goosey_base` slug to preserve the per-app practice store.
Version 0.3.1 fixes the observed 48 KiB compile-time Lua memory error by using
the supported 96 KiB ceiling and incremental garbage collection on entry and
600 ms idle ticks. Generated source omits comments/indentation to reduce buffers.
USB upload, cold launch, market detail and ticket navigation were verified on
the connected badge. At the ticket screen: system free 24,632 bytes, largest
block 8,704 bytes. This is a smoke test, not a long-running stress test.
Exit Goosey to the home screen before Push: reloading while it was running
caused a firmware abort/reboot. Reopening after reboot succeeded.
Radio and custom font rendering remain unverified.

The builder checks `market-order-v2.json`: changing/removing/reordering a market
requires a deliberate migration because `paper_v2` uses positional holdings.
It refuses to silently reinterpret another market's holdings.

## Controls

| Screen | Controls |
|---|---|
| Markets | Up/down select, A opens |
| Detail | Left/right select YES/NO, A trades, B returns |
| Ticket | Up/down select field; left/right adjust; A advances or opens Review; B returns |
| Review | A confirms once, B edits |
| Settings | Up/down select, A opens, B resumes |
| Portfolio | Up/down select, A opens market, B settings |
| Account | A edits username, B settings |
| Everywhere | Start opens/closes Settings; firmware HOME exits the app |


Practice trades use local cent-rounded, fee-free simulation. Connected trading
will use server milli-feather quotes and idempotent commits instead. No local
balance or graph is presented as a shared server portfolio. The selected six markets have no order-book screen. Green LEDs mean **local practice save**, not cloud receipt.

## Connected foundation (not wired into the installable app)

- `src/sync.lua`: bounded public snapshot/delta reducer; detects stale data,
  replay, gaps and changed catalogs. Authentication/decoding must precede it.
  Version 1 supports up to 16 markets; no account data or order mutations.
- `gateway/sse.mjs`: bounded UTF-8 SSE reader and single authenticated fetch
  connection, backpressure through awaited callbacks, Last-Event-ID resume,
  and cursor advancement only after application/checkpoint success. It is a
  library, not a deployed gateway daemon. The caller must implement durable
  checkpoints, reconnect/backoff/heartbeat timeout, snapshot reconciliation
  and POST authorization before production use. No endpoint exists yet.
- `tests/`: Lua host mocks and sync reducer tests; built-in Node tests for SSE.

Next milestone is a two-badge/USB round-trip proof, followed by the durable
server outbox/SSE endpoint and authenticated wireless pairing. The official
guide exposes `badge.radio.on_recv` and 44-byte broadcasts, but filters out
system bump/sync frames. Native tapping cannot be intercepted by Lua. Inbound
USB messages to running relay Lua, secure device identity, and email magic-link
login remain unimplemented. Do not connect raw radio packets directly to trading.

## Tests

Python 3 plus pinned `lupa==2.8` and `Pillow==12.3.0` are used only for host tests.
The layout renderer defaults to macOS Arial; on Linux set `BADGE_TEST_FONT` to
an installed compatible TTF. `BADGE_OUTPUT` optionally selects a build directory.

```sh
python3 badge/scripts/build.py
python3 badge/tests/test_app.py
python3 badge/tests/test_sync.py
node --test badge/gateway/sse.test.mjs
```

Rendered screenshots are approximate 320×240 layouts, not physical badge captures.
Dependencies of the website are not needed for these checks.

## Upstream review

Baseline advanced from b668f4d to dd26256. Upstream adds order-book bulk cancel,
public trade tape, private fills/history, recovery UI and chart fixes. Seed data,
LMSR trade service and core auth were unchanged in that range. The email pairing,
SSE + POST and gateway architecture still applies; ORDER_BOOK remains deliberately
view-only in the badge release. Web email verification is not passwordless login.

The clean upstream `npm ci` currently fails with missing `@emnapi/core` and
`@emnapi/runtime` lock entries. No package/lock changes are included here. A
no-lockfile, ignore-scripts local install succeeded for inspection; it is not
evidence of a reproducible web build or passing backend integration tests.

## Socials email and requested font

The desired account email is the one already saved in the badge Socials app.
The official stock Lua API deliberately excludes email/phone/socials from both
badge.me and contacts. Do not substitute badge_id for verified email. Reusing
Socials email requires an organizer-supported, user-consented identity API;
this integration is not implemented. Existing email-link explanation is only
placeholder UI, not an authentication flow.

Pokemon Red/Blue-style typography is requested but not implemented. Stock Lua
only exposes built-in font sizes, not custom font loading. A bitmap renderer
or firmware font binding is needed; avoid adding hundreds of glyph widgets
without memory profiling on hardware. Current body text uses native fonts.

## Latest upstream integration

Merged master c26990d. Upstream now defines a replacement catalog in
`prisma/htn-2026-markets.ts`, with explicit closing timestamps and editorial
opening probabilities. The installed badge still uses the original catalog,
now pinned in `catalog-v1.json`, because `paper_v1` positions are indexed.
Rebuilding after pulling must not silently attach holdings to new questions.
A deliberate slug-based migration is required before switching badge catalogs.
This pin preserves the exact previously tested build; it does not supply live
history, volume, or closing timestamps. Price history currently lasts only for
the open app session; balance and holdings persist across launches.

Version 0.7 supersedes the legacy-catalog pin described above. The old catalog
is retained for recovery only; new builds use the shared selected-markets file.

The three stage markets append to the initial paper_v2 catalog. Existing
three-market balances and holdings are read unchanged; new positions start at
zero, and the next successful trade saves the expanded record. The initial
three-slug prefix is checked at build time. No live database is changed by a
build, and the seed does not remove existing markets.
