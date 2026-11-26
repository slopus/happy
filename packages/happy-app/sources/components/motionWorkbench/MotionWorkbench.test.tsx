import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    current: true, nonce: '', clients: [] as any[], session: {} as any, sessions: {} as Record<string, any>,
    workspace: { reference: null as any, setReference: vi.fn() },
    rpc: vi.fn(), queue: vi.fn(), link: vi.fn(), spawn: vi.fn(), hydrate: vi.fn(),
}));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { dark: true, colors: { surface: 'surface', divider: 'divider', text: 'text', textSecondary: 'secondary', textDestructive: 'error' } } }) }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/fileWorkspace/WorkspaceButton', () => ({ WorkspaceButton: 'WorkspaceButton' }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => state.current, getRuntimeAccountSelection: () => ({ key: 'account' }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://paws.invalid' }));
vi.mock('@/utils/sessionUtils', () => ({ resolveSessionState: (session: any) => ({ isConnected: session?.connected !== false }), getSessionName: (session: any) => session.title ?? session.id }));
vi.mock('@/sync/storage', () => ({ useSession: (id: string) => state.sessions[id], useAllSessions: () => Object.values(state.sessions), useSocketStatus: () => ({ status: 'connected' }), storage: { getState: () => ({ sessions: state.sessions }) } }));
vi.mock('@/sync/motionWorkbench.web', () => ({ motionWorkbenchRequest: state.rpc, MotionWorkbenchRpcError: class extends Error { code = 'STALE_REVIEW'; } }));
vi.mock('@/sync/messageStagingQueueRuntime', () => ({ stageSessionMessage: state.queue }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'zh-Hans' }));
vi.mock('@/components/DesktopDialogFrame', () => ({ DesktopDialogFrame: ({ visible, ...props }: any) => visible ? React.createElement('Dialog', props) : null }));
vi.mock('@/components/fileWorkspace/context', () => ({ useFileWorkspace: () => state.workspace }));
vi.mock('./motionArtifactLinks.web', () => ({ linkMotionProject: state.link }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: state.spawn }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionHydrated: state.hydrate } }));
vi.mock('./studioClient.web', () => ({
    motionStudioFrameHtml: (_bundle: unknown, nonce: string) => { state.nonce = nonce; return '<html></html>'; },
    createStudioClient: () => {
        const id = `00000000-0000-4000-8000-${String(state.clients.length + 1).padStart(12, '0')}`;
        const client = { open: vi.fn(async () => ({ descriptor: { bindingId: id, state: { document: { title: 'Paws 宣传片' } } }, bundle: { licenseText: 'GPL' }, assets: [] })),
            close: vi.fn(async () => true), getBindingId: () => id, state: vi.fn(), operation: vi.fn() };
        state.clients.push(client); return client;
    },
}));
import { MotionWorkbench } from './MotionWorkbench.web';

