import { closeTemporaryConversationPanel } from '@/navigation/conversationPanelNavigation';
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { RoleDetailPanel } from './RoleDetailPanel';
import { getFirstSubmissionScope, setFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import type { SubagentInspectorSelection } from '@/components/subagent/SubagentInspectorContext';

const mocks = vi.hoisted(() => ({ os: 'web', list: vi.fn(), push: vi.fn(), close: vi.fn(), closePanel: vi.fn(), backHandler: null as (() => boolean) | null,
    panel: null as any, focused: true, machine: null as any, deferredClose: null as (() => void) | null, savedListeners: new Set<() => void>() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.os; }, select: (x: any) => x.web ?? x.default }, ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (f: any) => f({ colors: { surface: 'surface', text: 'text', textSecondary: 'secondary', divider: 'divider', textLink: 'link', textDestructive: 'error', surfacePressed: 'pressed' } }) }, useUnistyles: () => ({ theme: { colors: { text: 'text', textLink: 'link' } } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useMachine: () => mocks.machine }));
vi.mock('@/sync/apiDelegation', () => ({ listMachineDelegationRoles: mocks.list }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { onStatusChange: (listener: (status: string) => void) => { listener('connected'); return () => {}; } } }));
vi.mock('@/sync/roleConfigurationHandoff', () => ({ subscribeRoleConfigurationSavedResults: (listener: () => void) => { mocks.savedListeners.add(listener); return () => { mocks.savedListeners.delete(listener); }; } }));
vi.mock('@/components/RightSwipePanelHost', () => ({ useRightSwipePanel: () => mocks.panel }));
vi.mock('@/components/codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: 'CodingAgentIcon' }));
const saved = { id: 'writer', name: 'Saved writer', description: 'Saved responsibilities', agent: 'antigravity' as const, model: 'neon', effort: 'high', autoDelegate: false, createdAt: 1, updatedAt: 2 };
const live = { ...saved, name: 'Current writer', description: 'Current responsibilities', updatedAt: 3 };
function selection(): SubagentInspectorSelection { return { kind: 'role-detail', id: 'role:writer', title: saved.name, status: 'completed', machineId: 'machine-a', roleId: saved.id, savedRole: saved, roleOwner: getFirstSubmissionScope() }; }

describe('conversation-owned role details', () => {
    let renderer: any;
    const render = async (value = selection(), surfaceColor?: string) => { await act(async () => { renderer = TestRenderer.create(<RoleDetailPanel selection={value} onClose={mocks.close} surfaceColor={surfaceColor} />); }); };
    const text = () => renderer.root.findAllByType('Text').map((n: any) => n.children.join('')).join(' ');
    const action = (testID: string) => renderer.root.findAllByType('Pressable').find((n: any) => n.props.testID === testID);
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks();
        setFirstSubmissionScope('owner-a', 'https://server.test');
        mocks.machine = { id: 'machine-a', active: true, metadata: { delegationRoles: 1, displayName: 'Test machine' } };
        mocks.os = 'web'; mocks.list.mockResolvedValue([live]); mocks.focused = true; mocks.panel = null; mocks.backHandler = null; mocks.deferredClose = null; mocks.savedListeners.clear();
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; expect(mocks.savedListeners.size).toBe(0); vi.unstubAllGlobals(); });

    it('reads current machine configuration without task-runner capability and opens settings only on explicit edit', async () => {
        await render();
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith('machine-a');
        expect(text()).toContain('Current writer'); expect(text()).toContain('Current responsibilities'); expect(text()).toContain('writer');
        expect(text()).not.toContain('Saved responsibilities'); expect(mocks.push).not.toHaveBeenCalled();
        expect(action('role-detail-edit').props.disabled).toBe(false);
        act(() => action('role-detail-edit').props.onPress());
        expect(mocks.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/settings/delegation-roles', params: { machineId: 'machine-a', roleId: 'writer', desktopModal: '1' } });
        expect(mocks.close).not.toHaveBeenCalled();
    });
    it('keeps a deleted role receipt readable and never offers editing a missing role', async () => {
        mocks.list.mockResolvedValue([]); await render();
        expect(text()).toContain('delegation.roleMissingSnapshot'); expect(text()).toContain('Saved responsibilities');
        expect(action('role-detail-edit').props.disabled).toBe(true);
        act(() => action('role-detail-edit').props.onPress()); expect(mocks.push).not.toHaveBeenCalled();
    });
    it('distinguishes offline and failed current reads while preserving the saved snapshot', async () => {
        mocks.machine.active = false; await render();
        expect(text()).toContain('delegation.roleOfflineSnapshot'); expect(text()).toContain('Saved writer'); expect(mocks.list).not.toHaveBeenCalled();
        act(() => renderer.unmount()); renderer = undefined; mocks.machine.active = true; mocks.list.mockRejectedValue(new Error('RPC unavailable'));
        await render(); expect(text()).toContain('delegation.roleSnapshotReadFailed'); expect(text()).toContain('RPC unavailable'); expect(text()).toContain('Saved writer');
        expect(action('role-detail-edit').props.disabled).toBe(true);
    });
    it('shows a loading state rather than claiming a role was deleted before its directory returns', async () => {
        let resolve!: (roles: typeof live[]) => void; mocks.list.mockReturnValue(new Promise(r => { resolve = r; }));
        await render(); expect(text()).toContain('common.loading'); expect(text()).not.toContain('delegation.roleMissingSnapshot');
        expect(action('role-detail-edit').props.disabled).toBe(true);
        await act(async () => { resolve([live]); }); expect(text()).toContain('Current writer'); expect(action('role-detail-edit').props.disabled).toBe(false);
    });
    it('rejects account reincarnation and a late directory result without revealing the old snapshot', async () => {
        let resolve!: (roles: typeof live[]) => void; mocks.list.mockReturnValue(new Promise(r => { resolve = r; }));
        await render();
        act(() => { setFirstSubmissionScope('owner-b', 'https://server.test'); setFirstSubmissionScope('owner-a', 'https://server.test'); });
        await act(async () => { resolve([live]); });
        expect(text()).toContain('delegation.ownerChanged'); expect(text()).not.toContain('Saved writer'); expect(text()).not.toContain('Current writer');
        expect(renderer.root.findAllByProps({ testID: 'role-detail-edit' })).toHaveLength(0);
    });
    it('keeps an old machine response from replacing a new machine selection', async () => {
        let resolve!: (roles: typeof live[]) => void; mocks.list.mockReturnValueOnce(new Promise(r => { resolve = r; }));
        const old = selection(); await render(old);
        mocks.machine = { ...mocks.machine, id: 'machine-b' }; mocks.list.mockResolvedValue([{ ...live, name: 'Machine B writer' }]);
        await act(async () => { renderer.update(<RoleDetailPanel selection={{ ...old, machineId: 'machine-b' }} onClose={mocks.close} />); });
        await act(async () => { resolve([live]); });
        expect(text()).toContain('Machine B writer'); expect(text()).not.toContain('Current writer');
    });
    it.each(['android', 'ios'])('waits for the native compact drawer close callback before clearing selection (%s)', async os => {
        mocks.os = os;
        mocks.panel = { isOpen: true, closePanel: (callback: () => void) => { mocks.closePanel(); mocks.deferredClose = callback; },
            registerBackHandler: (callback: () => boolean) => { mocks.backHandler = callback; return () => { mocks.backHandler = null; }; } };
        await render(); act(() => action('role-detail-close').props.onPress());
        expect(mocks.closePanel).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
        act(() => mocks.deferredClose?.()); expect(mocks.close).toHaveBeenCalledOnce();
        act(() => { mocks.backHandler?.(); }); expect(mocks.closePanel).toHaveBeenCalledTimes(2);
    });
    it('releases the controlled Web drawer immediately even when its spring callback never completes', async () => {
        mocks.panel = { isOpen: true, closePanel: (callback: () => void) => { mocks.closePanel(); mocks.deferredClose = callback; },
            registerBackHandler: (callback: () => boolean) => { mocks.backHandler = callback; return () => { mocks.backHandler = null; }; } };
        await render(); act(() => action('role-detail-close').props.onPress());
        expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.closePanel).not.toHaveBeenCalled(); expect(mocks.deferredClose).toBeNull();
        act(() => { expect(closeTemporaryConversationPanel()).toBe(true); });
        expect(mocks.close).toHaveBeenCalledTimes(2); expect(mocks.closePanel).not.toHaveBeenCalled();
        act(() => mocks.backHandler?.()); expect(mocks.close).toHaveBeenCalledTimes(3);
    });

    it('closes the desktop inspector with Escape while a settings dialog or IME keeps ownership of its keys', async () => {
        let handler!: (event: any) => void; let dialogOpen = false;
        const remove = vi.fn();
        vi.stubGlobal('document', { addEventListener: (_name: string, fn: typeof handler) => { handler = fn; }, removeEventListener: remove,
            querySelectorAll: () => dialogOpen ? [{ getBoundingClientRect: () => ({ width: 500, height: 500 }) }] : [] });
        await render();
        const event = () => ({ key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn(), defaultPrevented: false, isComposing: false, repeat: false });
        dialogOpen = true; act(() => handler(event())); expect(mocks.close).not.toHaveBeenCalled();
        dialogOpen = false; act(() => handler({ ...event(), isComposing: true })); expect(mocks.close).not.toHaveBeenCalled();
        const escape = event(); act(() => handler(escape)); expect(mocks.close).toHaveBeenCalledOnce(); expect(escape.preventDefault).toHaveBeenCalledOnce();
        act(() => renderer.unmount()); renderer = undefined; expect(remove).toHaveBeenCalledWith('keydown', handler);
    });

    it('lets the desktop frame own its surface while standalone drawers remain opaque', async () => {
        await render(selection(), 'transparent');
        const root = renderer.root.findByProps({ testID: 'role-detail-panel' });
        expect(Object.assign({}, ...root.props.style.filter(Boolean)).backgroundColor).toBe('transparent');
        act(() => renderer.unmount()); renderer = undefined; await render();
        expect(Object.assign({}, ...renderer.root.findByProps({ testID: 'role-detail-panel' }).props.style.filter(Boolean)).backgroundColor).toBe('surface');
        act(() => action('role-detail-close').props.onPress()); expect(mocks.close).toHaveBeenCalledOnce();
    });
});
