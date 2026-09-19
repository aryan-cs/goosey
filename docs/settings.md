# Account settings

Settings live at `/settings` with Profile, Appearance, Notifications, Privacy, and Security sections. Appearance and the privacy explanation are available while signed out; private account controls require a verified account.

- Appearance offers System, Light, and Dark. The preference is stored in this browser, applied before first paint, and synchronized across tabs. System follows the OS. A storage failure still changes the current page and explains that the choice was not saved.
- Profile edits one username and a short bio. Username changes also update the public display name and profile URL. Profile and privacy PATCH requests update only supplied fields.
- Privacy independently controls the public profile and leaderboard. Market comments remain public. Public profiles identify the author of recent trading activity.
- Notification preferences filter known optional categories from both the inbox and unread badge. Hidden notices are retained; restoring a category restores its history. Mark all read affects visible categories only. Unknown and moderation types remain visible. These preferences do not change security email delivery.
- Security shows the verified email, links to the existing password recovery flow, and reuses signed-in browser management and logout.

## Database upgrade

The `User.notificationPreferences` field defaults to `{}`, which preserves all existing notification categories. Both Prisma schemas include it.

For an existing SQLite database, back up the database, then apply `prisma/sqlite-upgrades/20260919200000_notification_preferences.sql` once before running the updated app. The working development database has already received this additive upgrade. Fresh development databases can use the existing `npm run db:push` workflow. Regenerate clients with `npm run db:generate`.

PostgreSQL deployments apply the checked-in `20260919200000_notification_preferences` migration through the existing migration deployment workflow. It adds a non-null text column with a default, preserving current users and notifications.

## UX references

The section structure borrows from [Polymarket settings](https://polymarket.com/settings). Profile and privacy controls were checked against Kalshi's [social profile](https://help.kalshi.com/en/articles/13823773-how-do-i-edit-my-kalshi-social-profile), [account security](https://help.kalshi.com/en/articles/14026040-reporting-account-activity), and [Inner Circle privacy](https://help.kalshi.com/en/articles/14894380-inner-circle) documentation. The implementation uses Goosey's existing typography, flat surfaces, and controls; it does not add wallets or cash features.
