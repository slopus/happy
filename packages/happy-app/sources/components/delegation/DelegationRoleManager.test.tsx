import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { DelegationRoleManager } from './DelegationRoleManager';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), confirm: vi.fn(), refreshCatalog: vi.fn(), clipboard: vi.fn(), configure: vi.fn(), randomUUID: vi.fn(), modalShow: vi.fn(), modalHide: vi.fn(),
    machines: [] as any[], sessions: [] as any[], scope: { key: 'account-a', serverUrl: 'https://example.test' } as { key: string; serverUrl: string } | null,
    owner: { key: 'account-a', generation: 'one', serverUrl: 'https://example.test' }, listeners: new Set<() => void>(), catalog: null as any,
    status: 'connected' as 'disconnected' | 'connecting' | 'connected' | 'error', statusListeners: new Set<(status: string) => void>() }));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Switch: 'Switch', Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'web', select: (value: any) => value.web ?? value.default } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.randomUUID }));
vi.mock('expo-clipboard', () => ({ setStringAsync: mocks.clipboard }));
vi.mock('./RoleModelPicker', () => ({ RoleModelPicker: 'RoleModelPicker' }));
vi.mock('./roleConfigurationNavigation', () => ({ openRoleConfiguration: mocks.configure }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/Item', () => ({ Item: (props: any) => React.createElement('Item', props, props.rightElement) }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ colors: { text: 'text', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider', surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected' } }) },
    useUnistyles: () => ({ theme: { colors: { text: 'text', textSecondary: 'secondary' } } }) }));
vi.mock('@/text', () => ({ t: (key: string, params?: unknown) => params ? `${key}:${JSON.stringify(params)}` : key }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm, show: mocks.modalShow, hide: mocks.modalHide } }));
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


