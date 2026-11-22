import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoalProject, GoalProjectConversationGroup } from '@slopus/happy-wire';
import type { ProjectConversationNavigationProps } from './ProjectConversationNavigation.types';

const mock = vi.hoisted(() => ({
    owner: { key: 'account', generation: '0', serverUrl: 'https://example.test', scope: 'test' },
    sessions: {} as Record<string, any>, unread: new Set<string>(), connected: true,
    deleted: new Set<string>(), deletionRevision: 0,
    deletionListeners: new Set<() => void>(),
    expansion: {} as Record<string, boolean>, expansionListeners: new Set<() => void>(),
    blur: undefined as (() => void) | undefined, canCreate: true, readOnly: false, maximized: false, width: 1600,
}));
vi.mock('expo-router', async () => {
    const React = await import('react');
    return { useFocusEffect: (callback: () => (() => void)) => React.useEffect(() => {
        const cleanup = callback(); mock.blur = cleanup; return cleanup;
    }, [callback]) };
});
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', TextInput: 'TextInput', ActivityIndicator: 'Spinner', useWindowDimensions:()=>({width:mock.width}),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: 'text', textLink: 'link', textSecondary: 'secondary', textDestructive: 'error',
        success: 'success', divider: 'divider', surface: 'surface', permission: { bypass: 'permission' } } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory(theme) } };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'zh', t: (key: string) => key }));
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => mock.owner }));
vi.mock('@/sync/storage', async () => {
    const React = await import('react');
    const update = (updater: any) => { mock.expansion = updater(mock.expansion); for (const listener of mock.expansionListeners) listener(); };
    return { storage: (select: any) => select({ sessions: mock.sessions, unreadSessionIds: mock.unread, socketStatus: mock.connected ? 'connected' : 'disconnected' }),
        useLocalSettingMutable: () => [React.useSyncExternalStore(listener => { mock.expansionListeners.add(listener); return () => { mock.expansionListeners.delete(listener); }; }, () => mock.expansion), (value: any) => update(() => value)],
        useLocalSettingUpdater: () => update,
    };
});
vi.mock('@/sync/projectSessionLinks', () => ({
    isProjectSessionDeleted: (id: string) => mock.deleted.has(id),
    getProjectSessionDeletionRevision: () => mock.deletionRevision,
    subscribeProjectSessionDeletions: (listener: () => void) => {
        mock.deletionListeners.add(listener); return () => { mock.deletionListeners.delete(listener); };
    },
}));
vi.mock('@/sync/projectConversationCandidates.web',()=>({loadProjectConversationCandidates:vi.fn().mockResolvedValue({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'}),releaseProjectConversationCandidates:vi.fn()}));
vi.mock('@/sync/ops', () => ({ machineStartGoalAuthor: vi.fn() }));
vi.mock('@/sync/projectGoals', () => ({
    projectGoalRequest: vi.fn(), canCreateProjectConversation: () => mock.canCreate,
    isReadOnlyProjectPreview: () => mock.readOnly,
}));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));
vi.mock('@/components/fileWorkspace/WorkspaceButton', () => ({ WorkspaceButton: (props: any) => React.createElement('Button', props, props.compact ? null : props.label) }));
vi.mock('@/components/fileWorkspace/WorkspaceTreeRow', () => ({ WorkspaceTreeRow: (props: any) => React.createElement('tree-row', props, props.title, props.badge, props.trailing) }));
vi.mock('@/components/fileWorkspace/context',()=>({useFileWorkspace:()=>({setMaximized:(value:boolean)=>{mock.maximized=value;}})}));
vi.mock('@/components/PanelTabs', () => ({ PanelTabs: 'PanelTabs' }));

import { projectGoalRequest } from '@/sync/projectGoals';
import { loadProjectConversationCandidates, releaseProjectConversationCandidates } from '@/sync/projectConversationCandidates.web';
import { machineStartGoalAuthor } from '@/sync/ops';
import { ProjectConversationNavigationProvider } from './ProjectConversationNavigation.web';
import { ProjectDetailsPanel } from './ProjectDetailsPanel.web';

const project: GoalProject = { projectPath: '/projects/paws', title: 'Paws', features: [
    { featurePath: '/projects/paws/features/web', title: 'Web' },
    { featurePath: '/projects/paws/features/mobile', title: 'Mobile' },
] };
function rememberedScopes() { return Object.fromEntries([project.projectPath,...project.features.map(feature=>feature.featurePath)].map(scope=>[`projects:conversation-navigation:${JSON.stringify(['machine',project.projectPath,scope])}`,true])); }
const webPath = project.features[0].featurePath;
const mobilePath = project.features[1].featurePath;
function history(id: string, directory = webPath, extra: Record<string, unknown> = {}) {
    return { sessionId: id, title: `History ${id}`, directory, updatedAt: 10, executed: true, ...extra };
}
function groups(): GoalProjectConversationGroup[] {
    return [
        { scopePath: project.projectPath, title: 'Paws', total: 2, sessions: [history('global', project.projectPath)] },
        { scopePath: webPath, title: 'Web', total: 31, sessions: [history('task-chat', webPath + '/tasks/one', { taskId: 'GFT-stable01' })], nextCursor: { updatedAt: 10, sessionId: 'task-chat' } },
        { scopePath: mobilePath, title: 'Mobile', total: 0, sessions: [] },
    ];
}
const response = (value = groups()) => ({ success: true, projectPath: project.projectPath, groups: value });
const select = vi.fn(), onTab = vi.fn();
let renderer: any;
let generation = 0;
let currentProps: Omit<ProjectConversationNavigationProps, 'children'>;
function Panel() {
    const [tab, setTab] = React.useState('details');
    return <ProjectDetailsPanel header={<span>Goal header</span>} tab={tab}
        onTab={value => { onTab(value); setTab(value); }} testID="project-scope-panel"
        footer={<span>Original footer</span>}><span>Original {tab}</span></ProjectDetailsPanel>;
}
function tree() { return <ProjectConversationNavigationProvider {...currentProps}><Panel /></ProjectConversationNavigationProvider>; }
async function setup(patch: Partial<Omit<ProjectConversationNavigationProps, 'children'>> = {}) {
    currentProps = { ...currentProps, ...patch };
    await act(async () => {
        if (renderer) renderer.update(tree());
        else renderer = TestRenderer.create(tree());
    });
}
// Tests for complete-history behavior explicitly perform the user's refresh action.
async function loadHistory(patch: Partial<Omit<ProjectConversationNavigationProps, 'children'>> = {}) {
    const mounted = !!renderer;
    await setup(patch);
    if (!mounted && mock.width >= 1100 && !currentProps.offline && !mock.readOnly) await press('project-conversations-refresh');
}
function controls() { return renderer.root.findAll((node: any) => node.type === 'Button' || node.type === 'tree-row'); }
function button(id: string) {
    const match = controls().find((node: any) => node.props.testID === id);
    expect(match, id).toBeDefined(); return match;
}
function byLabel(label: string) {
    const matches = controls().filter((node: any) => node.props.label === label);
    expect(matches, label).toHaveLength(1); return matches[0];
}
async function press(id: string) { await act(async () => { button(id).props.onPress(); }); }
function allText() {
    const text = (node: any): string => typeof node === 'string' ? node
        : Array.isArray(node) ? node.map(text).join('') : node ? text(node.children) : '';
    return text(renderer.toJSON());
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
function live(id: string, extra: any = {}) {
    return { id, updatedAt: 20, thinking: false, presence: 'online', active: true, agentState: {},
        metadata: { machineId: 'machine', path: webPath, goalBoard: { featurePath: webPath } }, ...extra };
}
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mock.owner = { key: 'account', generation: String(++generation), serverUrl: 'https://example.test', scope: 'test' };
    mock.sessions = {}; mock.unread = new Set(); mock.connected = true; mock.deleted.clear();
    mock.deletionRevision = 0; mock.deletionListeners.clear(); mock.blur = undefined;
    mock.canCreate = true; mock.readOnly = false; mock.maximized = false; mock.width=1600;
    mock.expansion = rememberedScopes(); mock.expansionListeners.clear();
    currentProps = { project, machineId: 'machine', agent: 'codex', offline: false, selectedId: 'global', onSelect: select };
    vi.mocked(projectGoalRequest).mockResolvedValue(response());
    vi.mocked(loadProjectConversationCandidates).mockResolvedValue({ candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot' });
    vi.mocked(machineStartGoalAuthor).mockResolvedValue({ type: 'success', sessionId: 'new-chat' });
});
afterEach(() => { if (renderer) act(() => { renderer.unmount(); }); renderer = undefined; vi.useRealTimers(); });


describe('on-demand complete conversation history', () => {
    it.each(['success', 'failure', 'cancel'] as const)('holds its catalog lease through grouping and releases exactly once after %s', async outcome => {
        const catalog = { candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'leased' };
        const pending = deferred<any>();
        vi.mocked(loadProjectConversationCandidates).mockResolvedValueOnce(catalog);
        vi.mocked(projectGoalRequest).mockReturnValueOnce(pending.promise);
        await loadHistory();
        expect(releaseProjectConversationCandidates).not.toHaveBeenCalled();
        expect(vi.mocked(projectGoalRequest).mock.calls[0][2]).toEqual({ projectPath: project.projectPath, ...catalog });
        if (outcome === 'cancel') {
            await press('project-conversations-cancel-history');
            expect(releaseProjectConversationCandidates).not.toHaveBeenCalled();
        }
        await act(async () => { pending.resolve(outcome === 'failure' ? { success: false } : response()); });
        expect(releaseProjectConversationCandidates).toHaveBeenCalledExactlyOnceWith(catalog);
    });
    it('releases a catalog arriving after cancellation without dispatching grouping', async () => {
        const pending = deferred<any>();
        vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
        await loadHistory();
        await press('project-conversations-cancel-history');
        const catalog = { candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'late' };
        await act(async () => { pending.resolve(catalog); });
        expect(projectGoalRequest).not.toHaveBeenCalled();
        expect(releaseProjectConversationCandidates).toHaveBeenCalledExactlyOnceWith(catalog);
    });
    it('opens remembered folders immediately without scanning account history or showing a spinner', async () => {
        mock.sessions = { synced: live('synced', { metadata: { machineId: 'machine', path: webPath } }) };
        await setup();
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
        expect(button('project-conversations-session-synced')).toBeDefined();
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
        expect(button('project-conversations-load-history').props.disabled).toBe(false);
        expect(button('project-conversations-filter-all').props.label).toBe('全部 —');
    });
    it('does not scan when a folder is expanded, reopened or files change', async () => {
        mock.expansion = {};
        await setup({ revision: 'initial' });
        await press(`project-conversations-toggle-${webPath}`);
        await setup({ revision: 'file-edit' });
        await press(`project-conversations-toggle-${webPath}`);
        await press(`project-conversations-toggle-${webPath}`);
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
        expect(projectGoalRequest).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
    });
    it('shows real complete-history progress and cancels without late rows or an automatic restart', async () => {
        const pending=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
        await setup();
        await press('project-conversations-load-history');
        const options=vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!;
        await act(async()=>{options.onProgress?.({phase:'catalog',processed:25,total:100});});
        expect(allText()).toContain('25%');
        expect(allText()).not.toContain('100%');
        await press('project-conversations-cancel-history');
        expect(options.signal!.aborted).toBe(true);
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
        await act(async()=>{options.onProgress?.({phase:'catalog',processed:100,total:100});pending.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'late'});});
        await setup({revision:'later-edit'});
        expect(projectGoalRequest).not.toHaveBeenCalled();
        expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
        expect(allText()).not.toContain('100%');
        expect(button('project-conversations-load-history').props.disabled).toBe(false);
    });
});

describe('compact conversation folders', () => {
    it('clears loading when the only expanded scope is removed during a pending read', async () => {
        mock.expansion={};const old=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(old.promise);
        await setup();await press(`project-conversations-toggle-${webPath}`);await press('project-conversations-load-history');
        await setup({project:{...project,features:[project.features[1]]}});
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
        expect(button('project-conversations-refresh').props.disabled).toBe(false);
        expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
    });
    it('cancels history when known scopes change without restarting an account scan', async () => {
        const old=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(old.promise);
        await loadHistory();const signal=vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!.signal!;
        const added=project.projectPath+'/features/docs';
        await setup({project:{...project,features:[project.features[0],{featurePath:added,title:'Docs'}]}});
        expect(signal.aborted).toBe(true);expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
        expect(button(`project-conversations-toggle-${added}`).props.title).toBe('Docs');
        await act(async()=>{old.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'superseded'});});
        expect(projectGoalRequest).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
        expect(controls().some((node:any)=>node.props.testID===`project-conversations-toggle-${mobilePath}`)).toBe(false);
    });

    it('keeps current folder names when old and refreshed group replies contain an older name', async () => {
        const old=deferred<any>();vi.mocked(projectGoalRequest).mockReturnValueOnce(old.promise);
        await loadHistory();
        await setup({project:{...project,features:[{...project.features[0],title:'Renamed web'},project.features[1]]}});
        expect(button(`project-conversations-toggle-${webPath}`).props.title).toBe('Renamed web');
        await act(async()=>{old.resolve(response());});
        expect(button(`project-conversations-toggle-${webPath}`).props.title).toBe('Renamed web');
        expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
    });
    it('updates known folders while all are folded without scanning history', async () => {
        mock.expansion={};await setup();
        const added=project.projectPath+'/features/docs';
        await setup({project:{...project,features:[{...project.features[0],title:'Renamed web'},{featurePath:added,title:'Docs'}]},revision:'new-scopes'});
        expect(button(`project-conversations-toggle-${webPath}`).props.title).toBe('Renamed web');
        expect(button(`project-conversations-toggle-${added}`).props.expanded).toBe(false);
        expect(controls().some((node:any)=>node.props.testID===`project-conversations-toggle-${mobilePath}`)).toBe(false);
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
    });

    it('does not queue history for file revisions while creation later fails', async () => {
        await loadHistory();const created=deferred<any>();vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
        await press(`project-conversations-new-${mobilePath}`);await setup({revision:'queued-during-create'});
        for(const scope of [project.projectPath,webPath,mobilePath]) await press(`project-conversations-toggle-${scope}`);
        await act(async()=>{created.reject(new Error('Creation failed'));});
        expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
    });

    it('preserves an explicit refresh queued during creation with all folders folded', async () => {
        mock.expansion={};await setup();const created=deferred<any>();vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
        await press(`project-conversations-new-${mobilePath}`);await press('project-conversations-refresh');
        await act(async()=>{created.reject(new Error('Creation failed'));});
        expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
    });
    it('defaults to collapsed known folders without reading the complete account catalog', async () => {
        mock.expansion = {};
        await setup();
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
        expect(projectGoalRequest).not.toHaveBeenCalled();
        for(const scope of [project.projectPath,webPath,mobilePath]) {
            expect(button(`project-conversations-toggle-${scope}`).props.expanded).toBe(false);
            expect(button(`project-conversations-new-${scope}`).props.disabled).toBe(false);
        }
        expect(allText()).not.toContain('开启第一个会话');
        expect(allText()).not.toContain('还没有会话');
        expect(allText()).not.toContain('features/mobile');
        await setup({revision:'changed-while-folded'});
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
    });

    it('shows existing scope sessions immediately on expansion and remembers the folder after remount', async () => {
        mock.expansion = {};
        mock.sessions = {'already-loaded':live('already-loaded')};
        await setup();await press(`project-conversations-toggle-${webPath}`);
        expect(button(`project-conversations-toggle-${webPath}`).props.expanded).toBe(true);
        expect(button('project-conversations-session-already-loaded')).toBeDefined();
        expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
        await act(async()=>{renderer.unmount();});renderer=undefined;
        mock.owner={...mock.owner,generation:'after-page-reload'};
        await setup();
        expect(button(`project-conversations-toggle-${webPath}`).props.expanded).toBe(true);
        expect(button(`project-conversations-toggle-${mobilePath}`).props.expanded).toBe(false);
        await setup({machineId:'another-machine'});
        expect(button(`project-conversations-toggle-${webPath}`).props.expanded).toBe(false);
    });

    it('cancels a pending traversal when all folders are collapsed without accepting late results', async () => {
        mock.expansion={};const pending=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
        await setup();await press(`project-conversations-toggle-${webPath}`);await press('project-conversations-load-history');
        const signal=vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!.signal!;
        await press(`project-conversations-toggle-${webPath}`);
        expect(signal.aborted).toBe(true);expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
        await act(async()=>{pending.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'late'});});
        expect(projectGoalRequest).not.toHaveBeenCalled();
        expect(allText()).not.toContain('AbortError');
    });
});