const snapshot = { protocol: 1, engine: 'motionharness', projectPath: '/owned/movie', documentRevision: 7, buildId: 'build', markerVersion: 'markers', projectId: 'a'.repeat(64), snapshotHash: 'b'.repeat(64), markers: [{ id: 'note', requestVersion: 1, label: 'AI 标记', notes: '只改工程名' }] };
let renderer: any;
const listeners = new Set<(event: any) => void>();
const frameWindow = {};
const ports: any[] = [];
const button = (testID: string) => renderer.root.findByProps({ testID });
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    state.current = true; state.clients.length = 0; state.nonce = '';
    state.session = { id: 'session', title: 'Viewing conversation', connected: true, metadata: { path: '/owned', machineId: 'machine', flavor: 'codex', motionWorkbenchChanges: [] as any[] }, agentState: undefined };
    state.sessions = { session: state.session, selected: { id: 'selected', title: 'Chosen editing conversation', connected: true, metadata: { path: '/owned', machineId: 'machine' } } };
    state.workspace.reference = null; state.workspace.setReference.mockReset().mockImplementation((reference: any) => { state.workspace.reference = typeof reference === 'function' ? reference(state.workspace.reference) : reference; });
    state.link.mockReset().mockResolvedValue(undefined); state.spawn.mockReset(); state.hydrate.mockReset().mockResolvedValue(true);
    state.rpc.mockReset().mockImplementation(async (_session, method) => method === 'motionWorkbenchInspect' ? snapshot : method === 'motionWorkbenchPrepareReview' ? { prompt: 'verified instructions' } : { closed: true });
    state.queue.mockReset().mockResolvedValue(undefined); listeners.clear(); ports.length = 0;
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { get length() { return storage.size; }, key: (i: number) => [...storage.keys()][i] ?? null,
        getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal('window', { addEventListener: (_type: string, listener: (event: any) => void) => listeners.add(listener), removeEventListener: (_type: string, listener: (event: any) => void) => listeners.delete(listener) });
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; vi.unstubAllGlobals(); });
async function mount(strict = false, onProjectTitleChange?: (title: string) => void) {
    const view = <MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} onProjectTitleChange={onProjectTitleChange} />;
    await act(async () => { renderer = TestRenderer.create(strict ? <React.StrictMode>{view}</React.StrictMode> : view, { createNodeMock: (element: any) => element.type === 'iframe' ? { contentWindow: frameWindow } : null }); });
}
function connect(nonce = state.nonce, source = frameWindow) {
    const port: any = { onmessage: null, close: vi.fn(), postMessage: vi.fn((message: any) => {
        if (message.type === 'prepare-close') queueMicrotask(() => port.onmessage?.({ data: { type: 'close-ready', id: message.id } }));
        if (message.type === 'context') queueMicrotask(() => port.onmessage?.({ data: { type: 'context', id: message.id, value: { playback: { time: 6.5 } } } }));
    }) };
    ports.push(port);
    for (const listener of listeners) listener({ source, data: { type: 'paws-motion-frame-ready', nonce }, ports: [port] });
    return port;
}
async function ready() { let port: any; await act(async () => { port = connect(); port.onmessage({ data: { type: 'ready' } }); }); return port; }
async function chooseTarget(id = 'selected') {
    await act(async () => button('motion-target-choose').props.onPress());
    await act(async () => button('motion-target:' + id).props.onPress());
}
async function openReview() { await act(async () => button('motion-review-open').props.onPress()); }

