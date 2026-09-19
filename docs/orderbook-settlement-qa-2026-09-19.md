# Order-book lifecycle verification — 2026-09-19

`npm run test:orderbook:settlement` runs real services against a disposable
SQLite database, then snapshots, restores, compares logical records and
reconciles the restored accounting state. CI wiring is maintained separately
from this local runner. It does not mutate the development database.

For each of YES, NO and VOID:

- Create an unfunded order-book market and journal-funded participants.
- Match actual YES and NO buys, creating collateral-backed contracts.
- Leave both a cash-reserving buy and a share-reserving sell open.
- Close through the administrator lifecycle service and verify exact refunds,
  released shares and no remaining active orders/reservations.
- Advance only the disposable fixture's eligibility dates after closing; use
  two distinct, unexposed administrators to propose and approve resolution.
- Process one position per batch, complete settlement, then replay completion.
- Check that approved equity stays constant before, between, and after payout
  batches, as holdings become cash rather than temporarily losing value.
- Check exact participant payouts/net balances, once-only settlement records
  and notifications, zero remaining shares/collateral, and balanced journals.

All three outcomes passed. The restored state matched the archive's logical
contents and reconciled: 25 journals, 19 accounts, 6 participants, 3 markets,
12 orders, 12 reservations and 3 fills.

## Corrections found by this work

1. Lifecycle command keys lacked market identity. Closing a second market at
   the same version with the same organizer could collide with the first
   market's command. Keys now include market ID; the real three-market run
   uses the same creator to close all three markets.
2. VOID payout validated the sum of YES and NO quantities against a per-outcome
   cap. A valid 6,000,000 YES plus 6,000,000 NO position could therefore stall.
   Validation now applies to each side independently and combines bigint
   numerators before dividing once, preserving legacy rounding. Boundary unit
   tests cover both sides at their cap and indivisible legacy payouts.
3. Positions awaiting approved settlement previously fell back to closed-book
   liquidation value. Winning-only positions could therefore show zero until
   paid. RESOLVING positions now retain their approved YES/NO/VOID payout and
   final probability. The shared loader applies this to both pricing models;
   the real batched order-book journey verifies equity continuity.

The existing market-maker settlement suite also passed, including bounded
batches, interrupted-worker recovery, stale-lease fencing and replay. These
checks are not a PostgreSQL load test or production release certification.
