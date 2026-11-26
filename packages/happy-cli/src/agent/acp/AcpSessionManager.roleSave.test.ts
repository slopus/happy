import { describe, expect, it } from 'vitest';
import { AcpSessionManager } from './AcpSessionManager';
import { boundedRoleSaveInput } from '@/delegation/roleSaveReceipt';
import type { SessionEnvelope } from '@slopus/happy-wire';

const role = { id: 'writer', name: 'Writer', description: 'Write verified facts', agent: 'codex' as const, autoDelegate: false, createdAt: 1, updatedAt: 2 };
const request = { action: 'update' as const, roleId: role.id, patch: { name: 'Writer' } };
const receipts = (events: SessionEnvelope[]) => events.filter(event => event.ev.t === 'tool-call-end' && event.ev.mcpAppResult);

describe('authoritative MCP save observation', () => {
    it('emits an independent bounded protocol pair without another tool execution or native output', () => {
        const mapper = new AcpSessionManager();
        const [turn] = mapper.startTurn();
        const receive = mapper.observeRoleSave(request)!;
        const events = receive(role);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ turn: turn.turn, ev: { t: 'tool-call-start', name: 'mcp__happy__agent_roles', args: request } });
        expect(events[1]).toMatchObject({ turn: turn.turn, ev: { t: 'tool-call-end', status: 'completed', mcpAppResult: {
            state: 'available', content: [], structuredContent: { success: true, role },
        } } });
        expect('call' in events[0].ev && 'call' in events[1].ev && events[0].ev.call === events[1].ev.call).toBe(true);
        expect(receive(role)).toEqual([]);
        expect(mapper.observeRoleSave(request)!(role)).toEqual([]);
    });

    it.each([true, false])('deduplicates role ID/revision with native-first=%s, including the exact AGY decorator', nativeFirst => {
        const mapper = new AcpSessionManager(); mapper.startTurn();
        const receive = mapper.observeRoleSave(request)!;
        const events = mapper.mapMessage({ type: 'tool-call', toolName: 'other', title: 'Run mcp_happy_agent_roles',
            callId: 'native', args: { ...request, toolSummary: 'Edit delegation role' } });
        const native = () => mapper.mapMessage({ type: 'tool-result', toolName: 'other', callId: 'native', result: { success: true, role } });
        events.push(...(nativeFirst ? native() : receive(role)), ...(nativeFirst ? receive(role) : native()));
        expect(receipts(events)).toHaveLength(1);
        expect(receipts(receive({ ...role, updatedAt: 3 }))).toHaveLength(1);
    });

    it.each(['invalidation', 'end', 'next-turn'])('does not publish a late completion after %s', change => {
        const mapper = new AcpSessionManager(); mapper.startTurn();
        const receive = mapper.observeRoleSave(request)!;
        if (change === 'invalidation') mapper.invalidateRoleSaveObservations();
        else { mapper.endTurn('cancelled'); if (change === 'next-turn') mapper.startTurn(); }
        expect(receive(role)).toEqual([]);
    });

    it('rejects malformed/oversized input and wrong or oversized role results', () => {
        const mapper = new AcpSessionManager(); mapper.startTurn();
        for (const input of [{ action: 'list' }, { ...request, unknown: true }, { ...request, toolSummary: 'Real MCP has no decorator' },
            { action: 'create', role: { ...role, description: 'x'.repeat(10001) } }]) {
            expect(mapper.observeRoleSave(input)).toBeUndefined();
        }
        const receive = mapper.observeRoleSave(request)!;
        expect(receive({ ...role, id: 'wrong' })).toEqual([]);
        expect(receive({ ...role, description: 'x'.repeat(10001) })).toEqual([]);
        expect(boundedRoleSaveInput({ ...request, toolSummary: { action: 'list' } }, true)).toBeUndefined();
        expect(boundedRoleSaveInput({ ...request, toolSummary: 'Display', unknown: true }, true)).toBeUndefined();
    });

    it('bounds pending native inputs and emitted revision memory until the next turn', () => {
        const mapper = new AcpSessionManager(); mapper.startTurn();
        for (let i = 0; i < 33; i++) mapper.mapMessage({ type: 'tool-call', toolName: 'mcp__happy__agent_roles', args: request, callId: `native-${i}` });
        expect(receipts(mapper.mapMessage({ type: 'tool-result', toolName: 'other', callId: 'native-32', result: { success: true, role } }))).toHaveLength(0);
        expect(receipts(mapper.mapMessage({ type: 'tool-result', toolName: 'other', callId: 'native-0', result: { success: true, role } }))).toHaveLength(1);
        const receive = mapper.observeRoleSave(request)!;
        let emitted = 0;
        for (let i = 3; i <= 131; i++) emitted += receipts(receive({ ...role, updatedAt: i })).length;
        expect(emitted).toBe(127);
        mapper.endTurn('completed'); mapper.startTurn();
        expect(receipts(mapper.observeRoleSave(request)!({ ...role, updatedAt: 132 }))).toHaveLength(1);
    });
});
