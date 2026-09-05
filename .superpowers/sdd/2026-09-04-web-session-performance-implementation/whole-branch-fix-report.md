# Whole-branch final fix report

Date: 2026-09-05
Fix baseline: `6b0a858e08ac0700af3979ef669eb2329f85d2db`
Review findings: `whole-branch-review-findings.md`

## Outcome

C1, I1–I8, the queue-receipt ruling, and the inexpensive event-first single-flight finding are addressed. No finding is deferred within this implementation wave.

Implementation commits:

- `3b941947c1b943187c1ec4e883219f0afd6a7cff` — session persistence, async writer consistency, route recovery, confirmed local queue, and compose draft survival.
- `6407d314ae2c64ce4973044533b353f1b520cbb5` — request-initiation evidence and worker startup logging.

Fresh final verification: App **250/250** in 38 files; Server **12/12** in 2 files; CLI **81/81** in 5 files; Node probe/evaluator **49/49**. App and Server typechecks and explicit CLI build exited 0. Both implementation commits passed staged diff checks.

This is implementation/test completion, not a browser performance or release claim. No browser, push, PR mutation, merge, deployment, daemon restart, or release was performed.

## Regression evidence and finding mapping

Commands below run from the repository root unless a package directory is specified. GREEN results refer to the final commands in the verification section, not just earlier partial runs. RED tests exercise the failing production boundary; supplemental mocked tests retain their narrower role.

### C1 — edited compose draft disappeared on real route unmount

Symptom/root cause: revision checks protected mounted React state, but dismissal removed the only copy of later text and attachments.

RED: `pnpm --filter happy-app exec vitest run sources/components/ComposeHome.test.tsx`. The new real-navigation-hook dismiss/unmount/remount case restored empty text instead of the later revision.

Fix: a route-independent, memory-only Zustand compose draft owns text revision and attachment references; the image picker accepts controlled selection. The accepted submission is cleared before navigation, and only if its revision/attachment IDs still match. Logout clears the draft. Attachment locations are not persisted to disk.

GREEN: G-APP, ComposeHome **5/5**, including real useNavigateToSession with router-boundary dismissal and actual component unmount/remount. The unsubmitted revision and only the newly added attachment survive. The native-picker boundary remains mocked in this component test; real picker tests also pass.

Commit: `3b941947`.

### I1 — later incremental sessions lost persisted overrides

Symptom/root cause: restoration depended on the entire store being empty; persistence writes rebuilt maps from loaded sessions and discarded unloaded entries.

RED: `pnpm --filter happy-app exec vitest run sources/sync/storage.lifecycle.test.ts -t 'restores persisted|resetting one loaded'`. Replayed with baseline storage.ts and the corrected persistent native-storage boundary: **2 failures**, missing restored draft/modes and erased unloaded permission override. The module-reset test double retains actual persistence across module reloads; this is not an instance-local fake losing its own data.

Fix: restore per session's first insertion, preserve explicit live clears, merge persistence updates without dropping unloaded sessions, and reset only the selected session's overrides. The automatic plan-mode persistence path also preserves unloaded entries.

GREEN: G-APP, storage lifecycle **4/4**, plus session sorting, permission modes, message-mode metadata, and default-selection suites.

Commit: `3b941947`.

### I2 — empty /new and standalone history had no first-page/pagination entry

Symptom/root cause: only successful SessionView hydration scheduled history; an empty list had no end callback, and page pagination was disabled.

RED: `pnpm --filter happy-app exec vitest run sources/components/SessionHistoryList.test.tsx`. Added empty/history-only page and sidebar cases observed no first-history scheduling. The additional ComposeHome bootstrap-readiness test initially observed history scheduling too early.

Fix: history page/sidebar and ComposeHome schedule the first page after their ready, interactive render. Further pages require a fresh explicit scroll gesture; layout-driven repeated end callbacks cannot drain all history. Both page and sidebar variants support this pagination.

GREEN: G-APP, SessionHistoryList **4/4**, ComposeHome **5/5**, bootstrap **18/18**. Coverage includes empty active, history-only data, page/sidebar entry, readiness gating, concurrent page coalescing, failure retry, and no automatic pagination loop.

Commit: `3b941947`.

### I3 — late async writers resurrected deleted sessions/encryption

Symptom/root cause: tombstone filtering/tracking covered full refresh only, while other writers and shared decryption caches could commit after deletion.

