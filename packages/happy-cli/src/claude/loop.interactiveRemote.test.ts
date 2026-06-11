import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockClaudeInteractiveRemoteLauncher,
    mockClaudeLocalLauncher,
    mockClaudeRemoteLauncher,
} = vi.hoisted(() => ({
    mockClaudeInteractiveRemoteLauncher: vi.fn(),
    mockClaudeLocalLauncher: vi.fn(),
    mockClaudeRemoteLauncher: vi.fn(),
}));

vi.mock('./claudeInteractiveRemoteLauncher', () => ({
    claudeInteractiveRemoteLauncher: mockClaudeInteractiveRemoteLauncher,
}));

vi.mock('./claudeLocalLauncher', () => ({
    claudeLocalLauncher: mockClaudeLocalLauncher,
}));

vi.mock('./claudeRemoteLauncher', () => ({
    claudeRemoteLauncher: mockClaudeRemoteLauncher,
}));

vi.mock('./session', () => ({
    Session: class MockSession {
        constructor(opts: Record<string, unknown>) {
            Object.assign(this, opts);
        }
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        logFilePath: '/tmp/happy.log',
    },
}));

import { loop } from './loop';

function createLoopOptions(overrides: Record<string, unknown> = {}) {
    return {
        path: '/tmp/project',
        startingMode: 'remote',
        onModeChange: vi.fn(),
        mcpServers: {},
        session: {},
        api: {},
        messageQueue: {},
        initialMode: { permissionMode: 'default' },
        hookSettingsPath: '/tmp/happy-hook-settings.json',
        ...overrides,
    } as any;
}

describe('loop interactive Claude remote selection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClaudeRemoteLauncher.mockResolvedValue('exit');
    });

    it('routes Claude remote mode to the interactive launcher and preserves its exit code', async () => {
        mockClaudeInteractiveRemoteLauncher.mockResolvedValueOnce({ type: 'exit', code: 42 });

        const code = await loop(createLoopOptions());

        expect(code).toBe(42);
        expect(mockClaudeInteractiveRemoteLauncher).toHaveBeenCalledTimes(1);
        expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
        expect(mockClaudeLocalLauncher).not.toHaveBeenCalled();
    });

    it('switches local launcher back to interactive remote without using SDK remote', async () => {
        mockClaudeInteractiveRemoteLauncher.mockResolvedValueOnce({ type: 'exit', code: 7 });
        mockClaudeLocalLauncher.mockResolvedValueOnce({ type: 'switch' });
        const onModeChange = vi.fn();

        const code = await loop(createLoopOptions({ startingMode: 'local', onModeChange }));

        expect(code).toBe(7);
        expect(onModeChange.mock.calls.map(([mode]) => mode)).toEqual(['remote']);
        expect(mockClaudeInteractiveRemoteLauncher).toHaveBeenCalledTimes(1);
        expect(mockClaudeLocalLauncher).toHaveBeenCalledTimes(1);
        expect(mockClaudeRemoteLauncher).not.toHaveBeenCalled();
    });
});
