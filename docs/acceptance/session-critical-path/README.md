# Session critical-path acceptance gate

Task 10 runs this acceptance procedure with the existing authenticated Ego workflow, an online selectable machine, and a known deep-link session. Do not use Playwright or another browser runner.

Before collecting or storing evidence, redact it. Never include login or account data, browser storage, credentials, cookies, tokens, device identifiers, private prompts, internal addresses, server addresses, or screenshots that reveal any of them. Evidence is limited to resource URLs and the two durations below. Use a safe HTTPS origin and known session ID only as command parameters; do not put them into this document or a checked-in evidence file.

## Gate commands

Run these commands from the repository root, replacing the angle-bracket placeholders with your values. The `--silent` option keeps pnpm's script banner out of the output; pass script flags directly without an extra standalone `--` (pnpm 10.11 forwards it to the script as an invalid argument).

Print the self-contained browser-side collection contract before starting the two paths:

```sh
pnpm --silent --filter happy-app run perf:session-critical-path \
  --origin <https-origin> \
  --session-id <known-session-id> \
  --mode print-ego-probe
```

Install the printed expression at **document start, before all application scripts**, using a verified document-start injection capability in the existing Ego workflow. A normal evaluation after navigation is not valid evidence. If that injection capability is unavailable, stop the measurement and report `RESOURCE_COLLECTION_FAILED`; do not substitute an after-navigation evaluation or claim a passing gate.

The expression installs and returns the in-memory `__happySessionCriticalPathProbe` object; re-evaluation during a same-document route transition returns that same object. It records legacy request initiation through `fetch` and `XMLHttpRequest.send`, without reading headers or bodies, and preserves their original arguments, return values and errors. Initiation records cover requests that complete after either resource freeze (including failed requests); legacy fetch/XHR ResourceTiming entries are not counted twice. Only a redacted exact-path legacy URL is retained for those initiation records. `PerformanceObserver` still collects other resource entries and drains pending completion records before freezing. It does not issue requests, read storage/credentials, or create application data.

Installation fails closed unless `document.readyState` is `loading`, no document scripts exist yet, and fetch/XHR instrumentation and `PerformanceObserver` are available. Failed installation, failed initiation capture, or later replacement of the wrapped APIs permanently invalidates the whole document's evidence, even if APIs are restored. Recover by installing in a new document before application scripts. Observer-only failures remain generation-scoped as described below.

Each generation permanently latches any collection failure, including observer initialization, seeding, callback entry reads/filtering, pending-record draining, or disconnection. Callback errors are contained; initialization, completion freezing, and `collect()` report the fixed code `RESOURCE_COLLECTION_FAILED` and message `Critical-path resource collection failed.` without the original error, message, or stack. Completing more marks or restoring the failed API cannot repair that generation. Both init methods replace the old generation before reading timing or initializing an observer, so a failed re-init cannot return old passing evidence; partially initialized observers are disconnected. Start a new healthy generation and repeat its measurements to recover. Callbacks from disconnected generations are ignored.

Run both paths in the same fresh authenticated Ego document so the probe can collect the two required durations:

1. Arrange document-start installation before opening the known deep link; then call `probe.initFreshDeepLink()` from the installed probe. This starts a new deep-link generation, clears its prior mark/snapshot/observer, and anchors collection at navigation timing's `startTime`. Initiations captured since installation cover early requests even when no ResourceTiming entry exists yet. When the header is visible, call `probe.markFreshHeaderVisible()`; when the latest message is complete, call `probe.markFreshLatestMessageComplete()`. Once both marks exist, the probe freezes both completion and initiation evidence and disconnects the deep-link resource observer.
2. At the new text session's send click, call `probe.startNewTextSession()` immediately before the click. This starts a new spawn generation, clears its prior mark/snapshot/observer, and anchors resource collection at that send-click time; entries before the click are excluded. Call `probe.markNewSessionEvent()` and `probe.markLocalQueue()` when those diagnostic events occur. Call `probe.markRouteNavigation()` at route navigation: this records `spawnNavigateMs` but does **not** freeze resources. Keep the observer active, then call `probe.markFirstAgentEvent()` at the first agent event and `probe.markTurnCompletion()` only when the turn completes. `markTurnCompletion()` is the required spawn completion and freezes/disconnects the spawn resource observer. If the route changes without a document reload, re-evaluate the printed expression and retain the returned probe before calling the remaining marks.
3. Do not call either init again for the generation being measured: a repeated init intentionally disconnects the old observer and invalidates prior completion marks and frozen URLs for that path. After deep-link completion and spawn turn completion, call `probe.collect()`. It flattens only the two frozen per-path snapshots into the minimal JSON below, so timing-buffer eviction after either completion cannot remove evidence. Save exactly that returned object with no additional fields:

```json
{
  "resources": [{ "name": "https://redacted.invalid/path" }],
  "deepLinkInteractiveMs": 2000,
  "spawnNavigateMs": 7000
}
```

Evaluate it:

```sh
pnpm --silent --filter happy-app run perf:session-critical-path \
  --origin <https-origin> \
  --session-id <known-session-id> \
  --mode evaluate-json \
  --input <measurement-json-path>
```

The command prints `{ ok, legacySessionCalls, deepLinkInteractiveMs, spawnNavigateMs }` to stdout for valid evidence, including an evaluator failure, so it is always parseable JSON. It exits non-zero if either duration exceeds its limit or a resource URL has the exact pathname `/v1/sessions`. Query strings and fragments do not bypass that check. The boundary values 2000 ms and 7000 ms pass.

Invalid invocation or evidence emits exactly one JSON object to stderr and exits non-zero: `{ "ok": false, "error": { "code": "..." } }`. Defined fixed codes are `INVALID_ARGS`, `INVALID_ORIGIN`, `INVALID_SESSION`, `INVALID_MODE`, `MISSING_INPUT`, `UNREADABLE_INPUT`, `INVALID_JSON`, and `INVALID_EVIDENCE`; no input path, parser detail, stack, or environment detail is emitted.

## Required two runs

1. **Fresh-context deep link.** In a fresh authenticated context, open the known session deep link. The probe measures navigation start to both visible header and latest-message completion; it records the later completion as `deepLinkInteractiveMs`.
2. **New text session.** Send a safe test message in a new text session. The probe measures send click to route navigation as `spawnNavigateMs`, then continues resource collection through the first agent event and required turn completion. The new-session event and message queue marks remain diagnostic context inside its in-memory namespace only.

For both critical paths, perform the final resource assertion: exact-path `/v1/sessions` calls must be **0**. The evaluator accepts only the minimum evidence fields shown above and rejects malformed JSON, malformed shapes, and malformed resource URLs.

Task 10 is responsible for executing Ego, collecting screenshots or MP4 evidence when needed, and cleaning up any test-created side effects. This Task 9 gate neither runs a browser nor performs those actions.
