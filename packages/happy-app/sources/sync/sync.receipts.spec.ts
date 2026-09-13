import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createReducer, reducer, registerUserMessageServerIds } from './reducer/reducer';
import { messageSortKey } from './typesMessage';
import { normalizeRawMessage, type NormalizedMessage } from './typesRaw';

const HOLD = { holdUserMessagesUntilAccepted: true };

function local(id: string): NormalizedMessage {
    return {
        id, localId: id, createdAt: 1000, role: 'user', isSidechain: false,
        content: { type: 'text', text: id }, meta: { expectsAcceptance: true },
    };
}

// Execute the real transport/adapter methods without importing the native app
// shell. AST extraction keeps the cursor and dispatch code under test intact;
// only sockets, encryption, and background notifications are replaced.
function source(name: string) {
    return ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
}

function transport(state: ReturnType<typeof createReducer>) {
    const parsed = source('./sync.ts');
    const klass = parsed.statements.find((node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === 'Sync')!;
    const names = ['flushOutbox', 'fetchForwardSince', 'applyFetchedMessages'];
    const methods = klass.members
        .filter((member) => member.name && names.includes(member.name.getText(parsed)))
        .map((member) => member.getText(parsed)).join('\n');
    expect(methods).toContain('flushOutbox');

    const receipt = {
        id: 'wire-receipt', localId: 'rig:receipt', seq: 11, createdAt: 3000,
        content: {
            role: 'session',
            content: {
                id: 'receipt', time: 3000, role: 'agent',
                ev: { t: 'user-message-accepted', id: 'durable-1', ref: 'server-1', runId: 'run' },
            },
        },
    };
    const ownEcho = {
        id: 'server-2', localId: 'local-2', seq: 12, createdAt: 2000,
        content: { role: 'user', content: { type: 'text', text: 'local-2' }, meta: { expectsAcceptance: true } },
    };
    const requests: string[] = [];
    const apiSocket = {
        request: async (url: string, options?: { method: string; body: string }) => {
            requests.push(url);
            if (options?.method === 'POST') {
                const sent = JSON.parse(options.body).messages as { localId: string }[];
                return { ok: true, json: async () => ({ messages: sent.map((message, index) => ({
                    id: message.localId === 'local-2' ? 'server-2' : 'server-file', localId: message.localId, seq: 12 + index,
                })) }) };
            }
            const afterSeq = Number(new URL(url, 'https://test.invalid').searchParams.get('after_seq'));
            return { ok: true, json: async () => ({ messages: [receipt, ownEcho].filter((m) => m.seq > afterSeq), hasMore: false }) };
        },
    };
    const storage = { getState: () => ({
        applyUserMessageServerIds: (_sid: string, pairs: { serverId: string; localId: string }[]) => registerUserMessageServerIds(state, pairs),
    }) };
    const javascript = ts.transpile(`class Sync { ${methods} }; return Sync;`, { target: ts.ScriptTarget.ES2022 });
    const Harness = new Function('apiSocket', 'storage', 'normalizeRawMessage', 'log', javascript)(
        apiSocket, storage, normalizeRawMessage, { log() {} },
    );
    const sync = new Harness();
    Object.assign(sync, {
        sessionLastSeq: new Map([['session', 10]]),
        pendingOutbox: new Map([['session', [{ localId: 'local-2', content: 'encrypted', kind: 'user' }]]]),
        sendAbortControllers: new Map(),
        hasPendingOutboxMessages: () => false,
        clearBackgroundSendWatchdog() {},
        cancelBackgroundSendTimeoutNotification: async () => {},
        invalidations: 0,
        getMessagesSync: () => ({ invalidate: () => sync.invalidations++ }),
        applyMessages: (_sid: string, messages: NormalizedMessage[]) => reducer(state, messages, null, HOLD),
    });
    return { sync, requests };
}

describe('receipt transport races', () => {
    it('does not retain attachment acknowledgements as unmatched user messages', async () => {
        const state = createReducer();
        reducer(state, [local('local-2')], null, HOLD);
        const { sync } = transport(state);
        sync.pendingOutbox.get('session').push({ localId: 'file-local', content: 'encrypted-file', kind: 'attachment' });

        await sync.flushOutbox('session');

        expect(state.unmatchedAckServerIds.size).toBe(0);
        expect(state.messageIds.get('server-2')).toBe(state.localIds.get('local-2'));
    });

    it('does not skip an unread receipt when a later send is acknowledged first', async () => {
        const state = createReducer();
        reducer(state, [local('local-1'), local('local-2')], null, HOLD);
        registerUserMessageServerIds(state, [{ serverId: 'server-1', localId: 'local-1' }]);
        const { sync, requests } = transport(state);

        await sync.flushOutbox('session');
        expect(sync.sessionLastSeq.get('session')).toBe(10);
        expect(sync.invalidations).toBe(1);
        expect(state.messageIds.get('server-2')).toBe(state.localIds.get('local-2'));

        await sync.fetchForwardSince('session', { decryptMessages: async (messages: unknown[]) => messages }, 10);
        expect(requests.at(-1)).toContain('after_seq=10');
        expect(sync.sessionLastSeq.get('session')).toBe(12);
        expect(state.messages.get(state.localIds.get('local-1')!)).toMatchObject({ pending: false, sortAt: 3000 });
    });

    it('retains an acknowledgement before the first session message container exists', () => {
        const parsed = source('./storage.ts');
        let adapter: ts.Expression | undefined;
        function visit(node: ts.Node) {
            if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'applyUserMessageServerIds') {
                adapter = node.initializer;
            }
            ts.forEachChild(node, visit);
        }
        visit(parsed);
        expect(adapter).toBeDefined();
        const state: { sessionMessages: Record<string, { reducerState: ReturnType<typeof createReducer> }> } = { sessionMessages: {} };
        const set = (update: (current: typeof state) => Partial<typeof state>) => Object.assign(state, update(state));
        const javascript = ts.transpile(`const apply = ${adapter!.getText(parsed)}; return apply;`, { target: ts.ScriptTarget.ES2022 });
        const apply = new Function('set', 'createReducer', 'registerUserMessageServerIds', 'messageSortKey', javascript)(
            set, createReducer, registerUserMessageServerIds, messageSortKey,
        );

        apply('session', [{ serverId: 'server-1', localId: 'local-1' }]);
        const reduced = state.sessionMessages.session?.reducerState;
        expect(reduced).toBeDefined();
        reducer(reduced!, [local('local-1'), {
            id: 'receipt', localId: null, createdAt: 3000, role: 'event', isSidechain: false,
            content: { type: 'user-message-accepted', ref: 'server-1' },
        }], null, HOLD);
        expect(reduced!.messages.get(reduced!.localIds.get('local-1')!)).toMatchObject({ pending: false, sortAt: 3000 });
    });
});