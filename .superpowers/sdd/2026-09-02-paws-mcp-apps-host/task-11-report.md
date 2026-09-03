# Task 11 report — allowlist-only MCP App telemetry

Commit: `9a71ebdb` (`feat(mcp-apps): add redacted lifecycle telemetry`)

## Delivered

- Added typed, runtime-normalized telemetry builders in CLI and App with exactly six emitted fields: `platform`, `stage`, `durationBucket`, `byteSizeBucket`, `originScoped`, and `outcomeCode`.
- Added the five approved product event names only: `mcp_app_render_started`, `mcp_app_render_succeeded`, `mcp_app_render_failed`, `mcp_app_tool_call_requested`, and `mcp_app_tool_call_resolved`. Unknown runtime event names are dropped.
- Added deterministic bounded duration/byte buckets and an explicit outcome allowlist. Invalid values collapse to `unknown` buckets or `MCP_APP_INTERNAL`; no raw numeric duration/size is emitted.
- Added CLI action-boundary diagnostics around the trusted `mcpAppToolCall` RPC. Requested/resolved events cover success, authorization denial, explicit cancellation, operation timeout, catalog denial, and safe result validation while deriving only a byte bucket and origin-scoped boolean from trusted handler state.
- Added App render and action telemetry at Host Controller/frame boundaries. Render events cover resource, sandbox, and initialize stages; tool events cover successful, failed, cancelled, and rate-limited request settlement.
- Connected the App sink to the existing opt-out-aware PostHog `tracking?.capture` path and the CLI sink to the existing file-only structured debug logger. The emitter catches sink exceptions, and telemetry never controls an operation branch.

## TDD evidence

- Initial canary RED: the CLI command failed at pre-test typecheck because `./mcpAppTelemetry` did not exist; the App suite failed collection for the same missing module. No tests were collected, which was the expected missing-feature failure.
- Builder GREEN: the initial CLI and App telemetry suites each passed 4/4 tests after the minimal modules were added.
- Integration RED: the real App Host Controller suite ran 21 tests with 2 failures because no lifecycle/action events were emitted. The CLI handler command failed typecheck because `telemetry` was not accepted and its runtime suite had the intended event assertion failure.
- Integration GREEN: CLI module + handler passed 64/64 tests; App module + Host/component/controller passed 31/31 tests.
- Runtime event-name RED: each telemetry suite ran 5 tests with 1 failure because an unknown canary event name reached the sink. GREEN adds the exact five-name runtime set.
- App rate-limit RED: controller + telemetry ran 27 tests with 1 failure because a tool request rejected before the operation body produced no requested/resolved pair. GREEN now emits `started` and stable `MCP_APP_TIMEOUT` without changing the existing limiter branch.
- Final fresh GREEN: CLI security matrix passed 6/6 files and 102/102 tests; App security matrix passed 10/10 files and 112/112 tests.

## Exact verification

```text
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/__tests__/permissionHandler.test.ts
Test Files  6 passed (6)
Tests       102 passed (102)

pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/sync/apiSocket.test.ts sources/utils/otaRuntimeConfig.test.ts
Test Files  10 passed (10)
Tests       112 passed (112)

pnpm --filter @wangjs-jacky/paws typecheck
exit 0

pnpm --filter happy-app typecheck
exit 0

node packages/happy-app/scripts/build-mcp-app-host-shell.cjs --check
exit 0

git diff --check
exit 0

git diff --exit-code -- packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts packages/happy-app/ota-runtime-versions.json packages/happy-app/scripts/ota-runtime-config.js
exit 0
```

## Emission sites

- `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts`: trusted tool RPC requested/resolved boundaries.
- `packages/happy-app/sources/components/tools/mcpApps/hostController.ts`: render resource/sandbox/initialize lifecycle, active-frame failure, tool requested/resolved, and pre-operation rate-limit settlement.
- `packages/happy-app/sources/components/tools/McpAppHost.tsx`: product analytics sink only; no caller metadata is added.

## Files changed

