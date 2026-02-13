import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { CodexMcpClient } from '../codexMcpClient';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockClientConnect,
    mockClientClose,
    mockStdioCtor,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockClientConnect: vi.fn(),
    mockClientClose: vi.fn(),
    mockStdioCtor: vi.fn(),
}));

vi.mock('child_process', () => ({
    execSync: mockExecSync,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class MockClient {
        setNotificationHandler = vi.fn();
        setRequestHandler = vi.fn();
        connect = mockClientConnect;
        close = mockClientClose;
        callTool = vi.fn();
        constructor() {}
    },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class MockTransport {
        pid = 12345;
        close = vi.fn();
        constructor(opts: any) {
            mockStdioCtor(opts);
        }
    },
}));

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexMcpClient sandbox integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExecSync.mockReturnValue('codex-cli 0.43.0');
        mockClientConnect.mockResolvedValue(undefined);
        mockClientClose.mockResolvedValue(undefined);
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex mcp'] });
    });

    it('wraps MCP transport when sandbox is enabled', async () => {
        const client = new CodexMcpClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['mcp-server']);
        expect(mockStdioCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'sh',
                args: ['-c', 'wrapped codex mcp'],
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const client = new CodexMcpClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockStdioCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                command: 'codex',
                args: ['mcp-server'],
            }),
        );
        expect(client.sandboxEnabled).toBe(false);
    });

    it('resets sandbox on disconnect', async () => {
        const client = new CodexMcpClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });
});
