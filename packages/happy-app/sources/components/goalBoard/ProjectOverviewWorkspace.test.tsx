import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ history: [] as any[], sessions: {} as Record<string, any>, owner: { key: 'account' }, fileOpen: false, maximized: false, blur: undefined as undefined | (() => void) }));
vi.mock('expo-router', async () => { const React = await import('react'); return { useFocusEffect: (callback: () => (() => void)) => React.useEffect(() => { const cleanup = callback(); mock.blur = cleanup; return cleanup; }, [callback]) }; });
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Pressable: 'Pressable', View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'Spinner', useWindowDimensions: () => ({ width: 1680 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => { const theme = { colors: { text: 'text', textLink: 'link', textSecondary: 'secondary', textDestructive: 'error', divider: 'divider' } }; return { useUnistyles: () => ({ theme }), StyleSheet: { create: (f: any) => f(theme) } }; });
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mock.owner }));
vi.mock('@/sync/storage', () => ({ storage: (select: any) => select({ sessions: mock.sessions }) }));
vi.mock('@/sync/ops', () => ({ machineStartGoalAuthor: vi.fn() }));
vi.mock('@/sync/projectGoals', () => ({ canCreateProjectConversation: () => true, loadProjectScope: vi.fn(), loadProjectScopeHistory: vi.fn(), projectGoalRequest: vi.fn(), projectScopeFiles: () => ({}) }));
vi.mock('@/sync/projectWorkspaceCache', () => ({ projectCacheKey: (kind: string) => kind, projectHistorySchema: {}, writeProjectCache: vi.fn(), isProjectSessionDeleted: () => false }));
vi.mock('./useProjectData', () => ({ useCachedProjectResource: (key: string) => ({ value: key === 'overview' ? { title: 'Real scope', goal: 'Real goal', scopePath: '/scope', indexPath: '/scope/index.md', fileCount: 8, countComplete: true } : { sessions: mock.history }, loading: false }) }));
vi.mock('@/components/fileWorkspace/SessionFileWorkspaceProvider', () => ({ SessionFileWorkspaceProvider: ({ children }: any) => children }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => ({ snapshot: { open: mock.fileOpen }, enabled: true, maximized: mock.maximized }) }));
vi.mock('./ProjectArchiveTree', () => ({ ProjectArchiveTree: 'Tree' }));
vi.mock('@/components/fileWorkspace/FileWorkspace', () => ({ FileWorkspace: 'File' }));
vi.mock('./ProjectConversationHeader', () => ({ ProjectConversationHeader: 'ConversationHeader' }));
vi.mock('./ProjectDetailsPanel', () => ({ ProjectDetailsPanel: ({ header, children, footer }: any) => <>{header}{children}{footer}</> }));
vi.mock('./ProjectConversationEmptyState', () => ({ ProjectConversationEmptyState: 'Empty' }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));
vi.mock('@/-session/SessionView', () => ({ SessionView: 'Session' }));
import { ProjectOverviewWorkspace } from './ProjectOverviewWorkspace';
import { loadProjectScopeHistory } from '@/sync/projectGoals';
import { machineStartGoalAuthor } from '@/sync/ops';
let renderer: any;
const select = vi.fn();
const session = { sessionId: 'existing', title: 'Real discussion', directory: '/scope', updatedAt: 1, executed: false };
function setup(conversationId?: string) {
    act(() => { renderer = TestRenderer.create(<React.StrictMode><ProjectOverviewWorkspace machineId="machine" scopePath="/scope" title="Scope" agent="codex" offline={false} surface="transparent" selectConversation={select} conversationId={conversationId}><div>Catalog</div></ProjectOverviewWorkspace></React.StrictMode>); });
    return () => renderer.root.findAllByType('Button').find((node: any) => node.props.testID === 'project-scope-open-chat').props.onPress();
}
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.history = []; mock.sessions = {}; mock.fileOpen = false; mock.maximized = false; vi.mocked(loadProjectScopeHistory).mockResolvedValue([]); vi.mocked(machineStartGoalAuthor).mockResolvedValue({ type: 'success', sessionId: 'new-empty' }); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); });
it('selection renders the global brief without creating or entering any conversation', () => { setup(); expect(machineStartGoalAuthor).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); });
it('explicit open resumes the scope history without creating a conversation', async () => { vi.mocked(loadProjectScopeHistory).mockResolvedValue([session]); const press = setup(); await act(async () => { press(); }); expect(select).toHaveBeenCalledExactlyOnceWith('existing'); expect(machineStartGoalAuthor).not.toHaveBeenCalled(); });
it('a verified new empty session is reused while server history catches up', async () => { const press = setup(); await act(async () => { press(); press(); }); await act(async () => { press(); }); expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1); expect(select.mock.calls.map(call => call[0])).toEqual(['new-empty', 'new-empty']); });
it('failed history never creates a new conversation', async () => { vi.mocked(loadProjectScopeHistory).mockRejectedValue(new Error('History unavailable')); const press = setup(); await act(async () => { press(); }); expect(machineStartGoalAuthor).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); });
it('cached global association cannot render a session explicitly rebound to a Task', () => { mock.history = [session]; mock.sessions.existing = { metadata: { machineId: 'machine', path: '/scope', goalBoard: { featurePath: '/scope', taskId: 'sibling' } } }; setup('existing'); expect(renderer.root.findAllByType('Session')).toHaveLength(0); });

