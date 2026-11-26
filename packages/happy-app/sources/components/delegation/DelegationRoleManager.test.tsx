import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { DelegationRoleManager } from './DelegationRoleManager';

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), confirm: vi.fn(), refreshCatalog: vi.fn(), clipboard: vi.fn(), configure: vi.fn(), randomUUID: vi.fn(), modalShow: vi.fn(), modalHide: vi.fn(), setParams: vi.fn(), back: vi.fn(), replace: vi.fn(), readRecord: vi.fn(), savedHandoff: vi.fn(), modalClose: vi.fn(), params: {} as Record<string, string>, flowNavigation: null as any,
    machines: [] as any[], sessions: [] as any[], scope: { key: 'account-a', serverUrl: 'https://example.test' } as { key: string; serverUrl: string } | null,
    owner: { key: 'account-a', generation: 'one', serverUrl: 'https://example.test' }, listeners: new Set<() => void>(), catalog: null as any,
    status: 'connected' as 'disconnected' | 'connecting' | 'connected' | 'error', statusListeners: new Set<(status: string) => void>(),
    savedResultListeners: new Set<(result: { machineId: string; roleId: string }) => void>() }));
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', useWindowDimensions: () => ({ width: 1440, height: 1000 }), Pressable: 'Pressable', Switch: 'Switch', Text: 'Text', TextInput: 'TextInput', View: 'View', Platform: { OS: 'web', select: (value: any) => value.web ?? value.default } }));
vi.mock('expo-router', () => ({ Stack: { Screen: 'StackScreen' }, useLocalSearchParams: () => mocks.params, useRouter: () => ({ push: vi.fn(), setParams: mocks.setParams, back: mocks.back, replace: mocks.replace, canGoBack: () => true }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/components/DesktopModalScene', () => ({ useIsDesktopModalScene: () => false }));
vi.mock('@/navigation/desktopModalNavigation', () => ({ navigateDesktopModalBack: mocks.modalClose }));
vi.mock('@/hooks/useRoleFlowNavigationBack', () => ({ useRoleFlowNavigationBack: (value: any) => { mocks.flowNavigation = value; } }));
vi.mock('@/sync/roleConfigurationHandoff', () => ({ readRoleConfiguration: mocks.readRecord, getRoleConfigurationSavedHandoff: mocks.savedHandoff,
    subscribeRoleConfigurationSavedResults: (listener: (result: { machineId: string; roleId: string }) => void) => {
        mocks.savedResultListeners.add(listener); return () => { mocks.savedResultListeners.delete(listener); };
    } }));
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
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'text', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider', surface: 'surface', surfacePressed: 'pressed', surfaceSelected: 'selected', textLink: 'link', groupped: { background: 'group' }, input: { background: 'input' }, button: { primary: { background: 'primary', tint: 'onPrimary' } } } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
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
    const moveMachine = async (id: string) => { await act(async () => { renderer.update(<DelegationRoleManager initialMachineId={id} />); }); };
    const create = async () => press('delegation-settings-new');
    const details = async (id = role.id) => press(`delegation-settings-role-${id}`);
    const editing = async (id = role.id) => { await details(id); await press('delegation-settings-edit'); };
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
        mocks.params = {}; mocks.readRecord.mockReturnValue(null); mocks.savedHandoff.mockReturnValue(null); mocks.flowNavigation = null;
        mocks.machines = [machine('machine-a'), machine('machine-b')]; mocks.sessions = []; mocks.catalog = null;
        mocks.status = 'connected'; mocks.statusListeners.clear(); mocks.savedResultListeners.clear();
        mocks.scope = { key: 'account-a', serverUrl: 'https://example.test' }; mocks.owner = { ...mocks.scope, generation: String(++generation) };
        mocks.list.mockResolvedValue([role]); mocks.confirm.mockResolvedValue(true); mocks.remove.mockResolvedValue([]);
        mocks.modalClose.mockReturnValue(false);
        mocks.modalShow.mockReturnValue('model-modal'); mocks.randomUUID.mockReturnValue('client-role-id'); mocks.clipboard.mockResolvedValue(true); mocks.configure.mockResolvedValue(undefined);
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; expect(mocks.savedResultListeners.size).toBe(0); });
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
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-close'); expect(find('delegation-settings-auto')).toBeDefined();
        await press('delegation-settings-close'); expect(find('delegation-settings-search')).toBeDefined(); await create(); expect(find('delegation-settings-name').props.value).toBe('');
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
        await moveMachine('machine-b'); await act(async () => { confirm(true); }); expect(mocks.remove).toHaveBeenCalledTimes(1);
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
        await moveMachine('machine-b'); await create(); expect(find('delegation-settings-name').props.value).toBe('');
        await moveMachine('machine-a'); expect(find('delegation-settings-name').props.value).toBe('Private A');
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
    it('consumes the unchanged submitted draft after a real AI save and opens the saved version for editing', async () => {
        await render(); await editing(); edit('delegation-settings-name', 'Unsaved local name');
        await press('delegation-settings-ai'); const sourceDraft = mocks.configure.mock.calls[0][1].draft;
        act(() => renderer.unmount()); renderer = undefined;
        const saved = { ...role, name: 'AI name', updatedAt: 3 };
        mocks.savedHandoff.mockReturnValue({ sourceDraft, savedRole: saved, revision: 1 });
        mocks.list.mockResolvedValue([saved]); await render('machine-a', role.id);
        expect(find('delegation-settings-name')).toBeUndefined();
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe(saved.name);
        await press('delegation-settings-cancel');
        expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
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
        mocks.savedHandoff.mockReturnValue({ sourceDraft: mocks.configure.mock.calls[0][1].draft, savedRole: created, revision: 1 });
        mocks.list.mockResolvedValue([role, created]); await render();
        expect(find('delegation-settings-id').props.subtitle).toBe(id);
        expect(find('delegation-settings-name')).toBeUndefined(); expect(mocks.create).not.toHaveBeenCalled();
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe('AI final name');
        expect(find('delegation-settings-description').props.value).toBe('AI final purpose');
        await press('delegation-settings-cancel'); expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    });
    it('uses the saved AI creation when its result deep-links to detail', async () => {
        await render(); await create(); edit('delegation-settings-name', 'Manual starting name'); await press('delegation-settings-ai');
        const id = mocks.configure.mock.calls[0][1].clientRoleId; act(() => renderer.unmount()); renderer = undefined;
        const created = { ...role, id, name: 'AI final name' };
        mocks.savedHandoff.mockReturnValue({ sourceDraft: mocks.configure.mock.calls[0][1].draft, savedRole: created, revision: 1 });
        mocks.list.mockResolvedValue([role, created]); await render('machine-a', id);
        await press('delegation-settings-edit');
        expect(find('delegation-settings-name').props.value).toBe('AI final name');
        await press('delegation-settings-cancel'); await press('delegation-settings-back');
        mocks.randomUUID.mockReturnValueOnce('another-new-role-id'); await create();
        expect(find('delegation-settings-name').props.value).toBe('');
    });
    it('opens a requested role directly in read-only detail', async () => {
        await render('machine-a', role.id); expect(find('delegation-settings-id').props.subtitle).toBe(role.id); expect(find('delegation-settings-name')).toBeUndefined();
    });
    it('keeps the header, progress and paired primary actions outside the scrolling form', async () => {
        await render();
        expect(find('delegation-flow-header').findAllByProps({ testID: 'delegation-settings-new' }).length).toBeGreaterThan(0);
        expect(find('delegation-flow-body').findAllByProps({ testID: 'delegation-settings-new' })).toHaveLength(0);
        await create();
        expect(find('delegation-flow-title').children.join('')).toBe('delegation.newRole');
        expect(find('delegation-flow-body').findAllByProps({ testID: 'delegation-settings-steps' })).toHaveLength(0);
        expect(find('delegation-flow-body').findAllByProps({ testID: 'delegation-settings-next' })).toHaveLength(0);
        expect(find('delegation-flow-footer').findAllByProps({ testID: 'delegation-settings-next' }).length).toBeGreaterThan(0);
        expect(find('delegation-flow-footer').findAllByProps({ testID: 'delegation-settings-cancel' }).length).toBeGreaterThan(0);
        expect(find('delegation-machine-picker')).toBeUndefined();
        edit('delegation-settings-name', 'Writer'); edit('delegation-settings-description', 'Write docs'); await press('delegation-settings-next');
        expect(find('delegation-settings-cancel')).toBeUndefined();
        expect(find('delegation-flow-footer').findAllByProps({ testID: 'delegation-settings-previous' }).length).toBeGreaterThan(0);
        expect(find('delegation-flow-footer').findAllByProps({ testID: 'delegation-settings-save' }).length).toBeGreaterThan(0);
    });
    it('routes host back through the current step and protects a full close of the dirty wizard', async () => {
        await render(); expect(mocks.flowNavigation.enabled).toBe(false);
        await create(); edit('delegation-settings-name', 'Writer'); edit('delegation-settings-description', 'Write docs'); await press('delegation-settings-next');
        expect(mocks.flowNavigation.enabled).toBe(true);
        await act(async () => { await mocks.flowNavigation.onBack(); });
        expect(find('delegation-settings-name').props.value).toBe('Writer'); expect(mocks.back).not.toHaveBeenCalled();
        await press('delegation-settings-next'); mocks.confirm.mockResolvedValueOnce(false);
        await act(async () => { await mocks.flowNavigation.onClose(); });
        expect(find('delegation-settings-auto')).toBeDefined();
        await act(async () => { await mocks.flowNavigation.onClose(); });
        expect(find('delegation-settings-search')).toBeDefined(); expect(mocks.flowNavigation.enabled).toBe(false);
    });
    it('returns detail to the list without retaining a stale deep-link role ID', async () => {
        await render('machine-a', role.id);
        expect(find('delegation-flow-header').findAllByProps({ testID: 'delegation-settings-edit' }).length).toBeGreaterThan(0);
        await act(async () => { await mocks.flowNavigation.onBack(); });
        expect(find('delegation-settings-search')).toBeDefined();
        expect(mocks.setParams).toHaveBeenLastCalledWith({ roleId: undefined, roleConfigurationReturn: undefined });
    });
    it('retains the same list scroll position when returning from a role detail', async () => {
        await render();
        act(() => find('delegation-flow-body').props.onScroll({ nativeEvent: { contentOffset: { y: 312 } } }));
        await details(); await press('delegation-settings-back');
        const scaffold = renderer.root.findByType((await import('./RoleFlowScaffold')).RoleFlowScaffold);
        expect(scaffold.props.scrollKey).toBe('list');
        expect(scaffold.props.scrollPositions.get(scaffold.props.scrollKey)).toBe(312);
    });
    it('returns through the desktop settings stack before using the application router', async () => {
        await render(); mocks.modalClose.mockReturnValueOnce(true);
        await press('delegation-settings-exit');
        expect(mocks.modalClose).toHaveBeenCalledWith(false); expect(mocks.back).not.toHaveBeenCalled();
        await press('delegation-settings-exit'); expect(mocks.back).toHaveBeenCalledOnce();
    });
    it('restores the exact unsaved AI source step, query, advanced fields and scroll after a fresh settings mount', async () => {
        const draft = { name: 'Source draft', description: 'Source responsibility', agent: 'antigravity' as const, model: 'manual-neon', effort: 'high', autoDelegate: false };
        mocks.params = { roleConfigurationReturn: 'rc-return' };
        mocks.readRecord.mockReturnValue({ id: 'rc-return', revision: 2, machineId: 'machine-a', roleId: 'reserved-role', draft,
            returnContext: { view: 'create', step: 2, query: 'Source query', advanced: true, scrollY: 142, baseline: JSON.stringify({ name: '', description: '', agent: 'antigravity', model: '', effort: '', autoDelegate: false }) } });
        await render();
        expect(find('delegation-settings-name')).toBeUndefined();
        expect(find('delegation-settings-model').props.value).toBe('manual-neon');
        expect(find('delegation-settings-effort').props.value).toBe('high');
        expect(renderer.root.findByType((await import('./RoleFlowScaffold')).RoleFlowScaffold).props.scrollPositions.get('create:2')).toBe(142);
        await press('delegation-settings-previous');
        expect(find('delegation-settings-name').props.value).toBe(draft.name);
        expect(find('delegation-settings-description').props.value).toBe(draft.description);
    });
    it('does not consume an independent dirty edit made after the AI source draft was handed off', async () => {
        await render(); await editing(); edit('delegation-settings-description', 'Handed to AI'); await press('delegation-settings-ai');
        const sourceDraft = mocks.configure.mock.calls[0][1].draft;
        edit('delegation-settings-description', 'My newer independent change');
        act(() => renderer.unmount()); renderer = undefined;
        const saved = { ...role, name: 'AI saved name', description: 'AI result', updatedAt: 3 };
        mocks.savedHandoff.mockReturnValue({ sourceDraft, savedRole: saved, revision: 1 }); mocks.list.mockResolvedValue([saved]);
        await render('machine-a', role.id); await press('delegation-settings-edit');
        expect(find('delegation-settings-description').props.value).toBe('My newer independent change');
        mocks.confirm.mockResolvedValueOnce(false); await press('delegation-settings-save');
        expect(mocks.confirm.mock.calls.at(-1)?.[0]).toBe('delegation.roleChangedTitle'); expect(mocks.update).not.toHaveBeenCalled();
    });

});
