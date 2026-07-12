# Memory index

- [Paper-exam block](project_paper-exam-block.md) — the off-limits `.paper*` BAMF sheet has a hardcoded palette but consumes `--red`/`--red-soft`/`--shadow-lg`; token retunes silently damage it
- [Glass fallback guards](project_glass-fallback-guards.md) — translucent CSS needs both a `color-mix` guard and a *prefixed* `backdrop-filter` guard; each has broken iOS Safari here before