let generation = 0;
describe('role management workflow', () => {
    let renderer: any;
    const find = (id: string) => renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
    const press = async (id: string) => { await act(async () => { find(id).props.onPress(); }); };
    const edit = (id: string, value: string) => act(() => { find(id).props.onChangeText(value); });
    const render = async (id = 'machine-a', roleId?: string) => { await act(async () => { renderer = TestRenderer.create(<DelegationRoleManager initialMachineId={id} initialRoleId={roleId} />); }); };
    const create = async () => press('delegation-settings-new');
    const details = async (id = role.id) => press(`delegation-settings-role-${id}`);
    const editing = async (id = role.id) => { await details(id); await press('delegation-settings-edit'); };
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
        mocks.machines = [machine('machine-a'), machine('machine-b')]; mocks.sessions = []; mocks.catalog = null;
        mocks.status = 'connected'; mocks.statusListeners.clear();
        mocks.scope = { key: 'account-a', serverUrl: 'https://example.test' }; mocks.owner = { ...mocks.scope, generation: String(++generation) };
        mocks.list.mockResolvedValue([role]); mocks.confirm.mockResolvedValue(true); mocks.remove.mockResolvedValue([]);
        mocks.modalShow.mockReturnValue('model-modal'); mocks.randomUUID.mockReturnValue('client-role-id'); mocks.clipboard.mockResolvedValue(true); mocks.configure.mockResolvedValue(undefined);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });
    it('starts with a searchable list, then read-only detail and explicit edit', async () => {
        await render(); expect(find('delegation-settings-name')).toBeUndefined();
        edit('delegation-settings-search', 'absent'); expect(find('delegation-settings-role-writer-id')).toBeUndefined();
        await press('delegation-settings-clear-search'); edit('delegation-settings-search', 'documentation'); await details();
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id); expect(find('delegation-settings-name')).toBeUndefined();
        await press('delegation-settings-edit'); expect(find('delegation-settings-name').props.value).toBe(role.name);
    });
    it('creates in two steps with validation, back preservation and native defaults', async () => {
        const created = { ...role, id: 'client-role-id', name: 'New writer', description: 'Write README', model: undefined, effort: undefined, autoDelegate: false };
        mocks.create.mockResolvedValue({ role: created, roles: [role, created] }); await render(); await create();
        await press('delegation-settings-next'); expect(find('delegation-settings-auto')).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
        edit('delegation-settings-name', created.name); edit('delegation-settings-description', created.description); await press('delegation-settings-next');
        expect(find('delegation-settings-name')).toBeUndefined(); expect(find('delegation-settings-auto').props.value).toBe(false);
        await press('delegation-settings-back'); expect(find('delegation-settings-name').props.value).toBe(created.name);
        await press('delegation-settings-next'); await press('delegation-settings-save');
        expect(mocks.create.mock.calls[0]).toEqual(['machine-a', expect.objectContaining({ name: created.name, description: created.description, agent: 'antigravity', model: undefined, effort: undefined, autoDelegate: false })]);
        expect(find('delegation-settings-id').props.subtitle).toBe(created.id); expect(find('delegation-settings-name')).toBeUndefined(); expect(mocks.configure).not.toHaveBeenCalled();
    });
    it('protects an unsaved create draft when cancelling from the second step', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Draft'); edit('delegation-settings-description', 'Purpose'); await press('delegation-settings-next');
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-cancel'); expect(find('delegation-settings-auto')).toBeDefined();
        await press('delegation-settings-cancel'); expect(find('delegation-settings-search')).toBeDefined(); await create(); expect(find('delegation-settings-name').props.value).toBe('');
    });
    it('retains failed edits and clears model/effort explicitly without changing ID', async () => {
        await render(); await editing(); await press('delegation-settings-advanced');
        edit('delegation-settings-name', 'Edited'); edit('delegation-settings-model', ''); edit('delegation-settings-effort', '');
        mocks.update.mockRejectedValueOnce(new Error('Save rejected')); await press('delegation-settings-save');
        expect(find('delegation-settings-name').props.value).toBe('Edited'); expect(find('delegation-settings-error').children.join('')).toBe('Save rejected');
        const updated = { ...role, name: 'Edited', model: undefined, effort: undefined }; mocks.update.mockResolvedValueOnce({ role: updated, roles: [updated] });
        await press('delegation-settings-save'); expect(mocks.update.mock.calls.at(-1)).toEqual(['machine-a', role.id, { name: 'Edited', description: role.description, agent: role.agent, model: null, effort: null, autoDelegate: true }]);
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id);
    });
    it('does not mistake a real ID named new for an unsaved role', async () => {
        const named = { ...role, id: 'new' }; mocks.list.mockResolvedValue([named]); await render(); await editing('new'); edit('delegation-settings-name', 'Edited real new');
        const updated = { ...named, name: 'Edited real new' }; mocks.update.mockResolvedValue({ role: updated, roles: [updated] }); await press('delegation-settings-save');
        expect(mocks.update.mock.calls[0][1]).toBe('new'); expect(mocks.create).not.toHaveBeenCalled(); await press('delegation-settings-delete'); expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('machine-a', 'new');
    });
    it('names the exact deletion target, preserves cancellation/failure, and cancels stale confirmations', async () => {
        await render(); await details(); mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-delete');
        expect(mocks.confirm.mock.calls[0][1]).toContain(role.name); expect(mocks.remove).not.toHaveBeenCalled();
        mocks.remove.mockRejectedValueOnce(new Error('Delete rejected')); await press('delegation-settings-delete');
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id); expect(find('delegation-settings-error').children.join('')).toBe('Delete rejected');
        let confirm!: (value: boolean) => void; mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; })); await press('delegation-settings-delete');
        await press('delegation-machine-picker'); await press('delegation-machine-machine-b'); await act(async () => { confirm(true); }); expect(mocks.remove).toHaveBeenCalledTimes(1);
    });
    it('waits for socket readiness and preserves a draft through reconnect', async () => {
        mocks.status = 'disconnected'; await render(); await create(); edit('delegation-settings-name', 'Reconnect draft'); expect(mocks.list).not.toHaveBeenCalled();
        await act(async () => { mocks.status = 'connected'; mocks.statusListeners.forEach(listener => listener('connected')); }); expect(mocks.list).toHaveBeenCalledTimes(1);
        await act(async () => { mocks.status = 'disconnected'; mocks.statusListeners.forEach(listener => listener('disconnected')); });
        await act(async () => { mocks.status = 'connected'; mocks.statusListeners.forEach(listener => listener('connected')); });
        expect(mocks.list).toHaveBeenCalledTimes(2); expect(find('delegation-settings-name').props.value).toBe('Reconnect draft');
    });
    it('isolates machine drafts and ignores a save after the account changes', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Private A');
        await press('delegation-machine-picker'); await press('delegation-machine-machine-b'); await create(); expect(find('delegation-settings-name').props.value).toBe('');
        await press('delegation-machine-picker'); await press('delegation-machine-machine-a'); expect(find('delegation-settings-name').props.value).toBe('Private A');
        edit('delegation-settings-description', 'Private purpose'); await press('delegation-settings-next');
        let resolveSave!: (value: unknown) => void; mocks.create.mockImplementationOnce(() => new Promise(resolve => { resolveSave = resolve; })); await press('delegation-settings-save'); mocks.list.mockResolvedValue([]);
        await act(async () => { mocks.scope = { key: 'account-b', serverUrl: 'https://example.test' }; mocks.owner = { ...mocks.scope, generation: 'changed' }; mocks.listeners.forEach(listener => listener()); });
        await act(async () => { resolveSave({ role: { ...role, id: 'late' }, roles: [{ ...role, id: 'late' }] }); });
        expect(find('delegation-settings-role-late')).toBeUndefined(); expect(find('delegation-settings-name')).toBeUndefined();
    });
    it('drops visible account-owned fields when the scope is cleared', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Private'); const reads = mocks.list.mock.calls.length;
        await act(async () => { mocks.scope = null; mocks.listeners.forEach(listener => listener()); });
        expect(find('delegation-settings-name')).toBeUndefined(); expect(find('delegation-settings-role-writer-id')).toBeUndefined(); expect(mocks.list).toHaveBeenCalledTimes(reads);
    });
    it.each([{ active: false, metadata: { delegationRoles: 1 } }, { active: true, metadata: { delegation: 1 } }])('allows an offline/old-machine draft but disables save and AI: %j', async value => {
        mocks.machines = [{ ...machine('machine-a'), ...value }]; await render(); await create(); edit('delegation-settings-name', 'Offline'); edit('delegation-settings-description', 'Purpose');
        expect(find('delegation-settings-ai').props.disabled).toBe(true); await press('delegation-settings-next'); expect(find('delegation-settings-save').props.disabled).toBe(true); expect(mocks.list).not.toHaveBeenCalled();
    });
    it('shows only model suggestions for the current machine and executor', async () => {
        mocks.sessions = [{ metadata: { machineId: 'machine-a', flavor: 'codex', models: [{ code: 'codex-only', value: 'Codex model' }] } }, { metadata: { machineId: 'machine-a', flavor: 'antigravity', models: [{ code: 'agy-only', value: 'AGY model' }] } }, { metadata: { machineId: 'machine-b', flavor: 'antigravity', models: [{ code: 'foreign', value: 'Foreign' }] } }];
        await render(); await create(); edit('delegation-settings-name', 'Role'); edit('delegation-settings-description', 'Purpose'); await press('delegation-settings-next'); await press('delegation-settings-model-picker');
        expect(mocks.modalShow.mock.calls[0][0].props.models).toEqual([{ code: 'agy-only', value: 'AGY model' }]);
        expect(find('delegation-model-agy-only')).toBeUndefined();
        act(() => mocks.modalShow.mock.calls[0][0].props.onSelect('agy-only'));
        expect(find('delegation-settings-model-picker').props.detail).toBe('AGY model');
    });
    it('copies in place without the Item copy modal or a page notice', async () => {
        await render(); await details(); await press('delegation-settings-copy-id'); expect(mocks.clipboard).toHaveBeenCalledExactlyOnceWith(role.id);
        expect(find('delegation-settings-copy-id-status').children.join('')).toBe('delegation.copiedInline'); expect(find('delegation-settings-id').props.copy).toBeUndefined(); expect(find('delegation-settings-notice')).toBeUndefined();
        mocks.clipboard.mockRejectedValueOnce(new Error('Blocked')); await press('delegation-settings-copy-example'); expect(find('delegation-settings-copy-example-status').children.join('')).toBe('delegation.copyFailedInline');
    });
    it('hands the exact machine, stable ID and partial draft to the normal conversation', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Technical writing'); await press('delegation-settings-ai');
        expect(mocks.configure.mock.calls[0][1]).toMatchObject({ machineId: 'machine-a', draft: { name: 'Technical writing', description: '', agent: 'antigravity', autoDelegate: false } });
        await press('delegation-settings-cancel'); await editing(); edit('delegation-settings-description', 'Adjusted purpose'); await press('delegation-settings-ai');
        expect(mocks.configure.mock.calls[1][1]).toMatchObject({ machineId: 'machine-a', roleId: role.id, draft: { description: 'Adjusted purpose', model: role.model, effort: role.effort } }); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    });
    it('restores an unfinished form after a conversation visit and clears it on account reincarnation', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Retained'); act(() => renderer.unmount()); renderer = undefined; await render(); expect(find('delegation-settings-name').props.value).toBe('Retained');
        await act(async () => { mocks.owner = { ...mocks.owner, generation: 'new-incarnation' }; mocks.scope = { ...mocks.scope! }; mocks.listeners.forEach(listener => listener()); }); expect(find('delegation-settings-name')).toBeUndefined();
    });
    it('refreshes a clean edit and its baseline after returning from AI configuration', async () => {
        await render(); await editing(); await press('delegation-settings-ai');
        act(() => renderer.unmount()); renderer = undefined;
        const updated = { ...role, name: 'AI writer', description: 'Updated by AI', updatedAt: 3 };
        mocks.list.mockResolvedValue([updated]); await render();
        expect(find('delegation-settings-name').props.value).toBe(updated.name);
        expect(find('delegation-settings-description').props.value).toBe(updated.description);
        await press('delegation-settings-cancel');
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id);
    });
    it('preserves a dirty edit across AI updates and asks before overwriting the remote configuration', async () => {
        await render(); await editing(); edit('delegation-settings-description', 'My unsaved purpose');
        await press('delegation-settings-ai'); act(() => renderer.unmount()); renderer = undefined;
        const remote = { ...role, name: 'AI renamed writer', description: 'Remote purpose', updatedAt: 3 };
        mocks.list.mockResolvedValue([remote]); await render();
        expect(find('delegation-settings-name').props.value).toBe(role.name);
        expect(find('delegation-settings-description').props.value).toBe('My unsaved purpose');
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-save');
        expect(mocks.confirm).toHaveBeenLastCalledWith('delegation.roleChangedTitle', 'delegation.roleChangedHint', {
            confirmText: 'files.overwrite', cancelText: 'common.cancel', destructive: true,
        });
        expect(mocks.update).not.toHaveBeenCalled();
        expect(find('delegation-settings-description').props.value).toBe('My unsaved purpose');
        const overwritten = { ...role, description: 'My unsaved purpose', updatedAt: 4 };
        mocks.update.mockResolvedValue({ role: overwritten, roles: [overwritten] }); await press('delegation-settings-save');
        expect(mocks.update).toHaveBeenCalledExactlyOnceWith('machine-a', role.id, expect.objectContaining({ name: role.name, description: 'My unsaved purpose' }));
        expect(find('delegation-settings-id').props.subtitle).toBe(role.id);
    });
    it('retains an older dirty edit when a result deep link first returns to detail', async () => {
        await render(); await editing(); edit('delegation-settings-name', 'Unsaved local name');
        await press('delegation-settings-ai'); act(() => renderer.unmount()); renderer = undefined;
        mocks.list.mockResolvedValue([{ ...role, name: 'AI name', updatedAt: 3 }]); await render('machine-a', role.id);
        expect(find('delegation-settings-name')).toBeUndefined();
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe('Unsaved local name');
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-save');
        expect(mocks.confirm.mock.calls.at(-1)?.[0]).toBe('delegation.roleChangedTitle');
        expect(mocks.update).not.toHaveBeenCalled();
    });
    it('reuses the AI-reserved weak ID when the user returns to finish creation manually', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Technical writer'); await press('delegation-settings-ai');
        const request = mocks.configure.mock.calls[0][1]; expect(request.clientRoleId).toBe('client-role-id'); expect(request.roleId).toBeUndefined();
        act(() => renderer.unmount()); renderer = undefined; await render();
        edit('delegation-settings-description', 'Write README'); await press('delegation-settings-next');
        const created = { ...role, id: request.clientRoleId, name: 'Technical writer', description: 'Write README' };
        mocks.create.mockResolvedValue({ role: created, roles: [role, created] }); await press('delegation-settings-save');
        expect(mocks.create.mock.calls[0][1].id).toBe(request.clientRoleId); expect(find('delegation-settings-id').props.subtitle).toBe(request.clientRoleId);
    });
    it('honors a result deep link over a retained new-role form after AI creation', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Before AI'); await press('delegation-settings-ai');
        const id = mocks.configure.mock.calls[0][1].clientRoleId; act(() => renderer.unmount()); renderer = undefined;
        const created = { ...role, id, name: 'AI created' }; mocks.list.mockResolvedValue([role, created]); await render('machine-a', id);
        expect(find('delegation-settings-id').props.subtitle).toBe(id); expect(find('delegation-settings-name')).toBeUndefined();
    });
    it('returns from an AI-created reserved role to its detail instead of duplicate creation', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Manual starting name'); edit('delegation-settings-description', 'Unfinished manual purpose');
        await press('delegation-settings-ai'); const id = mocks.configure.mock.calls[0][1].clientRoleId;
        act(() => renderer.unmount()); renderer = undefined;
        const created = { ...role, id, name: 'AI final name', description: 'AI final purpose' };
        mocks.list.mockResolvedValue([role, created]); await render();
        expect(find('delegation-settings-id').props.subtitle).toBe(id);
        expect(find('delegation-settings-name')).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe('Manual starting name');
        expect(find('delegation-settings-description').props.value).toBe('Unfinished manual purpose');
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-save');
        expect(mocks.confirm.mock.calls.at(-1)?.[0]).toBe('delegation.roleChangedTitle');
        expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    });
    it('keeps the manual draft associated when the AI creation result deep-links to detail', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Manual starting name'); await press('delegation-settings-ai');
        const id = mocks.configure.mock.calls[0][1].clientRoleId; act(() => renderer.unmount()); renderer = undefined;
        mocks.list.mockResolvedValue([role, { ...role, id, name: 'AI final name' }]); await render('machine-a', id);
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe('Manual starting name');
        mocks.confirm.mockResolvedValueOnce(true); await press('delegation-settings-cancel'); await press('delegation-settings-back');
        mocks.randomUUID.mockReturnValueOnce('another-new-role-id'); await create();
        expect(find('delegation-settings-name').props.value).toBe('');
    });
    it('opens a requested role directly in read-only detail', async () => {
        await render('machine-a', role.id); expect(find('delegation-settings-id').props.subtitle).toBe(role.id); expect(find('delegation-settings-name')).toBeUndefined();
    });
});
