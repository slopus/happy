import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    mockNotificationHandler,
    mockRequestHandler,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockClientConnect: vi.fn(),
    mockClientClose: vi.fn(),
    mockStdioCtor: vi.fn(),
    mockNotificationHandler: {
        current: null as ((data: any) => void) | null,
    },
    mockRequestHandler: {
        current: null as ((request: any) => Promise<any>) | null,
    },
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
        setNotificationHandler = vi.fn((_schema: any, handler: (data: any) => void) => {
            mockNotificationHandler.current = handler;
        });
        setRequestHandler = vi.fn((_schema: any, handler: (request: any) => Promise<any>) => {
            mockRequestHandler.current = handler;
        });
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
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.43.0');
        mockClientConnect.mockResolvedValue(undefined);
        mockClientClose.mockResolvedValue(undefined);
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex mcp'] });
        mockNotificationHandler.current = null;
        mockRequestHandler.current = null;
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
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
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
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
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
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

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const client = new CodexMcpClient(sandboxConfig);

        await client.connect();

        expect(mockStdioCtor).toHaveBeenCalledWith(
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );
    });

    it('maps permission decisions to Codex elicitation actions', async () => {
        const client = new CodexMcpClient();
        client.setPermissionHandler({
            handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved_for_session' }),
        } as any);

        await client.connect();

        expect(mockRequestHandler.current).toBeTruthy();
        const response = await mockRequestHandler.current!({
            params: {
                codex_call_id: 'call_123',
                codex_command: ['echo', 'hi'],
                codex_cwd: '/tmp/project',
            },
        });

        expect(response).toEqual({ action: 'accept' });
    });

    it('falls back to exec_approval_request metadata when elicitation params omit Codex fields', async () => {
        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
        };
        const client = new CodexMcpClient();
        client.setPermissionHandler(permissionHandler as any);

        await client.connect();

        expect(mockNotificationHandler.current).toBeTruthy();
        expect(mockRequestHandler.current).toBeTruthy();

        mockNotificationHandler.current!({
            params: {
                msg: {
                    type: 'exec_approval_request',
                    call_id: 'call_from_event',
                    command: ['/bin/zsh', '-lc', 'mkdir -p ../02-mobliecoding'],
                    cwd: '/tmp/project',
                },
            },
        });

        const response = await mockRequestHandler.current!({
            params: {
                message: 'Allow Codex to run mkdir?',
                requestedSchema: { type: 'object', properties: {} },
            },
        });

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'call_from_event',
            'CodexBash',
            {
                command: ['/bin/zsh', '-lc', 'mkdir -p ../02-mobliecoding'],
                cwd: '/tmp/project',
            },
        );
        expect(response).toEqual({ action: 'accept' });
    });

    it('falls back to patch approval metadata when elicitation params omit Codex fields', async () => {
        const permissionHandler = {
            handleToolCall: vi.fn().mockResolvedValue({ decision: 'approved' }),
        };
        const client = new CodexMcpClient();
        client.setPermissionHandler(permissionHandler as any);

        await client.connect();

        expect(mockNotificationHandler.current).toBeTruthy();
        expect(mockRequestHandler.current).toBeTruthy();

        mockNotificationHandler.current!({
            params: {
                msg: {
                    type: 'apply_patch_approval_request',
                    call_id: 'call_patch_event',
                    changes: {
                        '/tmp/project/README.md': {
                            type: 'add',
                            content: '# hello\n',
                        },
                    },
                },
            },
        });

        const response = await mockRequestHandler.current!({
            params: {
                message: 'Allow Codex to apply patch?',
                requestedSchema: { type: 'object', properties: {} },
            },
        });

        expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
            'call_patch_event',
            'CodexPatch',
            {
                changes: {
                    '/tmp/project/README.md': {
                        type: 'add',
                        content: '# hello\n',
                    },
                },
                autoApproved: undefined,
            },
        );
        expect(response).toEqual({ action: 'accept' });
    });
});
