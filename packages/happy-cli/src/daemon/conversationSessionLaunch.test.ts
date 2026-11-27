import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationSessionLauncher, type ConversationLaunchSnapshot, type ConversationSessionLaunchRequest, type ConversationNativeCandidate } from './conversationSessionLaunch';
import type { SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { portableNativeSourceIdentity } from '@slopus/happy-wire';

const nativeId = '00000000-0000-4000-8000-000000000001';
const request: ConversationSessionLaunchRequest = { rootSessionId: 'root', sourceSessionId: 'source',
    requestId: '00000000-0000-4000-8000-000000000010', targetAgent: 'codex', expectedCodexAccountProfileId: 'profile' };
let directory: string;
const snapshot = (id: string, extra: Partial<ConversationLaunchSnapshot['metadata']> = {}): ConversationLaunchSnapshot => ({
    id, seq: id === 'root' ? 12 : 21, active: true, agentStateVersion: 3,
    agentState: { claudeThinking: false, turnStatus: { status: 'completed', updatedAt: 10 } },
    metadata: { machineId: 'machine', path: '/project', host: 'mac', homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happy', happyLibDir: '/runtime', happyToolsDir: '/runtime/tools', flavor: 'codex',
        codexThreadId: nativeId, codexAccountProfileId: 'profile', capabilities: { conversationNativeResume: 1 }, ...extra },
});
function fixture() {
    const sessions: Record<string, ConversationLaunchSnapshot> = {
        root: snapshot('root', { conversationActiveSessionId: 'source', conversationSwitch: { id: request.requestId, sourceSessionId: 'source' } }),
        source: snapshot('source', { flavor: 'claude', codexThreadId: undefined, codexAccountProfileId: undefined,
            conversationRootSessionId: 'root', continuationOfSessionId: 'root' }),
    };
    const deps = {
        directory, machineId: 'machine', read: vi.fn(async (id: string) => {
            if (!sessions[id]) throw new Error('Missing predecessor'); return structuredClone(sessions[id]);
        }), liveCandidates: vi.fn(() => [] as string[]), verifyNative: vi.fn(async () => true),
        readCoverage: vi.fn(async (owner: ConversationLaunchSnapshot) => ({ sessionId: owner.id, throughSeq: owner.seq,
            afterSeq: owner.metadata.portableContextBoundary?.afterSeq ?? 0 })),
        findCreated: vi.fn(async () => undefined as string | undefined),
        cancelTarget: vi.fn(async () => {}),
        spawn: vi.fn(async (_request: ConversationSessionLaunchRequest, _source: ConversationLaunchSnapshot,
            _native: ConversationNativeCandidate | undefined, _validate: () => Promise<void>): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'new-segment' })),
    };
    return { sessions, deps, launch: createConversationSessionLauncher(deps) };
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'conversation-native-launch-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('reserved conversation native restoration', () => {
    it('creates a new App segment with conservative native coverage and leaves the predecessor chain untouched', async () => {
        const f = fixture(); const before = structuredClone(f.sessions);
        const result = await f.launch(request);
        expect(result).toEqual({ type: 'success', sessionId: 'new-segment', nativeResume: { sourceSessionId: 'root', contextEpoch: null,
            coverage: [{ sessionId: 'root', throughSeq: 12, afterSeq: 0 }], contextSources: ['source', 'root'].map(id => ({ sessionId: id, identity: portableNativeSourceIdentity(f.sessions[id].metadata) })) } });
        expect(f.deps.spawn).toHaveBeenCalledWith(request, expect.objectContaining({ id: 'source' }),
            expect.objectContaining({ nativeId, source: expect.objectContaining({ id: 'root' }) }), expect.any(Function));
        expect(f.sessions).toEqual(before);
    });
    it('does not claim archive heads or a different provider segment as native coverage', async () => {
        const f = fixture();
        Object.assign(f.sessions.root.metadata, { portableContext: { heads: [{ sessionId: 'unread', throughSeq: 999, afterSeq: 0 }] } });
        expect(await f.launch(request)).toMatchObject({ nativeResume: { coverage: [{ sessionId: 'root', throughSeq: 12, afterSeq: 0 }] } });
    });
    it.each(['capability', 'account', 'connection', 'missing-history'])('starts fresh when %s does not prove a compatible native binding', async reason => {
        const f = fixture();
        if (reason === 'capability') f.sessions.root.metadata.capabilities = {};
        if (reason === 'account') f.sessions.root.metadata.codexAccountProfileId = 'other-profile';
        if (reason === 'connection') f.sessions.root.metadata.codexMagpieConnection = true;
        if (reason === 'missing-history') f.deps.verifyNative.mockResolvedValue(false);
        expect(await f.launch(request)).toEqual({ type: 'success', sessionId: 'new-segment' });
        expect(f.deps.spawn.mock.calls[0][2]).toBeUndefined();
    });
    it('never resurrects a native binding older than a clear boundary', async () => {
        const f = fixture(); f.sessions.source.metadata.portableContextBoundary = { id: 'new-epoch', afterSeq: 18 };
        expect(await f.launch(request)).toEqual({ type: 'success', sessionId: 'new-segment' });
        expect(f.deps.spawn.mock.calls[0][2]).toBeUndefined();
    });
    it('resumes a post-clear identity in its own segment with that segment boundary', async () => {
        const f = fixture(); f.sessions.root.metadata.portableContextBoundary = { id: 'new-epoch', afterSeq: 7 };
        expect(await f.launch(request)).toMatchObject({ nativeResume: { coverage: [{ sessionId: 'root', throughSeq: 12, afterSeq: 7 }] } });
    });
    it.each(['busy', 'queued', 'approval', 'foreign-root', 'machine', 'path', 'cycle', 'missing', 'reservation'])('rejects %s before dispatch', async problem => {
        const f = fixture();
        if (problem === 'busy') f.sessions.source.agentState!.turnStatus!.status = 'running';
        if (problem === 'queued') f.sessions.source.agentState!.queuedMessages = 1;
        if (problem === 'approval') f.sessions.source.agentState!.requests = { approval: { tool: 'bash', arguments: {}, createdAt: 10 } };
        if (problem === 'foreign-root') f.sessions.source.metadata.conversationRootSessionId = 'another';
        if (problem === 'machine') f.sessions.source.metadata.machineId = 'other-machine';
        if (problem === 'path') f.sessions.source.metadata.path = '/other-project';
        if (problem === 'cycle') f.sessions.source.metadata.continuationOfSessionId = 'source';
        if (problem === 'missing') f.sessions.source.metadata.continuationOfSessionId = 'missing';
        if (problem === 'reservation') f.sessions.root.metadata.conversationSwitch!.id = 'other-request';
        expect(await f.launch(request)).toMatchObject({ type: 'error', notDispatched: true });
        expect(f.deps.spawn).not.toHaveBeenCalled();
    });
    it('does not take a native thread held by a live independent conversation', async () => {
        const f = fixture(); f.sessions.foreign = snapshot('foreign'); f.deps.liveCandidates.mockReturnValue(['foreign']);
        expect(await f.launch(request)).toMatchObject({ type: 'error', notDispatched: true });
        expect(f.deps.spawn).not.toHaveBeenCalled();
    });
    it('rechecks the entire chain immediately before spawning', async () => {
        const f = fixture();
        f.deps.spawn.mockImplementation(async (...args: unknown[]) => {
            f.sessions.source.seq++;
            await (args[3] as () => Promise<void>)();
            return { type: 'success', sessionId: 'should-not-start' };
        });
        expect(await f.launch(request)).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('changed') });
    });
    it('binds the exact immutable prefix descriptor before restoring a native thread', async () => {
        const f = fixture();
        Object.assign(f.sessions.root.metadata, { portableContext: { id: 'original-prefix', sha256: 'original-digest' } });
        f.deps.spawn.mockImplementation(async (...args: unknown[]) => {
            Object.assign(f.sessions.root.metadata, { portableContext: { id: 'replaced-prefix', sha256: 'different-digest' } });
            await (args[3] as () => Promise<void>)();
            return { type: 'success', sessionId: 'should-not-start' };
        });
        expect(await f.launch(request)).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('changed') });
    });
    it('deduplicates concurrent requests and durable reload retries without a second worker', async () => {
        const f = fixture();
        const [first, second] = await Promise.all([f.launch(request), f.launch(request)]);
        expect(first).toEqual(second); expect(f.deps.spawn).toHaveBeenCalledOnce();
        const reopened = createConversationSessionLauncher(f.deps);
        expect(await reopened(request)).toEqual(first); expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('retains an uncertain launch receipt and only recovers a registered worker', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'lost startup ACK' } as never);
        expect(await f.launch(request)).toMatchObject({ type: 'error' });
        expect(await f.launch(request)).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('unknown') });
        expect(f.deps.spawn).toHaveBeenCalledOnce();
        f.deps.findCreated.mockResolvedValue('registered-worker');
        expect(await f.launch(request)).toMatchObject({ type: 'success', sessionId: 'registered-worker', nativeResume: { sourceSessionId: 'root', coverage: [], contextEpoch: null, contextSources: expect.any(Array) } });
        expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('does not call an unreadable existing receipt a known pre-dispatch failure', async () => {
        const f = fixture(); await f.launch(request);
        await writeFile(join(directory, `${request.requestId}.json`), 'interrupted receipt');
        const result = await f.launch(request);
        expect(result.type).toBe('error'); expect(result).not.toHaveProperty('notDispatched', true);
        expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('releases a known pre-dispatch failure so the same request may safely try again', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error', notDispatched: true, errorMessage: 'account unavailable' } as never);
        expect(await f.launch(request)).toMatchObject({ type: 'error', notDispatched: true });
        expect(await f.launch(request)).toMatchObject({ type: 'success' });
        expect(f.deps.spawn).toHaveBeenCalledTimes(2);
    });
    it('rejects unsupported providers before creating a receipt or worker', async () => {
        const f = fixture();
        expect(await f.launch({ ...request, targetAgent: 'openclaw' })).toMatchObject({ type: 'error', notDispatched: true });
        expect(f.deps.spawn).not.toHaveBeenCalled(); expect(f.deps.read).not.toHaveBeenCalled();
    });
    it('restores an independent continuation through its frozen root archive without following the predecessor live', async () => {
        const f = fixture(); f.sessions.root.metadata.continuationOfSessionId = 'independent-source';
        Object.assign(f.sessions.root.metadata, { portableContext: { id: 'frozen', sha256: 'snapshot-hash' } });
        expect(await f.launch(request)).toMatchObject({ type: 'success', sessionId: 'new-segment', nativeResume: { sourceSessionId: 'root' } });
        expect(f.deps.read.mock.calls.some(([id]) => id === 'independent-source')).toBe(false);
        expect(f.deps.spawn.mock.calls[0][2]).toMatchObject({ nativeId });
    });
    it('rejects an unverified eligible fork, but permits a fork excluded by a later clear', async () => {
        const f = fixture(); f.sessions.root.metadata.forkedFromMessageId = 'rewind';
        expect(await f.launch(request)).toMatchObject({ type: 'error', notDispatched: true });
        expect(f.deps.spawn).not.toHaveBeenCalled();
        f.sessions.source.metadata.portableContextBoundary = { id: 'reset', afterSeq: 10 };
        expect(await f.launch(request)).toMatchObject({ type: 'success' });
        expect(f.deps.spawn.mock.calls[0][2]).toBeUndefined();
    });
    it('persists cancellation without a worker and blocks a delayed original launch', async () => {
        const f = fixture();
        expect(await f.launch.cancel(request)).toEqual({ success: true, cancelled: true });
        expect(await f.launch(request)).toMatchObject({ type: 'error', notDispatched: true, conversationCancelled: true });
        expect(f.deps.spawn).not.toHaveBeenCalled();
    });
    it('cancels a uniquely registered unsent target once and never starts it again', async () => {
        const f = fixture(); await f.launch(request);
        expect(await f.launch.cancel(request)).toEqual({ success: true, cancelled: true, targetSessionId: 'new-segment' });
        expect(await f.launch.cancel(request)).toEqual({ success: true, cancelled: true, targetSessionId: 'new-segment' });
        expect(f.deps.cancelTarget).toHaveBeenCalledOnce();
        expect(await f.launch(request)).toMatchObject({ type: 'error', conversationCancelled: true });
        expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('does not cancel an unknown, unregistered target or replay a prompt', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'lost ACK' });
        await f.launch(request);
        expect(await f.launch.cancel(request)).toMatchObject({ success: false, error: expect.stringContaining('unknown') });
        expect(f.deps.cancelTarget).not.toHaveBeenCalled(); expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('retains the receipt when a user-delivery or process-exit proof rejects cancellation', async () => {
        const f = fixture(); await f.launch(request); f.deps.cancelTarget.mockRejectedValueOnce(new Error('user input already delivered'));
        expect(await f.launch.cancel(request)).toMatchObject({ success: false, error: expect.stringContaining('delivered') });
        expect(await f.launch(request)).toMatchObject({ type: 'success', sessionId: 'new-segment' });
        expect(f.deps.spawn).toHaveBeenCalledOnce();
    });
    it('rejects cancellation when the authoritative root moved to another worker', async () => {
        const f = fixture(); await f.launch(request); f.sessions.root.metadata.conversationActiveSessionId = 'other';
        expect(await f.launch.cancel(request)).toMatchObject({ success: false });
        expect(f.deps.cancelTarget).not.toHaveBeenCalled();
    });
    it('does not reuse a native identity already leased by an uncertain launch whose root metadata was overwritten', async () => {
        const f = fixture(); f.deps.spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'worker webhook lost' });
        await f.launch(request);
        const newer = { ...request, requestId: '00000000-0000-4000-8000-000000000099' };
        f.sessions.root.metadata.conversationSwitch!.id = newer.requestId;
        expect(await f.launch(newer)).toEqual({ type: 'success', sessionId: 'new-segment' });
        expect(f.deps.spawn.mock.calls[1][2]).toBeUndefined();
    });
});
