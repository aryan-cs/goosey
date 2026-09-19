# Admin workflow verification — 2026-09-19

The isolated HTTP journey now exercises actual administrator actions rather
than only participant denials:

- Issue an invitation, replay the same ID/code, reject a changed request under
  the same key, verify list responses omit token material, revoke twice, and
  verify persisted revocation.
- Review a participant suggestion, verify its status and review note in the
  participant view, and ensure a repeated review cannot create another notice.
- Hide a reported comment, verify removal from the public feed and a one-count
  decrease, then reject repeated review without another decrement or notice.
- Create/update event groupings and markets with version/idempotency checks.

`npm run test:e2e` passed these checks against a temporary database and loopback
production server. The runner uses an ephemeral port, fresh token/rate-limit
secrets, and disabled SMTP configuration. Its restored database passed logical
comparison and reconciliation (10 journals, 12 accounts, 2 participant users,
8 markets). Nothing was reset on the shared localhost:8080 database.

The separate LMSR settlement journey and the YES/NO/VOID order-book settlement
journey passed. The latter's restored database reconciled 25 journals,
19 accounts, 6 participants, 3 markets, 12 orders/reservations, and 3 fills.
Checks include approval separation, replay, multi-batch recovery, and worker
fencing. Full source lint passed; the full unit suite passed 956 tests with one
skipped test.

These are local functional and regression checks, not a production deployment
or comprehensive security certification. Service-backed admin routes recheck
the session after reading the body, and their services check active-admin status
inside the transaction; unlike direct moderation/invitation writes, the session
check itself is not inside those service transactions.
