# Codex-style session list visual evidence

Visible UI cases: 1

## Case NAV-13-01 — Compact project navigation and row disclosure

- Problem: project avatars, card borders, per-row status dots, mixed icon families,
  and a details card inserted below the hovered row made the session rail visually
  noisy and allowed the last row's details to cover the following project.
- Before: `session-list-codex-style-before-1280x900.png`, captured from the
  existing clean-`main` navigation fixture.
- After: `session-list-codex-style-after-1280x900.png`, captured from the updated
  `NAV-13-01` Playwright case with a long session title in its hover state.
- Viewport: Chromium, English, light theme, `1280×900`, DPR `1`.

The After case also asserts that the long title enters marquee mode, the status,
pin, and archive actions remain inside the sidebar, and the details popover begins
strictly to the right of the sidebar boundary. Keyboard, narrow-screen More-menu,
touch-Web, archive, and restore behavior are covered by the remaining NAV-13 cases.
