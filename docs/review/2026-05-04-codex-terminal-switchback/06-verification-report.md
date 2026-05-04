# Verification Report

Scope: correctness-only verifier pass over CRITICAL/WARNING findings from `01-architect-review.md` through `05-product-owner-review.md`.

Base checked with `git diff origin/main -- <file>`.

## Summary

- Critical findings kept: 0
- Warning findings kept: 5
- Pre-existing findings kept: 0
- Duplicates: 1 duplicate pair merged
- Retracted findings: 1

## Verified Warnings

### 🔴 PR-INTRODUCED WARNING: Fresh local Codex exits are masked by thread discovery

Sources:
- `02-developer-review.md`: "Fresh local Codex exits are masked by thread discovery"
- `04-performance-review.md`: "Native launcher keeps polling discovery after Codex exits early"

Evidence:
- `packages/happy-cli/src/codex/codexLocalLauncher.ts` is a new file relative to `origin/main`.
- For fresh launches without `opts.codexThreadId`, `discoveryPromise` is `waitForDiscoveredThreadId(...)` polling for up to 10 seconds at lines 133-150.
- `exitPromise` resolves with the child exit code at lines 156-164.
- After `Promise.race([discoveryPromise, exitPromise])`, a fulfilled early child exit falls through to `Promise.all([discoveryPromise, exitPromise])` at line 173.
- If no session metadata appears, `discoveryPromise` rejects and line 177 throws the discovery error instead of returning `{ type: 'exit', code }`.

Behavior traced:
When native `codex` exits before writing session metadata, the launcher still waits for discovery. The eventual `Could not discover Codex thread id...` error masks the native process exit status. This also keeps discovery polling after the child is gone.

Verdict: kept. This is a user-visible correctness regression in the new local default path.

### 🔴 PR-INTRODUCED WARNING: Native local Codex bypasses configured Happy sandbox

Source:
- `03-security-review.md`: "Native local Codex bypasses configured Happy sandbox"

Evidence:
- `runCodex` still reads `sandboxConfig` from settings at `packages/happy-cli/src/codex/runCodex.ts:111` and writes it to session metadata at line 130.
- The remote app-server path passes `sandboxConfig` into `new CodexAppServerClient(sandboxConfig)` at line 564.
- `CodexAppServerClient.connect()` initializes the Happy sandbox and wraps the Codex app-server command when sandboxing is enabled at `packages/happy-cli/src/codex/codexAppServerClient.ts:398-405`.
- The new local path calls `launchNativeCodex(...)` at `packages/happy-cli/src/codex/runCodex.ts:293-316` without passing `sandboxConfig`.
- `launchNativeCodex` directly spawns `codex` with inherited stdio/env at `packages/happy-cli/src/codex/codexLocalLauncher.ts:107-114`; the launcher has no Happy sandbox config input or wrapper.
- Terminal Codex now defaults to local mode in `packages/happy-cli/src/codex/modeLoop.ts:8-17`.

Behavior traced:
A user with Happy sandboxing enabled starts `happy codex` from the terminal. The session metadata can advertise the configured sandbox, but the default local path launches native Codex outside Happy's sandbox wrapper. Native Codex permission flags are not equivalent to Happy's configured filesystem/network sandbox and are absent for default mode.

Verdict: kept. This is a PR-introduced sandbox boundary regression.

### 🔴 PR-INTRODUCED WARNING: Local Codex default can fail on Windows npm installs

Source:
- `05-product-owner-review.md`: "Local Codex default can fail on Windows npm installs"

Evidence:
- The new local launcher imports `spawn` from `node:child_process` and calls `spawn('codex', ...)` at `packages/happy-cli/src/codex/codexLocalLauncher.ts:1` and line 110.
- The existing app-server launcher imports `cross-spawn` and explicitly documents that it is needed for `codex.cmd` / `codex.ps1` Windows npm shims at `packages/happy-cli/src/codex/codexAppServerClient.ts:16-17` and lines 431-433.
- Terminal-started Codex now defaults to local mode in `packages/happy-cli/src/codex/modeLoop.ts:16`.
- `codexLocalLauncher.ts` is new relative to `origin/main`.

