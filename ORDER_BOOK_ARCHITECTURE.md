# Goosey order-book architecture

Status: accepted for staged implementation. Existing LMSR markets remain LMSR until resolution. New order-book markets use `pricingModel = ORDER_BOOK`; the two engines never execute against the same market.

## Economic model

Each binary contract pays `payoutMilli` feathers when correct. Prices, money, quantities, sequence numbers, and fees are integers; matching and accounting never use floating point.

Goosey keeps one canonical YES-price book:

| User intent | Canonical side | Canonical YES price | Reservation |
|---|---|---:|---|
| Buy YES at `y` | BUY | `y` | `y × quantity` cash plus maximum fee |
| Sell YES at `y` | SELL | `y` | YES contracts |
| Buy NO at `n` | SELL | `payout − n` | `n × quantity` cash plus maximum fee |
| Sell NO at `n` | BUY | `payout − n` | NO contracts |

Legal limit prices satisfy `0 < price < payout`. Public YES/NO views are exact complements. This mirrors Kalshi's canonical YES-side V2 model and its public YES/NO bid presentation: <https://docs.kalshi.com/api-reference/orders/create-order-v2> and <https://docs.kalshi.com/api-reference/market/get-market-orderbook>.

One canonical bid and ask can represent four economic effects. The persisted original intent determines which effect applies:

| Canonical bid | Canonical ask | Effect |
|---|---|---|
| Buy YES | Sell YES | Transfer existing YES |
| Buy YES | Buy NO | Mint a fully collateralized YES/NO pair |
| Sell NO | Sell YES | Burn a YES/NO pair |
| Sell NO | Buy NO | Transfer existing NO |

Minting moves exactly `quantity × payout` into market collateral. Burning or complete-set redemption removes equal YES/NO quantities and releases the same amount. Transfers do not change supply or collateral. Naked shorting is prohibited.

## Deterministic matching

Every state-changing command for a market receives one authoritative monotonic `bookSequence`. The priority key is `(price, prioritySequence, orderId)`:

- Highest bid first.
- Lowest ask first.
- Oldest sequence first at one price.
- `orderId` is only a deterministic final tie-breaker; sequence allocation must prevent ordinary ties.
- Execution occurs at the resting maker's price.
- A partial maker retains priority.
- A newly resting residual goes to the back of its price level.

This implements Kalshi's filed price-time and “or better” rules: <https://www.cftc.gov/filings/orgrules/rules02172515652.pdf>.

The pure matcher lives in `src/lib/order-book.ts`. It accepts a committed book snapshot plus one sequenced incoming order and emits deterministic fills, cancellations, self-trade prevention effects, and the next resting book. It does not read clocks, allocate IDs, access the network, or mutate persistence.

### Time in force

- `GTC`: match immediately and rest any residual.
- `IOC`: match immediately and cancel any residual in the same command.
- `FOK`: run a side-effect-free preflight with the same price/STP rules; fill all or make no mutation.
- `postOnly`: valid only with GTC; reject the entire order if any immediate execution is possible.
- Optional GTC expiry is implemented as a sequenced worker command. Matching code never polls wall time; the worker releases backing, records terminal state, and emits the private order event atomically.

### Self-trade prevention

`stpOwnerId` is derived server-side from beneficial ownership. The initial default is `CANCEL_AGGRESSOR`; supported engine policies are:

- `CANCEL_AGGRESSOR`: cancel the incoming residual and stop.
- `CANCEL_RESTING`: cancel the resting self-order and continue.
- `CANCEL_BOTH`: cancel both residuals and stop.

STP creates no trade, fee, cash transfer, or position mutation. Kalshi V2 documents equivalent taker-at-cross and maker cancellation modes in its create-order reference.

## Reservations and accounting

Before an order can enter matching:

- A cash-backed order moves worst-case principal and maximum fee from the user's available wallet to reserved cash.
- A sell order reserves owned YES or NO contracts.
- Reserved contracts remain in the position but cannot be sold, redeemed, or reserved again.
- A price improvement, canceled remainder, or excess fee reserve is returned immediately.

Required invariants after every command:

1. Available cash and every non-debt ledger account are nonnegative.
2. `available cash + reserved cash` equals user cash custody.
3. Aggregate reserved cash equals the sum of active order cash reservations.
4. `reservedYesShares ≤ yesShares` and `reservedNoShares ≤ noShares`.
5. Every active reservation belongs to exactly one nonterminal order.
6. `originalQuantity = filledQuantity + canceledQuantity + remainingQuantity`.
7. Every terminal order has zero reservation.
8. For order-book markets, aggregate YES supply equals aggregate NO supply.
9. Market collateral equals aggregate complete sets times payout.
10. Every fill has exactly one immutable balanced journal and its postings sum to zero.
11. Fees never enter market collateral.
12. Command replay creates no new order, fill, posting, reservation, or event.

