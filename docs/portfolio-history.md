# Participant trade history

`GET /api/portfolio/history` returns only the current authenticated participant's
executions. All responses, including errors, are private and non-cacheable.
The endpoint accepts `limit` (1–100, default 30) and an opaque `cursor` returned
by the previous page. Repeated or unknown query parameters are rejected.

Each item includes a source-prefixed ID, market link information, outcome,
BUY/SELL action, quantity, gross amount, fee, execution time, and pricing source.
Money is serialized as decimal strings of milli-feathers; dates are ISO strings.
An order-book participant sees their own outcome price and maker/taker fee, not
the counterparty's. Gross amounts exclude the separately returned fee.

LMSR trades and order-book fills share a descending `(createdAt, source-prefixed
ID)` ordering. Each table uses the corresponding cursor boundary before the
results merge. The source prefix disambiguates table IDs and equal timestamps;
the extra fetched record determines whether `nextCursor` is present. Empty and
final pages have a null cursor. New executions belong on the latest page and
do not reorder an already-traversed older-page boundary.

Related activity totals count executions, not submitted orders or contracts.
The number of markets traded deduplicates markets across both pricing models.

Verification includes equal-time cursor boundaries, NO-price complements,
maker/taker fees, authenticated ownership, strict query handling, and failure
responses. The disposable SQLite order-book journey independently traverses
two persisted fill pages and checks seller economics and NO-buyer isolation.
This does not imply that every UI or hosted deployment release gate is complete.
