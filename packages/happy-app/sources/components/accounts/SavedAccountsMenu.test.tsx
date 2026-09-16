import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({ list: vi.fn(), switch: vi.fn(), active: 'a', navigate: vi.fn() }));
vi.mock('react-native', () => ({ ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ switchAccount: mocks.switch }) }));
vi.mock('@/auth/accounts', () => ({ listSavedAccounts: mocks.list }));
vi.mock('@/auth/accountRuntime', () => ({ getActiveAccountKey: () => mocks.active }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'text', textSecondary: 'secondary', divider: 'divider', surfaceSelected: 'selected-dark', surfacePressed: 'pressed-dark', status: { error: 'error' } } };
    return { StyleSheet: { hairlineWidth: 1, create: (fn: any) => fn(theme) }, useUnistyles: () => ({ theme }) };
});
import { SavedAccountsMenu } from './SavedAccountsMenu';
describe('SavedAccountsMenu', () => {
    let renderer: any;
    beforeEach(() => {
        vi.clearAllMocks(); mocks.active = 'a'; mocks.switch.mockResolvedValue(undefined);
        mocks.list.mockResolvedValue([{ key: 'a', accountId: 'A', label: 'Personal', serverUrl: 'https://example.test' }, { key: 'b', accountId: 'B', label: 'MISS', serverUrl: 'https://example.test' }]);
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.useRealTimers(); });
    const mount = async () => { await act(async () => { renderer = TestRenderer.create(<SavedAccountsMenu onNavigate={mocks.navigate} />); }); };
    const row = (id: string) => renderer.root.findByProps({ testID: `sidebar-switch-account-${id}` });
    it('shows saved accounts directly, marks current, and uses semantic selected/hover surfaces', async () => {
        await mount();
        expect(row('A').props.accessibilityState.selected).toBe(true);
        expect(row('B').props.accessibilityState.selected).toBe(false);
        expect(row('A').props.style({ pressed: false })).toContainEqual({ backgroundColor: 'selected-dark' });
        await act(async () => row('B').props.onHoverIn());
        expect(row('B').props.style({ pressed: false })).toContainEqual({ backgroundColor: 'pressed-dark' });
        await act(async () => row('A').props.onPress());
        expect(mocks.switch).not.toHaveBeenCalled();
    });
    it('uses protected auth switching, blocks double clicks, and leaves navigation unchanged on cancelled switch', async () => {
        let finish!: () => void;
        mocks.switch.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
        await mount();
        await act(async () => { row('B').props.onPress(); row('B').props.onPress(); });
        expect(mocks.switch).toHaveBeenCalledExactlyOnceWith('b');
        expect(row('A').props.disabled).toBe(true);
        await act(async () => finish());
        expect(row('A').props.disabled).toBe(false);
        expect(mocks.navigate).not.toHaveBeenCalled();
    });
    it('shows an error and unlocks the list after failed switching', async () => {
        mocks.switch.mockRejectedValue(new Error('fixture failure'));
        await mount();
        await act(async () => row('B').props.onPress());
        expect(renderer.root.findByProps({ accessibilityRole: 'alert' }).props.children).toBe('accounts.failed');
        expect(row('B').props.disabled).toBe(false);
    });
    it('opens the add form only on explicit request', async () => {
        await mount();
        expect(mocks.navigate).not.toHaveBeenCalled();
        act(() => renderer.root.findByProps({ testID: 'sidebar-add-account' }).props.onPress());
        expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/accounts?add=1');
    });
    it('keeps add-account available if saved accounts fail to load', async () => {
        mocks.list.mockRejectedValue(new Error('fixture failure'));
        await mount();
        expect(renderer.root.findByProps({ accessibilityRole: 'alert' })).toBeTruthy();
        expect(renderer.root.findByProps({ testID: 'sidebar-add-account' }).props.disabled).toBe(false);
    });
    it('focuses the first account after async loading even when the parent focus timer was missed', async () => {
        vi.useFakeTimers();
        const focus = vi.fn();
        await act(async () => {
            renderer = TestRenderer.create(<SavedAccountsMenu onNavigate={mocks.navigate} />, {
                createNodeMock: (element: any) => element.props.testID === 'sidebar-switch-account-A' ? { focus } : null,
            });
        });
        act(() => vi.runOnlyPendingTimers());
        expect(focus).toHaveBeenCalledOnce();
    });
});
