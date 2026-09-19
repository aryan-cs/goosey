# Goosey UI conventions

Reference: https://mobbin.com/ (reviewed September 19, 2026). Goosey uses its restrained typography, pill controls, spacious panels, and tonal grouping. Goosey's requested borderless secondary buttons are an intentional adaptation; Mobbin's homepage itself also uses outlined secondary buttons.

## Shared primitives

Use the existing `.button` variants, `.icon-button`, `.stacked-form`, panel classes, and theme tokens. Do not recreate their borders, shadows, or radii in page styles.

- Primary action: contrast fill, on-contrast text, pill shape.
- Secondary action: sunken neutral fill, normal text, no visible outline. Hover changes the fill.
- Ghost action: transparent fill; hover uses the neutral control fill.
- Controls: `--control-height` (44px minimum), `--control-padding` (24px horizontal), `--radius-control` (pill).
- Panels: `--radius-lg`, `--space-panel` (24px), `--space-panel-mobile` (20px). Settings and related content use `--space-section` (24px).
- Nested textareas and compact notices use the smaller radius tokens. Do not make multiline textareas pill shaped.
- In-flow panels use tonal backgrounds, no decorative outline, no drop shadow. Floating navigation retains its glass treatment. Surface shadow tokens are `none` in both themes.
- Avatars use a tinted fill without an ornamental border.
- Inline values and mixed type share text baselines. Feather icons use an optical baseline offset. Keep full calculation precision; display percentages as whole numbers.

## Intentional boundaries

Borders are not prohibited when they communicate state or structure:

- Keyboard focus outlines and input focus rings remain visible.
- Selected YES/NO controls retain their outcome-colored outline.
- Linked comments and the current leaderboard user can use an accent outline.
- List separators use `--border-subtle`; trade totals use the same solid separator rather than a separate dashed style.
- Checkboxes, chart crosshairs, notification badge cutouts, and forced-colors outlines retain their functional boundaries.

## Review checklist

Check light/dark, desktop/mobile, focus, hover, selected, disabled, and wrapped text. Test real populated pages as well as empty states. Preserve existing navigation, financial values, validation, and accessibility semantics. Do not add a new override to disguise a conflicting base rule: fix the shared rule or document a specific state exception.

## Verification — September 19, 2026

Production build passed. Browser checks covered 26 real routes at 390px and 1440px in both light and dark themes (104 route/theme/width combinations): landing, market browse, both market engines, events and event detail, leaderboard, community, search, rules, watchlist, notifications, portfolio and activity, suggestions, all five settings sections, public profile, login, signup, reset password, email verification, and the authenticated admin desk. No horizontal overflow was detected. The 21 public/member routes additionally passed computed-style checks for unwanted secondary/icon button borders and control/card shadows.

Visually inspected the reference and representative desktop/mobile settings, market, landing, and admin screenshots. Confirmed borderless hover and a visible keyboard focus outline on the sign-out action. Checks used the existing isolated browser database; no production data was changed. This audit covers desktop browser mobile viewports, not physical devices or every possible application state.
