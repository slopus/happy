# Application service latency: incremental optimization

This change follows the October 9 Advisor timing audit. That audit separated cold worker launch, native model discovery, native connection prewarm, sampling, and propagation to the UI. Its cold UI samples were 21–22 seconds; warm first-text samples were 3.4–4.4 seconds. Those are historical observations, not measurements of this patch.

## Changes

- After a fresh account grant is redeemed, restore a native model catalog scoped by profile and stable account identity. Keep its original `fetched_at`, `client_version`, and 300-second native TTL. Codex remains responsible for version compatibility. Watch catalog writes so consecutive launches can benefit before the worker exits; probes also publish before returning. Auth, host config, and conversation history are not shared through this cache.
- Extract machine metadata from the daemon implementation. Load interactive authentication UI only when authentication is needed, and Codex terminal UI only with a TTY. Preserve authentication, launch policy, and worker tracing order.
- Add opt-in, bounded authenticated turn observation. A cursor covers the complete record plus sequence, so phase/cancellation/completion do not require new text. Local committed writes wake readers; one-second authoritative reads cover other server instances and revocation. No transaction is held while waiting.
- Teach the SDK (including the application bridge) to wait for changes. Old servers keep ordinary polling. A retryable transport failure disables waiting for that subscription and retries ordinary reads. Authorization/context failures still stop observation. Host ownership is checked again after a wait.
- Publish the first nonempty native text through the existing serialized queue immediately; coalesce later text for 50ms instead of the original 250ms. Retain backpressure and terminal flushing.
- Wake native readiness waits on the verified ready event, watch error, or cancellation instead of waiting for the next 250ms poll. Recheck binding, active state, errors and cancellation after the session read; retain bounded polling as a fallback for active-state propagation.
- Advisor's companion change upgrades its vendored SDK and propagates browser disconnects to bridge reads.

## Local evidence

Native Codex 0.159.3, same account, same app-server arguments, separate temporary homes, no user turns sent. Seeded cases copied a genuinely fresh native catalog; timestamps were not rewritten. Alternating samples:

| Native thread/start | Sample 1 | Sample 2 |
| --- | ---: | ---: |
| Empty model cache | 14.012s | 15.125s |
| Valid same-account model cache | 7.968s | 8.299s |

Empty-cache logs showed model refresh timeouts. These component observations support cache reuse; they do not establish a new end-to-end UI SLA. A first-ever account launch or expired/mismatched cache still needs native discovery.

Packaged module import checks used the actual chunks referenced by each `codexWorkerEntry.mjs`, comparing the deployed baseline with this build, three alternating samples in fresh Node 24 processes. Final run medians:

| Import stage | Baseline | Patched |
| --- | ---: | ---: |
| Authentication module | 405ms | 162ms |
| Codex runtime module | 1229ms | 827ms |

These are module evaluation measurements, not total worker startup. Earlier runs under concurrent test/build load varied substantially; do not add these independent measurements into a claimed page latency.

## Validation

- CLI: 75 focused tests across cache/launch lifecycle, command entry, worker publication and affected agent wrappers passed. This Mac's filesystem-heavy launch tests exceeded the default 5s timeout in earlier runs; the final run used one worker and a 15s per-test timeout. No production timeout or assertion was relaxed.
- SDK service suite: 89 tests passed, including bridge cursor propagation, host authorization recheck, immediate same-sequence completion, and failed-wait fallback.
- Server: 76 relevant tests passed across service persistence, grants, actual HTTP transport, turn/history handling, observations and installed-package smoke acceptance, in separate runs. Native-provider/browser acceptance cases were not invoked.
- New tests cover stale/future/oversized/corrupt catalogs, account/profile isolation, concurrent writers, FIFO/symlink handling, state-only updates, notification races, cross-server fallback, disconnect cleanup, and revocation during an actual route wait.
- CLI, server and SDK typechecks passed. SDK and CLI builds passed. Independent review: PASS after two identified edge cases were fixed.
- Advisor companion: build passed; 188 tests passed and 2 existing cases skipped with the new installed tarball.
- First-text follow-up: 35 focused native-runtime/worker tests passed, with CLI build/typecheck. Readiness tests use a 10-second fallback and verify that ready/error/abort wake it immediately, that changed bindings prevent sending, and that timers/subscriptions are cleaned up. Publication tests verify no first-text coalescing timer, burst coalescing, a blocked first publication followed by more text and completion, and monotonically increasing output sequences. Independent follow-up review: PASS.

## Production baseline retest before activation

The production Ego retest on October 9 still ran the prior deployed release: a new conversation first displayed text after 19.012s; a repeated short answer after 4.437s; a longer answer after 3.389s and finished at 9.488s, with roughly one-second display updates. These are not results of this branch. PR #698 has no CI checks; workflow dispatch returned HTTP 422, `Actions has been disabled for this repository`, so it has not been merged or activated.

The additional readiness and first-text changes remove application scheduling waits (up to one poll interval and the initial coalescing window), not native provider computation. Their end-to-end benefit must be measured after activation. They do not justify promising a specific new UI first-token time.

## Release and remaining limits

This record is pre-deployment evidence. Merge and activate the server and CLI release, then install the companion Advisor SDK build; changing only the Paws Web bundle is insufficient. Preserve existing native workers during daemon activation. After activation, repeat the original Ego cold/new-conversation/warm/long-answer cases, recording click, admission, claim, thread/start, first native delta and first visible text independently.

Native WebSocket/prewarm and provider response time still exist. This patch does not change undocumented native flags, weaken account isolation, or introduce a cross-account process pool. Multi-version native clients may reject the most recently cached catalog and refresh normally. A process-local notifier accelerates one-instance delivery; cross-instance delivery falls back to bounded database reads.
