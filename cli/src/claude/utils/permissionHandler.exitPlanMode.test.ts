import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

describe('PermissionHandler (ExitPlanMode)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.HAPPY_STACKS_TOOL_TRACE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_FILE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_DIR;
        delete process.env.HAPPY_LOCAL_TOOL_TRACE;
        delete process.env.HAPPY_LOCAL_TOOL_TRACE_FILE;
        delete process.env.HAPPY_LOCAL_TOOL_TRACE_DIR;
        delete process.env.HAPPY_TOOL_TRACE;
        delete process.env.HAPPY_TOOL_TRACE_FILE;
        delete process.env.HAPPY_TOOL_TRACE_DIR;
    });

    it('allows ExitPlanMode when approved', async () => {
        const rpcHandlers = new Map<string, (msg: any) => any>();
        let agentState: any = { requests: {}, completedRequests: {} };

        const client = {
            sessionId: 's1',
            rpcHandlerManager: {
                registerHandler: (name: string, handler: any) => {
                    rpcHandlers.set(name, handler);
                },
            },
            updateAgentState: vi.fn((updater: (current: any) => any) => {
                agentState = updater(agentState);
            }),
        } as any;

        const session = {
            client,
            api: {
                push: () => ({ sendToAllDevices: vi.fn() }),
            },
            setLastPermissionMode: vi.fn(),
        } as any;

        const { PermissionHandler } = await import('./permissionHandler');
        const handler = new PermissionHandler(session);

        handler.onMessage({
            type: 'assistant',
            message: {
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: 'p1' } }],
            },
        } as any);

        const resultPromise = handler.handleToolCall(
            'ExitPlanMode',
            { plan: 'p1' },
            { permissionMode: 'plan' } as any,
            { signal: new AbortController().signal },
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeDefined();

        await permissionRpc!({ id: 'toolu_1', approved: true });
        await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'p1' } });
    });

    it('denies ExitPlanMode with the provided reason, and does not abort the remote loop', async () => {
        const rpcHandlers = new Map<string, (msg: any) => any>();
        let agentState: any = { requests: {}, completedRequests: {} };

        const client = {
            sessionId: 's1',
            rpcHandlerManager: {
                registerHandler: (name: string, handler: any) => {
                    rpcHandlers.set(name, handler);
                },
            },
            updateAgentState: vi.fn((updater: (current: any) => any) => {
                agentState = updater(agentState);
            }),
        } as any;

        const session = {
            client,
            api: {
                push: () => ({ sendToAllDevices: vi.fn() }),
            },
            setLastPermissionMode: vi.fn(),
        } as any;

        const { PermissionHandler } = await import('./permissionHandler');
        const handler = new PermissionHandler(session);

        handler.onMessage({
            type: 'assistant',
            message: {
                content: [{ type: 'tool_use', id: 'toolu_1', name: 'ExitPlanMode', input: { plan: 'p1' } }],
            },
        } as any);

        const resultPromise = handler.handleToolCall(
            'ExitPlanMode',
            { plan: 'p1' },
            { permissionMode: 'plan' } as any,
            { signal: new AbortController().signal },
        );

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeDefined();

        await permissionRpc!({ id: 'toolu_1', approved: false, reason: 'Please change step 2' });
        await expect(resultPromise).resolves.toMatchObject({ behavior: 'deny', message: 'Please change step 2' });

        expect(handler.isAborted('toolu_1')).toBe(false);
    });
});
