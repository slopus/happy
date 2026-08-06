# Session list layout toggle visual evidence

Visible UI cases: 2

## Case NAV-14-01 — Discoverable layout control

- Problem: the merged project-grouped sidebar had no visible control for changing
  how sessions are organized.
- Before: the existing `NAV-13-01` after image from `main`, which shows the project
  hierarchy without a layout toggle.
- After: `session-list-project-layout-1280x900.png`, which keeps the project
  hierarchy and adds the selected folder-layout control.

## Case NAV-14-02 — Time-ordered session navigation

- Problem: users could not scan every session as one recency-ordered timeline.
- Before: `session-list-project-layout-1280x900.png`, showing the same three
  sessions nested under `atlas` and `beta`.
- After: `session-list-time-layout-1280x900.png`, showing the same fixture under
  `Recent` / `Today`, ordered newest first with project and machine context.

All images use Chromium, English, light theme, `1280×900`, and DPR `1`.
The `[SESSION-LAYOUT]` Playwright case also checks both tooltip labels, strict
recency ordering, and persistence of both layout choices across reloads.
