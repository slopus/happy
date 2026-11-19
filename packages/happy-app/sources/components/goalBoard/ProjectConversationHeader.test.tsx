import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ os: 'native', confirmRemove: vi.fn(), session: { id: 'one', active: false, metadata: {} } as any, sessions: {} as Record<string, any>, deleted: new Set<string>(), busy: false, callbacks: {} as any, archive: vi.fn(), remove: vi.fn(), restore: vi.fn(), alert: vi.fn(), unmount: vi.fn() }));
vi.mock('react-native', () => ({ Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View', Platform: { get OS() { return mock.os; } }, useWindowDimensions: () => ({ width: 1600, height: 900 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('react-native-unistyles', () => { const theme = { colors: { modal: { backdrop: 'backdrop' }, status: {}, shadow: {}, surface: 'surface', divider: 'divider' } }; return { useUnistyles: () => ({ theme }), StyleSheet: { create: (f: any) => f(theme) } }; });
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: React.forwardRef((props: any, ref: any) => React.createElement('Button', { ...props, ref })) }));
vi.mock('@/sync/storage', () => ({ useSession: (id: string) => mock.sessions[id], storage: Object.assign((select: any) => select({ sessions: mock.sessions }), { getState: () => ({ sessions: mock.sessions }) }) }));
vi.mock('@/sync/projectSessionLinks', () => ({ isProjectSessionDeleted: (id: string) => mock.deleted.has(id) }));
vi.mock('@/modal', () => ({ Modal: { alert: mock.alert } }));
vi.mock('@/hooks/useProjectModalEscape', () => ({ useProjectModalEscape: () => {} }));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: (_session: any, callbacks: any) => { React.useEffect(() => () => mock.unmount(), []); mock.callbacks = callbacks; return { archiveSession: mock.archive, deleteSession: mock.remove, confirmDeleteSession: mock.confirmRemove, restoreSession: mock.restore, archivingSession: mock.busy }; } }));
import { ProjectConversationHeader } from './ProjectConversationHeader';
let renderer: any;
const select = vi.fn(), globalChat = vi.fn(), close = vi.fn();
const props = { testIDPrefix: 'test', selectedId: 'one', sessions: [{ sessionId: 'one', title: 'Old chat', directory: '/task', updatedAt: 1, executed: false }], onSelect: select, onGlobal: globalChat, onClose: close, manage: true };
function setup(patch: any = {}) { act(() => { if (renderer) renderer.update(<ProjectConversationHeader {...props} {...patch} />); else renderer = TestRenderer.create(<ProjectConversationHeader {...props} {...patch} />, { createNodeMock: () => ({ measureInWindow: (f: any) => f(100, 80, 100, 36), focus: vi.fn() }) }); }); }
const press = (id: string) => act(() => renderer.root.findAllByType('Button').find((n: any) => n.props.testID === id).props.onPress());
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.os = 'native'; mock.session = { id: 'one', active: false, metadata: {} }; mock.sessions = { one: mock.session, two: { id: 'two', metadata: {} } }; mock.deleted.clear(); mock.busy = false; });
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });
it('provides distinct global and close actions without changing the selected history', () => { setup(); press('test-global-chat'); press('test-close-chat'); expect(globalChat).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled(); });
it('labels global history independently and still switches its own sessions', () => { setup({ scope: 'global', onGlobal: undefined }); expect(renderer.root.findAllByType('Button').find((n: any) => n.props.testID === 'test-history').props.label).toBe('projectGoals.globalHistory'); press('test-history'); press('test-history-one'); expect(select).toHaveBeenCalledExactlyOnceWith('one'); expect(renderer.root.findAllByType('Modal')).toHaveLength(0); });
it('exposes delete and archive directly and delegates delete to its existing confirmation handler', () => {
    setup();
    press('test-delete-conversation'); press('test-archive-conversation');
    expect(mock.remove).toHaveBeenCalledTimes(1); expect(mock.archive).toHaveBeenCalledTimes(1);
    expect(mock.alert).not.toHaveBeenCalled();
});
it.each(['onAfterDelete', 'onAfterArchive'])('shows the next conversation after %s instead of closing', callback => {
    setup({ sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'two' }] });
    act(() => mock.callbacks[callback]());
    expect(select).toHaveBeenCalledExactlyOnceWith('two'); expect(close).not.toHaveBeenCalled();
});
it('closes when the last conversation is removed', () => { setup(); act(() => mock.callbacks.onAfterDelete()); expect(close).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled(); });
it('filters archived and deleted history and advances a selected archived conversation once', () => {
    mock.session.metadata.lifecycleState = 'archived'; mock.deleted.add('deleted');
    setup({ sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'deleted' }, { ...props.sessions[0], sessionId: 'two' }] });
    expect(select).toHaveBeenCalledExactlyOnceWith('two');
    press('test-history');
    expect(renderer.root.findAllByProps({ testID: 'test-history-one' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'test-history-deleted' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'test-history-two' })).not.toHaveLength(0);
});
it('disables both lifecycle actions while either operation is running', () => { mock.busy = true; setup(); for (const id of ['test-delete-conversation', 'test-archive-conversation']) expect(renderer.root.findAllByType('Button').find((n: any) => n.props.testID === id).props.disabled).toBe(true); });
it('late archive completion cannot close a different conversation', () => { setup(); const old = mock.callbacks.onAfterArchive; setup({ selectedId: 'two' }); act(() => old()); expect(close).not.toHaveBeenCalled(); act(() => mock.callbacks.onAfterDelete()); expect(select).toHaveBeenCalledExactlyOnceWith('one'); expect(close).not.toHaveBeenCalled(); });
it('late completion cannot navigate after leaving the workspace', () => { setup(); const old = mock.callbacks.onAfterArchive; act(() => renderer.unmount()); renderer = undefined; old(); expect(close).not.toHaveBeenCalled(); });
it('read-only previews keep close and history but omit lifecycle mutations', () => { setup({ manage: false }); expect(renderer.root.findAllByProps({ testID: 'test-delete-conversation' })).toHaveLength(0); expect(renderer.root.findAllByProps({ testID: 'test-archive-conversation' })).toHaveLength(0); press('test-close-chat'); expect(close).toHaveBeenCalledTimes(1); });

