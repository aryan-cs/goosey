# Market forecast and portfolio API contract

Market listings, discovery, calendar, search, event pages, and market-detail APIs
use the shared market-mark loader. A response's market rows and their marks are
read from one serializable snapshot.

`probabilityYesBps` is an integer from 0 to 10000, or `null` when no mark exists.
Zero is a genuine mark, not an absent value. Consumers must display the absence
of a price instead of substituting 50%. `probabilitySource` identifies `LMSR`,
`MID`, `LAST`, `SETTLEMENT`, or `NONE`; `probabilityStale` describes the mark's
freshness. A mark is not a promise that any particular quantity can execute at
that price.

Order-book chart history contains actual committed fills, converted using each
market's contract payout. It does not use equal YES/NO inventories or an initial
LMSR snapshot as a price, and does not append the current midpoint as a trade.
Listing/discovery histories are chronological. Discovery excludes markets
without a mark from the movers list. Final or approved settlement outcomes use
their payout marks, including during batched settlement.

History queries preserve execution sequence for fills sharing a timestamp.
Downsampling retains that tie order and always keeps the latest observation;
when the budget is at least two points it retains the first as well. A
three-point response keeps the endpoint pair and the interior observation with
the largest deviation from their connecting line.

The portfolio API distinguishes spendable `cashMilli`, order-backed
`reservedCashMilli`, and `positionValueMilli`. Equity includes all three, while
`totalCashMilli` includes spendable and reserved cash only. Position values use
available executable depth rather than the displayed probability. Unfillable
remainders are exposed through `unfilledYesShares` and `unfilledNoShares`.
All monetary `*Milli` values are serialized as decimal strings, not JavaScript
floating-point numbers.

Public order-book ETags identify the complete returned representation. An order
may expire before the worker advances its sequence, so sequence alone cannot
serve as a response validator. Order-book responses remain non-cacheable.

Regression coverage lives in the forecast API, order-book route, market-mark,
portfolio, and history test suites. Shared localhost read-only checks of market
listing, discovery, and calendar returned HTTP 200 on 2026-09-19. These checks do
not establish production load capacity.
