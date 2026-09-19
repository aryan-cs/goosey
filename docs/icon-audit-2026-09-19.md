# Icon audit — September 19, 2026

Reviewed 133 icon call sites across 26 source files, including conditional states and the chart SVG (which retains its independent aspect ratio).

## Changes

- Give width-only icons matching heights, preventing Lucide's default height from distorting alignment.
- Align wrapped success and error messages beside 18px icons, with semantic colors preserved inside auth cards.
- Center completion illustrations, rank badges, and metric icons; align inline feather currency symbols.
- Size comment cancel controls consistently and separate movement indicators from their values.
- Reserve space for the mobile trading close control and remove the overlapping decorative shield.
- Replace the auth submit arrow with a spinner while submitting.

## Verification and limits

Three independent reviewers inspected auth/settings/admin/support, markets/trading/portfolio, and navigation/community/leaderboard/search. Public pages were checked in desktop and mobile browser layouts. An isolated component preview using the actual stylesheet and Lucide icons verified wrapped verification messages, errors, input icons, discussion cancel actions, completion illustrations, and ranking icons in dark desktop and light mobile layouts. Protected and conditional states that could not be reached without account or financial mutations were reviewed in source or this preview; this is not a claim that every private state was exercised live. The preview is an ignored QA artifact and does not add sample data to the app.

## Individual source inventory

Each row was reviewed for its sizing rule, containing layout, spacing and wrapping behavior. Line numbers refer to the working source during the audit.

