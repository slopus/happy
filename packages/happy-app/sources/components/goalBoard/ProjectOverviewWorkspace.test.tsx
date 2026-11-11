import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ history: [] as any[], sessions: {} as Record<string, any>, owner: { key: 'account' }, blur: undefined as undefined | (() => void) }));
vi.mock('expo-router', async () => { const React = await import('react'); return { useFocusEffect: (callback: () => (() => void)) => React.useEffect(() => { const cleanup = callback(); mock.blur = cleanup; return cleanup; }, [callback]) }; });
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'Spinner', useWindowDimensions: () => ({ width: 1680 }) }));
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
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => ({ snapshot: { open: false }, enabled: true }) }));
vi.mock('@/components/fileWorkspace/WorkspaceDirectoryTree', () => ({ WorkspaceDirectoryTree: 'Tree' }));
vi.mock('@/components/fileWorkspace/FileWorkspace', () => ({ FileWorkspace: 'File' }));
vi.mock('@/components/PanelTabs', () => ({ PanelTabs: 'Tabs' }));
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
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); mock.history = []; mock.sessions = {}; vi.mocked(loadProjectScopeHistory).mockResolvedValue([]); vi.mocked(machineStartGoalAuthor).mockResolvedValue({ type: 'success', sessionId: 'new-empty' }); });
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
