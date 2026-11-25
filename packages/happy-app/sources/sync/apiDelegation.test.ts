import { beforeEach, describe, expect, it, vi } from 'vitest';
import { delegationRequest, listDelegationRoles, readDelegatedTask, saveDelegationRole } from './apiDelegation';
import { MachineMetadataSchema, MetadataSchema } from './storageTypes';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    account: { key: 'account-a', generation: 'generation-a', serverUrl: 'https://example.test' },
    state: { sessions: {} as Record<string, any>, machines: {} as Record<string, any> },
}));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: mocks.rpc } }));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => {}, getRuntimeAccountSelection: () => mocks.account }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const role = { id: 'writer', name: 'Writer', description: 'Write factual documentation', agent: 'antigravity' as const, model: 'exact-model-code', autoDelegate: true };
const summary = { id: 'task-a', parentSessionId: 'parent-a', title: 'Write the README', roleId: role.id, roleName: role.name, agent: role.agent, model: role.model,
    version: 2, status: 'completed' as const, startedAt: 1000, updatedAt: 3000, finishedAt: 3000, resultAvailable: true };
const task = { ...summary, prompt: 'Make the existing draft shorter', history: [{ version: 1, prompt: 'Write a README', status: 'completed' as const, startedAt: 1000, updatedAt: 2000,
    result: { text: 'Version one', truncated: false } }], result: { text: 'Version two', truncated: false } };

beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.account = { key: 'account-a', generation: 'generation-a', serverUrl: 'https://example.test' };
    mocks.state = { sessions: { 'parent-a': { metadata: { machineId: 'machine-a', capabilities: { delegation: 1 } } } }, machines: { 'machine-a': { active: true, metadata: { delegation: 1 } } } };
});

describe('parent-scoped delegation RPC', () => {
    it('lists the daemon roles once and supplies the real parent machine and session', async () => {
        mocks.rpc.mockResolvedValue({ success: true, roles: [{ ...role, createdAt: 1, updatedAt: 2 }] });
        expect(await listDelegationRoles('parent-a')).toMatchObject([{ id: role.id, model: role.model }]);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('machine-a', 'delegation', { action: 'roles-list', parentSessionId: 'parent-a' });
    });
    it('does not contact an offline or older daemon', async () => {
        mocks.state.machines['machine-a'].active = false;
        await expect(listDelegationRoles('parent-a')).rejects.toThrow('delegation.offline');
        mocks.state.machines['machine-a'].active = true;
        mocks.state.machines['machine-a'].metadata = {};
        await expect(listDelegationRoles('parent-a')).rejects.toThrow('delegation.unsupported');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('does not contact an upgraded daemon on behalf of an old parent worker', async () => {
        mocks.state.sessions['parent-a'].metadata.capabilities = {};
        await expect(listDelegationRoles('parent-a')).rejects.toThrow('delegation.protocolHint');
        await expect(saveDelegationRole('parent-a', role)).rejects.toThrow('delegation.protocolHint');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('does not report a role saved without a matching durable role acknowledgement', async () => {
        mocks.rpc.mockResolvedValue({ success: true });
        await expect(saveDelegationRole('parent-a', role)).rejects.toThrow('delegation.invalidResponse');
        mocks.rpc.mockResolvedValue({ success: false, error: 'Target model is unavailable' });
        await expect(saveDelegationRole('parent-a', role)).rejects.toThrow('Target model is unavailable');
    });
    it('keeps versioned results and refuses another parent or task record', async () => {
        mocks.rpc.mockResolvedValue({ success: true, task });
        expect((await readDelegatedTask('parent-a', 'task-a')).history[0].version).toBe(1);
        mocks.rpc.mockResolvedValue({ success: true, task: { ...task, parentSessionId: 'parent-b' } });
        await expect(readDelegatedTask('parent-a', 'task-a')).rejects.toThrow('delegation.invalidResponse');
        mocks.rpc.mockResolvedValue({ success: true, task: { ...task, id: 'task-b' } });
        await expect(readDelegatedTask('parent-a', 'task-a')).rejects.toThrow('delegation.invalidResponse');
    });
    it('rejects a late result after account or parent-machine changes', async () => {
        let resolve!: (value: unknown) => void;
        mocks.rpc.mockImplementation(() => new Promise(done => { resolve = done; }));
        const pending = listDelegationRoles('parent-a');
        mocks.account = { ...mocks.account, generation: 'generation-b' };
        resolve({ success: true, roles: [] });
        await expect(pending).rejects.toThrow('delegation.ownerChanged');
        const moved = listDelegationRoles('parent-a');
        mocks.state.sessions['parent-a'].metadata.machineId = 'machine-b';
        resolve({ success: true, roles: [] });
        await expect(moved).rejects.toThrow('delegation.ownerChanged');
    });
    it('does not treat an accepted cancellation request as completed', async () => {
        mocks.rpc.mockResolvedValue({ success: true, task: { ...task, status: 'running', cancelRequested: true } });
        const result = await delegationRequest('parent-a', { action: 'cancel', taskId: 'task-a' });
        expect(result.task).toMatchObject({ status: 'running', cancelRequested: true });
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });
});

describe('delegation metadata retention', () => {
    it('retains negotiated capabilities and typed roles/tasks instead of stripping them', () => {
        const metadata = MetadataSchema.parse({ path: '/project', host: 'test-host', delegationProtocol: 1, capabilities: { delegation: 1 },
            delegationRoles: [{ ...role, createdAt: 1, updatedAt: 2 }], delegatedTasks: [summary] });
        expect(metadata.capabilities?.delegation).toBe(1);
        expect(metadata.delegationRoles?.[0].model).toBe(role.model);
        expect(metadata.delegatedTasks?.[0]).toEqual(summary);
        const machine = MachineMetadataSchema.parse({ host: 'test-host', platform: 'darwin', happyCliVersion: '1.0', happyHomeDir: '/app', homeDir: '/home', delegation: 1 });
        expect(machine.delegation).toBe(1);
    });
});