it('leaving the screen during history lookup prevents late creation and navigation', async () => {
    let resolve!: (sessions: any[]) => void;
    vi.mocked(loadProjectScopeHistory).mockReturnValue(new Promise(done => { resolve = done; }));
    const press = setup();
    act(() => { press(); });
    act(() => { mock.blur?.(); });
    await act(async () => { resolve([]); });
    expect(machineStartGoalAuthor).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
});
it('leaving the screen during creation prevents a late session from changing the route', async () => {
    let resolve!: (result: any) => void;
    vi.mocked(machineStartGoalAuthor).mockReturnValue(new Promise(done => { resolve = done; }));
    const press = setup();
    await act(async () => { press(); });
    expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
    act(() => { mock.blur?.(); });
    await act(async () => { resolve({ type: 'success', sessionId: 'new-empty' }); });
    expect(select).not.toHaveBeenCalled();
});

it('explicit new creates a separate conversation even when verified history exists', async () => {
    mock.history = [session]; setup('existing');
    const header = renderer.root.findByType('ConversationHeader');
    await act(async () => { header.props.onNew(); header.props.onNew(); });
    expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
    expect(loadProjectScopeHistory).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledExactlyOnceWith('new-empty');
});
it('separate explicit new actions use distinct idempotency keys', async () => {
    mock.history = [session]; setup('existing');
    await act(async () => { renderer.root.findByType('ConversationHeader').props.onNew(); });
    await act(async () => { renderer.root.findByType('ConversationHeader').props.onNew(); });
    const calls = vi.mocked(machineStartGoalAuthor).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1].requestId).not.toBe(calls[1][1].requestId);
});
it('an unresolved selected conversation keeps the catalog beside the reserved chat slot without rendering an unverified session', () => {
    setup('not-yet-verified');
    expect(renderer.root.findAllByType('div')).toHaveLength(1);
    expect(renderer.root.findAllByType('Session')).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'project-scope-chat' })).toHaveLength(1);
});
it('history switching keeps the details panel and uses the selected scope session', () => {
    mock.history = [session]; setup('existing');
    act(() => renderer.root.findByType('ConversationHeader').props.onSelect('older'));
    expect(select).toHaveBeenCalledExactlyOnceWith('older');
    expect(renderer.root.findByProps({ testID: 'project-scope-panel' })).toBeDefined();
    expect(machineStartGoalAuthor).not.toHaveBeenCalled();
});
it('keeps cards visible while switching the center between conversation and document', () => {
    mock.history = [session]; mock.fileOpen = true; setup('existing');
    act(() => renderer.root.findAllByType('View').find((node: any) => node.props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 1600 } } }));
    expect(renderer.root.findByType('File').parent.props.style.display).toBe('none');
    expect(renderer.root.findByProps({ testID: 'project-scope-center-chat-tab' }).props.accessibilityState.selected).toBe(true);
    act(() => renderer.root.findByProps({ testID: 'project-scope-panel' }).props.onTab('files'));
    expect(renderer.root.findByType('File').parent.props.style.display).toBeUndefined();
    expect(renderer.root.findAllByType('Tree')).toHaveLength(1);
    expect(renderer.root.findAllByType('div')).toHaveLength(1);
    act(() => renderer.root.findByProps({ testID: 'project-scope-panel' }).props.onTab('details'));
    expect(renderer.root.findByType('File').parent.props.style.display).toBe('none');
    expect(renderer.root.findByProps({ testID: 'project-scope-center-chat-tab' }).props.accessibilityState.selected).toBe(true);
    expect(renderer.root.findAllByType('Tree')).toHaveLength(0);
});

it('returns from files to discussion and back through the center tabs without reopening a file', () => {
    mock.history = [session]; mock.fileOpen = true; setup('existing');
    act(() => renderer.root.findByProps({ testID: 'project-scope-panel' }).props.onTab('files'));
    const file = renderer.root.findByType('File');
    const chat = renderer.root.findByProps({ testID: 'project-scope-chat' });
    const discussion = renderer.root.findByType('Session');
    const tab = (key: string) => renderer.root.findByProps({ testID: `project-scope-center-${key}-tab` });

    for (let i = 0; i < 2; i++) {
        expect(tab('file').props.accessibilityState.selected).toBe(true);
        act(() => tab('chat').props.onPress());
        expect(file.parent.props.style.display).toBe('none');
        expect(chat.parent.props.style.display).toBeUndefined();
        expect(tab('chat').props.accessibilityState.selected).toBe(true);
        act(() => tab('file').props.onPress());
        expect(file.parent.props.style.display).toBeUndefined();
        expect(chat.parent.props.style.display).toBe('none');
        expect(renderer.root.findByType('File')).toBe(file);
        expect(renderer.root.findByType('Session')).toBe(discussion);
        expect(renderer.root.findAllByType('Tree')).toHaveLength(1);
        expect(renderer.root.findAllByType('div')).toHaveLength(1);
    }
    expect(select).not.toHaveBeenCalled();
    expect(machineStartGoalAuthor).not.toHaveBeenCalled();
});

it.each([
    { fileOpen: false, maximized: false, conversationId: 'existing' },
    { fileOpen: true, maximized: false, conversationId: undefined },
    { fileOpen: true, maximized: true, conversationId: 'existing' },
])('omits the center switcher when only one view is available: %o', ({ fileOpen, maximized, conversationId }) => {
    mock.history = [session]; mock.fileOpen = fileOpen; mock.maximized = maximized; setup(conversationId);
    expect(renderer.root.findAllByProps({ testID: 'project-scope-center-file-tab' })).toHaveLength(0);
});
