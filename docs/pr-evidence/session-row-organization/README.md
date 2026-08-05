# Session row organization visual evidence

These four pairs were captured with the repository Web E2E harness in Chromium,
English, light theme, and DPR 1. The `before` images use `origin/main` at
`b5ec84b5`; the `after` images use this branch rebased on that same commit.
Each pair uses the same seeded title/path and the same viewport.

## Case 1 — honest location and overflow details

- Viewport: 1280x900
- Before: hovering a long session row exposes neither its full title nor its
  project, machine, agent, relative time, and running status.
- After: the row shows an honest location line, the browser title hint is set
  only for real overflow, and hover reveals the complete detail card.

## Case 2 — keyboard actions without accidental navigation

- Viewport: 1280x900
- Before: keyboard focus offers no visible Pin/Archive actions or detail card.
- After: focus reveals 40px Pin/Archive controls and details; activating Pin
  keeps the user on `/new` and Escape dismisses the disclosure.

## Case 3 — archive is distinct from restore/resume

- Viewport: 1280x900
- Before: archived rows are expanded by default and do not expose an explicit
  list-membership Restore action.
- After: archive removes the row from the default list; expanding Archived
  exposes Restore, never Resume, and restoring changes encrypted lifecycle
  metadata without starting an agent or faking online presence.

## Case 4 — narrow and touch action parity

- Viewport: 799x900
- Before: the narrow drawer row has no discoverable More affordance.
- After: More exposes the same Pin and Archive capabilities without nesting
  action buttons inside the row navigation target.
