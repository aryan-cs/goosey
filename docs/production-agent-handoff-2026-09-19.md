# Goosey production handoff — September 19, 2026

Please finish deploying and verifying the platform changes below. This is a
handoff for the agent with access to the production Vercel project and Neon
database. Do not assume a GitHub push updated the deployed website, or that a
code deployment updates existing market records.

## 1. Establish the deployment and database baseline

- Repository: https://github.com/aryan-cs/goosey, branch `master`.
- Vercel project: `goosey`, team `bowens-projects-b0c91e9e`.
- Production: https://getgoosey.vercel.app.
- Existing Neon resource: `goosey-test`. Despite its name, it contains real
  website accounts and market activity. Preserve it.
- Record the currently deployed commit and compare it with the intended release
  commit. Production state has not been freshly reverified for this handoff;
  the items below are implemented locally or requested, not a claim that every
  item is still absent from production. Skip work already correctly deployed.
- Use a clean checkout. The originating checkout has unrelated in-progress
  Solana/security changes; do not upload its uncommitted working tree.
- Before database writes, record the branch/database identity, check migration
  status, and establish a recoverable backup/restore point. Keep credentials out
  of logs, commits, screenshots, and the handoff response.
- Read `AGENTS.md`, `docs/vercel-deployment.md`, and the relevant installed
  Next.js guides before implementation. Read the current scripts before running
  them: this is a moving shared repository.

## 2. Deploy the community and leaderboard fixes

Relevant commits: `8f4c433` (community visibility and refresh), `1133362`
(mandatory leaderboard). Equivalent earlier community commit: `853a7b0`.

### Community

- Public market comments must appear in `/community` even when the author's
  profile is private. Previously the feed incorrectly filtered those comments
  using profile visibility.
- Keep private profiles private; displaying a public comment does not authorize
  exposing private profile pages or account fields.
- Keep existing moderation/deletion restrictions.
- Community and leaderboard refresh approximately every 15 seconds while
  visible, with refresh on returning to the page. This is polling, not a promise
  of instantaneous push delivery.
- Verify with two independent browser sessions: a real comment visible on its
  market should also appear in the community feed without a manual reload.

### Leaderboard

- All active ordinary player accounts participate, including players who have
  not traded. Ignore the legacy `leaderboardVisible` preference.
- Remove the visibility toggle and reject attempts to change it through the
  profile API. A direct API request must not restore the opt-out.
- Admin/system/inactive accounts are excluded by the current implementation;
  profile privacy remains separate from leaderboard participation.
- Rank using cash plus reserved cash plus current open-position value, minus
  actual welcome grants. Do not inflate rank with the 1,000 starter feathers.
- No bulk rewrite of the old visibility column is necessary.
- **Remaining gap discovered during handoff:** `/leaderboard` calls
  `getLeaderboardRows(100)`. Everyone is eligible, but only the top 100 are
  displayed. To fully satisfy “everyone shows up,” add pagination or another
  complete browsing mechanism, preserving global rank and stable ordering.
  The home-page top-eight preview can remain limited.
- Verify an account whose old opt-out is false still appears, a new untraded
  player appears at the appropriate rank, and a trade updates ranking across
  browser sessions. Check the beyond-100 case on an isolated test database.

## 3. Publish the first-dance group in production

Relevant commit: `e5d540b`. Full instructions: `docs/first-dance-markets.md`.
Definitions: `src/lib/dance-market.ts`.

- Group title: **Which dance will a winning team member do first?**
- Group URL: `/events/htn-2026-winner-first-dance`.
- Options: **Worm**, **Dab**, **Floss**, **None of these**.
- The user explicitly chose: **only the first qualifying dance wins**.
- Eligible performers are members of confirmed overall winning teams, on the
  closing-ceremony stage. Later dances do not change the result. Full rules cover
  sponsor-only winners, missing evidence, ties, and cancellation.
- Exactly one option resolves YES and three resolve NO, or all four VOID.
  “None” wins only when usable evidence establishes no qualifying dance.
- Named buy/sell controls operate each option's YES contract. Selling requires
  holdings. Quotes, holdings, history, and comments remain backed by real data.
- The current implementation groups four independent binary LMSR markets; it
  is **not** a normalized multi-outcome pricing engine. Prices may not sum to
  100%. Preserve the disclosure and do not normalize prices cosmetically.
- Deploy the resolution guards with the UI: they reject contradictory sibling
  decisions. Existing two-person approval and settlement accounting still apply.
  Settlement is per child, not atomic across the entire group.

With the intended PostgreSQL environment securely supplied to the shell:

```sh
node --import tsx scripts/publish-dance-markets.ts --system-operator
node --import tsx scripts/publish-dance-markets.ts --system-operator --apply
```

The first command previews; inspect it before applying. Standalone scripts must
receive their environment explicitly; do not assume Next.js loads `.env.local`
for a plain Node invocation. The script is idempotent and creates audited records.
It refuses conflicting existing definitions and missing-child publication after
close. Never bypass that deadline to create markets after an outcome is known.

