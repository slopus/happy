# Codex-style session action icon evidence

Visible UI cases: 1

## Case NAV-16-01 — Session hover actions match Codex semantics

- Problem: the desktop session row represented pinning with a five-pointed
  star and exposed no direct delete action, despite the Codex reference using
  distinct pin, delete, and archive controls.
- Before: `session-actions-before-1280x900.png` shows the old star and archive
  pair.
- After: `session-actions-after-1280x900.png` shows the unified Octicons pin,
  trash, and archive controls while preserving the hover detail card.

Both screenshots use Chromium, English, light theme, `1280×900`, and DPR `1`.
The `[NAV-13-01]` Playwright case also asserts that the rendered icon nodes are
named `pin`, `trash`, and `archive`.
