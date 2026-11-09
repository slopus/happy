import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    socket: 'connecting', session: { metadata: { path: '/work', machineId: 'machine' }, agentState: { turnStatus: { status: 'completed', turnId: 'initial', updatedAt: 1 } } },
    reads: vi.fn(), writes: vi.fn(), artifacts: vi.fn(), persisted: {} as Record<string, unknown>, references: {} as Record<string, { path: string; hash: string; quote?: string } | null>, current: true,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@/hooks/useDesktopWorkspaceLayout', () => ({ useDesktopWorkspaceLayout: () => ({ rightPanelAvailable: true }) }));
vi.mock('@/sync/storage', () => ({ useMachine: () => null, useSession: () => mocks.session, useSocketStatus: () => ({ status: mocks.socket }) }));
vi.mock('@/auth/accountRuntime', () => ({ accountRuntimeCurrent: () => mocks.current, getRuntimeAccountSelection: () => ({ key: 'account' }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://fixture.test' }));
vi.mock('@/sync/persistence', () => ({
    loadWorkspaceVersionOperations: () => ({}), saveWorkspaceVersionOperations: vi.fn(),
    loadFileWorkspaceUI: () => ({ tabs: ['/work/方案.md'], active: '/work/方案.md', open: true, width: 430 }), saveFileWorkspaceUI: vi.fn(),
    loadFileWorkspaceReference: (scope: string) => mocks.references[scope] ?? null,
    saveFileWorkspaceReference: (scope: string, value: any) => { mocks.references[scope] = structuredClone(value); },
    loadFileWorkspaceDrafts: () => mocks.persisted,
    saveFileWorkspaceDrafts: (_scope: string, value: any) => { mocks.persisted = structuredClone(value); return true; },
}));
vi.mock('@/sync/artifactWorkspace', () => ({ artifactRequest: (...args: any[]) => mocks.artifacts(...args), artifactInvalidations: () => [] }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./fileIO', () => ({ readWorkspaceText: (...args: any[]) => mocks.reads(...args), writeWorkspaceText: (...args: any[]) => mocks.writes(...args) }));
import { SessionFileWorkspaceProvider } from './SessionFileWorkspaceProvider';
import { useFileWorkspace, type FileWorkspaceContextValue } from './context';
let value: FileWorkspaceContextValue;
function Probe() { value = useFileWorkspace()!; return null; }
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function node() { return <SessionFileWorkspaceProvider sessionId="session"><Probe /></SessionFileWorkspaceProvider>; }
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.socket = 'connecting'; mocks.current = true; mocks.session.metadata.path = '/work'; mocks.session.agentState.turnStatus = { status: 'completed', turnId: 'initial', updatedAt: 1 };
    mocks.persisted = {}; mocks.references = {}; mocks.reads.mockReset().mockResolvedValue({ content: '# Base', hash: 'base' }); mocks.writes.mockReset().mockResolvedValue({ hash: 'saved' });
    mocks.artifacts.mockReset().mockResolvedValue([]);
});
describe('workspace owner in real session lifecycle', () => {
    it('renders file content while version discovery is still waiting', async () => {
        mocks.socket = 'connected';
        mocks.artifacts.mockReturnValue(new Promise(() => {}));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        try {
            expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ phase: 'ready', content: '# Base' });
            expect(mocks.reads).toHaveBeenCalledTimes(1);
            expect(mocks.artifacts).toHaveBeenCalled();
        } finally {
            await act(async () => { renderer.unmount(); await tick(); });
        }
    });
    it('reports a missing file immediately without querying version history', async () => {
        mocks.socket = 'connected';
        mocks.artifacts.mockReturnValue(new Promise(() => {}));
        mocks.reads.mockRejectedValue(new Error('ENOENT: missing'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        try {
            expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ phase: 'error', error: 'ENOENT: missing' });
            expect(mocks.artifacts).not.toHaveBeenCalled();
        } finally {
            await act(async () => { renderer.unmount(); await tick(); });
        }
    });
    it('keeps a draft editable when background version discovery fails', async () => {
        mocks.socket = 'connected';
        mocks.artifacts.mockRejectedValue(new Error('version service offline'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        try {
            await act(async () => { value.controller.edit('/work/方案.md', '# Mine'); await tick(); });
            expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ phase: 'ready', draft: '# Mine', error: null });
        } finally {
            await act(async () => { renderer.unmount(); await tick(); });
        }
    });
    it('does not start background version requests when a file read finishes after unmount', async () => {
        mocks.socket = 'connected';
        let finishRead!: (result: { content: string; hash: string }) => void;
        mocks.reads.mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        await act(async () => { renderer.unmount(); await tick(); });
        await act(async () => { finishRead({ content: '# Late', hash: 'late' }); await tick(); });
        expect(mocks.artifacts).not.toHaveBeenCalled();
    });
    it('waits for connection before restoring tabs and keeps dirty content across a full remount', async () => {
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        expect(mocks.reads).not.toHaveBeenCalled();
        mocks.socket = 'connected'; await act(async () => { renderer.update(node()); await tick(); });
        expect(mocks.reads).toHaveBeenCalledTimes(1);
        await act(async () => { value.controller.edit('/work/方案.md', '# Unsaved'); await tick(); });
        expect(mocks.persisted).toEqual({ '/work/方案.md': { draft: '# Unsaved', hash: 'base' } });
        await act(async () => { renderer.unmount(); await tick(); });
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ draft: '# Unsaved', conflict: false });
        await act(async () => { renderer.unmount(); await tick(); });
    });
    it('preserves cached drafts when the machine is unavailable and restores against a changed baseline on reconnect', async () => {
        mocks.socket = 'connected'; mocks.persisted = { '/work/方案.md': { draft: '# My draft', hash: 'base' } };
        mocks.reads.mockRejectedValueOnce(new Error('Machine offline'));
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        expect(mocks.persisted['/work/方案.md']).toMatchObject({ draft: '# My draft' });
        mocks.reads.mockResolvedValue({ content: '# External', hash: 'new' });
        mocks.socket = 'disconnected'; await act(async () => { renderer.update(node()); await tick(); });
        mocks.socket = 'connected'; await act(async () => { renderer.update(node()); await tick(); });
        expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ draft: '# My draft', content: '# External', conflict: true });
        await act(async () => { renderer.unmount(); await tick(); });
    });
    it('refreshes once on completion, preserves a dirty draft, and ignores a subsequent account switch', async () => {
        mocks.socket = 'connected'; let renderer: any;
        await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
        await act(async () => { value.controller.edit('/work/方案.md', '# Mine'); await tick(); });
        mocks.reads.mockResolvedValue({ content: '# Agent', hash: 'agent' });
        mocks.session.agentState.turnStatus = { status: 'completed', turnId: 'agent-turn', updatedAt: 2 };
        await act(async () => { renderer.update(node()); await tick(); });
        expect(mocks.reads).toHaveBeenCalledTimes(2);
        expect(value.snapshot.documents['/work/方案.md']).toMatchObject({ draft: '# Mine', conflict: true });
        mocks.current = false;
        await act(async () => { await value.controller.open('/work/another.md'); });
        expect(value.snapshot.tabs).toEqual(['/work/方案.md']);
        await act(async () => { renderer.unmount(); await tick(); });
    });
});

