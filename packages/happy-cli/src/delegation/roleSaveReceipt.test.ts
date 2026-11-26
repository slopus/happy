import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleSaveReceipt } from './roleSaveReceipt';
import { delegationToolResponse } from './mcpTools';
import { CodexMcpAppAdapter } from '@/codex/mcpApps/CodexMcpAppAdapter';
import { mapCodexMcpMessageToSessionEnvelopes, mapCodexThreadToSessionEnvelopes } from '@/codex/utils/sessionProtocolMapper';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { handleToolCall, handleToolCallUpdate, type HandlerContext } from '@/agent/acp/sessionUpdateHandlers';
import { DefaultTransport } from '@/agent/transport';
import type { SessionEnvelope } from '@slopus/happy-wire';

const role = { id: 'technical-writer', name: 'Writer', description: 'Write technical documentation', agent: 'antigravity' as const,
    model: 'Neon', effort: 'High', autoDelegate: false, createdAt: 1, updatedAt: 2 };
const { createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = role;
const input = { action: 'create', role: draft };
const raw = delegationToolResponse({ success: true, role, roles: [role] });
const receipt = { version: 1, state: 'available', content: [], structuredContent: { success: true, role } };

describe('bounded first-party role-save receipt', () => {
    it('maps the real no-ui Codex MCP result to both live and replay tool-end events', () => {
        const item = { type: 'mcpToolCall' as const, id: 'save-role', server: 'happy', tool: 'agent_roles', status: 'completed', arguments: input, result: raw };
        const normalized = new CodexMcpAppAdapter().normalizeItem(item);
        expect(normalized.presentation).toBeUndefined();
        expect(normalized.result).toEqual(receipt);
        const live = mapCodexMcpMessageToSessionEnvelopes({ type: 'mcp_tool_call_end', status: 'completed', mcp_call: normalized }, { currentTurnId: 'turn' }).envelopes;
        const replay = mapCodexThreadToSessionEnvelopes({ turns: [{ id: 'turn', status: 'completed', startedAt: 1, completedAt: 2, items: [item] }] });
        expect(live.find(value => value.ev.t === 'tool-call-end')?.ev).toMatchObject({ mcpAppResult: receipt });
        expect(replay.find(value => value.ev.t === 'tool-call-end')?.ev).toMatchObject({ mcpAppResult: receipt });
        expect(JSON.stringify(normalized.result)).not.toContain('"roles"');
    });

    it.each([
        ['foreign', 'agent_roles', input, raw],
        ['happy', 'delegate_task', input, raw],
        ['happy', 'agent_roles', { action: 'list' }, raw],
        ['happy', 'agent_roles', { action: 'delete', roleId: role.id }, raw],
        ['happy', 'agent_roles', { action: 'save', role: draft }, raw],
        ['happy', 'agent_roles', { toolSummary: 'Create writer' }, raw],
        ['happy', 'agent_roles', input, { success: false, role }],
        ['happy', 'agent_roles', input, { success: true, role, isError: true }],
        ['happy', 'agent_roles', input, { success: true, role, status: 'denied' }],
        ['happy', 'agent_roles', input, { success: true, role, status: 'failed' }],
        ['happy', 'agent_roles', input, { success: true, role: { ...role, agent: 'unknown' } }],
        ['happy', 'agent_roles', { action: 'update', roleId: 'different-role', patch: { name: 'New name' } }, raw],
        ['happy', 'agent_roles', input, { content: [{ type: 'text', text: 'I saved the role.' }] }],
        ['happy', 'agent_roles', input, { content: [{ type: 'text', text: JSON.stringify({ success: true, role }) + ' '.repeat(65536) }] }],
        ['happy', 'agent_roles', input, { success: true, role: { ...role, description: 'x'.repeat(10001) } }],
    ])('rejects non-receipt case %#', (server, tool, request, result) => {
        expect(roleSaveReceipt(server as string, tool as string, request, result)).toBeUndefined();
    });

    it('does not carry a valid-looking role on a failed or denied Codex call', () => {
        const adapter = new CodexMcpAppAdapter();
        for (const status of ['failed', 'cancelled', 'denied', 'inProgress']) {
            expect(adapter.normalizeItem({ type: 'mcpToolCall', id: status, server: 'happy', tool: 'agent_roles', status, arguments: input, result: raw }).result).toBeUndefined();
        }
    });
});

afterEach(() => vi.useRealTimers());
describe('real ACP update → session mapper', () => {
    function run(title: string, result: unknown, status = 'completed', rawOutput = false) {
        vi.useFakeTimers();
        const mapper = new AcpSessionManager();
        const events: SessionEnvelope[] = mapper.startTurn();
        const ctx: HandlerContext = {
            transport: new DefaultTransport('antigravity'), activeToolCalls: new Set(),
            toolCallStartTimes: new Map(), toolCallTimeouts: new Map(), toolCallIdToNameMap: new Map(),
            idleTimeout: null, toolCallCountSincePrompt: 0,
            emit: message => events.push(...mapper.mapMessage(message)), emitIdleStatus: () => {},
            clearIdleTimeout: () => {}, setIdleTimeout: () => {},
        };
        handleToolCall({ toolCallId: 'native-role', kind: 'other', title, rawInput: { action: 'update', roleId: role.id, patch: { name: 'Writer' } } }, ctx);
        handleToolCallUpdate({ toolCallId: 'native-role', kind: 'other', status, ...(rawOutput ? { rawOutput: result } : { content: result }) }, ctx);
        return events;
    }
    it.each([false, true])('retains the actual happy result from ACP rawOutput=%s', rawOutput => {
        const content = rawOutput ? raw : [{ type: 'content', content: { type: 'text', text: JSON.stringify(raw) } }];
        const events = run('Run mcp_happy_agent_roles', content, 'completed', rawOutput);
        const start = events.find(value => value.ev.t === 'tool-call-start')!;
        const end = events.find(value => value.ev.t === 'tool-call-end')!;
        expect(start.ev).toMatchObject({ name: 'mcp__happy__agent_roles', args: { action: 'update', roleId: role.id } });
        expect(end.ev).toMatchObject({ call: 'call' in start.ev ? start.ev.call : null, mcpAppResult: receipt });
    });
    it.each([
        ['Run mcp_foreign_agent_roles', raw, 'completed'],
        ['Run mcp_happy_agent_roles extra', raw, 'completed'],
        ['Run mcp_happy_agent_roles', raw, 'failed'],
        ['Run mcp_happy_agent_roles', raw, 'cancelled'],
        ['Run mcp_happy_agent_roles', { isError: true, content: raw.content }, 'completed'],
        ['Run mcp_happy_agent_roles', { success: true, role, status: 'denied' }, 'completed'],
        ['Run mcp_happy_agent_roles', [{ type: 'content', content: { type: 'text', text: 'malformed' } }], 'completed'],
        ['Run mcp_happy_agent_roles', [{ type: 'content', content: { type: 'text', text: JSON.stringify({ success: true, role }) + ' '.repeat(65536) } }], 'completed'],
    ])('rejects ACP non-receipt %#', (title, result, status) => {
        const end = run(title as string, result, status as string).find(value => value.ev.t === 'tool-call-end')!;
        expect(end.ev).not.toHaveProperty('mcpAppResult');
    });
});
