import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { createProjectGoalRuntime } from './projectGoalRuntime';
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const key = new Uint8Array(32).fill(7);
const catalogFingerprint = (pairs: Array<[string, number]>) => createHash('sha256').update(JSON.stringify([...pairs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
const encode = (value: unknown) => encodeBase64(encrypt(key, 'legacy', value));
const ready = { role: 'agent', content: { type: 'event', data: { type: 'ready' } } };
const metadata = { host: 'fixture', path: '/archive/feature/tasks/task', machineId: 'machine' };
const row = (id: string, seq: number, meta = metadata) => ({ id, seq, metadata: encode(meta), updatedAt: 1, active: false });
const runtime = () => createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'fixture', machineId: 'machine', legacyKey: key,
    findSession: () => ({ encryption: { encryptionKey: key, encryptionVariant: 'legacy', seq: 0, metadataVersion: 0, agentStateVersion: 0 }, pid: 1, startedBy: 'test' }) });
beforeEach(() => { vi.mocked(axios.get).mockReset(); vi.mocked(axios.post).mockReset(); });
describe('production project relay adapter', () => {
    it('includes old tasks beyond the first 150 sessions and excludes another machine/directory', async () => {
        vi.mocked(axios.get).mockImplementation(async (url, config) => {
            if (String(url).endsWith('/v2/sessions')) return { data: (config?.params as { cursor?: string } | undefined)?.cursor
                ? { sessions: [row('old-task', 1), row('blank-chat', 1), row('wrong-machine', 1, { ...metadata, machineId: 'other' })], hasNext: false }
                : { sessions: Array.from({ length: 200 }, (_, i) => row(`unrelated-${i}`, 0, { ...metadata, path: '/elsewhere' })), hasNext: true, nextCursor: 'cursor_v1_old' } };
            const content = String(url).includes('blank-chat') ? ready : { role: 'user', content: { type: 'text', text: 'Execute' } };
            return { data: { messages: [{ seq: 1, content: { t: 'encrypted', c: encode(content) } }] } };
        });
        const history = await runtime().history('/archive/feature', [{ id: 'task', title: 'Task', directory: metadata.path }]);
        expect(history.map(session => [session.sessionId, session.executed])).toEqual([['old-task', true], ['blank-chat', false]]);
        expect(vi.mocked(axios.get).mock.calls.filter(call => String(call[0]).endsWith('/v2/sessions'))).toHaveLength(2);
    });
    it('explicit Goal bindings isolate sibling Tasks and retain a scope binding without a Task id', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
            row('sibling', 0, { ...metadata, goalBoard: { featurePath: '/archive/feature', taskId: 'sibling' } } as any),
            row('global', 0, { ...metadata, goalBoard: { featurePath: '/archive/feature' } } as any),
        ], hasNext: false } });
        expect(await runtime().history('/archive/feature', [{ id: 'task', directory: metadata.path }])).toEqual([]);
        expect((await runtime().history('/archive/feature', [{ id: '', directory: metadata.path }])).map(session => session.sessionId)).toEqual(['global']);
    });
    it('a broken pagination cursor cannot be mistaken for complete history', async () => {
        vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [], hasNext: true, nextCursor: 'same' } });
        await expect(runtime().history('/archive/feature', [])).rejects.toThrow('could not be verified');
        expect(axios.get).toHaveBeenCalledTimes(2);
    });
    it('missing transcript sequences cannot establish an empty discussion', async () => {
        vi.mocked(axios.get).mockImplementation(async url => ({ data: String(url).endsWith('/v2/sessions')
            ? { sessions: [row('partial', 2)], hasNext: false }
            : { messages: [{ seq: 2, content: { t: 'encrypted', c: encode(ready) } }, { seq: 2, content: { t: 'encrypted', c: encode(ready) } }] } }));
        expect((await runtime().history('/archive/feature', [{ id: 'task', directory: metadata.path }]))[0].executed).toBe(true);
    });
    it('submits exactly one encrypted user message carrying a stable relay deduplication ID', async () => {
        vi.mocked(axios.post).mockResolvedValue({ data: { messages: [{ localId: 'goal-first:task' }] } });
        await runtime().send('session', 'Read the real task Prompt', 'goal-first:task');
        expect(axios.post).toHaveBeenCalledTimes(1);
        const [url, body] = vi.mocked(axios.post).mock.calls[0];
        expect(url).toBe('http://relay.test/v3/sessions/session/messages');
        const message = (body as any).messages[0];
        expect(message.localId).toBe('goal-first:task');
        expect(decrypt(key, 'legacy', decodeBase64(message.content))).toMatchObject({ role: 'user', content: { text: 'Read the real task Prompt' }, meta: { sentFrom: 'paws-goal-project' } });
    });
});

