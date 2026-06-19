# Claude Goal Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Claude current-goal tracking plus clear/edit UI parity while keeping Claude as the owner of goal state.

**Architecture:** Treat Claude `goal_status` transcript attachments as a side-channel, not as chat messages. Map those attachments into `AgentState.agentGoalStatus`; route clear/edit through Claude-native `/goal` slash commands; update the UI only after a structured Claude confirmation arrives.

**Tech Stack:** TypeScript, Vitest, Claude JSONL scanner, Happy session RPC, existing `AgentGoalStatus` schema, existing `AgentGoalBar`.

---

## Scope Check

This is one implementation slice: Claude goal parity. It touches the Claude CLI adapter, scanner plumbing, message queue isolation, and existing app goal-action wiring. It does not require new UI components because `AgentGoalBar`, `SessionView`, and `sessionGoalAction` already exist.

## File Structure

- Create `packages/happy-cli/src/claude/claudeGoalStatus.ts`
  - Validate Claude `goal_status` raw transcript attachments.
  - Map valid observations into `AgentGoalStatus`.
  - Reduce transcript observations to the latest state.
  - Parse Claude goal-action RPC params.
  - Compute fixture-backed capabilities.
- Create `packages/happy-cli/src/claude/claudeGoalStatus.test.ts`
  - Unit tests for mapping, reduction, action parsing, privacy, and capabilities.
- Create fixture files under `packages/happy-cli/src/claude/__fixtures__/goal-status/`
  - Raw JSONL snippets used by tests and to document observed Claude behavior.
- Modify `packages/happy-cli/src/claude/utils/sessionScanner.ts`
  - Keep `RawJSONLinesSchema` conversation-only.
  - Add an `onTranscriptEvent` side channel for recognized non-chat events.
  - Dedupe transcript events by `uuid` without passing them to `sendClaudeSessionMessage`.
- Modify `packages/happy-cli/src/claude/utils/sessionScanner.test.ts`
  - Prove `goal_status` events are surfaced through the side channel and not forwarded as chat messages.
- Modify `packages/happy-cli/src/utils/MessageQueue2.ts`
  - Add a non-destructive isolated enqueue method for slash commands.
- Modify `packages/happy-cli/src/utils/MessageQueue2.test.ts`
  - Prove isolated commands do not batch and do not clear pending prompts.
- Modify `packages/happy-cli/src/claude/runClaude.ts`
  - Track current Claude goal state and support gates.
  - Consume scanner side-channel events.
  - Register Claude `goal-action` RPC.
  - Queue `/goal clear` and `/goal <objective>` as isolated commands.
- Modify `packages/happy-cli/src/claude/runClaude.test.ts`
  - Prove goal updates and actions use authoritative side-channel state.
- App files are expected to remain unchanged unless tests reveal a small error copy gap:
  - `packages/happy-app/sources/-session/SessionView.tsx`
  - `packages/happy-app/sources/components/AgentGoalBar.tsx`
  - `packages/happy-app/sources/components/AgentGoalBar.spec.ts`

---

### Task 0: Fixture Gate

**Files:**
- Create: `packages/happy-cli/src/claude/__fixtures__/goal-status/active.jsonl`
- Create: `packages/happy-cli/src/claude/__fixtures__/goal-status/completed.jsonl`
- Create: `packages/happy-cli/src/claude/__fixtures__/goal-status/edit-active.jsonl`
- Create: `packages/happy-cli/src/claude/__fixtures__/goal-status/cleared.jsonl`
- Create: `packages/happy-cli/src/claude/__fixtures__/goal-status/README.md`

- [ ] **Step 1: Search existing local transcripts for reusable real fixtures**

Run:

```bash
rg -n '"type":"goal_status"|"/goal clear"|"<command-args>clear"|"/goal ' ~/.claude/projects -g '*.jsonl'
```

Expected:

- At least active and completed fixtures are expected to be findable from existing local transcripts.
- If `edit-active` or `cleared` fixtures are missing, do not invent them. Continue to Step 2.

- [ ] **Step 2: Capture missing action fixtures only with explicit approval**

If `edit-active.jsonl` or `cleared.jsonl` cannot be sourced from existing transcripts, stop and ask the user before running live Claude fixture capture because it can spend Claude tokens. Use this exact approval question:

```text
Нужно сделать live Claude fixture capture для /goal edit и /goal clear. Это может потратить Claude токены. Продолжаем?
```

After approval, capture in a disposable directory:

```bash
mkdir -p /tmp/happy-claude-goal-fixtures
cd /tmp/happy-claude-goal-fixtures
claude
```

Inside the interactive Claude session, run these commands:

```text
/goal keep this goal active until I explicitly clear it
/goal replace this goal with edited fixture objective
/goal clear
```

Then locate the new transcript:

```bash
ls -t ~/.claude/projects/-tmp-happy-claude-goal-fixtures/*.jsonl | head -1
```

Expected:

- The transcript contains one active `goal_status` attachment for the first goal.
- The transcript contains one replacement active `goal_status` attachment with condition `replace this goal with edited fixture objective`.
- The transcript contains a structured clear-related `goal_status` attachment.

If clear does not emit a structured confirmation, stop before Task 1 and report that full clear/edit parity is not implementable from authoritative Claude evidence. Revise this plan and the spec for partial capability before continuing.

- [ ] **Step 3: Copy raw fixture lines without hand-editing payloads**

Create the fixture directory:

```bash
mkdir -p packages/happy-cli/src/claude/__fixtures__/goal-status
```

