import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { DelegationResponse, SessionEnvelope } from '@slopus/happy-wire';
import { launchDelegationDaemonSession } from '@/daemon/controlClient';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { startHappyServer } from './startHappyServer';

vi.mock('@/daemon/controlClient', () => ({ launchIndependentDaemonSession: vi.fn(), launchDelegationDaemonSession: vi.fn() }));
const role = { id: 'writer', name: 'Writer', description: 'Write verified documentation', agent: 'codex' as const, autoDelegate: false, createdAt: 1, updatedAt: 2 };
const { createdAt: _created, updatedAt: _updated, ...draft } = role;
const request = { action: 'create', role: draft };

describe('real first-party MCP save observer', () => {
    beforeEach(() => { vi.mocked(launchDelegationDaemonSession).mockReset(); });
    async function connect(observer?: Parameters<typeof startHappyServer>[1]) {
        const server = await startHappyServer({ sessionId: 'parent' } as ApiSessionClient, observer);
        const client = new Client({ name: 'actual-role-save-test', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        return { client, close: async () => { await client.close(); server.stop(); } };
    }

    it('uses the actual durable daemon response even when AGY emits no output and only a display summary at start', async () => {
        const mapper = new AcpSessionManager();
        const events: SessionEnvelope[] = mapper.startTurn();
        events.push(...mapper.mapMessage({ type: 'tool-call', toolName: 'other', title: 'Run mcp_happy_agent_roles', callId: 'native', args: { toolSummary: 'Create role' } }));
        const observer = vi.fn((_parent, input) => { const receive = mapper.observeRoleSave(input)!; return (saved: unknown) => { events.push(...receive(saved)); }; });
        vi.mocked(launchDelegationDaemonSession).mockResolvedValue({ success: true, role, roles: [role] });
        const connection = await connect({ observeRoleSave: observer });
        try {
            const response = await connection.client.callTool({ name: 'agent_roles', arguments: request });
            expect(response.isError).toBe(false);
            expect(observer).toHaveBeenCalledWith('parent', request);
            expect(launchDelegationDaemonSession).toHaveBeenCalledExactlyOnceWith('parent', { action: 'roles-create', role: draft, protocolVersion: 2 }, undefined);
            events.push(...mapper.mapMessage({ type: 'tool-result', toolName: 'other', callId: 'native', result: undefined }));
            const receipts = events.filter(event => event.ev.t === 'tool-call-end' && event.ev.mcpAppResult);
            expect(receipts).toHaveLength(1);
            expect(receipts[0].ev).toMatchObject({ mcpAppResult: { structuredContent: { success: true, role } } });
            expect(JSON.stringify(receipts)).not.toContain('"roles"');
        } finally { await connection.close(); }
    });

    it.each(['failed', 'denied', 'missing-role', 'malformed-role', 'wrong-id', 'oversize', 'throw'])('does not observe a %s daemon result', async kind => {
        const finish = vi.fn(); const observer = vi.fn(() => finish);
        let response: unknown = { success: true, role };
        if (kind === 'failed') response = { success: false, role };
        if (kind === 'denied') response = { success: true, role, error: 'Permission denied' };
        if (kind === 'missing-role') response = { success: true, roles: [role] };
        if (kind === 'malformed-role') response = { success: true, role: { ...role, agent: 'unknown' } };
        if (kind === 'wrong-id') response = { success: true, role: { ...role, id: 'unrelated' } };
        if (kind === 'oversize') response = { success: true, role: { ...role, description: 'x'.repeat(10001) } };
        if (kind === 'throw') vi.mocked(launchDelegationDaemonSession).mockRejectedValue(new Error('Actual persistence failure'));
        else vi.mocked(launchDelegationDaemonSession).mockResolvedValue(response as DelegationResponse);
        const connection = await connect({ observeRoleSave: observer });
        try {
            const result = await connection.client.callTool({ name: 'agent_roles', arguments: request });
            if (kind === 'throw') expect(result.isError).toBe(true);
            expect(launchDelegationDaemonSession).toHaveBeenCalledOnce();
            expect(finish).not.toHaveBeenCalled();
        } finally { await connection.close(); }
    });

    it.each(['factory', 'sync-completion', 'async-completion'])('preserves the successful mutation when the observer throws at %s', async failure => {
        vi.mocked(launchDelegationDaemonSession).mockResolvedValue({ success: true, role });
        const observer = vi.fn(() => {
            if (failure === 'factory') throw new Error('Observation could not start');
            return failure === 'async-completion' ? async () => { throw new Error('Async observation failure'); } : () => { throw new Error('Observation failure'); };
        });
        const connection = await connect({ observeRoleSave: observer });
        try {
            const response = await connection.client.callTool({ name: 'agent_roles', arguments: request });
            expect(response.isError).toBe(false);
            expect(launchDelegationDaemonSession).toHaveBeenCalledOnce();
            expect(observer).toHaveBeenCalledOnce();
        } finally { await connection.close(); }
    });

    it('observes update but never list/delete/legacy save or another delegation tool', async () => {
        vi.mocked(launchDelegationDaemonSession).mockResolvedValue({ success: true, role });
        const finish = vi.fn(); const observer = vi.fn(() => finish);
        const connection = await connect({ observeRoleSave: observer });
        try {
            for (const args of [{ action: 'list' }, { action: 'delete', roleId: role.id }, { action: 'save', role: draft }]) {
                await connection.client.callTool({ name: 'agent_roles', arguments: args });
            }
            await connection.client.callTool({ name: 'read_delegated_task', arguments: { taskId: 'task' } });
            expect(observer).not.toHaveBeenCalled();
            await connection.client.callTool({ name: 'agent_roles', arguments: { action: 'update', roleId: role.id, patch: { name: role.name } } });
            expect(observer).toHaveBeenCalledExactlyOnceWith('parent', { action: 'update', roleId: role.id, patch: { name: role.name } });
            expect(finish).toHaveBeenCalledExactlyOnceWith(role);
        } finally { await connection.close(); }
    });

    it('does not invent an observer for other callers, including the existing Codex path', async () => {
        vi.mocked(launchDelegationDaemonSession).mockResolvedValue({ success: true, role });
        const connection = await connect();
        try { expect((await connection.client.callTool({ name: 'agent_roles', arguments: request })).isError).toBe(false); }
        finally { await connection.close(); }
    });
});
