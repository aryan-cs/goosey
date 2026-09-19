# Notification inbox verification — 2026-09-19

Scope: ordinary functional checks against the isolated `browser-e2e.db` on
port 8081. No new audit tasks or tests against external systems.

- Real notifications were fetched through the API with a three-item page size.
  Loading older items produced six rows. A real reply from a second test account
  triggered the new-updates notice without discarding those six rows; explicit
  refresh returned the latest three rows and updated the header unread count.
- Disabling reply notifications removed the reply on the next visible poll.
  Restoring the original preferences brought it back.
- An intentionally interrupted GET preserved the existing rows and exposed a
  retry action. Retrying recovered successfully.
- A mark-read PATCH was held until after navigation to its market. The request
  completed and a subsequent real API read confirmed persisted `readAt`.
- Inspected desktop and 390px mobile screenshots. Mobile action buttons were
  corrected to wrap as whole controls instead of splitting their labels.
- Focused notification/polling suite: 29 passing tests. Full suite: 540 passing,
  one skipped. Scoped lint and the SQLite-configured production build pass.

Screenshots are local artifacts under `output/playwright/notifications-live-*`.
These checks are not a comprehensive security certification or load test.

## Publication follow-up

- Feed validation and state transitions now live in a pure tested helper.
  Twelve tests cover replacement, polling, pagination overlap, changed read
  status, malformed responses and preference changes while older pages are open.
- Manual refresh clears old success messages. The update notice describes both
  new notifications and changed read status instead of implying new arrivals only.
- Rechecked real trade notifications in a disposable SQLite production preview:
  a one-item API page loaded its older item, marking that item read changed the
  persisted unread count, and marking all read yielded zero unread via the API.
  Explicit refresh cleared the success message without undoing persisted state.
- Inspected desktop and 390px screenshots under
  `output/playwright/notification-integration-*.png`.
- Full suite: 983 passing, one skipped; lint, typecheck and production build pass.
  Desktop and mobile participant/admin journeys also pass. Final isolated
  reconciliation: 84 journals, 64 accounts, 10 participants, 14 markets,
  38 orders/reservations and eight order-book fills.
