# Notification consistency

The inbox reads preferences, the requested page, and the total unread count in
one serializable transaction. The unread count covers all visible notifications,
not just the current page. Ordering uses creation time followed by notification
ID, both descending; the cursor retains both values so equal timestamps do not
drop entries. Repeated query parameters are rejected before a snapshot opens.

Mark-all reads preferences inside the authenticated mutation transaction.
Individual and bulk read-status writes revalidate the session in the same
transaction as the write. A revoked session cannot rely on earlier request-level
authentication to perform the mutation.

Visible polling aborts active requests when the page becomes hidden, without
reporting an interruption to the user. Foreground events queue one refresh and
wait for cooperative cancellation to finish before starting it. Callers must
honor the supplied abort signal. Ordinary request failures retain bounded
backoff; active visible requests have a ten-second timeout.

Verification: 42 focused tests across notification routes, preferences, cursor
encoding, polling, and the mutation-session helper passed on 2026-09-19.
Route mocks reject root-client reads and writes, ensuring the snapshot and
mutation clients are actually used. These are functional regression tests, not
a production load or security certification.