RED: R-SYNC below replayed baseline sync.ts with the final real Sync/Zustand/Encryption composition tests. All five snapshot sources failed deletion assertions; the full-refresh failure was leaked encryption even where store deletion survived. Additional RED tests showed deleted-session cache entries reappearing after latest/incremental decryption and an outbox acknowledgement restoring message sequence runtime after deletion.

Fix: active/history/single/event/full snapshot writers register before their first await, retain a shared deletion-generation boundary, prepare encryption privately, then validate and synchronously commit encryption/store. Realtime field/message decryption is detached and guarded after awaits. Message-page loads discard detached decryption after route/delete invalidation. Outbox acknowledgements require the original still-owned queue before updating runtime. Tombstones remain until all older writers settle.

GREEN: G-APP, real writer composition **22/22**, bootstrap **18/18**, new-session **6/6**, visibility **21/21**, encryption staging **5/5**. Tests cover every snapshot source, overlapping HTTP writers and deletes, field decryption, latest/incremental message caches, late acknowledgements, and owner replacement.

Commit: `3b941947`.

### I4 — account sequence and message sequence were compared as one domain

Symptom/root cause: realtime envelope account sequence was assigned to session message sequence, then used to choose HTTP base fields.

RED: R-SYNC's realistic envelope test failed because the account cursor replaced the session message sequence.

Fix: keep an independent account-event cursor; realtime message updates advance only from the message sequence, field updates retain it, and HTTP/base state merges compare updatedAt with same-domain sequence tie-breaking. Metadata and agent-state versions remain independent.

GREEN: G-APP, real writer composition and bootstrap tests cover both update-session and new-message envelopes, a later HTTP snapshot's base fields, and independent metadata/agent versions.

Commit: `3b941947`.

### I5 — valid deep links could stay loading indefinitely

Symptom/root cause: UI swallowed snapshot/latest failures without retry; a detached preparation losing to a valid active/event writer was reported as route abandonment.

RED: R-SYNC's cold route winner case rejected with route abandonment. `pnpm --filter happy-app exec vitest run sources/-session/SessionView.hydration.test.tsx` failed on the missing visible retry state. An additional latest-page regression initially replaced newer loaded pagination anchors with older response anchors.

Fix: reprepare against the winning encryption once and continue a still-current route. SessionView retries with three bounded delays, then exposes an explicit error/retry action. Cleanup cancels that mount's operation/timer. An older latest page cannot regress a newer loaded winner.

GREEN: G-APP, SessionView **4/4**, bootstrap **18/18**, and real cold-route writer tests. No preloaded messages are used for the transient snapshot/latest failure and encryption-winner cases. Real Sync failures can retry successfully without full-list fallback; UI tests prove bounded retries and visible retry state.

Commit: `3b941947`.

### I6 and queue ruling — first queue failure lost created-session recovery

Symptom/root cause: recovery state existed only for hydration failure, and Promise<void> could resolve despite missing session/encryption or skipped attachment uploads.

RED: `pnpm --filter happy-app exec vitest run sources/hooks/useSpawnSession.test.tsx` initially failed the first queue-failure recovery and undefined-receipt navigation cases. R-SYNC confirms baseline sendMessage falsely succeeds for unavailable session/encryption and partial attachment failure.

Fix: register pending operation state immediately when the RPC returns its session ID. Keep configured/queued state until navigation finishes; repeated clicks and retries reuse it. sendMessage now returns a typed LocalMessageQueueReceipt only after the complete local encrypted outbox commit, or throws. Stage all attachment/text encryption first; reject partial uploads, ownership loss and encryption failure. Draft clearing, queued telemetry and navigation follow the confirmed receipt. Post-commit rendering, scheduling, tracing/title helpers cannot turn acceptance into a retry. Preserve queue-array identity so an in-flight flush removes only its original prefix.

Self-review RED: the initial atomic-queue implementation replaced the queue array, allowing the earlier flush to erase a second queued message. The real flush/send overlap test failed, then passed after preserving identity. A separate deletion/acknowledgement RED also now passes.

Caller audit: SessionView waits before clearing submitted content; MessageView option sends and capability quick prompts report failure; capability panels close only after acceptance; voice sends return a stable failure result and do not increment success counts. ChatList's awaited edit callback and ComposeHome's existing custom-analysis try/catch already propagate failure. No compatibility wrapper masks queue failure.

