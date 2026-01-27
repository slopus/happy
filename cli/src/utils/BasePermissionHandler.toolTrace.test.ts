import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';

class FakeRpcHandlerManager {
    handlers = new Map<string, (payload: any) => any>();
    registerHandler(_name: string, handler: any) {
        this.handlers.set(_name, handler);
    }
}

class FakeSession {
    sessionId = 'test-session-id';
    rpcHandlerManager = new FakeRpcHandlerManager();
    agentState: any = { requests: {}, completedRequests: {} };

    updateAgentState(updater: any) {
        this.agentState = updater(this.agentState);
        return this.agentState;
    }

    getAgentStateSnapshot() {
        return this.agentState;
    }
}

class TestPermissionHandler extends BasePermissionHandler {
    protected getLogPrefix(): string {
        return '[Test]';
    }

    request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
            this.addPendingRequestToState(toolCallId, toolName, input);
        });
    }
}

describe('BasePermissionHandler tool trace', () => {
    afterEach(() => {
        delete process.env.HAPPY_STACKS_TOOL_TRACE;
        delete process.env.HAPPY_STACKS_TOOL_TRACE_FILE;
        __resetToolTraceForTests();
    });

    it('records permission-request events when tool tracing is enabled', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-permissions-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const session = new FakeSession();
        const handler = new TestPermissionHandler(session as any, {
            toolTrace: { protocol: 'codex', provider: 'codex' },
        } as any);

        void handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });

        expect(existsSync(filePath)).toBe(true);
        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            v: 1,
            direction: 'outbound',
            sessionId: 'test-session-id',
            protocol: 'codex',
            provider: 'codex',
            kind: 'permission-request',
            payload: expect.objectContaining({
                type: 'permission-request',
                permissionId: 'perm-1',
                toolName: 'bash',
            }),
        });
    });

    it('records permission-response events when a permission is resolved', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'happy-tool-trace-permissions-'));
        const filePath = join(dir, 'tool-trace.jsonl');
        process.env.HAPPY_STACKS_TOOL_TRACE = '1';
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE = filePath;

        const session = new FakeSession();
        const handler = new TestPermissionHandler(session as any, {
            toolTrace: { protocol: 'codex', provider: 'codex' },
        } as any);

        const pending = handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });
        const rpcHandler = session.rpcHandlerManager.handlers.get('permission');
        expect(rpcHandler).toBeDefined();

        await rpcHandler?.({ id: 'perm-1', approved: true, decision: 'approved' });
        await pending;

        expect(existsSync(filePath)).toBe(true);
        const raw = readFileSync(filePath, 'utf8');
        const lines = raw.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[1])).toMatchObject({
            v: 1,
            direction: 'inbound',
            sessionId: 'test-session-id',
            protocol: 'codex',
            provider: 'codex',
            kind: 'permission-response',
            payload: {
                type: 'permission-response',
                permissionId: 'perm-1',
                approved: true,
                decision: 'approved',
            },
        });
    });
});
