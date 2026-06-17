# Authoritative Agent Goal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authoritative-only agent goal contract and hidden UI surface that can render current goals only when Claude or Codex provides machine-readable goal state.

**Architecture:** Store an optional `agentGoalStatus` read model in encrypted `AgentState`, but never derive it from chat text or `/goal` messages. The app resolves a visible goal only from active status tied to the current Claude session id or Codex thread id, then renders a small read-only `AgentGoalBar` above the composer. Agent-specific source wiring is blocked behind an explicit discovery gate; if no authoritative Claude/Codex source exists, the bar remains hidden.

**Tech Stack:** TypeScript, Zod 4, React Native, React 19, Vitest, pnpm.

---

## Scope Check

This plan implements Phase 1 from `docs/superpowers/specs/2026-06-17-authoritative-agent-goal-design.md` and adds a strict Phase 2 source discovery gate. It does not implement Happy-owned goal state, transcript inference, stop-hook enforcement, or optimistic clear/stop/edit actions.

If the source discovery gate finds no machine-readable Claude or Codex goal source, stop after Phase 1. That is a valid completed implementation because visible behavior remains unchanged and no fake current-goal UI ships.

## File Structure

- Modify `packages/happy-app/sources/sync/storageTypes.ts`
  - Owns app-side Zod schemas for encrypted metadata and agent state.
  - Add `AgentGoalStatusSchema` and `agentGoalStatus` to `AgentStateSchema`.
- Modify `packages/happy-app/sources/sync/storageTypes.spec.ts`
  - Unit tests for valid and invalid goal status payloads.
- Modify `packages/happy-cli/src/api/types.ts`
  - Mirror the `AgentGoalStatus` TypeScript type for CLI `AgentState`.
- Create `packages/happy-app/sources/components/agentGoalStatus.ts`
  - Pure resolver that decides whether a session can show a current-goal bar.
  - Keeps connectivity and source identity checks out of UI rendering.
- Create `packages/happy-app/sources/components/agentGoalStatus.spec.ts`
  - Unit tests for active, inactive, unavailable, disconnected, heartbeat, and identity-mismatch cases.
- Create `packages/happy-app/sources/components/AgentGoalBar.tsx`
  - Small presentational component for the current-goal bar.
  - Renders actions only when both a capability and an action handler are provided.
- Create `packages/happy-app/sources/components/AgentGoalBar.spec.ts`
  - Pure React element tests for text, read-only behavior, and action routing.
- Modify `packages/happy-app/sources/text/_default.ts` and `packages/happy-app/sources/text/translations/*.ts`
  - Add localized strings for the goal bar label, action labels, and accessibility label.
- Modify `packages/happy-app/sources/-session/SessionView.tsx`
  - Resolve visible goal state and render `AgentGoalBar` above the composer.
- Optional source-gate only: inspect Claude SDK and Codex app-server types before any adapter wiring.

---

### Task 1: Add App And CLI Agent Goal Status Contract

**Files:**
- Modify: `packages/happy-app/sources/sync/storageTypes.ts`
- Modify: `packages/happy-app/sources/sync/storageTypes.spec.ts`
- Modify: `packages/happy-cli/src/api/types.ts`

- [ ] **Step 1: Add failing app schema tests**

