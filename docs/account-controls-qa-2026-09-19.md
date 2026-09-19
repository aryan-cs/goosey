# Account control integration

The session list now distinguishes loading, failure, signed-out and confirmed
revocation states. Ten-second deadlines bound reads and mutations; a failed or
uncertain request preserves the list and permits recovery. Unmount aborts active
work. The expired-session sign-in link returns to `/settings/security`.

Browser verification used only an isolated SQLite database on port 8081:

- Held a session GET beyond ten seconds. The timeout appeared and Refresh
  browsers became enabled. Removing the delay and refreshing recovered the
  actual list and kept the current browser signed in.
- Allowed a real revocation to commit, then dropped its response. The UI kept
  the unconfirmed row. Retrying received the server's 404 and refreshed the list,
  removing the already-revoked browser while preserving the current session.
- Inspected the rendered recovered list in
  `output/playwright/session-recovery-desktop.png`.
- Participant and administrator browser journeys passed on desktop and mobile:
  registration, verification and journal-backed grant, sign-out/sign-in,
  two-sided trading and redemption, comments, limit order placement/cancellation,
  profile/privacy settings, leaderboard, suggestion submission, and invite
  issuance/revocation. Suggestion and invite forms now retain their form element
  across asynchronous submission, so successful reset does not throw.
- Updated the existing journey to use current search-dialog controls and an
  actual seeded, open, funded LMSR market instead of obsolete catalog slugs.
  Added a disposable-database/base-URL guard before fixture writes.
- Full suite: 983 passed, one skipped. Source lint, typecheck and production
  build passed; the isolated ledger reconciled after the browser journeys.

Expected browser console errors during fault injection were the deliberately
aborted request and subsequent 404. They are not failures in the normal journey.
The normal port-8080 development server was never stopped or reseeded.
