# Unified public activity integration

The homepage now reads LMSR trades and order-book fills in one serializable
snapshot. Each source is bounded to the requested limit; the combined feed uses
descending timestamp and source-prefixed ID ordering before applying that limit.
A fill appears once, from its taker's perspective. NO execution volume uses the
complement of the canonical YES price, with fees kept separate. Draft markets
are excluded and private usernames are removed before returning public data.

Verification on 2026-09-19:

- Fourteen focused tests passed: mixed-source ordering, limit validation, exact
  bigint amounts, YES/NO execution amounts, BUY/SELL taker perspective, privacy,
  query bounds and error propagation.
- The helper queried the existing isolated order-entry integration database and
  returned six genuine order-book fills, unique IDs and redacted private users.
  No additional balances, prices or fills were inserted for this check.
- A copied production build rendered the three latest fills on the homepage:
  two YES shares for 80 feathers and one YES share for 40 feathers were visible,
  with real market links and anonymous attribution. Inspected desktop and 390px
  mobile screenshots in `output/playwright/unified-activity-*.png`.
- Source lint, TypeScript and a production build passed. The full suite immediately
  before this helper was added passed 956 tests with one skipped; the 14 new
  helper tests passed separately afterward.

The normal development server on port 8080 was not stopped or reseeded.
