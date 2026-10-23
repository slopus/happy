import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials, PersistedSession } from '@/persistence';
import { codexHistoryKey, historyTurn, isCodexSessionActiveSince, syncCodexHistory } from './syncHistory';

const mock = vi.hoisted(() => ({
    configuration: { happyHomeDir: '', serverUrl: 'https://test.invalid' },
    records: {} as Record<string, PersistedSession>, remote: [] as any[], sent: [] as any[],
    get: vi.fn(), post: vi.fn(), create: vi.fn(), list: vi.fn(), read: vi.fn(),
    metadataBeforeUpdate: undefined as any,
}));
vi.mock('@/configuration', () => ({ configuration: mock.configuration }));
vi.mock('@/persistence', () => ({
    readPersistedSessions: () => mock.records,
    persistSession: (id: string, record: PersistedSession) => { mock.records[id] = structuredClone(record); },
}));
vi.mock('@/resume/localHappyAgentAuth', () => ({ readLocalHappyAgentCredentials: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/utils/createSessionMetadata', () => ({ createSessionMetadata: () => ({ metadata: { machineId: 'machine' } }) }));
vi.mock('axios', () => ({ default: { get: mock.get, post: mock.post, isAxiosError: () => false } }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({ getOrCreateSession: mock.create, deactivateSession: vi.fn().mockResolvedValue(true) }) } }));
vi.mock('@/api/apiSession', () => ({ ApiSessionClient: class {
    constructor(private token: string, private session: any) {}
    close = vi.fn(); uploadLocalImageAttachmentEnvelope = vi.fn();
    async updateMetadata(update: (metadata: any) => any) {
        const metadata = update(mock.metadataBeforeUpdate ?? this.session.metadata);
        const metadataVersion = (this.session.metadataVersion ?? 0) + 1;
        const raw = mock.remote.find(row => row.id === this.session.id);
        raw.metadata = encodeBase64(encrypt(this.session.encryptionKey, this.session.encryptionVariant, metadata));
        raw.metadataVersion = metadataVersion;
        return { metadata, metadataVersion };
    }
} }));
vi.mock('./codexAppServerClient', () => ({ CodexAppServerClient: class {
    connect = vi.fn(); disconnect = vi.fn(); listThreads = mock.list; readThreadHistory = mock.read;
} }));

const credentials: Credentials = { token: 'test', encryption: {
    type: 'dataKey', machineKey: new Uint8Array(32).fill(1), publicKey: new Uint8Array(32).fill(2),
} };
const thread = { id: 'native-id', cwd: '/original', name: 'Original', createdAt: 100, updatedAt: 200 };
const turn = { id: 'turn-1', status: 'completed', items: [
    { type: 'userMessage', id: 'user', content: [{ type: 'text', text: 'hello' }] },
    { type: 'agentMessage', id: 'agent', text: 'world' },
] };

beforeEach(async () => {
    vi.clearAllMocks();
    mock.records = {}; mock.remote = []; mock.sent = [];
    mock.metadataBeforeUpdate = undefined;
    mock.configuration.happyHomeDir = await mkdtemp(join(tmpdir(), 'happy-history-'));
    mock.get.mockImplementation(async () => ({ data: { sessions: mock.remote, nextCursor: null } }));
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({ data: archived && !ancestorThreadId ? [thread] : [], nextCursor: null }));
    mock.read.mockResolvedValue({ ...thread, turns: [turn] });
    mock.create.mockImplementation(async ({ metadata, encryptionKey }) => {
        const id = metadata.codexThreadId === thread.id ? 'happy-id' : `happy-${metadata.codexThreadId}`;
        mock.remote.push({ id, active: false, metadata: encodeBase64(encrypt(encryptionKey, 'dataKey', metadata)), seq: 0 });
        return { id, metadata, encryptionKey, encryptionVariant: 'dataKey', seq: 0, metadataVersion: 1, agentStateVersion: 0 };
    });
    mock.post.mockImplementation(async (_, { messages }) => {
        mock.sent.push(...messages);
        return { data: { messages: messages.map((_: any, i: number) => ({ seq: i + 1 })) } };
    });
});
afterEach(async () => { await rm(mock.configuration.happyHomeDir, { recursive: true, force: true }); });