Replace `packages/happy-app/sources/sync/storageTypes.spec.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { AgentGoalStatusSchema, AgentStateSchema, MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves archive lifecycle metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
            lifecycleState: 'archived',
            lifecycleStateSince: 123,
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.lifecycleState).toBe('archived');
        expect(metadata.lifecycleStateSince).toBe(123);
        expect(metadata.archivedBy).toBe('cli');
        expect(metadata.archiveReason).toBe('User terminated');
    });
});

describe('AgentGoalStatusSchema', () => {
    it('accepts active goal state with source identity and capabilities', () => {
        const goal = AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the current task',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
            sourceRevision: 7,
            capabilities: {
                clear: true,
                stop: false,
            },
            progress: {
                currentStep: 1,
                totalSteps: 2,
                steps: [
                    { text: 'inspect source', status: 'completed' },
                    { text: 'write fix', status: 'in_progress' },
                ],
            },
        });

        expect(goal.status).toBe('active');
        expect(goal.text).toBe('finish the current task');
        expect(goal.capabilities?.clear).toBe(true);
        expect(goal.progress?.steps).toHaveLength(2);
    });

    it('accepts inactive and unavailable states', () => {
        expect(AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            reason: 'completed',
        })).toMatchObject({ status: 'inactive', reason: 'completed' });

        expect(AgentGoalStatusSchema.parse({
            status: 'unavailable',
            source: 'claude',
            observedAt: 1710000000000,
            reason: 'unsupported',
        })).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    });

    it('rejects active state without non-empty text', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: '   ',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
        })).toThrow();
    });

    it('rejects active state without source identity', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
        })).toThrow();
    });

    it('rejects malformed capabilities and progress payloads', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'claude-session-1',
            capabilities: { clear: 'yes' },
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'codex',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: 'codex-thread-1',
            progress: {
                currentStep: 0,
                totalSteps: 1,
                steps: [{ text: 'bad', status: 'unknown' }],
            },
        })).toThrow();
    });

    it('rejects empty source identity values', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: 1710000000000,
            sourceSessionId: '   ',
        })).toThrow();

        expect(() => AgentGoalStatusSchema.parse({
            status: 'inactive',
            source: 'codex',
            observedAt: 1710000000000,
            sourceRevision: '',
        })).toThrow();
    });

    it('rejects invalid observation timestamps', () => {
        expect(() => AgentGoalStatusSchema.parse({
            status: 'active',
            source: 'claude',
            text: 'finish the task',
            observedAt: -1,
            sourceSessionId: 'claude-session-1',
        })).toThrow();
    });

    it('preserves agent goal status through AgentStateSchema', () => {
        const state = AgentStateSchema.parse({
            controlledByUser: true,
            agentGoalStatus: {
                status: 'active',
                source: 'codex',
                text: 'review the branch',
                observedAt: 1710000000000,
                sourceSessionId: 'codex-thread-1',
            },
        });

        expect(state.agentGoalStatus?.status).toBe('active');
    });
});
```

- [ ] **Step 2: Run schema tests and verify they fail**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts
```

Expected: FAIL because `AgentGoalStatusSchema` is not exported from `storageTypes.ts`.

- [ ] **Step 3: Add app Zod schema and AgentState field**

In `packages/happy-app/sources/sync/storageTypes.ts`, insert this block immediately before `export const AgentStateSchema = z.object({`:

```ts
export const AgentGoalSourceSchema = z.enum(['claude', 'codex']);

export const AgentGoalProgressStepSchema = z.object({
    text: z.string().trim().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
}).strict();

export const AgentGoalProgressSchema = z.object({
    currentStep: z.number().int().positive().optional(),
    totalSteps: z.number().int().positive().optional(),
    steps: z.array(AgentGoalProgressStepSchema).optional(),
}).strict();

export const AgentGoalCapabilitiesSchema = z.object({
    clear: z.boolean().optional(),
    stop: z.boolean().optional(),
    edit: z.boolean().optional(),
}).strict();

const AgentGoalStatusBaseSchema = z.object({
    source: AgentGoalSourceSchema,
    observedAt: z.number().int().nonnegative(),
    sourceSessionId: z.string().trim().min(1).optional(),
    sourceRevision: z.union([z.string().trim().min(1), z.number()]).optional(),
});

export const AgentGoalStatusSchema = z.discriminatedUnion('status', [
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('unavailable'),
        reason: z.enum(['unsupported', 'not_loaded', 'stale', 'malformed', 'error', 'unknown']).optional(),
    }).strict(),
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('inactive'),
        reason: z.enum(['none', 'cleared', 'completed', 'unknown']).optional(),
    }).strict(),
    AgentGoalStatusBaseSchema.extend({
        status: z.literal('active'),
        sourceSessionId: z.string().trim().min(1),
        text: z.string().trim().min(1),
        capabilities: AgentGoalCapabilitiesSchema.optional(),
        progress: AgentGoalProgressSchema.optional(),
    }).strict(),
]);