Copy one raw JSONL line per fixture file. Use exact raw transcript lines, not manually reconstructed JSON. The fixture files must each contain a single JSON object followed by a newline.

Expected file roles:

```text
active.jsonl       # met:false, sentinel:true, condition set
completed.jsonl    # met:true, completed evaluation payload
edit-active.jsonl  # met:false for replacement objective
cleared.jsonl      # structured clear confirmation
```

- [ ] **Step 4: Write fixture provenance notes**

Create `packages/happy-cli/src/claude/__fixtures__/goal-status/README.md`:

```markdown
# Claude Goal Status Fixtures

These fixtures are raw Claude Code JSONL transcript lines used to validate Happy's Claude goal adapter.

- `active.jsonl`: active goal sentinel emitted after `/goal <condition>`.
- `completed.jsonl`: completed goal evaluation emitted after Claude satisfies a goal.
- `edit-active.jsonl`: active goal sentinel emitted after replacing an existing goal with `/goal <new condition>`.
- `cleared.jsonl`: clear confirmation emitted after `/goal clear`.

Do not hand-edit fixture payloads. If Claude changes this transcript shape, add a new fixture with provenance instead of rewriting old evidence.
```

- [ ] **Step 5: Validate all fixture files contain valid JSON**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = 'packages/happy-cli/src/claude/__fixtures__/goal-status';
for (const name of ['active.jsonl', 'completed.jsonl', 'edit-active.jsonl', 'cleared.jsonl']) {
  const raw = fs.readFileSync(path.join(dir, name), 'utf8');
  if (!raw.endsWith('\n')) throw new Error(`${name} must end with a newline`);
  const lines = raw.trimEnd().split('\n');
  if (lines.length !== 1) throw new Error(`${name} must contain exactly one JSONL row`);
  JSON.parse(lines[0]);
  console.log(`${name}: ok`);
}
NODE
```

Expected:

```text
active.jsonl: ok
completed.jsonl: ok
edit-active.jsonl: ok
cleared.jsonl: ok
```

- [ ] **Step 6: Commit fixture evidence**

```bash
git add packages/happy-cli/src/claude/__fixtures__/goal-status
git commit -m "test(claude): add goal status fixtures"
```

---

### Task 1: Claude Goal Mapper

**Files:**
- Create: `packages/happy-cli/src/claude/claudeGoalStatus.ts`
- Create: `packages/happy-cli/src/claude/claudeGoalStatus.test.ts`

- [ ] **Step 1: Write failing mapper tests**

Create `packages/happy-cli/src/claude/claudeGoalStatus.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    claudeGoalActionCapabilities,
    mapClaudeGoalStatusEventToAgentGoalStatus,
    parseClaudeGoalActionParams,
    parseClaudeGoalStatusTranscriptEvent,
    reduceClaudeGoalStatusEvents,
} from './claudeGoalStatus';

function fixture(name: string): unknown {
    const raw = readFileSync(join(__dirname, '__fixtures__', 'goal-status', name), 'utf8').trim();
    return JSON.parse(raw);
}

describe('parseClaudeGoalStatusTranscriptEvent', () => {
    it('accepts raw Claude goal_status transcript attachments', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));

        expect(event).toMatchObject({
            type: 'goal_status',
            uuid: expect.any(String),
            sourceSessionId: expect.any(String),
            attachment: {
                type: 'goal_status',
                met: false,
                condition: expect.any(String),
            },
        });
    });

    it('rejects ordinary transcript attachments', () => {
        expect(parseClaudeGoalStatusTranscriptEvent({
            type: 'attachment',
            uuid: 'att-1',
            sessionId: 'claude-1',
            attachment: { type: 'skill_listing', content: 'skills' },
        })).toBeNull();
    });
});

describe('mapClaudeGoalStatusEventToAgentGoalStatus', () => {
    it('maps active goal_status attachments to active agent goal state', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-19T10:00:00.000Z'));

        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        const status = mapClaudeGoalStatusEventToAgentGoalStatus(event, event.sourceSessionId, {
            capabilities: { clear: true, edit: true },
        });

        expect(status).toEqual({
            source: 'claude',
            observedAt: Date.now(),
            sourceSessionId: event.sourceSessionId,
            sourceRevision: event.uuid,
            status: 'active',
            text: event.attachment.condition,
            capabilities: { clear: true, edit: true },
        });

        vi.useRealTimers();
    });

    it('maps completed goal_status attachments to inactive completed state without storing evaluator details', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('completed.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        const status = mapClaudeGoalStatusEventToAgentGoalStatus(event, event.sourceSessionId);

        expect(status).toMatchObject({
            source: 'claude',
            sourceSessionId: event.sourceSessionId,
            sourceRevision: event.uuid,
            status: 'inactive',
            reason: 'completed',
        });
        expect(JSON.stringify(status)).not.toContain('reason text');
        expect(JSON.stringify(status)).not.toContain('durationMs');
        expect(JSON.stringify(status)).not.toContain('tokens');
    });

    it('ignores goal_status events for another Claude session', () => {
        const event = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        if (!event) throw new Error('expected fixture to parse');

        expect(mapClaudeGoalStatusEventToAgentGoalStatus(event, 'different-session')).toBeNull();
    });
});

describe('reduceClaudeGoalStatusEvents', () => {
    it('uses the latest state in transcript order', () => {
        const active = parseClaudeGoalStatusTranscriptEvent(fixture('active.jsonl'));
        const completed = parseClaudeGoalStatusTranscriptEvent(fixture('completed.jsonl'));
        if (!active || !completed) throw new Error('expected fixtures to parse');

        const latest = reduceClaudeGoalStatusEvents([active, completed], completed.sourceSessionId);

        expect(latest).toMatchObject({
            status: 'inactive',
            reason: 'completed',
            sourceSessionId: completed.sourceSessionId,
        });
    });
});

