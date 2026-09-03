# Three-level navigation visual evidence

Visible UI cases: 2

## Case THREE-NAV-01 — Relationship Advisor conversation index

- Problem: opening the Relationship Advisor reused the global session library and entered a chat immediately, so the plugin had no dedicated conversation index.
- Before: `case-1-before.png`, captured from `origin/main` in an isolated Web E2E environment.
- After: `case-1-after.png`, captured by isolated Web E2E before any advisor conversation is created.
- Acceptance video: `case-1-e2e.mp4`.
- Viewport/theme: desktop Web, 1280×900, DPR 1, Gingham dark.

## Case THREE-NAV-02 — Collapsible and resizable organization pane

- Problem: the organization and session panes were fixed together; the session-pane title had no control for hiding the organization pane.
- Before: `case-2-before.png`, captured from `origin/main` in an isolated Web E2E environment.
- After: `case-2-after.png`, captured after drag-resize and refresh persistence checks.
- Acceptance video: `case-2-e2e.mp4`.
- Viewport/theme: desktop Web, 1280×900, DPR 1, Gingham dark.

The recorded E2E cases also verify that the historical project, list, tag, session actions, settings, shortcuts, plugin, and Agent entry points remain available.

The compact-width regression additionally restores a persisted 320px organization width at an 800px viewport, verifies that the rendered organization pane is capped at 242px, and confirms the session pane remains at least 200px after keyboard resize.