it('imports all source kinds and archived history once, preserving the native ID and directory', async () => {
    expect(await syncCodexHistory(credentials, 'machine')).toMatchObject({ imported: 1, failed: 0 });
    expect(mock.list.mock.calls.slice(0, 2).map(([opts]) => opts.archived)).toEqual([false, true]);
    expect(mock.list.mock.calls[0][0].sourceKinds).toContain('subAgentThreadSpawn');
    expect(mock.records['happy-id'].metadata).toMatchObject({ path: '/original', codexThreadId: 'native-id', hostPid: 0 });
    expect(mock.records['happy-id'].metadata.summary?.text).toBe('Original');
    await syncCodexHistory(credentials, 'machine');
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('retries a partially sent turn with identical message IDs and does not resurrect deleted entries', async () => {
    mock.post.mockRejectedValueOnce(new Error('connection lost after delivery'));
    expect(await syncCodexHistory(credentials, 'machine')).toMatchObject({ failed: 1 });
    const first = mock.post.mock.calls[0][1].messages.map((message: any) => message.localId);
    await syncCodexHistory(credentials, 'machine');
    expect(mock.post.mock.calls[1][1].messages.map((message: any) => message.localId)).toEqual(first);
    expect(mock.create).toHaveBeenCalledTimes(1);
    mock.remote = [];
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].codexHistory?.deleted).toBe(true);
    await syncCodexHistory(credentials, 'machine');
    expect(mock.create).toHaveBeenCalledTimes(1);
});

it('uses distinct stable keys and strips raw reasoning from imported display history', () => {
    expect(codexHistoryKey(credentials, 'a')).toEqual(codexHistoryKey(credentials, 'a'));
    expect(codexHistoryKey(credentials, 'a')).not.toEqual(codexHistoryKey(credentials, 'b'));
    expect(historyTurn({ id: 't', items: [{ type: 'reasoning', id: 'r', summary: ['visible'], content: ['private'] }] }, 1000).items)
        .toEqual([{ type: 'reasoning', id: 'r', summary: ['visible'] }]);
});

it('discovers children with empty previews and saves their parent for continuation', async () => {
    const child = { ...thread, id: 'child', name: null, preview: '', canAcceptDirectInput: null };
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({
        data: archived ? [] : ancestorThreadId ? [child] : [thread], nextCursor: null,
    }));
    expect(await syncCodexHistory(credentials, 'machine')).toMatchObject({ discovered: 2, imported: 2, failed: 0 });
    expect(mock.records['happy-child'].metadata.codexParentThreadId).toBe(thread.id);
    expect(mock.records['happy-id'].metadata.codexParentThreadId).toBeUndefined();
    expect(mock.create).toHaveBeenCalledTimes(2);
});

