import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const mock = vi.hoisted(() => ({ sessions: {} as Record<string, any>, machines: { machine: {} },
    segments: {} as Record<string, any>, read: vi.fn(), spawn: vi.fn(), update: vi.fn(), send: vi.fn(), hydrate: vi.fn(), rpc: vi.fn(), machineRpc: vi.fn(),
    updateSessionFastMode: vi.fn(), updateSessionPermissionMode: vi.fn(), updateSessionModelMode: vi.fn(), updateSessionEffortLevel: vi.fn(),
    applySessions: (rows: any[]) => { for (const row of rows) mock.sessions[row.id] = row; },
}));
const persisted = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return persisted.get(key); }
    set(key: string, value: string) { persisted.set(key, value); }
    delete(key: string) { persisted.delete(key); }
} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '9efc1c63-e694-44c6-b14e-3b1e6fae0706', CryptoDigestAlgorithm: { SHA256: 'SHA256' },
    digestStringAsync: async (_alg: string, text: string) => (await import('node:crypto')).createHash('sha256').update(text).digest('hex') }));
vi.mock('./storage', () => ({ storage: { getState: () => mock, subscribe: () => () => {} } }));
vi.mock('./sync', () => ({ sync: { sendMessage: mock.send, readPortableContextSegment: mock.read } }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mock.rpc, machineRPC: mock.machineRpc } }));
vi.mock('./ops', () => ({ machineSpawnNewSession: mock.spawn, sessionUpdateMetadata: mock.update }));
vi.mock('./ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: mock.hydrate }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: () => 'portable-test-continuation', assertAccountRuntime: () => {} }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => 'Original task' }));
let sourceCounter = 0;
let archiveText: string[];
beforeEach(() => {
    vi.resetModules(); vi.resetAllMocks(); persisted.clear();
    mock.sessions = {}; mock.segments = {}; archiveText = [];
    mock.read.mockImplementation(async id => {
        if (!mock.segments[id]) throw new Error('portable-context-history-unavailable');
        return mock.segments[id];
    });
    mock.hydrate.mockResolvedValue(true);
    mock.update.mockImplementation(async (_id, meta, version, fn) => ({ metadata: fn(meta), version: version + 1 }));
    mock.rpc.mockImplementation(async (_id, method, input) => {
        expect(method).toBe('portable-context-upload');
        if (input.action === 'append') { archiveText[input.index] = input.chunk; return { success: true }; }
        const text = archiveText.join('');
        const { snapshot } = JSON.parse(text);
        expect(createHash('sha256').update(text).digest('hex')).toBe(input.sha256);
        return { success: true, descriptor: { version: 1, id: snapshot.id, sha256: input.sha256,
            rootSessionId: snapshot.rootSessionId, sourceSessionId: snapshot.sourceSessionId, heads: snapshot.heads } };
    });
});
function source(id = `source-${sourceCounter++}`, text = 'Remember ORCHID and fix its parser') {
    mock.sessions[id] = { id, metadataVersion: 1, metadata: { path: '/project', machineId: 'machine', flavor: 'codex', host: 'host' },
        permissionMode: 'default', modelMode: 'gpt-6-astra', effortLevel: 'medium' };
    mock.segments[id] = { head: { sessionId: id, throughSeq: 1, afterSeq: 0 }, items: [{ id: `${id}/1/0`, sourceSessionId: id, seq: 1, role: 'user', text }],
        assertCurrent: vi.fn(), verifyCurrent: vi.fn(async () => {}) };
    mock.spawn.mockImplementation(async () => {
        mock.sessions.new = { id: 'new', metadataVersion: 1, metadata: { path: '/project', machineId: 'machine', host: 'host',
            portableContextProtocol: 1, codexThreadId: 'fresh-provider-id' } };
        return { type: 'success', sessionId: 'new' };
    });
    return id;
}

describe('complete continuation installation', () => {
    it('installs a verified archive without copying source model, permissions or provider identity', async () => {
        const id = source();
        mock.sessions.target = { id: 'target', metadataVersion: 4, metadata: { flavor: 'antigravity', portableContextProtocol: 1,
            machineId: 'machine', path: '/project', host: 'host', currentModelCode: 'gemini-neon', custom: 'keep' } };
        const { prepareSessionContinuationContext, attachSessionContinuationContext } = await import('./sessionContextHandoff');
        const prepared = await prepareSessionContinuationContext(id);
        await attachSessionContinuationContext('target', id, prepared);
        expect(mock.sessions.target.metadata).toMatchObject({ flavor: 'antigravity', currentModelCode: 'gemini-neon', custom: 'keep',
            continuationOfSessionId: id, continuationContext: prepared.context, portableContext: { id: prepared.archive.snapshot.id, sha256: prepared.sha256 } });
        expect(mock.sessions.target.metadata).not.toHaveProperty('codexThreadId');
        expect(prepared.context).toContain('ORCHID');
        expect(mock.sessions[id].metadata.continuedBySessionId).toBeUndefined();
        expect(mock.updateSessionModelMode).not.toHaveBeenCalled();
        expect(mock.send).not.toHaveBeenCalled();
    });
    it('uploads every byte of a large source in acknowledged chunks before linking metadata', async () => {
        const text = '中'.repeat(70000) + 'EXACT_TAIL';
        const id = source(undefined, text);
        const { createSessionContinuation } = await import('./sessionContinuation');
        expect(await createSessionContinuation(id)).toBe('new');
        expect(mock.rpc.mock.calls.filter(call => call[2].action === 'append').length).toBeGreaterThan(1);
        expect(JSON.parse(archiveText.join('')).snapshot.items[0].text).toBe(text);
        expect(mock.sessions.new.metadata.continuationContext).not.toContain('EXACT_TAIL');
        expect(mock.sessions.new.metadata.continuationContext).toContain('thread_read');
        expect(mock.sessions.new.metadata.portableContext.sha256).toHaveLength(64);
    });
    it('stops at clear in a non-root source and never loads cleared ancestors', async () => {
        source('root', 'CLEARED_SECRET'); source('current', 'CURRENT_TASK');
        mock.sessions.current.metadata = { ...mock.sessions.current.metadata, continuationOfSessionId: 'root', conversationRootSessionId: 'root' };
        mock.segments.current.boundary = { id: 'clear-id', afterSeq: 0 };
        const prepared = await (await import('./sessionContextHandoff')).prepareSessionContinuationContext('current');
        expect(prepared.archive.snapshot.rootSessionId).toBe('root');
        expect(prepared.archive.snapshot.heads.map(head => head.sessionId)).toEqual(['current']);
        expect(mock.read).toHaveBeenCalledExactlyOnceWith('current');
        expect(JSON.stringify(prepared.archive)).not.toContain('CLEARED_SECRET');
    });
    it('includes every original segment rather than recursively carrying previous excerpts', async () => {
        source('root', 'EARLY_ORIGINAL'); source('second', 'LATER_ORIGINAL');
        mock.sessions.root.metadata.conversationActiveSessionId = 'second';
        mock.sessions.second.metadata.conversationRootSessionId = 'root';
        mock.sessions.second.metadata.continuationOfSessionId = 'root';
        mock.sessions.second.metadata.continuationContext = 'OBSOLETE_SNIPPET';
        const prepared = await (await import('./sessionContextHandoff')).prepareSessionContinuationContext('second');
        expect(prepared.archive.snapshot.items.map(item => item.text)).toEqual(['EARLY_ORIGINAL', 'LATER_ORIGINAL']);
        expect(JSON.stringify(prepared.archive)).not.toContain('OBSOLETE_SNIPPET');
    });
    it('rejects a cycle or machine/path mismatch without constructing partial history', async () => {
        source('root'); source('second');
        mock.sessions.root.metadata.conversationActiveSessionId = 'second';
        mock.sessions.second.metadata.conversationRootSessionId = 'root';
        mock.sessions.second.metadata.continuationOfSessionId = 'root';
        mock.sessions.root.metadata.continuationOfSessionId = 'second';
        const { prepareSessionContinuationContext } = await import('./sessionContextHandoff');
        await expect(prepareSessionContinuationContext('second')).rejects.toThrow('invalid-lineage');
        delete mock.sessions.root.metadata.continuationOfSessionId;
        mock.sessions.root.metadata.path = '/different';
        await expect(prepareSessionContinuationContext('second')).rejects.toThrow('lineage-mismatch');
    });
    it('does not publish a partial upload or an unverified commit digest', async () => {
        const id = source(); await mock.spawn();
        const { prepareSessionContinuationContext, attachSessionContinuationContext } = await import('./sessionContextHandoff');
        const prepared = await prepareSessionContinuationContext(id);
        mock.rpc.mockResolvedValueOnce({ success: false });
        await expect(attachSessionContinuationContext('new', id, prepared)).rejects.toThrow('upload-failed');
        expect(mock.update).not.toHaveBeenCalled();
        mock.rpc.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true, descriptor: {
            version: 1, id: prepared.archive.snapshot.id, sha256: '0'.repeat(64), rootSessionId: id, sourceSessionId: id, heads: prepared.archive.snapshot.heads,
        } });
        await expect(attachSessionContinuationContext('new', id, prepared)).rejects.toThrow('commit-unconfirmed');
        expect(mock.update).not.toHaveBeenCalled();
    });
    it('fails closed when a source changes after preparation and before upload', async () => {
        const id = source(); await mock.spawn();
        const { prepareSessionContinuationContext, attachSessionContinuationContext } = await import('./sessionContextHandoff');
        const prepared = await prepareSessionContinuationContext(id);
        mock.segments[id].verifyCurrent.mockRejectedValueOnce(new Error('source changed'));
        await expect(attachSessionContinuationContext('new', id, prepared)).rejects.toThrow('source changed');
        expect(mock.rpc).not.toHaveBeenCalled();
    });
    it('requires a real worker history-tool capability, with no legacy text fallback', async () => {
        vi.useFakeTimers();
        try {
            const id = source(); await mock.spawn(); delete mock.sessions.new.metadata.portableContextProtocol;
            const { prepareSessionContinuationContext, attachSessionContinuationContext } = await import('./sessionContextHandoff');
            const installing = attachSessionContinuationContext('new', id, await prepareSessionContinuationContext(id));
            const rejected = expect(installing).rejects.toThrow('worker-upgrade-required');
            await vi.advanceTimersByTimeAsync(20001); await rejected;
            expect(mock.rpc).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });
});

