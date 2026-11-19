# Web popover click-away repair

Base: 4a9eccf6. Scope: Web session settings, new-session sidebar inline selectors, sidebar account/help menus.

## Cause and behavior

SessionInfoDropdown relied on an absolute backdrop constrained to its screen; its full-width dropdown wrapper intercepted clicks in transparent gutters. Sidebar account/help backdrops similarly covered only the sidebar. SessionConfigPanel sidebar inline pickers had no click-away listener at all.

A shared Web-only capture-phase pointer listener now closes those transient surfaces across layout boundaries, including targets that stop bubbling. Panel contents and owning triggers are excluded; triggers retain their own click toggle. The full-width session dropdown wrapper uses box-none on Web, preserving the original native pointer behavior. Sidebar click-away suppresses trigger refocus so it does not steal the outside target's focus. Listeners are removed on close/unmount.

Other inspected surfaces already have full-screen modal/portal backdrops or outside listeners: composer context/model/permission/directory menus, session row/context actions, file-tab context menus, reading-width control, project history/task switchers, and browser-step viewer. No speculative changes were made there.

## Validation

- 124 tests in 10 relevant files passed, including new DOM pointer-event coverage, session panel ownership, sidebar selector pointerdown→click toggle, and existing sidebar/menu regressions.
- Complete happy-app `tsc --noEmit` passed; `git diff --check` passed.
- Independent review passed after correcting a discovered sidebar toggle regression.
- Ego with actual SessionInfoDropdown + React Native Web: internal model click keeps panel; repeated More click closes; sidebar outside click closes and increments its action count once; transparent gutter click closes.
- Rerun browser fixture: from packages/happy-app, `node e2e/fixtures/popover-dismiss/serve.mjs`, then visit its printed loopback URL with Ego. Model/store/machine boundaries are synthetic. This is an actual-component browser test, not a complete authenticated App or production test.
- Screenshot choice was asked and remains unanswered; no screenshots/video were captured, and no browser Skills frames were reported. This does not block the code repair under CLAUDE.md.
- Native behavior was not changed intentionally or device-tested. Formal Web deployment and OTA are separate from local validation.

## Knowledge

Ego operation: ego-ops/references/sites/paws/operations/verify-popover-dismiss.md. Full knowledge validator ran but encountered a pre-existing unrelated missing `web-annotations/review-cli-callback-design` operation registration; no unrelated files were repaired.