it('mirrors archive and unarchive even with unchanged timestamps and after Happy attachment', async () => {
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.codexArchived).toBe(true);
    mock.records['happy-id'].codexHistory!.attached = true;
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({ data: !archived && !ancestorThreadId ? [thread] : [], nextCursor: null }));
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata).toMatchObject({ codexArchived: false, lifecycleState: 'stopped' });
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({ data: archived && !ancestorThreadId ? [thread] : [], nextCursor: null }));
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.codexArchived).toBe(true);
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('repairs a missing remote thread identifier from its trusted import mapping without replaying history', async () => {
    await syncCodexHistory(credentials, 'machine');
    const saved = mock.records['happy-id'];
    const metadata = { ...saved.metadata };
    delete metadata.codexThreadId;
    delete metadata.codexArchived;
    mock.remote[0].metadata = encodeBase64(encrypt(Buffer.from(saved.encryptionKey, 'base64'), 'dataKey', metadata));
    saved.codexHistory!.attached = true;
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.codexThreadId).toBe(thread.id);
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('preserves an intentional clear that keeps native archive metadata', async () => {
    await syncCodexHistory(credentials, 'machine');
    const saved = mock.records['happy-id'];
    const metadata = { ...saved.metadata };
    delete metadata.codexThreadId;
    mock.remote[0].metadata = encodeBase64(encrypt(Buffer.from(saved.encryptionKey, 'base64'), 'dataKey', metadata));
    saved.codexHistory!.attached = true;
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.codexThreadId).toBeUndefined();
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('does not restore a thread identifier when clear races with native metadata sync', async () => {
    await syncCodexHistory(credentials, 'machine');
    mock.records['happy-id'].codexHistory!.attached = true;
    mock.metadataBeforeUpdate = { ...mock.records['happy-id'].metadata, codexThreadId: undefined };
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({ data: archived && !ancestorThreadId ? [{ ...thread, name: 'Changed' }] : [], nextCursor: null }));
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.codexThreadId).toBeUndefined();
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('mirrors native titles and activity after attachment while preserving a chosen Happy title', async () => {
    await syncCodexHistory(credentials, 'machine');
    mock.records['happy-id'].codexHistory!.attached = true;
    const renamed = { ...thread, name: 'Renamed', updatedAt: 300 };
    mock.list.mockImplementation(async ({ archived, ancestorThreadId }) => ({ data: archived && !ancestorThreadId ? [renamed] : [], nextCursor: null }));
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata).toMatchObject({ name: 'Renamed', summary: { text: 'Renamed' }, lastMeaningfulMessageAt: 300000 });
    const saved = mock.records['happy-id'];
    mock.remote[0].metadata = encodeBase64(encrypt(Buffer.from(saved.encryptionKey, 'base64'), 'dataKey', {
        ...saved.metadata, summary: { text: 'My Happy title', updatedAt: 300000 },
    }));
    renamed.name = 'Renamed again';
    await syncCodexHistory(credentials, 'machine');
    expect(mock.records['happy-id'].metadata.summary?.text).toBe('My Happy title');
    expect(mock.post).toHaveBeenCalledTimes(1);
});

it('limits fast discovery to recent threads without recursively rescanning old descendants', async () => {
    mock.list.mockImplementation(async () => ({ data: [thread], nextCursor: 'older' }));
    expect(await syncCodexHistory(credentials, 'machine', { since: 201000 })).toMatchObject({ discovered: 0, failed: 0 });
    expect(mock.list).toHaveBeenCalledTimes(2);
    expect(mock.list.mock.calls[0][0]).toMatchObject({ sortKey: 'updated_at', sortDirection: 'desc' });
    expect(mock.read).not.toHaveBeenCalled();
});

it('automatically connects only recent unarchived primary sessions with a native identifier', () => {
    const record = { codexHistory: { updatedAt: 100, turns: [] }, metadata: {
        codexThreadId: 'native-id', codexArchived: false, lastMeaningfulMessageAt: 100,
    } } as unknown as PersistedSession;
    expect(isCodexSessionActiveSince(record, 100)).toBe(true);
    expect(isCodexSessionActiveSince({ ...record, codexHistory: undefined }, 100)).toBe(true);
    expect(isCodexSessionActiveSince(record, 101)).toBe(false);
    for (const metadata of [{ codexArchived: true }, { codexArchived: undefined },
        { codexParentThreadId: 'parent' }, { codexThreadId: undefined }]) {
        expect(isCodexSessionActiveSince({ ...record, metadata: { ...record.metadata, ...metadata } }, 100)).toBe(false);
    }
    expect(isCodexSessionActiveSince({ ...record, codexHistory: { ...record.codexHistory!, deleted: true } }, 100)).toBe(false);
});