- `packages/happy-cli/src/codex/mcpApps/mcpAppTelemetry.ts`
- `packages/happy-cli/src/codex/mcpApps/mcpAppTelemetry.test.ts`
- `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.ts`
- `packages/happy-cli/src/codex/mcpApps/registerMcpAppRpcHandlers.test.ts`
- `packages/happy-app/sources/components/tools/mcpApps/mcpAppTelemetry.ts`
- `packages/happy-app/sources/components/tools/mcpApps/mcpAppTelemetry.test.ts`
- `packages/happy-app/sources/components/tools/mcpApps/hostController.ts`
- `packages/happy-app/sources/components/tools/mcpApps/hostController.test.ts`
- `packages/happy-app/sources/components/tools/McpAppHost.tsx`
- `packages/happy-app/sources/components/tools/McpAppHost.test.tsx`

## Sensitive-value search

- Canary serialization snapshots in both packages assert exact six-key objects and reject canary URI, connector, arguments, result, `_meta`, and HTML keys/values.
- Unknown platform/stage/outcome runtime values collapse to bounded safe values; unknown event names do not reach a sink.
- Synchronous throwing-sink tests pass in both packages and prove diagnostics cannot throw into MCP App control flow.
- Production grep across both telemetry modules found no resource URI, connector/account/call/origin IDs, tool/app/server identifiers, arguments, results, `_meta`, HTML, URL, raw error, message, summary, or stack fields.
- Changed logging/capture grep found only the fixed allowlisted telemetry paths: CLI file logger, App PostHog sink, and calls to the non-throwing typed emitter. Canary strings appear only in tests.

## Self-review / concerns

- The App Host has no connector/trusted-origin authority by design, so App-side events report its own `originScoped: false`; the CLI trusted boundary records the accurate origin-scoped bit without widening the encrypted App protocol or exposing authority metadata to the View.
- Telemetry uses a separate observation clock and does not alter the existing injected rate-limit clock, timeout deadlines, cancellation controllers, permission flow, authority derivation, response envelopes, or error mapping.
- Request/result bodies are never passed to a sink. CLI computes byte counts only through the already-bounded validated JSON boundary and emits only the bucket; App currently emits the zero bucket for tool payloads rather than serializing View values for analytics.
- Generated Host Shell and OTA runtime contract files remain byte-for-byte unchanged. Runtime/device/Web E2E remains a later task gate.
- The two untracked Task 14 E2E paths remain untouched and excluded from staging.

## Fix round 1

Commit: `ea286331` (`fix(mcp-apps): harden telemetry outcomes`)

### Findings addressed

- Expanded both telemetry sink contracts to `void | PromiseLike<void>`. Emitters still return synchronously, immediately assimilate a returned thenable with a native Promise, attach an inert rejection handler, and contain synchronous sink throws plus hostile then getters/methods without awaiting or changing MCP App control flow.
- Recorded the first App Controller-owned request termination cause beside the abort it owns. Exact View cancellation emits `cancelled`; the local 30-second request deadline emits `MCP_APP_TIMEOUT`; downstream `MCP_APP_SESSION_OFFLINE` cannot overwrite either known cause. Controller teardown/disposal deliberately has no local cancel/deadline marker and remains `MCP_APP_SESSION_OFFLINE`.
- Made App action byte-size buckets honest. Requested and successful resolved events compute caught, capped UTF-8 JSON sizes from the already-validated request/result values. Serialization failure maps through `NaN` to the existing explicit `unknown` bucket instead of fabricating zero; no raw serialized value leaves the helper.
- Made CLI `originScoped` reflect the actual outgoing direct-call boundary. It starts false and flips true only when the immutable host-derived `originCallId = binding.callId` is attached to the Codex call. Success and cancellation after execution begins resolve true; permission/catalog/rate/timeout paths that never issue the call remain false.
- Strengthened CLI action tests to require exactly one requested/resolved pair, exact order, stable outcome, origin-scoped semantics, and no duplicates for success, denial, explicit cancellation, catalog timeout, and concurrency-rate rejection.

### RED / GREEN

