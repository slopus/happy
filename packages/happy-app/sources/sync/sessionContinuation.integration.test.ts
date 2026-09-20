import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sessions: {} as Record<string, any>, machines: { machine: {} }, sessionMessages: {} as Record<string, any>,
    updateSessionFastMode: vi.fn(), updateSessionPermissionMode: vi.fn(), updateSessionModelMode: vi.fn(), updateSessionEffortLevel: vi.fn(),
    applySessions: (rows: any[]) => { for (const row of rows) state.sessions[row.id] = row; } }));
const persisted = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return persisted.get(key); }
    set(key: string, value: string) { persisted.set(key, value); }
    delete(key: string) { persisted.delete(key); }
} }));
const spawn = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const hydrate = vi.hoisted(() => vi.fn());
vi.mock('./storage', () => ({ storage: { getState: () => state } }));
const load = vi.hoisted(() => vi.fn());
const older = vi.hoisted(() => vi.fn());
vi.mock('./sync', () => ({ sync: { sendMessage: send, ensureMessagesLoaded: load, loadOlderMessages: older, jumpToLatestMessages: vi.fn() } }));
vi.mock('./ops', () => ({ machineSpawnNewSession: spawn, sessionUpdateMetadata: update }));
vi.mock('./ensureSessionHydratedWithRetry', () => ({ ensureSessionHydratedWithRetry: hydrate }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: () => 'test-continuation', assertAccountRuntime: () => {} }));
vi.mock('@/utils/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => 'Original task' }));
let sourceCounter = 0;
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    state.sessions = {}; state.sessionMessages = {};
    load.mockResolvedValue(undefined);
    hydrate.mockResolvedValue(true);
    update.mockImplementation(async (_id, meta, version, fn) => ({ metadata: fn(meta), version: version + 1 }));
});
function source() {
    const id = `source-${sourceCounter++}`;
    state.sessions[id] = { id, metadataVersion: 1, metadata: { path: '/project', machineId: 'machine', flavor: 'codex', host: 'host' },
        permissionMode: 'default', modelMode: 'gpt-6-astra', effortLevel: 'medium' };
    state.sessionMessages[id] = { isLoaded: true, isAtLatest: true, messages: [{ id: 'request', kind: 'user-text', text: 'Remember project ORCHID and continue its parser fix', createdAt: 1 }] };
    spawn.mockImplementation(async () => {
        state.sessions.new = { id: 'new', metadataVersion: 1, metadata: { path: '/project', host: 'host', codexThreadId: 'fresh-provider-id' } };
        return { type: 'success', sessionId: 'new' };
    });
    return id;
}
describe('fresh continuation integration', () => {
    it('uses ordinary spawn with no old backend identifier, preserves settings, sends nothing', async () => {
        const id = source();
        const { createSessionContinuation } = await import('./sessionContinuation');
        expect(await createSessionContinuation(id)).toBe('new');
        expect(spawn).toHaveBeenCalledWith({ machineId: 'machine', directory: '/project', agent: 'codex', approvedNewDirectoryCreation: false });
        expect(state.sessions.new.metadata).toMatchObject({ continuationOfSessionId: id, codexThreadId: 'fresh-provider-id' });
        expect(state.sessions[id].metadata.continuedBySessionId).toBe('new');
        expect(state.sessions.new.metadata.parentSessionId).toBeUndefined();
        expect(state.sessions.new.metadata.continuationContext).toContain('ORCHID');
        expect(state.updateSessionModelMode).toHaveBeenCalledWith('new', 'gpt-6-astra');
        expect(state.updateSessionPermissionMode).toHaveBeenCalledWith('new', 'default');
        expect(state.updateSessionEffortLevel).toHaveBeenCalledWith('new', 'medium');
        expect(send).not.toHaveBeenCalled();
    });
    it('survives reload after spawn succeeded but hydration failed without spawning twice', async () => {
        const id = source(); hydrate.mockResolvedValue(false);
        await expect((await import('./sessionContinuation')).createSessionContinuation(id)).rejects.toThrow('continuation-hydration-failed');
        vi.resetModules(); hydrate.mockResolvedValue(true);
        expect(await (await import('./sessionContinuation')).createSessionContinuation(id)).toBe('new');
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it('does not relaunch or send messages when opening an existing successor', async () => {
        const id = source(); state.sessions[id].metadata.continuedBySessionId = 'existing';
        expect(await (await import('./sessionContinuation')).createSessionContinuation(id)).toBe('existing');
        expect(spawn).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    });
});

it('retains an unknown RPC outcome across repeated attempts', async () => {
    const id = source(); spawn.mockResolvedValue({ type: 'error', errorMessage: 'operation has timed out', outcomeUnknown: true });
    const { createSessionContinuation } = await import('./sessionContinuation');
    await expect(createSessionContinuation(id)).rejects.toThrow('continuation-outcome-unknown');
    await expect(createSessionContinuation(id)).rejects.toThrow('continuation-outcome-unknown');
    expect(spawn).toHaveBeenCalledTimes(1);
});

it('does not create an empty successor when source history cannot be read', async () => {
    const id = source(); state.sessionMessages[id].isLoaded = false;
    await expect((await import('./sessionContinuation')).createSessionContinuation(id)).rejects.toThrow('continuation-history-unavailable');
    expect(spawn).not.toHaveBeenCalled();
});

it('reads past a latest page containing only tool calls before saving the handoff', async () => {
    const id = source();
    state.sessionMessages[id] = { isLoaded: true, isAtLatest: true, hasMoreOlder: true, messages: [{ id: 'tool', kind: 'tool-call', createdAt: 2 }] };
    older.mockImplementation(async () => {
        state.sessionMessages[id] = { isLoaded: true, isAtLatest: true, hasMoreOlder: false, messages: [{ id: 'goal', kind: 'user-text', createdAt: 1, text: 'Original task: ORCHID parser' }] };
    });
    await (await import('./sessionContinuation')).createSessionContinuation(id);
    expect(state.sessions.new.metadata.continuationContext).toContain('ORCHID');
});