The legacy `/markets/htn-2026-winner-stage-dance` asks a different question:
whether any qualifying dance happens. Preserve traded positions and original
terms. The publisher pauses only an untouched open legacy LMSR market, with a
concurrent-trade guard. Do not rename its ID into a child, move its positions,
or wipe/void it just to replace the UI. Verify the group is discoverable from
browse/navigation and the untouched retired original points to it.

Verify named option selection, stale-quote clearing on option changes, buy/sell,
holdings, and resolution guards in an isolated environment. Do not create test
trades or settle real production markets just for deployment QA.

## 4. Publish the University of Toronto market

Relevant commit: `f135597`. See `docs/selected-market-launch.md` and
`prisma/selected-markets.json`.

- Title: **Will a University of Toronto team win?**
- Slug: `htn-2026-all-toronto-team-wins`.
- Separate binary market, independent from Waterloo.
- Every listed member of at least one overall winning team must be enrolled at
  University of Toronto. Mixed-university teams and sponsor-only prizes do not
  qualify. Insufficient evidence resolves VOID under the published rules.
- Neutral 50% opening price is the configured starting quote, not past activity.

Preview and publish only this selected market:

```sh
node --import tsx scripts/launch-selected-markets.ts --system-operator --slug=htn-2026-all-toronto-team-wins
GOOSEY_CONFIRM_MARKET_LAUNCH=htn-2026-all-toronto-team-wins node --import tsx scripts/launch-selected-markets.ts --system-operator --slug=htn-2026-all-toronto-team-wins --apply
```

Do not run the full historical six-market launch to add this one market.
Verify rerunning does not duplicate it, and Waterloo remains unchanged.

## 5. Finish the requested “67” wording change against actual records

Relevant commit: `14965fe`. Requested title:
**Will a closing ceremony speaker do a 67?**
Existing slug: `htn-2026-mc-does-67`.

- The source catalog was changed, but the production screenshot still showed
  **Will the MC do a 67?**. Updating seed/catalog text does not rewrite a persisted
  market. Read the current production row before deciding what remains.
- Check title, short title, description, and resolution rules together. The
  requested wording broadens eligible people from the MC to any ceremony speaker;
  changing only the heading could misrepresent the existing contract.
- The legacy production market already had trading activity in the last observed
  state. Do not silently overwrite its settlement eligibility, reset its price,
  or recreate it with the same identity. Preserve trades, positions, comments,
  historical snapshots, collateral, and audit history.
- Prepare a concrete audited treatment of that traded contract for the owner:
  either an explicitly approved amendment with clear participant notice, or a
  separate broader contract while the old one retains its original terms.
  Report this decision as an outstanding dependency if it has not been made;
  do not claim a source-only rename completed the production request.
- Verify consistent wording in browse cards, detail title, trade ticket, and
  rules after the chosen treatment is applied.

## 6. Check market times and historical charts

- Current source definitions close Toronto and dance trading at
  **September 20, 2026, 14:30 America/Toronto (18:30 UTC)** and target resolution
  at **16:30 America/Toronto (20:30 UTC)**. The dance event starts September 18
  at 00:00 America/Toronto. Validate these against the intended ceremony schedule
  and existing published terms; a screenshot's timezone is not proof of an error.
- Do not change traded contract deadlines silently or reopen after known results.
- Include and verify the existing chart/activity improvements as applicable:
  `bb301c5` automatic visible-page activity refresh; `c734877` chart coverage from
  event start with labeled opening-price holds; `e6018a3` hourly horizons and
  five-position range selector; `301d172`, `d0c3ef8`, `3649262` trade attribution,
  volume alignment, and ticket spacing.
- Display real stored probability history and actual timestamps. Labeled opening
  holds must not be presented as executed trades. Do not import development
  history to make new live markets appear older or more active.

## 7. Confirm public signup/login and production configuration

Relevant commits include `3cc59fa` (immediate signup) and `619b017` (concurrent
welcome-grant checks). Recheck current implementation and deployment.

Production configuration should use:

```dotenv
DATABASE_PROVIDER=postgresql
APP_URL=https://getgoosey.vercel.app
NEXT_PUBLIC_APP_URL=https://getgoosey.vercel.app
EMAIL_VERIFICATION_URL=https://getgoosey.vercel.app/verify-email
PASSWORD_RESET_URL=https://getgoosey.vercel.app/reset-password
REQUIRE_EMAIL_VERIFICATION=false
STARTING_FEATHERS=1000
GOOSEY_DEPLOY_MIGRATIONS=0
```

- Privately configure the existing `POSTGRES_DATABASE_URL`, or supported
  `NEON_DATABASE_URL` fallback, and a stable nonempty `AUTH_SECRET`. Never put
  PostgreSQL credentials in `DATABASE_URL`; that variable is reserved for SQLite.
- Do not casually rotate existing production secrets. Dedicated token/rate-limit
  secrets must be nonempty if set; otherwise leave unset to use the auth fallback.
