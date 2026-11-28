# Conversation runtime preparation

> Agent execution: implement the authorized acceptance repair with tests first.

**Goal:** AGY/Codex shared-chat switches must confirm the target runtime and selected configuration before sending the first business request.

**Architecture:** A separate conversation-prepare RPC binds the candidate worker, source/root/request and immutable context. Provider code shares its native-ready/configuration logic with delegation while preserving separate ownership checks. App failures retain the candidate and draft for retry or safe cancellation.

**Spec:** `/Volumes/ZHITAI TiPlus7100s/Development/jacky-github/t3code-context-handoff-research/paws-shared-conversation-acceptance-20261128.md`, SW-02/PERM-02.

## Constraints

- Work only in this sibling worktree. No browser, real-model calls, publication or global process restarts.
- No polling, delegated-owner impersonation, AGY native restore, or unproven history coverage.
- AGY/Codex old workers without the preparation RPC fail explicitly. Claude/OpenCode retain their existing contract.
- Unknown delivery is not permission to replay a business request.

## Tasks

- [x] Reproduce in hook tests: webhook returned, native preparation pending/rejected; no send, commit or draft cleanup.
- [x] Add strict request/result schemas and a worker/context binding helper; test stale binding, startup failure and configuration acknowledgement.
- [x] Share AGY and Codex native-ready/configuration preparation with separate conversation ownership.
- [x] Call preparation once before first send; retry the same candidate without spawning another worker.
- [x] Run focused App/CLI tests and package typechecks; report unsupported/unverified runtime paths and activation requirements.

## Implementation result

The first business send now waits for a separate `conversation-prepare` receipt. The request and receipt bind the worker PID, source/root/request and immutable archive ID/hash. AGY waits for native startup/catalog, selected model/effort and metadata acknowledgement; its permission policy remains enforced by Paws. Codex additionally obtains a native thread response confirming model, effort, approval policy and sandbox before metadata acknowledgement. A fresh, unmodified empty thread has no rollout to resume, so only the existing client safety flag permits replacing that empty thread with `thread/start`; restored/history-bearing threads use native `thread/settings/update` before `thread/resume` reads back the actual configuration. Native 0.166 ignores resume overrides for an already loaded thread, so repeating resume alone is insufficient. Neither route submits a turn or falls back to a fresh thread after a failed restore.

App preparation uses staged permissions or the target's defaults, reads the acknowledged target metadata once, and preserves `messageMeta`'s native-ACK priority. Its returned guard remains active through source verification and the atomic outbox commit. Account changes, changed worker/configuration/context, cancelled reservation, or incompatible ownership invalidate the send. An unqueued failure retains the candidate and draft for same-candidate retry or existing safe cancellation; an unknown/queued business outcome is never replayed.

The CLI preparation has one 70-second deadline, and transport has a 75-second overall deadline. Expiration invalidates late configuration callbacks. These are bounded waits with events/metadata acknowledgements, with no status-query loop.

## Verification

- App: 10 files, **193 tests passed**. Files: `useSpawnSession.conversation`, `useSpawnSession`, `ops.conversationPreparation`, `conversationSwitch`, `sessionContextHandoff.scope`, `portableContext`, `messageMeta`, `useSessionAgentComposer.web`, `useSessionTaskPermission`, `ops.permissionMode`. Existing React test-renderer deprecation/act warnings remain.
- CLI: 6 files, **271 tests passed**: `codexAppServerClient` (106), `codexConversationPreparation` (3), `codexDelegationRpc` (28), `runCodex.startupTrace` (12), `runAcp` (112), `conversationPreparation` (10). The native protocol tests use local mock processes, not real model requests.
- Both package `typecheck` commands, happy-wire `build`, and `git diff --check` passed. CLI global setup also completed its package build, with existing bundle warnings.
- CLI tests initially inherited this host's managed-account environment and 43 legacy tests timed out waiting for unimplemented mock authentication responses. The complete batch passed after isolating only that command's environment; no machine/account configuration was changed:

```sh
env -u HAPPY_CODEX_ACCOUNT_PROFILE_ID -u HAPPY_CODEX_ACCOUNT_CREDENTIAL_VERSION -u CODEX_HOME \
  pnpm --filter @wangjs-jacky/paws exec vitest run --project unit \
  src/codex/codexAppServerClient.test.ts src/codex/codexConversationPreparation.test.ts \
  src/codex/codexDelegationRpc.test.ts src/codex/runCodex.startupTrace.test.ts \
  src/agent/acp/runAcp.test.ts src/continuation/conversationPreparation.test.ts
```

New hook regressions first reproduced delivery after a prepared worker changed during source verification or before atomic enqueue; both reject without commit/draft cleanup after the guard fix. Timeout, target-default permission and account-change regressions also exercised the missing boundaries before their fixes.

## Remaining acceptance boundary

No browser, daemon activation, account mutation, real native model request, publication, OTA/APK or Android device acceptance was performed in this implementation task. AGY uses fresh native state plus portable history; native AGY resume remains unsupported. Claude/OpenCode retain their existing paths. New App and CLI code must both be activated for AGY/Codex shared-chat preparation; older workers fail explicitly when the RPC is unavailable. Real installed Codex response compatibility and the complete first-business-turn path remain for the separate acceptance task.

## Native compatibility correction (2026-11-29)

Real Codex 0.166 QA probes reproduced stale settings on a repeated resume. The client now updates a historical thread through native thread/settings/update, then reads the same thread back with resume and retains all strict ACK checks. The settings API empty response is not considered readiness. The path is guarded against concurrent preparation, changed ownership/process/thread and active turns; unsupported native versions fail explicitly. The fresh empty path remains start-only. A failing regression preceded the fix, and all 115 client tests passed. The prior merged-source batch (App249 plus runtime7, CLI324) and final candidate/native activation evidence remain separate.
