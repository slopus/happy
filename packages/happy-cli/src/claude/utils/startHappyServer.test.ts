import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createChangeTitleHandler, startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

function makeFakeClient(hasTitle: boolean) {
    return {
        hasTitle: vi.fn(() => hasTitle),
        sendClaudeSessionMessage: vi.fn(),
        updateMetadata: vi.fn()
    } as unknown as ApiSessionClient;
}

async function callTool(serverUrl: string, id: number, name: string, args: Record<string, unknown>) {
    const response = await fetch(serverUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
        }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    return JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw);
}

describe('createChangeTitleHandler', () => {
    it('sets the title when the session has none yet', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('Fix login bug');

        expect(result).toEqual({ success: true });
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'summary', summary: 'Fix login bug' })
        );
    });

    it('locks the title once one already exists, ignoring later change_title calls', async () => {
        const client = makeFakeClient(true);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('A newer title the model came up with');

        expect(result.success).toBe(false);
        expect(client.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });

    it('stores the branchSlug in session metadata alongside the title', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('Fix login bug', 'fix-login-bug');

        expect(result).toEqual({ success: true });
        expect(client.updateMetadata).toHaveBeenCalledTimes(1);
        const updater = (client.updateMetadata as any).mock.calls[0][0];
        expect(updater({ summary: { text: 'Fix login bug', updatedAt: 1 } })).toEqual({
            summary: { text: 'Fix login bug', updatedAt: 1, branchSlug: 'fix-login-bug' }
        });
    });

    it('does not touch metadata when no branchSlug is supplied', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        await changeTitle('Fix login bug');

        expect(client.updateMetadata).not.toHaveBeenCalled();
    });

    it('ignores a blank branchSlug rather than storing whitespace', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        await changeTitle('Fix login bug', '   ');

        expect(client.updateMetadata).not.toHaveBeenCalled();
    });

    it('trims the branchSlug before storing it', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        await changeTitle('Fix login bug', '  fix-login-bug\n');
        const updater = (client.updateMetadata as any).mock.calls[0][0];

        expect(updater({ summary: { text: 'Fix login bug', updatedAt: 1 } }).summary.branchSlug)
            .toBe('fix-login-bug');
    });

    // The summary write is a separate, fire-and-forget updateMetadata call that
    // silently gives up on a hard error, so branchSlug can land on metadata that
    // has no summary yet. Writing only { branchSlug } there would leave a summary
    // object missing its required text/updatedAt.
    it('writes a complete summary when metadata has no summary yet', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        await changeTitle('Fix login bug', 'fix-login-bug');
        const updater = (client.updateMetadata as any).mock.calls[0][0];
        const summary = updater({}).summary;

        expect(summary.text).toBe('Fix login bug');
        expect(typeof summary.updatedAt).toBe('number');
        expect(summary.branchSlug).toBe('fix-login-bug');
    });
});