- App RED: telemetry module + controller ran 32 tests with 6 failures and 26 passes. Failures were the missing async/hostile thenable handling, hard-coded zero request/result sizes, downstream offline overriding local cancellation/deadline, and missing serialization fallback. The first timeout run also exposed a test-order unhandled warning because its rejection expectation was attached after advancing fake time; the test was corrected to attach before advancing, without changing production behavior.
- CLI RED: telemetry module + handler ran 67 tests with 3 failures and 64 passes. Failures were async/hostile thenable handling and successful direct execution reporting `originScoped: false`. Tightened downstream pair assertions were then exercised after the first failure was removed.
- A test-only typecheck caught concise arrow sinks returning `Array.push()`'s number after the sink contract became `void | PromiseLike<void>`; the fixtures now use block-bodied void callbacks.
- Focused GREEN: App telemetry/controller/Host passed 3/3 files and 38/38 tests; the standalone controller, including dispose/offline distinction, passed 26/26. CLI telemetry + handler passed 2/2 files and 67/67 tests.
- Final fresh GREEN: App security matrix passed 10/10 files and 118/118 tests. CLI MCP App/permission matrix passed 6/6 files and 104/104 tests.

### Exact verification

```text
pnpm --filter @wangjs-jacky/paws exec vitest run --project unit src/codex/mcpApps src/codex/__tests__/permissionHandler.test.ts
Test Files  6 passed (6)
Tests       104 passed (104)

pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/sync/apiSocket.test.ts sources/utils/otaRuntimeConfig.test.ts
Test Files  10 passed (10)
Tests       118 passed (118)

pnpm --filter @wangjs-jacky/paws typecheck
exit 0

pnpm --filter happy-app typecheck
exit 0

node packages/happy-app/scripts/build-mcp-app-host-shell.cjs --check
exit 0

git diff --check
exit 0

git diff --exit-code 9a71ebdb -- packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts packages/happy-app/ota-runtime-versions.json packages/happy-app/scripts/ota-runtime-config.js
exit 0
```

### Sensitive-value search and self-review

- Both telemetry suites retain the exact five-name/six-key canary snapshots, unknown runtime event drop, sync throwing-sink containment, async rejection-handler attachment, and hostile thenable containment.
- Production telemetry-module banned-field grep remains empty. Changed logging/capture review found no new console/DOM logging and no URI, URL, identifier, argument, result, `_meta`, HTML, raw error/message/stack, or canary value entering a sink.
- UTF-8 size calculation is observation-only and capped at one byte over the existing bridge maximum. The real Host Shell/RPC path supplies JSON values; the cyclic direct-controller regression proves unexpected serialization failure remains safe and low-cardinality.
- Local termination attribution changes telemetry only. Existing abort controllers, five-second authenticated cancel settlement, 30-second deadline, permission flow, authority checks, result envelopes, and display-safe errors are unchanged.
- Generated Host Shell and OTA runtime contract files remain unchanged. The two untracked Task 14 E2E paths remain untouched and excluded from staging.

## Fix round 2

### Residual addressed

- Replaced the App telemetry-only `JSON.stringify` plus full-buffer UTF-8 measurement with a pure bounded JSON UTF-8 counter. It allocates neither a serialized value nor an encoded byte buffer and stops as soon as the existing bridge-size cap (`256 KiB + 1`) is reached.
- The counter handles JSON punctuation, object omission, array null coercion, finite/non-finite numbers, control-character escaping, and UTF-8 string widths incrementally, including valid surrogate pairs and well-formed JSON escaping of lone surrogates.
- Structural work is explicitly bounded to depth 32 and 262,145 visited nodes at the controller seam. Cycles, BigInt, accessors, `toJSON`, non-plain object prototypes, throwing/revoked proxies, and exhausted structural bounds return `unknown`; no getter or caller serialization hook is invoked.
- Plain-object enumeration uses a capped loop without allocating an explicit key list; arrays read data descriptors one slot at a time. A million-slot lazy proxy test reaches the cap after fewer than 100 descriptor visits, proving telemetry does not traverse or encode the full value.
- Telemetry event names, six-key payload schema, authority, cancellation, deadlines, validation, result envelopes, and error mapping are unchanged.

### RED / GREEN

- Canary RED: the new bounded-counter suite failed collection because `./boundedJsonUtf8ByteLength` did not exist (1 failed suite, 0 tests collected).
- Helper GREEN: the new suite passed 3/3 tests, including exact ordinary JSON byte counts, omission/null/escape/surrogate behavior, circular/BigInt/accessor/proxy/depth/node safe fallbacks, and bounded lazy-array traversal.
- Focused integration GREEN: bounded helper plus App Host Controller passed 2/2 files and 29/29 tests. Existing controller assertions retain non-zero request/result buckets and circular-input `unknown` behavior.
- Final fresh App GREEN: the prescribed security matrix passed 11/11 files and 121/121 tests.