it('restores pending file context after reload, keeps the original baseline, and clears it on removal', async () => {
    mocks.socket = 'connected'; let renderer: any;
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    const reference = { path: '/work/方案.md', hash: 'base', quote: 'Original selection' };
    await act(async () => { value.setReference(reference); await tick(); });
    await act(async () => { renderer.unmount(); await tick(); });
    mocks.reads.mockResolvedValue({ content: '# New on disk', hash: 'new' });
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    expect(value.reference).toEqual(reference);
    expect(value.snapshot.documents['/work/方案.md'].hash).toBe('new');
    await act(async () => { value.setReference(null); await tick(); });
    await act(async () => { renderer.unmount(); await tick(); });
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    expect(value.reference).toBeNull();
    await act(async () => { renderer.unmount(); await tick(); });
});
it('does not restore a pending reference from a different cwd', async () => {
    mocks.socket = 'connected'; let renderer: any;
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    await act(async () => { value.setReference({ path: '/work/方案.md', hash: 'base' }); await tick(); });
    await act(async () => { renderer.unmount(); await tick(); });
    mocks.session.metadata.path = '/another';
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    expect(value.reference).toBeNull();
    await act(async () => { renderer.unmount(); await tick(); });
});

it('rebinds a restored file only after matching background version metadata arrives', async () => {
    mocks.socket = 'connected';
    const artifact = { id: 'artifact', workspaceId: 'workspace', entryPath: '方案.md' };
    const restored = {
        artifact, entryContent: '# Restored', workingRevision: 'revision',
        readRef: { kind: 'version', versionId: 'restored-version' },
        manifest: { entryPath: '方案.md', files: [{ path: '方案.md', sha256: 'restored-hash' }] },
    };
    let finishRead!: (value: typeof restored) => void;
    const delayed = new Promise<typeof restored>(resolve => { finishRead = resolve; });
    let restoring = false;
    mocks.artifacts.mockImplementation(async (_machine, method) => {
        if (method === 'artifactCapabilities') return { protocol: 2 };
        if (method === 'artifactCatalog') return [{ artifacts: [artifact] }];
        if (method === 'artifactRead') return restoring ? delayed : restored;
        return {};
    });
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(node()); await tick(); });
    vi.spyOn(value.versions, 'restore').mockResolvedValue(true);
    mocks.reads.mockResolvedValue({ content: '# Restored', hash: 'restored-hash' });
    restoring = true;
    let operation!: Promise<boolean>;
    await act(async () => { operation = value.restoreVersion('/work/方案.md'); await tick(); });
    expect(value.reference).toBeNull();
    await act(async () => { finishRead(restored); await operation; await tick(); });
    expect(value.reference).toMatchObject({
        path: '/work/方案.md', hash: 'restored-hash',
        artifact: { artifactId: 'artifact', expectedRevision: 'revision', versionId: 'restored-version' },
    });
    await act(async () => { renderer.unmount(); await tick(); });
});