Behavior traced:
On Windows installations where `codex` resolves through npm shim files, the previous app-server path used `cross-spawn`; the new default local path uses native Node spawn and can hit the exact `ENOENT` class the existing comment says `cross-spawn` avoids.

Verdict: kept. This is a platform correctness regression in the new default terminal path.

### 🔴 PR-INTRODUCED WARNING: Discovery failures are not surfaced as actionable Happy session errors

Source:
- `05-product-owner-review.md`: "Discovery failures are not surfaced as actionable Happy session errors"

Evidence:
- `launchNativeCodex` throws discovery failures at `packages/happy-cli/src/codex/codexLocalLauncher.ts:167-177`, including the ambiguous-discovery fast path from lines 38-42.
- `runCodex` awaits `launchLocalCodexSession(...)` without a catch in the initial local-mode path at `packages/happy-cli/src/codex/runCodex.ts:513-518`.
- `launchLocalCodexSession` uses a `finally` block at lines 340-355 that only sends session death, flushes, closes, and clears keepalive when not switching back to remote.
- There is no session message/event emitted with the discovery error before close.
- The PRD requires ambiguous discovery to fail visibly in `docs/plans/codex-local-remote-handoff-prd.md:45` and `docs/plans/codex-local-remote-handoff-prd.md:133`.

Behavior traced:
If fresh local discovery rejects while a mobile/web message is queued for handoff, the local launch rejects, the Happy session is closed with only a death event, and the queued mobile turn has no actionable in-app error explaining the failed discovery.

Verdict: kept. This is PR-introduced and affects the required handoff/error behavior.

### 🔴 PR-INTRODUCED WARNING: Enriched command results may change compact mobile rendering

Source:
- `05-product-owner-review.md`: "Enriched command results may change compact mobile rendering"

Evidence:
- `typesRaw.ts` changed session `tool-call-end` normalization from `content: null` to `content: result?.content ?? null` at `packages/happy-app/sources/sync/typesRaw.ts:652-665`.
- The reducer copies normalized `tool-result.content` into `message.tool.result` at `packages/happy-app/sources/sync/reducer/reducer.ts:833-836`; the sidechain paths do the same at lines 991-993 and 1027-1030.
- Compact tool rendering shows output whenever `tool.state === 'completed' && tool.result` at `packages/happy-app/sources/components/tools/ToolView.tsx:257-262`.
- The PRD requires command output to be preserved but compact mobile rendering to remain unchanged for now at `docs/plans/codex-local-remote-handoff-prd.md:60-67` and notes the raw `result` payload should support later richer rendering at lines 72-80.
- The `typesRaw.ts` change is PR-introduced relative to `origin/main`.

Behavior traced:
Session-protocol command results with `result.content` now become normalized `tool-result.content`, then become `message.tool.result`, then render in the compact tool view. That changes current compact mobile rendering instead of preserving output only on the additive raw `result` field.

Verdict: kept. This is a user-visible contract regression against the PRD, not a style issue.

## Retracted Findings

### Retracted: Fresh local launch repeatedly scans the full Codex session day directory

Source:
- `04-performance-review.md`: "Fresh local launch repeatedly scans the full Codex session day directory"

Evidence:
- The behavior is real: `discoverCodexThreadId` recursively lists `.jsonl` files from launch-date session directories at `packages/happy-cli/src/codex/codexThreadDiscovery.ts:101-114`, and `waitForDiscoveredThreadId` can call it every 250ms for up to 10 seconds at `packages/happy-cli/src/codex/codexLocalLauncher.ts:30-45` and lines 141-142.

Reason retracted:
This is a performance/resource-use concern, not a correctness finding on its own. The correctness-relevant early-exit polling aspect is already kept under "Fresh local Codex exits are masked by thread discovery."

## Duplicate Mapping

- Developer "Fresh local Codex exits are masked by thread discovery" and Performance "Native launcher keeps polling discovery after Codex exits early" describe the same root cause in `launchNativeCodex`: an early child exit still waits for discovery and can throw discovery failure. They are merged into one verified warning.
