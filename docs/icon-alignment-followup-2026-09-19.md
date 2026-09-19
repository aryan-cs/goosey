# Icon alignment follow-up — September 19, 2026

## Scope and fixes

Re-inventoried 128 Lucide/feather/brand instances across 26 TSX files, including conditional branches. The earlier audit missed a homepage CSS override: compact headings inherited 28px text while retaining 17px icons. The homepage now scopes its large type to non-compact headings; compact headings use 20px text and matching, first-line-aligned icons. Rules headings follow the same relationship.

The shared icon stylesheet also aligns wrapped market dates, scales currency symbols with financial values, keeps form and button icons square, and anchors notice icons to the first text line. Comment error text and its Retry action now wrap together. Chart SVGs and logo artwork retain their independent sizing. A dark-mode event notice/hover defect found during the page review now uses the existing theme surface tokens.

## Browser coverage

Used the running development site on localhost:8080 and an isolated production preview on 127.0.0.1:8081 backed by the existing browser-e2e database. Signed into existing test participant and administrator accounts through the login form; no live accounts, balances, markets, or orders were changed.

| Page group | Routes inspected |
| --- | --- |
| Discovery | /, /markets, /markets/[slug], /search, /events, /events/[slug] |
| Community | /leaderboard, /community, /users/[username], /rules |
| Account entry | /login, /signup, /verify-email, /reset-password |
| Participant | /portfolio, /portfolio/activity, /notifications, /watchlist, /markets/suggest |
| Settings | /settings (redirect), /settings/appearance, /settings/profile, /settings/security, /settings/notifications, /settings/privacy |
| Administration | /admin, both denied and authorized views |

Reviewed desktop (1440px) and phone (390px) captures, light and dark themes. Signed-in coverage includes populated rankings, notifications, community posts, trade history and order-book controls. Settings and admin content have no standalone Lucide icons beyond the shared shell; their controls were still inspected. Public mobile checks found no page-width overflow or distorted non-square UI icons. The signed-in route sweep also found no page-width overflow.

Additional checks: opened/closed the mobile trade sheet; verified its YES/NO pills, arrow and close control; exercised a rejected verification link; interrupted the preview network to check the discussion error/retry layout. Capture artifacts and the current per-instance source inventory are under ignored output/playwright/icon-audit/.

## Validation and limits

Production build (including TypeScript) and focused ESLint passed. CSS and JSX diff checks passed. Conditional financial-success, redemption and suggestion-success icons were reviewed in source; this pass did not execute financial operations or send emails to exercise those states. This is a page/layout audit, not a claim that every possible data combination or business flow has been tested.
