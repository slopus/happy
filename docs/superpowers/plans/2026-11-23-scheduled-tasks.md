# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Create, manage and actually execute encrypted Paws schedules independently of Bots.

**Architecture:** Account-owned plans and separate run records persist in reserved database KV keys. Deadline timers create durable runs and socket events wake the owning machine; ordinary encrypted sessions execute prompts and report the matching root turn.

**Tech Stack:** TypeScript, Zod, Prisma/PGlite, Fastify, Socket.IO, existing Paws CLI/session encryption, React Native/Expo/Unistyles.

**Spec:** ../specs/2026-11-23-scheduled-tasks-design.md

## Global Constraints

- Work only in `happy--scheduled-tasks`; no database migrations or new infrastructure.
- Reserved prefix `paws:scheduled:v1:`; generic KV mutation must reject it.
- No business-state polling; use deadlines, startup/reconnect recovery and socket events.
- Never store private task configuration in plaintext on the server.
- Waiting for input and uncertain execution block overlaps; no automatic replay of uncertain work.
- Web/Android share UI; no native dependency/runtime changes, no Tauri work.
- Normal PR/CI release rules apply; actual timer → AI reply is required evidence.

## Review Focus

1. Two requests racing must not create duplicate runs or accept stale edits.
2. DST and long deadlines must neither trigger twice nor spin a zero-delay timer.
3. Crashes between spawn, binding and prompt delivery must fail closed.
4. A different/subagent/old turn cannot complete the current scheduled run.
5. Pause/delete/retention cannot erase an executing run or stop unrelated work.

### Task 1: Shared schedule contracts and time calculation

**Files:** `packages/happy-wire/src/scheduledTasks.ts`, `scheduledTasks.test.ts`, `src/index.ts`.
**Produces:** `ScheduleRuleSchema`, `ScheduledTaskConfigSchema`, `ScheduledTaskSchema`, `ScheduledRunSchema`, `nextScheduledAt(rule, after): number | null`, reserved-prefix and terminal-state helpers.

- [x] Write tests for absolute once/interval times, daily/weekly timezones, both DST transitions and invalid inputs.
- [x] Run `pnpm --filter @slopus/happy-wire exec vitest run src/scheduledTasks.test.ts`; observe missing behavior, then implement using Intl calendar conversion and a bounded calendar-day search.
- [x] Run wire build/tests; commit the tested contract.

### Task 2: Durable server registry and event/deadline scheduler

**Files:** `packages/happy-server/sources/app/scheduledTasks/{store,scheduler}.ts`, colocated `.spec.ts`, `app/api/routes/scheduledTaskRoutes.ts`, `app/api/api.ts`, `app/api/socket.ts`, `app/events/eventRouter.ts`, `app/kv/kvMutate.ts`, `main.ts`, `index.ts`.
**Consumes:** Task 1 contracts.
**Produces:** CRUD/list/run-now/history/claim/report APIs, `startScheduledTaskScheduler()`, `wakeScheduledTasksForMachine(accountId,machineId)`.

- [x] Write database-backed tests for due materialization, racing edits/claims/run-now, machine/account isolation, pause and bounded terminal retention.
- [x] Observe failures, implement serializable KV transactions with version guards, run/request IDs, snapshots and encrypted payloads.
- [x] Add exact-deadline timers and one-shot startup recovery; notify machine/client sockets only after commit.
- [x] Test that uncertainty keeps overlap blocked, old reports cannot affect new runs, generic KV cannot mutate reserved keys, and restart materializes only one missed run.
- [x] Run server targeted tests and build; commit.

### Task 3: Daemon delivery, durable journal and exact lifecycle receipts

**Files:** `packages/happy-cli/src/daemon/scheduledTasks/{journal,runner}.ts`, colocated `.test.ts`, `daemon/run.ts`, `api/apiMachine.ts`, `api/scheduledRun.ts`, `api/apiSession.ts`, `api/types.ts`.
**Consumes:** claim/report APIs and encrypted config snapshots.
**Produces:** `createScheduledTaskRunner(deps)`, durable protected task/session bindings, stable `scheduled:<runId>` prompt delivery, exact root-turn receipts.