export type AgentGoalStatus = z.infer<typeof AgentGoalStatusSchema>;
```

Then add `agentGoalStatus` inside `AgentStateSchema`:

```ts
export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish(),
    agentGoalStatus: AgentGoalStatusSchema.optional(),
});
```

- [ ] **Step 4: Add CLI TypeScript mirror type**

In `packages/happy-cli/src/api/types.ts`, insert immediately before `export type AgentState = {`:

```ts
export type AgentGoalStatus = {
  source: 'claude' | 'codex',
  observedAt: number,
  sourceSessionId?: string,
  sourceRevision?: string | number,
} & (
  | {
      status: 'unavailable',
      reason?: 'unsupported' | 'not_loaded' | 'stale' | 'malformed' | 'error' | 'unknown',
    }
  | {
      status: 'inactive',
      reason?: 'none' | 'cleared' | 'completed' | 'unknown',
    }
  | {
      status: 'active',
      sourceSessionId: string,
      text: string,
      capabilities?: {
        clear?: boolean,
        stop?: boolean,
        edit?: boolean,
      },
      progress?: {
        currentStep?: number,
        totalSteps?: number,
        steps?: Array<{
          text: string,
          status: 'pending' | 'in_progress' | 'completed',
        }>,
      },
    }
);
```

Then add the field to `AgentState`:

```ts
export type AgentState = {
  controlledByUser?: boolean | null | undefined
  requests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number
    }
  }
  completedRequests?: {
    [id: string]: {
      tool: string,
      arguments: any,
      createdAt: number,
      completedAt: number,
      status: 'canceled' | 'denied' | 'approved',
      reason?: string,
      mode?: PermissionMode,
      decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort',
      allowTools?: string[]
    }
  }
  agentGoalStatus?: AgentGoalStatus
}
```

- [ ] **Step 5: Run schema tests and typechecks**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts
pnpm --filter happy-app run typecheck
pnpm --filter happy run typecheck
```

Expected: PASS for all three commands.

- [ ] **Step 6: Commit contract changes**

Run:

```bash
git add packages/happy-app/sources/sync/storageTypes.ts packages/happy-app/sources/sync/storageTypes.spec.ts packages/happy-cli/src/api/types.ts
git commit -m "feat: add agent goal status contract"
```

---

### Task 2: Add Freshness And Visibility Resolver

**Files:**
- Create: `packages/happy-app/sources/components/agentGoalStatus.ts`
- Create: `packages/happy-app/sources/components/agentGoalStatus.spec.ts`

- [ ] **Step 1: Add failing resolver tests**

Create `packages/happy-app/sources/components/agentGoalStatus.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import { resolveVisibleAgentGoalStatus } from './agentGoalStatus';

function sessionWith(overrides: Partial<Session>): Session {
    return {
        id: 'happy-session-1',
        seq: 1,
        createdAt: 1000,
        updatedAt: 2000,
        active: true,
        activeAt: 10_000,
        metadata: {
            path: '/tmp/project',
            host: 'local',
            claudeSessionId: 'claude-session-1',
            codexThreadId: 'codex-thread-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('resolveVisibleAgentGoalStatus', () => {
    it('returns an active goal for the current Claude session identity', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'finish the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                    capabilities: { clear: true },
                },
            },
        }));

        expect(visible?.text).toBe('finish the branch');
        expect(visible?.capabilities?.clear).toBe(true);
    });

    it('returns an active goal for the current Codex thread identity', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'review the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'codex-thread-1',
                },
            },
        }));

        expect(visible?.text).toBe('review the branch');
    });

    it('hides inactive, unavailable, and missing goal states', () => {
        expect(resolveVisibleAgentGoalStatus(sessionWith({ agentState: null }))).toBeNull();

        expect(resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'inactive',
                    source: 'claude',
                    observedAt: 11_000,
                    reason: 'completed',
                },
            },
        }))).toBeNull();

        expect(resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'unavailable',
                    source: 'codex',
                    observedAt: 11_000,
                    reason: 'unsupported',
                },
            },
        }))).toBeNull();
    });

    it('hides active goals while the session is disconnected', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            presence: Date.now() - 60_000,
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'finish the branch',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('keeps a matching active goal visible when heartbeat activeAt advances', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            activeAt: 20_000,
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'current goal',
                    observedAt: 19_999,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible?.text).toBe('current goal');
    });

    it('hides active goals whose source session id does not match metadata', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'old thread goal',
                    observedAt: 11_000,
                    sourceSessionId: 'different-thread',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals with sourceSessionId when metadata has no current agent id', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            metadata: {
                path: '/tmp/project',
                host: 'local',
            },
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'unverifiable goal',
                    observedAt: 11_000,
                    sourceSessionId: 'claude-session-1',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals with blank sourceSessionId defensively', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'claude',
                    text: 'blank identity goal',
                    observedAt: 11_000,
                    sourceSessionId: '',
                },
            },
        }));

        expect(visible).toBeNull();
    });

    it('hides active goals without sourceSessionId defensively', () => {
        const visible = resolveVisibleAgentGoalStatus(sessionWith({
            agentState: {
                agentGoalStatus: {
                    status: 'active',
                    source: 'codex',
                    text: 'unverifiable current-run goal',
                    observedAt: 10_001,
                } as any,
            },
        }));

        expect(visible).toBeNull();
    });
});
```