it.each(['archive', 'delete'])('store update and late %s completion advance only once', kind => {
    const sessions = [...props.sessions, { ...props.sessions[0], sessionId: 'two' }];
    setup({ sessions }); const complete = mock.callbacks[kind === 'archive' ? 'onAfterArchive' : 'onAfterDelete'];
    if (kind === 'archive') mock.sessions = { ...mock.sessions, one: { ...mock.session, metadata: { lifecycleState: 'archived' } } };
    else { mock.deleted.add('one'); mock.sessions = { two: mock.sessions.two }; }
    setup({ sessions }); act(() => complete());
    expect(select).toHaveBeenCalledExactlyOnceWith('two'); expect(close).not.toHaveBeenCalled();
});
it('skips a remaining conversation archived while deletion was pending', () => {
    setup({ sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'two' }] });
    mock.sessions.two.metadata.lifecycleState = 'archived';
    act(() => mock.callbacks.onAfterDelete());
    expect(close).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
});

it('resolves an older history page before closing the last loaded conversation', async () => {
    const resolveNext = vi.fn().mockResolvedValue('older'); setup({ onResolveNext: resolveNext });
    await act(async () => mock.callbacks.onAfterDelete());
    expect(resolveNext).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledExactlyOnceWith('older'); expect(close).not.toHaveBeenCalled();
});
it('late history-page resolution cannot replace a different selected conversation', async () => {
    let resolve!: (id: string) => void;
    const onResolveNext = () => new Promise<string>(done => { resolve = done; });
    setup({ onResolveNext }); act(() => mock.callbacks.onAfterDelete());
    setup({ selectedId: 'two' }); await act(async () => resolve('older'));
    expect(select).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});
it('hides an archived machine-history row before its live header is loaded', () => {
    setup({ sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'cold-archive', lifecycleState: 'archived' }] });
    press('test-history'); expect(renderer.root.findAllByProps({ testID: 'test-history-cold-archive' })).toHaveLength(0);
});