- [x] Write journal/runner tests using temporary directories and real contract data; a restart after a possible send cannot respawn/resend.
- [x] Observe failures; implement claiming on socket events/connect, validation, existing spawn/resume/grants, long-lived encrypted session bindings and atomic journal writes.
- [x] Write lifecycle tests: matching localId starts run; only same root turn ends it; unrelated/subagent/replayed events cannot complete it; disconnected receipts survive restart.
- [x] Observe failures; integrate tracker into common session protocol handling and reconnect flush without polling.
- [x] Run CLI tests/typecheck/build and relevant resume/independent-session regressions; commit.

### Task 4: Management UI and translations

**Files:** `packages/happy-app/sources/sync/scheduledTasks.ts`, `sync/sync.ts`, `components/scheduledTasks/*`, `app/(app)/scheduled-tasks.tsx`, `app/(app)/_layout.tsx`, `components/SidebarView.tsx`, `components/SidebarNavigator.tsx`, all `text/translations/*`.
**Consumes:** encrypted task/run API and machine encryption, real machine/model catalog.
**Produces:** navigation, responsive list/detail, create/edit draft, schedule/advanced controls and history links.

- [x] Add meaningful tests for draft validation, machine/config changes, stale-save conflicts and reset/session binding semantics; run RED first.
- [x] Implement using current theme, Item/Dialog/Modal patterns and width constraints; preserve drafts on failure/dismiss.
- [x] Delegate new translations to i18n-translator as required by App CLAUDE.
- [x] Wire event invalidation and one-shot reconnect refresh into sync, without timed fetching.
- [x] Run App targeted tests and typecheck; consolidate the feature commit.
- [ ] Web export and native-device acceptance remain outside this requested local timer test; no APK/OTA was published.

### Task 5: Review, actual trigger acceptance and delivery

**Files:** `docs/validation/scheduled-tasks.md`, final fixes in affected files.

- [x] Fresh independent whole-branch review against ST-01…ST-10; fix material findings with regression tests.
- [x] Use the existing authorized environment/runtime procedures; preserve existing workers and normal CI release boundaries. Current user requests testing before claiming completion; never substitute an unrequested cloud preview.
- [x] Create a uniquely labelled short future once-task. Leave the management page, observe one matching session and real AI reply, then verify completed history. Test pause and repeated run-now plus same/new conversation behavior.
- [x] Ego-only creation, pause, edit, leave-page, completed history and result navigation; verified key frames and key-state replay delivered. Independent PC screenshot review passed.
- [ ] Non-default theme, small-screen and native-phone interaction acceptance are not yet run.
- [x] Stop only test-created runtime processes and close the Ego task space; retain private test records/evidence locally and document release boundaries separately.

## Execution ledger

- 2026-11-23: User explicitly requested actual implementation and timer acceptance after receiving design. Continue in this session; previous optional PR comparison screenshot question remains unanswered and is not a blocker.
- Ruling: Reuse reserved UserKVStore records for v1 — satisfies existing human-only migration rule without new schema — startup loading scales with stored schedules; deployment scope is one service instance.

- 2026-11-23 implementation and local acceptance: wire 239, Server 709 passed/15 skipped; App baseline 5413 plus affected targets/typecheck passed. CLI full review run had 2065 pass/one fixture failure; corrected fixture and all affected follow-ups passed. Independent final code review passed.
- Actual timer: UI-created 23:35 plan completed with one exact reply after leaving App; final restarted server 23:39:48.979 plan completed at 23:40:07.168. Fixed-chat recovery, new-chat mode and before/after request-ID retries passed. See docs/validation/scheduled-tasks.md.
- Real acceptance additionally fixed macOS directory aliases and stale relay presence after worker exit; PID probes do not stop any process and unknown states fail closed.
- Delivery scope is the requested test-first phase. Production Web/Server/CLI/OTA are unchanged; no optional PR comparison screenshots or mobile results are implied.
