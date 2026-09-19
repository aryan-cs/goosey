# Grouped event navigation

Implemented `/events` and `/events/[slug]` with server-rendered persisted event
membership, category/timing filters, twelve-item cursor pages, and direct links
from search into the matching event rather than its broad category.

The public event service excludes drafts and empty/draft-only events. Its
serializable snapshot loads actual market marks alongside membership. Empty
order books have no invented forecast. Settled YES/NO outcomes display 100%/0%;
voided contracts are labeled as voided. Related binary contracts are explicitly
described as independent, not normalized into an artificial distribution.

Verification on 2026-09-19:

- Production build and TypeScript passed.
- Full ESLint passed; the unit run passed 703 tests with one intentional skip.
- Event service plus discovery forecast regressions: 46 tests passed.
- `event-navigation.spec.ts`: desktop and mobile production journeys passed.
  Covered distinct same-category search links, member-only navigation, missing
  and draft-only events, genuine empty-book marks, resolved outcomes, timing and
  category selection, invalid filters, and 13-event pagination across two pages.
- Visual inspection at 1440px and 390px confirmed readable cards and detail
  rows. Mobile document width matched the viewport without horizontal overflow.

The browser run used a disposable SQLite snapshot on loopback port 8082, not the
live development database. Admin-created market fixtures used zero-subsidy
order books; no fabricated trading or price history was inserted. Resolved
zero-position fixtures were set directly for display assertions, not claimed as
a test of settlement execution.

Next's async not-found boundary can stream an HTTP 200 layout before resolving
the missing event. The regression therefore verifies the rendered not-found
boundary and noindex metadata, and independently requires HTTP 404 from the
event API. The initial fixture assertion also needed to read the persisted
short title because the create-market response does not return that field.
