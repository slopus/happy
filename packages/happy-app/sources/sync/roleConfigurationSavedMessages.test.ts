import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ records: new Map<string, string>(), current: true, id: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `receipt-${++mock.id}` }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (name: string) => name, accountRuntimeCurrent: () => mock.current }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'http://test' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/persistence/deviceStorage', () => ({
    MMKV: class {
        getString(key: string) { return mock.records.get(key); }
        getAllKeys() { return [...mock.records.keys()]; }
        set(key: string, value: string) { mock.records.set(key, value); }
    },
    writeDeviceStorage: async (disk: { set(key: string, value: string): void }, key: string, value: string) => { disk.set(key, value); },
    flushDeviceStorageWrites: async () => {},
}));
import { createRoleConfiguration, bindRoleConfigurationSession, getRoleConfigurationSavedHandoff } from './roleConfigurationHandoff';
import { observeRoleConfigurationRealtimeMessage, observeRoleConfigurationSavedMessages } from './roleConfigurationSavedMessages';
import { setFirstSubmissionScope } from './firstSubmissionScope';
import { createReducer, reducer } from './reducer/reducer';
import { normalizeRawMessage, type NormalizedMessage } from './typesRaw';
import type { Message, ToolCallMessage } from './typesMessage';
import type { Session } from './storageTypes';
import type { NewSessionDraft } from './persistence';

const launch: NewSessionDraft = { input: '', selectedMachineId: 'machine-1', selectedPath: '/repo', agentType: 'codex', permissionMode: 'yolo',
    modelMode: 'default', effortLevel: null, sessionType: 'simple', worktreeKey: null, updatedAt: 1 };
const request = { machineId: 'machine-1', clientRoleId: 'writer-id', draft: { name: 'Writer', description: 'Write a grounded README', agent: 'antigravity' as const, model: 'neon', autoDelegate: false } };
const role = { ...request.draft, id: request.clientRoleId, createdAt: 1, updatedAt: 2000 };
const session = (id: string, metadata: Partial<NonNullable<Session['metadata']>> = {}): Session => ({ id, seq: 1, createdAt: 1, updatedAt: 1,
    active: true, activeAt: 1, presence: "online", metadata: { path: '/repo', host: 'test', machineId: 'machine-1', ...metadata }, metadataVersion: 1,
    agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0 });
const sessions = () => ({ 'role-session': session('role-session') });

function receiptEvents(agent: 'codex' | 'antigravity' = 'codex', time = 1100): NormalizedMessage[] {
    const envelopes = [{ id: 'start', time, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-start', call: 'save-role', name: agent === 'codex' ? 'McpTool' : 'mcp__happy__agent_roles',
        title: 'happy.agent_roles', description: 'Save role', args: agent === 'codex'
            ? { server: 'happy', tool: 'agent_roles', arguments: { action: 'create', role: { id: role.id } } }
            : { action: 'create', role: { id: role.id } },
    } }, { id: 'end', time: time + 10, role: 'agent', turn: 'role-turn', ev: {
        t: 'tool-call-end', call: 'save-role', status: 'completed',
        mcpAppResult: { version: 1, state: 'available', content: [], structuredContent: { success: true, role } },
    } }];
    const normalized = envelopes.map((content, i) => normalizeRawMessage(`db-${i}`, null, content.time, { role: 'session', content } as never))
        .filter((value): value is NormalizedMessage => value !== null);
    return normalized;
}
function receiptMessages(agent: 'codex' | 'antigravity' = 'codex', time = 1100): Message[] { return reducer(createReducer(), receiptEvents(agent, time)).messages; }
async function bind() {
    const record = await createRoleConfiguration(request, launch);
    await bindRoleConfigurationSession(record.id, request.machineId, 'role-session');
    return record;
}
beforeEach(() => {
    vi.restoreAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(1000);
    mock.records.clear(); mock.current = true; mock.id = 0;
    setFirstSubmissionScope('owner-A', 'http://test');
});

