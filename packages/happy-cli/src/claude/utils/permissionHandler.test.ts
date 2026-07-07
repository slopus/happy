import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { EnhancedMode } from '../loop';

vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

function createSessionMock() {
    let state: Record<string, any> = {};
    const handlers = new Map<string, (message: any) => Promise<void>>();
    const sendSessionNotification = vi.fn();
    const pushClient = { sendSessionNotification };

    return {
        session: {
            client: {
                sessionId: 'happy-session-1',
                getMetadata: vi.fn(() => ({})),
                updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                    state = updater(state);
                    return state;
                }),
                rpcHandlerManager: {
                    registerHandler: vi.fn((name: string, handler: (message: any) => Promise<void>) => {
                        handlers.set(name, handler);
                    }),
                },
            },
            api: {
                push: vi.fn(() => pushClient),
            },
        },
        getState: () => state,
        handlers,
        sendSessionNotification,
    };
}

function getPermissionResponseHandler(handlers: Map<string, (message: any) => Promise<void>>) {
    const handler = handlers.get('permission');
    expect(handler).toBeDefined();
    return handler!;
}

describe('PermissionHandler', () => {
    it('auto-approves tool calls in yolo mode without surfacing a request', async () => {
        const { session, getState } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        handler.handleModeChange('yolo');

        const result = await handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_yolo' },
        );

        expect(result).toMatchObject({ behavior: 'allow' });
        expect(getState().requests).toBeUndefined();
    });

    it('auto-approves tool calls in bypassPermissions mode', async () => {
        const { session } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        handler.handleModeChange('bypassPermissions');

        const result = await handler.handleToolCall(
            'Write',
            { file_path: '/tmp/x', content: 'y' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_bypass' },
        );

        expect(result).toMatchObject({ behavior: 'allow' });
    });

    it('syncs the mapped mode into the live query on mode change', async () => {
        const { session } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const setMode = vi.fn(async () => {});

        handler.setPermissionModeUpdater(setMode);
        handler.handleModeChange('yolo');

        expect(setMode).toHaveBeenCalledWith('bypassPermissions');
    });

    it('keeps main-thread request IDs unchanged', async () => {
        const { session, getState, handlers } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        const pending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_main' },
        );

        expect(getState().requests.toolu_main).toMatchObject({
            tool: 'Bash',
            arguments: { command: 'pwd' },
        });

        await getPermissionResponseHandler(handlers)({ id: 'toolu_main', approved: true });
        await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    });

    it('uses agentID to disambiguate sub-agent permission requests with the same toolUseID', async () => {
        const { session, getState, handlers, sendSessionNotification } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const firstController = new AbortController();
        const secondController = new AbortController();

        const firstPending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: firstController.signal, toolUseID: 'toolu_shared', agentID: 'agent-a' },
        );
        const secondPending = handler.handleToolCall(
            'Bash',
            { command: 'whoami' },
            mode,
            { signal: secondController.signal, toolUseID: 'toolu_shared', agentID: 'agent-b' },
        );

        expect(getState().requests).toMatchObject({
            'agent-a:toolu_shared': {
                tool: 'Bash',
                arguments: { command: 'pwd' },
                // Raw provider id rides along so the app can attach the
                // permission card to the sidechain tool call.
                toolUseId: 'toolu_shared',
            },
            'agent-b:toolu_shared': {
                tool: 'Bash',
                arguments: { command: 'whoami' },
                toolUseId: 'toolu_shared',
            },
        });
        expect(sendSessionNotification).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: expect.objectContaining({ requestId: 'agent-a:toolu_shared' }),
        }));
        expect(sendSessionNotification).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: expect.objectContaining({ requestId: 'agent-b:toolu_shared' }),
        }));

        const respondToPermission = getPermissionResponseHandler(handlers);
        await respondToPermission({
            id: 'agent-b:toolu_shared',
            approved: false,
            reason: 'not this one',
        });
        await respondToPermission({
            id: 'agent-a:toolu_shared',
            approved: true,
        });

        await expect(firstPending).resolves.toMatchObject({ behavior: 'allow' });
        await expect(secondPending).resolves.toMatchObject({
            behavior: 'deny',
            message: 'not this one',
        });
        expect(getState().completedRequests['agent-a:toolu_shared']).toMatchObject({
            status: 'approved',
            toolUseId: 'toolu_shared',
        });
        expect(getState().completedRequests['agent-b:toolu_shared']).toMatchObject({
            status: 'denied',
            toolUseId: 'toolu_shared',
        });
    });

    it('can look up a single sub-agent response by raw toolUseID for transcript follow-up paths', async () => {
        const { session, handlers } = createSessionMock();
        const handler = new PermissionHandler(session as any);
        const controller = new AbortController();

        const pending = handler.handleToolCall(
            'Bash',
            { command: 'pwd' },
            mode,
            { signal: controller.signal, toolUseID: 'toolu_result', agentID: 'agent-a' },
        );

        await getPermissionResponseHandler(handlers)({
            id: 'agent-a:toolu_result',
            approved: false,
            reason: 'denied',
            mode: 'default',
        });

        await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
        expect(handler.getResponseForToolUseId('toolu_result')).toMatchObject({
            approved: false,
            reason: 'denied',
        });
        expect(handler.isAborted('toolu_result')).toBe(true);
    });
});
