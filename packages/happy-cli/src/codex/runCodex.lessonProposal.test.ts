import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
    submit: null as null | ((input: { token: string; proposal: unknown }) => { accepted: boolean }),
    aborted: false,
    token: '',
    requestIds: undefined as string[] | undefined,
    steerText: '',
    emit: null as null | ((event: unknown) => void),
    closeQueue: null as null | (() => void),
    onSend: null as null | (() => Promise<void>),
    onSteer: null as null | (() => Promise<void>),
    proposal: { name: 'Verified recovery' },
    statusProbeFails: false,
    send: vi.fn(),
    startThread: vi.fn(),
    session: {
        sessionId: 'lesson-session', getMetadata: () => ({ path: '/tmp/lesson-test' }),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        onUserMessage: vi.fn(), onFileEvent: vi.fn(), on: vi.fn(), hasTitle: () => true,
        sendSessionEvent: vi.fn(), sendSessionProtocolMessage: vi.fn(), sendSessionMessage: vi.fn(),
        sendTurnLatency: vi.fn(),
        sendStreamDelta: vi.fn(),
        updateMetadata: vi.fn(), updateAgentState: vi.fn(), keepAlive: vi.fn(),
        sendSessionDeath: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}),
        rpcHandlerManager: { registerHandler: vi.fn() },
    },
}));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execSync: vi.fn(() => 'codex 0.140.0') }));
vi.mock('@/utils/MessageQueue2', async (original) => {
    const actual = await original<typeof import('@/utils/MessageQueue2')>();
    return { ...actual, MessageQueue2: class<T> extends actual.MessageQueue2<T> {
        constructor(hash: (mode: T) => string) { super(hash); fixture.closeQueue = () => this.close(); }
        async waitForMessagesAndGetAsString(signal?: AbortSignal) {
            const batch = await super.waitForMessagesAndGetAsString(signal);
            return batch && fixture.requestIds ? { ...batch, requestIds: fixture.requestIds } : batch;
        }
    } };
});
vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: vi.fn() }));
vi.mock('@/persistence', async (original) => ({ ...await original<typeof import('@/persistence')>(), readSettings: vi.fn(async () => ({ machineId: 'machine' })) }));
vi.mock('@/api/api', () => ({ ApiClient: { create: vi.fn(async () => ({ getOrCreateMachine: vi.fn(), getOrCreateSession: vi.fn(async () => ({ id: 'lesson-session' })) })) } }));
vi.mock('@/utils/setupOfflineReconnection', () => ({ setupOfflineReconnection: () => ({ session: fixture.session }) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => ({})) }));
vi.mock('@/checkpoint/checkpointSessionComposition', () => ({ createCheckpointSessionComposition: vi.fn(async () => ({})) }));
vi.mock('@/codex/codexSkills', () => ({ discoverCodexSkillCommands: vi.fn(async () => []) }));
vi.mock('@/aplus/fetchAplusMcpServers', async (original) => ({ ...await original<typeof import('@/aplus/fetchAplusMcpServers')>(), fetchAplusMcpConfigSnapshot: vi.fn(async () => null) }));
vi.mock('@/codex/codexMcpConfigSynchronizer', () => ({ CodexMcpConfigSynchronizer: class { mcpServers = {}; sync = async () => ({ mcpServers: this.mcpServers }); } }));
vi.mock('@/codex/codexMcpRuntimeRecovery', () => ({ CodexMcpRuntimeRecovery: class {
    recoverBeforeTurn = async () => ({ status: 'ready' });
    readStatuses = async () => {
        if (fixture.statusProbeFails) throw new Error('app-server status probe failed');
        return [];
    };
} }));
vi.mock('@/claude/utils/startHappyServer', () => ({ startHappyServer: vi.fn(async (_session, options) => {
    fixture.submit = options.proposeLesson;
    return { url: 'http://127.0.0.1:1', toolNames: ['propose_lesson'], stop: vi.fn() };
}) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn(), warn: vi.fn() } }));
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {
    threadId: string | null = null;
    connect = async () => {};
    disconnect = async () => {};
    steerTurn = async (text: string) => { fixture.steerText = text; await fixture.onSteer?.(); };
    setApprovalHandler = vi.fn();
    setEventHandler = (handler: (event: unknown) => void) => { fixture.emit = handler; };
    supportsGoalActions = () => false;
    hasActiveThread = () => Boolean(this.threadId);
    startThread = async (options: unknown) => { fixture.startThread(options); this.threadId = 'thread'; return { threadId: 'thread', model: 'test' }; };
    abortPreparedTurn = vi.fn();
    abortTurnWithFallback = async () => ({ forcedRestart: false });
    sendTurnAndWait = async (prompt: string, options: unknown) => {
        fixture.send(prompt, options);
        fixture.token = prompt.match(/token="([^"]+)"/)![1];
        expect(fixture.submit?.({ token: fixture.token, proposal: fixture.proposal })).toEqual({ accepted: true });
        await fixture.onSend?.();
        return { aborted: fixture.aborted };
    };
} }));