describe('protocol saved-role receipts independent of result-card rendering', () => {
    it.each(['codex', 'antigravity'] as const)('acknowledges a reduced %s save after leaving the conversation', async agent => {
        await bind();
        // No React component is mounted: this is the reducer's applied batch.
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), receiptMessages(agent))).toBe(1);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toMatchObject({ sourceDraft: request.draft, savedRole: role });
    });
    it('does not acknowledge an unbound ordinary conversation or replay a consumed receipt', async () => {
        const messages = receiptMessages();
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), messages)).toBe(0);
        expect(mock.records.size).toBe(0);
        await bind();
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), messages)).toBe(1);
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), messages)).toBe(0);
    });
    it('does not let an old historical result consume a newer handoff revision', async () => {
        await bind();
        vi.spyOn(Date, 'now').mockReturnValue(1500);
        await createRoleConfiguration({ ...request, roleId: role.id, draft: { ...request.draft, description: 'New requirements' } }, launch);
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), receiptMessages())).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it('rejects another session, another machine and frozen account ownership', async () => {
        await bind();
        expect(observeRoleConfigurationSavedMessages('other-session', { 'other-session': session('other-session') }, receiptMessages())).toBe(0);
        expect(observeRoleConfigurationSavedMessages('role-session', { 'role-session': session('role-session', { machineId: 'other-machine' }) }, receiptMessages())).toBe(0);
        mock.current = false;
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), receiptMessages())).toBe(0);
        mock.current = true;
        setFirstSubmissionScope('owner-B', 'http://test');
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), receiptMessages())).toBe(0);
    });
    it('accepts verified conversation continuation receipts and rejects conflicting ownership', async () => {
        await bind();
        const continuation = {
            'role-session': session('role-session', { conversationActiveSessionId: 'worker' }),
            worker: session('worker', { conversationRootSessionId: 'role-session', continuationOfSessionId: 'role-session' }),
        };
        expect(observeRoleConfigurationSavedMessages('worker', continuation, receiptMessages())).toBe(1);
        await createRoleConfiguration({ ...request, roleId: role.id }, launch);
        expect(observeRoleConfigurationSavedMessages('worker', { ...continuation, worker: session('worker', { conversationRootSessionId: 'role-session', machineId: 'foreign' }) }, receiptMessages('codex', 1600))).toBe(0);
    });
    it('ignores assistant claims, running/error tools, reads and failed outputs', async () => {
        await bind();
        const tool = receiptMessages().find((message): message is ToolCallMessage => message.kind === 'tool-call')!;
        const invalid = [
            { ...tool, tool: { ...tool.tool, state: 'running' as const } },
            { ...tool, tool: { ...tool.tool, state: 'error' as const } },
            { ...tool, tool: { ...tool.tool, input: { server: 'happy', tool: 'agent_roles', arguments: { action: 'list' } } } },
            { ...tool, tool: { ...tool.tool, mcpAppResult: undefined, result: { success: false, role } } },
            { kind: 'agent-text' as const, id: 'claim', localId: null, createdAt: 1200, text: `Saved ${role.id}` },
        ];
        expect(observeRoleConfigurationSavedMessages('role-session', sessions(), invalid)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it.each(['historical-window', 'background-sequence-gap'])('observes realtime save pairs while %s skips all UI projection', async () => {
        await bind();
        const [start, end] = receiptEvents();
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(0);
        // Neither packet needs to reach the main transcript reducer/card.
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(1);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)?.savedRole).toEqual(role);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
    });
    it('drops a pending realtime pair when the role handoff revision changes', async () => {
        await bind();
        const [start, end] = receiptEvents();
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        await createRoleConfiguration({ ...request, roleId: role.id, draft: { ...request.draft, description: 'Later task' } }, launch);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it('drops pending realtime state across an account A → B → A incarnation', async () => {
        await bind();
        const [start, end] = receiptEvents();
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        setFirstSubmissionScope('owner-B', 'http://test'); setFirstSubmissionScope('owner-A', 'http://test');
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it('does not retain an unbound call or complete a pair after runtime freeze', async () => {
        const [start, end] = receiptEvents();
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        await bind();
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        setFirstSubmissionScope('owner-A', 'http://test');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        mock.current = false;
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        mock.current = true;
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
    });
    it('bounds pending role calls and releases completed state', async () => {
        await bind();
        const [start, end] = receiptEvents();
        if (start.role !== 'agent' || end.role !== 'agent') throw new Error('fixture must contain tool protocol');
        const call = start.content[0]; const output = end.content[0];
        if (call.type !== 'tool-call' || output.type !== 'tool-result') throw new Error('fixture must contain tool pair');
        for (let index = 0; index < 33; index++) observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...start, content: [{ ...call, id: `call-${index}` }] });
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, tool_use_id: 'call-0' }] })).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, tool_use_id: 'call-32' }] })).toBe(1);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, tool_use_id: 'call-32' }] })).toBe(0);
    });
    it('never tracks another session, wrong call ID, unrelated tools or denied results', async () => {
        await bind();
        const [start, end] = receiptEvents();
        observeRoleConfigurationRealtimeMessage('other-session', { 'other-session': session('other-session') }, start);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        if (start.role !== 'agent' || end.role !== 'agent') throw new Error('fixture must contain tool protocol');
        const call = start.content[0]; const output = end.content[0];
        if (call.type !== 'tool-call' || output.type !== 'tool-result') throw new Error('fixture must contain tool pair');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...start, content: [{ ...call, input: { server: 'other', tool: 'agent_roles', arguments: { action: 'create' } } }] });
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        setFirstSubmissionScope('owner-A', 'http://test');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, tool_use_id: 'wrong-call' }] })).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, permissions: { date: 1100, result: 'denied' } }] })).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it.each(['codex', 'antigravity'] as const)('pairs an early %s result with its later-decrypted start', async agent => {
        await bind();
        const [start, end] = receiptEvents(agent);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(1);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)?.savedRole).toEqual(role);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
    });
    it('does not pair an orphan result across a new handoff revision or account incarnation', async () => {
        await bind();
        const [start, end] = receiptEvents();
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), end);
        await createRoleConfiguration({ ...request, roleId: role.id, draft: { ...request.draft, description: 'New source draft' } }, launch);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
        setFirstSubmissionScope('owner-A', 'http://test');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), end);
        setFirstSubmissionScope('owner-B', 'http://test'); setFirstSubmissionScope('owner-A', 'http://test');
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
    });
    it('isolates a sidechain result with the same call ID from a root role call', async () => {
        await bind();
        const [start, end] = receiptEvents();
        if (end.role !== 'agent' || end.content[0].type !== 'tool-result') throw new Error('fixture must contain output');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, isSidechain: true, content: [{ ...end.content[0], parentUUID: 'child-agent' }] })).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(1);
    });
    it('rejects oversized results, bounds orphan results and releases failed pairs', async () => {
        await bind();
        const [start, end] = receiptEvents();
        if (start.role !== 'agent' || start.content[0].type !== 'tool-call' || end.role !== 'agent' || end.content[0].type !== 'tool-result') throw new Error('fixture must contain tool protocol');
        const call = start.content[0]; const output = end.content[0];
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), start);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, content: 'x'.repeat(128 * 1024) }] })).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        expect(getRoleConfigurationSavedHandoff('machine-1', role.id)).toBeNull();
        setFirstSubmissionScope('owner-A', 'http://test');
        observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, status: 'failed', is_error: true }] });
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), start)).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), end)).toBe(0);
        setFirstSubmissionScope('owner-A', 'http://test');
        for (let index = 0; index < 33; index++) observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...end, content: [{ ...output, tool_use_id: `orphan-${index}` }] });
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...start, content: [{ ...call, id: 'orphan-0' }] })).toBe(0);
        expect(observeRoleConfigurationRealtimeMessage('role-session', sessions(), { ...start, content: [{ ...call, id: 'orphan-32' }] })).toBe(1);
    });
});
