# T14 compact session header evidence

- Case ID: `T14-01`
- Visible UI cases: `1`
- Fixture: local authenticated session, online Codex Agent, Capability Hub expanded, Agent panel open
- Viewport: `1280×900`, DPR `1`, Chromium
- Before baseline: `4acc743ab97c557756dd7dbcde85885aed24240d`
- After revision: this feature branch head; the PR body pins the immutable full commit SHA
- Capture source: `packages/happy-app/e2e/agent-group-panel-evidence.spec.ts`, case `AGP-01`

The before and after images use the same fixture, viewport, DPR, panel state, and full-page crop. The header is the only changed area; the open Agent panel also proves that the T04 grouped runtime/execution/session-management interaction remains available.

The dedicated `compact-session-header-evidence.spec.ts` acceptance cases additionally verify long-title truncation and focus tooltip behavior, direct hit testing of all compact controls, the unified right-panel toggle in both states, retained sidebar session creation, and the absence of horizontal overflow. A separate 390×844 Chromium case proves that the desktop-only change leaves the phone Agent chip and new-session action intact while omitting the desktop title, More, and panel-toggle controls.
