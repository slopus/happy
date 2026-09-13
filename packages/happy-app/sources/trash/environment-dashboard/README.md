# Device environment controlled browser acceptance

Run from `packages/happy-app`:

```sh
node sources/trash/environment-dashboard/build.mjs
```

Open `http://127.0.0.1:4387/` using Ego only. The source is bundled at server startup; restart this server after changing production code.

This exercises the production `DeviceEnvironmentView`, `useEnvironmentDashboard`, runtime store and React Native Web. It replaces only external boundaries: auth, machine storage, RPC, translation selection, the Unistyles runtime, icon glyphs and modal confirmation. Theme tokens and Chinese translations are imported from production. The surrounding dialog reproduces existing desktop dimensions; real navigation integration is covered by `DesktopDeviceEnvironmentModal.integration.test.tsx`, not by this fixture.

No network RPC, package commands, real credentials, or persisted machine configuration are used. No need for SSH, production login, or daemon restart. Do not deploy this fixture as the product.

## Fixed cases

| Case | Entry and operations | Expected evidence |
| --- | --- | --- |
| ENV-1 | `/`, 1365 × 768; wait for auto inspection | Three device columns, five tool rows and footer fit; no `start` events |
| ENV-2 | Click `environment-action-device-2-github-cli`, then `environment-update-type-github-cli` | One write to device 2; then two remaining GitHub writes, no other tools |
| ENV-3 | Then click `environment-update-all` | Nine remaining writes, up to three machines simultaneously, never two writes overlapping on one machine |
| ENV-4 | `/?scenario=failure`; toggle device 3 offline, update all, retry device 2 GitHub | Seven successes, one failure, no offline writes; targeted retry succeeds |
| ENV-4 unknown | `/?scenario=uncertain`; update device 1 GitHub, then scan | Only one write; all device 1 changes remain disabled; explicit unresolved explanation is visible |
| ENV-5 | During ENV-3 close via `fixture-close`, reopen via `fixture-open` | Same running batch; final nine-success result remains visible |
| ENV-6 | `/?theme=gingham`, desktop and 390 × 844; scroll `environment-device-columns` | Semantic theme colors; fixed tool identity, device 3 reachable, footer and page remain in viewport |
| CQ-1 | `/`, 1440 × 900 or 1024 × 768; click `codex-account-refresh-fixture-codex-account` and accept the confirmation | The fixture account changes from unknown to a current 7-day remaining percentage; a synthetic `quota-refreshed` event is recorded with no network or Codex process |

`window.fixture.calls` contains allowlisted fixture events (`inspect`, `start`, `end`, `failed`, `uncertain`) with machine/tool/time. Use it only as an assertion boundary alongside visible state. Reloading starts a fresh synthetic scenario.

Example Ego round (use the returned numeric space and exact target in later rounds):

```sh
ego-browser nodejs <<'EOF'
const task = await useOrCreateTaskSpace('device environment controlled regression');
await openOrReuseTab('http://127.0.0.1:4387/', {wait:true});
await cdp('Emulation.setDeviceMetricsOverride', {width:1365,height:768,deviceScaleFactor:1,mobile:false});
await wait(1.2);
cliLog({taskId:task.id,tab:currentTab});
cliLog(await snapshotText());
cliLog(await js('window.fixture.calls'));
const {captureVerifiedBrowserStep} = await import('file:///Users/jacky/.nvm/versions/node/v24.20.0/lib/node_modules/@wangjs-jacky/paws/scripts/capture-browser-step.mjs');
cliLog(await captureVerifiedBrowserStep({cdp,pageInfo,currentTab}, 'http://127.0.0.1:4387/'));
EOF
```

Report each verified Ego round to Happy with its private screenshot, fresh invocation runId and `skillName=ego-browser`. Record positive-path video only after assertions pass. A plain browser `window.confirm` is only a fixture substitute, not evidence for the production Modal host; cancellation/explicit acknowledgment is covered by component tests.

## Deliberate limits

- No real package installation, native-device behavior, whole-App theme runtime, production modal focus integration, or transport/daemon restart is proven by this fixture.
- Queues survive modal unmount within one authenticated app runtime, not browser or App termination.
- Unknown remote completion remains blocked through ordinary scans. Recovery requires the user to verify that the remote process ended and explicitly acknowledge it; acknowledgment only scans, never retries.
- Separate simultaneous clients are outside the front-end queue guarantee; the existing daemon still owns its component-level lock and plan validation.
- Secret transfer (npm tokens, cloud AK/SK) is a separate future feature.