describe('startHappyServer tool registration', () => {
    // The MCP server is rebuilt per request, so a malformed tool schema does
    // not fail at startup — it breaks every tool in the session at call time.
    // Listing the tools over the real transport is what catches that.
    it('serves every happy tool over tools/list', async () => {
        const client = { hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            const response = await fetch(server.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            });
            expect(response.status).toBe(200);

            const raw = await response.text();
            const payload = JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw);
            const names = payload.result.tools.map((tool: { name: string }) => tool.name);

            expect(names).toEqual(expect.arrayContaining([
                'change_title',
                'script_automations',
                'bash_stream',
                'browser_tabs',
                'browser_snapshot',
                'browser_screenshot',
                'browser_click',
                'browser_fill',
                'browser_scroll',
                'browser_navigate',
                'browser_open_tab',
                'browser_close_tab',
                'browser_capabilities',
            ]));
            expect(names).toEqual(expect.arrayContaining(server.toolNames));
        } finally {
            server.stop();
        }
    });

    it('rejects a zero browser scroll before reaching the daemon', async () => {
        const client = { hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            const payload = await callTool(server.url, 2, 'browser_scroll', { deltaX: 0, deltaY: 0 });
            expect(payload.result.isError).toBe(true);
            expect(payload.result.content[0].text).toMatch(/non-zero/i);
        } finally {
            server.stop();
        }
    });

    it('rejects an unbounded browser scroll in the MCP schema', async () => {
        const client = { hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            const payload = await callTool(server.url, 3, 'browser_scroll', { deltaY: 10_001 });
            expect(payload.result.isError).toBe(true);
            expect(payload.result.content[0].text).toContain('10000');
        } finally {
            server.stop();
        }
    });

    it('rejects an empty browser scroll ref in the MCP schema', async () => {
        const client = { hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            const payload = await callTool(server.url, 4, 'browser_scroll', { ref: '', deltaY: 300 });
            expect(payload.result.isError).toBe(true);
            expect(payload.result.content[0].text).toMatch(/>=1 characters|at least 1 character/i);
        } finally {
            server.stop();
        }
    });

    it('forwards branchSlug from a real tools/call through to the handler', async () => {
        const updateMetadata = vi.fn();
        const client = {
            hasTitle: () => false,
            sendClaudeSessionMessage: vi.fn(),
            updateMetadata,
            sessionId: 'test'
        } as unknown as ApiSessionClient;
        const server = await startHappyServer(client);
        try {
            // Assert the slug the caller sent is the one that gets stored — a bare
            // "updateMetadata was called" check still passes if the tool wires the
            // wrong argument (e.g. the title) into the handler's slug parameter.
            const payload = await callTool(server.url, 1, 'change_title', { title: 'Fix login bug', branchSlug: 'fix-login-bug' });
            expect(payload.result.isError).toBe(false);

            expect(updateMetadata).toHaveBeenCalledTimes(1);
            const updater = updateMetadata.mock.calls[0][0];
            expect(updater({}).summary.branchSlug).toBe('fix-login-bug');
        } finally {
            server.stop();
        }
    });

    it('forces protected bash_stream writes into the active turn workspace', async () => {
        const fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-protected-mcp-'));
        const originalPath = join(fixtureRoot, 'original');
        const workspacePath = join(fixtureRoot, 'workspace');
        await Promise.all([mkdir(originalPath), mkdir(workspacePath)]);
        const client = {
            hasTitle: () => false,
            sendClaudeSessionMessage: vi.fn(),
            sessionId: 'test',
        } as unknown as ApiSessionClient;
        const trackProtectedBashProcess = vi.fn();
        const server = await startHappyServer(client, {
            protectedBashCwd: () => workspacePath,
            trackProtectedBashProcess,
        });
        try {
            const payload = await callTool(server.url, 5, 'bash_stream', {
                command: 'printf isolated > mutation.txt; pwd',
                cwd: originalPath,
            });

            expect(payload.result.isError).toBe(false);
            const reportedCwd = payload.result.content[0].text.split('\n')[0];
            await expect(realpath(reportedCwd)).resolves.toBe(await realpath(workspacePath));
            await expect(readFile(join(workspacePath, 'mutation.txt'), 'utf8')).resolves.toBe('isolated');
            await expect(readFile(join(originalPath, 'mutation.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect(trackProtectedBashProcess).toHaveBeenCalledOnce();
            expect(trackProtectedBashProcess.mock.calls[0][0].pid).toEqual(expect.any(Number));
        } finally {
            server.stop();
            await rm(fixtureRoot, { recursive: true, force: true });
        }
    });
});


describe('foreground lesson proposal tool', () => {
    it('only exposes the tool when the provider supplies a turn-bound handler', async () => {
        const without = await startHappyServer(makeFakeClient(false));
        try { expect(without.toolNames).not.toContain('propose_lesson'); } finally { without.stop(); }
        const handler = vi.fn(() => ({ accepted: false }));
        const server = await startHappyServer(makeFakeClient(false), { proposeLesson: handler });
        try {
            expect(server.toolNames).toContain('propose_lesson');
            const token = 'b96f00e6-112e-4a8d-8117-23f28d3f9e34';
            const response = await callTool(server.url, 1, 'propose_lesson', { token, proposal: { name: 'Verified' } });
            expect(handler).toHaveBeenCalledWith({ token, proposal: { name: 'Verified' } });
            expect(JSON.parse(response.result.content[0].text)).toEqual({ accepted: false });
        } finally { server.stop(); }
    });
});

describe('browser task runtime PoC flag', () => {
    async function listNames(url: string): Promise<string[]> {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        const raw = await response.text();
        const payload = JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw);
        return payload.result.tools.map((tool: { name: string }) => tool.name);
    }
    const client = () => ({ hasTitle: () => false, sendClaudeSessionMessage: vi.fn(), sessionId: 'test' } as unknown as ApiSessionClient);

    it('keeps legacy browser tools and no browser_task tools without the flag', async () => {
        vi.stubEnv('HAPPY_BROWSER_TASK_RUNTIME_URL', '');
        const server = await startHappyServer(client());
        try {
            const names = await listNames(server.url);
            expect(names).toContain('browser_tabs');
            expect(names.some((n) => n.startsWith('browser_task_'))).toBe(false);
        } finally {
            server.stop();
            vi.unstubAllEnvs();
        }
    });

    it('takes the broker session secret out of the environment so spawned children never inherit it', async () => {
        vi.stubEnv('HAPPY_BROWSER_TASK_RUNTIME_URL', 'http://127.0.0.1:1');
        vi.stubEnv('HAPPY_BROWSER_TASK_BROKER_SOCKET', '/nonexistent/broker.sock');
        vi.stubEnv('HAPPY_BROWSER_TASK_SESSION_SECRET', 'synthetic-session-secret');
        const server = await startHappyServer(client());
        try {
            expect(process.env.HAPPY_BROWSER_TASK_SESSION_SECRET).toBeUndefined();
            expect(server.toolNames).toContain('browser_task_submit_batch');
        } finally {
            server.stop();
            vi.unstubAllEnvs();
        }
    });

    it('replaces legacy browser tools with browser_task tools when the flag is set', async () => {
        vi.stubEnv('HAPPY_BROWSER_TASK_RUNTIME_URL', 'http://127.0.0.1:1');
        vi.stubEnv('HAPPY_BROWSER_TASK_GRANT_FILE', '/nonexistent/grant');
        const server = await startHappyServer(client());
        try {
            const names = await listNames(server.url);
            expect(names).toContain('browser_task_submit_batch');
            expect(names.filter((n) => n.startsWith('browser_') && !n.startsWith('browser_task_'))).toEqual([]);
            expect(server.toolNames).toContain('browser_task_submit_batch');
            expect(server.toolNames).not.toContain('browser_tabs');
        } finally {
            server.stop();
            vi.unstubAllEnvs();
        }
    });
});