GREEN: G-APP, useSpawnSession **18/18**, ComposeHome **5/5**, real writer composition **22/22**, MessageView **3/3**, picker **9/9**, plus mode/attachment suites. Includes initial duplicate clicks, first queue failure, partial upload, later text-encryption failure, deletion during encryption, post-commit ancillary faults, navigation retry without requeue, and in-flight flush overlap.

Commit: `3b941947`.

### I7 — probe missed requests still in flight at freeze

Symptom/root cause: ResourceTiming appears on completion. Disconnecting the deep-link observer before completion, then filtering by the later spawn start, could omit a request initiated during the deep-link interval.

RED: `node --test --test-name-pattern='real in-flight|installed after' packages/happy-app/scripts/check-session-critical-path.test.mjs` failed both cases: the real delayed HTTP/fetch request was omitted, and late installation did not fail closed. An additional accessor-fault RED showed non-stable error propagation while checking instrumentation.

Fix: document-start fetch/XHR initiation tracking records exact-path legacy starts independently of completion entries, including failed or still-pending requests. Legacy completion entries do not duplicate initiation records. Late/missing installation, capture failure, replaced instrumentation or accessor faults invalidate evidence with RESOURCE_COLLECTION_FAILED. README now requires verified Ego document-start injection; absence of that capability is an explicit failed measurement, not an after-navigation fallback.

GREEN: G-NODE **49/49**, including a real local HTTP server with native fetch and native PerformanceObserver completion after freeze, XHR send initiation, failure semantics, replacement/accessor faults, frozen snapshots, observer faults, and both literal README pnpm commands.

Commit: `6407d314`.

### I8 — real worker utility logged command and working directory

Symptom/root cause: spawnHappyCLI passed complete command/cwd and missing-entrypoint paths to the real file logger, regardless of DEBUG.

RED: `pnpm exec vitest run --project unit src/daemon/run.sessionStartupTrace.test.ts` in packages/happy-cli. The real logger serialization test detected prohibited command/directory content. An earlier missing-entrypoint branch also exposed the path.

Fix: replace command, directory and raw synchronous spawn failures with fixed codes. Logging is best effort and cannot block child creation.

GREEN: G-CLI **81/81** across five files, including run.sessionStartupTrace **15/15**. The canary test invokes the real run.ts startup integration, actual spawn utility and actual logger, mocking only OS spawn and filesystem writes for this boundary; it is not a full daemon launch. It checks successful spawn, missing entrypoint, thrown spawn error and throwing logger. No canary values or captured logs are reproduced here.

Commit: `6407d314`.

### Minor — event-first hydration was not shared with RPC acknowledgement

Symptom/root cause: while new-session decryption awaited, ensureSessionHydrated saw no store row and initiated a redundant GET.

RED: R-SYNC's already-decrypting event/ACK case observed an extra targeted GET.

Fix: event and targeted hydration share a per-session in-flight promise with ownership-safe cleanup. The promise is removed after settlement; this introduces no result cache or TTL.

GREEN: G-APP, real writer composition's event-before-ACK case passes with no duplicate GET. Task 7's independent attachment single-flight/no-TTL behavior remains unchanged and green.

Commit: `3b941947`.

## Exact final verification commands

### R-SYNC — final composition tests against baseline sync.ts

Only sync.ts was temporarily restored to FIX_BASE using apply_patch; test/native-boundary corrections remained. The following produced **10 expected failures**, then the fix was restored and G-APP passed. No branch switch, worktree switch or destructive git reset was used.

```sh
pnpm --filter happy-app exec vitest run sources/sync/sync.sessionWriters.test.ts \
  -t 'pending .* decryption|keeps message seq separate|lets an event already|continues a cold route|queues all attachments|rejects a send'
```

### G-APP — 250 tests, 38 files, exit 0

