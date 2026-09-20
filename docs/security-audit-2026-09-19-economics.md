# Economics security audit — 2026-09-19

Reviewed participant-controlled trading, order placement/replacement/cancellation, complete-set redemption, valuation, leaderboard accounting, and registration/verification grant replay. This is a targeted code audit with regression testing, not a claim that every attack is prevented.

## Confirmed findings and fixes

**Participant-triggered leaderboard denial of service through zero-value LMSR holdings.** On a market with 1,000 YES contracts, zero NO contracts, liquidity 40, and a 100,000 milli-feather payout, buying one NO contract succeeds at a gross cost of one milli-feather. Its conservative sale proceeds round to zero. The previous portfolio valuation called the executable SELL quote function, which correctly rejected a zero-proceeds trade. That exception propagated through the public leaderboard, so one participant's holding could break valuation for everyone. Fees that consume the entire sale proceeds produced the same failure.

The arithmetic now supports zero-valued liquidation estimates separately from executable trade validation. `sellLiquidationValueMilli` retains quantity, market-state, fee, and payout checks; executable SELL quotes still reject nonpositive proceeds. Aggregate and per-side LMSR portfolio valuation use the new function. No balances, positions, or financial journals are rewritten.

Changed implementation: `src/lib/market-maker.ts`, `src/lib/trading.ts`, `src/lib/portfolio.ts`. Regression tests: `src/lib/market-maker.test.ts` and `src/lib/leaderboard.test.ts`. The leaderboard regression executes the real position-valuation stack, with database reads replaced by fixtures.

**Revoked-session order accepted after a deliberately delayed request body.** The HTTP regression sent an order JSON object without its final closing brace, revoked that session using another session, then finished the body. The old build returned 201 and reserved 1,000 milli-feathers. Economic routes had authenticated before waiting for the complete body, while services checked the account but not that session.

Body-bearing economic routes now authenticate after reading their bounded JSON body. Quote creation, trade execution, redemption, order placement/replacement/cancellation, and bulk cancellation also call the shared transaction session guard before replay or mutation. HTTP order commands skip the outside-transaction replay shortcut. Internal service and worker callers remain supported without HTTP credentials. Seven regression cases in `src/lib/economic-session.test.ts` assert that guard rejection occurs before any economic mutation or replay lookup. The hostile HTTP suite independently contains the delayed-body reproduction.

## Accounting and authorization review

- LMSR execution uses a server-stored quote scoped to its user and market, verifies expiry/version/consumption, and recomputes authoritative price and fees. Requests cannot supply the executed quantity, side, fee, or wallet identity.
- Order placement derives ownership and self-trade identity on the server. BUY principal and fees are escrowed; SELL contracts are reserved. Fill accounting uses balanced journals and conditional nonnegative account debits. Replacement retains cumulative fee accounting across its order chain.
- Trade, order, and redemption mutations run in serializable transactions. Conditional balance debits and position/version checks supplement transaction isolation. Redemption requires unreserved complete sets and decrements supply and collateral atomically. No minting or double-spend bypass was found in this review; that is not a proof over all database interleavings.
- Leaderboard equity includes wallet cash, order cash escrow, and position value, and subtracts recorded welcome grants for PnL. Order-book valuation excludes the participant's own orders and uses executable external depth rather than simply multiplying by the latest trade price.

## Registration, verification, and grants

Registration creates a zero balance and zero wallet within one transaction. Canonical email and username have database uniqueness constraints. Optional invitation use is conditionally incremented below its usage cap.

Email confirmation atomically claims an unexpired, unconsumed token, consumes sibling verification tokens, conditionally verifies an active unverified participant, and grants funds inside the same serializable transaction. The durable journal has a unique `(WELCOME_GRANT, userId)` key and is inserted before balance increments. A conflict or later failure rolls back the token, verification, journal, and balances together. Already verified, suspended, and privileged accounts cannot claim another welcome grant through confirmation. Password-reset tokens are purpose-scoped, consumed once, and reset revokes existing sessions.

The existing database-backed recovery tests cover two distinct verification tokens racing for the same user, sequential token replay, account eligibility, and rollback on an invalid grant configuration. No additional grant replay defect was found. The executed concurrency test uses SQLite; PostgreSQL concurrency remains a separate validation requirement.

## Residual collusion risk and enforceable options

Same-account self-trades are blocked, but separately verified accounts are distinct principals. Colluding accounts can exchange contracts at extreme valid prices to transfer wealth and concentrate gains in one leaderboard account. They can also fund a favorable resting order that temporarily increases the other account's executable liquidation value. These actions need real collateral and do not create combined wealth, but they can distort individual rankings. Email verification alone does not establish one account per person; mailbox aliases and multiple mailboxes remain possible.

Possible controls require explicit competition rules and implementation:

1. Bind ranked participation and welcome grants to an organizer-issued, single-use participant identity or roster entry. Enforce that identity with a database uniqueness constraint, not only email normalization. An identity provider's stable subject can serve this purpose when it represents the intended participants.
2. Where multiple accounts per person are intentionally permitted, assign a server-controlled beneficial-owner group. Use that group for self-trade prevention, valuation exclusions, grant eligibility, and ranking. Do not accept group identifiers from clients.
3. Detect concentrated counterparties, repeated extreme-price transfers, and coordinated order placement/cancellation for review. Keep auditable evidence and permit ranking disqualification under published rules. These signals are not proof of collusion and should not automatically seize balances.
4. If live unrealized rankings are too manipulable, rank final settled competition PnL or delay provisional results. This reduces transient quote manipulation but does not eliminate intentional wealth transfers between accounts.

Rate limits, shared-IP blocks, blanket email-alias stripping, or an email-domain allowlist alone do not reliably establish unique people or prevent collusion. No new identity policy or heuristic trade rejection was introduced in this audit.

## Validation

The economics run passed **141 tests**, with **one existing skipped test**, across these 16 suites:

```sh
npx vitest run src/lib/market-maker.test.ts src/lib/leaderboard.test.ts src/lib/trading-reservations.test.ts src/lib/order-exchange.test.ts src/lib/order-exchange.lifecycle.test.ts src/lib/redemption.test.ts src/lib/invariants.test.ts src/lib/order-book.test.ts src/lib/order-book.property.test.ts src/lib/order-book-accounting.test.ts src/lib/order-book-valuation.test.ts src/lib/serializable-transaction.test.ts src/lib/order-service.test.ts src/lib/order-service.pagination.test.ts src/lib/order-service.depth.test.ts src/lib/order-service.activity.test.ts
```

After the session fix, `npx vitest run src/lib/economic-session.test.ts src/lib/order-exchange.test.ts src/lib/order-exchange.lifecycle.test.ts src/lib/trading-reservations.test.ts src/lib/redemption.test.ts src/lib/leaderboard.test.ts src/lib/market-maker.test.ts` passed **65 tests**, with **one existing skipped test**. Targeted ESLint and `npm run typecheck` passed. `npx vitest run src/lib/auth-recovery.test.ts` also passed all **18 tests**, including the SQLite concurrent verification/grant regression. This report does not claim a production penetration test or PostgreSQL race test.
