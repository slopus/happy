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
vi.mock('@/sync/storage', () => ({ storage: (select: any) => select({
    sessions: mock.sessions, unreadSessionIds: mock.unread, socketStatus: mock.connected ? 'connected' : 'disconnected',
}) }));
vi.mock('@/sync/projectSessionLinks', () => ({
    isProjectSessionDeleted: (id: string) => mock.deleted.has(id),
    getProjectSessionDeletionRevision: () => mock.deletionRevision,
    subscribeProjectSessionDeletions: (listener: () => void) => {
        mock.deletionListeners.add(listener); return () => { mock.deletionListeners.delete(listener); };
    },
}));
vi.mock('@/sync/projectConversationCandidates.web',()=>({loadProjectConversationCandidates:vi.fn().mockResolvedValue({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'})}));
vi.mock('@/sync/ops', () => ({ machineStartGoalAuthor: vi.fn() }));
vi.mock('@/sync/projectGoals', () => ({
    projectGoalRequest: vi.fn(), canCreateProjectConversation: () => mock.canCreate,
    isReadOnlyProjectPreview: () => mock.readOnly,
}));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));
vi.mock('@/components/fileWorkspace/context',()=>({useFileWorkspace:()=>({setMaximized:(value:boolean)=>{mock.maximized=value;}})}));
vi.mock('@/components/PanelTabs', () => ({ PanelTabs: 'PanelTabs' }));

import { projectGoalRequest } from '@/sync/projectGoals';
import { loadProjectConversationCandidates } from '@/sync/projectConversationCandidates.web';
import { machineStartGoalAuthor } from '@/sync/ops';
import { ProjectConversationNavigationProvider } from './ProjectConversationNavigation.web';
import { ProjectDetailsPanel } from './ProjectDetailsPanel.web';

const project: GoalProject = { projectPath: '/projects/paws', title: 'Paws', features: [
    { featurePath: '/projects/paws/features/web', title: 'Web' },
    { featurePath: '/projects/paws/features/mobile', title: 'Mobile' },
] };
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
function button(id: string) {
    const match = renderer.root.findAllByType('Button').find((node: any) => node.props.testID === id);
    expect(match, id).toBeDefined(); return match;
}
function byLabel(label: string) {
    const matches = renderer.root.findAllByType('Button').filter((node: any) => node.props.label === label);
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
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
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
    currentProps = { project, machineId: 'machine', agent: 'codex', offline: false, selectedId: 'global', onSelect: select };
    vi.mocked(projectGoalRequest).mockResolvedValue(response());
    vi.mocked(loadProjectConversationCandidates).mockResolvedValue({ candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot' });
    vi.mocked(machineStartGoalAuthor).mockResolvedValue({ type: 'success', sessionId: 'new-chat' });
});
afterEach(() => { if (renderer) act(() => { renderer.unmount(); }); renderer = undefined; });

describe('project conversation navigation integration', () => {
    it('uses complete server totals and preserves task identity when navigating loaded history', async () => {
        await setup();
        expect(loadProjectConversationCandidates).toHaveBeenCalledExactlyOnceWith('machine', project.projectPath, { refresh: true });
        expect(projectGoalRequest).toHaveBeenCalledExactlyOnceWith('machine', 'goalProjectConversations', { projectPath: project.projectPath, candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot' });
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        expect(allText()).toContain('33 个会话 · 2 个子项目');
        await press('project-conversations-session-task-chat');
        expect(select).toHaveBeenCalledExactlyOnceWith({ scopePath: webPath, taskId: 'GFT-stable01', sessionId: 'task-chat' });
        expect(machineStartGoalAuthor).not.toHaveBeenCalled();
    });

    it('guards duplicate new clicks and creates in the exact empty feature scope', async () => {
        await setup();
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
        await setup();
        const pending = deferred<any>(); vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
        act(() => { button(`project-conversations-new-${mobilePath}`).props.onPress(); });
        vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(group => group.scopePath === mobilePath
            ? { ...group, total: 1, sessions: [history('new-mobile', mobilePath)] } : group)));
        await press('project-conversations-refresh');
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        await act(async () => { pending.resolve({ type: 'success', sessionId: 'new-mobile' }); });
        expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
        expect(renderer.root.findAllByType('Button').filter((node: any) => node.props.testID === 'project-conversations-session-new-mobile')).toHaveLength(1);
    });

    it.each(['selection', 'blur', 'unmount', 'account'] as const)('does not navigate from a late creation after %s changes', async reason => {
        await setup();
        const pending = deferred<any>(); vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
        act(() => { button(`project-conversations-new-${mobilePath}`).props.onPress(); });
        expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
        if (reason === 'selection') await setup({ selectedId: 'another-chat' });
        else if (reason === 'blur') act(() => { mock.blur?.(); });
        else if (reason === 'unmount') { act(() => { renderer.unmount(); }); renderer = undefined; }
        else mock.owner = { ...mock.owner, generation: 'replacement' };
        await act(async () => { pending.resolve({ type: 'success', sessionId: 'late-chat' }); });
        expect(select).not.toHaveBeenCalled();
    });

    it('shows history failure and retries instead of claiming there are no conversations', async () => {
        vi.mocked(projectGoalRequest).mockRejectedValueOnce(new Error('History denied'));
        await setup();
        expect(allText()).toContain('History denied');
        expect(allText()).not.toContain('还没有会话');
        expect(machineStartGoalAuthor).not.toHaveBeenCalled();
        await act(async () => { byLabel('重试').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenCalledTimes(2);
        expect(button('project-conversations-session-global')).toBeDefined();
        expect(allText()).not.toContain('History denied');
    });

    it('merges the requested group page, deduplicates IDs and retains other scope histories', async () => {
        await setup();
        vi.mocked(projectGoalRequest).mockResolvedValue(response([{
            scopePath: webPath, title: 'Web', total: 31,
            sessions: [history('task-chat', webPath + '/tasks/one', { taskId: 'GFT-stable01', title: 'Updated task title' }), history('older')],
        }]));
        await act(async () => { byLabel('加载更多历史').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversations', {
            projectPath: project.projectPath, scopePath: webPath, candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot', cursor: { updatedAt: 10, sessionId: 'task-chat' },
        });
        expect(loadProjectConversationCandidates).toHaveBeenLastCalledWith('machine', project.projectPath, { refresh: false });
        expect(button('project-conversations-session-global')).toBeDefined();
        expect(button('project-conversations-session-older')).toBeDefined();
        expect(renderer.root.findAllByType('Button').filter((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toHaveLength(1);
        expect(button('project-conversations-session-task-chat').props.label).toContain('Updated task title');
        expect(button('project-conversations-filter-all').props.label).toBe('全部 33');
        expect(renderer.root.findAllByType('Button').some((node: any) => node.props.label === '加载更多历史')).toBe(false);
    });

    it('replaces old groups instead of applying an old history cursor to a renewed snapshot', async () => {
        await setup();
        vi.mocked(loadProjectConversationCandidates).mockResolvedValue({ candidates: [], catalogFingerprint: 'b'.repeat(64), catalogSnapshotId: 'renewed' });
        vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(group => ({ ...group, total: 0, sessions: [], nextCursor: undefined }))));
        await act(async () => { byLabel('加载更多历史').props.onPress(); });
        expect(projectGoalRequest).toHaveBeenLastCalledWith('machine', 'goalProjectConversations', {
            projectPath: project.projectPath, candidates: [], catalogFingerprint: 'b'.repeat(64), catalogSnapshotId: 'renewed',
        });
        expect(button('project-conversations-filter-all').props.label).toBe('全部 0');
        expect(renderer.root.findAllByType('Button').some((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toBe(false);
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
        mock.unread.add('unread'); await setup();
        expect(button('project-conversations-filter-attention').props.label).toBe('待处理 3');
        expect(button('project-conversations-filter-running').props.label).toBe('执行中 1');
        expect(button('project-conversations-session-permission').props.label).toContain('待回复 / 授权');
        expect(button('project-conversations-session-failed').props.label).toContain('status.failed');
        expect(button('project-conversations-session-unread').props.label).toContain('待查看');
        expect(button('project-conversations-session-complete').props.label).toContain('status.completed');
        expect(button('project-conversations-session-cold').props.label).toContain('历史会话');
        mock.connected = false; await setup({ offline: true });
        expect(button('project-conversations-filter-running').props.label).toBe('执行中 0');
        expect(button('project-conversations-session-running').props.label).toContain('状态未知');
        expect(button(`project-conversations-new-${webPath}`).props.disabled).toBe(true);
        expect(button('project-conversations-session-cold').props.disabled).not.toBe(true);
    });

    it('removes deleted histories through the deletion subscription without a network refresh', async () => {
        await setup();
        act(() => { mock.deleted.add('task-chat'); mock.deletionRevision++; for (const listener of mock.deletionListeners) listener(); });
        expect(renderer.root.findAllByType('Button').some((node: any) => node.props.testID === 'project-conversations-session-task-chat')).toBe(false);
        expect(button('project-conversations-filter-all').props.label).toBe('全部 32');
        expect(projectGoalRequest).toHaveBeenCalledTimes(1);
    });

    it('keeps details and files reachable and returns to the same conversation navigation', async () => {
        await setup();
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
 await setup();
 await act(async()=>{renderer.update(<ProjectConversationNavigationProvider {...currentProps}><ProjectDetailsPanel header={null} tab="details" onTab={onTab} testID="project-task-panel" showTabs={false} footer={<span>Mobile task actions</span>}><span>Mobile task details</span></ProjectDetailsPanel></ProjectConversationNavigationProvider>);});
 expect(allText()).toContain('Mobile task details');expect(allText()).toContain('Mobile task actions');
 expect(renderer.root.findAllByType('PanelTabs')).toHaveLength(0);
 expect(renderer.root.findAllByType('Button').filter((b:any)=>b.props.testID==='project-conversations-filter-all')).toHaveLength(0);
});
it('retains older-history loading when search has no match on the first page',async()=>{
 await setup();const input=renderer.root.findByType('TextInput');await act(async()=>input.props.onChangeText('older missing title'));
 expect(allText()).toContain('加载更多历史');expect(allText()).toContain('已加载');
});
it('does not steal navigation after switching feature or file while creation is pending',async()=>{
 await setup({locationKey:'feature-one'});const pending=deferred<any>();vi.mocked(machineStartGoalAuthor).mockReturnValue(pending.promise);
 await press(`project-conversations-new-${mobilePath}`);await setup({locationKey:'feature-two-file'});
 await act(async()=>pending.resolve({type:'success',sessionId:'late-scope'}));expect(select).not.toHaveBeenCalled();
});

it('reveals chat from a maximized file on the Sessions tab and on the already-selected history row',async()=>{
 await setup();const tabs=()=>renderer.root.findByType('PanelTabs');
 await act(async()=>tabs().props.onTabChange('files'));mock.maximized=true;
 await act(async()=>tabs().props.onTabChange('sessions'));expect(mock.maximized).toBe(false);
 mock.maximized=true;onTab.mockClear();await press('project-conversations-session-global');
 expect(mock.maximized).toBe(false);expect(onTab).toHaveBeenCalledWith('details');expect(select).toHaveBeenCalledWith({scopePath:project.projectPath,sessionId:'global',taskId:undefined});
});

it('does not read complete history for the desktop-only navigator on compact Web',async()=>{
 mock.width=800;await setup();expect(projectGoalRequest).not.toHaveBeenCalled();expect(allText()).toContain('Original details');expect(renderer.root.findAllByType('Button').filter((b:any)=>b.props.testID==='project-conversations-filter-all')).toHaveLength(0);
});

it('renders project scopes immediately with unknown counts and enabled new actions while the cold catalog loads', async () => {
 const pending=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(pending.promise);
 await setup();
 expect(button('project-conversations-filter-all').props.label).toBe('全部 —');
 expect(allText()).not.toContain('还没有会话');
 expect(allText()).toContain('加载历史');
 for(const scope of [project.projectPath,webPath,mobilePath])expect(button(`project-conversations-new-${scope}`).props.disabled).toBe(false);
 expect(machineStartGoalAuthor).not.toHaveBeenCalled();
});

it.each(['creation-first','history-first'] as const)('retains an immediately created scope session when cold read and create finish %s',async order=>{
 const catalog=deferred<any>(),created=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
 await setup();await press(`project-conversations-new-${mobilePath}`);
 expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
 const readCompletes=async()=>{await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});};
 const createCompletes=async()=>{await act(async()=>{created.resolve({type:'success',sessionId:'created-during-load'});});};
 if(order==='creation-first'){await createCompletes();expect(button('project-conversations-filter-all').props.label).toBe('全部 —');await readCompletes();}
 else{await readCompletes();expect(button('project-conversations-filter-all').props.label).toBe('全部 33');await createCompletes();}
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(renderer.root.findAllByType('Button').filter((n:any)=>n.props.testID==='project-conversations-session-created-during-load')).toHaveLength(1);
 expect(select).toHaveBeenCalledExactlyOnceWith({scopePath:mobilePath,sessionId:'created-during-load'});
});

it('deduplicates a local creation already contained in the cold read snapshot',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await setup();await press(`project-conversations-new-${mobilePath}`);
 expect(machineStartGoalAuthor).toHaveBeenCalledTimes(1);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[history('new-chat',mobilePath)]}:g)));
 await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(renderer.root.findAllByType('Button').filter((n:any)=>n.props.testID==='project-conversations-session-new-chat')).toHaveLength(1);
});

it('coalesces startup revisions into one cached-catalog reaggregation instead of a second fresh scan',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await setup({revision:'first'});await setup({revision:'second'});await setup({revision:'third'});
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(1);
 await act(async()=>{catalog.resolve({candidates:[],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'});});
 expect(loadProjectConversationCandidates).toHaveBeenCalledTimes(2);
 expect(vi.mocked(loadProjectConversationCandidates).mock.calls.map(call=>call[2])).toEqual([{refresh:true},{refresh:false}]);
 expect(projectGoalRequest).toHaveBeenCalledTimes(2);
});

it('still obtains a fresh catalog for an idle revision and an explicit refresh',async()=>{
 await setup({revision:'initial'});await setup({revision:'idle-change'});await press('project-conversations-refresh');
 expect(vi.mocked(loadProjectConversationCandidates).mock.calls.map(call=>call[2])).toEqual([{refresh:true},{refresh:true},{refresh:true}]);
});

it('finds an empty feature by its path and retains its new conversation action',async()=>{
 await setup();await act(async()=>renderer.root.findByType('TextInput').props.onChangeText('features/mobile'));
 expect(button(`project-conversations-new-${mobilePath}`).props.disabled).toBe(false);
 expect(renderer.root.findAllByProps({testID:`project-conversations-group-${mobilePath}`})).not.toHaveLength(0);
 expect(allText()).not.toContain('没有匹配结果');
});

it('keeps a new scope row through a paginated read followed by a queued cached reaggregation',async()=>{
 await setup();const page=deferred<any>();
 vi.mocked(projectGoalRequest).mockReturnValueOnce(page.promise).mockResolvedValue(response());
 await act(async()=>byLabel('加载更多历史').props.onPress());
 await press(`project-conversations-new-${mobilePath}`);
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 await setup({revision:'during-page'});
 await act(async()=>page.resolve(response([groups()[1]])));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-new-chat')).toBeDefined();
 expect(loadProjectConversationCandidates).toHaveBeenLastCalledWith('machine',project.projectPath,{refresh:false});
});

it('does not add a created ID twice when the complete snapshot counts it outside the loaded history page',async()=>{
 const catalog=deferred<any>();vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 await setup();await press(`project-conversations-new-${mobilePath}`);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[]}:g)));
 await act(async()=>catalog.resolve({candidates:[{sessionId:'new-chat',directory:mobilePath,title:'New',metadataVersion:1}],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-new-chat')).toBeDefined();
});

it('does not increment a snapshot-counted ID when its creation callback arrives after history outside the loaded page',async()=>{
 const catalog=deferred<any>(),created=deferred<any>();
 vi.mocked(loadProjectConversationCandidates).mockReturnValueOnce(catalog.promise);
 vi.mocked(machineStartGoalAuthor).mockReturnValueOnce(created.promise);
 await setup();await press(`project-conversations-new-${mobilePath}`);
 vi.mocked(projectGoalRequest).mockResolvedValue(response(groups().map(g=>g.scopePath===mobilePath?{...g,total:1,sessions:[]}:g)));
 await act(async()=>catalog.resolve({candidates:[{sessionId:'counted-not-loaded',directory:mobilePath,title:'Created',metadataVersion:1}],catalogFingerprint:'a'.repeat(64),catalogSnapshotId:'snapshot'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 await act(async()=>created.resolve({type:'success',sessionId:'counted-not-loaded'}));
 expect(button('project-conversations-filter-all').props.label).toBe('全部 34');
 expect(button('project-conversations-session-counted-not-loaded')).toBeDefined();
 expect(select).toHaveBeenCalledExactlyOnceWith({scopePath:mobilePath,sessionId:'counted-not-loaded'});
});