describe('ordinary independent continuation lifecycle', () => {
    it('uses a fresh native identity, preserves settings and sends nothing', async () => {
        const id = source();
        expect(await (await import('./sessionContinuation')).createSessionContinuation(id)).toBe('new');
        expect(mock.spawn).toHaveBeenCalledWith({ machineId: 'machine', directory: '/project', agent: 'codex', approvedNewDirectoryCreation: false });
        expect(mock.sessions.new.metadata).toMatchObject({ continuationOfSessionId: id, codexThreadId: 'fresh-provider-id' });
        expect(mock.sessions[id].metadata.continuedBySessionId).toBe('new');
        expect(mock.updateSessionModelMode).toHaveBeenCalledWith('new', 'gpt-6-astra');
        expect(mock.updateSessionPermissionMode).toHaveBeenCalledWith('new', 'default');
        expect(mock.send).not.toHaveBeenCalled();
    });
    it('survives reload after spawn succeeded without spawning twice', async () => {
        const id = source(); mock.hydrate.mockResolvedValue(false);
        await expect((await import('./sessionContinuation')).createSessionContinuation(id)).rejects.toThrow('hydration-failed');
        vi.resetModules(); mock.hydrate.mockResolvedValue(true);
        expect(await (await import('./sessionContinuation')).createSessionContinuation(id)).toBe('new');
        expect(mock.spawn).toHaveBeenCalledTimes(1);
    });
    it('does not create an empty successor when full history is unavailable', async () => {
        const id = source(); delete mock.segments[id];
        await expect((await import('./sessionContinuation')).createSessionContinuation(id)).rejects.toThrow('history-unavailable');
        expect(mock.spawn).not.toHaveBeenCalled();
    });
    it('retains an unknown RPC outcome instead of silently creating another worker', async () => {
        const id = source(); mock.spawn.mockResolvedValue({ type: 'error', errorMessage: 'timeout', outcomeUnknown: true });
        const { createSessionContinuation } = await import('./sessionContinuation');
        await expect(createSessionContinuation(id)).rejects.toThrow('outcome-unknown');
        await expect(createSessionContinuation(id)).rejects.toThrow('outcome-unknown');
        expect(mock.spawn).toHaveBeenCalledTimes(1);
    });
    it('opens an existing successor and rejects retired sources before reading or starting anything', async () => {
        const id = source(); mock.sessions[id].metadata.continuedBySessionId = 'existing';
        const { createSessionContinuation } = await import('./sessionContinuation');
        expect(await createSessionContinuation(id)).toBe('existing');
        mock.sessions[id].metadata.flavor = 'personal';
        await expect(createSessionContinuation(id)).rejects.toThrow('personal-agent-retired');
        expect(mock.spawn).not.toHaveBeenCalled(); expect(mock.read).not.toHaveBeenCalled();
    });
});


