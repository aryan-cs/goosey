# Advanced order controls

Order-book market pages expose **Advanced order options** beneath price and
quantity. Every mode is still a limit order; Goosey never submits an unbounded
market order.

| Mode | Behavior |
| --- | --- |
| Good until canceled (GTC) | Trade at the limit or better; leave any unfilled remainder on the book. |
| Immediate or cancel (IOC) | Trade whatever is immediately available at the limit or better, then cancel the unfilled remainder. |
| Fill or kill (FOK) | Fill the entire quantity immediately at the limit or better, or reject it without any fills. |
| Post-only | GTC only. Reject the whole order if it would execute immediately; otherwise place it on the book. |
| Optional expiration | GTC only. Enter a future date and minute in the browser's local timezone. No custom expiration means the normal cancellation/market lifecycle still applies. |

Changing to IOC or FOK clears post-only and expiration instead of sending an
unsupported combination. The parser rejects impossible dates and nonexistent
local times during a daylight-saving clock jump. During a fall-back overlap,
the browser's earlier occurrence is used. The submitted instant is stored in
UTC, and resting-order details show its expiration in local time.

The backend remains authoritative about available cash/shares, matching,
expiration, fees, self-trade prevention and market state. The UI does not invent
liquidity or a fill. Buy orders show their maximum reservation including fees;
IOC/FOK still require backing for the submitted quantity. Unused backing is
released by the same atomic execution/cancellation path. Expired resting orders
are excluded from matching immediately; the settlement worker processes their
reservation release on its next cycle.

## Retry behavior

A submitted order retains its exact JSON payload and idempotency key after an
ambiguous response. Retrying confirms that same operation, including its
original expiration, rather than creating a duplicate. Editing any input
starts a new attempt, so check existing orders before changing an uncertain
submission.

A confirmed FOK/post-only rejection is different: it completes that attempt
without an accepted order. Clicking submit again without editing starts a new
attempt against current liquidity. The UI explains the rejection instead of
showing a generic transport error or indefinitely replaying the old rejection.

Accepted-order messages distinguish full fills, partial fills still resting,
partial fills followed by cancellation, and cancellations without any fills.
They do not describe an IOC cancellation as a resting limit order.

## Verification (2026-09-19)

- Forty-five focused helper tests cover allowed combinations, strict local dates,
  the Toronto DST gap/overlap, expiration, result messages and rejection codes.
- Desktop and mobile Chromium journeys submit real HTTP orders using a fresh
  isolated database and journal-funded test accounts. They cover empty and
  partial IOC execution, FOK rejection with no economic effects followed by an
  unchanged-draft fresh-key success, post-only crossing rejection/noncrossing
  placement, clearing GTC-only settings, and a committed expiring order whose
  response is dropped and then replayed with the exact body/key.
- Both browser journeys passed. Reconciliation of the disposable test database,
  including earlier harness runs, passed for 51 journals, 43 accounts, 12
  participant wallets, seven markets, 22 orders/reservations and six fills.
- The complete unit/integration suite passed 653 tests with one intentional skip
  across 83 files. Lint, typecheck and an explicit-SQLite build passed.
- The expanded ticket and public order guide were visually inspected on desktop
  and at 390px mobile width. The mobile document had no horizontal overflow, and
  both ticket controls and the submit action remained reachable by scrolling.

These are bounded local checks, not high-load or production deployment claims.

### Integration follow-up

The final desktop/mobile run passed eight browser tests covering order entry
and account destinations. It additionally verifies a post-only amendment that
is definitively rejected, then succeeds with unchanged inputs and a new command
key after competing liquidity is canceled. A committed amendment with a dropped
response reuses its exact key, body, and order version and creates only one
replacement. The portfolio's sign-in link now retains its history-page
destination through the signup handoff.

The disposable database reconciled 72 journals, 56 accounts, 8 participants,
10 markets, 36 orders/reservations, and 8 fills after these runs. Desktop and
390px screenshots of the trading page, portfolio, history, and orders view were
inspected. The mobile portfolio had no horizontal document overflow. Source
lint, typecheck, and the fresh production build passed. The final browser run
used an isolated copy of the build so another task's build could not invalidate
its JavaScript chunks.
