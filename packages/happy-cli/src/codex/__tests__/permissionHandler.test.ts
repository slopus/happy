import { describe, expect, it, vi } from 'vitest';
import { CodexPermissionHandler } from '../utils/permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionMock() {
    let state: Record<string, any> = {};

    return {
        session: {
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
    };
}

describe('CodexPermissionHandler', () => {
    it.each(['approved', 'aborted', 'reset', 'auto-approved'])('keeps %s permission timestamps stable when state transforms replay', async mode => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
        try {
            const { session } = createSessionMock();
            const handler = new CodexPermissionHandler(session as any);
            const pending = handler.handleToolCall('fixture', mode === 'auto-approved' ? 'change_title' : 'Bash', { command: 'pwd' });
            if (mode === 'approved') {
                const permission = session.rpcHandlerManager.registerHandler.mock.calls.find(([name]) => name === 'permission');
                await permission![1]({ id: 'fixture', approved: true });
            } else if (mode === 'aborted') handler.abortAll();
            else if (mode === 'reset') { void pending.catch(() => {}); handler.reset(); }
            await pending.catch(() => {});
            const replay = () => session.updateAgentState.mock.calls.reduce((state, [update]) => update(state), {});
            const original = replay();
            clock.mockReturnValue(200);
            expect(replay()).toEqual(original);
        } finally { clock.mockRestore(); }
    });
    it('permanently refuses late approval registration, including auto-approval, after shutdown', async () => {
        const { session, getState } = createSessionMock(); const handler = new CodexPermissionHandler(session as any);
        const pending = handler.handleToolCall('before-close', 'Bash', {});
        handler.closeForShutdown();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
        expect(getState().completedRequests['before-close'].reason).toBe('Session shutting down');
        const writes = session.updateAgentState.mock.calls.length;
        await expect(handler.handleToolCall('safe-late', 'change_title', {})).resolves.toEqual({ decision: 'abort' });
        const late = handler.handleToolCall('late', 'Bash', {});
        // Avoid orphaning the pending resolver in the Red run.
        handler.abortAll();
        await expect(late).resolves.toEqual({ decision: 'abort' });
        expect(session.updateAgentState).toHaveBeenCalledTimes(writes);
    });

    it.each(['Bash', 'change_title'])('closes even an empty handler before a late %s request', async tool => {
        const { session } = createSessionMock(); const handler = new CodexPermissionHandler(session as any);
        handler.closeForShutdown();
        await expect(handler.handleToolCall('late-empty', tool, {})).resolves.toEqual({ decision: 'abort' });
        expect(session.updateAgentState).not.toHaveBeenCalled();
    });

    it('keeps ordinary user abort reusable for a later approval', async () => {
        const { session, getState } = createSessionMock(); const handler = new CodexPermissionHandler(session as any);
        const first = handler.handleToolCall('first', 'Bash', {}); handler.abortAll(); await first;
        expect(getState().completedRequests.first.reason).toBe('Aborted by user');
        const next = handler.handleToolCall('next', 'Bash', {});
        expect(getState().requests.next).toBeDefined(); handler.abortAll(); await next;
    });

    it('auto-approves the safe change_title tool', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_change_title_123',
            'change_title',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_change_title_123).toMatchObject({
            tool: 'change_title',
            arguments: { title: 'Greeting' },
            status: 'approved',
            decision: 'approved',
        });
    });

    it('keeps non-safe tools pending for user approval', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_exec_123',
            'Bash',
            { command: 'pwd' },
        );

        expect(getState().requests.call_exec_123).toMatchObject({
            tool: 'Bash',
            arguments: { command: 'pwd' },
        });

        handler.abortAll();

        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does NOT auto-approve a crafted tool name containing change_title as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_malicious_1',
            'change_title_and_run_command',
            { title: 'pwn', cmd: 'rm -rf /' },
        );

        // Should remain pending (not auto-approved) — resolve via abort to clean up.
        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does NOT auto-approve a tool whose ID merely contains change_title as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        // ID like `x_change_title_y` — old substring check would match, new prefix check must not.
        const pending = handler.handleToolCall(
            'x_change_title_y',
            'ExecCommand',
            { command: 'rm -rf /' },
        );

        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('auto-approves change_title tool call by Gemini-style ID (change_title-<timestamp>)', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'change_title-1765385846663',
            'other',
            { title: 'Greeting' },
        );

        expect(result).toEqual({ decision: 'approved' });
    });

    it('auto-approves requests from the codex_apps MCP server', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'codex_apps:42',
            'send_message',
            { channel: 'engineering', text: 'Deployed' },
            { serverName: 'codex_apps' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests['codex_apps:42']).toMatchObject({
            tool: 'send_message',
            status: 'approved',
        });
    });

    it('keeps an identically named tool from another MCP server pending', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'other:42',
            'send_message',
            { channel: 'engineering', text: 'Deployed' },
            { serverName: 'other' },
        );

        handler.abortAll();

        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });
});