- A normal visitor should sign up, receive a usable session and exactly one
  welcome grant, and sign back in without an email-verification prerequisite.
  This does not mark their email as verified. Check existing unverified accounts
  can log in and receive only any genuinely missing grant.
- Password-reset email needs real SMTP. Last verified deployment had no SMTP.
  If email is part of this release, configure host, port, TLS, user/password, and
  sender, then verify actual delivery and one-time reset. Otherwise report reset
  email as unavailable; do not claim all auth recovery works.
- Use isolated tests for repeat signup/grant cases. Any live smoke account must
  be an agreed real QA account, not bulk synthetic users or invented activity.

## 8. Supply localhost access to a separate real-data development branch

- Create a Neon development branch from the actual production branch with
  current data, e.g. `aryan-local-dev`. Confirm parent, database, branch identity,
  and expiration policy. It is a snapshot, not continuous synchronization.
- Securely provide its pooled connection URL. No production write access from
  Aryan's local environment is assumed or newly authorized by this handoff.
- On Aryan's computer the existing gitignored destination is
  `/Users/aryan/Desktop/projects/goosey/.env.local`. Do not commit it or print it.
- The branch URL and local auth secret were blank when this handoff was prepared.
  Generate an independent local secret, e.g. `openssl rand -hex 32`; production's
  auth secret is not required for the isolated branch.

```dotenv
DATABASE_PROVIDER=postgresql
POSTGRES_DATABASE_URL="<development branch pooled URL>"
AUTH_SECRET="<independent local secret>"
APP_URL=http://localhost:8080
NEXT_PUBLIC_APP_URL=http://localhost:8080
EMAIL_VERIFICATION_URL=http://localhost:8080/verify-email
PASSWORD_RESET_URL=http://localhost:8080/reset-password
REQUIRE_EMAIL_VERIFICATION=false
STARTING_FEATHERS=1000
GOOSEY_DEPLOY_MIGRATIONS=0
```

- Restart the local server after configuring it; verify schema compatibility and
  real copied records. The previous local server used SQLite and was not connected
  to the live database. A new app account alone does not change that connection.
- Local users must sign in separately. Changes in either branch do not automatically
  appear in the other. Leave synthetic development servers/imports disabled.

## 9. Keep the shared development fixture available, out of production

The earlier requested synthetic dataset and usage documentation are already in
`fixtures/synthetic/three-months/`, the root README, and
`docs/development-sandbox.md`. They include varied trader handles, market
lifecycles, executed development trades, probability history, and reset/import/
export workflows. Preserve this team resource, but do not load it into the live
database or the requested real-data localhost branch. Do not run `db:seed`,
`db:push`, fixture import, or database reset against production. The request to
reset synthetic development data before launch never authorized deleting real
accounts or trades already on the website.

## 10. Release checks and operational follow-through

1. Pick and record the intended release SHA. Review all intervening changes;
   `master` also contains concurrent wallet/Solana/badge work. Do not enable or
   describe those integrations as production-ready just because they are merged.
   Consult `docs/solana-wallet-integration.md`, `docs/solana-migration.md`, and the
   current README for their separate release gates. No MongoDB migration is part
   of this PostgreSQL deployment request.
2. Install locked dependencies and run the repository checks appropriate to the
   selected release. At minimum run lint, typecheck, tests, and build; inspect
   failures rather than assuming the previous local pass covers a newer SHA.
3. Check PostgreSQL migration status. Rehearse needed additive migrations on the
   development branch first. `GOOSEY_DEPLOY_MIGRATIONS=0` prevents automatic build
   migration; it does not block manual scripts. Use the documented migration
   deployment path when needed, never destructive schema synchronization.
4. Deploy to the correct Vercel project and verify the production alias points to
   that exact release. GitHub auto-deployment was not established in the earlier
   setup; verify its current status rather than assuming a push deployed.
5. Preview and apply only the intended publication/editorial changes above.
6. Verify `/api/health`. Check `/api/ready` and explain any worker dependency:
   Vercel deployment alone does not supervise the settlement worker. Follow
   `docs/settlement-worker-operations.md` for the actual continuous worker setup.
7. Verify desktop/mobile UI and independent signed-in/signed-out sessions:
   signup/login, leaderboard inclusion and refresh, public comments across pages,
   new market discovery, dance options, correct times and real chart data.
   Close temporary verification tabs when done.
8. Keep financial execution, concurrent grant, and settlement stress tests on an
   isolated database. Relevant focused checks include leaderboard/profile/community
   tests, dance resolution tests, and `scripts/dance-market-e2e.ts` (which creates
   its own temporary SQLite database). Reconcile affected accounting using the
   documented read-only checks after authorized operations.

## Required completion report

Return the deployed SHA, Vercel deployment URL, confirmed production domain,
database/branch identity without credentials, migration results, market slugs
created or updated, how the legacy traded contracts were handled, verification
evidence, and remaining blockers. Explicitly distinguish code deployed, database
records published, and features verified. Report SMTP, worker readiness, the 67
contract decision, and leaderboard pagination honestly if any remain unfinished.
Share local connection credentials privately, never in that report.
