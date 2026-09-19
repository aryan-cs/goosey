# Trading integration checkpoint — 2026-09-19

`npm run test:orderbook` passed against a fresh, temporary SQLite database.
It then backed up, restored, compared logical contents, and reconciled the
restored database: 56 journals, 47 accounts, 13 users, 6 markets, 29 orders,
29 reservations, and 7 fills. The script removes its temporary database directory
when it exits; it does not reset the shared development database.

The integration exercises real exchange services and ledger-backed participant
funding. It verifies participant-side YES/NO fill notices, no notice for an
unfilled resting order, and no duplicate notice on replay. An injected database
trigger rejects notification insertion to verify that the entire fill and its
accounting effects roll back. The expected database error in that case is not a
failed integration run.

Additional checks cover replacement priority, bounded bulk cancellation with
one command per market, preserving other participants' orders, empty-book market
creation, suspended/privileged maker exclusion, executable depth valuation versus
actual sale proceeds, reserved-cash leaderboard equity, and paginated personal
execution history. Completed fills are bounded by the captured public trade
sequence so concurrent fills cannot appear ahead of the response's watermark.

HTTP trading mutations now pass their request session into the exchange or
trading service. Session validity is checked within the financial transaction,
before a stored result can be replayed or a balance changed. Internal worker and
test callers remain separate from HTTP authentication and still undergo the
services' participant and market checks.

This checkpoint's focused unit run passed 73 tests across nine files. It is not
a claim of hosted deployment readiness or a production load test.
