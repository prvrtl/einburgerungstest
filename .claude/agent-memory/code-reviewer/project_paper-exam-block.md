---
name: paper-exam-block
description: The .paper* block in styles.css is an off-limits BAMF-sheet simulation with a hardcoded palette, yet it consumes theme-dependent tokens (--red, --red-soft, --shadow-lg)
metadata:
  type: project
---

`static/styles.css`'s `.paper*` block simulates the official BAMF paper exam sheet. It is
treated as OFF LIMITS in redesign work, and it uses a **hardcoded, theme-independent palette**
(cream `#fdfdfb`, black `#111`, gray `#c9c9c4`) — but it still *consumes* three theme tokens:
`--red` (`.paper-timer.low`), `--red-soft` + `--red` (`.paper-warn`), and `--shadow-lg`
(the sheet's box-shadow).

**Why:** This makes the paper block a silent collateral-damage target. Any retune of the color
tokens changes how the paper sheet renders even though no `.paper*` rule was touched, and the
dark-mode token values get applied on top of the *light* cream background (the paper does not
switch palettes with the theme). E.g. the iOS redesign moved `--red` `#d93025` → `#ff3b30`,
which dropped the low-timer contrast on cream from 4.69:1 to 3.48:1 (below WCAG AA).

**How to apply:** When reviewing or making any change to the color tokens in `styles.css`,
check contrast of the new `--red` / `--red-soft` against cream `#fdfdfb` (not against `--bg`),
in BOTH the light and dark token sets, since dark-mode reds land on the same cream sheet.
"`git diff` shows no `.paper*` rule changed" is necessary but NOT sufficient.
