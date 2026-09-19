# Community browsing verification — 2026-09-19

## Integration checkpoint

- Re-ran the community service suite: 11 tests passed. Typecheck and full source
  lint passed alongside the three market presentation tests.
- Extended and passed the real HTTP journey on a fresh isolated SQLite database:
  private authors are absent from community discovery; publishing both profiles
  exposes the actual root and reply, with the root's focused discussion link.
  Moderating the root removes both from discovery. Invalid and repeated cursor
  parameters render the recovery state. Backup/restore reconciliation still
  passed (10 journals, 12 accounts, two participant users, eight markets).
- This regression uses actual registration, verification, profile, comment and
  moderation APIs; it does not insert community posts directly into the database.

- The server-rendered feed now uses 25-item timestamp/id seek pagination instead
  of silently stopping at 50 comments. Only public-profile, visible comments in
  non-draft markets appear; replies to hidden/deleted parents are excluded from
  this discovery feed.
- Isolated browser verification used existing comments in `browser-e2e.db`.
  Temporarily enabling the test author's public profile produced 25 posts on
  page one and 8 on page two, with no overlapping post bodies. The setting was
  restored to private afterward. No production activity was fabricated.
- Older/latest navigation and invalid-cursor recovery worked. Inspected mobile
  rendering at 390px; the document did not overflow horizontally.
- A signed-out visitor used the discussion sign-in link and returned to
  `/markets/venue-wifi-through-demos#discussion-heading` with an enabled comment
  composer. Previously this link used the database ID instead of the route slug.
- Eleven new service tests cover filtering, stable pagination and cursor
  validation. Full suite: 551 passing, one skipped. Scoped lint, typecheck and
  the SQLite-configured production build pass.

## Focused discussion follow-up

- A reply absent from the ordinary initial 25-reply window loaded directly via
  `?comment=<id>`. Its parent and the selected reply were visible, with the reply
  highlighted. Inspected the actual rendered discussion at 390px.
- The same focused URL survived sign-in. “View all discussion” removed the
  selection and restored normal sorting/pagination. No horizontal overflow.
- A hidden comment returned 404. Focused route tests cover missing/cross-market
  targets, hidden roots, bounded reply windows and draft-market permissions.
- Created one real reply from a second isolated test account. Its persisted
  notification contained the new reply ID and opened that exact reply.
- Full suite after the addition: 557 passing, one skipped. Production build
  with `DATABASE_PROVIDER=sqlite` passed; focused route suite passed again after
  tightening cursor-conflict validation.
