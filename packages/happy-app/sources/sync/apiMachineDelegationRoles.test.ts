import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineDelegationRole, deleteMachineDelegationRole, listMachineDelegationRoles, machineDelegationRolesRequest, updateMachineDelegationRole } from './apiDelegation';
import { MachineMetadataSchema, MetadataSchema } from './storageTypes';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), account: { key: 'a', generation: 'one', serverUrl: 'https://example.test' },
    state: { machines: {} as Record<string, any>, sessions: {} } }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: mocks.rpc } }));
vi.mock('./storage', () => ({ storage: { getState: () => mocks.state } }));
vi.mock('@/auth/accountRuntime', () => ({ assertAccountRuntime: () => {}, getRuntimeAccountSelection: () => mocks.account }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const input = { name: 'Writer', description: 'Write documentation only', agent: 'antigravity' as const, autoDelegate: false };
const role = { ...input, id: 'generated-id', createdAt: 1, updatedAt: 1 };

beforeEach(() => {
    vi.clearAllMocks(); mocks.account = { key: 'a', generation: 'one', serverUrl: 'https://example.test' };
    mocks.state = { sessions: {}, machines: { machine: { id: 'machine', active: true, metadata: { delegation: 1, delegationRoles: 1 } } } };
});

describe('machine-only role configuration', () => {
    it('preserves the role-management capability when reading machine metadata', () => {
        expect(MachineMetadataSchema.parse({ delegationRoles: 1, host: 'host', platform: 'darwin', happyCliVersion: 'test', happyHomeDir: '/fixture', homeDir: '/fixture' }).delegationRoles).toBe(1);
    });
    it('preserves default/temporary route snapshots in V2 while retaining strict V1 metadata projections', () => {
        const task = { id: 'task-temp', parentSessionId: 'parent', title: 'Write', roleName: 'AGY native', agent: 'antigravity',
            version: 1, status: 'running', startedAt: 1, updatedAt: 1, resultAvailable: false };
        const metadata = { path: '/fixture', host: 'host', capabilities: { delegation: 1, delegationRoutes: 1 },
            delegationV2: { version: 2, roles: [role], tasks: [task] } };
        expect(MetadataSchema.parse(metadata)).toMatchObject(metadata);
        expect(() => MetadataSchema.parse({ ...metadata, delegationRoles: [role] })).toThrow();
        expect(() => MetadataSchema.parse({ ...metadata, delegatedTasks: [task] })).toThrow();
        const v1Role = { ...role, model: 'known-model' };
        const v1Task = { ...task, roleId: role.id, model: 'known-model' };
        expect(MetadataSchema.parse({ ...metadata, delegationRoles: [v1Role], delegatedTasks: [v1Task] }).delegationV2?.tasks[0]).not.toHaveProperty('model');
    });
    it('lists roles without any session and uses the machine configuration RPC', async () => {
        mocks.rpc.mockResolvedValue({ success: true, roles: [role] });
        expect(await listMachineDelegationRoles('machine')).toEqual([role]);
        expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('machine', 'delegation-roles', { action: 'list' }, { isCurrent: expect.any(Function) });
    });
    it('creates a native-default role without inventing an ID/model or dispatching a task', async () => {
        mocks.rpc.mockResolvedValue({ success: true, role, roles: [role] });
        expect(await createMachineDelegationRole('machine', input)).toEqual({ role, roles: [role] });
        expect(mocks.rpc.mock.calls[0][2]).toEqual({ action: 'create', role: input });
        expect(mocks.rpc.mock.calls[0][2].role).not.toHaveProperty('id');
        expect(mocks.rpc.mock.calls[0][2].role).not.toHaveProperty('model');
    });
    it('updates by immutable role ID and explicitly clears model/effort to the native default', async () => {
        const updated = { ...role, name: 'Editor', updatedAt: 2 };
        mocks.rpc.mockResolvedValue({ success: true, role: updated, roles: [updated] });
        expect((await updateMachineDelegationRole('machine', role.id, { name: 'Editor', model: null, effort: null })).role).toEqual(updated);
        expect(mocks.rpc.mock.calls[0][2]).toEqual({ action: 'update', roleId: role.id, patch: { name: 'Editor', model: null, effort: null } });
    });
    it('requires a matching durable role and latest list before acknowledging create/update', async () => {
        for (const reply of [{ success: true, roles: [] }, { success: true, role, roles: [] },
            { success: true, role: { ...role, name: 'Wrong' }, roles: [{ ...role, name: 'Wrong' }] }]) {
            mocks.rpc.mockResolvedValue(reply);
            await expect(createMachineDelegationRole('machine', input)).rejects.toThrow('delegation.roleSettingsInvalidResponse');
        }
        mocks.rpc.mockResolvedValue({ success: true, role: { ...role, id: 'foreign' }, roles: [{ ...role, id: 'foreign' }] });
        await expect(updateMachineDelegationRole('machine', role.id, { name: 'Writer' })).rejects.toThrow('delegation.roleSettingsInvalidResponse');
    });
    it('confirms deletion from the returned role list and rejects duplicate IDs', async () => {
        mocks.rpc.mockResolvedValue({ success: true, roles: [role] });
        await expect(deleteMachineDelegationRole('machine', role.id)).rejects.toThrow('delegation.roleSettingsInvalidResponse');
        mocks.rpc.mockResolvedValue({ success: true, roles: [] });
        expect(await deleteMachineDelegationRole('machine', role.id)).toEqual([]);
        mocks.rpc.mockResolvedValue({ success: true, roles: [role, role] });
        await expect(listMachineDelegationRoles('machine')).rejects.toThrow('delegation.roleSettingsInvalidResponse');
    });
    it('refuses an offline or old machine before sending; delegation alone does not authorize role CRUD', async () => {
        mocks.state.machines.machine.active = false;
        await expect(listMachineDelegationRoles('machine')).rejects.toThrow('delegation.offline');
        mocks.state.machines.machine.active = true; delete mocks.state.machines.machine.metadata.delegationRoles;
        await expect(createMachineDelegationRole('machine', input)).rejects.toThrow('delegation.rolesProtocolHint');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('fences encryption-time emission and late results after account/machine changes', async () => {
        let resolve!: (value: unknown) => void;
        mocks.rpc.mockImplementation(() => new Promise(done => { resolve = done; }));
        const pending = listMachineDelegationRoles('machine');
        const guard = mocks.rpc.mock.calls[0][3].isCurrent;
        expect(guard()).toBe(true);
        mocks.account = { ...mocks.account, generation: 'two' };
        expect(guard()).toBe(false);
        resolve({ success: true, roles: [role] });
        await expect(pending).rejects.toThrow('delegation.roleSettingsOwnerChanged');
    });
    it('validates the strict machine contract and does not accept task replies', async () => {
        await expect(machineDelegationRolesRequest('machine', { action: 'update', roleId: role.id, patch: { id: 'other' } } as any)).rejects.toThrow();
        expect(mocks.rpc).not.toHaveBeenCalled();
        mocks.rpc.mockResolvedValue({ success: false, error: 'duplicate role ID' });
        await expect(createMachineDelegationRole('machine', input)).rejects.toThrow('duplicate role ID');
    });
});
