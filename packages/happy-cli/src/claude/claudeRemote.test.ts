import { createLessonTurnObservations } from '@/memory/lessonTurnObservations';
import { createLessonProposalTurn } from '@/utils/lessonProposalTurn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import * as sandbox from '@/sandbox/claudeProcessSandbox';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('refuses a mandatory session without config before starting the SDK', async () => {
        await expect(claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [],
            sandboxPolicyMode: 'mandatory', sandbox: { enabled: false },
            hookSettingsPath: '/tmp/synthetic-settings.json',
            nextMessage: async () => ({ message: 'synthetic prompt', mode }),
            onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false, onSessionFound: vi.fn(), onThinkingChange: vi.fn(), onMessage: vi.fn(),
        })).rejects.toMatchObject({ name: 'MandatorySandboxError', reason: 'missing-config' });
        expect(query).not.toHaveBeenCalled();
    });

    it('resumes separate-UID Claude state without reading or waiting on its private transcript', async () => {
        const close = vi.fn();
        const prepare = vi.spyOn(sandbox, 'prepareClaudeProcessSandbox').mockResolvedValue({ claudeConfigDir: '/home/agent-sbx/.claude', spawn: vi.fn(), close });
        const found = vi.fn();
        vi.mocked(query).mockReturnValue({ async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'synthetic-resumed', tools: [], slash_commands: [], mcp_servers: [] };
            yield { type: 'result', subtype: 'success' };
        } } as any);
        let count = 0;
        try {
            await claudeRemote({ sessionId: 'synthetic-resume', path: process.cwd(), allowedTools: [], sandboxPolicyMode: 'mandatory',
                hookSettingsPath: '/tmp/synthetic-settings.json', nextMessage: async () => count++ === 0 ? { message: 'synthetic', mode } : null,
                onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
                onSessionFound: found, onThinkingChange: vi.fn(), onMessage: vi.fn() });
            expect(vi.mocked(query).mock.calls[0][0].options?.resume).toBe('synthetic-resume');
            expect(vi.mocked(query).mock.calls[0][0].options?.settingsPath).toBeUndefined();
            expect(found).toHaveBeenCalledWith('synthetic-resumed');
            expect(close).toHaveBeenCalled();
        } finally { prepare.mockRestore(); }
    });

    it('reports that the provider never started when mode switching aborts before the first message', async () => {
        const result = await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => null,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(result).toBe('not-started');
        expect(query).not.toHaveBeenCalled();
    });

    it('recovers a server that died while idle before the next turn starts', async () => {
        const boundaryOrder: string[] = [];
        // 결과 직후 복구는 정상을 보고, 다음 입력을 기다리는 동안 서버가 죽는다.
        const mcpServerStatus = vi.fn()
            .mockResolvedValueOnce([{ name: 'argos', status: 'connected' }])
            .mockResolvedValue([{ name: 'argos', status: 'failed' }]);
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus,
            reconnectMcpServer: vi.fn(async (name: string) => {
                boundaryOrder.push('mcp-recover');
                return { serverName: name, status: 'connected' as const };
            }),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const beforeTurn = vi.fn(async () => { boundaryOrder.push('checkpoint-gate'); });
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            beforeTurn,
            nextMessage: async () => {
                messageCount += 1;
                return messageCount <= 2 ? { message: `hello-${messageCount}`, mode } : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        } as any);

        // result 는 한 번뿐이라 결과 직후 복구도 한 번뿐이고, 그때는 아직
        // connected 였다. 그러므로 재연결이 일어났다는 사실 자체가 다음 턴
        // 시작 전에 복구했다는 증거다.
        await vi.waitFor(() => expect(boundaryOrder).toContain('mcp-recover'));
        expect(beforeTurn).toHaveBeenCalled();
    });

    it('does not dispatch a protected turn when the checkpoint gate fails', async () => {
        const calls: string[] = [];
        vi.mocked(query).mockImplementation(() => {
            calls.push('provider');
            return {
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    yield { type: 'result', subtype: 'success' };
                },
            } as any;
        });
        const beforeTurn = vi.fn(async () => {
            calls.push('gate');
            throw new Error('checkpoint unavailable');
        });
        const options = {
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'edit the project', mode }),
            beforeTurn,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        };

        await expect(claudeRemote(options)).rejects.toThrow('checkpoint unavailable');

        expect(beforeTurn).toHaveBeenCalledOnce();
        expect(query).not.toHaveBeenCalled();
        expect(calls).toEqual(['gate']);
    });

    it('starts the provider with the protected sandbox fixed before its first turn', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };
        const providerPath = '/private/checkpoints/turn-1';

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            sandbox,
            nextMessage: async () => ({ message: 'edit the project', mode }),
            beforeTurn: vi.fn(async () => ({
                operationId: 'turn-1',
                checkpointId: 'a'.repeat(40),
                providerPath,
                claudeSandbox: sandbox,
            })),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(query).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox, cwd: providerPath }),
        }));
    });

    it('closes the protected provider tree before applying and announcing ready', async () => {
        const calls: string[] = [];
        const close = vi.fn(() => calls.push('close'));
        vi.mocked(query).mockReturnValue({
            close,
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);

        const result = await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({ message: 'edit the project', mode }),
            beforeTurn: vi.fn(async () => ({
                operationId: 'turn-1',
                checkpointId: 'a'.repeat(40),
                providerPath: '/private/checkpoints/active-turn',
            })),
            completeTurn: vi.fn(async (quiesceWriters) => {
                await quiesceWriters();
                calls.push('apply');
                return { status: 'completed' as const, entries: [] };
            }),
            onReady: () => calls.push('ready'),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(result).toBe('protected-turn-complete');
        expect(close).toHaveBeenCalledOnce();
        expect(calls).toEqual(['close', 'apply', 'ready']);
    });

    it('does not dispatch an excluded-path retry while protection confirmation is pending', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        let rejectConfirmation!: (reason: Error) => void;
        const confirmation = new Promise<void>((_, reject) => {
            rejectConfirmation = reject;
        });
        const beforeTurn = vi.fn(() => confirmation);
        const options = {
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'retry after the excluded .env write was denied', mode }),
            beforeTurn,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        };

        const running = claudeRemote(options);
        await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledOnce());

        expect(query).not.toHaveBeenCalled();

        rejectConfirmation(new Error('excluded path confirmation cancelled'));
        await expect(running).rejects.toThrow('excluded path confirmation cancelled');
        expect(query).not.toHaveBeenCalled();
    });

    it('does not enqueue a follow-up prompt when its checkpoint gate fails', async () => {
        const deliveredPrompts: unknown[] = [];
        vi.mocked(query).mockImplementation((request) => {
            const prompt = (request.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            return {
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    const initial = await prompt.next();
                    deliveredPrompts.push(initial.value);
                    yield { type: 'result', subtype: 'success' };
                    await prompt.next();
                },
            } as any;
        });
        const beforeTurn = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('follow-up checkpoint unavailable'));
        let messageCount = 0;

        await expect(claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount <= 2
                    ? { message: `message-${messageCount}`, mode }
                    : null;
            },
            beforeTurn,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        })).rejects.toThrow('follow-up checkpoint unavailable');

        expect(beforeTurn).toHaveBeenCalledTimes(2);
        expect(deliveredPrompts).toEqual([
            expect.objectContaining({
                message: expect.objectContaining({ content: 'message-1' }),
            }),
        ]);
    });

    it('returns after the first completed turn without waiting for more automation input', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const nextMessage = vi.fn(async () => ({ message: 'scheduled prompt', mode }));

        const result = await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage,
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(result).toBe('turn-complete');
        expect(nextMessage).toHaveBeenCalledOnce();
    });

    function runOnceWithProviderMessages(
        providerMessages: unknown[],
        provider: { staysOpen?: boolean; backgroundWaitBudgetMs?: number } = {},
    ) {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield* providerMessages;
                // A live provider keeps its stream open while background work runs.
                if (provider.staysOpen) await new Promise(() => undefined);
            },
        } as any);
        const onReady = vi.fn();
        const onMessage = vi.fn();
        const running = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            backgroundWaitBudgetMs: provider.backgroundWaitBudgetMs,
            nextMessage: async () => ({ message: 'scheduled prompt', mode }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
        });
        return { running, onReady, onMessage };
    }

    const backgroundTasks = (tasks: Array<{ task_type: string; ambient?: boolean }>) => ({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: tasks.map((task, index) => ({ task_id: `task-${index}`, description: 'work', ...task })),
    });

    it('keeps an automation run alive until its background agents report back', async () => {
        const finalResult = { type: 'result', subtype: 'success', result: 'saw agents' };
        const { running, onReady, onMessage } = runOnceWithProviderMessages([
            backgroundTasks([{ task_type: 'local_agent' }]),
            { type: 'result', subtype: 'success', result: 'launched' },
            backgroundTasks([]),
            finalResult,
        ]);

        await expect(running).resolves.toBe('turn-complete');
        expect(onMessage).toHaveBeenCalledWith(finalResult);
        expect(onReady).toHaveBeenCalledOnce();
    });

    it('ends an automation run while only background shells or ambient tasks remain', async () => {
        const { running, onMessage } = runOnceWithProviderMessages([
            backgroundTasks([{ task_type: 'local_bash' }, { task_type: 'local_agent', ambient: true }]),
            { type: 'result', subtype: 'success', result: 'launched' },
            { type: 'result', subtype: 'success', result: 'never reached' },
        ]);

        await expect(running).resolves.toBe('turn-complete');
        expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ result: 'never reached' }));
    });

    it('ends an automation run when its background agent never reports back', async () => {
        const launched = { type: 'result', subtype: 'success', result: 'launched' };
        const { running, onReady, onMessage } = runOnceWithProviderMessages([
            backgroundTasks([{ task_type: 'local_agent' }]),
            launched,
        ], { staysOpen: true, backgroundWaitBudgetMs: 20 });

        await expect(running).resolves.toBe('turn-complete');
        expect(onReady).toHaveBeenCalledOnce();
        expect(onMessage.mock.calls.filter(([message]) => message === launched)).toHaveLength(1);
    });

    it('ends an automation run at the result after its agent reported back, even before the level catches up', async () => {
        const { running, onMessage } = runOnceWithProviderMessages([
            backgroundTasks([{ task_type: 'local_agent' }]),
            { type: 'result', subtype: 'success', result: 'launched' },
            { type: 'system', subtype: 'task_notification', task_id: 'task-0', status: 'completed', output_file: '', summary: 'done' },
            { type: 'result', subtype: 'success', result: 'agent read' },
            backgroundTasks([]),
        ], { staysOpen: true, backgroundWaitBudgetMs: 60_000 });

        await expect(running).resolves.toBe('turn-complete');
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ result: 'agent read' }));
    });

    it('ends an automation run whose empty level lands after the result it belongs to', async () => {
        const { running } = runOnceWithProviderMessages([
            backgroundTasks([{ task_type: 'local_agent' }]),
            { type: 'result', subtype: 'success', result: 'launched' },
            { type: 'result', subtype: 'success', result: 'agent read' },
            backgroundTasks([]),
        ], { staysOpen: true, backgroundWaitBudgetMs: 20 });

        await expect(running).resolves.toBe('turn-complete');
    });

    it.each([false, true])('routes stream_event partials even when diagnostics throw: %s', async (diagnosticThrows) => {
        const streamEvent = {
            type: 'stream_event',
            uuid: 'evt-1',
            session_id: 'claude-session',
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        };
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield streamEvent;
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const onMessage = vi.fn();
        const onStreamEvent = vi.fn();
        const onTurnLatency = vi.fn(() => { if (diagnosticThrows) throw new Error('diagnostic unavailable'); });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            exitAfterFirstTurn: true,
            nextMessage: vi.fn(async () => ({
                message: 'hi',
                mode,
                latency: {
                    attribution: 'exclusive' as const,
                    inputCount: 1,
                    traces: [{ id: 'trace-1', receivedAt: 0, queueMs: 1 }],
                },
            })),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onStreamEvent,
            onTurnLatency,
        });

        expect(onStreamEvent).toHaveBeenCalledWith(streamEvent);
        expect(onTurnLatency).toHaveBeenCalledWith(expect.objectContaining({
            id: 'trace-1', attribution: 'exclusive', inputCount: 1, queueMs: 1,
            sdkSubmitMs: expect.any(Number), firstSdkTextMs: expect.any(Number), outcome: 'text',
        }));
        expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stream_event' }));
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result' }));
    });

    it('pushes active-turn input into the running SDK prompt stream', async () => {
        let releaseResult!: () => void;
        const resultGate = new Promise<void>((resolve) => {
            releaseResult = resolve;
        });
        let prompt!: AsyncIterator<unknown>;
        vi.mocked(query).mockImplementation((request) => {
            prompt = (request.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
            return {
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() {
                    await resultGate;
                    yield { type: 'result', subtype: 'success' };
                },
            } as any;
        });
        let activeInputSender: ((text: string) => Promise<boolean>) | null = null;
        let resolveActiveInputSender!: (sender: (text: string) => Promise<boolean>) => void;
        const activeInputSenderReady = new Promise<(text: string) => Promise<boolean>>((resolve) => {
            resolveActiveInputSender = resolve;
        });
        let messageCount = 0;

        const running = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => (
                messageCount++ === 0 ? { message: 'initial request', mode } : null
            ),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onActiveInputReady: (sender) => {
                activeInputSender = sender;
                if (sender) resolveActiveInputSender(sender);
            },
        });

        const sendActiveInput = await activeInputSenderReady;
        expect(await prompt.next()).toMatchObject({
            value: { message: { content: 'initial request' } },
        });
        expect(await sendActiveInput('apply this now')).toBe(true);
        expect(await prompt.next()).toMatchObject({
            value: { message: { content: 'apply this now' } },
        });

        releaseResult();
        await running;
        expect(activeInputSender).toBeNull();
        expect(await sendActiveInput('too late')).toBe(false);
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });
        const onPromptSuggestionChange = vi.fn((suggestion: string | null) => {
            callbackOrder.push(`suggestion:${suggestion ?? 'clear'}`);
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onPromptSuggestionChange,
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['suggestion:clear', 'event:Context was reset', 'reset', 'ready']);
    });

    it('injects worker agents + delegation prompt when HAPPY_WORKER_MODEL is set', async () => {
        const prev = { model: process.env.HAPPY_WORKER_MODEL, effort: process.env.HAPPY_WORKER_EFFORT };
        process.env.HAPPY_WORKER_MODEL = 'haiku';
        process.env.HAPPY_WORKER_EFFORT = 'low';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);

            let count = 0;
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'do the thing', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
                onCompletionEvent: vi.fn(),
                onSessionReset: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.agents?.worker?.model).toBe('haiku');
            expect(options.agents?.worker?.effort).toBe('low');
            expect(options.appendSystemPrompt).toMatch(/delegate/i);
        } finally {
            if (prev.model === undefined) delete process.env.HAPPY_WORKER_MODEL; else process.env.HAPPY_WORKER_MODEL = prev.model;
            if (prev.effort === undefined) delete process.env.HAPPY_WORKER_EFFORT; else process.env.HAPPY_WORKER_EFFORT = prev.effort;
        }
    });

    it('leaves agents undefined when no worker model is set (backward compatible)', async () => {
        const prev = process.env.HAPPY_WORKER_MODEL;
        delete process.env.HAPPY_WORKER_MODEL;
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);

            let count = 0;
            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'hi', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
                onCompletionEvent: vi.fn(),
                onSessionReset: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.agents).toBeUndefined();
        } finally {
            if (prev === undefined) delete process.env.HAPPY_WORKER_MODEL; else process.env.HAPPY_WORKER_MODEL = prev;
        }
    });

    it('instructs the agent to discover connector and runtime MCP tools before browser fallback', async () => {
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail"]';
        process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES = '["argos","gmail"]';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);
            let count = 0;

            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                mcpServers: {
                    happy: { type: 'http', url: 'http://happy.test/mcp' },
                    argos: { type: 'http', url: 'https://argos.test/mcp' },
                },
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'check gmail', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
            });

            const prompt = vi.mocked(query).mock.calls[0][0].options?.appendSystemPrompt;
            expect(prompt).toContain('argos, gmail');
            expect(prompt).toContain('deferred MCP tool discovery');
            expect(prompt).not.toContain('aplus-common');
        } finally {
            delete process.env.HAPPY_APLUS_EXPECTED_CONNECTORS;
            delete process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES;
        }
    });

    it('keeps skill governance and expected MCP service guidance together', async () => {
        const previous = {
            settingSources: process.env.HAPPY_SETTING_SOURCES,
            skillAllowlist: process.env.HAPPY_SKILL_ALLOWLIST,
            connectors: process.env.HAPPY_APLUS_EXPECTED_CONNECTORS,
            mcpServices: process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES,
        };
        process.env.HAPPY_SETTING_SOURCES = 'project,local';
        process.env.HAPPY_SKILL_ALLOWLIST = 'pdf';
        process.env.HAPPY_APLUS_EXPECTED_CONNECTORS = '["gmail"]';
        process.env.HAPPY_APLUS_EXPECTED_MCP_SERVICES = '["argos","gmail"]';
        try {
            vi.mocked(query).mockReturnValue({
                setPermissionMode: vi.fn(),
                mcpServerStatus: vi.fn(async () => []),
                async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; },
            } as any);
            let count = 0;

            await claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/happy-test-settings.json',
                nextMessage: async () => (count++ === 0 ? { message: 'check services', mode } : null),
                onReady: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: vi.fn(),
                onThinkingChange: vi.fn(),
                onMessage: vi.fn(),
            });

            const options = vi.mocked(query).mock.calls[0][0].options!;
            expect(options.settingSources).toEqual(['project', 'local']);
            expect(options.skills).toEqual(['pdf']);
            expect(options.appendSystemPrompt).toContain('argos, gmail');
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                const envKey = key === 'settingSources' ? 'HAPPY_SETTING_SOURCES'
                    : key === 'skillAllowlist' ? 'HAPPY_SKILL_ALLOWLIST'
                    : key === 'connectors' ? 'HAPPY_APLUS_EXPECTED_CONNECTORS'
                    : 'HAPPY_APLUS_EXPECTED_MCP_SERVICES';
                if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
            }
        }
    });

    it('enables prompt suggestions and routes them outside the conversation transcript', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
                yield {
                    type: 'prompt_suggestion',
                    suggestion: '  Run the focused tests  ',
                    uuid: 'suggestion-1',
                    session_id: 'session-1',
                };
            },
        } as any);

        const onMessage = vi.fn();
        const onPromptSuggestionChange = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => (messageCount++ === 0 ? { message: 'implement it', mode } : null),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onPromptSuggestionChange,
        });

        expect(vi.mocked(query).mock.calls[0][0].options?.promptSuggestions).toBe(true);
        expect(onPromptSuggestionChange.mock.calls.map(([value]) => value)).toEqual([
            null,
            'Run the focused tests',
        ]);
        expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt_suggestion' }));
    });

    it('drops a completed-turn suggestion that arrives after the next user input was accepted', async () => {
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
                await Promise.resolve();
                yield {
                    type: 'prompt_suggestion',
                    suggestion: 'Stale previous-turn suggestion',
                    uuid: 'suggestion-1',
                    session_id: 'session-1',
                };
            },
        } as any);

        const onPromptSuggestionChange = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                if (messageCount === 1) return { message: 'first', mode };
                if (messageCount === 2) return { message: 'next', mode };
                return null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onPromptSuggestionChange,
        });

        expect(onPromptSuggestionChange.mock.calls.map(([value]) => value)).toEqual([null, null]);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });

    it('reconnects a server that changes from connected init metadata to failed SDK runtime status', async () => {
        const reconnectMcpServer = vi.fn(async () => {});
        const mcpServerStatus = vi.fn()
            .mockResolvedValueOnce([{
                name: 'argos',
                status: 'failed',
                error: 'connection refused',
            }])
            .mockResolvedValueOnce([{ name: 'argos', status: 'connected' }]);
        const onMcpStatus = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus,
            reconnectMcpServer,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'system',
                    subtype: 'init',
                    mcp_servers: [{ name: 'argos', status: 'connected' }],
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        let messageCount = 0;
        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1 ? { message: 'use argos', mode } : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onMcpStatus,
        });

        expect(mcpServerStatus).toHaveBeenCalled();
        expect(reconnectMcpServer).toHaveBeenCalledOnce();
        expect(reconnectMcpServer).toHaveBeenCalledWith('argos');
        expect(onMcpStatus.mock.calls.map(([status]) => status.status)).toEqual([
            'failed',
            'reconnecting',
            'connected',
        ]);
    });

    it('refreshes MCP config after idle input arrives and before the next turn starts', async () => {
        const setMcpServers = vi.fn(async () => ({ added: ['argos'], removed: [], errors: {} }));
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            setMcpServers,
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
        const onApplied = vi.fn();
        const boundaryOrder: string[] = [];
        const beforeTurn = vi.fn(async () => {
            boundaryOrder.push('checkpoint-gate');
        });
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            beforeTurn,
            nextMessage: async () => {
                boundaryOrder.push('next-message');
                messageCount += 1;
                return messageCount <= 2 ? { message: `hello-${messageCount}`, mode } : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            mcpConfig: {
                baseServers: { happy: { type: 'http', url: 'http://happy.test/mcp' } },
                initialAplusServers: {},
                fetchAplusServers: vi.fn(async () => {
                    boundaryOrder.push('mcp-sync');
                    return {
                        ok: true as const,
                        servers: { argos: { type: 'http' as const, url: 'https://argos.test/mcp' } },
                    };
                }),
                onApplied,
            },
        });

        await vi.waitFor(() => expect(beforeTurn).toHaveBeenCalledTimes(2));
        expect(boundaryOrder.slice(0, 5)).toEqual([
            'next-message',
            'checkpoint-gate',
            'next-message',
            'mcp-sync',
            'checkpoint-gate',
        ]);
        await vi.waitFor(() => {
            expect(setMcpServers).toHaveBeenCalledWith({
                happy: { type: 'http', url: 'http://happy.test/mcp' },
                argos: { type: 'http', url: 'https://argos.test/mcp' },
            });
            expect(onApplied).toHaveBeenCalledOnce();
        });
    });
});

