# Session layout action icon evidence

Visible UI cases: 2

## Case NAV-15-01 — Project layout advertises time sorting

- Problem: while sessions were grouped by project, the toggle repeated the
  current folder layout instead of showing the action it would perform.
- Before: the merged project-layout evidence from `main@410fd4d7`, where the
  control uses a folder icon.
- After: `project-layout-clock-action-1280x900.png`, where the same project
  fixture uses a clock icon to advertise switching to time order.

## Case NAV-15-02 — Time layout advertises project grouping

- Problem: while sessions were ordered by time, the toggle repeated the
  current clock layout instead of showing the action it would perform.
- Before: the merged time-layout evidence from `main@410fd4d7`, where the
  control uses a clock icon.
- After: `time-layout-folder-action-1280x900.png`, where the same time-ordered
  fixture uses a folder icon to advertise switching back to project grouping.

All images use Chromium, English, light theme, `1280×900`, and DPR `1`. The
`[SESSION-LAYOUT]` Playwright case also checks the action icon name before and
after switching, both tooltip labels, ordering, context, and preference reloads.
