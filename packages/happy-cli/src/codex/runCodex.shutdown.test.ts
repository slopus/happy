import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
    submit: null as null | ((input: { token: string; proposal: unknown }) => { accepted: boolean }),
    aborted: false,
    token: '',
    steerText: '',
    emit: null as null | ((event: unknown) => void),
    closeQueue: null as null | (() => void),
    onInterrupt: null as null | (() => void),
    onSend: null as null | (() => Promise<void>),
    onSteer: null as null | (() => Promise<void>),
    onConnect: null as null | (() => Promise<void>),
    onResumeThread: null as null | (() => Promise<void>),
    proposal: { name: 'Verified recovery' },
    gate: null as import('../sessionDrain/runtimeProducerGate').RuntimeProducerGate | null,
    events: [] as string[],
    markDispatched: null as null | (() => void),
    send: vi.fn(),
    recoverMcp: vi.fn(async (_input: { includeRuntimeStatuses?: boolean }): Promise<import('./codexMcpRuntimeRecovery').CodexMcpRecoveryResult> => ({ status: 'ready', affectedServers: [] })),
    readMcpStatuses: vi.fn(async (): Promise<import('@slopus/happy-wire').McpRuntimeServerStatus[]> => []),
    getOrCreateSession: vi.fn(async () => ({ id: 'lesson-session' })),
    disconnect: vi.fn(async () => {}),
    admitTool: undefined as undefined | (<T>(work: () => Promise<T>) => Promise<T>),
    reconnect: vi.fn(async () => ({})),
    session: {
        tracksShutdownStorage: true,
        flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })),
        isStorageConfirmationCurrent: vi.fn(() => true),
        canFreezeInboundMessagesForShutdown: () => true, freezeInboundMessagesForShutdown: vi.fn(() => true),
        awaitMessageAck: vi.fn(async () => ({ ok: true })),
        waitForStorageCapacity: async () => {}, markStorageOutputIncomplete: vi.fn(),
        sessionId: 'lesson-session', getMetadata: () => ({ path: '/tmp/lesson-test', mcpServers: [{ name: 'cached-server', status: 'connected' }] }),
        drainAttachmentsForUserMessage: vi.fn(async () => []),
        onUserMessage: vi.fn(), onFileEvent: vi.fn(), on: vi.fn(), hasTitle: () => true,
        sendSessionEvent: vi.fn(), sendSessionProtocolMessage: vi.fn(), sendSessionMessage: vi.fn(),
        updateMetadata: vi.fn(), updateAgentState: vi.fn(), keepAlive: vi.fn(() => { fixture.events.push('keepAlive'); }),
        sendSessionDeath: vi.fn(), flush: vi.fn(async () => {}), close: vi.fn(async () => {}),
        rpcHandlerManager: { registerHandler: vi.fn() },
    },
}));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execSync: vi.fn(() => 'codex 0.140.0') }));
vi.mock('@/utils/MessageQueue2', async (original) => {
    const actual = await original<typeof import('@/utils/MessageQueue2')>();
    return { ...actual, MessageQueue2: class<T> extends actual.MessageQueue2<T> {
        constructor(hash: (mode: T) => string) { super(hash); fixture.closeQueue = () => this.close(); }
    } };
});
vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: vi.fn() }));
vi.mock('@/persistence', async (original) => ({ ...await original<typeof import('@/persistence')>(), readSettings: vi.fn(async () => ({ machineId: 'machine' })) }));
vi.mock('@/api/api', () => ({ ApiClient: { create: vi.fn(async () => ({ getOrCreateMachine: vi.fn(), getOrCreateSession: fixture.getOrCreateSession })) } }));
vi.mock('@/utils/setupOfflineReconnection', () => ({ setupOfflineReconnection: () => ({ session: fixture.session }) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: vi.fn(async () => ({})) }));
vi.mock('@/checkpoint/checkpointSessionComposition', () => ({ createCheckpointSessionComposition: vi.fn(async () => ({})) }));
vi.mock('@/codex/codexSkills', () => ({ discoverCodexSkillCommands: vi.fn(async () => []) }));
vi.mock('@/aplus/fetchAplusMcpServers', async (original) => ({ ...await original<typeof import('@/aplus/fetchAplusMcpServers')>(), fetchAplusMcpConfigSnapshot: vi.fn(async () => null) }));
vi.mock('@/codex/codexMcpConfigSynchronizer', () => ({ CodexMcpConfigSynchronizer: class { mcpServers = {}; sync = async () => ({ mcpServers: this.mcpServers }); } }));
vi.mock('@/codex/codexMcpRuntimeRecovery', () => ({ CodexMcpRuntimeRecovery: class { recoverBeforeTurn = fixture.recoverMcp; readStatuses = fixture.readMcpStatuses; } }));
vi.mock('@/claude/utils/startHappyServer', () => ({ startHappyServer: vi.fn(async (_session, options) => {
    fixture.submit = options.proposeLesson;
    fixture.admitTool = options.admitTool;
    return { url: 'http://127.0.0.1:1', toolNames: ['propose_lesson'], stop: vi.fn(() => { fixture.events.push('mcpStopped'); }) };
}) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn(), warn: vi.fn() } }));
vi.mock('@/codex/codexAppServerClient', () => ({ CodexAppServerClient: class {
    setTurnDispatchHandler = (handler: () => void) => { fixture.markDispatched = handler; };
    setOutputStorageGate = vi.fn();
    freezeInputForShutdown = () => true;
    interruptTurn = async () => { fixture.onInterrupt?.(); };
    endInputAndAwaitExit = async () => ({ exited: true, code: 0, signal: null });
    waitForOutputDrain = async () => {};
    cancelOutputDrain = () => {};
    finishShutdownObservation = () => {};
    clearThreadState = vi.fn();
    authRecoverySource = 'cli-login';
    authRecoveryBusy = false;
    reconnectForAuth = fixture.reconnect;
    threadId: string | null = null;
    connect = async () => { await fixture.onConnect?.(); };
    resumeThread = async ({ threadId }: { threadId: string }) => { await fixture.onResumeThread?.(); return { threadId, model: 'test' }; };
    disconnect = fixture.disconnect;
    steerTurn = async (text: string) => { fixture.steerText = text; await fixture.onSteer?.(); };
    setApprovalHandler = vi.fn();
    setEventHandler = (handler: (event: unknown) => void) => { fixture.emit = handler; };
    supportsGoalActions = () => false;
    hasActiveThread = () => Boolean(this.threadId);
    startThread = async () => { this.threadId = 'thread'; return { threadId: 'thread', model: 'test' }; };
    abortPreparedTurn = vi.fn();
    abortTurnWithFallback = async () => ({ forcedRestart: false });
    sendTurnAndWait = async (prompt: string) => {
        fixture.send(prompt);
        fixture.markDispatched?.();
        await fixture.onSend?.();
        return { aborted: fixture.aborted };
    };
} }));