describe('lessons at the provider boundary', () => {
    /*
     * These assert what the SDK is actually handed, not what the source says.
     * The recall/acknowledge wiring is only correct if the emitted user
     * message keeps its attachments, if the block arrives as an extra block,
     * and if acknowledgement waits for the provider to accept the turn — none
     * of which a unit test of the host can see.
     */
    type Turn = { sent: unknown; };

    function providerCapturing(emit: (push: (event: unknown) => void) => Promise<void>) {
        const turns: Turn[] = [];
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                const queued: unknown[] = [];
                const push = (event: unknown) => { queued.push(event); };
                for await (const message of args.prompt) {
                    turns.push({ sent: (message as any).message.content });
                    await emit(push);
                    while (queued.length) yield queued.shift() as any;
                }
            },
        }) as any);
        return turns;
    }

    function baseOptions(overrides: Record<string, unknown>) {
        return {
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            ...overrides,
        } as any;
    }

    const ticket = { id: 'ticket-1' } as any;

    it.each(['/compact', '/review changes'])('preserves native command input with lesson generation enabled (%s)', async command => {
        const proposalTurn = createLessonProposalTurn();
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const turn = { recall: vi.fn(async () => ({ outcome: 'selected' as const, block: 'REFERENCE', ticket })), acknowledge: vi.fn(async () => true) };
        const turns = providerCapturing(async push => { push({ type: 'result', subtype: 'success' }); });
        await claudeRemote(baseOptions({
            exitAfterFirstTurn: true, nextMessage: async () => ({ message: command, mode }),
            lessonProposalTurn: proposalTurn,
            lessons: { sessionId: 'happy-session', sessionKind: 'foreground', review, turn },
        }));
        expect(turns[0].sent).toBe(command);
        expect(review.prepareReviewTurn).not.toHaveBeenCalled();
    });

    it('discards interrupted generation observations before the next generation', async () => {
        const observations = createLessonTurnObservations();
        const review = { reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        providerCapturing(async push => {
            push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'fail', name: 'Bash', input: { command: 'npm test' } }] } });
            push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fail', is_error: true }] } });
            push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'pass', name: 'Bash', input: { command: 'npm test' } }] } });
            push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'pass', is_error: false }] } });
            push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abort', is_error: true }] } });
        });
        const lessons = { sessionId: 'happy-session', sessionKind: 'foreground', observations, review };
        await claudeRemote(baseOptions({ nextMessage: async () => ({ message: 'First request', mode }), lessons, isAborted: (id: string) => id === 'abort' }));
        providerCapturing(async push => { push({ type: 'result', subtype: 'success' }); });
        await claudeRemote(baseOptions({ nextMessage: async () => ({ message: 'Second request', mode }), lessons, exitAfterFirstTurn: true }));
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            record: expect.objectContaining({ agentSummary: '', recoveredFailures: [] }),
        }));
    });

    it('keeps prior-response history and cancels the preceding review across checkpoint generations', async () => {
        const lifecycle = { controller: new AbortController(), completedAssistantTurns: 0 };
        const signals: AbortSignal[] = [];
        const review = { reviewFinishedTurn: vi.fn(async ({ signal }: { signal: AbortSignal }) => { signals.push(signal); return 'reviewed' as const; }) };
        const lessons = { sessionId: 'happy-session', sessionKind: 'foreground', review };
        providerCapturing(async push => { push({ type: 'result', subtype: 'success' }); });
        for (const message of ['First request', 'No, use the corrected procedure']) {
            await claudeRemote(baseOptions({
                nextMessage: async () => ({ message, mode }), lessons, lessonReviewLifecycle: lifecycle,
                completeTurn: async () => ({ status: 'completed', entries: [] }),
            }));
            if (signals.length === 1) expect(signals[0].aborted).toBe(false);
        }
        expect(signals[0].aborted).toBe(true);
        expect(review.reviewFinishedTurn).toHaveBeenLastCalledWith(expect.objectContaining({
            record: expect.objectContaining({ hadPriorAssistantTurn: true }),
        }));
    });

    it('does not count proposing a lesson as evidence for that lesson', async () => {
        const observations = createLessonTurnObservations();
        observations.commandStarted('unverified anonymous command');
        const review = { reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        providerCapturing(async push => {
            push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'proposal', name: 'mcp__happy__propose_lesson', input: {} }] } });
            push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'proposal', is_error: false }] } });
            push({ type: 'result', subtype: 'success' });
        });
        await claudeRemote(baseOptions({
            nextMessage: async () => ({ message: 'No, correct the approach', mode }), exitAfterFirstTurn: true,
            lessons: { sessionId: 'happy-session', sessionKind: 'foreground', observations, review },
        }));
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            record: expect.objectContaining({ agentSummary: '', recoveredFailures: [] }),
        }));
    });

    it('uses the current provider turn to stage a candidate and only passes it after normal completion', async () => {
        const proposalTurn = createLessonProposalTurn();
        const proposal = { name: 'Verified procedure' };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const turns = providerCapturing(async (push) => {
            const text = String(turns[0].sent);
            const token = text.match(/token="([^"]+)"/)![1];
            expect(proposalTurn.submit({ token, proposal })).toEqual({ accepted: true });
            expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
            push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Verified recovery' }] } });
            push({ type: 'result', subtype: 'success' });
        });
        let sent = false;
        await claudeRemote(baseOptions({
            nextMessage: async () => { if (sent) return null; sent = true; return { message: 'Fix the failure', mode }; },
            lessonProposalTurn: proposalTurn,
            lessons: { sessionId: 'happy-session', sessionKind: 'foreground', review },
        }));
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({ proposal, settingsRevision: 4 }));
        expect(proposalTurn.take('anything')).toEqual({});
    });

    it.each(['completed', 'failed'])('starts lesson persistence only after checkpoint apply succeeds (%s)', async (status) => {
        const proposalTurn = createLessonProposalTurn();
        const proposal = { name: 'Verified procedure' };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const turns = providerCapturing(async push => {
            const token = String(turns[0].sent).match(/token="([^"]+)"/)![1];
            proposalTurn.submit({ token, proposal });
            push({ type: 'result', subtype: 'success' });
        });
        const running = claudeRemote(baseOptions({
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'Fix the failure', mode }),
            lessonProposalTurn: proposalTurn,
            lessons: { sessionId: 'happy-session', sessionKind: 'foreground', review },
            completeTurn: async () => {
                expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
                return { status, entries: [] };
            },
        }));
        if (status === 'failed') {
            await expect(running).rejects.toThrow('checkpoint turn apply did not complete');
            expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
        } else {
            await expect(running).resolves.toBe('turn-complete');
            expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({ proposal,
                record: expect.objectContaining({ hadPriorAssistantTurn: false }) }));
        }
    });

    it('discards a proposal when the provider result reports an error', async () => {
        const proposalTurn = createLessonProposalTurn();
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        let token = '';
        const turns = providerCapturing(async (push) => {
            token = String(turns[0].sent).match(/token="([^"]+)"/)![1];
            proposalTurn.submit({ token, proposal: { name: 'Unverified' } });
            push({ type: 'result', subtype: 'error_during_execution', is_error: true });
        });
        let sent = false;
        await claudeRemote(baseOptions({
            nextMessage: async () => { if (sent) return null; sent = true; return { message: 'Fix failure', mode }; },
            lessonProposalTurn: proposalTurn,
            lessons: { sessionId: 'happy-session', sessionKind: 'foreground', review },
        }));
        expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
        expect(proposalTurn.submit({ token, proposal: {} }).accepted).toBe(false);
    });

    it('does not ask automation sessions to propose lessons', async () => {
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'not-eligible' as const) };
        const turns = providerCapturing(async (push) => { push({ type: 'result', subtype: 'success' }); });
        let sent = false;
        await claudeRemote(baseOptions({
            nextMessage: async () => { if (sent) return null; sent = true; return { message: 'Scheduled work', mode }; },
            lessonProposalTurn: createLessonProposalTurn(),
            lessons: { sessionId: 'happy-session', sessionKind: 'automation', review },
        }));
        expect(review.prepareReviewTurn).not.toHaveBeenCalled();
        expect(turns[0].sent).toBe('Scheduled work');
    });

    it('prepends the block without disturbing an attachment, and acknowledges only after the assistant starts', async () => {
        const acknowledged: unknown[] = [];
        const whenAcknowledged: string[] = [];
        const turnHost = {
            recall: vi.fn(async () => ({ outcome: 'selected' as const, block: 'LESSONS', ticket })),
            acknowledge: vi.fn(async (t: unknown) => {
                acknowledged.push(t);
                whenAcknowledged.push('ack');
                return true;
            }),
        };
        const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } };
        const turns = providerCapturing(async (push) => {
            // Queued, and nothing has been yielded to the consumer yet: a
            // message sitting in the provider's input queue is not acceptance.
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(turnHost.acknowledge).not.toHaveBeenCalled();
            whenAcknowledged.push('assistant');
            push({ type: 'assistant', message: { content: [] } });
            push({ type: 'result', subtype: 'success' });
        });

        await claudeRemote(baseOptions({
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: [{ type: 'text', text: 'fix this' }, image], mode }),
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', turn: turnHost },
        }));

        // The recall query is the text, and the attachment is still there.
        expect(turnHost.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'fix this' }));
        expect(turns[0].sent).toEqual([
            { type: 'text', text: 'LESSONS' },
            { type: 'text', text: 'fix this' },
            image,
        ]);
        // Selected is not delivered: the queue push is not acceptance.
        await vi.waitFor(() => expect(acknowledged).toEqual([ticket]));
        expect(whenAcknowledged[0]).toBe('assistant');
    });

    it('sends the message unchanged when nothing was selected', async () => {
        const turns = providerCapturing(async (push) => {
            push({ type: 'result', subtype: 'success' });
        });
        const turnHost = {
            recall: vi.fn(async () => ({ outcome: 'none' as const })),
            acknowledge: vi.fn(async () => true),
        };

        await claudeRemote(baseOptions({
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'plain text turn', mode }),
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', turn: turnHost },
        }));

        expect(turns[0].sent).toBe('plain text turn');
        expect(turnHost.acknowledge).not.toHaveBeenCalled();
    });

    it('does not acknowledge a turn the assistant never began', async () => {
        /*
         * The provider took the message and ended the turn without ever
         * starting an assistant message — a refusal, a mode switch, an error
         * on the way in. Nothing was delivered, so the trace must not say it
         * was.
         */
        const turnHost = {
            recall: vi.fn(async () => ({ outcome: 'selected' as const, block: 'LESSONS', ticket })),
            acknowledge: vi.fn(async () => true),
        };
        providerCapturing(async (push) => {
            push({ type: 'result', subtype: 'success' });
        });

        await claudeRemote(baseOptions({
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'fix this', mode }),
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', turn: turnHost },
        }));

        expect(turnHost.recall).toHaveBeenCalled();
        expect(turnHost.acknowledge).not.toHaveBeenCalled();
    });

    it('recalls active input without replacing the running turn identity or overclaiming delivery', async () => {
        let activeInputSender: ((text: string) => Promise<boolean>) | null = null;
        const proposalTurn = createLessonProposalTurn();
        const proposal = { name: 'Verified correction' };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 4 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const initialTicket = { id: 'initial' } as any;
        const activeTicket = { id: 'active' } as any;
        const turnHost = {
            recall: vi.fn(async ({ query }: { query: string }) => ({
                outcome: 'selected' as const,
                block: query === 'steer toward the migration' ? 'ACTIVE LESSON' : 'INITIAL LESSON',
                ticket: query === 'steer toward the migration' ? activeTicket : initialTicket,
            })),
            acknowledge: vi.fn(async () => true),
        };
        let emitted = 0;
        const turns = providerCapturing(async (push) => {
            emitted += 1;
            push({ type: 'assistant', message: { content: [] } });
            if (emitted === 2) {
                const token = (index: number) => String(turns[index].sent).match(/token="([^"]+)"/)?.[1] ?? '';
                expect(proposalTurn.submit({ token: token(0), proposal }).accepted).toBe(false);
                expect(proposalTurn.submit({ token: token(1), proposal }).accepted).toBe(true);
                push({ type: 'result', subtype: 'success' });
            }
        });

        const running = claudeRemote(baseOptions({
            lessonProposalTurn: proposalTurn,
            nextMessage: (() => {
                let requested = false;
                return async () => {
                    if (requested) return null;
                    requested = true;
                    return { message: 'initial request', mode };
                };
            })(),
            lessons: {
                sessionId: 'happy-session-1', sessionKind: 'foreground', turn: turnHost, review,
            },
            onActiveInputReady: (sender: ((text: string) => Promise<boolean>) | null) => { activeInputSender = sender; },
        }));

        await vi.waitFor(() => expect(activeInputSender).not.toBeNull());
        await vi.waitFor(() => expect(turnHost.acknowledge).toHaveBeenCalledWith(initialTicket));
        expect(await activeInputSender!('steer toward the migration')).toBe(true);
        await running;

        expect(turnHost.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'steer toward the migration' }));
        expect(String(turns[0].sent)).toContain('INITIAL LESSON\n\ninitial request');
        expect(String(turns[1].sent)).toContain('ACTIVE LESSON\n\nsteer toward the migration');
        expect(turnHost.acknowledge).toHaveBeenCalledWith(initialTicket);
        expect(turnHost.acknowledge).not.toHaveBeenCalledWith(activeTicket);
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            proposal, settingsRevision: 4,
            record: expect.objectContaining({ userMessages: ['initial request', 'steer toward the migration'] }),
        }));
    });

    it('does not reopen steering when next-turn recall outlives a provider failure', async () => {
        let releaseRecall!: () => void;
        let markRecallStarted!: () => void;
        const gate = new Promise<void>(resolve => { releaseRecall = resolve; });
        const started = new Promise<void>(resolve => { markRecallStarted = resolve; });
        const readiness: unknown[] = [];
        const turn = {
            recall: vi.fn(async ({ query }: { query: string }) => {
                if (query === 'next primary') { markRecallStarted(); await gate; }
                return { outcome: 'disabled' as const };
            }),
            acknowledge: vi.fn(async () => true),
        };
        vi.mocked(query).mockImplementation((args: any) => ({
            setPermissionMode: vi.fn(), mcpServerStatus: vi.fn(async () => []),
            async *[Symbol.asyncIterator]() {
                await args.prompt[Symbol.asyncIterator]().next();
                yield { type: 'assistant', message: { content: [] } };
                yield { type: 'result', subtype: 'success' };
                await started;
                throw new Error('provider failed');
            },
        }) as any);
        let index = 0;
        const prompts = ['initial request', 'next primary'];
        const running = claudeRemote(baseOptions({
            nextMessage: async () => index < prompts.length ? { message: prompts[index++], mode } : null,
            lessons: { sessionId: 's', sessionKind: 'foreground', turn },
            onActiveInputReady: (value: unknown) => { readiness.push(value); },
        })).catch(error => error.message);
        expect(await running).toBe('provider failed');
        const updatesAtExit = readiness.length;
        releaseRecall();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(readiness).toHaveLength(updatesAtExit);
        expect(readiness.at(-1)).toBeNull();
    });

    it('keeps steering closed until the next primary prompt finishes recall', async () => {
        let sender: ((text: string) => Promise<boolean>) | null = null;
        let releaseRecall!: () => void;
        const gate = new Promise<void>(resolve => { releaseRecall = resolve; });
        const turn = {
            recall: vi.fn(async ({ query }: { query: string }) => {
                if (query === 'next primary') await gate;
                return { outcome: 'disabled' as const };
            }),
            acknowledge: vi.fn(async () => true),
        };
        const turns = providerCapturing(async push => {
            push({ type: 'assistant', message: { content: [] } });
            push({ type: 'result', subtype: 'success' });
        });
        let index = 0;
        const prompts = ['initial request', 'next primary'];
        const running = claudeRemote(baseOptions({
            nextMessage: async () => index < prompts.length ? { message: prompts[index++], mode } : null,
            lessons: { sessionId: 's', sessionKind: 'foreground', turn },
            onActiveInputReady: (value: typeof sender) => { sender = value; },
        }));
        await vi.waitFor(() => expect(turn.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'next primary' })));
        const senderDuringPreparation = sender;
        releaseRecall();
        await running;
        expect(senderDuringPreparation).toBeNull();
        expect(turns.map(value => value.sent)).toEqual(prompts);
    });

    it.each([['recall', 'result'], ['proposal', 'result'], ['recall', 'session-cancel'], ['proposal', 'session-cancel']])('rejects a steer whose %s preparation finishes after %s', async (phase, boundary) => {
        const lifecycle = { controller: new AbortController(), completedAssistantTurns: 0 };
        let activeInputSender: ((text: string) => Promise<boolean>) | null = null;
        let finishRecall!: () => void;
        const recallGate = new Promise<void>((resolve) => { finishRecall = resolve; });
        const initialTicket = { id: 'initial' } as any;
        const turnHost = {
            recall: vi.fn(async ({ query }: { query: string }) => {
                if (phase === 'recall' && query === 'late steer') await recallGate;
                return { outcome: 'selected' as const, block: 'LESSON', ticket: initialTicket };
            }),
            acknowledge: vi.fn(async () => true),
        };
        const proposalTurn = createLessonProposalTurn();
        const begin = vi.spyOn(proposalTurn, 'begin');
        let prepared = 0;
        const review = {
            prepareReviewTurn: vi.fn(async () => {
                prepared += 1;
                if (phase === 'proposal' && prepared === 2) await recallGate;
                return { revision: 1 };
            }),
            reviewFinishedTurn: vi.fn(async () => 'no-lesson' as const),
        };
        let releaseResult!: () => void;
        const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
        providerCapturing(async (push) => {
            push({ type: 'assistant', message: { content: [] } });
            await resultGate;
            push({ type: 'result', subtype: 'success' });
        });
        let requested = false;
        const running = claudeRemote(baseOptions({
            nextMessage: async () => {
                if (requested) return null;
                requested = true;
                return { message: 'initial request', mode };
            },
            lessonProposalTurn: proposalTurn,
            lessonReviewLifecycle: lifecycle,
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', turn: turnHost, review },
            onActiveInputReady: (sender: ((text: string) => Promise<boolean>) | null) => { activeInputSender = sender; },
        }));

        await vi.waitFor(() => expect(activeInputSender).not.toBeNull());
        const accepted = activeInputSender!('late steer');
        await vi.waitFor(() => expect(turnHost.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'late steer' })));
        if (phase === 'proposal') await vi.waitFor(() => expect(review.prepareReviewTurn).toHaveBeenCalledTimes(2));
        if (boundary === 'session-cancel') {
            lifecycle.controller.abort();
            proposalTurn.cancel();
            finishRecall();
            const wasAccepted = await accepted;
            releaseResult();
            await running;
            expect(wasAccepted).toBe(false);
        } else {
            releaseResult();
            await vi.waitFor(() => expect(activeInputSender).toBeNull());
            finishRecall();
            await expect(accepted).resolves.toBe(false);
            await running;
        }
        expect(begin).toHaveBeenCalledOnce();
        expect(turnHost.recall).toHaveBeenCalledWith(expect.objectContaining({ query: 'late steer' }));
    });

    it('does not review a turn the provider ended with an error', async () => {
        const review = { reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        providerCapturing(async (push) => {
            push({ type: 'result', subtype: 'error_during_execution', is_error: true });
        });

        await claudeRemote(baseOptions({
            exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'do the thing', mode }),
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', review },
        }));

        // A turn that failed carries no verified procedure, so it must not be
        // paid for either.
        expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
    });

    it('propagates caller cancellation to lesson recall and background review', async () => {
        const controller = new AbortController();
        const signals: AbortSignal[] = [];
        const turn = {
            recall: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                signals.push(signal);
                return { outcome: 'disabled' as const };
            }),
            acknowledge: vi.fn(async () => true),
        };
        const review = {
            reviewFinishedTurn: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                signals.push(signal);
                return 'reviewed' as const;
            }),
        };
        providerCapturing(async push => { push({ type: 'result', subtype: 'success' }); });
        await claudeRemote(baseOptions({
            signal: controller.signal, exitAfterFirstTurn: true,
            nextMessage: async () => ({ message: 'initial request', mode }),
            lessons: { sessionId: 's', sessionKind: 'foreground', turn, review },
        }));
        expect(signals).toHaveLength(2);
        controller.abort();
        expect(signals.every(signal => signal.aborted)).toBe(true);
    });

    it('aborts a review still running when the next input arrives', async () => {
        const signals: AbortSignal[] = [];
        const review = {
            reviewFinishedTurn: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                signals.push(signal);
                return 'reviewed' as const;
            }),
        };
        providerCapturing(async (push) => {
            push({ type: 'result', subtype: 'success' });
        });
        let sent = 0;

        await claudeRemote(baseOptions({
            nextMessage: async () => {
                sent += 1;
                return sent <= 2 ? { message: `turn-${sent}`, mode } : null;
            },
            lessons: { sessionId: 'happy-session-1', sessionKind: 'foreground', review },
        }));

        await vi.waitFor(() => expect(signals.length).toBeGreaterThanOrEqual(2));
        // The first turn's review is not allowed to keep spending once the
        // conversation has moved on.
        expect(signals[0].aborted).toBe(true);
    });
});