- [ ] **Step 2: Run resolver tests and verify they fail**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/agentGoalStatus.spec.ts
```

Expected: FAIL because `packages/happy-app/sources/components/agentGoalStatus.ts` does not exist.

- [ ] **Step 3: Implement resolver**

Create `packages/happy-app/sources/components/agentGoalStatus.ts`:

```ts
import type { AgentGoalStatus, Session } from '@/sync/storageTypes';

export type VisibleAgentGoalStatus = AgentGoalStatus & { status: 'active'; text: string; sourceSessionId: string };

type GoalSession = Pick<Session, 'agentState' | 'presence' | 'metadata'>;

function expectedSourceSessionId(session: GoalSession, source: AgentGoalStatus['source']): string | null {
    if (source === 'claude') {
        return session.metadata?.claudeSessionId ?? null;
    }
    if (source === 'codex') {
        return session.metadata?.codexThreadId ?? null;
    }
    return null;
}

function sourceIdentityMatches(session: GoalSession, goal: VisibleAgentGoalStatus): boolean {
    const expected = expectedSourceSessionId(session, goal.source);
    return expected !== null
        && typeof goal.sourceSessionId === 'string'
        && goal.sourceSessionId.trim().length > 0
        && goal.sourceSessionId === expected;
}

export function resolveVisibleAgentGoalStatus(session: GoalSession): VisibleAgentGoalStatus | null {
    const goal = session.agentState?.agentGoalStatus;
    if (!goal || goal.status !== 'active') {
        return null;
    }

    if (session.presence !== 'online') {
        return null;
    }

    if (!sourceIdentityMatches(session, goal)) {
        return null;
    }

    return goal;
}
```

- [ ] **Step 4: Run resolver tests and typecheck**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/agentGoalStatus.spec.ts
pnpm --filter happy-app run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 5: Commit resolver**

Run:

```bash
git add packages/happy-app/sources/components/agentGoalStatus.ts packages/happy-app/sources/components/agentGoalStatus.spec.ts
git commit -m "feat(app): resolve visible agent goal state"
```

---

### Task 3: Add Read-Only Agent Goal Bar Component

**Files:**
- Create: `packages/happy-app/sources/components/AgentGoalBar.tsx`
- Create: `packages/happy-app/sources/components/AgentGoalBar.spec.ts`
- Modify: `packages/happy-app/sources/text/_default.ts`
- Modify: `packages/happy-app/sources/text/translations/en.ts`
- Modify: `packages/happy-app/sources/text/translations/ru.ts`
- Modify: `packages/happy-app/sources/text/translations/pl.ts`
- Modify: `packages/happy-app/sources/text/translations/es.ts`
- Modify: `packages/happy-app/sources/text/translations/it.ts`
- Modify: `packages/happy-app/sources/text/translations/pt.ts`
- Modify: `packages/happy-app/sources/text/translations/ca.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hans.ts`
- Modify: `packages/happy-app/sources/text/translations/zh-Hant.ts`
- Modify: `packages/happy-app/sources/text/translations/ja.ts`

- [ ] **Step 1: Add localized goal bar strings**

Add `agentGoalBar` under the existing `components` object in `packages/happy-app/sources/text/_default.ts` and every file in `packages/happy-app/sources/text/translations/`.

Use these exact values:

| File | currentGoal | clearGoal | stopGoal | editGoal | accessibilityLabel |
| --- | --- | --- | --- | --- | --- |
| `_default.ts`, `en.ts` | `Current goal` | `Clear goal` | `Stop goal` | `Edit goal` | `Current goal: ${goal}` |
| `ru.ts` | `Текущая цель` | `Очистить цель` | `Остановить цель` | `Изменить цель` | `Текущая цель: ${goal}` |
| `pl.ts` | `Bieżący cel` | `Wyczyść cel` | `Zatrzymaj cel` | `Edytuj cel` | `Bieżący cel: ${goal}` |
| `es.ts` | `Objetivo actual` | `Borrar objetivo` | `Detener objetivo` | `Editar objetivo` | `Objetivo actual: ${goal}` |
| `it.ts` | `Obiettivo attuale` | `Cancella obiettivo` | `Ferma obiettivo` | `Modifica obiettivo` | `Obiettivo attuale: ${goal}` |
| `pt.ts` | `Objetivo atual` | `Limpar objetivo` | `Parar objetivo` | `Editar objetivo` | `Objetivo atual: ${goal}` |
| `ca.ts` | `Objectiu actual` | `Esborra objectiu` | `Atura objectiu` | `Edita objectiu` | `Objectiu actual: ${goal}` |
| `zh-Hans.ts` | `当前目标` | `清除目标` | `停止目标` | `编辑目标` | `当前目标：${goal}` |
| `zh-Hant.ts` | `目前目標` | `清除目標` | `停止目標` | `編輯目標` | `目前目標：${goal}` |
| `ja.ts` | `現在の目標` | `目標をクリア` | `目標を停止` | `目標を編集` | `現在の目標: ${goal}` |

Each object must use this shape:

```ts
        agentGoalBar: {
            currentGoal: 'Current goal',
            accessibilityLabel: ({ goal }: { goal: string }) => `Current goal: ${goal}`,
            clearGoal: 'Clear goal',
            stopGoal: 'Stop goal',
            editGoal: 'Edit goal',
        },
