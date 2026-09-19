# Mobile layout review — September 19, 2026

## Changes

- Leaderboard podium: 10px gaps, 12px horizontal card padding, rounded shared surfaces, three-line names, and consistent avatar/rank spacing. Full names remain readable in the standings below.
- Standings: 16px horizontal and 18px vertical row padding. Rank and avatar align with the name block; the score has its own line rather than competing with a long name.
- Trade activity: wrapped descriptions and timestamps on separate lines, with 14px body text and 16px vertical row spacing.
- Community cards: 20px padding and wrapping market links. Market list rows: 16px padding.
- Mobile form fields: 16px input/select/textarea text, including dialog fields. Chart ranges, quantity shortcuts, and theme controls have at least 44px-high targets.
- Four quantity shortcuts stay on one row, keeping the trade action visible at 320×740. Market filters stack at the narrowest width.
- Event cards and filters now use the existing shared surface/radius tokens rather than independent borders and corner sizes.

## Visual reference

Reviewed the public [Mobbin website](https://mobbin.com/) at phone width: generous gutters, rounded navigation, simple surfaces, readable hierarchy, and pill controls. This review uses that public reference and Goosey's established tokens; it does not claim access to Mobbin's private app library.

## Coverage

Used the existing isolated `browser-e2e.db` accounts and records. No production records were seeded or changed. Chromium browser checks at 320×844, 390×844, and 430×844 included dark and light themes; 390px captures included the full page, reviewed in readable viewport-sized crops.

All 26 page routes/templates were covered:

- Home, markets, market detail (both market-maker and order-book versions), search.
- Events and event detail.
- Leaderboard, community, user profile, rules.
- Login, signup, email verification, password reset.
- Portfolio, orders/fills activity, notifications, watchlist, market suggestion.
- Settings redirect, appearance, profile, security, notifications, privacy.
- Admin market desk, including the forms and queues below the fold.

84 route/viewport combinations were captured in the main sweep. No document-level horizontal overflow or offscreen form controls/headings were found. Undersized select text found in the first pass was corrected and rechecked in events, order entry, settings, portfolio activity, and admin.

Interactive checks: existing participant/admin sign-in and sign-out; mobile navigation opening; search opening from navigation, entering a query, displaying a real result, and closing; light/dark selection and persistence after reload; opening and dismissing the market trade sheet; scrolling its contents to the action. After the shortcut layout fix, the 44px trade action fits entirely inside a 320×740 viewport.

Production build and TypeScript passed. Screenshot and browser evidence are in ignored `output/playwright/mobile-review/`.

## Scope limits

This is a responsive layout and interaction review using desktop Chromium at phone viewport sizes, not a physical iOS/Android device certification. Account creation, password-reset emails, settlement, order submission, and destructive admin actions were not repeated for CSS-only changes. Existing populated and empty states were inspected; not every possible server error or arbitrary user-generated string was enumerated.
