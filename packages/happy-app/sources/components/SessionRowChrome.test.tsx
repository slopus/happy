import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { SessionRowActions } from './SessionRowChrome';
import { SessionActionsPopover } from './SessionActionsPopover';

const mocks = vi.hoisted(() => ({
    os: 'android', width: 400,
    actions: vi.fn(), pin: vi.fn(), archive: vi.fn(), remove: vi.fn(), confirmRemove: vi.fn(),
    session: { id: 'session-1', metadata: {} } as any,
}));
vi.mock('react-native', () => ({
    Platform: { get OS() { return mocks.os; } },
    Pressable: 'Pressable', View: 'View', Text: 'Text', Modal: 'Modal',
    useWindowDimensions: () => ({ width: mocks.width, height: 900 }),
}));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather', Octicons: 'Octicons', Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { surface: '#fff', header: { background: '#fff' }, status: { error: '#f00' }, shadow: {} } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: () => null }));
vi.mock('@/sync/storage', () => ({ useSession: () => mocks.session, useMachine: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/sessionUtils', () => ({ formatLastSeen: () => '' }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => {
    mocks.actions();
    return {
        togglePinSession: mocks.pin, archiveSession: mocks.archive, deleteSession: mocks.remove, confirmDeleteSession: mocks.confirmRemove,
        actionItems: [{ id: 'pin', label: 'Pin', icon: 'pin', onPress: mocks.pin }],
    };
} }));

let renderer: any;
function render(element: React.ReactElement) { act(() => { renderer = TestRenderer.create(element); }); }
function host(testID: string) { return renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID)[0]; }
function Harness() {
    const [anchor, setAnchor] = React.useState<any>(null);
    return <SessionRowActions sessionId="session-1" statusLabel="Completed" visible={false}
        contextAnchor={anchor} onContextAnchorChange={setAnchor} />;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.os = 'android'; mocks.width = 400;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; });

describe('session row action initialization', () => {
    it.each(['android', 'ios', 'web'])('keeps %s phone rows idle until the menu is opened', (os) => {
        mocks.os = os;
        render(<Harness />);
        expect(mocks.actions).not.toHaveBeenCalled();
        act(() => host('session-row-more-action').props.onPress({ stopPropagation() {}, nativeEvent: { pageX: 300, pageY: 200 } }));
        expect(mocks.actions).toHaveBeenCalledTimes(1);
        const menuAction = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.findAllByType('Ionicons').length > 0)[0];
        act(() => menuAction.props.onPress());
        expect(mocks.pin).toHaveBeenCalledOnce();
        expect(host('session-row-more-action')).toBeDefined();
        expect(renderer.root.findAllByType('Ionicons')).toHaveLength(0);
    });

    it('does not initialize action hooks while mounting 100 phone rows', () => {
        render(<>{Array.from({ length: 100 }, (_, index) => <SessionRowActions key={index}
            contextAnchor={null} onContextAnchorChange={() => {}} statusLabel="Completed"
            sessionId={`session-${index}`} visible={false} />)}</>);
        expect(mocks.actions).not.toHaveBeenCalled();
    });

    it('does not initialize action hooks for a batch of closed row and project menus', () => {
        render(<>{Array.from({ length: 100 }, (_, index) => <SessionActionsPopover key={index}
            anchor={null} onClose={() => {}} sessionId={`session-${index}`} visible={false} />)}</>);
        expect(mocks.actions).not.toHaveBeenCalled();
    });

    it('keeps desktop inline actions initialized across hover changes', () => {
        mocks.os = 'web'; mocks.width = 1400;
        const props = { sessionId: 'session-1', statusLabel: 'Completed', contextAnchor: null, onContextAnchorChange: vi.fn() };
        render(<SessionRowActions {...props} visible={false} />);
        expect(mocks.actions).toHaveBeenCalledTimes(1);
        expect(host('session-row-pin-action')).toBeUndefined();
        act(() => renderer.update(<SessionRowActions {...props} visible />));
        act(() => host('session-row-pin-action').props.onPress({ stopPropagation() {} }));
        expect(mocks.pin).toHaveBeenCalledOnce();
        expect(host('session-row-delete-action')).toBeDefined();
        expect(host('session-row-archive-action')).toBeDefined();
    });
});

it('confirms desktop row deletion beside its trigger before deleting', () => {
    mocks.os = 'web'; mocks.width = 1400;
    render(<SessionRowActions sessionId="session-1" statusLabel="Completed" visible
        contextAnchor={null} onContextAnchorChange={vi.fn()} />);
    act(() => host('session-row-delete-action').props.onPress({ stopPropagation() {}, nativeEvent: { clientX: 280, clientY: 200 } }));
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.confirmRemove).not.toHaveBeenCalled();
    expect(host('session-delete-confirmation')).toBeDefined();
    act(() => host('session-delete-cancel').props.onPress({ stopPropagation() {} }));
    expect(host('session-delete-confirmation')).toBeUndefined();
    expect(mocks.confirmRemove).not.toHaveBeenCalled();
    act(() => host('session-row-delete-action').props.onPress({ stopPropagation() {}, nativeEvent: { clientX: 280, clientY: 200 } }));
    act(() => host('session-delete-confirm').props.onPress({ stopPropagation() {} }));
    expect(mocks.confirmRemove).toHaveBeenCalledOnce();
    expect(host('session-delete-confirmation')).toBeUndefined();
});

it('drops inline confirmation when a reused row switches sessions', () => {
    mocks.os = 'web'; mocks.width = 1400;
    const row = (id: string) => <SessionRowActions sessionId={id} statusLabel="Completed" visible contextAnchor={null} onContextAnchorChange={vi.fn()} />;
    render(row('session-1'));
    act(() => host('session-row-delete-action').props.onPress({ stopPropagation() {}, nativeEvent: { clientX: 280, clientY: 200 } }));
    expect(host('session-delete-confirmation')).toBeDefined();
    mocks.session = { id: 'session-2', metadata: {} };
    act(() => renderer.update(row('session-2')));
    expect(host('session-delete-confirmation')).toBeUndefined();
    mocks.session = { id: 'session-1', metadata: {} };
    act(() => renderer.update(row('session-1')));
    expect(host('session-delete-confirmation')).toBeUndefined();
    expect(mocks.confirmRemove).not.toHaveBeenCalled();
});
