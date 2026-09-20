import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createReducer, reducer } from './reducer/reducer';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';
import { messageSortKey } from './typesMessage';
import { messagePlanMode } from './messagePlanMode';
import { AsyncLock } from '@/utils/lock';

// Like sync.receipts.spec.ts, extract the real transport/store adapters without
// booting native services. Unlike the preload mock, pagination cannot create an
// entry here. Only network, decryption and unrelated agent-mode effects are fake.
function source(name: string) {
    return ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
}
function compile(code: string, dependencies: Record<string, unknown>): any {
    return new Function(...Object.keys(dependencies), ts.transpile(code, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
const storeSource = source('./storage.ts');
const adapterNames = ['applyMessages', 'applyMessagesLoaded', 'applyOlderMessagesPagination', 'applyOlderMessagesLoading'];
const adapters: string[] = [];
function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && adapterNames.includes(node.name.getText(storeSource))) adapters.push(node.getText(storeSource));
    ts.forEachChild(node, visit);
}
visit(storeSource);
expect(adapters).toHaveLength(adapterNames.length);
const syncSource = source('./sync.ts');
const klass = syncSource.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'Sync')!;
const methodNames = ['fetchMessages', 'fetchInitialLatestPage', 'fetchForwardSince', 'applyFetchedMessages', 'loadOlderMessages', 'preloadLatestPage', 'fetchOlderMessagesInBackground'];
const methods = klass.members.filter(node => node.name && methodNames.includes(node.name.getText(syncSource))).map(node => node.getText(syncSource));
expect(methods).toHaveLength(methodNames.length);

function record(seq: number, visible = false) {
    const content = visible
        ? { role: 'user', content: { type: 'text', text: `synthetic-${seq}` } }
        : { role: 'agent', content: { type: 'acp', provider: 'codex', data: { type: 'token_count', total_tokens: seq } } };
    RawRecordSchema.parse(content);
    return { id: `m${seq}`, seq, localId: null, createdAt: seq, content };
}
function setup(rows: ReturnType<typeof record>[], archived = false) {
    let state: any = { sessions: { session: { id: 'session', active: !archived, metadata: null, agentState: null } }, sessionMessages: {} };
    Object.assign(state, compile(`return ({${adapters.join(',')}});`, {
        set: (update: (state: any) => any) => { state = update(state); },
        createReducer, reducer, messageSortKey, messagePlanMode, rigSendsMessageReceipts: () => false,
    }));
    const storage = { getState: () => state };
    const request = vi.fn(async (url: string) => {
        const query = new URL(url, 'https://synthetic.invalid').searchParams;
        const backward = query.has('before_seq');
        const cursor = Number(query.get(backward ? 'before_seq' : 'after_seq'));
        const matching = rows.filter(m => backward ? m.seq < cursor : m.seq > cursor).sort((a, b) => backward ? b.seq - a.seq : a.seq - b.seq);
        return { ok: true, status: 200, json: async () => ({ messages: matching.slice(0, 100), hasMore: matching.length > 100 }) };
    });
    const Harness = compile(`class Sync { ${methods.join('\n')} }; return Sync;`, {
        storage, apiSocket: { request }, normalizeRawMessage, SEQ_BACKWARD_INITIAL_SENTINEL: 2147483647,
        log: { log() {} }, setTimeout: (resolve: () => void) => resolve(),
    });
    const sync = new Harness();
    const encryption = { decryptMessages: vi.fn(async (messages: unknown[]) => messages) };
    const lock = new AsyncLock();
    Object.assign(sync, {
        sessionLastSeq: new Map(), sessionOldestSeq: new Map(), olderMessagesPrefetchAttempts: new Map(),
        encryption: { getSessionEncryption: () => encryption }, getSessionMessageLock: () => lock,
        messagePreloader: { take: () => null }, prefetchOlderMessagesInBackground() {},
        applyMessages: (...args: any[]) => state.applyMessages(...args),
    });
    return { sync, encryption, request, storage, messages: () => state.sessionMessages.session };
}