describe('claudeGoalActionCapabilities', () => {
    it('returns partial capabilities only for confirmed action paths', () => {
        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: true,
            confirmedActions: { clear: true, edit: false },
        })).toEqual({ clear: true });

        expect(claudeGoalActionCapabilities({
            goalCommandSupported: true,
            observedGoalStatus: true,
            confirmedActions: { clear: false, edit: true },
        })).toEqual({ edit: true });

        expect(claudeGoalActionCapabilities({
            goalCommandSupported: false,
            observedGoalStatus: true,
            confirmedActions: { clear: true, edit: true },
        })).toBeUndefined();
    });
});

describe('parseClaudeGoalActionParams', () => {
    it('parses clear and edit RPC params', () => {
        expect(parseClaudeGoalActionParams({ action: 'clear' })).toEqual({ type: 'clear' });
        expect(parseClaudeGoalActionParams({ action: 'edit', objective: '  updated goal  ' })).toEqual({
            type: 'set',
            objective: 'updated goal',
        });
    });

    it('rejects unsupported, stop, and empty edit requests', () => {
        expect(parseClaudeGoalActionParams({ action: 'stop' })).toBeNull();
        expect(parseClaudeGoalActionParams({ action: 'edit', objective: '   ' })).toBeNull();
        expect(parseClaudeGoalActionParams({ action: 'edit' })).toBeNull();
    });
});
```

- [ ] **Step 2: Run mapper tests and verify they fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/claudeGoalStatus.test.ts
```

Expected:

```text
FAIL src/claude/claudeGoalStatus.test.ts
Error: Failed to load url ./claudeGoalStatus
```

- [ ] **Step 3: Implement the mapper**

Create `packages/happy-cli/src/claude/claudeGoalStatus.ts`:

```ts
import type { AgentGoalStatus } from '@/api/types';

type AgentGoalCapabilities = NonNullable<Extract<AgentGoalStatus, { status: 'active' }>['capabilities']>;

export type ClaudeGoalStatusAttachment = {
    type: 'goal_status';
    met: boolean;
    condition?: string;
    sentinel?: boolean;
    reason?: string;
    iterations?: number;
    durationMs?: number;
    tokens?: number;
};

export type ClaudeGoalStatusTranscriptEvent = {
    type: 'goal_status';
    uuid: string;
    timestamp?: string;
    sourceSessionId: string;
    sourceRevision: string;
    claudeVersion?: string;
    attachment: ClaudeGoalStatusAttachment;
};

export type ClaudeGoalCommand =
    | { type: 'set'; objective: string }
    | { type: 'clear' };

export type ClaudeGoalActionConfirmations = {
    clear: boolean;
    edit: boolean;
};

export const CLAUDE_GOAL_ACTION_CONFIRMATIONS: ClaudeGoalActionConfirmations = {
    clear: true,
    edit: true,
};

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

export function parseClaudeGoalStatusTranscriptEvent(value: unknown): ClaudeGoalStatusTranscriptEvent | null {
    const raw = record(value);
    if (!raw || raw.type !== 'attachment') return null;

    const attachment = record(raw.attachment);
    if (!attachment || attachment.type !== 'goal_status') return null;

    const uuid = nonEmptyString(raw.uuid);
    const sourceSessionId = nonEmptyString(raw.sessionId);
    const met = booleanValue(attachment.met);
    if (!uuid || !sourceSessionId || met === null) return null;

    const condition = nonEmptyString(attachment.condition) ?? undefined;
    const parsedAttachment: ClaudeGoalStatusAttachment = {
        type: 'goal_status',
        met,
        ...(condition ? { condition } : {}),
        ...(attachment.sentinel === true ? { sentinel: true } : {}),
        ...(nonEmptyString(attachment.reason) ? { reason: nonEmptyString(attachment.reason)! } : {}),
        ...(typeof attachment.iterations === 'number' ? { iterations: attachment.iterations } : {}),
        ...(typeof attachment.durationMs === 'number' ? { durationMs: attachment.durationMs } : {}),
        ...(typeof attachment.tokens === 'number' ? { tokens: attachment.tokens } : {}),
    };

    return {
        type: 'goal_status',
        uuid,
        sourceRevision: uuid,
        sourceSessionId,
        ...(nonEmptyString(raw.timestamp) ? { timestamp: nonEmptyString(raw.timestamp)! } : {}),
        ...(nonEmptyString(raw.version) ? { claudeVersion: nonEmptyString(raw.version)! } : {}),
        attachment: parsedAttachment,
    };
}

export function claudeGoalActionCapabilities(opts: {
    goalCommandSupported: boolean;
    observedGoalStatus: boolean;
    confirmedActions: ClaudeGoalActionConfirmations;
}): AgentGoalCapabilities | undefined {
    if (!opts.goalCommandSupported || !opts.observedGoalStatus) return undefined;
    const capabilities: AgentGoalCapabilities = {};
    if (opts.confirmedActions.clear) capabilities.clear = true;
    if (opts.confirmedActions.edit) capabilities.edit = true;
    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function baseStatus(event: ClaudeGoalStatusTranscriptEvent): Pick<AgentGoalStatus, 'source' | 'observedAt' | 'sourceSessionId' | 'sourceRevision'> {
    return {
        source: 'claude',
        observedAt: Date.now(),
        sourceSessionId: event.sourceSessionId,
        sourceRevision: event.sourceRevision,
    };
}

export function mapClaudeGoalStatusEventToAgentGoalStatus(
    event: ClaudeGoalStatusTranscriptEvent,
    currentClaudeSessionId?: string | null,
    opts?: { capabilities?: AgentGoalCapabilities },
): AgentGoalStatus | null {
    if (currentClaudeSessionId && event.sourceSessionId !== currentClaudeSessionId) {
        return null;
    }

    const condition = nonEmptyString(event.attachment.condition);
    if (!event.attachment.met) {
        if (!condition) {
            return { ...baseStatus(event), status: 'unavailable', reason: 'malformed' };
        }
        return {
            ...baseStatus(event),
            status: 'active',
            text: condition,
            ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
        };
    }

    if (condition) {
        return {
            ...baseStatus(event),
            status: 'inactive',
            reason: 'completed',
        };
    }

    return {
        ...baseStatus(event),
        status: 'inactive',
        reason: 'cleared',
    };
}

export function reduceClaudeGoalStatusEvents(
    events: ClaudeGoalStatusTranscriptEvent[],
    currentClaudeSessionId: string,
    opts?: { capabilities?: AgentGoalCapabilities },
): AgentGoalStatus | null {
    let latest: AgentGoalStatus | null = null;
    for (const event of events) {
        const mapped = mapClaudeGoalStatusEventToAgentGoalStatus(event, currentClaudeSessionId, opts);
        if (mapped) latest = mapped;
    }
    return latest;
}

export function parseClaudeGoalActionParams(params: Record<string, unknown>): ClaudeGoalCommand | null {
    if (params.action === 'clear') return { type: 'clear' };
    if (params.action === 'edit') {
        const objective = nonEmptyString(params.objective);
        return objective ? { type: 'set', objective } : null;
    }
    return null;
}
```