### Exact verification

```text
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/sync/apiSocket.test.ts sources/utils/otaRuntimeConfig.test.ts
Test Files  11 passed (11)
Tests       121 passed (121)

pnpm --filter happy-app typecheck
exit 0

node packages/happy-app/scripts/build-mcp-app-host-shell.cjs --check
exit 0

git diff --check
exit 0

git diff --exit-code ea286331 -- packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts packages/happy-app/ota-runtime-versions.json packages/happy-app/scripts/ota-runtime-config.js
exit 0
```

### Sensitive-value search and self-review

- The existing exact five-name/six-key canary telemetry tests remain green. Production telemetry-module grep remains empty for URI, connector/account/call/origin/server/tool/app identifiers, arguments, structured content, `_meta`, HTML/URL, raw error/message/stack, and canary fields.
- The bounded helper returns only a number or `null`; it never returns, logs, or sends input content. Changed logging/capture grep is empty.
- Full response validation still uses the existing serializer because that is the authority-neutral bridge-size enforcement path, not telemetry. Only the former duplicate telemetry serialization was replaced.
- Generated Host Shell and OTA runtime contract files remain byte-for-byte unchanged. The two untracked Task 14 E2E paths remain untouched and excluded from staging.

## Fix round 3

### Residual addressed

- Removed the telemetry counter's open-ended prototype-chain walk. Each input object now receives exactly one caught `getPrototypeOf` lookup and is accepted only with the exact safe prototype: `Array.prototype` for arrays, and `Object.prototype` or `null` for ordinary objects.
- Arrays with custom prototypes are rejected before slot traversal, so inherited indexed values cannot be mistaken for JSON null holes. Dates, maps, typed arrays, functions, and other non-JSON container prototypes remain `unknown`.
- Own `toJSON` data properties and accessors are rejected through descriptors without invocation. Direct hooks on the two accepted standard prototypes are also rejected, and their standard parent relationship is checked with a fixed number of trusted-prototype operations rather than a caller-controlled walk.
- A cyclic Proxy prototype trap is now bounded to one call and returns `unknown`; throwing prototype and descriptor traps remain contained.

### RED / GREEN

- Regression RED: the expanded helper suite ran 6 tests with 2 intended failures. The cyclic prototype Proxy reached its test guard after 5 trap calls instead of the required one, and a custom-prototype sparse array was incorrectly counted as six bytes instead of `unknown`.
- Focused GREEN: helper plus App Host Controller passed 2/2 files and 32/32 tests. The cyclic Proxy records exactly one prototype lookup; custom/inherited sparse arrays, serialization hooks, and non-JSON containers all resolve safely to `unknown`.
- Final fresh App GREEN: the prescribed security matrix passed 11/11 files and 124/124 tests.

### Exact verification

```text
pnpm --filter happy-app exec vitest run sources/components/tools/mcpApps sources/components/tools/McpAppHost.test.tsx sources/sync/ops.mcpApps.test.ts sources/sync/apiSocket.test.ts sources/utils/otaRuntimeConfig.test.ts
Test Files  11 passed (11)
Tests       124 passed (124)

pnpm --filter happy-app typecheck
exit 0

node packages/happy-app/scripts/build-mcp-app-host-shell.cjs --check
exit 0

git diff --check
exit 0

git diff --exit-code dc06ee85 -- packages/happy-app/sources/components/tools/mcpApps/generated/hostShellBundle.ts packages/happy-app/ota-runtime-versions.json packages/happy-app/scripts/ota-runtime-config.js
exit 0
```

### Sensitive-value search and self-review

- The exact five-event/six-key canary telemetry tests remain green. The counter still returns only a bounded number or `null`, never input content.
- Production telemetry-module banned-field grep and changed logging/capture grep remain empty. The helper contains no `JSON.stringify`, `TextEncoder`, or full-buffer UTF-8 call.
- The prototype policy intentionally favors safe `unknown` telemetry over executing or following caller-controlled serialization behavior. It changes observation only; validated bridge data, authority, cancellation, deadlines, envelopes, and errors are untouched.
- Generated Host Shell and OTA runtime files remain unchanged. The two untracked Task 14 E2E paths remain untouched and excluded from staging.
