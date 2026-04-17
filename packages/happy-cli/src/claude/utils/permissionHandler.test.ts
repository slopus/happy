import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';

vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createClientMock(sessionId: string) {
    const handlers = new Map<string, (message: any) => Promise<void> | void>();

    return {
        sessionId,
        getMetadata: vi.fn(() => ({})),
        updateAgentState: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn((name: string, handler: (message: any) => Promise<void> | void) => {
                handlers.set(name, handler);
            }),
        },
        getHandler: (name: string) => handlers.get(name),
    };
}

function createSessionMock(client: ReturnType<typeof createClientMock>) {
    return {
        client,
        api: {
            push: () => ({
                sendSessionNotification: vi.fn(),
            }),
        },
        addSessionFoundCallback: vi.fn(),
    };
}

describe('Claude PermissionHandler', () => {
    it('re-registers permission RPC handler when session client changes', () => {
        const initialClient = createClientMock('session-1');
        const updatedClient = createClientMock('session-2');
        const session = createSessionMock(initialClient);
        const handler = new PermissionHandler(session as any);

        const initialRegisteredHandler = initialClient.getHandler('permission');
        expect(initialRegisteredHandler).toBeTypeOf('function');

        (session as any).client = updatedClient;
        handler.updateSession(session as any);

        const updatedRegisteredHandler = updatedClient.getHandler('permission');
        expect(updatedRegisteredHandler).toBeTypeOf('function');
        expect(updatedRegisteredHandler).not.toBe(initialRegisteredHandler);
        expect(updatedClient.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('permission', expect.any(Function));
    });
});