it('retains task history across a feature move and observed directory changes', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
        row('stable', 0, { ...metadata, goalBoard: { featurePath: '/old/feature', taskId: 'GFT-abcdefgh' } } as any),
        row('legacy', 0, { ...metadata, path: '/old/task' }),
    ], hasNext: false } });
    const history = await runtime().history('/new/feature', [{ id: 'GFT-abcdefgh', directory: '/new/task', directories: ['/new/task', '/old/task'] }]);
    expect(history.map(session => [session.sessionId, session.directory])).toEqual([['stable', '/new/task'], ['legacy', '/new/task']]);
});

it('reads aggregate header groups from one catalog without fetching message transcripts', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
        row('feature-global', 1, { ...metadata, path: '/archive/feature', goalBoard: { featurePath: '/archive/feature' } } as any),
        row('feature-task', 1, { ...metadata, goalBoard: { featurePath: '/archive/feature', taskId: 'task' } } as any),
    ], hasNext: false } });
    const history = await runtime().history('/archive', [
        { id: '', directory: '/archive', featurePath: '/archive' },
        { id: '', directory: '/archive/feature', featurePath: '/archive/feature' },
        { id: 'task', directory: metadata.path, featurePath: '/archive/feature' },
    ], { headersOnly: true });
    expect(history.map(session => session.sessionId)).toEqual(['feature-global', 'feature-task']); expect(axios.get).toHaveBeenCalledTimes(1);
});
it('refuses an exact header total when a session cannot be decrypted', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ ...row('inaccessible', 0), metadata: encodeBase64(new Uint8Array(64)) }], hasNext: false } });
    await expect(runtime().history('/archive', [], { headersOnly: true })).rejects.toThrow();
});