```

Replace the string literals with the exact per-file values from the table. Keep the same object shape in every language file so `TranslationStructure` typechecking remains valid.

- [ ] **Step 2: Add failing component tests**

Create `packages/happy-app/sources/components/AgentGoalBar.spec.ts`:

```ts
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { VisibleAgentGoalStatus } from './agentGoalStatus';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Icon', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surfaceHigh: '#242424',
                surfacePressed: '#303030',
                text: '#ffffff',
                textSecondary: '#a0a0a0',
                divider: '#444444',
                button: {
                    secondary: {
                        tint: '#c0c0c0',
                    },
                },
            },
        },
    }),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: { goal?: string }) => {
        const values: Record<string, string> = {
            'components.agentGoalBar.currentGoal': 'Current goal',
            'components.agentGoalBar.clearGoal': 'Clear goal',
            'components.agentGoalBar.stopGoal': 'Stop goal',
            'components.agentGoalBar.editGoal': 'Edit goal',
        };
        if (key === 'components.agentGoalBar.accessibilityLabel') {
            return `Current goal: ${params?.goal ?? ''}`;
        }
        return values[key] ?? key;
    },
}));

const goal: VisibleAgentGoalStatus = {
    status: 'active',
    source: 'claude',
    text: 'finish the current task',
    observedAt: 11_000,
    sourceSessionId: 'claude-session-1',
};

type ElementWithProps = React.ReactElement<Record<string, any>>;

function childrenOf(node: React.ReactNode): React.ReactNode[] {
    if (!React.isValidElement(node)) {
        return [];
    }
    return React.Children.toArray((node as ElementWithProps).props.children);
}

function textContent(node: React.ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    return childrenOf(node).map(textContent).join('');
}

function findAllByLabel(node: React.ReactNode, label: string): ElementWithProps[] {
    const matches: ElementWithProps[] = [];
    if (React.isValidElement(node)) {
        const element = node as ElementWithProps;
        if (element.props.accessibilityLabel === label) {
            matches.push(element);
        }
        for (const child of childrenOf(element)) {
            matches.push(...findAllByLabel(child, label));
        }
    }
    return matches;
}

async function renderGoalBar(props: Record<string, unknown>): Promise<ElementWithProps> {
    const { AgentGoalBar } = await import('./AgentGoalBar');
    return AgentGoalBar(props as any) as ElementWithProps;
}

