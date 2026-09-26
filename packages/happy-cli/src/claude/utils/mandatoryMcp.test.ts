import { describe, it, expect, vi } from 'vitest';
import { request } from 'node:http';
import { startHappyServer } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';
import { BROWSER_TASK_TOOL_NAMES } from '@/browserRuntime/agentTools';

function rpc(socketPath: string, token: string, method: string, params: unknown = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, path: '/', method: 'POST', headers: {
            Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        } }, res => {
            let body = ''; res.on('data', data => { body += data; });
            res.on('end', () => resolve({ status: res.statusCode!, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    });
}

it('authenticates the Unix MCP endpoint and exposes exactly the mandatory browser tools', async () => {
    const client = { sessionId: 'synthetic-session', hasTitle: () => true } as ApiSessionClient;
    const previous = process.env.HAPPY_BROWSER_TASK_RUNTIME_URL;
    process.env.HAPPY_BROWSER_TASK_RUNTIME_URL = 'http://127.0.0.1:1';
    // Linux group permissions are exercised in the privileged container; the unit
    // transport test uses an isolated current-user socket on every developer OS.
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const server = await startHappyServer(client, { mandatorySandbox: true, proposeLesson: () => ({ accepted: false }) });
    try {
        expect(server.socketPath).toBeTruthy();
        const token = server.mcpConfig.env!.SAYCODE_MCP_TOKEN;
        expect((await rpc(server.socketPath!, 'wrong-synthetic', 'tools/list')).status).toBe(401);
        const response = await rpc(server.socketPath!, token, 'tools/list');
        expect(response.status).toBe(200);
        const payload = JSON.parse(response.body.slice(response.body.indexOf('data: ') + 6));
        expect(payload.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['change_title', ...BROWSER_TASK_TOOL_NAMES].sort());
        for (const name of ['bash_stream', 'script_automations', 'browser_tabs', 'propose_lesson']) {
            const result = await rpc(server.socketPath!, token, 'tools/call', { name, arguments: {} });
            expect(result.body).toMatch(/not found|Unknown tool/i);
        }
    } finally {
        server.stop();
        vi.unstubAllGlobals();
        if (previous === undefined) delete process.env.HAPPY_BROWSER_TASK_RUNTIME_URL;
        else process.env.HAPPY_BROWSER_TASK_RUNTIME_URL = previous;
    }
});
