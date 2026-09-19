# Production release results — September 19, 2026

## Deployment

- Production: https://getgoosey.vercel.app
- Deployed source SHA: `bcd103ecafbd1de57af7d1fda4c4e32dc476850c` (clean committed checkout at deployment).
- Vercel deployment: `dpl_FoRBcuo1bT3Nqp4TWYpkHEgg1UDg`, state READY, target production.
- Immutable deployment URL: https://goosey-p0zjrxyy4-bowens-projects-b0c91e9e.vercel.app
- Vercel inspection confirmed the getgoosey.vercel.app alias.
- Later documentation/fixture commits and concurrent upstream commits are not automatically part of this deployment.

## Published database records

New market slugs:

- `htn-2026-closing-speaker-does-67`
- `htn-2026-all-toronto-team-wins`
- `htn-2026-winner-first-dance-worm`
- `htn-2026-winner-first-dance-dab`
- `htn-2026-winner-first-dance-floss`
- `htn-2026-winner-first-dance-none`

Grouped event: https://getgoosey.vercel.app/events/htn-2026-winner-first-dance

The broader speaker contract is separate. The existing `htn-2026-mc-does-67` contract retains its MC-only title, rules, trade, position, comment and stored history. Reciprocal notices explain the distinction; an audit entry links the separate publication. No existing holder was moved into a broader contract.

The original `htn-2026-winner-stage-dance` had no trades, positions or volume and was paused by the guarded publisher. It was not deleted. The four new options settle as one YES and three NO, or all VOID if evidence cannot resolve the first qualifying dance. They use independent binary prices; the event page explicitly says prices need not total 100%. Waterloo remains separate from Toronto; the all-listed-members/overall-winning-team rules apply.

The database inspection after publication found 12 markets, 7 accounts (6 players and one administrator), and 6 welcome grants. Subsequent public leaderboard inspection found a seventh active player; production remains open to real signups. No test orders or test comments were submitted to production.

## Verification

- 132 unit-test files passed: 1,478 tests passed, one skipped.
- Typecheck, lint, production build, schema/migration checks passed.
- Three PostgreSQL migrations applied, including the additive wallet-link migration. Normal deployment migrations now explicitly disabled (`GOOSEY_DEPLOY_MIGRATIONS=0`); no schema reset.
- Real isolated dance settlement E2E passed, including first-dance settlement guards and ledger checks.
- Real isolated badge auth/BUY/SELL/idempotency/revocation E2E passed; host Lua/gateway checks passed. These are not a claim of a successful live hardware order.
- `/api/health`: HTTP 200, database reachable.
- `/api/ready`: HTTP 503, `WORKER_MISSING`; no expired-market or settlement backlog at check time.
- Public leaderboard API pagination returned correct totals/global ranks; unit coverage exercises 123 players and the page beyond 100. All active players are included, including untraded accounts, and starter grants are excluded from PnL. No profile/API opt-out remains.
- Two separate browser contexts (Chrome and in-app browser), on isolated localhost data: a comment posted through the real API appeared automatically in both without reload. A new untraded account then appeared automatically on both leaderboards (24 → 25 players). No manual refresh button was used.
- Production signed-out community displayed a public comment by a private-profile author without a profile link. Automated policy tests cover private profiles and moderated comments.
- Production dance event visibly showed Worm/Dab/Floss/None, named Buy/Sell controls and the independent-price notice. Switching to Floss changed the ticket and rules to Floss without submitting an order.
- Public registration/login is configured without invitation or email-verification gates; production `STARTING_FEATHERS=1000`. Existing isolated signup/ledger tests verify the single welcome grant. The synthetic sandbox intentionally uses a larger development balance; its new-account test is not evidence of the production grant amount.
- APP_URL and NEXT_PUBLIC_APP_URL are https://getgoosey.vercel.app; provider is PostgreSQL.
- Official participant schedule at https://my.hackthenorth.com/schedule displayed Sunday closing ceremonies 2:30–4:30 PM, explicitly EDT. Market close 2026-09-20T18:30Z and expected resolution 20:30Z agree. Historical trades were not fabricated or backfilled.

## Database isolation and recovery

Neon project: `round-mud-98593510` (console name goosey-test; nevertheless its main branch serves live users).

- Production main: `br-misty-band-avav3pks`.
- Recovery copy before publication: `pre-release-2026-09-19`, `br-curly-dew-avzfuhg3`; expires September 26 at 4:04:41 PM EDT.
- Development copy after publication: `aryan-local-dev`, `br-shy-sound-avbfzkbz`; no automatic deletion.
- New `goosey_local` role exists only on the development branch, with data read/write and sequence access, not schema-administration privileges. Its pooled connection was verified as that role: 7 accounts and 12 markets.
- A separate local auth secret and development-only pooled URL were delivered as encrypted output and saved in an ignored mode-600 local environment file. No production credential was exported. No credentials belong in this report or GitHub.
- Local private file: `output/development-access/aryan.env.local`. Bowen must transfer it privately to Aryan's Mac as `/Users/aryan/Desktop/projects/goosey/.env.local`; this agent cannot write to that other computer. Do not replace the database URL with production or run migration/write tests against main. Schema changes on the dev branch require a deliberate owner migration.
- Shared synthetic fixture remains in GitHub. Its schema fingerprint was revalidated after additive empty wallet-link tables; no fixture account, trade or history data changed. Fresh isolated import and post-browser-test reconciliation passed (2,721 balanced journals). It was never imported into Neon production or the real-data development branch.

## Remaining blockers

1. A continuously hosted settlement worker is missing. Deployment alone does not run the long-lived worker. Provision a supported worker host using the documented production environment, then verify `/api/ready` and worker heartbeat. Trading pages being up is not settlement readiness.
2. SMTP is not configured. Ordinary signup/login works without verification; password-reset email cannot be claimed operational until an actual provider is configured and delivery tested.
3. Badge 0.10 modular app and deployed account/trading APIs are implemented, but physical authenticated trading awaits the user's matching-code account link. The USB gateway subsequently stopped on a console timeout and the console no longer answered a probe. Reconnect/power-cycle the badge before resuming hardware verification. Stock Lua does not expose a verified Socials email identity or direct internet transport; a Mac USB gateway remains necessary with one badge. No live trade was submitted.

Badge release bundle saved locally under `../../outputs/goosey-badge-0.10.0-usb.zip`, without account tokens, appdata, or private credentials.
