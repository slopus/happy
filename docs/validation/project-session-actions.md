# Project conversation actions and lifecycle

## Behavior

- Replace the project conversation ellipsis menu with separate delete and archive icons. Keep the existing delete confirmation and close-panel action.
- After removal, select the newest remaining available conversation. Continue finite Task history pagination when the loaded page is exhausted; close only when no available conversation remains.
- Exclude archived/archive-requested sessions from history lists and continuation. The daemon filters before its page limit, including sessions without a locally hydrated header; archive history still protects once-only Task execution.
- Keep owner validation, read-only previews, and late completion/navigation guards. A blurred page cancels deferred selection.
- Online global continuation uses fresh authoritative history; only newly acknowledged sessions still awaiting their first catalog/header appearance may be reused locally.

## Verification

The regressions were reproduced before the implementation, including absent-header archives, exhausted loaded pages, and a wrong-owner route exposing management actions. Related component/history tests, the complete App test suite, Wire build, App/CLI typechecks, and CLI project service/runtime tests are recorded in the PR.

A broader CLI Goal Board run encountered one `No fs.watch update` timeout in the unchanged watcher test. Its isolated rerun passed. This is separate from the changed service/runtime regressions.

## Delivery boundary

This change includes the CLI Goal service as well as the App. Full filtering of older machine history requires updating that service together with the Web/App change. No running daemon, existing conversation, or production deployment was changed during source validation.

No separate version-before/after screenshot matrix was requested. The later E2E request includes verified browser states and sampled video evidence. Physical-device interaction was not verified; browser results follow below.


## Real browser E2E (2026-11-19)

Spec: `packages/happy-app/e2e/fixtures/project-goals/verify-session-actions.ego.mjs`.
Run only through Ego against a fresh `project-goals/serve.mjs` environment. The complete App, relay, encrypted RPC, lifecycle metadata, deletion endpoint, and history service are real. The launcher creates blank synthetic relay sessions; no production daemon, worker process, or model is launched.

| Case | Task conversation | Global conversation | Assertions |
| --- | --- | --- | --- |
| C1 Direct icons | Pass | Pass | Delete/archive are direct visible controls; ellipsis entry absent; delete cancellation preserves the selected session and its HTTP 200 status. |
| C2 Delete and replace | Pass | Pass | Confirmed deletion returns HTTP 404; the panel automatically selects a remaining synthetic session, which returns HTTP 200. |
| C3 Archive filtering | Pass | Pass | Durable lifecycle becomes archive-requested/archived; daemon history excludes that archived ID; the visible menu omits archive and deleted IDs; filtering remains after a full reload. |

The test resets only IDs issued by the disposable fixture. Transport presence can update history order, so C2 checks that the replacement is a remaining available fixture session rather than assuming creation order. Every pass asserts unchanged model-submission and user-message counts.

The ordinary six cases passed. Video replay uses the same executable cases, fresh fixture sessions, owned-target CDP sampling, and explicit verified state frames. Chinese captions identify the case; the recording is sampled browser evidence, not a claimed 30-fps compositor capture. The 43.3-second, 1680×960 H.264/yuv420p/30-fps MP4 passed ffprobe, full decoding and a ten-key-state visual audit. It is delivered through Happy and saved as [the review video](assets/project-session-actions-e2e.mp4), using sampled key-state playback with readable pauses; physical-phone playback is unverified.

The actual screenshots found clipped hover hints on the new icons; the two optional tooltip props were removed while accessible names remain. Early test-only failures involved a cold modal locator, `+` versus `%20` URL binding, unsettled header geometry, and an overly strong assumption that a deleted daemon association receipt disappears. The final selectors, route serializer, stable-layout wait, API checks, and fixture reset correct those assumptions. Failed rounds are not counted as passing evidence.

A direct fixture run is:

```sh
pnpm exec tsx --tsconfig packages/happy-cli/tsconfig.json packages/happy-app/e2e/fixtures/project-goals/serve.mjs
```

Authenticate in the owned Ego page through the private auth URL, record its numeric task-space and exact target, and configure `sessionActionsConfig={contextPath,scope:'task'|'global',capture,record}` before importing the spec through `ego-browser nodejs`. The context contains the private runtime path and current Happy capture session/run identity. Never commit authentication URLs, runtime IDs, receipts, or media from `test-results`.
