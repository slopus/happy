import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import { PermissionHandler } from './permissionHandler';

class FakeRpcHandlerManager {
    handlers = new Map<string, (payload: any) => any>();
    registerHandler(_name: string, handler: any) {
        this.handlers.set(_name, handler);
    }
}

class FakeClient {
    sessionId = 'test-session-id';
    rpcHandlerManager = new FakeRpcHandlerManager();
    agentState: any = { requests: {}, completedRequests: {}, capabilities: {} };

    updateAgentState(updater: any) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getAgentStateSnapshot() {
        return this.agentState;
    }
}

function createFakeSession() {
    const client = new FakeClient();
    return {
        client,
        api: {
            push() {
                return { sendToAllDevices() {} };
            },
        },
    } as any;
}

describe('Claude PermissionHandler tool trace', () => {
    afterEach(() => {
        delete process.env.HAPPY_STACKS_TOOL_TRACE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_FILE;
        __resetToolTraceForTests();
    });

    it('records permission-request and permission-response when tool tracing is enabled', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-claude-permissions-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const session = createFakeSession();
        const handler = new PermissionHandler(session);

        const input = { file_path: '/etc/hosts' };
        handler.onMessage({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input }] },
        } as any);

        const controller = new AbortController();
        const permissionPromise = handler.handleToolCall('Read', input, { permissionMode: 'default' } as any, {
            signal: controller.signal,
        });

        await new Promise((r) => setTimeout(r, 0));
        handler.approveToolCall('toolu_1');

        await expect(permissionPromise).resolves.toMatchObject({ behavior: 'allow' });

        expect(existsSync(filePath)).toBe(true);
        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n').map((l) => JSON.parse(l));

        expect(lines).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    direction: 'outbound',
                    sessionId: 'test-session-id',
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'permission-request',
                    payload: expect.objectContaining({
                        type: 'permission-request',
                        permissionId: 'toolu_1',
                        toolName: 'Read',
                    }),
                }),
                expect.objectContaining({
                    direction: 'inbound',
                    sessionId: 'test-session-id',
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'permission-response',
                    payload: expect.objectContaining({
                        type: 'permission-response',
                        permissionId: 'toolu_1',
                        approved: true,
                    }),
                }),
            ]),
        );
    });
});