describe('AgentGoalBar', () => {
    it('renders the current goal label and text', async () => {
        const element = await renderGoalBar({ goal });

        expect(textContent(element)).toContain('Current goal');
        expect(textContent(element)).toContain('finish the current task');
        expect(findAllByLabel(element, 'Current goal: finish the current task')).toHaveLength(1);
    });

    it('does not render action buttons without an action handler', async () => {
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true, stop: true, edit: true },
            },
        });

        expect(findAllByLabel(element, 'Clear goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Stop goal')).toHaveLength(0);
        expect(findAllByLabel(element, 'Edit goal')).toHaveLength(0);
    });

    it('renders and dispatches explicit action capabilities', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true, stop: false, edit: true },
            },
            onAction,
        });

        const clearButton = findAllByLabel(element, 'Clear goal')[0];
        const editButton = findAllByLabel(element, 'Edit goal')[0];
        expect(findAllByLabel(element, 'Stop goal')).toHaveLength(0);

        clearButton.props.onPress();
        editButton.props.onPress();

        expect(onAction).toHaveBeenNthCalledWith(1, 'clear');
        expect(onAction).toHaveBeenNthCalledWith(2, 'edit');
    });

    it('disables the in-flight action button', async () => {
        const onAction = vi.fn();
        const element = await renderGoalBar({
            goal: {
                ...goal,
                capabilities: { clear: true },
            },
            onAction,
            inFlightAction: 'clear',
        });

        const clearButton = findAllByLabel(element, 'Clear goal')[0];
        expect(clearButton.props.accessibilityState).toEqual({ disabled: true });
    });
});
```

- [ ] **Step 3: Run component tests and verify they fail**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/AgentGoalBar.spec.ts
```

Expected: FAIL because `AgentGoalBar.tsx` does not exist.

- [ ] **Step 4: Implement component**

Create `packages/happy-app/sources/components/AgentGoalBar.tsx`:

```tsx
import { Ionicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { VisibleAgentGoalStatus } from './agentGoalStatus';
import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

export type AgentGoalAction = 'clear' | 'stop' | 'edit';

type AgentGoalBarProps = {
    goal: VisibleAgentGoalStatus;
    onAction?: (action: AgentGoalAction) => void;
    inFlightAction?: AgentGoalAction | null;
    onPressDetails?: () => void;
};

const ACTION_CONFIG: Array<{
    action: AgentGoalAction;
    capability: keyof NonNullable<VisibleAgentGoalStatus['capabilities']>;
    icon: keyof typeof Ionicons.glyphMap;
}> = [
    { action: 'edit', capability: 'edit', icon: 'create-outline' },
    { action: 'stop', capability: 'stop', icon: 'pause-outline' },
    { action: 'clear', capability: 'clear', icon: 'trash-outline' },
];

export function AgentGoalBar(props: AgentGoalBarProps) {
    const { theme } = useUnistyles();
    const actions = props.onAction
        ? ACTION_CONFIG.filter((item) => props.goal.capabilities?.[item.capability])
        : [];
    const actionLabels: Record<AgentGoalAction, string> = {
        edit: t('components.agentGoalBar.editGoal'),
        stop: t('components.agentGoalBar.stopGoal'),
        clear: t('components.agentGoalBar.clearGoal'),
    };

    return (
        <Pressable
            accessibilityLabel={t('components.agentGoalBar.accessibilityLabel', { goal: props.goal.text })}
            onPress={props.onPressDetails}
            style={({ pressed }) => ({
                backgroundColor: theme.colors.surfaceHigh,
                borderColor: theme.colors.divider,
                borderWidth: 1,
                borderRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                marginBottom: 8,
                opacity: pressed && props.onPressDetails ? 0.8 : 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
            })}
        >
            <Ionicons name="locate-outline" size={18} color={theme.colors.textSecondary} />
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                    style={{
                        color: theme.colors.textSecondary,
                        fontSize: 12,
                        lineHeight: 16,
                        fontWeight: '600',
                    }}
                    numberOfLines={1}
                >
                    {t('components.agentGoalBar.currentGoal')}
                </Text>
                <Text
                    style={{
                        color: theme.colors.text,
                        fontSize: 14,
                        lineHeight: 19,
                    }}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                >
                    {props.goal.text}
                </Text>
            </View>
            {actions.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {actions.map((item) => {
                        const disabled = props.inFlightAction === item.action;
                        return (
                            <Pressable
                                key={item.action}
                                accessibilityRole="button"
                                accessibilityLabel={actionLabels[item.action]}
                                accessibilityState={{ disabled }}
                                disabled={disabled}
                                onPress={() => props.onAction?.(item.action)}
                                hitSlop={8}
                                style={({ pressed }) => ({
                                    width: 30,
                                    height: 30,
                                    borderRadius: 15,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: pressed ? theme.colors.surfacePressed : 'transparent',
                                    opacity: disabled ? 0.6 : 1,
                                })}
                            >
                                {disabled ? (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                ) : (
                                    <Ionicons name={item.icon} size={16} color={theme.colors.button.secondary.tint} />
                                )}
                            </Pressable>
                        );
                    })}
                </View>
            )}
        </Pressable>
    );
}
```

