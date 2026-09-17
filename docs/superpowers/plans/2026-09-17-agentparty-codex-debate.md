# AgentParty Codex Debate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bounded two-Codex-Agent debate mode with a ten-round cap and real `gpt-5.6-luna` / `low` spawn forwarding.

**Architecture:** The Paws spawn contract gains Codex-only model and effort fields and forwards them unmodified through SDK, socket RPC, and daemon launch. AgentParty persists a room-owned debate state machine and schedules exactly one next turn after each durable completion.

**Tech Stack:** TypeScript, Vitest, Paws Agent SDK, Paws server socket RPC, Happy CLI daemon, React/Vite.

**Spec:** `docs/superpowers/specs/2026-09-17-agentparty-codex-debate-design.md`

## Global Constraints

- Only `agent: 'codex'` is supported in this release.
- Default profile: model `gpt-5.6-luna`, effort `low`.
- A round has exactly two responses; maximum valid rounds are 1–10.
- Never persist recovery credentials or expose hidden reasoning/tool output.
- Stop/restart prevents subsequent scheduling but does not claim remote-process termination.

---

### Task 1: Extend the Paws Codex spawn contract

**Files:**
- Modify: `packages/paws-agent/src/client/types.ts`
- Modify: Paws Agent session resource request serialization and tests
- Modify: Paws server spawn RPC validation/types and tests
- Modify: `packages/happy-cli/src/modules/common/registerCommonHandlers.ts`
- Modify: `packages/happy-cli/src/daemon/run.ts` and daemon spawn tests

**Interfaces:**
- Produces `SpawnSessionInput` fields `model?: string` and `effort?: CodexEffort`.
- Produces daemon launch args `--model <model> --effort <effort>` only for Codex.

- [ ] **Step 1: Write failing SDK, RPC, and daemon tests**

```ts
expect(serializedSpawn).toMatchObject({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low' });
expect(launch.args).toContain('--model');
expect(launch.args).toContain('gpt-5.6-luna');
expect(launch.args).toContain('--effort');
expect(launch.args).toContain('low');
```

- [ ] **Step 2: Run focused tests and verify missing fields fail.**
- [ ] **Step 3: Add typed Codex-only fields, validation, RPC forwarding, and daemon argument forwarding.**
- [ ] **Step 4: Re-run focused tests, typechecks, and commit.**

### Task 2: Make AgentParty profiles Codex-only and reproducible

**Files:**
- Modify: `packages/paws-agent-party/src/group-chat/profiles.ts`
- Modify: `packages/paws-agent-party/src/group-chat/rooms.ts`
- Modify: `packages/paws-agent-party/src/web/GroupChatApp.tsx`
- Test: `packages/paws-agent-party/test/group-chat-service.test.ts`
- Test: `packages/paws-agent-party/test/connection.test.tsx`

**Interfaces:**
- Produces profile/member fields `model: string` and `effort: 'low'|'medium'|'high'|'xhigh'|'max'`.
- Room creation snapshots these fields and remote spawn receives them.

- [ ] **Step 1: Write failing profile/room/UI tests for the luna-low defaults and frozen member snapshot.**
- [ ] **Step 2: Run focused tests and verify the current engine-only profile fails.**
- [ ] **Step 3: Replace selectable engines with Codex profile configuration; validate API input; pass snapshot values into `sdk.spawn`.**
- [ ] **Step 4: Re-run tests/typecheck and commit.**

### Task 3: Add durable bounded debate scheduling

**Files:**
- Modify: `packages/paws-agent-party/src/group-chat/rooms.ts`
- Create: `packages/paws-agent-party/src/group-chat/debate.ts`
- Modify: `packages/paws-agent-party/src/server/http.ts`
- Test: `packages/paws-agent-party/test/group-chat-service.test.ts`

**Interfaces:**
- Produces `DebateSnapshot { status, members:[string,string], maxRounds, completedRounds, nextMemberId, sourceMessageId }`.
- Produces `startDebate()` and `stopDebate()` room operations.

- [ ] **Step 1: Write failing state-machine tests for opening positions, alternation, exactly 20 responses at a 10-round cap, stop, failure, and restart interruption.**
- [ ] **Step 2: Run them and verify no debate scheduler exists.**
- [ ] **Step 3: Implement one-at-a-time persistence-first scheduling, terminal messages, stop endpoint, and restart interruption.**
- [ ] **Step 4: Re-run focused tests/typecheck and commit.**

### Task 4: Expose debate controls and status in the group chat

**Files:**
- Modify: `packages/paws-agent-party/src/web/GroupChatApp.tsx`
- Test: `packages/paws-agent-party/test/group-chat-composer.test.ts`

- [ ] **Step 1: Write failing UI tests for the auto-debate toggle, 1–10 selector, active round indicator, and stop control.**
- [ ] **Step 2: Run test to verify it fails.**
- [ ] **Step 3: Implement accessible controls and status; retain normal routing when debate is off or mention count differs from two.**
- [ ] **Step 4: Re-run UI tests/typecheck and commit.**

### Task 5: Full verification and production delivery

**Files:**
- Modify: `packages/paws-agent-party/README.md`

- [ ] **Step 1: Run all affected Paws Agent, daemon, and AgentParty test suites; run typechecks and production builds.**
- [ ] **Step 2: Independently review diff and fix any findings.**
- [ ] **Step 3: Run a real two-Codex live case: complete a capped debate and stop a second active debate.**
- [ ] **Step 4: Commit, push, open PR to `main`, merge, wait for the official Web deploy workflow, and smoke-test `https://47.115.228.20:8443`.**
