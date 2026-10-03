# App authorization UI regression

Run from the repo root: `node packages/happy-app/sources/trash/app-authorization-ui/serve.mjs`.
Open the printed loopback URL in Ego. `/` renders the real authorization route; `/list`
renders the real authorized-apps route. `?theme=ginghamLight` selects the light theme;
`?empty=1` removes the fixture devices.

This uses the actual React Native Web controls, route components and theme tokens.
Auth, API, encryption, router, and modal confirmation are deterministic boundaries.
No real account, recovery secret, authorization, Agent or production data is used.
This does not validate the full application shell or native device behavior.

Cases:
- A: without a device, Allow connection is disabled/opacity 0.45. After selection it
  is enabled/opacity 1. Submission locks all choices and exposes aria-busy.
- B: click, Tab/Space and arrow keys select the device or duration; radio state and
  focus agree. Check hover, selection and focus under ginghamDark.
- C: content max width 640; buttons share the same boundaries. At 390px all controls
  remain visible without horizontal overflow.
- D: authorized apps have explicit active/revoked states; only active grants can be
  revoked. Confirmation and API effects here use isolated fixture data.
- E: set `window.fixtureFail=true`, submit, and verify error feedback, retained
  selection and enabled retry. Reset it to false before the successful video run.

`window.fixtureApprovals` records requests for duplicate-submit and selected-machine
assertions. These fixture fields are not present in production builds.

Verified 2026-10-03 using Ego task 418: A/B/C/D/E pass at 1440x900 ginghamDark;
C/E pass at 390x844 ginghamLight. Independent code and PC component review pass.
Root app typecheck, 6 button/keyboard tests and 7 OTA contract tests passed.
Before/after PR screenshot request was pending; supplied user screenshots establish
original defects, base revision 459a4994. Skills progress frames show the verified
new component states; no matched Before/After PR matrix is claimed.

## Integration with permanent authorization (main #677)

Mac mini advertises protocol 2; MacBook Pro advertises protocol 1. Select permanent
authorization on MacBook Pro: Allow connection stays disabled with an upgrade hint.
Select 1 day to restore it, then Mac mini + permanent: request expiresAt must be null.
The active fixture grant is permanent and must remain active/revocable in the list.
Verified 2026-10-03 in Ego task 428; 16 targeted tests and app typecheck passed.
