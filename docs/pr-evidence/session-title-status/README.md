# T09 editable title and runtime status evidence

- Visible UI cases: `2`
- Baseline: `394a380484f484adb447c990fc2f0a81b9cc0ec0`
- After revision: this feature branch head; the PR body pins the immutable full commit SHA
- Capture: Chromium, English, light theme, DPR `1`, `1440×900`
- Source: `packages/happy-app/e2e/session-title-status-evidence.spec.ts`

## Case 1 — first-message fallback title and editable header state

- Before: sending the first message leaves the session named “New chat” and the
  header exposes neither editing nor a permanent runtime state.
- After: the first message becomes the fallback title, the header exposes an
  edit action and running state, and the same browser case proves a later manual
  rename survives a second real message.

## Case 2 — distinguish running and permission-required sessions

- Before: two sessions in the same project have no compact runtime labels and a
  permission row opens the session without jumping to its pending request.
- After: persisted running and permission-required states remain distinguishable
  after reload, and the pending row routes directly to its PermissionFooter.
  The same case deactivates the session, verifies the offline notice plus
  disabled actions, reconnects a new session socket, and verifies that actions
  and the two sidebar states recover without losing the request.

## Responsive boundary coverage

`T09-03` is an assertion-only browser case. At `800`, `1024`, and `1440` it
checks center hit-testing, ordered non-overlap, no horizontal overflow, a title
target of at least `32px`, and `40px` More and right-panel toggle targets. At
`1440` it also requires a title target of at least `120px` and a status target
of at least `44px`. PC Web intentionally uses the inline title/status identity
and does not render an Agent chip. At `390×844`, the case proves the desktop
title/status/More controls stay absent while the phone Agent chip and
new-session action remain available.
