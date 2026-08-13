# Relationship Advisor history and desktop Agent dialog

All screenshots use a 1280x900 CSS viewport, DPR 1, and the same isolated local authenticated environment.

| Case | Before | After |
| --- | --- | --- |
| Advisor conversations were not available in the left sidebar | `case-1-before-history.png` | `case-1-after-history.png`; `case-1-after-history-gingham-dark.png` verifies selected and pressed surfaces under the non-default dark theme |
| My Agents opened as a full-width bottom drawer on desktop | `case-2-before-agent-drawer.png` | `case-2-after-agent-dialog.png`; `case-2-after-agent-dialog-gingham-dark.png` verifies the opaque dialog surface under the non-default dark theme |

The deterministic Playwright Case is `[RELATIONSHIP-ADVISOR-HISTORY]` in `packages/happy-app/e2e/web-compose-home.spec.ts`.