- [ ] **Step 5: Run component tests and typecheck**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/AgentGoalBar.spec.ts
pnpm --filter happy-app run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 6: Commit component**

Run:

```bash
git add packages/happy-app/sources/components/AgentGoalBar.tsx packages/happy-app/sources/components/AgentGoalBar.spec.ts packages/happy-app/sources/text/_default.ts packages/happy-app/sources/text/translations/en.ts packages/happy-app/sources/text/translations/ru.ts packages/happy-app/sources/text/translations/pl.ts packages/happy-app/sources/text/translations/es.ts packages/happy-app/sources/text/translations/it.ts packages/happy-app/sources/text/translations/pt.ts packages/happy-app/sources/text/translations/ca.ts packages/happy-app/sources/text/translations/zh-Hans.ts packages/happy-app/sources/text/translations/zh-Hant.ts packages/happy-app/sources/text/translations/ja.ts
git commit -m "feat(app): add agent goal bar"
```

---

### Task 4: Render The Bar Above The Composer Through The Resolver

**Files:**
- Modify: `packages/happy-app/sources/-session/SessionView.tsx`
- Modify: `packages/happy-app/sources/components/agentGoalStatus.spec.ts`

- [ ] **Step 1: Add resolver regression for missing authoritative state**

Append this test to `packages/happy-app/sources/components/agentGoalStatus.spec.ts`:

```ts
it('does not invent visible goal state without agentGoalStatus', () => {
    const visible = resolveVisibleAgentGoalStatus(sessionWith({
        agentState: {},
    }));

    expect(visible).toBeNull();
});
```

- [ ] **Step 2: Run resolver test**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/agentGoalStatus.spec.ts
```

Expected: PASS. This is a regression guard that visible state comes only from `agentState.agentGoalStatus`.

- [ ] **Step 3: Wire component into SessionView**

In `packages/happy-app/sources/-session/SessionView.tsx`, add imports near the other component imports:

```ts
import { AgentGoalBar } from '@/components/AgentGoalBar';
import { resolveVisibleAgentGoalStatus } from '@/components/agentGoalStatus';
```

Inside `SessionViewLoaded`, after `const usageData = React.useMemo(() => { ... }, [sessionUsage, session.latestUsage]);`, add:

```ts
    const visibleAgentGoal = React.useMemo(() => (
        resolveVisibleAgentGoalStatus(session)
    ), [
        session.agentState?.agentGoalStatus,
        session.presence,
        session.metadata?.claudeSessionId,
        session.metadata?.codexThreadId,
    ]);