describe('BasePermissionHandler settlement hook', () => {
    /** Captures the RPC handler the base registers, so a test can answer the way the transport does. */
    function createAnsweringSessionMock() {
        let state: Record<string, any> = {};
        let answer: ((response: unknown) => Promise<unknown>) | null = null;
        return {
            session: {
                rpcHandlerManager: {
                    registerHandler: vi.fn((_name: string, fn: (response: unknown) => Promise<unknown>) => {
                        answer = fn;
                    }),
                },
                updateAgentState: vi.fn((updater: (s: Record<string, any>) => Record<string, any>) => {
                    state = updater(state);
                    return state;
                }),
            },
            answer: (response: unknown) => {
                if (!answer) throw new Error('permission RPC handler was never registered');
                return answer(response);
            },
            getState: () => state,
        };
    }

    /** A handler that records every settlement, or throws on demand. */
    class ObservingHandler extends CodexPermissionHandler {
        readonly settled: { id: string; reason: string }[] = [];
        throwOnSettle = false;
        protected override onPendingSettled(permissionId: string, reason: string): void {
            this.settled.push({ id: permissionId, reason });
            if (this.throwOnSettle) throw new Error('publisher exploded: raw provider text');
        }
    }

    const raise = (handler: CodexPermissionHandler) => handler.handleToolCall(
        'call_exec_1', 'CodexBash', { command: ['ls'] },
    );

    it('fires exactly once when the prompt is answered', async () => {
        const mock = createAnsweringSessionMock();
        const handler = new ObservingHandler(mock.session as any);
        const decided = raise(handler);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await expect(decided).resolves.toEqual({ decision: 'approved' });
        expect(handler.settled).toEqual([{ id: 'call_exec_1', reason: 'answered' }]);

        // A second answer finds nothing pending and must not notify again.
        await mock.answer({ id: 'call_exec_1', approved: true });
        expect(handler.settled).toHaveLength(1);
    });

    it('fires exactly once per request on abort', async () => {
        const mock = createAnsweringSessionMock();
        const handler = new ObservingHandler(mock.session as any);
        const decided = raise(handler);
        handler.abortAll();
        await expect(decided).resolves.toEqual({ decision: 'abort' });
        expect(handler.settled).toEqual([{ id: 'call_exec_1', reason: 'aborted' }]);

        // Nothing pending any more: a second abort is a no-op.
        handler.abortAll();
        expect(handler.settled).toHaveLength(1);
    });

    it('fires exactly once per request on reset', async () => {
        const mock = createAnsweringSessionMock();
        const handler = new ObservingHandler(mock.session as any);
        const decided = raise(handler);
        handler.reset('test');
        await expect(decided).rejects.toThrow('Session reset');
        expect(handler.settled).toEqual([{ id: 'call_exec_1', reason: 'reset' }]);
        handler.reset('again');
        expect(handler.settled).toHaveLength(1);
    });

    it('does not let a throwing hook block the answer', async () => {
        // The prompt is already resolved by the time the hook runs, so a publisher that throws has
        // nothing the caller could roll back — it must not turn an answered permission into an
        // unanswered one.
        const mock = createAnsweringSessionMock();
        const handler = new ObservingHandler(mock.session as any);
        handler.throwOnSettle = true;
        const decided = raise(handler);
        await expect(mock.answer({ id: 'call_exec_1', approved: true })).resolves.toBeUndefined();
        await expect(decided).resolves.toEqual({ decision: 'approved' });
        // The agent state still moved the request to completed.
        expect(mock.getState().completedRequests.call_exec_1).toMatchObject({ status: 'approved' });
    });

    it('does not let a throwing hook stop an abort or a reset partway through', async () => {
        for (const settle of ['abort', 'reset'] as const) {
            const mock = createAnsweringSessionMock();
            const handler = new ObservingHandler(mock.session as any);
            handler.throwOnSettle = true;
            const first = handler.handleToolCall('call_a', 'CodexBash', { command: ['a'] });
            const second = handler.handleToolCall('call_b', 'CodexBash', { command: ['b'] });
            if (settle === 'abort') {
                handler.abortAll();
                await expect(first).resolves.toEqual({ decision: 'abort' });
                await expect(second).resolves.toEqual({ decision: 'abort' });
            } else {
                handler.reset('test');
                await expect(first).rejects.toThrow('Session reset');
                await expect(second).rejects.toThrow('Session reset');
            }
            // Both were notified even though the first notification threw.
            expect(handler.settled.map((entry) => entry.id), settle).toEqual(['call_a', 'call_b']);
        }
    });

    it('is inert for a handler that does not override it', async () => {
        // Gemini and the ACP handler take this path: no hook, no channel behaviour, and the
        // ordinary settlement is byte-for-byte what it was.
        const mock = createAnsweringSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler);
        await mock.answer({ id: 'call_exec_1', approved: false });
        await expect(decided).resolves.toEqual({ decision: 'abort' });
        expect(mock.getState().completedRequests.call_exec_1).toMatchObject({ status: 'denied' });
    });
});

