# Navigation IA visual evidence

Visible UI cases: 1

## Case NAV-07-01 — Stable work navigation and collapsible projects

- Problem: Inbox, New session, My Agents, and Manage sessions competed as peers, while project sections could not be collapsed as the session list grew.
- Before: `case-1-before.png`, captured from clean `main` at `20f138fd8a4327c4332a15f66b28b8be0702b928`.
- After: `case-1-after.png`, captured from this implementation with the `beta` project collapsed and the selected `atlas` session still visibly highlighted.
- Fixture: the same four local E2E sessions across two machines and three projects.
- Route: the same selected `/session/:id` route.
- Viewport: `1280x900`, DPR `1`, Chromium.

The after Case also verifies that direct navigation into a collapsed project automatically expands it and marks the destination row with `aria-current="page"`.
