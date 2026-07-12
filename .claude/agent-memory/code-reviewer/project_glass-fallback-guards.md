---
name: glass-fallback-guards
description: Translucent-surface CSS in static/styles.css has bitten this project twice on @supports guards — check both color-mix AND prefixed backdrop-filter
metadata:
  type: project
---

Any translucent/frosted surface in `static/styles.css` needs TWO independent guards, and both have been gotten wrong before:

1. `@supports not (background: color-mix(in srgb, red 50%, transparent))` — a background built from `color-mix()` becomes invalid-at-computed-value-time on Safari < 16.2 and the element renders with NO background (transparent), not with the previous background. The Liquid Glass plan called this out as "the exact bug we already fixed once".
2. `@supports (backdrop-filter: ...)` is FALSE on Safari <= 17, which supports only `-webkit-backdrop-filter`. Guards must be written as `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))`, otherwise the fallback fires on all pre-18 iOS Safari and silently disables the effect for a large share of this app's mobile users.

**Why:** the app is a mobile-first PWA; iOS Safari is the dominant client, and it is precisely the browser where these two features shipped years apart.

**How to apply:** when reviewing or writing any `backdrop-filter` / `color-mix` CSS here, check both guards and confirm the fallback restores a *solid background*, not merely `backdrop-filter: none`. See also [[paper-exam-block]].