Fee calculations are cumulative per order. For rate `r` basis points and cumulative executed notional `N`, total fee is `ceil(N × r / 10_000)`; the fee on the next fill is the new cumulative total minus the fee already charged. This prevents splitting one execution into many fills from changing the charge.

## Persistence and transaction boundary

The additive schema introduces `MarketOrder`, `OrderFill`, and `OrderEvent`, plus market pricing model/sequence and position reservation fields. Before production, PostgreSQL migrations will add database checks, partial price-time indexes, immutable journal protections, an order-command table for permanent business idempotency, and a transactional outbox.

One place/match transaction performs:

1. Lock the market engine/sequence row.
2. Acquire or replay the account-scoped idempotency command.
3. Validate market state, tick, quantity, TIF, and actor.
4. Allocate the command sequence.
5. Lock and reserve initiating cash or shares.
6. Load resting liquidity in exact price-time order.
7. Run deterministic post-only/FOK/STP/matching rules.
8. Persist order states and fills.
9. Apply reservations, positions, collateral, fees, and balanced journals.
10. Append ordered public/private events and an outbox message.
11. Store the exact response for idempotent replay.
12. Commit.

No email, WebSocket, or other network operation occurs inside this transaction. PostgreSQL retries the entire transaction on serialization failures (`40001`), deadlocks (`40P01`), or Prisma `P2034`, with bounded jitter. SQLite is local, single-process development only and requires one mutation writer.

## Market data and displayed probability

Execution price and displayed probability are distinct:

- Buy preview: quantity-weighted asks actually available.
- Sell preview: quantity-weighted bids actually available.
- Headline probability: midpoint only for a qualified two-sided book with an acceptably narrow spread; otherwise a recent last trade; otherwise no point estimate.
- One-sided book: show the executable bid or ask, not a synthetic probability.
- Portfolio value: executable liquidation depth net of fees, excluding the owner's own orders.
- Official leaderboard: realized/settled journal-derived P&L, not a manipulable midpoint mark.

The implied YES probability in basis points is `round(yesPrice × 10_000 / payout)`. It is a market-implied estimate, not an exchange-authored forecast. Thin-book charts store fills, bid/ask observations, and qualified reference marks separately. Empty intervals remain empty rather than receiving synthetic observations.

## Public/private API contract

Planned versioned endpoints:

- `GET /api/v1/markets/{slug}/orderbook`: aggregated levels and sequence; no owners or order IDs.
- `GET /api/v1/markets/{slug}/trades`: cursor-paginated immutable fills; no participant identity.
- `POST /api/v1/orders`: place a limit order with `Idempotency-Key`.
- `GET /api/v1/orders`: authenticated user's orders only.
- `POST /api/v1/orders/{id}/decrease`: same-price quantity reduction retaining priority.
- `POST /api/v1/orders/{id}/amend`: increases/price changes are atomic cancel-replace and lose priority.
- `DELETE /api/v1/orders/{id}`: cancel current unfilled quantity and release its reservation.

Foreign order IDs return the same not-found response as nonexistent IDs. Identity, owner, role, sequence, status, fees, and reservation amounts are never accepted from request bodies.

Realtime consumers receive a committed snapshot followed by sequenced absolute-level deltas. A duplicate is ignored; a sequence gap marks the view stale and requires a fresh snapshot. Events are delivered at least once and deduplicated by `(marketId, sequence, effectIndex)`. Kalshi's snapshot/delta protocol is documented at <https://docs.kalshi.com/websockets/orderbook-updates>.

## Lifecycle and settlement

Pause, close, and resolution pass through the same sequencer as order commands. A transition to non-matchable state:

1. Rejects new orders.
2. Fences in-flight matching.
3. Cancels every live order in deterministic sequence.
4. Releases all cash and contract reservations.
5. Proves open-order and reservation counts are zero.
6. Only then permits settlement to snapshot positions.

Existing LMSR markets are never converted in place because their supply and collateral invariants differ. Rollout is expand/coexist/contract: add tables, backfill existing markets as LMSR, test internal CLOB markets, enable selected new CLOB markets, let LMSR markets resolve, then retire legacy creation.

## Release gates

Order-book markets remain disabled outside local development until all gates pass:

- Deterministic vectors for price-time priority, maker pricing, partial fills, TIF, STP, complements, and overflow.
- Independent property tests for order, cash, position, reservation, collateral, and journal conservation.
- Real PostgreSQL tests with 100 synchronized clients across multiple processes and markets.
- Cancel/fill, amend/fill, close/fill, redeem/fill, and settlement races each produce one legal serial result.
- Crash/retry tests at every mutation stage create no duplicates or stranded reservations.
- Snapshot plus replay yields byte-identical book, order, fill, balance, and position state.
- Complete authorization/IDOR/CSRF/rate-limit tests.
- Wash-trading surveillance and abuse-adjusted public volume/ranking.
- Independent reconciliation reports zero discrepancies.