```

Then replace the existing `const input = (` block with:

```tsx
    const input = (
        <>
            {inactiveHint}
            {visibleAgentGoal && (
                <CenteredInputWidth horizontalPadding={sessionInputHorizontalPadding}>
                    <AgentGoalBar goal={visibleAgentGoal} />
                </CenteredInputWidth>
            )}
            {composer}
        </>
    );
```

Do not pass `onAction` in this task. Without an authoritative action transport, the bar is read-only even if a future test fixture includes capabilities.

- [ ] **Step 4: Run focused app tests and typecheck**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/components/agentGoalStatus.spec.ts sources/components/AgentGoalBar.spec.ts sources/sync/storageTypes.spec.ts
pnpm --filter happy-app run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 5: Commit SessionView wiring**

Run:

```bash
git add packages/happy-app/sources/-session/SessionView.tsx packages/happy-app/sources/components/agentGoalStatus.spec.ts
git commit -m "feat(app): render authoritative agent goal bar"
```

---

### Task 5: Run Authoritative Source Discovery Gate

**Files:**
- No code files are modified unless a machine-readable source is proven.

- [ ] **Step 1: Inspect Claude SDK for goal-state API**

Run:

```bash
rg -n "\\bgoal\\b|\\bgoals\\b|Goal" packages/happy-cli/node_modules/@anthropic-ai/claude-agent-sdk packages/happy-cli/src/claude 2>/dev/null || true
```

Expected for the current checkout: no machine-readable goal state API. Matches in comments or prose do not count.

- [ ] **Step 2: Inspect Codex app-server types for goal-state API**

Run:

```bash
rg -n "\\bgoal\\b|\\bgoals\\b|Goal" packages/happy-cli/src/codex packages/happy-cli/node_modules/@openai/codex node_modules/@openai/codex 2>/dev/null || true
```

Expected for the current checkout: no machine-readable goal state API.

- [ ] **Step 3: Document the source gate outcome in the commit message or PR body**

If both commands find no authoritative source, do not modify Claude or Codex adapters. Add this exact note to the implementation PR body:

```md
Goal state source gate: checked Claude SDK and Codex app-server surfaces for machine-readable goal metadata/events/status. No authoritative goal-state source was available in this checkout, so this PR adds the contract and hidden UI only. The current-goal bar remains hidden until an adapter can report authoritative `agentGoalStatus`.
```

If either command finds a structured source, stop before coding adapter wiring and draft a follow-up plan that names the exact event or API shape. Do not infer behavior from prose output.

- [ ] **Step 4: Commit no-source gate note only if a local docs note is added**

If the PR body will carry the note, no commit is needed for this task. If a repo note is requested instead, create `docs/superpowers/plans/2026-06-17-authoritative-agent-goal-source-gate.md` with the exact command outputs and commit it:

```bash
git add docs/superpowers/plans/2026-06-17-authoritative-agent-goal-source-gate.md
git commit -m "docs: record agent goal source gate"
```

---

### Task 6: Final Verification

**Files:**
- No source changes unless verification exposes a defect.

- [ ] **Step 1: Run focused app tests**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/sync/storageTypes.spec.ts sources/components/agentGoalStatus.spec.ts sources/components/AgentGoalBar.spec.ts sources/components/parseLocalCommandMessage.spec.ts
```

Expected: PASS. This covers schema, source-identity resolver, goal bar rendering, and existing `/goal` chip parsing.

- [ ] **Step 2: Run existing reducer and suggestion regressions**

Run:

```bash
pnpm --filter happy-app exec vitest run sources/sync/reducer/reducer.spec.ts sources/sync/suggestionCommands.spec.ts
```

Expected: PASS. This checks that the new optional `agentGoalStatus` field does not disturb existing agent state processing or slash suggestions.

- [ ] **Step 3: Run app and CLI typechecks**

Run:

```bash
pnpm --filter happy-app run typecheck
pnpm --filter happy run typecheck
```

Expected: PASS for both commands.

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Review final diff**

Run:

```bash
BASE=$(git merge-base fix/mass-fix HEAD)
git diff --stat "$BASE"..HEAD
git diff "$BASE"..HEAD -- packages/happy-app/sources/sync/storageTypes.ts packages/happy-cli/src/api/types.ts packages/happy-app/sources/components/agentGoalStatus.ts packages/happy-app/sources/components/AgentGoalBar.tsx packages/happy-app/sources/-session/SessionView.tsx packages/happy-app/sources/text/_default.ts packages/happy-app/sources/text/translations
```

Expected:

- `agentGoalStatus` exists only as optional encrypted `AgentState`.
- `resolveVisibleAgentGoalStatus` hides inactive, unavailable, disconnected, missing-identity, and identity-mismatched goals.
- `SessionView` renders the bar only through `resolveVisibleAgentGoalStatus`.
- `AgentGoalBar` uses `components.agentGoalBar.*` translation keys instead of hardcoded UI text.
- No Claude or Codex adapter writes active goal state unless Task 5 found a structured authoritative source and a follow-up plan was approved.

- [ ] **Step 6: Commit verification fixes if any were needed**

If verification required code changes, commit only those fixes:

```bash
git add <changed-files>
git commit -m "fix: harden agent goal visibility"
```

If verification passed without changes, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: Phase 1 contract, hidden UI, no transcript inference, missing/incorrect source-identity rejection, action non-optimism, and source gating are covered.
- Intentional gap: Phase 2 adapter wiring is not implemented until a machine-readable Claude or Codex source is proven.
- Type consistency: `AgentGoalStatus`, `AgentGoalStatusSchema`, `agentGoalStatus`, `VisibleAgentGoalStatus`, and `resolveVisibleAgentGoalStatus` use the same property names across tasks.
- Visibility safety: No task creates a current-goal bar from `/goal` user text, command wrappers, local stdout, TodoWrite, or assistant prose.
