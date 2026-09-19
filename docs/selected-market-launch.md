# Approved market catalog launch

`prisma/selected-markets.json` contains the user-approved Hack the North
markets. The launch uses `createAdminMarket` so ordinary pricing, collateral,
ledger, rate-limit, and audit checks still apply. No orders are placed.

Preview against the intended database:

```sh
node --import tsx scripts/launch-selected-markets.ts --username=bowenzhu21
```

Applying requires `--apply` and `GOOSEY_CONFIRM_ADMIN_USERNAME` matching the
exact username. Obtain explicit account-owner approval before using this: it
promotes the existing active account to ADMIN and records an audit event.
It never creates a user, changes a password, or marks an email verified.
Existing matching slugs are preserved; conflicting definitions stop the run.
Each creation uses a stable idempotency key. Reruns do not duplicate markets.

The original September 19 launch was authorized for `bowenzhu21` on the `goosey-test`
Vercel project and its separate Neon database. The explicit one-time Vercel
build override runs the launcher after the build, using protected database
environment variables. The normal committed build command does not run it.

Local verification for that launch: six OPEN markets, one promotion audit record,
zero trades, and no duplicate creation on a second run. Automated tests also cover inactive
accounts, non-participant roles, repeated promotions and concurrent changes.

## Launch without a participant account

Use `--system-operator` instead of `--username`, with `--apply` and explicit
`GOOSEY_CONFIRM_MARKET_LAUNCH=selected-market-catalog-v2` for the full approved catalog.
This provisions a dedicated private admin audit principal with a discarded
random login secret and an invalid delivery address, not a participant account.
No personal account is promoted. Existing operator identity must match its
provisioning audit. The normal market service creates and funds the markets.
A real SQLite rehearsal verified replay safety, six markets, one operator,
no issued sessions and no trades.

## University of Toronto market

The catalog also includes `htn-2026-all-toronto-team-wins`: **Will a University
of Toronto team win?** Like Waterloo, every listed member of at least one overall
winning team must be enrolled at that university; mixed-university teams and
sponsor-only prizes do not qualify. It uses the same close/result schedule and
neutral 50% opening price. The two university markets settle independently.

Publish only this new contract, without revisiting or changing other markets:

```sh
node --import tsx scripts/launch-selected-markets.ts --system-operator --slug=htn-2026-all-toronto-team-wins
GOOSEY_CONFIRM_MARKET_LAUNCH=htn-2026-all-toronto-team-wins node --import tsx scripts/launch-selected-markets.ts --system-operator --slug=htn-2026-all-toronto-team-wins --apply
```

Configure the intended database privately first. The first command previews;
the second uses the normal audited creation service. Exact slug selection rejects
unknown names and avoids unrelated existing-market differences. Rerunning does
not duplicate the contract. Fresh seeds automatically include this market.
