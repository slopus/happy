import { describe, expect, it, vi } from 'vitest';
import { CodexPermissionHandler } from '../utils/permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

function createSessionMock() {
    let state: Record<string, any> = {};
    const sendSessionNotification = vi.fn();
    const metadata = {
        path: '/Users/test/project',
        host: 'test-host',
        homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happy',
        happyLibDir: '/Users/test/.happy/lib',
        happyToolsDir: '/Users/test/.happy/tools',
    };

    return {
        session: {
            sessionId: 'session-123',
            getMetadata: vi.fn(() => metadata),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: vi.fn((updater: (currentState: Record<string, any>) => Record<string, any>) => {
                state = updater(state);
                return state;
            }),
        },
        getState: () => state,
        sendSessionNotification,
        metadata,
    };
}

describe('CodexPermissionHandler', () => {
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

    it('auto-approves the current-session archive tool', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'archive_session-1765385846663',
            'archive_session',
            { reason: 'Task complete' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests['archive_session-1765385846663']).toMatchObject({
            tool: 'archive_session',
            arguments: { reason: 'Task complete' },
            status: 'approved',
            decision: 'approved',
        });
    });

    it('auto-approves the first-party send_image tool by exact name', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_send_image_123',
            'mcp__happy__send_image',
            { path: '/tmp/render.png' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_send_image_123).toMatchObject({
            tool: 'mcp__happy__send_image',
            arguments: { path: '/tmp/render.png' },
            status: 'approved',
            decision: 'approved',
        });
    });

    it('auto-approves the first-party send_file tool by exact name', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_send_file_123',
            'mcp__happy__send_file',
            { path: '/tmp/acceptance.mp4' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_send_file_123).toMatchObject({
            tool: 'mcp__happy__send_file',
            status: 'approved',
        });
    });

    it('auto-approves the first-party browser-step reporter', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const result = await handler.handleToolCall(
            'call_report_browser_step_123',
            'mcp__happy__report_browser_step',
            { path: '/tmp/ego-step.png', label: '打开订单详情' },
        );

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests.call_report_browser_step_123).toMatchObject({
            tool: 'mcp__happy__report_browser_step',
            arguments: { path: '/tmp/ego-step.png', label: '打开订单详情' },
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

    it('sends a permission notification when a Codex tool waits for user approval', async () => {
        const { session, metadata, sendSessionNotification } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any, sendSessionNotification);

        const pending = handler.handleToolCall(
            'call_exec_notify',
            'CodexBash',
            { command: ['pnpm', 'test'], cwd: '/Users/test/project' },
        );

        expect(sendSessionNotification).toHaveBeenCalledTimes(1);
        expect(sendSessionNotification).toHaveBeenCalledWith({
            kind: 'permission',
            metadata,
            data: {
                sessionId: 'session-123',
                requestId: 'call_exec_notify',
                tool: 'CodexBash',
                type: 'permission_request',
                provider: 'codex',
            },
        });

        handler.abortAll();

        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('auto-approves all tools in yolo mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);
        handler.setPermissionMode('yolo');

        const result = await handler.handleToolCall(
            'call_patch_123',
            'CodexPatch',
            { changes: [{ path: 'file.ts', diff: '...' }] },
        );

        expect(result).toEqual({ decision: 'approved_for_session' });
        expect(getState().completedRequests.call_patch_123).toMatchObject({
            tool: 'CodexPatch',
            status: 'approved',
            decision: 'approved_for_session',
        });
        expect(getState().requests).toBeUndefined();
    });

    it('approves an already-pending request when switching into yolo mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_patch_pending',
            'CodexPatch',
            { changes: [{ path: 'file.ts', diff: '...' }] },
        );

        expect(getState().requests.call_patch_pending).toMatchObject({
            tool: 'CodexPatch',
        });

        handler.setPermissionMode('yolo');

        await expect(pending).resolves.toEqual({ decision: 'approved_for_session' });
        expect(getState().requests).toEqual({});
        expect(getState().completedRequests.call_patch_pending).toMatchObject({
            tool: 'CodexPatch',
            status: 'approved',
            decision: 'approved_for_session',
        });
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

    it('does NOT auto-approve a crafted tool name containing archive_session as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_malicious_archive_1',
            'archive_session_and_run_command',
            { reason: 'pwn', cmd: 'rm -rf /' },
        );

        handler.abortAll();
        await expect(pending).resolves.toEqual({ decision: 'abort' });
    });

    it('does NOT auto-approve a crafted tool name containing send_image as substring', async () => {
        const { session } = createSessionMock();
        const handler = new CodexPermissionHandler(session as any);

        const pending = handler.handleToolCall(
            'call_malicious_2',
            'send_image_and_run_command',
            { path: '/tmp/render.png', cmd: 'rm -rf /' },
        );

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
});