```sh
pnpm --filter happy-app exec vitest run --maxWorkers=4 \
  sources/sync/apiTypes.spec.ts \
  sources/sync/apiSocket.test.ts \
  sources/sync/apiSessions.test.ts \
  sources/sync/sessionSnapshotHydration.test.ts \
  sources/sync/sync.newSession.test.ts \
  sources/sync/sessionBootstrap.test.ts \
  sources/sync/sessionMessageLoadGate.test.ts \
  sources/sync/sessionMessageRetention.test.ts \
  sources/sync/sync.messageVisibility.test.ts \
  sources/sync/storage.lifecycle.test.ts \
  sources/sync/encryption/encryption.routeStaging.test.ts \
  sources/hooks/useSpawnSession.test.tsx \
  sources/components/ComposeHome.test.tsx \
  sources/components/SessionHistoryList.test.tsx \
  sources/-session/SessionView.hydration.test.tsx \
  sources/sync/apiAttachments.downloadSource.test.ts \
  sources/hooks/useAttachmentImage.test.tsx \
  sources/hooks/useAttachmentImage.web.test.tsx \
  sources/sync/sessionStartupTrace.test.ts \
  sources/sync/sync.sessionWriters.test.ts \
  sources/hooks/useSessionWorkingDirectory.test.tsx \
  sources/hooks/useSessionWorkingDirectory.integration.test.tsx \
  sources/utils/sessionWorkingDirectory.test.ts \
  sources/utils/sessionFork.test.ts \
  sources/sync/ops.codexFork.test.ts \
  sources/components/MessageView.forkActions.test.tsx \
  sources/hooks/useImagePicker.test.ts \
  sources/sync/storage.sessionSorting.test.ts \
  sources/sync/sessionPermissionModes.test.ts \
  sources/sync/messageMeta.test.ts \
  sources/sync/typesMessageMeta.test.ts \
  sources/sync/sessionFallbackTitle.test.ts \
  sources/sync/sessionApply.test.ts \
  sources/sync/ops.sessionDelete.test.ts \
  sources/sync/ops.screenshot.test.ts \
  sources/sync/relationshipAdvisorClient.test.ts \
  sources/sync/relationshipAdvisorImages.test.ts \
  sources/utils/newSessionModeSelection.test.ts
pnpm --filter happy-app run typecheck
```

### G-SERVER — 12 tests, 2 files; typecheck exit 0

```sh
pnpm --filter happy-server-self-host exec vitest run \
  sources/app/api/socket/rpcHandler.spec.ts \
  sources/app/api/routes/sessionRoutes.spec.ts
pnpm --filter happy-server-self-host run typecheck
```

### G-CLI — 81 tests, 5 files; explicit build exit 0

Run in packages/happy-cli:

```sh
pnpm exec vitest run --project unit src/api/apiMachine.test.ts src/api/apiMachine.codexFork.test.ts src/api/apiSession.test.ts src/daemon/run.sessionStartupTrace.test.ts
pnpm exec vitest run --project unit src/api/api.test.ts
pnpm run build
```

The first run passed 65 tests, the second passed 16. The explicit build also completed independently of Vitest's build setup. Only pre-existing bin/empty-chunk build warnings were emitted.

### G-NODE — 49 tests, exit 0

```sh
node --test packages/happy-app/scripts/check-session-critical-path.test.mjs
git diff --check
git diff --check 6b0a858e08ac0700af3979ef669eb2329f85d2db..HEAD
```

## Self-review and remaining acceptance boundary

- Encryption preparation remains detached until guarded synchronous commit. E2EE payloads and validated outer traceId allowlists are unchanged.
- Upgraded cold/new-session paths and their tested error retries do not call the legacy account session list. The existing genuine unrecovered reconnect compensation remains intact; first-connect and recovered-reconnect distinctions remain covered by apiSocket tests.
- Offscreen message behavior, route leases, LRU release, explicit older-page pagination and attachment single-flight cleanup remain green. No TTL or automatic history drain was added.
- Remote directory, advisor and direct screenshot features from main are retained; the relevant existing source paths were preserved, and directory/fork, advisor and screenshot tests passed.
- The changed mocked integration fixtures now implement detached-encryption methods or modal boundaries required by production. They do not replace the new real Sync/Zustand/Encryption composition coverage.
- No sensitive evidence is included in this report. Tests use synthetic fixtures; the report intentionally excludes canary values, raw logs and measured URLs.
- Task 10 still owns authenticated Ego execution, visual cases, actual latency thresholds and zero-legacy-request browser evidence. This wave did not validate Ego's document-start injection capability. If it is unavailable, the new probe intentionally fails closed.
- The root main worktree was inspected but left unchanged; branch/workspace synchronization there is outside this fix assignment.