describe('claudeRemote channel-origin slash handling', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
        vi.mocked(query).mockReturnValue({
            setPermissionMode: vi.fn(),
            mcpServerStatus: vi.fn(async () => []),
            reconnectMcpServer: vi.fn(),
            async *[Symbol.asyncIterator]() {
                yield { type: 'result', subtype: 'success' };
            },
        } as any);
    });

    /**
     * Saycode specs/desktop-messenger-channels R9/R11.
     *
     * This parser is a *second* one, separate from `runClaude.onUserMessage`. A channel turn
     * reaches the queue through the session's own RPC and never passes through that handler, but
     * it does arrive here — and here `/clear` calls `onSessionReset` and returns before the
     * provider sees anything. Gating only the first parser leaves an external sender able to wipe
     * a session's context with seven characters.
     */
    it('does not reset the session when a channel turn is the literal text /clear', async () => {
        const onSessionReset = vi.fn();
        await claudeRemote({
            prepareChannelExecution: async () => true,
            beginChannelExecution: () => true,
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: vi.fn()
                .mockResolvedValueOnce({ message: '/clear', mode, channelRequestId: 'core-req-1' })
                .mockResolvedValue(null),
            onReady: vi.fn(),
            onSessionReset,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(onSessionReset).not.toHaveBeenCalled();
        // It went to the provider as ordinary input instead.
        expect(query).toHaveBeenCalled();
    });

    it('still resets the session for an in-app /clear', async () => {
        const onSessionReset = vi.fn();
        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: vi.fn()
                .mockResolvedValueOnce({ message: '/clear', mode })
                .mockResolvedValue(null),
            onReady: vi.fn(),
            onSessionReset,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(onSessionReset).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
    });

    it('does not treat a channel /compact as a compaction request', async () => {
        const onCompletionEvent = vi.fn();
        await claudeRemote({
            prepareChannelExecution: async () => true,
            beginChannelExecution: () => true,
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: vi.fn()
                .mockResolvedValueOnce({ message: '/compact', mode, channelRequestId: 'core-req-2' })
                .mockResolvedValue(null),
            onReady: vi.fn(),
            onCompletionEvent,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
        });

        expect(onCompletionEvent).not.toHaveBeenCalledWith('Compaction started');
    });
});


it('rechecks channel cancellation after checkpoint preparation and never starts the provider', async () => {
    let allowed = true;
    const beginChannelExecution = vi.fn(() => allowed);
    vi.mocked(query).mockClear();
    const result = await claudeRemote({
        sessionId: null, path: process.cwd(), allowedTools: [],
        hookSettingsPath: '/tmp/happy-test-settings.json',
        nextMessage: async () => ({ message: 'cancelled work', mode, channelRequestId: 'r1' }),
        beforeTurn: async () => { await Promise.resolve(); allowed = false; },
        prepareChannelExecution: async () => true,
        beginChannelExecution,
        onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any,
        isAborted: () => false, onSessionFound: vi.fn(), onThinkingChange: vi.fn(), onMessage: vi.fn(),
    });
    expect(beginChannelExecution).toHaveBeenCalledWith('r1');
    expect(result).toBe('not-started');
    expect(query).not.toHaveBeenCalled();
});
