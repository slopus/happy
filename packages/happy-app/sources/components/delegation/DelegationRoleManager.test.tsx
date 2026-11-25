import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { DelegationRoleManager } from './DelegationRoleManager';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), confirm: vi.fn(), refreshCatalog: vi.fn(),
    machines: [] as any[], sessions: [] as any[], scope: { key: 'account-a', serverUrl: 'https://example.test' } as { key: string; serverUrl: string } | null,
    owner: { key: 'account-a', generation: 'one', serverUrl: 'https://example.test' }, listeners: new Set<() => void>(), catalog: null as any,
    status: 'connected' as 'disconnected' | 'connecting' | 'connected' | 'error', statusListeners: new Set<(status: string) => void>() }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Switch: 'Switch', Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'web', select: (value: any) => value.web ?? value.default } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/Item', () => ({ Item: 'Item' }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ colors: { text: 'text', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider', surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected' } }) },
    useUnistyles: () => ({ theme: { colors: { text: 'text', textSecondary: 'secondary' } } }) }));
vi.mock('@/text', () => ({ t: (key: string, params?: unknown) => params ? `${key}:${JSON.stringify(params)}` : key }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/sync/storage', () => ({ useAllMachines: () => mocks.machines, useAllSessions: () => mocks.sessions }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mocks.owner }));
vi.mock('@/sync/firstSubmissionScope', () => ({ getFirstSubmissionScope: () => mocks.scope,
    subscribeFirstSubmissionScope: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('@/sync/apiDelegation', () => ({ listMachineDelegationRoles: mocks.list, createMachineDelegationRole: mocks.create, updateMachineDelegationRole: mocks.update, deleteMachineDelegationRole: mocks.remove }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { onStatusChange: (listener: (status: string) => void) => {
    mocks.statusListeners.add(listener); listener(mocks.status); return () => mocks.statusListeners.delete(listener);
} } }));
vi.mock('@/hooks/useMagpieModelCatalog', () => ({ useMagpieModelCatalog: () => ({ catalog: mocks.catalog, refresh: mocks.refreshCatalog }) }));
const role = { id: 'writer-id', name: 'Writer', description: 'Write documentation', agent: 'antigravity' as const, model: 'native-exact', effort: 'high', autoDelegate: true, createdAt: 1, updatedAt: 2 };
const machine = (id: string) => ({ id, active: true, metadata: { host: id, homeDir: '/fixture', delegationRoles: 1 } });

describe('role settings independent from live sessions', () => {
    let renderer: any;
    const find = (testID: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID)[0];
    const press = async (testID: string) => { await act(async () => { find(testID).props.onPress(); }); };
    const edit = (testID: string, value: string) => act(() => { find(testID).props.onChangeText(value); });
    const render = async (id = 'machine-a') => { await act(async () => { renderer = TestRenderer.create(<DelegationRoleManager initialMachineId={id} />); }); };
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
        mocks.machines = [machine('machine-a'), machine('machine-b')]; mocks.sessions = []; mocks.catalog = null;
        mocks.status = 'connected'; mocks.statusListeners.clear();
        mocks.scope = { key: 'account-a', serverUrl: 'https://example.test' }; mocks.owner = { ...mocks.scope, generation: 'one' };
        mocks.list.mockResolvedValue([role]); mocks.confirm.mockResolvedValue(true); mocks.remove.mockResolvedValue([]);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

    it('creates with an auto-generated stable ID and native defaults; saving does not dispatch', async () => {
        const created = { id: 'server-generated', name: 'New writer', description: 'Write README', agent: 'antigravity', autoDelegate: false, createdAt: 3, updatedAt: 3 };
        mocks.create.mockResolvedValue({ role: created, roles: [role, created] });
        await render();
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('machine-a');
        expect(find('delegation-settings-auto').props.value).toBe(false);
        expect(find('delegation-settings-id').props.subtitle).toBe('delegation.idGenerated');
        edit('delegation-settings-name', created.name); edit('delegation-settings-description', created.description);
        await press('delegation-settings-save');
        expect(mocks.create).toHaveBeenCalledExactlyOnceWith('machine-a', { name: created.name, description: created.description, agent: 'antigravity', model: undefined, effort: undefined, autoDelegate: false });
        expect(find('delegation-settings-id').props).toMatchObject({ subtitle: created.id, copy: created.id });
        expect(mocks.update).not.toHaveBeenCalled();
    });
    it('waits for socket connection after cached machine hydration and refreshes once per reconnect', async () => {
        mocks.status = 'disconnected';
        await render();
        expect(mocks.list).not.toHaveBeenCalled();
        expect(find('delegation-settings-save').props.disabled).toBe(true);
        await act(async () => {
            mocks.status = 'connecting'; mocks.statusListeners.forEach(listener => listener('connecting'));
        });
        expect(mocks.list).not.toHaveBeenCalled();
        await act(async () => {
            mocks.status = 'connected'; mocks.statusListeners.forEach(listener => listener('connected'));
        });
        expect(mocks.list).toHaveBeenCalledTimes(1);
        expect(find('delegation-settings-role-writer-id')).toBeDefined();
        await act(async () => { mocks.statusListeners.forEach(listener => listener('connected')); });
        expect(mocks.list).toHaveBeenCalledTimes(1);
        await act(async () => {
            mocks.status = 'disconnected'; mocks.statusListeners.forEach(listener => listener('disconnected'));
        });
        edit('delegation-settings-name', 'Keep reconnect draft');
        await act(async () => {
            mocks.status = 'connected'; mocks.statusListeners.forEach(listener => listener('connected'));
        });
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(find('delegation-settings-name').props.value).toBe('Keep reconnect draft');
    });
    it('ignores a pre-disconnect result after a reconnect query has returned', async () => {
        let first!: (value: unknown) => void;
        mocks.list.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
        await render();
        await act(async () => {
            mocks.status = 'disconnected'; mocks.statusListeners.forEach(listener => listener('disconnected'));
        });
        const latest = { ...role, id: 'reconnected-role' };
        mocks.list.mockResolvedValueOnce([latest]);
        await act(async () => {
            mocks.status = 'connected'; mocks.statusListeners.forEach(listener => listener('connected'));
        });
        await act(async () => { first([role]); });
        expect(mocks.list).toHaveBeenCalledTimes(2);
        expect(find('delegation-settings-role-reconnected-role')).toBeDefined();
        expect(find('delegation-settings-role-writer-id')).toBeUndefined();
    });
    it('retains failed edits and separate new-role drafts, then clears defaults explicitly on update', async () => {
        await render();
        edit('delegation-settings-name', 'Keep my new role');
        await press('delegation-settings-role-writer-id');
        edit('delegation-settings-name', 'Edited writer'); edit('delegation-settings-model', ''); edit('delegation-settings-effort', '');
        mocks.update.mockRejectedValueOnce(new Error('Save rejected'));
        await press('delegation-settings-save');
        expect(find('delegation-settings-name').props.value).toBe('Edited writer');
        expect(find('delegation-settings-error').children.join('')).toBe('Save rejected');
        await press('delegation-settings-new');
        expect(find('delegation-settings-name').props.value).toBe('Keep my new role');
        await press('delegation-settings-role-writer-id');
        expect(find('delegation-settings-name').props.value).toBe('Edited writer');
        const updated = { ...role, name: 'Edited writer', model: undefined, effort: undefined };
        mocks.update.mockResolvedValueOnce({ role: updated, roles: [updated] });
        await press('delegation-settings-save');
        expect(mocks.update.mock.calls.at(-1)).toEqual(['machine-a', role.id, { name: 'Edited writer', description: role.description, agent: role.agent, model: null, effort: null, autoDelegate: true }]);
    });
    it('edits and deletes a real role whose ID is new, without confusing it with an unsaved role', async () => {
        const namedNew = { ...role, id: 'new' };
        mocks.list.mockResolvedValue([namedNew]);
        await render(); await press('delegation-settings-role-new');
        expect(find('delegation-settings-id').props).toMatchObject({ subtitle: 'new', copy: 'new' });
        edit('delegation-settings-name', 'Edited real new role');
        const updated = { ...namedNew, name: 'Edited real new role' };
        mocks.update.mockResolvedValue({ role: updated, roles: [updated] });
        await press('delegation-settings-save');
        expect(mocks.update.mock.calls[0][1]).toBe('new');
        expect(mocks.create).not.toHaveBeenCalled();
        await press('delegation-settings-delete');
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('machine-a', 'new');
        expect(find('delegation-settings-id').props.subtitle).toBe('delegation.idGenerated');
    });
    it('protects unsaved edits when deleting is cancelled and retains the unrelated new draft after deletion', async () => {
        await render(); edit('delegation-settings-name', 'Unrelated new draft');
        await press('delegation-settings-role-writer-id'); edit('delegation-settings-description', 'Unsaved purpose');
        mocks.confirm.mockResolvedValueOnce(false);
        await press('delegation-settings-delete');
        expect(mocks.confirm.mock.calls[0][1]).toContain('delegation.discardOnDelete');
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(find('delegation-settings-description').props.value).toBe('Unsaved purpose');
        await press('delegation-settings-delete');
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('machine-a', role.id);
        expect(find('delegation-settings-name').props.value).toBe('Unrelated new draft');
    });
    it('ignores a late list result after changing machines and preserves the old machine draft', async () => {
        let resolveA!: (value: unknown) => void;
        mocks.list.mockImplementation((id: string) => id === 'machine-a' ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve([{ ...role, id: 'b-role', name: 'Machine B writer' }]));
        await render(); edit('delegation-settings-name', 'Machine A draft');
        await press('delegation-machine-picker'); await press('delegation-machine-machine-b');
        await act(async () => { resolveA([role]); });
        expect(find('delegation-settings-role-writer-id')).toBeUndefined();
        expect(find('delegation-settings-role-b-role')).toBeDefined();
        mocks.list.mockResolvedValue([role]);
        await press('delegation-machine-picker'); await press('delegation-machine-machine-a');
        expect(find('delegation-settings-name').props.value).toBe('Machine A draft');
    });
    it('keeps the selected role and unsaved edits after a failed deletion', async () => {
        await render(); await press('delegation-settings-role-writer-id');
        edit('delegation-settings-description', 'Keep this responsibility');
        mocks.remove.mockRejectedValueOnce(new Error('Delete rejected'));
        await press('delegation-settings-delete');
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id);
        expect(find('delegation-settings-description').props.value).toBe('Keep this responsibility');
        expect(find('delegation-settings-role-writer-id')).toBeDefined();
        expect(find('delegation-settings-error').children.join('')).toBe('Delete rejected');
    });
    it('does not delete a role after its confirmation completes on another machine', async () => {
        let confirm!: (approved: boolean) => void;
        mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
        await render(); await press('delegation-settings-role-writer-id');
        await press('delegation-settings-delete');
        await press('delegation-machine-picker'); await press('delegation-machine-machine-b');
        await act(async () => { confirm(true); });
        expect(mocks.remove).not.toHaveBeenCalled();
        expect(find('delegation-settings-name').props.value).toBe('');
    });
    it('ignores a late save and clears account-owned drafts after an account change', async () => {
        let resolveSave!: (value: unknown) => void;
        mocks.create.mockImplementation(() => new Promise(resolve => { resolveSave = resolve; }));
        await render(); edit('delegation-settings-name', 'Private A'); edit('delegation-settings-description', 'Account A responsibility');
        await press('delegation-settings-save');
        mocks.list.mockResolvedValue([]);
        await act(async () => {
            mocks.scope = { key: 'account-b', serverUrl: 'https://example.test' }; mocks.owner = { ...mocks.scope, generation: 'two' };
            mocks.listeners.forEach(listener => listener());
        });
        const foreign = { ...role, id: 'a-late', name: 'Private A' };
        await act(async () => { resolveSave({ role: foreign, roles: [foreign] }); });
        expect(find('delegation-settings-name').props.value).toBe('');
        expect(find('delegation-settings-role-a-late')).toBeUndefined();
        expect(find('delegation-settings-notice')).toBeUndefined();
    });
    it('removes account-owned fields and makes no new role query when the account scope is cleared', async () => {
        await render(); edit('delegation-settings-name', 'Private draft');
        const reads = mocks.list.mock.calls.length;
        await act(async () => { mocks.scope = null; mocks.listeners.forEach(listener => listener()); });
        expect(find('delegation-settings-name')).toBeUndefined();
        expect(find('delegation-settings-role-writer-id')).toBeUndefined();
        expect(mocks.list).toHaveBeenCalledTimes(reads);
    });
    it.each([{ active: false, metadata: { delegationRoles: 1 } }, { active: true, metadata: { delegation: 1 } }])('does not read or save roles on an offline/old machine: %j', async state => {
        mocks.machines = [{ ...machine('machine-a'), ...state }];
        await render(); edit('delegation-settings-name', 'Keep offline draft');
        expect(mocks.list).not.toHaveBeenCalled();
        expect(find('delegation-settings-save').props.disabled).toBe(true);
        expect(find('delegation-settings-name').props.value).toBe('Keep offline draft');
    });
    it('shows only model suggestions observed for the same machine and executor', async () => {
        mocks.sessions = [{ metadata: { machineId: 'machine-a', flavor: 'codex', models: [{ code: 'codex-only', value: 'Codex model' }] } },
            { metadata: { machineId: 'machine-a', flavor: 'antigravity', models: [{ code: 'agy-only', value: 'AGY model', supportedEffortLevels: ['high'] }] } },
            { metadata: { machineId: 'machine-b', flavor: 'antigravity', models: [{ code: 'foreign-model', value: 'Other machine' }] } }];
        await render();
        const chooser = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === 'delegation.chooseModel');
        act(() => chooser.props.onPress());
        expect(find('delegation-model-agy-only')).toBeDefined();
        expect(find('delegation-model-codex-only')).toBeUndefined();
        expect(find('delegation-model-foreign-model')).toBeUndefined();
    });
});
