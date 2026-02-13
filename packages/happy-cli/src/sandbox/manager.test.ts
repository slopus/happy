import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import {
    initializeSandbox,
    wrapCommand,
    wrapForMcpTransport,
} from './manager';

const {
    mockInitialize,
    mockWrapWithSandbox,
    mockReset,
    mockBuildSandboxRuntimeConfig,
} = vi.hoisted(() => ({
    mockInitialize: vi.fn(),
    mockWrapWithSandbox: vi.fn(),
    mockReset: vi.fn(),
    mockBuildSandboxRuntimeConfig: vi.fn(),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
    SandboxManager: {
        initialize: mockInitialize,
        wrapWithSandbox: mockWrapWithSandbox,
        reset: mockReset,
    },
}));

vi.mock('./config', () => ({
    buildSandboxRuntimeConfig: mockBuildSandboxRuntimeConfig,
}));

describe('sandbox manager', () => {
    const runtimeConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: ['*'],
            deniedDomains: [],
            allowLocalBinding: true,
            allowUnixSockets: [],
        },
        filesystem: {
            denyRead: [],
            allowWrite: ['/tmp'],
            denyWrite: [],
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSandboxRuntimeConfig.mockReturnValue(runtimeConfig);
        mockWrapWithSandbox.mockResolvedValue('sandbox wrapped command');
    });

    it('initializes sandbox and returns cleanup function', async () => {
        const sandboxConfig: SandboxConfig = {
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        };

        const cleanup = await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(sandboxConfig, '/workspace/session');
        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);

        await cleanup();
        expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('wrapCommand delegates to SandboxManager.wrapWithSandbox', async () => {
        const wrapped = await wrapCommand('node script.js');

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('node script.js');
        expect(wrapped).toBe('sandbox wrapped command');
    });

    it('wrapForMcpTransport returns sh -c wrapped command', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox codex command');

        const wrapped = await wrapForMcpTransport('codex', ['mcp-server']);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('codex mcp-server');
        expect(wrapped).toEqual({
            command: 'sh',
            args: ['-c', 'sandbox codex command'],
        });
    });
});