const signalListeners = new Map<'SIGINT' | 'SIGTERM', Set<(...args: any[]) => void>>();
beforeEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) signalListeners.set(signal, new Set(process.listeners(signal)));
});
afterEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
            if (!signalListeners.get(signal)?.has(listener)) process.removeListener(signal, listener);
        }
    }
    fixture.requestIds = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); fixture.submit = null; fixture.onSend = null; fixture.onSteer = null; fixture.steerText = ''; fixture.statusProbeFails = false; fixture.session.sendTurnLatency.mockReset(); });

// specs/checkpoint-local-history — Codex keeps its process across turns and records the folder
// before dispatch and after the turn, including a turn the provider failed.
describe('Codex local history wiring', () => {
    it.each([[false, false], [true, false], [false, true]])('connects an API input trace to preparation and terminal without changing dispatch (observerFails=%s, steer=%s)', async (observerFails, steer) => {
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        fixture.aborted = false;
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Initial request');
        if (observerFails) fixture.session.sendTurnLatency.mockImplementation(() => { throw new Error('diagnostic failed'); });
        fixture.onSend = async () => {
            if (fixture.send.mock.calls.length === 1) {
                expect(fixture.session.sendTurnLatency).not.toHaveBeenCalled();
                await fixture.session.onUserMessage.mock.calls[0][0]({
                    role: 'user', content: { type: 'text', text: 'Traced input' },
                    meta: { latencyTrace: { version: 1, id: 'f4197a29-55c5-4e65-a5c1-fbdc18e7babe' } },
                });
            } else {
                if (steer) {
                    const handler = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
                    await handler({ text: 'Keep the answer short' });
                }
                try { fixture.emit?.({ type: 'agent_message_delta', item_id: 'item', index: 0, offset: 0, delta: 'OK' }); }
                finally { fixture.closeQueue?.(); }
            }
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(fixture.send).toHaveBeenCalledTimes(2);
        const frames = fixture.session.sendTurnLatency.mock.calls.map(([frame]) => frame);
        expect(frames).toContainEqual(expect.objectContaining({ type: 'turn-latency-progress', phase: 'preparing' }));
        expect(frames).toContainEqual(expect.objectContaining({ type: 'turn-latency-progress', phase: 'completed' }));
        expect(frames).toContainEqual(expect.objectContaining({
            type: 'turn-latency', id: 'f4197a29-55c5-4e65-a5c1-fbdc18e7babe', attribution: steer ? 'coalesced' : 'exclusive', inputCount: steer ? 2 : 1, outcome: 'text',
        }));
        fixture.session.sendTurnLatency.mockReset();
    });

    it.each([['completes', false], ['fails', true]])('records around a turn that %s', async (_label, fails) => {
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        fixture.aborted = false;
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Edit b.html');
        const calls: string[] = [];
        const { createCheckpointSessionComposition } = await import('@/checkpoint/checkpointSessionComposition');
        const agentReader = { guidance: vi.fn(async () => 'checkpoint test guidance'), status: vi.fn(), query: vi.fn() } as never;
        vi.mocked(createCheckpointSessionComposition).mockResolvedValueOnce({
            sandboxConfig: undefined,
            agentReader,
            localHistory: {
                beforeTurn: async () => { calls.push('before'); return { operationId: 'turn-1', checkpointId: 'a'.repeat(40), providerPath: process.cwd() }; },
                afterTurn: async () => { calls.push('after'); },
            },
        });
        fixture.onSend = async () => {
            calls.push('send');
            if (fails) throw new Error('provider unavailable');
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        const { startHappyServer } = await import('@/claude/utils/startHappyServer');
        expect(startHappyServer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ checkpointReader: agentReader }));
        expect(fixture.startThread).toHaveBeenCalledWith(expect.objectContaining({ developerInstructions: expect.stringContaining('checkpoint test guidance') }));
        expect(calls).toEqual(['before', 'send', 'after']);
    });
});