describe('workbench ownership and AI submission', () => {
    it('publishes the saved project title on open and on a native edit or refresh', async () => {
        const title = vi.fn();
        await mount(false, title);
        expect(title).toHaveBeenLastCalledWith('Paws 宣传片');
        const port = await ready();
        state.clients.at(-1).operation.mockResolvedValue({ value: { state: { document: { title: '新片名' } } }, assets: [] });
        await act(async () => port.onmessage({ data: { id: 1, type: 'operation', input: { route: 'document/commit' } } }));
        expect(title).toHaveBeenLastCalledWith('新片名');
        state.clients.at(-1).state.mockResolvedValue({ value: { document: { title: 'AI 保存的片名' } }, assets: [] });
        await act(async () => port.onmessage({ data: { id: 2, type: 'state', input: {} } }));
        expect(title).toHaveBeenLastCalledWith('AI 保存的片名');
        expect(JSON.stringify(renderer.toJSON())).toContain('AI 保存的片名');
    });
    it('does not start duplicate native opens during React StrictMode remounting', async () => {
        await mount(true);
        expect(state.clients.reduce((count, client) => count + client.open.mock.calls.length, 0)).toBe(1);
    });
    it('never sends project data to a foreign frame or nonce and accepts one owned child channel', async () => {
        await mount(); const wrongSource = connect(state.nonce, {}), wrongNonce = connect('00000000-0000-4000-8000-000000000999');
        expect(wrongSource.postMessage).not.toHaveBeenCalled(); expect(wrongNonce.postMessage).not.toHaveBeenCalled();
        const owned = connect(); expect(owned.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'paws-motion-connect' }));
        const duplicate = connect(); expect(duplicate.close).toHaveBeenCalledOnce(); expect(duplicate.postMessage).not.toHaveBeenCalled();
    });
    it('queues the exact revalidated review once even when send is clicked twice', async () => {
        await mount(); await ready(); await chooseTarget(); await openReview();
        await act(async () => { button('motion-review-send').props.onPress(); button('motion-review-send').props.onPress(); });
        expect(state.rpc.mock.calls.filter(([, method]) => method === 'motionWorkbenchPrepareReview')).toEqual([['session', 'motionWorkbenchPrepareReview', {
            projectPath: '/owned/movie', projectId: snapshot.projectId, snapshotHash: snapshot.snapshotHash, markers: [{ id: 'note', requestVersion: 1 }],
        }]]);
        expect(state.queue).toHaveBeenCalledExactlyOnceWith('selected', 'verified instructions', undefined, 'queue', expect.objectContaining({ displayText: expect.stringContaining('只改工程名') }));
    });
    it('opens a project and review without invoking AI until a conversation is explicitly chosen and sent', async () => {
        await mount(); await ready(); await openReview();
        expect(state.queue).not.toHaveBeenCalled(); expect(state.link).not.toHaveBeenCalled();
        expect(button('motion-review-send').props.disabled).toBe(true);
        await chooseTarget();
        expect(state.link).toHaveBeenCalledExactlyOnceWith('selected', { projectId: snapshot.projectId, projectPath: '/owned/movie', title: 'Paws 宣传片' });
        expect(state.queue).not.toHaveBeenCalled(); expect(button('motion-review-send').props.disabled).toBe(false);
        expect(JSON.stringify(renderer.toJSON())).toContain('Chosen editing conversation');
    });
    it('lists only connected same-machine conversations whose root contains the actual project', async () => {
        state.sessions.child = { id: 'child', metadata: { path: '/owned/movie', machineId: 'machine' } };
        state.sessions.sibling = { id: 'sibling', metadata: { path: '/owned-sibling', machineId: 'machine' } };
        state.sessions.outside = { id: 'outside', metadata: { path: '/elsewhere', machineId: 'machine' } };
        state.sessions.wrongMachine = { id: 'wrongMachine', metadata: { path: '/owned', machineId: 'another-machine' } };
        state.sessions.offline = { id: 'offline', connected: false, metadata: { path: '/owned', machineId: 'machine' } };
        await mount(); await ready(); await act(async () => button('motion-target-choose').props.onPress());
        const ids = renderer.root.findAllByType('WorkspaceButton').map((node: any) => node.props.testID).filter((id: unknown) => typeof id === 'string' && id.startsWith('motion-target:'));
        expect(ids.sort()).toEqual(['motion-target:child', 'motion-target:selected', 'motion-target:session']);
        expect(state.queue).not.toHaveBeenCalled();
    });
    it('keeps the chosen session and prepared prompt frozen when the current view is hidden or its input target changes', async () => {
        await mount(); await ready(); await chooseTarget(); await openReview();
        let finish!: (value: unknown) => void;
        state.rpc.mockImplementation(async (_session, method) => method === 'motionWorkbenchPrepareReview' ? new Promise(done => { finish = done; }) : snapshot);
        let pending: Promise<void> | undefined;
        act(() => { pending = button('motion-review-send').props.onPress(); });
        await act(async () => {});
        expect(finish).toEqual(expect.any(Function));
        state.workspace.reference = { motion: { projectPath: '/owned/another-film' } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible={false} onClose={() => {}} />));
        await act(async () => { finish({ prompt: 'frozen selected-project instructions' }); await pending; });
        expect(state.queue).toHaveBeenCalledExactlyOnceWith('selected', 'frozen selected-project instructions', undefined, 'queue', expect.any(Object));
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(state.queue).toHaveBeenCalledTimes(1);
    });
    it.each(['machine', 'root'])('never dispatches to a target whose %s changes after preparation', async reason => {
        await mount(); await ready(); await chooseTarget(); await openReview();
        state.rpc.mockImplementation(async (_session, method) => {
            if (method === 'motionWorkbenchPrepareReview') { if (reason === 'machine') state.sessions.selected.metadata.machineId = 'different'; else state.sessions.selected.metadata.path = '/not-allowed'; return { prompt: 'do not send' }; }
            return snapshot;
        });
        await act(async () => button('motion-review-send').props.onPress());
        expect(state.queue).not.toHaveBeenCalled(); expect(JSON.stringify(renderer.toJSON())).toContain('target session is unavailable');
    });
    it('keeps native draft input and does not link a conversation when the native close guard blocks selection', async () => {
        await mount(); const port = await ready();
        port.postMessage.mockImplementation((message: any) => {
            if (message.type === 'prepare-close') queueMicrotask(() => port.onmessage({ data: { type: 'close-blocked', id: message.id, message: 'Keep unconfirmed annotation' } }));
        });
        await chooseTarget();
        expect(state.link).not.toHaveBeenCalled(); expect(state.queue).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'motion-target-dialog' })).toBeDefined();
        expect(JSON.stringify(renderer.toJSON())).toContain('Keep unconfirmed annotation');
    });
    it('clears the current-conversation target when the composer reference is removed', async () => {
        await mount(); await ready(); await chooseTarget('session'); await openReview();
        expect(button('motion-review-send').props.disabled).toBe(false);
        state.workspace.reference = null;
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(button('motion-review-send').props.disabled).toBe(true); expect(state.queue).not.toHaveBeenCalled();
    });
    it('retains an already queued target and prompt when the displayed conversation is replaced', async () => {
        await mount(); await ready(); await chooseTarget(); await openReview();
        let finish!: () => void; state.queue.mockReturnValueOnce(new Promise<void>(done => { finish = done; }));
        act(() => { button('motion-review-send').props.onPress(); }); await act(async () => {});
        expect(state.queue).toHaveBeenCalledExactlyOnceWith('selected', 'verified instructions', undefined, 'queue', expect.any(Object));
        await act(async () => renderer.update(<MotionWorkbench sessionId="selected" projectPath="/owned/movie" visible onClose={() => {}} />));
        await act(async () => finish());
        expect(state.queue).toHaveBeenCalledTimes(1); expect(state.queue.mock.calls[0][0]).toBe('selected');
    });
    it('requires a fresh selection snapshot after a native document invalidation', async () => {
        await mount(); const port = await ready(); await chooseTarget(); await openReview();
        state.session.metadata.motionWorkbenchChanges = [{ bindingId: state.clients.at(-1).getBindingId(), sequence: 1 }];
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'refresh' });
        expect(button('motion-review-send').props.disabled).toBe(true); expect(JSON.stringify(renderer.toJSON())).toContain('motionWorkbench.reviewChanged');
        await act(async () => button('motion-review-open').props.onPress()); expect(button('motion-review-send').props.disabled).toBe(false);
    });
    it('never queues a prepared review after the account runtime has changed', async () => {
        await mount(); await ready(); await chooseTarget(); await openReview();
        state.rpc.mockImplementation(async () => { state.current = false; return { prompt: 'stale account' }; });
        await act(async () => button('motion-review-send').props.onPress()); expect(state.queue).not.toHaveBeenCalled();
    });
    it('refreshes a completed Agent build through its existing event and does not replay historical completion', async () => {
        state.session.agentState = { turnStatus: { status: 'completed', turnId: 'old', updatedAt: 1 } };
        await mount(); const port = await ready(); expect(port.postMessage).not.toHaveBeenCalledWith({ type: 'refresh' });
        state.session.agentState = { turnStatus: { status: 'completed', turnId: 'new', updatedAt: 2 } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(port.postMessage.mock.calls.filter(([message]: any[]) => message.type === 'refresh')).toHaveLength(1);
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(port.postMessage.mock.calls.filter(([message]: any[]) => message.type === 'refresh')).toHaveLength(1);
    });
    it.each(['before', 'after'])('safely reloads a changed native build %s Agent completion and restores the playhead', async order => {
        await mount(); const port = await ready();
        const change = () => port.onmessage({ data: { type: 'source-changed' } });
        if (order === 'before') await act(async () => change());
        expect(state.clients).toHaveLength(1);
        state.session.agentState = { turnStatus: { status: 'completed', turnId: 'new', updatedAt: 2 } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        if (order === 'after') await act(async () => change());
        expect(state.clients).toHaveLength(2); expect(state.clients[0].close).toHaveBeenCalledOnce();
        const next = await ready(); expect(next.postMessage).toHaveBeenCalledWith({ type: 'seek', time: 6.5 });
    });
    it.each(['before', 'after'])('reloads the frozen queued conversation build when its completion arrives %s the source event, even after choosing another conversation', async order => {
        state.sessions.selected.agentState = { turnStatus: { status: 'completed', turnId: 'historical-selected', updatedAt: 1 } };
        state.sessions.later = { id: 'later', title: 'Later chosen conversation', connected: true, metadata: { path: '/owned', machineId: 'machine' } };
        await mount(); const port = await ready(); await chooseTarget('selected'); await openReview();
        await act(async () => button('motion-review-send').props.onPress());
        expect(state.queue).toHaveBeenCalledExactlyOnceWith('selected', 'verified instructions', undefined, 'queue', expect.any(Object));
        await chooseTarget('later');
        expect(JSON.stringify(renderer.toJSON())).toContain('Later chosen conversation');
        // The mutable chosen conversation has never received this request.
        state.sessions.later.agentState = { turnStatus: { status: 'completed', turnId: 'unrelated-later', updatedAt: 4 } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        expect(state.clients).toHaveLength(1);
        const sourceChanged = () => port.onmessage({ data: { type: 'source-changed' } });
        if (order === 'before') await act(async () => sourceChanged());
        expect(state.clients).toHaveLength(1); // Historical completion is not replayed.
        state.sessions.selected.agentState = { turnStatus: { status: 'completed', turnId: 'queued-selected-result', updatedAt: 5 } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        if (order === 'after') await act(async () => sourceChanged());
        expect(state.session.agentState).toBeUndefined(); // Transport session never completed a turn.
        expect(state.clients).toHaveLength(2); expect(state.clients[0].close).toHaveBeenCalledOnce();
        const next = await ready(); expect(next.postMessage).toHaveBeenCalledWith({ type: 'seek', time: 6.5 });
        expect(state.queue).toHaveBeenCalledTimes(1);
    });
    it.each(['not-ready', 'read-error'])('reconnects to the same created conversation after a hydration %s without spawning another', async reason => {
        state.spawn.mockResolvedValueOnce({ type: 'success', sessionId: 'known-created' });
        if (reason === 'not-ready') state.hydrate.mockResolvedValueOnce(false);
        else state.hydrate.mockRejectedValueOnce(new Error('Metadata read failed'));
        state.hydrate.mockImplementationOnce(async (id: string) => {
            state.sessions[id] = { id, title: 'Recovered created conversation', connected: true, metadata: { path: '/owned', machineId: 'machine' } };
            return true;
        });
        await mount(); await ready(); await act(async () => button('motion-target-choose').props.onPress());
        await act(async () => button('motion-target-new').props.onPress());
        expect(state.spawn).toHaveBeenCalledTimes(1);
        expect(state.hydrate).toHaveBeenCalledExactlyOnceWith('known-created');
        expect(state.link).not.toHaveBeenCalled(); expect(state.queue).not.toHaveBeenCalled();
        expect(button('motion-target-new').props.label).toContain('重试连接已创建会话');
        expect(button('motion-target-new').props.disabled).toBe(false);
        await act(async () => button('motion-target-new').props.onPress());
        expect(state.spawn).toHaveBeenCalledTimes(1);
        expect(state.hydrate.mock.calls).toEqual([['known-created'], ['known-created']]);
        expect(state.link).toHaveBeenCalledExactlyOnceWith('known-created', { projectId: snapshot.projectId, projectPath: '/owned/movie', title: 'Paws 宣传片' });
        expect(JSON.stringify(renderer.toJSON())).toContain('Recovered created conversation');
        expect(state.queue).not.toHaveBeenCalled();
    });
    it('blocks another create attempt when the creation outcome is unknown', async () => {
        state.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'Delivery outcome unknown', outcomeUnknown: true });
        await mount(); await ready(); await act(async () => button('motion-target-choose').props.onPress());
        await act(async () => button('motion-target-new').props.onPress());
        expect(button('motion-target-new').props.disabled).toBe(true);
        // Even a stale event cannot turn an uncertain create into a duplicate request.
        await act(async () => button('motion-target-new').props.onPress());
        expect(state.spawn).toHaveBeenCalledTimes(1); expect(state.link).not.toHaveBeenCalled(); expect(state.queue).not.toHaveBeenCalled();
    });
    it('keeps an unconfirmed native draft and offers an explicit reload after a new build', async () => {
        await mount(); const port = await ready();
        port.postMessage.mockImplementation((message: any) => {
            if (message.type === 'prepare-close') queueMicrotask(() => port.onmessage({ data: { type: 'close-blocked', id: message.id, message: 'Keep native draft' } }));
        });
        state.session.agentState = { turnStatus: { status: 'completed', turnId: 'new', updatedAt: 2 } };
        await act(async () => renderer.update(<MotionWorkbench sessionId="session" projectPath="/owned/movie" visible onClose={() => {}} />));
        await act(async () => port.onmessage({ data: { type: 'source-changed' } }));
        expect(state.clients).toHaveLength(1); expect(state.clients[0].close).not.toHaveBeenCalled();
        expect(button('motion-reopen')).toBeDefined(); expect(JSON.stringify(renderer.toJSON())).toContain('Keep native draft');
    });
});