describe('CodexPermissionHandler channel guidance', () => {
    function createObservingSessionMock(options: { throwOnSend?: boolean } = {}) {
        let state: Record<string, any> = {};
        let answer: ((response: unknown) => Promise<unknown>) | null = null;
        const sent: any[] = [];
        return {
            session: {
                runtimeId: 'runtime-1',
                rpcHandlerManager: {
                    registerHandler: vi.fn((name: string, fn: (response: unknown) => Promise<unknown>) => {
                        if (name === 'permission') answer = fn;
                    }),
                },
                updateAgentState: vi.fn((updater: (s: Record<string, any>) => Record<string, any>) => {
                    state = updater(state);
                    return state;
                }),
                sendSessionProtocolMessage: vi.fn((envelope: any) => {
                    if (options.throwOnSend) throw new Error('transport exploded: raw provider text');
                    sent.push(envelope);
                }),
            },
            answer: (response: unknown) => {
                if (!answer) throw new Error('permission RPC handler was never registered');
                return answer(response);
            },
            events: () => sent.map((envelope) => envelope.ev),
            getState: () => state,
        };
    }

    const TURN = { turnId: 'turn-a', channelRequestId: 'req-1', runtimeId: 'runtime-1' };

    /**
     * Exactly what the approval boundary does: one call, with the turn in `context`. Nothing is
     * published by the caller, so a test cannot accidentally establish an order production does
     * not have — the defect this replaced was a call placed *before* `handleToolCall`, where no
     * pending request existed yet and every publish was silently dropped.
     */
    const raise = (
        handler: CodexPermissionHandler,
        channelTurn?: { turnId: string; channelRequestId: string | null; runtimeId: string },
    ) => handler.handleToolCall('call_exec_1', 'CodexBash', { command: ['ls'] }, {
        ...(channelTurn ? { channelTurn } : {}),
    });

    it('publishes the wait from the same call that registers the prompt', async () => {
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, TURN);
        // Already published by the time the call returns — no second step to forget.
        expect(mock.events()).toEqual([{
            t: 'channel-permission',
            permissionId: 'call_exec_1',
            turnId: 'turn-a',
            channelRequestId: 'req-1',
            runtimeId: 'runtime-1',
            kind: 'desktop-only',
            createdAt: expect.any(Number),
        }]);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
    });

    it('publishes nothing when the approval carried no resolvable turn', async () => {
        // No `channelTurn` in the context: the request's provider turn id was absent, unknown or
        // stale. Fail closed rather than name the turn that happens to be open.
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler);
        expect(mock.events()).toEqual([]);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
        expect(mock.events()).toEqual([]);
    });

    it('says nothing about the tool or its arguments', async () => {
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, TURN);
        expect(Object.keys(mock.events()[0]).sort()).toEqual([
            'channelRequestId', 'createdAt', 'kind', 'permissionId', 'runtimeId', 't', 'turnId',
        ]);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
    });

    it('is desktop-only, never generic', async () => {
        // Codex registers no dedicated channel-permission RPC, so a messenger could never answer
        // this. `generic` would offer a button whose answers have no route.
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, TURN);
        expect((mock.events()[0] as any).kind).toBe('desktop-only');
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
    });

    it('publishes nothing for a Desktop-originated turn', async () => {
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, { ...TURN, channelRequestId: null });
        expect(mock.events()).toEqual([]);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
        expect(mock.events()).toEqual([]);
    });

    it('publishes nothing for an auto-approved tool, which never waits', async () => {
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        await expect(handler.handleToolCall('change_title-1', 'change_title', { title: 'x' }, {
            channelTurn: TURN,
        })).resolves.toEqual({ decision: 'approved' });
        expect(mock.events()).toEqual([]);
    });

    it('does not let a throwing publish break the permission request', async () => {
        // The Desktop user must still be asked, and must still be able to answer, even if the
        // channel transport fails outright.
        const mock = createObservingSessionMock({ throwOnSend: true });
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, TURN);
        expect(mock.getState().requests.call_exec_1).toMatchObject({ tool: 'CodexBash' });
        await mock.answer({ id: 'call_exec_1', approved: true });
        await expect(decided).resolves.toEqual({ decision: 'approved' });
        expect(mock.getState().completedRequests.call_exec_1).toMatchObject({ status: 'approved' });
    });

    it('withdraws the wait on answer, abort and reset', async () => {
        for (const settle of ['answer', 'abort', 'reset'] as const) {
            const mock = createObservingSessionMock();
            const handler = new CodexPermissionHandler(mock.session as any);
            const decided = raise(handler, TURN);
            if (settle === 'answer') {
                await mock.answer({ id: 'call_exec_1', approved: true });
                await decided;
            } else if (settle === 'abort') {
                handler.abortAll();
                await decided;
            } else {
                handler.reset('test');
                await expect(decided).rejects.toThrow('Session reset');
            }
            expect(mock.events().map((event: any) => event.t), settle)
                .toEqual(['channel-permission', 'channel-permission-withdrawn']);
            const withdrawn = mock.events()[1] as any;
            expect(withdrawn.reason, settle).toBe(
                settle === 'answer' ? 'answered' : settle === 'abort' ? 'aborted' : 'reset',
            );
            expect(Object.keys(withdrawn).sort()).toEqual([
                'channelRequestId', 'createdAt', 'permissionId', 'reason', 'runtimeId', 't', 'turnId',
            ]);
        }
    });

    it('withdraws exactly once even if the prompt is answered twice', async () => {
        const mock = createObservingSessionMock();
        const handler = new CodexPermissionHandler(mock.session as any);
        const decided = raise(handler, TURN);
        await mock.answer({ id: 'call_exec_1', approved: true });
        await decided;
        await mock.answer({ id: 'call_exec_1', approved: true });
        expect(mock.events().filter((event: any) => event.t === 'channel-permission-withdrawn'))
            .toHaveLength(1);
    });

    it('registers no dedicated channel-permission RPC', () => {
        const mock = createObservingSessionMock();
        new CodexPermissionHandler(mock.session as any);
        const names = (mock.session.rpcHandlerManager.registerHandler as any).mock.calls
            .map((call: unknown[]) => call[0]);
        expect(names).toContain('permission');
        expect(names).not.toContain('channel-permission');
    });
});