it('reuses the frozen inherited archive and never reads parent future messages or its later clear', async () => {
    source('parent', 'ORIGINAL_PARENT_AT_FORK'); source('child', 'CHILD_WORK');
    mock.sessions.child.metadata.continuationOfSessionId = 'parent';
    const prefix = { snapshot: { version: 1, id: '542f508a-1122-446b-9039-b98f8a3f67ea', rootSessionId: 'parent', sourceSessionId: 'parent',
        heads: [{ sessionId: 'parent', throughSeq: 1, afterSeq: 0 }], items: [...mock.segments.parent.items] }, blobKeys: {} };
    const text = JSON.stringify(prefix);
    const descriptor = { version: 1, id: prefix.snapshot.id, sha256: createHash('sha256').update(text).digest('hex'),
        rootSessionId: 'parent', sourceSessionId: 'parent', heads: prefix.snapshot.heads };
    mock.sessions.parent.metadata.portableContextBoundary = { id: 'clear-after-branch', afterSeq: 10 };
    mock.segments.parent.items.push({ id: 'parent/2/0', sourceSessionId: 'parent', seq: 2, role: 'user', text: 'PARENT_FUTURE_MUST_NOT_LEAK' });
    mock.machineRpc.mockImplementation(async (_machine, method, input) => {
        expect(method).toBe('read-conversation-context');
        expect(input.sourceSessionId).toBe('child');
        const end = Math.min(input.textOffset + 77, text.length);
        return { success: true, chunk: text.slice(input.textOffset, end), nextTextOffset: end < text.length ? end : null, descriptor };
    });
    const prepared = await (await import('./sessionContextHandoff')).prepareSessionContinuationContext('child');
    expect(mock.read).toHaveBeenCalledExactlyOnceWith('child');
    expect(prepared.archive.snapshot.items.map(item => item.text)).toEqual(['ORIGINAL_PARENT_AT_FORK', 'CHILD_WORK']);
    expect(prepared.archive.snapshot.heads[0]).toEqual({ sessionId: 'parent', throughSeq: 1, afterSeq: 0 });
    expect(JSON.stringify(prepared.archive)).not.toContain('PARENT_FUTURE_MUST_NOT_LEAK');
});

it('does not guess the inheritance boundary of an old excerpt-only independent continuation', async () => {
    source('child'); mock.sessions.child.metadata.continuationOfSessionId = 'parent';
    mock.machineRpc.mockResolvedValue({ success: false });
    await expect((await import('./sessionContextHandoff')).prepareSessionContinuationContext('child')).rejects.toThrow('inherited-history-unavailable');
    expect(mock.read).toHaveBeenCalledExactlyOnceWith('child');
});