| Source | Line | Icon |
| --- | ---: | --- |
| `src/app/community/page.tsx` | 10 | `MessageCircle` |
| `src/app/error.tsx` | 8 | `AlertTriangle` |
| `src/app/markets/[slug]/page.tsx` | 51 | `ChevronRight` |
| `src/app/markets/[slug]/page.tsx` | 55 | `CalendarClock` |
| `src/app/markets/[slug]/page.tsx` | 55 | `FeatherIcon` |
| `src/app/markets/[slug]/page.tsx` | 56 | `Bookmark` |
| `src/app/markets/[slug]/page.tsx` | 56 | `Share2` |
| `src/app/markets/page.tsx` | 39 | `Search` |
| `src/app/markets/page.tsx` | 41 | `Filter` |
| `src/app/page.tsx` | 41 | `GooseMark` |
| `src/app/page.tsx` | 47 | `ArrowRight` |
| `src/app/page.tsx` | 52 | `Sparkles` |
| `src/app/page.tsx` | 62 | `Radio` |
| `src/app/page.tsx` | 68 | `Trophy` |
| `src/app/page.tsx` | 69 | `FeatherIcon` |
| `src/app/page.tsx` | 72 | `Users` |
| `src/app/portfolio/page.tsx` | 54 | `FeatherIcon` |
| `src/app/portfolio/page.tsx` | 54 | `FeatherIcon` |
| `src/app/portfolio/page.tsx` | 54 | `FeatherIcon` |
| `src/app/portfolio/page.tsx` | 54 | `FeatherIcon` |
| `src/app/rules/page.tsx` | 4 | `BookOpen` |
| `src/app/rules/page.tsx` | 4 | `Scale` |
| `src/app/rules/page.tsx` | 4 | `ShieldCheck` |
| `src/app/users/[username]/page.tsx` | 16 | `FeatherIcon` |
| `src/components/app-shell.tsx` | 74 | `ChevronDown` |
| `src/components/app-shell.tsx` | 145 | `GooseMark` |
| `src/components/app-shell.tsx` | 156 | `Search` |
| `src/components/app-shell.tsx` | 162 | `FeatherIcon` |
| `src/components/app-shell.tsx` | 164 | `Bell` |
| `src/components/app-shell.tsx` | 165 | `UserRound` |
| `src/components/app-shell.tsx` | 178 | `Menu` |
| `src/components/app-shell.tsx` | 186 | `X` |
| `src/components/app-shell.tsx` | 217 | `GooseMark` |
| `src/components/app-shell.tsx` | 221 | `ChartNoAxesColumnIncreasing` |
| `src/components/app-shell.tsx` | 236 | `CircleHelp` |
| `src/components/auth-form.tsx` | 58 | `GooseMark` |
| `src/components/auth-form.tsx` | 63 | `UserRound` |
| `src/components/auth-form.tsx` | 64 | `Mail` |
| `src/components/auth-form.tsx` | 65 | `LockKeyhole` |
| `src/components/auth-form.tsx` | 65 | `EyeOff` |
| `src/components/auth-form.tsx` | 65 | `Eye` |
| `src/components/auth-form.tsx` | 68 | `AlertCircle` |
| `src/components/auth-form.tsx` | 69 | `LoaderCircle` |
| `src/components/auth-form.tsx` | 69 | `ArrowRight` |
| `src/components/brand.tsx` | 16 | `Feather` |
| `src/components/comments.tsx` | 177 | `MessageCircle` |
| `src/components/comments.tsx` | 180 | `X` |
| `src/components/comments.tsx` | 185 | `X` |
| `src/components/comments.tsx` | 186 | `X` |
| `src/components/comments.tsx` | 188 | `AlertCircle` |
| `src/components/comments.tsx` | 191 | `Reply` |
| `src/components/comments.tsx` | 191 | `Pencil` |
| `src/components/comments.tsx` | 191 | `Trash2` |
| `src/components/comments.tsx` | 191 | `Flag` |
| `src/components/comments.tsx` | 191 | `Pencil` |
| `src/components/comments.tsx` | 191 | `Trash2` |
| `src/components/comments.tsx` | 191 | `Flag` |
| `src/components/data-primitives.tsx` | 7 | `ArrowUpRight` |
| `src/components/data-primitives.tsx` | 7 | `ArrowDownRight` |
| `src/components/data-primitives.tsx` | 13 | `FeatherIcon` |
| `src/components/data-primitives.tsx` | 13 | `FeatherIcon` |
| `src/components/data-primitives.tsx` | 13 | `ChevronRight` |
| `src/components/data-primitives.tsx` | 19 | `Crown` |
| `src/components/data-primitives.tsx` | 19 | `Medal` |
| `src/components/data-primitives.tsx` | 19 | `FeatherIcon` |
| `src/components/data-primitives.tsx` | 23 | `Trophy` |
| `src/components/data-primitives.tsx` | 23 | `TrendingUp` |
| `src/components/data-primitives.tsx` | 23 | `FeatherIcon` |
| `src/components/email-verification-flow.tsx` | 156 | `GooseMark` |
| `src/components/email-verification-flow.tsx` | 157 | `LoaderCircle` |
| `src/components/email-verification-flow.tsx` | 158 | `CheckCircle2` |
| `src/components/email-verification-flow.tsx` | 163 | `CheckCircle2` |
| `src/components/email-verification-flow.tsx` | 164 | `AlertCircle` |
| `src/components/email-verification-flow.tsx` | 166 | `Mail` |
| `src/components/email-verification-flow.tsx` | 167 | `LoaderCircle` |
| `src/components/email-verification-flow.tsx` | 167 | `RotateCcw` |
| `src/components/market-trading-panel.tsx` | 94 | `X` |
| `src/components/market-trading-panel.tsx` | 104 | `ArrowUp` |
| `src/components/market.tsx` | 53 | `ArrowUpRight` |
| `src/components/market.tsx` | 53 | `ArrowDownRight` |
| `src/components/market.tsx` | 64 | `Bookmark` |
| `src/components/market.tsx` | 69 | `Clock3` |
| `src/components/market.tsx` | 89 | `FeatherIcon` |
| `src/components/market.tsx` | 90 | `MessageCircle` |
| `src/components/market.tsx` | 101 | `TrendingUp` |
| `src/components/market.tsx` | 105 | `FeatherIcon` |
| `src/components/notification-center.tsx` | 101 | `Bell` |
| `src/components/notification-center.tsx` | 103 | `CheckCheck` |
| `src/components/notification-center.tsx` | 103 | `Bell` |
| `src/components/order-book-panel.tsx` | 190 | `RefreshCw` |
| `src/components/order-book-panel.tsx` | 195 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 197 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 197 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 199 | `AlertCircle` |
| `src/components/order-book-panel.tsx` | 200 | `LoaderCircle` |
| `src/components/order-book-panel.tsx` | 203 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 203 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 205 | `FeatherIcon` |
| `src/components/order-book-panel.tsx` | 205 | `X` |
| `src/components/password-reset-flow.tsx` | 92 | `CheckCircle2` |
| `src/components/password-reset-flow.tsx` | 103 | `LockKeyhole` |
| `src/components/password-reset-flow.tsx` | 104 | `LockKeyhole` |
| `src/components/password-reset-flow.tsx` | 105 | `Mail` |
| `src/components/password-reset-flow.tsx` | 106 | `AlertCircle` |
| `src/components/password-reset-flow.tsx` | 107 | `CheckCircle2` |
| `src/components/password-reset-flow.tsx` | 108 | `LoaderCircle` |
| `src/components/probability-plot.tsx` | 51 | `svg` |
| `src/components/redemption-form.tsx` | 69 | `CheckCircle2` |
| `src/components/redemption-form.tsx` | 98 | `LoaderCircle` |
| `src/components/search-experience.tsx` | 86 | `Search` |
| `src/components/search-experience.tsx` | 89 | `X` |
| `src/components/search-experience.tsx` | 97 | `Search` |
| `src/components/search-experience.tsx` | 101 | `Search` |
| `src/components/search-experience.tsx` | 102 | `CalendarDays` |
| `src/components/search-experience.tsx` | 103 | `UserRound` |
| `src/components/states.tsx` | 10 | `FeatherIcon` |
| `src/components/states.tsx` | 14 | `AlertCircle` |
| `src/components/states.tsx` | 14 | `RefreshCw` |
| `src/components/suggestion-form.tsx` | 24 | `CheckCircle2` |
| `src/components/suggestion-form.tsx` | 25 | `LoaderCircle` |
| `src/components/trade-history.tsx` | 17 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 129 | `ShieldCheck` |
| `src/components/trade-ticket.tsx` | 132 | `CheckCircle2` |
| `src/components/trade-ticket.tsx` | 132 | `RotateCcw` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 144 | `FeatherIcon` |
| `src/components/trade-ticket.tsx` | 146 | `AlertCircle` |
| `src/components/trade-ticket.tsx` | 151 | `LoaderCircle` |
| `src/components/trade-ticket.tsx` | 151 | `ArrowRight` |
