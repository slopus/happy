import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { useHappyAction } from '@/hooks/useHappyAction';
import { SessionActionsPopover } from './SessionActionsPopover';

const mocks = vi.hoisted(() => ({
    os: 'android', remove: vi.fn(), oldDelete: vi.fn(), executions: vi.fn(), pending: Promise.resolve(),
    session: { id: 'session-1', metadata: {} } as any,
}));
vi.mock('react-native', () => ({
    Platform: { get OS() { return mocks.os; } },
    Pressable: 'Pressable', View: 'View', Text: 'Text', Modal: 'Modal',
    useWindowDimensions: () => ({ width: 400, height: 900 }),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', Octicons: 'Octicons', Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: '#fff', header: { background: '#fff' }, status: { error: '#f00' }, shadow: {} } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/sync/storage', () => ({ useSession: () => mocks.session, useMachine: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => {
    const [, perform] = useHappyAction(async () => { mocks.executions(); await mocks.pending; });
    return {
        actionItems: [{ id: 'pin', label: 'Pin', icon: 'pin', onPress: () => { perform(); } }, { id: 'delete', label: 'Delete', icon: 'trash', onPress: mocks.oldDelete }],
        confirmDeleteSession: mocks.remove,
    };
} }));


vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
let renderer: any;
let reopen!: () => void;
function Harness() {
    const [visible, setVisible] = React.useState(true);
    reopen = () => setVisible(true);
    return <SessionActionsPopover visible={visible} anchor={{ type: 'point', x: 100, y: 100 }}
        onClose={() => setVisible(false)} sessionId="session-1" />;
}
function pressAction() {
    const action = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.findAllByType('Ionicons').length > 0)[0];
    act(() => action.props.onPress());
}

afterEach(() => { if (renderer) act(() => renderer.unmount()); });
it('keeps the real useHappyAction in-flight guard when the menu is reopened', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.executions.mockClear();
    let finish!: () => void;
    mocks.pending = new Promise<void>(resolve => { finish = resolve; });
    try {
        act(() => { renderer = TestRenderer.create(<Harness />); });
        pressAction();
        expect(mocks.executions).toHaveBeenCalledTimes(1);
        act(() => reopen());
        pressAction();
        expect(mocks.executions).toHaveBeenCalledTimes(1);
        await act(async () => { finish(); await mocks.pending; });
        act(() => reopen());
        pressAction();
        expect(mocks.executions).toHaveBeenCalledTimes(2);
    } finally { await act(async () => { finish(); await mocks.pending; }); }
});

it('replaces the web menu with an anchored confirmation and dismisses outside without deleting', () => {
    mocks.os = 'web';
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
    const deleteAction = () => renderer.root.findAll((n: any) => n.type === 'Pressable' && n.findAllByType('Ionicons').some((icon: any) => icon.props.name === 'trash'))[0];
    act(() => { renderer = TestRenderer.create(<Harness />); });
    act(() => deleteAction().props.onPress());
    expect(host('session-delete-confirmation')).toBeDefined();
    expect(mocks.oldDelete).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    act(() => host('session-delete-outside').props.onPress({ stopPropagation() {} }));
    expect(host('session-delete-confirmation')).toBeUndefined();
    expect(mocks.remove).not.toHaveBeenCalled();
    act(() => reopen());
    act(() => deleteAction().props.onPress());
    act(() => host('session-delete-confirm').props.onPress({ stopPropagation() {} }));
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.oldDelete).not.toHaveBeenCalled();
    mocks.os = 'android';
});

it('drops the old confirmation when a reused menu switches session, including switching back', () => {
    mocks.os = 'web';
    const host = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
    const menu = (id: string) => <SessionActionsPopover visible anchor={{ type: 'point', x: 100, y: 100 }} onClose={() => {}} sessionId={id} />;
    act(() => { renderer = TestRenderer.create(menu('session-1')); });
    const remove = renderer.root.findAll((n: any) => n.type === 'Pressable' && n.findAllByType('Ionicons').some((icon: any) => icon.props.name === 'trash'))[0];
    act(() => remove.props.onPress());
    expect(host('session-delete-confirmation')).toBeDefined();
    act(() => renderer.update(menu('session-2')));
    expect(host('session-delete-confirmation')).toBeUndefined();
    act(() => renderer.update(menu('session-1')));
    expect(host('session-delete-confirmation')).toBeUndefined();
    mocks.os = 'android';
});