describe('Codex foreground lesson proposal wiring', () => {
    it('preserves durable local-auto request ids through a merged Codex batch', async () => {
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        fixture.aborted = false;
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'First request');
        const { DifficultyRoutingCommitter } = await import('@/difficultyRoutingCommit');
        const commit = vi.spyOn(DifficultyRoutingCommitter.prototype, 'commitApplied');
        let turns = 0;
        fixture.onSend = async () => {
            if (++turns === 1) {
                const receive = fixture.session.onUserMessage.mock.calls[0][0] as (message: unknown) => Promise<unknown>;
                for (const serverMessageId of ['durable-1', 'durable-1', 'durable-2']) {
                    await receive({ serverMessageId, content: { text: 'same content' },
                        meta: { modelSource: 'auto', model: 'gpt-5.6-sol', effort: 'high' } });
                }
            } else fixture.closeQueue?.();
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(commit).toHaveBeenCalledWith(['message:durable-1', 'message:durable-1', 'message:durable-2'], expect.any(String));
    });

    it.each(['high', null])('dispatches the boundary model and exact effort without rollback on provider failure (effort=%s)', async (effort) => {
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        fixture.aborted = false;
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Continue the request');
        const { DifficultyRoutingCommitter } = await import('@/difficultyRoutingCommit');
        vi.spyOn(DifficultyRoutingCommitter.prototype, 'commitApplied').mockReturnValue({ model: 'gpt-5.4', effort });
        fixture.onSend = async () => { throw new Error('provider unavailable after apply'); };
        const discard = vi.spyOn(DifficultyRoutingCommitter.prototype, 'discardPending');
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(fixture.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: 'gpt-5.4', effort: effort ?? undefined }));
        expect(discard).not.toHaveBeenCalled();
    });

    it('does not carry an aborted turn failure into the next turn recovery evidence', async () => {
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'First request');
        let turns = 0;
        fixture.onSend = async () => {
            turns += 1;
            const callId = `command-${turns}`;
            fixture.emit?.({ type: 'exec_command_begin', call_id: callId, command: 'npm test', cwd: '/project' });
            fixture.emit?.({ type: 'exec_command_end', call_id: callId, exit_code: turns === 1 ? 1 : 0, status: 'completed' });
            fixture.aborted = turns === 1;
            if (turns === 1) {
                const receive = fixture.session.onUserMessage.mock.calls[0][0] as (message: unknown) => Promise<unknown>;
                await receive({ content: { text: 'Second request' } });
            } else fixture.closeQueue?.();
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(fixture.send).toHaveBeenCalledTimes(2);
        expect(review.reviewFinishedTurn).toHaveBeenCalledOnce();
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            record: expect.objectContaining({ recoveredFailures: [], userMessages: ['Second request'] }),
        }));
    });

    it('replaces a steered turn token and includes only the accepted correction in its evidence', async () => {
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        const correction = 'No, use the verified recovery procedure instead';
        const corrected = { name: 'Corrected verified procedure' };
        fixture.onSend = async () => {
            const oldToken = fixture.token;
            const steer = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
            await steer({ text: correction });
            const newToken = fixture.steerText.match(/token="([^"]+)"/)?.[1];
            expect(newToken).toBeTruthy();
            expect(newToken).not.toBe(oldToken);
            expect(fixture.submit?.({ token: oldToken, proposal: corrected })).toEqual({ accepted: false });
            expect(fixture.submit?.({ token: newToken!, proposal: corrected })).toEqual({ accepted: true });
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            proposal: corrected, settingsRevision: 9,
            record: expect.objectContaining({ hadPriorAssistantTurn: false, userMessages: ['Recover and verify the failed operation', correction] }),
        }));
    });

    it('does not let a late earlier steer preparation replace the newer steer token', async () => {
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        let release!: (value: { revision: number }) => void;
        let preparing!: () => void;
        const started = new Promise<void>(resolve => { preparing = resolve; });
        const oldPreparation = new Promise<{ revision: number }>(resolve => { release = resolve; });
        let prepares = 0;
        const corrected = { name: 'Latest verified correction' };
        const review = {
            prepareReviewTurn: vi.fn(async () => { if (++prepares === 2) { preparing(); return oldPreparation; } return { revision: 9 }; }),
            reviewFinishedTurn: vi.fn(async () => 'reviewed' as const),
        };
        fixture.onSend = async () => {
            const steer = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
            const older = steer({ text: 'Earlier correction' });
            await started;
            await steer({ text: 'No, apply the latest correction' });
            const token = fixture.steerText.match(/token="([^"]+)"/)![1];
            release({ revision: 9 });
            await older;
            expect(fixture.submit?.({ token, proposal: corrected })).toEqual({ accepted: true });
        };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            proposal: corrected,
            record: expect.objectContaining({ userMessages: ['Recover and verify the failed operation', 'No, apply the latest correction'] }),
        }));
    });

    it('discards an unacknowledged steer proposal when the provider finishes before the steer ACK', async () => {
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        let release!: () => void;
        const ack = new Promise<void>(resolve => { release = resolve; });
        let pendingSteer: Promise<unknown> | undefined;
        fixture.onSteer = () => ack;
        fixture.onSend = async () => {
            const steer = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
            pendingSteer = steer({ text: 'No, revise the procedure' });
            await vi.waitFor(() => expect(fixture.steerText).toContain('token="'));
            const token = fixture.steerText.match(/token="([^"]+)"/)![1];
            expect(fixture.submit?.({ token, proposal: fixture.proposal })).toEqual({ accepted: true });
        };
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'cancelled' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        release();
        await pendingSteer;
        expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({
            signal: expect.objectContaining({ aborted: true }),
            record: expect.objectContaining({ userMessages: ['Recover and verify the failed operation'] }),
        }));
        expect(review.reviewFinishedTurn).not.toHaveBeenCalledWith(expect.objectContaining({ proposal: fixture.proposal }));
    });

    it('does not dispatch a cancelled prompt when explicit abort arrives during lesson preparation', async () => {
        const { DifficultyRoutingCommitter } = await import('@/difficultyRoutingCommit');
        const discard = vi.spyOn(DifficultyRoutingCommitter.prototype, 'discardPending');
        fixture.requestIds = ['cancelled-request', 'merged-request'];
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        const review = {
            prepareReviewTurn: vi.fn(async () => {
                const abort = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'abort')![1] as () => Promise<unknown>;
                await abort();
                return { revision: 9 };
            }),
            reviewFinishedTurn: vi.fn(async () => 'reviewed' as const),
        };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(discard).toHaveBeenCalledWith(['cancelled-request', 'merged-request'], 'cancelled');
        expect(review.prepareReviewTurn).toHaveBeenCalledOnce();
        expect(fixture.send).not.toHaveBeenCalled();
        expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
    });

    it.each(['message', 'steer'])('immediately cancels a pending review when %s input is accepted', async (inputKind) => {
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        let beforeInput: boolean | undefined;
        let afterInput: boolean | undefined;
        const review = {
            prepareReviewTurn: vi.fn(async () => ({ revision: 9 })),
            reviewFinishedTurn: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
                beforeInput = signal.aborted;
                if (inputKind === 'message') {
                    const receive = fixture.session.onUserMessage.mock.calls[0][0] as (message: unknown) => unknown;
                    receive({ content: { text: 'Next user request' } });
                } else {
                    const steer = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
                    await steer({ text: 'Revise the current approach' });
                }
                afterInput = signal.aborted;
                return 'cancelled' as const;
            }),
        };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(beforeInput).toBe(false);
        expect(afterInput).toBe(true);
    });

    it.each([false, true])('passes a staged proposal only on normal completion (aborted=%s)', async (aborted) => {
        fixture.aborted = aborted;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        // Run-once only terminates this harness; the authenticated host supplies the foreground kind.
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(fixture.send).toHaveBeenCalledOnce();
        if (aborted) expect(review.reviewFinishedTurn).not.toHaveBeenCalled();
        else expect(review.reviewFinishedTurn).toHaveBeenCalledWith(expect.objectContaining({ proposal: fixture.proposal, settingsRevision: 9 }));
        expect(fixture.submit?.({ token: fixture.token, proposal: {} })).toEqual({ accepted: false });
    });

    it('still dispatches the turn when the MCP status probe fails', async () => {
        // Status reporting is informational. A rejection from it used to reach
        // the turn's catch, which discards the prompt and reports a crash the
        // Codex process never had.
        fixture.statusProbeFails = true;
        fixture.aborted = false;
        for (const key of Object.keys(process.env)) {
            if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
        }
        vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
        vi.stubEnv('HAPPY_INITIAL_PROMPT', 'Recover and verify the failed operation');
        const review = { prepareReviewTurn: vi.fn(async () => ({ revision: 9 })), reviewFinishedTurn: vi.fn(async () => 'reviewed' as const) };
        const { runCodex } = await import('./runCodex');
        await runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never },
            noSandbox: true, lessons: { turn: null, review, sessionKind: 'foreground' } });
        expect(fixture.send).toHaveBeenCalledOnce();
        expect(review.reviewFinishedTurn).toHaveBeenCalledOnce();
        expect(fixture.session.sendSessionEvent.mock.calls.map(([event]) => event))
            .not.toContainEqual({ type: 'message', message: 'Process exited unexpectedly' });
    });
});
