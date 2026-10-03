import { describe, expect, it, vi } from 'vitest';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import type { Session } from './session';
import type { EnhancedMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: vi.fn(),
}));

describe('Claude model changes across provider restarts', () => {
    it('reports a routing epoch reset only when the queued clear resets the provider session', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const clearSessionId = vi.fn(() => { void handlers.get('switch')!(); });
        const onSessionReset = vi.fn(() => {
            expect(clearSessionId).toHaveBeenCalledOnce();
        });
        const client = {
            sessionId: 'clear-epoch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        queue.pushIsolated('/clear', { permissionMode: 'default', model: 'claude-sonnet-5' });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), clearSessionId, onSessionReset,
        } as unknown as Session;
        expect(onSessionReset).not.toHaveBeenCalled();
        await claudeRemoteLauncher(session);
        expect(onSessionReset).toHaveBeenCalledOnce();
    });

    it.each(['model', 'effort', 'boundary-model', 'boundary-effort'] as const)('applies consecutive %s changes at the SDK boundary', async (field) => {
        const modes: EnhancedMode[] = field.endsWith('model')
            ? ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-opus-5'].map(model => ({ permissionMode: 'default', model }))
            : ['low', 'high', 'medium', 'medium'].map(effort => ({ permissionMode: 'default', model: 'claude-opus-5', effort: effort as EnhancedMode['effort'] }));
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const received: Array<{ text: unknown; model: Options['model']; effort: Options['effort'] }> = [];
        const launches: Options[] = [];
        const boundary = field.startsWith('boundary-');
        const resolveMode = () => boundary ? { model: modes[received.length].model!, effort: modes[received.length].effort ?? null } : null;
        const onModeApplied = vi.fn((_ids: string[] | undefined, _executionId: string) => resolveMode());
        const onModeResolved = vi.fn(resolveMode);
        const queuedMode = (index: number) => boundary ? modes[0] : modes[index];
        let metadata: Record<string, any> = {};
        const snapshots: any[] = [];
        const client = {
            sessionId: 'model-switch-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn((update) => {
                metadata = update(metadata);
                if (metadata.claudeBackgroundTasks) snapshots.push(metadata.claudeBackgroundTasks);
            }), getMetadata: () => metadata,
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const generation = launches.length;
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
                    received.push({ text: message.message.content, model: options?.model, effort: options?.effort });
                    yield { type: 'system', subtype: 'background_tasks_changed', tasks: [
                        { task_id: `bg-${generation}`, task_type: 'local_bash', description: 'server' },
                        { task_id: 'watcher', task_type: 'local_bash', description: 'watch', ambient: true },
                    ] };
                    if (generation > 1) {
                        // No task_notification: the full empty snapshot must clear it.
                        yield { type: 'system', subtype: 'background_tasks_changed', tasks: [] };
                        // Bookends may arrive after a newer full snapshot; do not resurrect it.
                        yield { type: 'system', subtype: 'task_started', task_id: `bg-${generation}`, description: 'server' };
                    }
                    yield { type: 'result', subtype: 'success' , result: '', is_error: false, uuid: `result-${received.length}` };
                    if (received.length === modes.length) {
                        void handlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${received.length}`, queuedMode(received.length), undefined, [`req-${received.length}`]);
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', queuedMode(0), undefined, ['req-0']);
        const lessonReviewLifecycle = { controller: new AbortController(), completedAssistantTurns: 0 };
        const cancelLessonReview = vi.fn(() => lessonReviewLifecycle.controller.abort());
        const guidance = vi.fn(async () => 'checkpoint test guidance');
        const session = {
            checkpointComposition: { agentReader: { guidance } },
            lessonReviewLifecycle, cancelLessonReview,
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(), onModeApplied, onModeResolved,
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(received).toEqual(modes.map((mode, index) => ({ text: `turn-${index}`, model: mode.model, effort: mode.effort })));
        expect(launches).toHaveLength(3);
        expect(guidance).toHaveBeenCalledTimes(3);
        for (const launch of launches) expect(launch.systemPrompt).toMatchObject({ append: expect.stringContaining('checkpoint test guidance') });
        expect(onModeApplied.mock.calls.map(([ids]) => ids)).toEqual(modes.map((_, i) => [`req-${i}`]));
        expect(new Set(onModeApplied.mock.calls.map(([, id]) => id)).size).toBe(modes.length);
        expect(snapshots.filter(s => s.tasks === null && s.available).length).toBeGreaterThanOrEqual(3);
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: true }));
        expect(snapshots).toContainEqual(expect.objectContaining({ tasks: [{ taskId: 'bg-1', label: 'server', kind: 'shell' }], available: false }));
        expect(snapshots.at(-1)).toEqual(expect.objectContaining({ tasks: [], available: false }));
        expect(lessonReviewLifecycle.completedAssistantTurns).toBe(modes.length);
        expect(cancelLessonReview).toHaveBeenCalled();
        expect(lessonReviewLifecycle.controller.signal.aborted).toBe(true);
        expect(client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Process exited unexpectedly' }));
    });

    it('records turn latency for a turn held back behind a provider restart', async () => {
        const queue = new MessageQueue2<EnhancedMode>(hashObject);
        const handlers = new Map<string, () => Promise<unknown>>();
        const modes: EnhancedMode[] = ['claude-sonnet-5', 'claude-opus-5'].map(model => ({ permissionMode: 'default', model }));
        const launches: Options[] = [];
        let received = 0;
        const client = {
            sessionId: 'restart-latency-test',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<unknown>) => handlers.set(name, handler) },
            updateAgentState: vi.fn(), updateMetadata: vi.fn(), getMetadata: () => ({}),
            sendClaudeSessionMessage: vi.fn(), sendStreamDelta: vi.fn(), sendTurnLatency: vi.fn(),
            setPendingTurnRequestId: vi.fn(), sendFinalAnswerForChannelTurn: vi.fn(),
            applyClaudeTurnResult: vi.fn(), closeClaudeSessionTurn: vi.fn(), sendSessionEvent: vi.fn(),
        };
        vi.mocked(query).mockImplementation(({ prompt, options }) => {
            launches.push(options!);
            const response = (async function* () {
                yield { type: 'system', subtype: 'init', session_id: '', tools: [], mcp_servers: [] };
                for await (const _message of prompt as AsyncIterable<SDKUserMessage>) {
                    received++;
                    yield { type: 'result', subtype: 'success', result: '', is_error: false, uuid: `result-${received}` };
                    if (received === modes.length) {
                        void handlers.get('switch')!();
                        return;
                    }
                    queue.push(`turn-${received}`, modes[received], undefined, undefined, { id: `trace-${received}`, receivedAt: performance.now() });
                }
            })();
            return Object.assign(response, { mcpServerStatus: async () => [], setPermissionMode: async () => {} }) as unknown as ReturnType<typeof query>;
        });
        queue.push('turn-0', modes[0], undefined, undefined, { id: 'trace-0', receivedAt: performance.now() });
        const session = {
            lessonReviewLifecycle: { controller: new AbortController(), completedAssistantTurns: 0 },
            cancelLessonReview: vi.fn(),
            sessionId: null, path: process.cwd(), queue, client, mcpServers: {},
            api: { push: () => ({ sendSessionNotification: vi.fn() }) },
            consumeOneTimeFlags: vi.fn(), onThinkingChange: vi.fn(),
        } as unknown as Session;
        await claudeRemoteLauncher(session);
        expect(launches).toHaveLength(2);
        expect(client.sendTurnLatency.mock.calls.map(([diagnostic]) => diagnostic.id)).toEqual(['trace-0', 'trace-1']);
    });
});