it('does not close or navigate when remaining-history lookup fails or is cancelled', async () => { setup({ onResolveNext: () => Promise.reject(new Error('cancelled')) }); await act(async () => { mock.callbacks.onAfterDelete(); }); expect(close).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); });

it('keeps mobile task controls inside the task menu and changes views without replacing a conversation', () => {
    const onView = vi.fn(), onMenuClose = vi.fn();
    const menu = { open: false, onClose: onMenuClose, onView, onInfo: vi.fn(), onOrdinary: vi.fn(), onProjectMenu: vi.fn() };
    setup({ mobile: true, mobileMenu: menu });
    expect(renderer.root.findAllByProps({ testID: 'test-history' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'test-delete-conversation' })).toHaveLength(0);
    setup({ mobile: true, mobileMenu: { ...menu, open: true } });
    press('test-mobile-files');
    expect(onView).toHaveBeenCalledExactlyOnceWith('files');
    expect(onMenuClose).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ testID: 'test-delete-conversation' })).toHaveLength(0);
    press('test-mobile-manage');
    press('test-delete-conversation');
    expect(mock.remove).toHaveBeenCalledTimes(1);
});
it('still advances a removed mobile task conversation while its menu is closed', () => {
    const mobileMenu = { open: false, onClose: vi.fn(), onView: vi.fn(), onInfo: vi.fn(), onOrdinary: vi.fn(), onProjectMenu: vi.fn() };
    setup({ mobile: true, mobileMenu, sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'two' }] });
    mock.sessions = { ...mock.sessions, one: { ...mock.session, metadata: { lifecycleState: 'archived' } } };
    setup({ mobile: true, mobileMenu, sessions: [...props.sessions, { ...props.sessions[0], sessionId: 'two' }] });
    expect(select).toHaveBeenCalledExactlyOnceWith('two');
});

it('keeps lifecycle action hooks mounted after closing the mobile sheet for confirmation', () => {
    const mobileMenu = { open: true, onClose: vi.fn(), onView: vi.fn(), onInfo: vi.fn(), onOrdinary: vi.fn(), onProjectMenu: vi.fn() };
    setup({ mobile: true, mobileMenu }); press('test-mobile-manage'); press('test-delete-conversation');
    setup({ mobile: true, mobileMenu: { ...mobileMenu, open: false } });
    expect(mock.unmount).not.toHaveBeenCalled();
    act(() => mock.callbacks.onAfterDelete());
    expect(close).toHaveBeenCalledTimes(1);
});

it('anchors desktop header delete confirmation to the trash button and cancels without deleting', () => {
    mock.os = 'web';
    setup({ scope: 'global' });
    press('test-delete-conversation');
    const host = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
    expect(host('session-delete-confirmation')).toBeDefined();
    expect(host('session-delete-arrow')).toBeDefined();
    expect(mock.remove).not.toHaveBeenCalled();
    expect(mock.confirmRemove).not.toHaveBeenCalled();
    act(() => host('session-delete-cancel').props.onPress({ stopPropagation() {} }));
    expect(host('session-delete-confirmation')).toBeUndefined();
    expect(mock.confirmRemove).not.toHaveBeenCalled();
    press('test-delete-conversation');
    act(() => host('session-delete-confirm').props.onPress({ stopPropagation() {} }));
    expect(mock.confirmRemove).toHaveBeenCalledOnce();
    expect(mock.remove).not.toHaveBeenCalled();
});
it('dismisses a pending header confirmation when a different conversation is selected', () => {
    mock.os = 'web'; setup(); press('test-delete-conversation');
    setup({ selectedId: 'two' });
    expect(renderer.root.findAllByProps({ testID: 'session-delete-confirmation' })).toHaveLength(0);
    setup({ selectedId: 'one' });
    expect(renderer.root.findAllByProps({ testID: 'session-delete-confirmation' })).toHaveLength(0);
    expect(mock.confirmRemove).not.toHaveBeenCalled();
});
