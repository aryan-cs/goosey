# Approved six-market launch

`prisma/selected-markets.json` contains the six user-approved closing-ceremony
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

The September 19 launch was authorized for `bowenzhu21` on the `goosey-test`
Vercel project and its separate Neon database. The explicit one-time Vercel
build override runs the launcher after the build, using protected database
environment variables. The normal committed build command does not run it.

Local verification: six OPEN markets, one promotion audit record, zero trades,
and no duplicate creation on a second run. Automated tests also cover inactive
accounts, non-participant roles, repeated promotions and concurrent changes.
