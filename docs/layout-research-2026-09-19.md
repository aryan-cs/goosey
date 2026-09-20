# Viewport and layout review — September 19, 2026

## Problem and acceptance criteria

The market page used a large heading/chart while the order form started below refresh metadata. At a laptop viewport, its submit button disappeared below the fold. The homepage similarly spent most of the initial screen on introductory decoration.

Prioritize the question, price context and action on the initial desktop screen. On compact screens, provide a direct trade entry and place the actual ticket before long explanatory sections. Longer rules, history and expanded options may scroll normally: fitting everything by clipping content or reducing readable controls is not the goal.

## Research and decisions

Three agents independently researched dashboard layout, market interfaces and responsive behavior, then reviewed the actual app.

| Source | Relevant guidance | Application in Goosey |
| --- | --- | --- |
| [Tableau dashboard best practices](https://help.tableau.com/current/pro/desktop/en-us/dashboards_best_practices.htm) | Design for actual display sizes; automatic fill behavior can impair smaller layouts. | Bound chart height with viewport-aware minimum/maximum values; check short laptops as well as phones. |
| [Material canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) | Supporting panes adapt across window sizes. | Desktop overview and ticket remain side by side; mobile places the ticket before rules/discussion and supplies direct entry links. |
| [NN/G progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Make frequent tasks readily available; defer secondary complexity. | Preserve the existing advanced-order disclosure, keep costs visible, and move refresh metadata beneath the ticket. |
| [GOV.UK text inputs](https://design-system.service.gov.uk/components/text-input/) | Field presentation should match expected input and use visible labels. | Price and quantity share a row when there is sufficient room, with labels and units retained. |
| [GOV.UK buttons](https://design-system.service.gov.uk/components/button/) | Give primary actions clear prominence. | Keep the trade CTA visible in the default laptop layout. |
| [IBM Carbon data tables](https://carbondesignsystem.com/components/data-table/usage/) | Consistent density and row sizing support scanning. | Reduce repeated gaps rather than shrinking text and targets. |
| [W3C target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) and [focus visibility](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum) | Interactive targets and focused controls must remain usable. | Keep primary controls at least44px high; remove the floating mobile entry bar when its target form is selected or focused. |
| [Kalshi market scanning guidance](https://alpha.kalshi.com/pro/help/markets-scanning-filtering-searching) | Readable questions and useful filtering support market discovery. | Retain the existing browse controls; prioritize actual market cards on the homepage. |
| [Polymarket predictions](https://polymarket.com/predictions) | Public interface exposes categories, sorting and status filtering. | Keep discovery accessible without adding another oversized introductory section. |
| [Mobbin](https://mobbin.com/) | Public catalog offers navigation, settings and bottom-sheet examples. | Preserve Goosey's existing typography, surfaces, radius tokens and frosted navigation. No authenticated Mobbin screen library was accessed. |

Specific dimensions are our implementation choices, not claims that these sources prescribe particular pixel measurements.

## Implementation

- New scoped CSS modules for homepage, market detail and order-book density; no global reset or business logic changes.
- Market question uses a restrained responsive size; chart plot height is bounded by viewport height rather than viewport width.
- Price/quantity fields share a row at sufficient container width. Refresh details no longer displace the ticket.
- Market information, rules and discussion follow the trading panel in the mobile reading order. Desktop retains the overview/details column beside the ticket.
- Mobile order-book Trade YES/NO links preserve the selected outcome and jump to the single real form, without duplicate forms or IDs.
- Homepage redundant decorative mark/explanation is suppressed and section spacing reduced. First market actions are visible without scrolling at the checked common sizes.

## Verification

- Market detail:1280×720 and1366×768. Ticket approximately510px tall;44px submit control bottom at638px in the720px viewport.
- Mobile order book:390×844. Trade entry jumps to the form at84px; complete default ticket fits. Expanded options remain accessible through normal scrolling.
- Homepage:1366×768 first card at453px, outcome actions717–761px;390×844 first card at494px, outcome actions758–802px.
- Checked narrow320px layouts for horizontal overflow; inspected light/dark views.
- Other screens reviewed: browse filtering remains usable, signup submit fits390×844, and settings appearance controls fit without excessive spacing.
- ESLint, TypeScript and production build checked. No orders submitted and no market/account seed data changed for this layout review.

Measurements describe these test viewports and content, not a guarantee against scrolling with arbitrary zoom, expanded options, long translated text or validation messages.