describe('history transport with production store adapters', () => {
    it.each([false, true])('preserves a valid invisible first page and can reach older rows (archived=%s)', async (archived) => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, i < 2)), archived);
        await h.sync.fetchMessages('session');
        expect(h.messages()).toMatchObject({ messages: [], isLoaded: true, hasMoreOlder: true });
        expect(h.sync.sessionOldestSeq.get('session')).toBe(3);
        await h.sync.fetchMessages('session');
        expect(h.request.mock.calls.at(-1)![0]).toContain('after_seq=102');
        expect(h.messages().hasMoreOlder).toBe(true);
        await h.sync.loadOlderMessages('session');
        expect(h.messages()).toMatchObject({ hasMoreOlder: false, isLoadingOlder: false });
        expect(h.messages().messages).toHaveLength(2);
        expect(h.sync.sessionOldestSeq.get('session')).toBe(1);
        const calls = h.request.mock.calls.length;
        await h.sync.loadOlderMessages('session');
        expect(h.request).toHaveBeenCalledTimes(calls);
    });

    it('initializes pagination after preload and preserves an existing container', async () => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, i < 2)));
        h.storage.getState().applyMessagesLoaded('session');
        const reducerState = h.messages().reducerState;
        await h.sync.preloadLatestPage('session', new AbortController().signal);
        expect(h.messages().reducerState).toBe(reducerState);
        expect(h.messages().hasMoreOlder).toBe(true);
        const fresh = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, i < 2)));
        await fresh.sync.preloadLatestPage('session', new AbortController().signal);
        expect(fresh.messages().hasMoreOlder).toBe(true);
    });

    it('keeps the five-attempt background budget while explicit demand crosses a deep invisible tail', async () => {
        const h = setup(Array.from({ length: 702 }, (_, i) => record(i + 1, i < 2)));
        await h.sync.fetchMessages('session');
        await h.sync.fetchOlderMessagesInBackground('session');
        expect(h.request).toHaveBeenCalledTimes(6);
        expect(h.messages()).toMatchObject({ messages: [], hasMoreOlder: true });
        await h.sync.fetchOlderMessagesInBackground('session');
        expect(h.request).toHaveBeenCalledTimes(6);
        await h.sync.loadOlderMessages('session');
        expect(h.messages().messages).toHaveLength(0);
        expect(h.sync.sessionOldestSeq.get('session')).toBe(3);
        await h.sync.loadOlderMessages('session');
        expect(h.messages().messages).toHaveLength(2);
        expect(h.messages().hasMoreOlder).toBe(false);
    });

    it('clears loading after 503, preserves the cursor and permits explicit retry', async () => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, true)));
        await h.sync.fetchMessages('session');
        h.request.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ messages: [], hasMore: true }) });
        await expect(h.sync.loadOlderMessages('session')).rejects.toThrow('503');
        expect(h.messages().isLoadingOlder).toBe(false);
        expect(h.sync.sessionOldestSeq.get('session')).toBe(3);
        await h.sync.loadOlderMessages('session');
        expect(h.messages().messages).toHaveLength(102);
    });

    it('reports cursor progress: true for a page that moved back, false for every no-op', async () => {
        const h = setup(Array.from({ length: 202 }, (_, i) => record(i + 1, true)));
        expect(await h.sync.loadOlderMessages('session')).toBe(false); // no initial fetch yet
        await h.sync.fetchMessages('session');
        expect(await h.sync.loadOlderMessages('session')).toBe(true);
        expect(await h.sync.loadOlderMessages('session')).toBe(true); // reaches seq 1
        expect(h.messages().hasMoreOlder).toBe(false);
        expect(await h.sync.loadOlderMessages('session')).toBe(false); // oldestSeq <= 1
        h.storage.getState().applyOlderMessagesPagination('session', { hasMore: true });
        expect(await h.sync.loadOlderMessages('session')).toBe(false); // cursor at 1 even if the store says more
        const calls = h.request.mock.calls.length;
        h.storage.getState().applyOlderMessagesLoading('session', true);
        expect(await h.sync.loadOlderMessages('session')).toBe(false); // in flight elsewhere
        expect(h.request).toHaveBeenCalledTimes(calls);
    });

    it('rejects, rather than silently no-ops, when the session key is missing', async () => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, true)));
        await h.sync.fetchMessages('session');
        h.sync.encryption = { getSessionEncryption: () => null };
        await expect(h.sync.loadOlderMessages('session')).rejects.toThrow('encryption not ready');
        expect(h.messages()).toMatchObject({ hasMoreOlder: true, isLoadingOlder: false });
        expect(h.request).toHaveBeenCalledTimes(1);
    });

    it('treats a non-empty backward page that does not move the cursor as exhausted', async () => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, true)));
        await h.sync.fetchMessages('session');
        // A misbehaving server repeats the newest page for every cursor.
        h.request.mockResolvedValue({ ok: true, status: 200, json: async () => ({ messages: [record(102, true), record(3, true)], hasMore: true }) });
        await h.sync.loadOlderMessages('session');
        expect(h.messages()).toMatchObject({ hasMoreOlder: false, isLoadingOlder: false });
        expect(h.sync.sessionOldestSeq.get('session')).toBe(3);
        await h.sync.loadOlderMessages('session');
        expect(h.request).toHaveBeenCalledTimes(2);
    });

    it('treats an empty backward response as exhausted even if it advertises more', async () => {
        const h = setup(Array.from({ length: 102 }, (_, i) => record(i + 1, true)));
        await h.sync.fetchMessages('session');
        h.request.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ messages: [], hasMore: true }) });
        await h.sync.loadOlderMessages('session');
        expect(h.messages()).toMatchObject({ hasMoreOlder: false, isLoadingOlder: false });
        expect(h.sync.sessionOldestSeq.get('session')).toBe(3);
        await h.sync.loadOlderMessages('session');
        expect(h.request).toHaveBeenCalledTimes(2);
    });

    it('does not initialize a failed or cancelled first page and correctly loads an empty session', async () => {
        const failed = setup([]);
        failed.request.mockRejectedValueOnce(new Error('503'));
        await expect(failed.sync.fetchMessages('session')).rejects.toThrow('503');
        expect(failed.messages()).toBeUndefined();
        const aborted = setup([record(1, true)]);
        const controller = new AbortController();
        aborted.encryption.decryptMessages.mockImplementationOnce(async messages => { controller.abort(); return messages; });
        await expect(aborted.sync.preloadLatestPage('session', controller.signal)).rejects.toThrow('cancelled');
        expect(aborted.messages()).toBeUndefined();
        const empty = setup([]);
        await empty.sync.fetchMessages('session');
        expect(empty.messages()).toMatchObject({ messages: [], isLoaded: true, hasMoreOlder: false });
    });
});