vi.mock('../sessionDrain/runtimeProducerGate', async (original) => {
    const actual = await original<typeof import('../sessionDrain/runtimeProducerGate')>();
    return { RuntimeProducerGate: class extends actual.RuntimeProducerGate {
        constructor(ports: ConstructorParameters<typeof actual.RuntimeProducerGate>[0]) { super(ports); fixture.gate = this; }
        override endTurn() { fixture.events.push('endTurn'); super.endTurn(); }
        override loopExited() { fixture.events.push('loopExited'); super.loopExited(); }
    } };
});
import { ApiClient } from '@/api/api';
import { StandaloneLaunchControl } from '../daemon/standaloneLaunchControl';
import type { StandaloneLaunchBootstrap } from '../daemon/standaloneLaunchProtocol';
import { SessionDrain, type DrainReceipt } from '../sessionDrain/sessionDrain';
import { CodexAuthRecovery } from './codexAuthRecovery';
import { logger } from '@/ui/logger';
const originalSignals = new Map<string, Function[]>();
const originalExitCode = process.exitCode;
beforeEach(() => { for (const signal of ['SIGINT', 'SIGTERM'] as const) originalSignals.set(signal, process.listeners(signal)); });
afterEach(() => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
            if (!originalSignals.get(signal)?.includes(listener)) process.removeListener(signal, listener);
        }
    }
});
afterEach(() => { process.exitCode = originalExitCode; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); fixture.onSend = null; fixture.onInterrupt = null; fixture.onSteer = null; fixture.onConnect = null; fixture.onResumeThread = null; fixture.steerText = ''; fixture.gate = null; fixture.events = []; fixture.session.freezeInboundMessagesForShutdown.mockReturnValue(true); });
afterEach(() => { fixture.recoverMcp.mockReset().mockResolvedValue({ status: 'ready', affectedServers: [] }); fixture.readMcpStatuses.mockReset().mockResolvedValue([]); });
async function start(prompt = 'Test input', confirmed = false, review?: import('@/memory/lessonReviewWorker').LessonReviewWorker, standaloneLaunch?: StandaloneLaunchBootstrap, resumeThreadId?: string) {
    for (const key of Object.keys(process.env)) {
        if (/^(HAPPY_RECONNECT_|HAPPY_INITIAL_|HAPPY_FORK|HAPPY_MANAGED_|SAYCODE_PROVIDER_|HAPPY_AUTOMATION_)/.test(key)) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('HAPPY_INITIAL_PROMPT', prompt);
    if (confirmed) { vi.stubEnv('HAPPY_MANAGED_REQUIRE_PROMPT_ACK', '1'); vi.stubEnv('HAPPY_INITIAL_PROMPT_LOCAL_ID', 'test-ack'); }
    vi.stubEnv('HAPPY_AUTOMATION_RUN_ONCE', '1');
    const { runCodex } = await import('./runCodex');
    return runCodex({ principal: { kind: 'account', credentials: { token: 'test-token' } as never }, noSandbox: true, ...(resumeThreadId ? { resumeThreadId } : {}), ...(standaloneLaunch ? { standaloneLaunch, startedBy: 'daemon' as const } : {}), ...(review ? { lessons: { turn: null, review, sessionKind: 'foreground' as const } } : {}) });
}
async function finishFrozenFixture(running: Promise<void>) {
    await vi.waitFor(() => expect(fixture.events).toContain('loopExited'));
    // Production confirmation belongs to SessionDrain; these tests only
    // exercise a directly frozen fixture and release it after their assertions.
    fixture.gate!.confirmShutdownStorage();
    await running;
}
describe('Codex runtime producer bookkeeping', () => {
    it('publishes same-turn MCP recovery metadata without a second pre-turn status query', async () => {
        const statuses = [{ name: 'notion', status: 'connected' as const, checkedAt: 5 }];
        fixture.recoverMcp.mockResolvedValue({ status: 'ready', affectedServers: [], runtimeStatuses: statuses });
        await start();
        expect(fixture.recoverMcp).toHaveBeenCalledOnce();
        expect(fixture.recoverMcp.mock.calls[0]?.[0]).toMatchObject({ includeRuntimeStatuses: true });
        expect(fixture.readMcpStatuses).not.toHaveBeenCalled();
        expect(fixture.send).toHaveBeenCalledOnce();
        const updates = fixture.session.updateMetadata.mock.calls.map(([update]) => update({}));
        expect(updates).toContainEqual({ mcpServers: statuses });
    });

    it('keeps manual MCP status requests fresh even after pre-turn metadata reuse', async () => {
        fixture.recoverMcp.mockResolvedValue({ status: 'ready', affectedServers: [], runtimeStatuses: [{ name: 'notion', status: 'connected', checkedAt: 5 }] });
        const fresh = [{ name: 'notion', status: 'connector-needs-auth' as const, checkedAt: 6 }];
        fixture.readMcpStatuses.mockResolvedValue(fresh);
        let reply: unknown;
        let readsBeforeManualRequest = -1;
        fixture.onSend = async () => {
            readsBeforeManualRequest = fixture.readMcpStatuses.mock.calls.length;
            const handler = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'mcp-status')![1] as (params: unknown) => Promise<unknown>;
            reply = await handler({ sessionId: 'lesson-session' });
        };
        await start();
        expect(readsBeforeManualRequest).toBe(0);
        expect(reply).toEqual({ statuses: fresh });
        expect(fixture.readMcpStatuses).toHaveBeenCalledOnce();
        expect(fixture.send).toHaveBeenCalledOnce();
    });

    it('falls back to fresh status reporting when recovery supplied no valid snapshot', async () => {
        const fresh = [{ name: 'notion', status: 'reconnecting' as const, checkedAt: 5 }];
        fixture.readMcpStatuses.mockResolvedValue(fresh);
        await start();
        expect(fixture.readMcpStatuses).toHaveBeenCalledOnce();
        expect(fixture.send).toHaveBeenCalledOnce();
        expect(fixture.session.updateMetadata.mock.calls.map(([update]) => update({}))).toContainEqual({ mcpServers: fresh });
    });

    // The daemon spawns the CLI with stdio ignored, so a start failure that only
    // reaches stderr leaves no reason anywhere and the user later sees only
    // that the session has no Codex thread to resume.
    it('records why Codex failed to start in the session log and the conversation before ending the session', async () => {
        const failure = new Error('Unsupported codex-multi-auth version 2.15.0; supported: >=2.16.0');
        fixture.onConnect = async () => { throw failure; };

        await expect(start()).rejects.toBe(failure);

        expect(logger.warn).toHaveBeenCalledWith('[codex]: Codex failed to start', failure);
        const notice = { type: 'message', message: 'Codex failed to start: Unsupported codex-multi-auth version 2.15.0; supported: >=2.16.0' };
        expect(fixture.session.sendSessionEvent).toHaveBeenCalledWith(notice);
        const noticeOrder = fixture.session.sendSessionEvent.mock.invocationCallOrder[
            fixture.session.sendSessionEvent.mock.calls.findIndex(([event]) => JSON.stringify(event) === JSON.stringify(notice))
        ];
        expect(noticeOrder).toBeLessThan(fixture.session.sendSessionDeath.mock.invocationCallOrder[0]);
        expect(noticeOrder).toBeLessThan(fixture.session.flush.mock.invocationCallOrder[0]);
        expect(fixture.send).not.toHaveBeenCalled();
    });

    it('records why resuming the Codex thread failed instead of ending the session silently', async () => {
        fixture.onResumeThread = async () => { throw new Error('thread not found'); };

        await expect(start('Resume input', false, undefined, undefined, 'thread-gone'))
            .rejects.toThrow('Failed to resume Codex thread thread-gone: thread not found');

        expect(logger.warn).toHaveBeenCalledWith('[codex]: Codex failed to start', expect.any(Error));
        expect(fixture.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Codex failed to start: Failed to resume Codex thread thread-gone: thread not found',
        });
        expect(fixture.send).not.toHaveBeenCalled();
    });
    it('rejects standalone authentication before creating an API client or server session', async () => {
        const parent = await StandaloneLaunchControl.open('early-auth-instance');
        const bootstrap = parent.reserve('early-auth-launch');
        try {
            await expect(start('Must not start', false, undefined, { ...bootstrap, secret: '0'.repeat(64) }))
                .rejects.toThrow('Standalone launch control');
            expect(ApiClient.create).not.toHaveBeenCalled();
            expect(fixture.getOrCreateSession).not.toHaveBeenCalled();
            expect(fixture.session.onUserMessage).not.toHaveBeenCalled();
            expect(fixture.send).not.toHaveBeenCalled();
        } finally { await parent.close(); }
    });
    it('uses the production launch channel to drain the real loop with its provider and session', async () => {
        const parent = await StandaloneLaunchControl.open('production-instance');
        const bootstrap = parent.reserve('production-launch');
        let proof!: ReturnType<StandaloneLaunchControl['drain']>;
        fixture.onSend = async () => {
            const interrupted = new Promise<void>(resolve => { fixture.onInterrupt = resolve; });
            proof = parent.drain(bootstrap.launchId, new AbortController().signal, { remainingMs: () => 30000 });
            await interrupted;
        };
        fixture.session.flushForShutdown.mockImplementationOnce(async () => {
            expect(fixture.events).toContain('loopExited');
            expect(fixture.session.close).not.toHaveBeenCalled();
            return { stored: true, revision: 1 };
        });
        try {
            await start('Production drain', false, undefined, bootstrap);
            expect(await proof).toEqual({ stored: true, releaseAcknowledged: true });
            expect(fixture.session.flushForShutdown).toHaveBeenCalledOnce();
            expect(fixture.session.close).toHaveBeenCalledOnce();
            expect(fixture.disconnect).toHaveBeenCalledOnce();
        } finally { await parent.close(); }
    });
    it('composes loop and writer settlement with storage proof and receipt release', async () => {
        let releaseWriter!: () => void;
        let drain!: SessionDrain;
        let pending!: Promise<DrainReceipt>;
        const flushForShutdown = vi.fn(async () => ({ stored: true as const, revision: 1 }));
        fixture.onSend = async () => {
            void fixture.admitTool!(() => new Promise<void>(resolve => { releaseWriter = resolve; }));
            drain = new SessionDrain('composed-loop', {
                freezeInputForShutdown: () => true, interruptTurn: async () => {},
                endInputAndAwaitExit: async () => ({ exited: true, code: 0, signal: null }),
                waitForOutputDrain: async () => {}, cancelOutputDrain: () => {}, finishShutdownObservation: () => {},
            }, { tracksShutdownStorage: true, flushForShutdown, isStorageConfirmationCurrent: () => true },
            async () => {}, fixture.gate!);
            pending = drain.drain(3000);
        };
        const running = start();
        await vi.waitFor(() => expect(fixture.events).toContain('loopExited'), { timeout: 3000 });
        expect(flushForShutdown).not.toHaveBeenCalled();
        expect(fixture.session.close).not.toHaveBeenCalled();
        releaseWriter();
        const receipt = await pending;
        expect(receipt).toMatchObject({ ownership: 'held', stored: true, runtimeExited: false, jobEmpty: false });
        expect(flushForShutdown).toHaveBeenCalledOnce();
        expect(fixture.session.close).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        drain.releaseRuntime(receipt);
        expect(await drain.outcome(receipt)).toBe('confirmed');
        await running;
        expect(fixture.session.close).toHaveBeenCalledOnce();
        expect(fixture.disconnect).toHaveBeenCalledOnce();
    });
    it('keeps kill blocked when provider freeze throws after an unknown mutation', async () => {
        let pending!: Promise<DrainReceipt>;
        fixture.onSend = async () => {
            const drain = new SessionDrain('unknown-loop', {
                freezeInputForShutdown: () => { throw new Error('partial provider freeze'); },
                interruptTurn: async () => {},
                endInputAndAwaitExit: async () => ({ exited: true, code: 0, signal: null }),
                waitForOutputDrain: async () => {}, cancelOutputDrain: () => {}, finishShutdownObservation: () => {},
            }, { tracksShutdownStorage: true, flushForShutdown: async () => ({ stored: true, revision: 1 }),
                isStorageConfirmationCurrent: () => true }, async () => {}, fixture.gate!);
            pending = drain.drain(1000);
        };
        void start();
        await vi.waitFor(() => expect(process.exitCode).toBe(1));
        expect(await pending).toMatchObject({ ownership: 'unknown', reason: 'freeze-failed' });
        await expect(fixture.admitTool!(async () => {})).rejects.toThrow('closed');
        const kill = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'killSession')![1] as () => Promise<{ success: boolean }>;
        const writes = fixture.session.updateMetadata.mock.calls.length;
        expect(await kill()).toMatchObject({ success: false });
        expect(fixture.session.updateMetadata).toHaveBeenCalledTimes(writes);
        expect(fixture.session.close).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
    });
    it('handles a blocked drain while an admitted MCP writer is still running', async () => {
        let release!: () => void; let writer: Promise<void> | undefined;
        fixture.onSend = async () => {
            writer = fixture.admitTool!(() => new Promise<void>(resolve => { release = resolve; }));
            fixture.gate!.freeze(); fixture.gate!.blockShutdownStorage();
        };
        void start();
        try {
            await vi.waitFor(() => expect(process.exitCode).toBe(1), { timeout: 5000 });
            expect(fixture.events).toContain('loopExited');
            expect(fixture.gate!.hasLiveProducers()).toBe(true);
            expect(fixture.session.close).not.toHaveBeenCalled();
            expect(fixture.disconnect).not.toHaveBeenCalled();
        } finally { release?.(); await writer; }
    });
    it('holds frozen cleanup before closing storage and provider until drain confirmation', async () => {
        fixture.onSend = async () => { fixture.gate!.freeze(); };
        const running = start();
        await vi.waitFor(() => expect(fixture.events).toContain('loopExited'), { timeout: 5000 });
        expect(fixture.session.close).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        fixture.gate!.confirmShutdownStorage();
        await running;
        expect(fixture.session.close).toHaveBeenCalledOnce();
        expect(fixture.disconnect).toHaveBeenCalledOnce();
    });
    it('refuses kill after a blocked freeze without closing live runtime resources', async () => {
        fixture.onSend = async () => { fixture.gate!.freeze(); fixture.gate!.blockShutdownStorage(); };
        void start();
        await vi.waitFor(() => expect(fixture.events).toContain('loopExited'));
        const kill = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'killSession')![1] as () => Promise<{ success: boolean }>;
        const writesBeforeKill = fixture.session.updateMetadata.mock.calls.length;
        expect(await kill()).toMatchObject({ success: false });
        expect(fixture.session.close).not.toHaveBeenCalled();
        expect(fixture.disconnect).not.toHaveBeenCalled();
        expect(fixture.session.updateMetadata).toHaveBeenCalledTimes(writesBeforeKill);
        expect(process.exitCode).toBe(1);
    });
    it('waits for a detached lesson writer before closing the session', async () => {
        let release!: () => void;
        const review = { reviewFinishedTurn: vi.fn(() => new Promise<'cancelled'>(resolve => {
            release = () => resolve('cancelled');
        })) };
        const running = start('Review this turn', false, review as never);
        await vi.waitFor(() => expect(review.reviewFinishedTurn).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(fixture.events).toContain('mcpStopped'));
        const closedEarly = fixture.session.close.mock.calls.length;
        const live = fixture.gate!.hasLiveProducers();
        release(); await running;
        expect(closedEarly).toBe(0);
        expect(live).toBe(true);
        await vi.waitFor(() => expect(fixture.gate!.hasLiveProducers()).toBe(false));
    });
    it('returns cached MCP status after freeze without a metadata write', async () => {
        let before = 0; let after = 0; let reply: unknown;
        fixture.onSend = async () => {
            fixture.gate!.freeze();
            const status = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'mcp-status')![1] as (params: unknown) => Promise<unknown>;
            before = fixture.session.updateMetadata.mock.calls.length;
            reply = await status({ sessionId: 'lesson-session' });
            after = fixture.session.updateMetadata.mock.calls.length;
        };
        await finishFrozenFixture(start());
        expect(reply).toEqual({ statuses: [{ name: 'cached-server', status: 'connected' }] });
        expect(after).toBe(before);
    });
    it('retains an admitted MCP writer until its actual settlement', async () => {
        let release!: () => void; let task: Promise<void> | undefined; let blocker: unknown;
        fixture.onSend = async () => {
            task = fixture.admitTool?.(() => new Promise<void>(resolve => { release = resolve; }));
            blocker = fixture.gate?.blocker();
        };
        const running = start();
        await vi.waitFor(() => expect(task).toBeDefined());
        const live = fixture.gate!.hasLiveProducers();
        release?.(); await task; await running;
        expect(task).toBeDefined();
        expect(blocker).toBeNull();
        expect(live).toBe(true);
        await vi.waitFor(() => expect(fixture.gate!.hasLiveProducers()).toBe(false));
    });
    it('records loop exit even when provider cleanup rejects', async () => {
        fixture.disconnect.mockRejectedValueOnce(new Error('cleanup failed'));
        await expect(start()).rejects.toThrow('cleanup failed');
        expect(fixture.events).toContain('loopExited');
        expect(fixture.gate!.hasLiveProducers()).toBe(false);
    });
    it('owns input before auth await and settles after the final turn writes', async () => {
        vi.spyOn(CodexAuthRecovery.prototype, 'beginTurn').mockImplementation(async () => {
            expect(fixture.gate?.blocker()).toBe('turn-preparing');
        });
        let dispatchBlocker: unknown = 'not dispatched';
        fixture.onSend = async () => { dispatchBlocker = fixture.gate?.blocker(); };
        await start();
        expect(fixture.send).toHaveBeenCalledOnce();
        expect(dispatchBlocker).toBeNull();
        expect(fixture.events.indexOf('endTurn')).toBeGreaterThan(fixture.events.lastIndexOf('keepAlive'));
        expect(fixture.events.indexOf('loopExited')).toBeGreaterThan(fixture.events.indexOf('endTurn'));
        expect(fixture.gate?.hasLiveProducers()).toBe(false);
    });
    it('reserves the initial prompt while its durable acknowledgement is pending', async () => {
        let release!: (value: { ok: boolean }) => void;
        fixture.session.awaitMessageAck.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const running = start('Confirmed input', true);
        await vi.waitFor(() => expect(fixture.session.awaitMessageAck).toHaveBeenCalledOnce());
        const blocker = fixture.gate?.blocker();
        release({ ok: true }); await running;
        expect(blocker).toBe('producer-busy');
        expect(fixture.send).toHaveBeenCalledOnce();
    });
    it('owns /clear and releases its turn without dispatching', async () => {
        vi.spyOn(CodexAuthRecovery.prototype, 'beginTurn').mockImplementation(async () => {
            expect(fixture.gate?.blocker()).toBe('turn-preparing');
            fixture.closeQueue?.();
        });
        await start('/clear');
        expect(fixture.send).not.toHaveBeenCalled();
        expect(fixture.events).toContain('endTurn');
        expect(fixture.gate?.hasLiveProducers()).toBe(false);
    });
    it('does not advertise ready after a partial freeze leaves input closed', async () => {
        fixture.onSend = async () => {
            fixture.session.freezeInboundMessagesForShutdown.mockReturnValue(false);
            try { fixture.gate?.freeze(); } catch { /* Simulate the cached blocked outcome, not a product drain. */ }
        };
        await finishFrozenFixture(start());
        expect(fixture.gate?.blocker()).toBe('frozen');
        expect(fixture.session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' });
    });
    it('reserves an authentication recovery until its actual promise settles', async () => {
        let release!: () => void; let blocker: unknown; let settledBlocker: unknown;
        vi.spyOn(CodexAuthRecovery.prototype, 'recover').mockImplementation(() => new Promise(resolve => {
            release = () => resolve({ version: 1, runtimeId: 'fixture', generation: 0, status: 'ready' });
        }));
        fixture.onSend = async () => {
            const recover = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'codex-auth-recover')![1] as (input: unknown) => Promise<unknown>;
            const running = recover({});
            blocker = fixture.gate?.blocker(); release(); await running;
            settledBlocker = fixture.gate?.blocker();
        };
        await start();
        expect(blocker).toBe('producer-busy');
        expect(settledBlocker).toBeNull();
    });
    it('keeps real auth recovery busy after freeze without reconnecting', async () => {
        let result: unknown;
        fixture.onSend = async () => {
            const lookup = (name: string) => fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([key]) => key === name)![1] as (input: unknown) => Promise<any>;
            const status = await lookup('codex-auth-status')({});
            fixture.gate!.freeze();
            result = await lookup('codex-auth-recover')({ version: 1, runtimeId: status.runtimeId,
                generation: status.generation, operationId: 'closed-recovery' });
        };
        await finishFrozenFixture(start());
        expect(result).toMatchObject({ status: 'busy' });
        expect(fixture.reconnect).not.toHaveBeenCalled();
    });
    it('tracks steer through the provider acknowledgement and final user echo', async () => {
        let blocker: unknown; let echoBlocker: unknown; let reply: unknown;
        fixture.onSend = async () => {
            let release!: () => void;
            fixture.onSteer = () => new Promise<void>(resolve => { release = resolve; });
            const steer = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'steer')![1] as (input: unknown) => Promise<unknown>;
            fixture.session.sendSessionProtocolMessage.mockImplementationOnce(() => { echoBlocker = fixture.gate?.blocker(); });
            const running = steer({ text: 'Tracked correction' });
            await vi.waitFor(() => expect(release).toBeTypeOf('function'));
            blocker = fixture.gate?.blocker(); release(); reply = await running;
        };
        await start();
        expect(blocker).toBe('producer-busy');
        expect(reply).toEqual({ success: true });
        expect(echoBlocker).toBe('producer-busy');
        expect(fixture.session.sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
    });
    it('refuses modifying RPCs after freeze before invoking provider or enqueue work', async () => {
        const results: unknown[] = [];
        fixture.onSend = async () => {
            fixture.gate!.freeze();
            for (const name of ['steer', 'goal-action', 'follow-up']) {
                const handler = fixture.session.rpcHandlerManager.registerHandler.mock.calls.find(([key]) => key === name)![1] as (input: unknown) => Promise<unknown>;
                results.push(await handler({ text: 'No new work' }).catch(error => ({ error: error.message })));
            }
        };
        await finishFrozenFixture(start());
        expect(results).toEqual([
            { success: false, error: 'Runtime input is closed' },
            { error: 'Runtime input is closed' },
            { accepted: false, reason: 'not-managed' },
        ]);
        expect(fixture.steerText).not.toBe('No new work');
    });
    it('tracks a claimed attachment and serial handler before they enqueue another input', async () => {
        const blockers: unknown[] = [];
        fixture.onSend = async () => {
            let release!: (value: []) => void;
            fixture.session.drainAttachmentsForUserMessage.mockImplementationOnce(() => new Promise<[]>(resolve => { release = resolve; }));
            const receive = fixture.session.onUserMessage.mock.calls[0][0] as (input: unknown) => Promise<void>;
            const input = receive({ content: { text: 'Second input' } });
            blockers.push(fixture.gate?.blocker());
            release([]); await input;
            blockers.push(fixture.gate?.blocker());
        };
        await start();
        expect(blockers).toEqual(['producer-busy', 'input-undelivered']);
    });
});
