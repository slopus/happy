import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnhancedMode } from './loop';

const {
    mockClaudeLocal,
    mockCreateSessionScanner,
    MockExitCodeError
} = vi.hoisted(() => {
    class MockExitCodeError extends Error {
        exitCode: number;
        constructor(exitCode: number) {
            super(`Process exited with code ${exitCode}`);
            this.exitCode = exitCode;
            this.name = 'ExitCodeError';
        }
    }

    return {
        mockClaudeLocal: vi.fn(),
        mockCreateSessionScanner: vi.fn(),
        MockExitCodeError
    };
});

vi.mock('./claudeLocal', () => ({
    claudeLocal: mockClaudeLocal,
    ExitCodeError: MockExitCodeError
}));

vi.mock('./utils/sessionScanner', () => ({
    createSessionScanner: mockCreateSessionScanner
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

import { claudeLocalLauncher } from './claudeLocalLauncher';

function createSessionDouble() {
    let onMessageHandler: ((message: string, mode: EnhancedMode) => void) | null = null;
    const handlers = new Map<string, () => Promise<void>>();

    const session = {
        sessionId: 'session-test',
        path: '/tmp',
        client: {
            sendClaudeSessionMessage: vi.fn(),
            sendSessionEvent: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn((name: string, fn: () => Promise<void>) => {
                    handlers.set(name, fn);
                })
            }
        },
        queue: {
            setOnMessage: vi.fn((fn: ((message: string, mode: EnhancedMode) => void) | null) => {
                onMessageHandler = fn;
            }),
            size: vi.fn(() => 0),
            reset: vi.fn()
        },
        addSessionFoundCallback: vi.fn(),
        removeSessionFoundCallback: vi.fn(),
        onSessionFound: vi.fn(),
        onThinkingChange: vi.fn(),
        consumeOneTimeFlags: vi.fn(),
        claudeEnvVars: undefined,
        claudeArgs: undefined,
        mcpServers: {},
        allowedTools: undefined,
        hookSettingsPath: '/tmp/hooks.json'
    };

    return {
        session,
        getOnMessageHandler: () => onMessageHandler,
        handlers
    };
}

describe('claudeLocalLauncher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCreateSessionScanner.mockResolvedValue({
            onNewSession: vi.fn(),
            cleanup: vi.fn(async () => {})
        });
    });

    it('returns switch when local abort during switch exits with code 143', async () => {
        const { session, getOnMessageHandler } = createSessionDouble();

        mockClaudeLocal.mockImplementation(async () => {
            const onMessage = getOnMessageHandler();
            if (onMessage) {
                onMessage('PHONE-A3', { permissionMode: 'default' });
            }
            throw new MockExitCodeError(143);
        });

        const result = await claudeLocalLauncher(session as any);

        expect(result).toEqual({ type: 'switch' });
    });

    it('propagates non-zero exit code when no switch was requested', async () => {
        const { session } = createSessionDouble();

        mockClaudeLocal.mockRejectedValue(new MockExitCodeError(2));

        const result = await claudeLocalLauncher(session as any);

        expect(result).toEqual({ type: 'exit', code: 2 });
    });
});