it('uses authenticated owner metadata candidates for untracked dataKey sessions without a root or session key', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [
        { id: 'owned-data-key', metadata: 'opaque-data-key-ciphertext', metadataVersion: 7, dataEncryptionKey: 'opaque-wrapped-key', seq: 12, updatedAt: 200, active: true },
        { id: 'other-machine', metadata: 'also-opaque', metadataVersion: 1, seq: 0, updatedAt: 1, active: false },
    ], hasNext: false } });
    const history = await createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'owner-token', machineId: 'machine', findSession: () => undefined })
        .history('/archive/feature', [{ id: '', directory: '/archive/feature', featurePath: '/archive/feature' }], { headersOnly: true,
            catalogFingerprint: catalogFingerprint([['owned-data-key', 7], ['other-machine', 1]]),
            headerCandidates: [{ sessionId: 'owned-data-key', metadataVersion: 7, directory: '/archive/feature', title: 'Owned discussion', featurePath: '/archive/feature' }] });
    expect(history).toMatchObject([{ sessionId: 'owned-data-key', title: 'Owned discussion', updatedAt: 200, active: true, metadata: { machineId: 'machine', path: '/archive/feature' } }]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
});
it('rejects unknown candidate IDs and stale metadata rather than trusting client snapshots', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ id: 'owned', metadata: 'opaque', metadataVersion: 4, seq: 0, updatedAt: 99, active: false }], hasNext: false } });
    const adapter = createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'owner-token', machineId: 'machine', findSession: () => undefined });
    const candidate = { sessionId: 'foreign', metadataVersion: 4, directory: '/archive/feature', title: 'Unknown' };
    await expect(adapter.history('/archive/feature', [], { headersOnly: true, catalogFingerprint: catalogFingerprint([['owned', 4]]), headerCandidates: [candidate] })).rejects.toThrow('outside the authenticated session catalog');
    await expect(adapter.history('/archive/feature', [], { headersOnly: true, catalogFingerprint: catalogFingerprint([['owned', 4]]), headerCandidates: [{ ...candidate, sessionId: 'owned', metadataVersion: 3 }] })).rejects.toThrow('metadata changed');
    await expect(adapter.history('/archive/feature', [], { headersOnly: true, catalogFingerprint: catalogFingerprint([['owned', 4]]), headerCandidates: [{ ...candidate, sessionId: 'owned' }, { ...candidate, sessionId: 'owned' }] })).rejects.toThrow('identities are duplicated');
});
it('accepts an explicitly empty complete candidate set without decrypting other machines', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ id: 'other-machine', metadata: 'opaque', metadataVersion: 1, seq: 0, updatedAt: 1, active: false }], hasNext: false } });
    expect(await createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'owner-token', machineId: 'machine', findSession: () => undefined })
        .history('/archive', [], { headersOnly: true, catalogFingerprint: catalogFingerprint([['other-machine', 1]]), headerCandidates: [] })).toEqual([]);
});

it.each(['created', 'deleted', 'metadata-rebound'])('rejects a cross-snapshot %s catalog rather than silently omitting selected-machine work', async change => {
    const before: Array<[string, number]> = [['owned', 3], ['other', 1]];
    const after = change === 'created' ? [...before, ['new-selected-machine', 1] as [string, number]]
        : change === 'deleted' ? before.slice(0, 1) : [['owned', 4], ['other', 1]] as Array<[string, number]>;
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: after.map(([id, metadataVersion]) => ({ id, metadataVersion, metadata: 'opaque', seq: 0, updatedAt: 100, active: true })), hasNext: false } });
    await expect(createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'owner-token', machineId: 'machine', findSession: () => undefined })
        .history('/archive', [], { headersOnly: true, headerCandidates: [], catalogFingerprint: catalogFingerprint(before) })).rejects.toThrow('Session catalog changed');
});

it('uses one immutable catalog for page and final conversation reads without a second relay read', async () => {
    const raw = { ...row('owned-snapshot', 2), metadataVersion: 4, dataEncryptionKey: null };
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [raw], hasNext: false } });
    const adapter = createProjectGoalRuntime({ serverUrl: 'http://relay.test', token: 'owner-token', machineId: 'machine', findSession: () => undefined });
    const page = await adapter.conversationCatalog!('/archive/feature', {});
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ ...raw, metadataVersion: 99, updatedAt: 999 }, { ...raw, id: 'new-session' }], hasNext: false } });
    const result = await adapter.history('/archive/feature', [{ id: 'task', directory: metadata.path }], { headersOnly: true, snapshotId: page.snapshotId,
        catalogFingerprint: page.catalogFingerprint, headerCandidates: [{ sessionId: raw.id, metadataVersion: 4, directory: metadata.path, title: 'Frozen title' }] });
    expect(result.map(item => [item.sessionId, item.updatedAt])).toEqual([['owned-snapshot', 1]]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    await expect(adapter.history('/other', [], { headersOnly: true, snapshotId: page.snapshotId, catalogFingerprint: page.catalogFingerprint, headerCandidates: [] })).rejects.toThrow('another project');
    adapter.disposeConversationCatalog!();
    await expect(adapter.conversationCatalog!('/archive/feature', { snapshotId: page.snapshotId })).rejects.toThrow('disposed');
});
