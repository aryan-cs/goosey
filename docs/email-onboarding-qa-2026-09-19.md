# Email-to-trade integration verification

`npm run test:email:onboarding` runs against the current production build. Run
`DATABASE_PROVIDER=sqlite npm run build` first. It requires Node, OpenSSL and the
generated Prisma clients, but no SMTP account, external mailbox or running
development server.

## What the runner exercises

- Creates its own temporary SQLite database and provisions only the system and
  administrator fixture identities out of band.
- Starts the built web application on an ephemeral loopback port, with a local
  HTTPS proxy and a separate implicit-TLS SMTP receiver.
- Generates a one-day certificate and trusts it only in the test clients and
  child process. Production certificate validation stays enabled. Nothing is
  added to system trust, and mail never leaves the loopback receiver.
- Registers two participants through HTTP; both initially have zero feathers
  and cannot access the protected portfolio.
- Requests verification through the real endpoint, receives the actual MIME
  messages sent by Nodemailer, and extracts the one-time fragment links. It
  never inserts account tokens or directly verifies/funds participants.
- Confirms both links, rejects replay, and checks one welcome grant per account.
  An unknown email receives the same generic response but creates no token/mail.
- Creates a real order-book market through the administrator endpoint. The two
  verified participants buy complementary YES/NO contracts, producing one fill.
  Retrying both placements does not duplicate the orders, fill or economic work.
- Delivers and consumes a real password-reset email, rejects reuse, revokes two
  old sessions, rejects the old password and restores portfolio access with the
  new password without changing cash or positions.
- Rejects an SMTP delivery, verifies the API reports delivery unavailable and
  removes the undelivered token, then accepts a successful retry.
- Stops the web process and reconciles journals, wallets, positions, market
  collateral and order reservations. Finally removes its temporary database,
  certificates and processes.

## Observed result

The local run on 2026-09-19 passed with two verified participants, four received
TLS emails, one fill, two replayed placements and two revoked sessions. Final
reconciliation passed for five journals, six accounts, two participant wallets,
one market, two orders and two reservations.

The integration rerun uses the current 1,000-feather welcome grant. Two contracts
cost 80 and 120 feathers respectively, leaving 920 and 880 feathers. Assertions
require explicit acceptance, identical order IDs and complete replay responses,
and exactly two persisted orders, in addition to checking balances and fills.
The stricter journey passed against a freshly built production application.

The current account browser rerun passed all 18 desktop/mobile cases across
navigation, password reset, and verification handoff. Its watchlist navigation
test now chooses a real public market from the disposable database instead of
depending on an obsolete seeded slug. The mobile verification screen was also
visually inspected. Nine new password-reset confirmation route tests verify
cookie clearing, no-store responses, invalid tokens, malformed input, and safe
unexpected-error handling.

## Verification-link recovery

Reopening a consumed link previously showed only the invalid-link/resend flow,
even when the current session was already verified. Resending for an already
verified account intentionally sends no mail, so this was a dead end. The page
now checks the current session independently and offers **Continue** when that
session is verified, while still reporting the link as rejected. A signed-out
visitor gets a sign-in link preserving the intended destination. No token owner
identity is inferred or exposed, and no additional feathers are granted.

Initial delivery failures no longer display an unconditional claim that an
email was sent. The initial delivery status also survives React's development
effect replay until it has actually been displayed.

All ten desktop/mobile cases in `tests/browser/verification-handoff.spec.ts`
passed on a separate fresh database: normal signed-out handoff, consumed link
with its owner signed in, another verified account signed in, signed-out
recovery, and initial delivery failure. Desktop and 390px mobile recovery
screenshots were visually inspected; the mobile document had no horizontal
overflow. Full regression checks passed: 608 unit/integration tests, one
intentional skip, lint, typecheck and an explicit-SQLite production build.

## Limits

This checks real API/SMTP integration, not public email deliverability or a
provider's credentials, reputation, spam handling or outage behavior. A real
deployment still needs an operator-supplied SMTP provider and HTTPS origin;
the test receiver is not a development verification bypass or a production
mail service. No production credentials are bundled. Browser navigation and
responsive layout are separate checks. CI now invokes this journey after its
API E2E, but that hosted execution has not yet been observed.