- [ ] **Step 4: Run mapper tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/claudeGoalStatus.test.ts
```

Expected:

```text
PASS src/claude/claudeGoalStatus.test.ts
```

- [ ] **Step 5: Commit mapper**

```bash
git add packages/happy-cli/src/claude/claudeGoalStatus.ts packages/happy-cli/src/claude/claudeGoalStatus.test.ts
git commit -m "feat(claude): map goal status attachments"
```

---

### Task 2: Scanner Goal Side Channel

**Files:**
- Modify: `packages/happy-cli/src/claude/utils/sessionScanner.ts`
- Modify: `packages/happy-cli/src/claude/utils/sessionScanner.test.ts`

- [ ] **Step 1: Add failing scanner tests**

Append tests to `packages/happy-cli/src/claude/utils/sessionScanner.test.ts`:

```ts
it('emits goal_status attachments through transcript event side channel only', async () => {
  const collectedEvents: unknown[] = [];
  scanner = await createSessionScanner({
    sessionId: null,
    workingDirectory: testDir,
    onMessage: (msg) => collectedMessages.push(msg),
    onTranscriptEvent: (event) => collectedEvents.push(event),
  });

  const sessionId = 'goal-session-1';
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(sessionFile, JSON.stringify({
    type: 'attachment',
    uuid: 'goal-att-1',
    timestamp: '2026-06-19T10:00:00.000Z',
    sessionId,
    attachment: {
      type: 'goal_status',
      met: false,
      sentinel: true,
      condition: 'finish scanner test',
    },
  }) + '\n');

  scanner.onNewSession(sessionId);
  await new Promise((r) => setTimeout(r, 200));

  expect(collectedMessages).toHaveLength(0);
  expect(collectedEvents).toHaveLength(1);
  expect(collectedEvents[0]).toMatchObject({
    type: 'goal_status',
    sourceSessionId: sessionId,
    attachment: { condition: 'finish scanner test' },
  });
});

it('does not re-emit the same goal_status attachment on repeated syncs', async () => {
  const collectedEvents: unknown[] = [];
  scanner = await createSessionScanner({
    sessionId: null,
    workingDirectory: testDir,
    onMessage: (msg) => collectedMessages.push(msg),
    onTranscriptEvent: (event) => collectedEvents.push(event),
  });

  const sessionId = 'goal-session-2';
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({
    type: 'attachment',
    uuid: 'goal-att-2',
    timestamp: '2026-06-19T10:01:00.000Z',
    sessionId,
    attachment: {
      type: 'goal_status',
      met: false,
      sentinel: true,
      condition: 'dedupe scanner test',
    },
  }) + '\n';

  await writeFile(sessionFile, line);
  scanner.onNewSession(sessionId);
  await new Promise((r) => setTimeout(r, 200));
  await appendFile(sessionFile, '');
  await new Promise((r) => setTimeout(r, 200));

  expect(collectedEvents).toHaveLength(1);
});
```

- [ ] **Step 2: Run scanner tests and verify they fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/utils/sessionScanner.test.ts -t "goal_status"
```

Expected:

```text
FAIL src/claude/utils/sessionScanner.test.ts
```

with TypeScript or runtime failure because `onTranscriptEvent` is not supported.

- [ ] **Step 3: Implement scanner side channel**

Modify `packages/happy-cli/src/claude/utils/sessionScanner.ts`:

```ts
import {
    parseClaudeGoalStatusTranscriptEvent,
    type ClaudeGoalStatusTranscriptEvent,
} from '../claudeGoalStatus';

type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

type ScannerEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent };
```

Extend options:

```ts
export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    missingFileTimeoutMs?: number
}) {
```

Replace `readSessionLog` with an entry reader:

```ts
async function readSessionEntries(projectDir: string, sessionId: string): Promise<ScannerEntry[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }

    const entries: ScannerEntry[] = [];
    for (const line of file.split('\n')) {
        try {
            if (line.trim() === '') continue;
            const raw = JSON.parse(line);

            if (raw.type && INTERNAL_CLAUDE_EVENT_TYPES.has(raw.type)) continue;

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(raw);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: `event:${transcriptEvent.uuid}`,
                    event: transcriptEvent,
                });
                continue;
            }

            const parsed = RawJSONLinesSchema.safeParse(raw);
            if (!parsed.success) continue;
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
        }
    }
    return entries;
}
```

Update call sites inside scanner:

```ts
const entries = await readSessionEntries(projectDir, session);
for (const entry of entries) {
    if (processedMessageKeys.has(entry.key)) {
        skipped++;
        continue;
    }
    processedMessageKeys.add(entry.key);
    if (entry.kind === 'message') {
        logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
        opts.onMessage(entry.message);
    } else {
        logger.debug(`[SESSION_SCANNER] Sending transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
        opts.onTranscriptEvent?.(entry.event);
    }
    sent++;
}
```

Where the scanner pre-marks existing entries, use `entry.key` for both messages and events:

```ts
const existing = await readSessionEntries(projectDir, sessionId);
for (const entry of existing) {
    processedMessageKeys.add(entry.key);
}
```

- [ ] **Step 4: Run scanner tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/utils/sessionScanner.test.ts
```

Expected:

```text
PASS src/claude/utils/sessionScanner.test.ts
```

- [ ] **Step 5: Commit scanner side channel**

```bash
git add packages/happy-cli/src/claude/utils/sessionScanner.ts packages/happy-cli/src/claude/utils/sessionScanner.test.ts
git commit -m "feat(claude): surface goal transcript events"
```

---

### Task 3: Non-Destructive Isolated Queue

**Files:**
- Modify: `packages/happy-cli/src/utils/MessageQueue2.ts`
- Modify: `packages/happy-cli/src/utils/MessageQueue2.test.ts`

- [ ] **Step 1: Add failing queue tests**

Append tests to `packages/happy-cli/src/utils/MessageQueue2.test.ts`:

```ts
it('pushIsolated does not clear pending messages and prevents batching', async () => {
    const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);

    queue.push('first prompt', { type: 'A' });
    queue.pushIsolated('isolated command', { type: 'A' });
    queue.push('next prompt', { type: 'A' });

    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
        message: 'first prompt',
        isolate: false,
    });

    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
        message: 'isolated command',
        isolate: true,
    });

    expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
        message: 'next prompt',
        isolate: false,
    });
});

it('pushIsolated notifies waiters', async () => {
    const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
    const pending = queue.waitForMessagesAndGetAsString();

    queue.pushIsolated('/goal clear', { type: 'A' });

    await expect(pending).resolves.toMatchObject({
        message: '/goal clear',
        isolate: true,
    });
});
```

- [ ] **Step 2: Run queue tests and verify they fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/utils/MessageQueue2.test.ts -t "pushIsolated"
```

Expected:

```text
FAIL src/utils/MessageQueue2.test.ts
Property 'pushIsolated' does not exist
```

- [ ] **Step 3: Implement `pushIsolated`**

Add to `packages/happy-cli/src/utils/MessageQueue2.ts` after `pushIsolateAndClear`:

```ts
/**
 * Push a message that must be processed alone without discarding
 * already-queued user prompts.
 */
pushIsolated(message: string, mode: T, attachments?: PendingAttachment[]): void {
    if (this.closed) {
        throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);
    logger.debug(`[MessageQueue2] pushIsolated() called with mode hash: ${modeHash}`);

    this.queue.push({
        message,
        mode,
        modeHash,
        isolate: true,
        attachments,
    });

    if (this.onMessageHandler) {
        this.onMessageHandler(message, mode);
    }

    if (this.waiter) {
        logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
        const waiter = this.waiter;
        this.waiter = null;
        waiter(true);
    }

    logger.debug(`[MessageQueue2] pushIsolated() completed. Queue size: ${this.queue.length}`);
}
```

- [ ] **Step 4: Run queue tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/utils/MessageQueue2.test.ts
```

Expected:

```text
PASS src/utils/MessageQueue2.test.ts
```

- [ ] **Step 5: Commit queue isolation**

```bash
git add packages/happy-cli/src/utils/MessageQueue2.ts packages/happy-cli/src/utils/MessageQueue2.test.ts
git commit -m "feat(queue): add isolated message enqueue"
```

---

### Task 4: Claude Runtime Goal Observation

**Files:**
- Modify: `packages/happy-cli/src/claude/runClaude.ts`
- Modify: `packages/happy-cli/src/claude/runClaude.test.ts`

- [ ] **Step 1: Add failing runtime observation tests**

Add a test to `packages/happy-cli/src/claude/runClaude.test.ts`:

```ts
it('updates agent goal state from scanner goal_status events without forwarding chat messages', async () => {
    const updateAgentState = vi.fn();
    const sentMessages: unknown[] = [];
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn(),
        sendClaudeSessionMessage: vi.fn((message: unknown) => sentMessages.push(message)),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => ({ claudeSessionId: 'claude-session-1', slashCommands: ['goal'] })),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: { registerHandler: vi.fn() },
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    const runPromise = runClaude({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any, {
        startingMode: 'remote',
        shouldStartDaemon: false,
    });

    await vi.waitFor(() => expect(mockCreateSessionScanner).toHaveBeenCalled());
    const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];

    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: 'goal-att-1',
        sourceRevision: 'goal-att-1',
        sourceSessionId: 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: false,
            sentinel: true,
            condition: 'finish runtime test',
        },
    });

    expect(sentMessages).toHaveLength(0);
    expect(updateAgentState).toHaveBeenCalledWith(expect.any(Function));
    const updater = updateAgentState.mock.calls[0][0];
    expect(updater({})).toMatchObject({
        agentGoalStatus: {
            source: 'claude',
            sourceSessionId: 'claude-session-1',
            status: 'active',
            text: 'finish runtime test',
            capabilities: { clear: true, edit: true },
        },
    });

    loopDeferred.resolve(0);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
    }) as never);
    await expect(runPromise).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
});
```

- [ ] **Step 2: Run the new runtime test and verify it fails**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/runClaude.test.ts -t "goal_status"
```

Expected:

```text
FAIL src/claude/runClaude.test.ts
```

because `onTranscriptEvent` is not registered or ignored.

- [ ] **Step 3: Wire goal observation in `runClaude.ts`**

Update the API type import:

```ts
import { AgentState, AgentGoalStatus, Metadata } from '@/api/types';
```

Import mapper helpers:

```ts
import {
    CLAUDE_GOAL_ACTION_CONFIRMATIONS,
    claudeGoalActionCapabilities,
    mapClaudeGoalStatusEventToAgentGoalStatus,
    parseClaudeGoalActionParams,
    type ClaudeGoalStatusTranscriptEvent,
} from './claudeGoalStatus';
```

Add local state after session client creation:

```ts
let latestClaudeGoalStatus: AgentGoalStatus | null = null;
const observedClaudeGoalRevisions = new Set<string>();

const goalCommandSupported = () => {
    const commands = session.getMetadata()?.slashCommands ?? [];
    return commands.some((command) => command === 'goal' || command === '/goal');
};

const currentClaudeSessionId = () => session.getMetadata()?.claudeSessionId ?? null;

const updateClaudeGoalState = (event: ClaudeGoalStatusTranscriptEvent) => {
    if (observedClaudeGoalRevisions.has(event.sourceRevision)) return;
    observedClaudeGoalRevisions.add(event.sourceRevision);

    const capabilities = claudeGoalActionCapabilities({
        goalCommandSupported: goalCommandSupported(),
        observedGoalStatus: true,
        confirmedActions: CLAUDE_GOAL_ACTION_CONFIRMATIONS,
    });
    const goalStatus = mapClaudeGoalStatusEventToAgentGoalStatus(
        event,
        currentClaudeSessionId(),
        capabilities ? { capabilities } : undefined,
    );
    if (!goalStatus) return;

    latestClaudeGoalStatus = goalStatus;
    session.updateAgentState((currentState) => ({
        ...currentState,
        agentGoalStatus: goalStatus,
    }));
};
```

Pass the scanner side channel in all `createSessionScanner` calls owned by `runClaude.ts`:

```ts
onTranscriptEvent: updateClaudeGoalState,
```

Keep existing `onMessage` behavior unchanged.

- [ ] **Step 4: Run runtime observation tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/runClaude.test.ts -t "goal_status|local mode owns"
```

Expected:

```text
PASS src/claude/runClaude.test.ts
```

- [ ] **Step 5: Commit runtime observation**

```bash
git add packages/happy-cli/src/claude/runClaude.ts packages/happy-cli/src/claude/runClaude.test.ts
git commit -m "feat(claude): observe goal status state"
```

---

### Task 5: Claude Goal Action RPC

**Files:**
- Modify: `packages/happy-cli/src/claude/runClaude.ts`
- Modify: `packages/happy-cli/src/claude/runClaude.test.ts`

- [ ] **Step 1: Add failing RPC tests**

Add tests to `packages/happy-cli/src/claude/runClaude.test.ts`:

```ts
it('registers Claude goal-action and queues clear as an isolated command without optimistic state changes', async () => {
    const updateAgentState = vi.fn();
    const registerHandler = vi.fn();
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => ({ claudeSessionId: 'claude-session-1', slashCommands: ['goal'] })),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: { registerHandler },
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    void runClaude({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any, { startingMode: 'remote', shouldStartDaemon: false });

    await vi.waitFor(() => {
        expect(registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        expect(mockLoop).toHaveBeenCalled();
    });
    const handler = registerHandler.mock.calls.find(([method]) => method === 'goal-action')?.[1];
    if (!handler) throw new Error('goal-action handler not registered');

    const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
    const loopOptions = mockLoop.mock.calls[0][0];
    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: 'goal-att-active',
        sourceRevision: 'goal-att-active',
        sourceSessionId: 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: false,
            sentinel: true,
            condition: 'finish rpc test',
        },
    });

    const promise = handler({ action: 'clear' });
    expect(loopOptions.messageQueue.queue).toEqual([
        expect.objectContaining({ message: '/goal clear', isolate: true }),
    ]);
    expect(updateAgentState).toHaveBeenCalledTimes(1);

    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: 'goal-att-cleared',
        sourceRevision: 'goal-att-cleared',
        sourceSessionId: 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: true,
        },
    });

    await expect(promise).resolves.toEqual({ ok: true });
});

it('rejects a second Claude goal action while one is pending', async () => {
    const updateAgentState = vi.fn();
    const registerHandler = vi.fn();
    const sessionClient = {
        sessionId: 'happy-session-1',
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateMetadata: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        on: vi.fn(),
        trackAttachmentDownload: vi.fn(),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        downloadAndDecryptAttachment: vi.fn(),
        getMetadata: vi.fn(() => ({ claudeSessionId: 'claude-session-1', slashCommands: ['goal'] })),
        sendSessionEvent: vi.fn(),
        updateAgentState,
        rpcHandlerManager: { registerHandler },
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
    };
    const api = {
        getOrCreateMachine: vi.fn(async () => ({})),
        getOrCreateSession: vi.fn(async () => ({
            id: 'happy-session-1',
            seq: 0,
            metadata: {},
            metadataVersion: 0,
            agentState: {},
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const,
        })),
        sessionSyncClient: vi.fn(() => sessionClient),
        deactivateSession: vi.fn(async () => {}),
    };
    mockApiClientCreate.mockResolvedValue(api);

    const loopDeferred = createDeferred<number>();
    mockLoop.mockReturnValue(loopDeferred.promise);

    void runClaude({
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as any, { startingMode: 'remote', shouldStartDaemon: false });

    await vi.waitFor(() => {
        expect(registerHandler).toHaveBeenCalledWith('goal-action', expect.any(Function));
        expect(mockLoop).toHaveBeenCalled();
    });
    const handler = registerHandler.mock.calls.find(([method]) => method === 'goal-action')?.[1];
    if (!handler) throw new Error('goal-action handler not registered');

    const scannerOptions = mockCreateSessionScanner.mock.calls[0][0];
    const loopOptions = mockLoop.mock.calls[0][0];
    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: 'goal-att-active',
        sourceRevision: 'goal-att-active',
        sourceSessionId: 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: false,
            sentinel: true,
            condition: 'old rpc goal',
        },
    });

    const first = handler({ action: 'edit', objective: 'new rpc goal' });
    expect(loopOptions.messageQueue.queue).toEqual([
        expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
    ]);

    await expect(handler({ action: 'clear' })).rejects.toThrow(/already in progress|busy/i);
    expect(loopOptions.messageQueue.queue).toEqual([
        expect.objectContaining({ message: '/goal new rpc goal', isolate: true }),
    ]);

    scannerOptions.onTranscriptEvent({
        type: 'goal_status',
        uuid: 'goal-att-edited',
        sourceRevision: 'goal-att-edited',
        sourceSessionId: 'claude-session-1',
        attachment: {
            type: 'goal_status',
            met: false,
            sentinel: true,
            condition: 'new rpc goal',
        },
    });

    await expect(first).resolves.toEqual({ ok: true });
});
```

- [ ] **Step 2: Run RPC tests and verify they fail**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/runClaude.test.ts -t "Claude goal-action|second Claude goal"
```

Expected:

```text
FAIL src/claude/runClaude.test.ts
```

because Claude does not register `goal-action`.

- [ ] **Step 3: Implement pending action confirmation**

In `runClaude.ts`, add:

```ts
type ClaudeGoalCommand = NonNullable<ReturnType<typeof parseClaudeGoalActionParams>>;