describe('project conversation navigation integration', () => {
    it('uses complete server totals and preserves task identity when navigating loaded history', async () => {
        await loadHistory();
        expect(loadProjectConversationCandidates).toHaveBeenCalledExactlyOnceWith('machine', project.projectPath, { refresh: true, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
        expect(projectGoalRequest).toHaveBeenCalledExactlyOnceWith('machine', 'goalProjectConversations', { projectPath: project.projectPath, candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot' }, expect.any(String));
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        expect(allText()).toContain('33 个会话 · 2 个子项目');
        await press('project-conversations-session-task-chat');
        expect(select).toHaveBeenCalledExactlyOnceWith({ scopePath: webPath, taskId: 'GFT-stable01', sessionId: 'task-chat' });
        expect(machineStartGoalAuthor).not.toHaveBeenCalled();
    });

    it('guards duplicate new clicks and creates in the exact empty feature scope', async () => {
        await loadHistory();
        const pending = deferred<any>(); vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
        const create = button(`project-conversations-new-${mobilePath}`).props.onPress;
        act(() => { create(); create(); });
        expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
        expect(machineStartGoalAuthor).toHaveBeenCalledWith('machine', {
            scopePath: mobilePath, requestId: expect.stringMatching(/^goal-navigation-/), agent: 'codex',
        });
        expect(button(`project-conversations-new-${webPath}`).props.disabled).toBe(true);
        await act(async () => { pending.resolve({ type: 'success', sessionId: 'new-mobile' }); });
        expect(select).toHaveBeenCalledExactlyOnceWith({ scopePath: mobilePath, sessionId: 'new-mobile' });
        expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
        expect(button('project-conversations-session-new-mobile')).toBeDefined();
    });

    it('queues refresh during creation and does not double count the returned new session', async () => {
        await loadHistory();
        const pending = deferred<any>(); vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
        act(() => { button(`project-conversations-new-${mobilePath}`).props.onPress(); });
        vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(group => group.scopePath === mobilePath
            ? { ...group, total: 1, sessions: [history('new-mobile', mobilePath)] } : group)));
        await press('project-conversations-refresh');
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        await act(async () => { pending.resolve({ type: 'success', sessionId: 'new-mobile' }); });
        expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
        expect(controls().filter((node: any) => node.props.testID === 'project-conversations-session-new-mobile')).toHaveLength(1);
    });

    it.each(['selection', 'blur', 'unmount', 'account'] as const)('does not navigate from a late creation after %s changes', async reason => {
        await loadHistory();
        const pending = deferred<any>(); vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
        act(() => { button(`project-conversations-new-${mobilePath}`).props.onPress(); });
        expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
        if (reason === 'selection') await loadHistory({ selectedId: 'another-chat' });
        else if (reason === 'blur') act(() => { mock.blur?.(); });
        else if (reason === 'unmount') { act(() => { renderer.unmount(); }); renderer = undefined; }
        else mock.owner = { ...mock.owner, generation: 'replacement' };
        await act(async () => { pending.resolve({ type: 'success', sessionId: 'late-chat' }); });
        expect(select).not.toHaveBeenCalled();
    });

    it('shows history failure and retries instead of claiming there are no conversations', async () => {
        vi.mocked(projectGoalRequest).mockRejectedValueOnce(new Error('History denied'));
        await loadHistory();
        expect(allText()).toContain('History denied');
        expect(allText()).not.toContain('还没有会话');
        expect(machineStartGoalAuthor).not.toHaveBeenCalled();
        await act(async () => { byLabel('重试').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
        expect(button('project-conversations-session-global')).toBeDefined();
        expect(allText()).not.toContain('History denied');
    });

    it('merges the requested group page, deduplicates IDs and retains other scope histories', async () => {
        await loadHistory();
        vi.mocked(projectGoalRequest).mockResolvedValue(response([{
            scopePath: webPath, title: 'Web', total: 31,
            sessions: [history('task-chat', webPath + '/tasks/one', { taskId: 'GFT-stable01', title: 'Updated task title' }), history('older')],
        }]));
        await act(async () => { byLabel('加载更多历史').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversations', {
            projectPath: project.projectPath, scopePath: webPath, candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot', cursor: { updatedAt: 10, sessionId: 'task-chat' },
        }, expect.any(String));
        expect(loadProjectConversationCandidates).toHaveBeenLastCalledWith('machine', project.projectPath, { refresh: false, signal: expect.any(AbortSignal), onProgress: expect.any(Function) });
        expect(button('project-conversations-session-global')).toBeDefined();
        expect(button('project-conversations-session-older')).toBeDefined();
        expect(controls().filter((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toHaveLength(1);
        expect(button('project-conversations-session-task-chat').props.label).toContain('Updated task title');
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        expect(controls().some((node: any) => node.props.label === '加载更多历史')).toBe(false);
    });

    it('replaces old groups instead of applying an old history cursor to a renewed snapshot', async () => {
        await loadHistory();
        vi.mocked(loadProjectConversationCandidates).mockResolvedValue({ candidates: [], catalogFingerprint: 'b'.repeat(64), catalogSnapshotId: 'renewed' });
        vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(group => ({ ...group, total: 0, sessions: [], nextCursor: undefined }))));
        await act(async () => { byLabel('加载更多历史').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversations', {
            projectPath: project.projectPath, candidates: [], catalogFingerprint: 'b'.repeat(64), catalogSnapshotId: 'renewed',
        }, expect.any(String));
        expect(button('project-conversations-filter-all').props.label).toBe('全部 0');
        expect(controls().some((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toBe(false);
    });

    it('uses canonical live outcomes and never treats cold executed history as completed', async () => {
        const ids = ['permission', 'failed', 'running', 'unread', 'complete', 'cold'];
        vi.mocked(projectGoalRequest).mockResolvedValue(response([
            { scopePath: project.projectPath, title: 'Paws', total: 0, sessions: [] },
            { scopePath: webPath, title: 'Web', total: ids.length, sessions: ids.map(id => history(id)) },
        ]));
        mock.sessions = {
            permission: live('permission', { thinking: true, agentState: { requests: { approve: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1 } } } }),
            failed: live('failed', { agentState: { turnStatus: { status: 'failed', updatedAt: 1 } } }),
            running: live('running', { thinking: true }),
            unread: live('unread', { agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } }),
            complete: live('complete', { agentState: { turnStatus: { status: 'completed', updatedAt: 1 } } }),
        };
        mock.unread.add('unread'); await loadHistory();
        expect(button('project-conversations-filter-attention').props.label).toBe('待处理 3');
        expect(button('project-conversations-filter-running').props.label).toBe('执行中 1');
        expect(button('project-conversations-session-permission').props.label).toContain('待回复 / 授权');
        expect(button('project-conversations-session-failed').props.label).toContain('status.failed');
        expect(button('project-conversations-session-unread').props.label).toContain('待查看');
        expect(button('project-conversations-session-complete').props.label).toContain('status.completed');
        expect(button('project-conversations-session-cold').props.label).toContain('历史会话');
        mock.connected = false; await loadHistory({ offline: true });
        expect(button('project-conversations-filter-running').props.label).toBe('执行中 0');
        expect(button('project-conversations-session-running').props.label).toContain('状态未知');
        expect(button(`project-conversations-new-${webPath}`).props.disabled).toBe(true);
        expect(button('project-conversations-session-cold').props.disabled).not.toBe(true);
    });

    it('removes deleted histories through the deletion subscription without a network refresh', async () => {
        await loadHistory();
        act(() => { mock.deleted.add('task-chat'); mock.deletionRevision++; for (const listener of mock.deletionListeners) listener(); });
        expect(controls().some((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toBe(false);
        expect(button('project-conversations-filter-all').props.label).toBe('全部 32');
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
    });

    it('keeps details and files reachable and returns to the same conversation navigation', async () => {
        await loadHistory();
        const tabs = () => renderer.root.findByType('PanelTabs');
        expect(tabs().props.activeTab).toBe('sessions');
        expect(tabs().props.tabs.map((tab: any) => tab.key)).toEqual(['sessions', 'details', 'files']);
        await act(async () => { tabs().props.onTabChange('details'); });
        expect(tabs().props.activeTab).toBe('details');
        expect(allText()).toContain('Original details'); expect(allText()).toContain('Original footer');
        await act(async () => { tabs().props.onTabChange('files'); });
        expect(tabs().props.activeTab).toBe('files'); expect(allText()).toContain('Original files');
        await act(async () => { tabs().props.onTabChange('sessions'); });
        expect(tabs().props.activeTab).toBe('sessions');
        expect(button('project-conversations-session-global').props.selected).toBe(true);
        expect(onTab).toHaveBeenLastCalledWith('details'); expect(select).not.toHaveBeenCalled();
    });
});
it('keeps compact Web task details and footer reachable when desktop tabs are hidden', async () => {
 await loadHistory();
 await act(async()=>{renderer.update(<ProjectConversationNavigationProvider {...currentProps}><ProjectDetailsPanel header={null} tab="details" onTab={onTab} testID="project-task-panel" showTabs={false} footer={<span>Mobile task actions</span>}><span>Mobile task details</span></ProjectDetailsPanel></ProjectConversationNavigationProvider>);});
 expect(allText()).toContain('Mobile task details');expect(allText()).toContain('Mobile task actions');
 expect(renderer.root.findAllByType('PanelTabs')).toHaveLength(0);
 expect(controls().filter((b:any)=>b.props.testID==='project-conversations-filter-all')).toHaveLength(0);
});
it('removes search while keeping filters and older history reachable',async()=>{
 await loadHistory();expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
 expect(allText()).not.toContain('搜索');
 await press('project-conversations-filter-running');
 expect(allText()).toContain('加载更多历史');expect(allText()).toContain('projectGoals.noFilteredConversations');
 await press('project-conversations-filter-all');expect(button('project-conversations-session-task-chat')).toBeDefined();
});

it('shows unknown counts while the first catalog is pending instead of claiming an empty project', async () => {
 const pending = deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await loadHistory();
 expect(button('project-conversations-filter-all').props.label).toBe('全部 —');
 expect(button('project-conversations-filter-attention').props.label).toBe('待处理 —');
 expect(button('project-conversations-filter-running').props.label).toBe('执行中 —');
 expect(allText()).toContain('加载历史…');expect(allText()).not.toContain('还没有会话');
 expect(renderer.root.findAllByType('Spinner')).toHaveLength(1);
 expect(projectGoalRequest).not.toHaveBeenCalled();
});

it.each(['catalog', 'groups'] as const)('ends a stuck %s read and accepts only the retried result', async stage => {
 vi.useFakeTimers();const pending = deferred<any>();
 if (stage === 'catalog') vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 else vi.mocked(projectGoalRequest).mockReturnValueOnce(pending.promise);
 await loadHistory();const signal = vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!.signal!;
 await loadHistory({revision:'changed-during-read'});
 await act(async()=>{await vi.advanceTimersByTimeAsync(180_000);});
 expect(signal.aborted).toBe(true);expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
 expect(allText()).toContain('errors.connectionTimeout');
 expect(button('project-conversations-refresh').props.disabled).toBe(false);
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
 const fresh = groups().map(group=>({...group,total:group.scopePath===webPath?1:0,sessions:group.scopePath===webPath?[history('fresh')]:[],nextCursor:undefined}));
 vi.mocked(projectGoalRequest).mockResolvedValue(response(fresh));
 await act(async()=>{byLabel('重试').props.onPress();});
 expect(button('project-conversations-session-fresh')).toBeDefined();
 expect(button('project-conversations-filter-all').props.label).toBe('全部 1');
 await act(async()=>{pending.resolve(stage==='catalog'?{candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'old'}:response());});
 expect(button('project-conversations-filter-all').props.label).toBe('全部 1');
 expect(button('project-conversations-session-fresh')).toBeDefined();
 expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
 expect(allText()).not.toContain('errors.connectionTimeout');
 if(stage==='groups')expect(vi.mocked(projectGoalRequest).mock.calls[0][3]).not.toBe(vi.mocked(projectGoalRequest).mock.calls[1][3]);
 expect(vi.getTimerCount()).toBe(0);
});

it('applies one deadline across catalog loading and group resolution', async () => {
 vi.useFakeTimers();const catalog = deferred<any>(), groupsPending = deferred<any>();
 vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 vi.mocked(projectGoalRequest).mockReturnValueOnce(groupsPending.promise);
 await loadHistory();await act(async()=>{await vi.advanceTimersByTimeAsync(170_000);});
 await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(projectGoalRequest).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
 expect(allText()).toContain('errors.connectionTimeout');expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
});

it('allows a healthy large catalog to finish after 85 seconds', async () => {
 vi.useFakeTimers();const pending=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await loadHistory();await act(async()=>{await vi.advanceTimersByTimeAsync(85_000);});
 expect(vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!.signal!.aborted).toBe(false);
 expect(allText()).not.toContain('errors.connectionTimeout');
 expect(button(`project-conversations-new-${webPath}`).props.disabled).toBe(false);
 await act(async()=>{pending.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(button('project-conversations-session-task-chat')).toBeDefined();expect(vi.getTimerCount()).toBe(0);
});

it('keeps already loaded rows and totals visible when a refresh times out', async () => {
 vi.useFakeTimers();await loadHistory();
 const pending = deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await press('project-conversations-refresh');
 expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
 expect(button('project-conversations-session-task-chat')).toBeDefined();
 await act(async()=>{await vi.advanceTimersByTimeAsync(180_000);});
 expect(button('project-conversations-session-task-chat')).toBeDefined();
 expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
 expect(allText()).toContain('errors.connectionTimeout');
});

it('aborts a pending read and removes its timer when the owner unmounts', async () => {
 vi.useFakeTimers();const pending = deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await loadHistory();const signal=vi.mocked(loadProjectConversationCandidates).mock.calls[0][2]!.signal!;
 await act(async()=>{renderer.unmount();});renderer=undefined;
 expect(signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
 await act(async()=>{pending.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(projectGoalRequest).not.toHaveBeenCalled();
});

it('does not scan during Strict Mode effect cleanup and loads only on user action', async () => {
 const old = deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(old.promise);
 await act(async()=>{renderer=TestRenderer.create(<React.StrictMode>{tree()}</React.StrictMode>);});
 expect(loadProjectConversationCandidates).not.toHaveBeenCalled();
 await press('project-conversations-load-history');
 await act(async()=>{old.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
 expect(button('project-conversations-session-task-chat')).toBeDefined();
 expect(renderer.root.findAllByType('Spinner')).toHaveLength(0);
 await act(async()=>{old.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'stale'});});
 expect(projectGoalRequest).toHaveBeenCalledTimes(1);
});
it('does not steal navigation after switching feature or file while creation is pending',async()=>{
 await loadHistory({locationKey:'feature-one'});const pending=deferred<any>();vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
 await press(`project-conversations-new-${mobilePath}`);await loadHistory({locationKey:'feature-two-file'});
 await act(async()=>pending.resolve({type:'success',sessionId:'late-scope'}));expect(select).not.toHaveBeenCalled();
});

it('reveals chat from a maximized file on the Sessions tab and on the already-selected history row',async()=>{
 await loadHistory();const tabs=()=>renderer.root.findByType('PanelTabs');
 await act(async()=>tabs().props.onTabChange('files'));mock.maximized=true;
 await act(async()=>tabs().props.onTabChange('sessions'));expect(mock.maximized).toBe(false);
 mock.maximized=true;onTab.mockClear();await press('project-conversations-session-global');
 expect(mock.maximized).toBe(false);expect(onTab).toHaveBeenCalledWith('details');expect(select).toHaveBeenCalledWith({scopePath:project.projectPath,sessionId:'global',taskId:undefined});
});

it('does not read complete history for the desktop-only navigator on compact Web',async()=>{
 mock.width=800;await loadHistory();expect(projectGoalRequest).not.toHaveBeenCalled();expect(allText()).toContain('Original details');expect(controls().filter((b:any)=>b.props.testID==='project-conversations-filter-all')).toHaveLength(0);
});

it('renders project scopes immediately with unknown counts and enabled new actions while the cold catalog loads', async () => {
 const pending=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await loadHistory();
 expect(button('project-conversations-filter-all').props.label).toBe('全部 —');
 expect(allText()).not.toContain('还没有会话');
 expect(allText()).toContain('加载历史');
 for(const scope of [project.projectPath,webPath,mobilePath])expect(button(`project-conversations-new-${scope}`).props.disabled).toBe(false);
 expect(machineStartGoalAuthor).not.toHaveBeenCalled();
});

it.each(['creation-first','history-first'] as const)('retains an immediately created scope session when cold read and create finish %s',async order=>{
 const catalog=deferred<any>(),created=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
 await loadHistory();await press(`project-conversations-new-${mobilePath}`);
 expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
 const readCompletes=async()=>{await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});};
 const createCompletes=async()=>{await act(async()=>{created.resolve({type:'success',sessionId:'created-during-load'});});};
 if(order==='creation-first'){await createCompletes();expect(button('project-conversations-filter-all').props.label).toBe('全部 —');await readCompletes();}
 else{await readCompletes();expect(button('project-conversations-filter-all').props.label).toBe('全部 33');await createCompletes();}
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(controls().filter((n:any)=>n.props.testID==='project-conversations-session-created-during-load')).toHaveLength(1);
 expect(select).toHaveBeenCalledExactlyOnceWith({scopePath:mobilePath,sessionId:'created-during-load'});
});

it('deduplicates a local creation already contained in the cold read snapshot',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await loadHistory();await press(`project-conversations-new-${mobilePath}`);
 expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[history('new-chat',mobilePath)]}:g)));
 await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(controls().filter((n:any)=>n.props.testID==='project-conversations-session-new-chat')).toHaveLength(1);
});

it('does not queue another history read for file revisions during a requested read',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await loadHistory({revision:'first'});await loadHistory({revision:'second'});await loadHistory({revision:'third'});
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
 await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
 expect(projectGoalRequest).toHaveBeenCalledTimes(1);
});

it('only obtains another fresh catalog for an explicit refresh, not an idle file revision',async()=>{
 await loadHistory({revision:'initial'});await loadHistory({revision:'idle-change'});await press('project-conversations-refresh');
 expect(vi.mocked(loadProjectConversationCandidates).mock.calls.map(call=>({refresh:call[2]?.refresh}))).toEqual([{refresh:true},{refresh:true}]);
});

it('retains the empty feature new-conversation action without a search field',async()=>{
 await loadHistory();expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
 expect(button(`project-conversations-new-${mobilePath}`).props.disabled).toBe(false);
 expect(renderer.root.findAllByProps({testID:`project-conversations-group-${mobilePath}`})).not.toHaveLength(0);
 expect(allText()).not.toContain('没有匹配结果');
});

it('keeps a new scope row through pagination without queuing a file-revision scan',async()=>{
 await loadHistory();const page=deferred<any>();
 vi.mocked(projectGoalRequest).mockReturnValueOnce(page.promise).mockResolvedValue(response());
 await act(async()=>byLabel('加载更多历史').props.onPress());
 await press(`project-conversations-new-${mobilePath}`);
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 await loadHistory({revision:'during-page'});
 await act(async()=>page.resolve(response([groups()[1]])));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-new-chat')).toBeDefined();
 expect(loadProjectConversationCandidates).toHaveBeenLastCalledWith('machine',project.projectPath,{refresh:false,signal:expect.any(AbortSignal),onProgress:expect.any(Function)});
});

it('does not add a created ID twice when the complete snapshot counts it outside the loaded history page',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await loadHistory();await press(`project-conversations-new-${mobilePath}`);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[]}:g)));
 await act(async()=>catalog.resolve({candidates:[{sessionId:'new-chat',directory:mobilePath,title:'New',metadataVersion:1}],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-new-chat')).toBeDefined();
});

it('does not increment a snapshot-counted ID when its creation callback arrives after history outside the loaded page',async()=>{
 const catalog=deferred<any>(),created=deferred<any>();
 vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
 await loadHistory();await press(`project-conversations-new-${mobilePath}`);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[]}:g)));
 await act(async()=>catalog.resolve({candidates:[{sessionId:'counted-not-loaded',directory:mobilePath,title:'Created',metadataVersion:1}],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 await act(async()=>created.resolve({type:'success',sessionId:'counted-not-loaded'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-counted-not-loaded')).toBeDefined();
 expect(select).toHaveBeenCalledExactlyOnceWith({scopePath:mobilePath,sessionId:'counted-not-loaded'});
});