type PendingClaudeGoalAction = {
    command: ClaudeGoalCommand;
    resolve: (value: { ok: true }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

let pendingClaudeGoalAction: PendingClaudeGoalAction | null = null;

const settlePendingClaudeGoalAction = (goalStatus: AgentGoalStatus) => {
    if (!pendingClaudeGoalAction) return;
    const pending = pendingClaudeGoalAction;

    if (pending.command.type === 'clear' && goalStatus.status === 'inactive') {
        clearTimeout(pending.timeout);
        pendingClaudeGoalAction = null;
        pending.resolve({ ok: true });
        return;
    }

    if (
        pending.command.type === 'set'
        && goalStatus.status === 'active'
        && goalStatus.text.trim() === pending.command.objective.trim()
    ) {
        clearTimeout(pending.timeout);
        pendingClaudeGoalAction = null;
        pending.resolve({ ok: true });
    }
};
```

Call `settlePendingClaudeGoalAction(goalStatus)` immediately after `latestClaudeGoalStatus = goalStatus`.

Register RPC after `messageQueue` is created:

```ts
session.rpcHandlerManager.registerHandler('goal-action', async (params: Record<string, unknown>) => {
    const command = parseClaudeGoalActionParams(params);
    if (!command) {
        throw new Error('Unsupported Claude goal action');
    }
    if (pendingClaudeGoalAction) {
        throw new Error('Claude goal action already in progress');
    }
    if (!latestClaudeGoalStatus || latestClaudeGoalStatus.status !== 'active') {
        throw new Error('No active Claude goal');
    }
    const capabilities = latestClaudeGoalStatus.capabilities ?? {};
    if (command.type === 'clear' && !capabilities.clear) {
        throw new Error('Claude clear goal action is not supported');
    }
    if (command.type === 'set' && !capabilities.edit) {
        throw new Error('Claude edit goal action is not supported');
    }
    if (messageQueue.size() > 0) {
        throw new Error('Claude message queue is busy');
    }

    const mode = currentEnhancedMode();
    const slashCommand = command.type === 'clear'
        ? '/goal clear'
        : `/goal ${command.objective}`;

    return await new Promise<{ ok: true }>((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingClaudeGoalAction = null;
            reject(new Error('Timed out waiting for Claude goal confirmation'));
        }, 30000);

        pendingClaudeGoalAction = { command, resolve, reject, timeout };
        try {
            messageQueue.pushIsolated(slashCommand, mode);
        } catch (error) {
            clearTimeout(timeout);
            pendingClaudeGoalAction = null;
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
});
```

Extract current mode creation from the existing on-user-message path into a local helper:

```ts
const currentEnhancedMode = (): EnhancedMode => ({
    permissionMode: currentPermissionMode || 'default',
    model: currentModel,
    fallbackModel: currentFallbackModel,
    customSystemPrompt: currentCustomSystemPrompt,
    appendSystemPrompt: currentAppendSystemPrompt,
    allowedTools: currentAllowedTools,
    disallowedTools: currentDisallowedTools,
    effort: currentEffort,
});
```

Use `currentEnhancedMode()` in the ordinary message path too, so action and chat messages share mode construction.

- [ ] **Step 4: Run RPC tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/runClaude.test.ts
```

Expected:

```text
PASS src/claude/runClaude.test.ts
```

- [ ] **Step 5: Commit action RPC**

```bash
git add packages/happy-cli/src/claude/runClaude.ts packages/happy-cli/src/claude/runClaude.test.ts
git commit -m "feat(claude): route goal actions"
```

---

### Task 6: App Contract Regression Checks

**Files:**
- Modify only if tests fail:
  - `packages/happy-app/sources/components/AgentGoalBar.spec.ts`
  - `packages/happy-app/sources/-session/SessionView.tsx`

- [ ] **Step 1: Run app goal-bar tests before changing app code**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/components/AgentGoalBar.spec.ts sources/components/agentGoalStatus.spec.ts sources/sync/storageTypes.spec.ts --run
```

Expected:

```text
PASS
```

- [ ] **Step 2: Add a regression test only if partial capabilities are not covered**

If no existing test proves a goal with only `{ edit: true }` renders only edit, add this test to `AgentGoalBar.spec.ts`:

```ts
it('renders only the actions explicitly reported by the agent', async () => {
    const element = await renderGoalBar({
        goal: {
            ...goal,
            capabilities: { edit: true },
        },
    });

    expect(findAllByLabel(element, 'Edit goal')).toHaveLength(1);
    expect(findAllByLabel(element, 'Clear goal')).toHaveLength(0);
    expect(findAllByLabel(element, 'Stop goal')).toHaveLength(0);
});
```

- [ ] **Step 3: Run app goal tests again**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/components/AgentGoalBar.spec.ts sources/components/agentGoalStatus.spec.ts sources/sync/storageTypes.spec.ts --run
```

Expected:

```text
PASS
```

- [ ] **Step 4: Commit app regression coverage only if a test was added**

If no app files changed, skip this commit. If a test was added:

```bash
git add packages/happy-app/sources/components/AgentGoalBar.spec.ts
git commit -m "test(app): cover partial goal capabilities"
```

---

### Task 7: Integration Verification

**Files:**
- No source changes.

- [ ] **Step 1: Run focused CLI tests**

Run:

```bash
pnpm --filter happy exec vitest run --project unit src/claude/claudeGoalStatus.test.ts src/claude/utils/sessionScanner.test.ts src/claude/runClaude.test.ts src/utils/MessageQueue2.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: Run app goal tests**

Run:

```bash
pnpm --dir packages/happy-app exec vitest run sources/components/AgentGoalBar.spec.ts sources/components/agentGoalStatus.spec.ts sources/sync/storageTypes.spec.ts --run
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run typechecks**

Run:

```bash
pnpm --filter happy run typecheck
pnpm --filter happy-app run typecheck
```

Expected:

```text
no TypeScript errors
```

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected:

```text
no output
```

- [ ] **Step 5: Manual smoke with log watch**

Install local CLI:

```bash
pnpm --filter happy cli:install
happy --version
```

Start or attach to a Claude Happy session, then from the app:

```text
/goal keep working until the goal bar is visible
```

Verify:

- Goal bar appears only after a `goal_status` attachment is observed.
- Edit sends `/goal <new objective>`.
- Bar text changes only after the replacement active `goal_status`.
- Clear sends `/goal clear`.
- Bar hides only after structured inactive/cleared state.

Watch logs:

```bash
ls -lt ~/.happy/logs | head
tail -f ~/.happy/logs/<latest-log-file>
```

Watch Claude transcript:

```bash
tail -f ~/.claude/projects/<project-slug>/<claude-session-id>.jsonl | rg --line-buffered 'goal_status|/goal'
```

Expected:

- No `/goal` user text is used to update `agentGoalStatus`.
- `agentGoalStatus` updates only after side-channel `goal_status`.
- No evaluator `reason`, `tokens`, or `durationMs` is synced into `AgentState`.

- [ ] **Step 6: Final commit if verification required cleanup changes**

If verification required additional source fixes:

```bash
git status --short
```

Stage only the exact source files changed by verification cleanup, then commit them with:

```bash
git commit -m "fix(claude): stabilize goal parity"
```

If no files changed after verification, do not create an empty commit.

---

## Plan Self-Review Checklist

- Spec coverage:
  - Discovery gate: Task 0.
  - Claude `goal_status` mapping: Task 1.
  - Scanner side channel and conversation-only schema: Task 2.
  - Isolated, non-destructive slash command queueing: Task 3.
  - Runtime observation, freshness, and capability gates: Task 4.
  - Clear/edit RPC delegation with confirmation: Task 5.
  - App shared UI contract: Task 6.
  - Verification and manual smoke: Task 7.
- Placeholder scan:
  - No forbidden placeholder markers remain after self-review.
  - All Task 5 RPC tests include concrete setup code.
- Type consistency:
  - `AgentGoalStatus`, `AgentGoalStatus.capabilities`, `sessionGoalAction`, `goal-action`, and `MessageQueue2` names match the current codebase.
  - New scanner side-channel events are intentionally separate from `RawJSONLines`.
