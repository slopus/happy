import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventDrivenMessageReplay } from './delegation-real-e2e-replay.mjs';
import { createNativeParentProof } from './delegation-real-e2e-protocol.mjs';

const input = { parentSessionId: 'new-parent', localId: 'parent-input', roleId: 'role', requestId: 'request', childMarker: 'CHILD', parentMarker: 'PARENT', previousTaskIds: [] };
const row = (seq, ev) => ({ id: `message-${seq}`, seq, raw: { role: 'session', content: { id: `envelope-${seq}`, time: seq, role: 'agent', turn: 'root', ev } } });

test('hydrates a coalesced newest-only notification into the complete unchanged native title proof', async () => {
    const proof = createNativeParentProof(input);
    const rows = [row(1, { t: 'turn-start', localIds: [input.localId] }),
        row(2, { t: 'tool-call-start', call: 'list', name: 'other', title: 'Run mcp_happy_agent_roles', args: { action: 'list' } }),
        row(3, { t: 'tool-call-end', call: 'list' }),
        row(4, { t: 'tool-call-start', call: 'delegate', name: 'other', title: 'Run mcp_happy_delegate_task', args: { roleId: input.roleId, requestId: input.requestId, prompt: input.childMarker } }),
        row(5, { t: 'tool-call-end', call: 'delegate' }), row(6, { t: 'text', text: 'PARENT CHILD' }), row(7, { t: 'turn-end', status: 'completed' })];
    const reads = [], errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: input.parentSessionId,
        readPage: async request => { reads.push(request); return { messages: rows, hasMore: false }; },
        onMessage: message => proof.observe(message.raw), onError: error => errors.push(error) });
    await replay.notify(input.parentSessionId, rows.at(-1));
    assert.deepEqual(errors, []);
    assert.deepEqual(reads, [{ sessionId: input.parentSessionId, afterSeq: 0, limit: 500 }]);
    const verified = proof.completed([{ id: 'task', parentSessionId: input.parentSessionId, roleId: input.roleId, childSessionId: 'new-child', status: 'completed', resultAvailable: true }]);
    assert.deepEqual(verified.toolCalls.map(call => call.name), ['agent_roles', 'delegate_task']);
    assert.equal(verified.rootTurnId, 'root');
});

test('uses bounded ascending pagination only until the announced sequence is reached', async () => {
    const reads = [], seen = [], errors = [];
    const rows = Array.from({ length: 6 }, (_, index) => ({ seq: index + 1 }));
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', pageSize: 2,
        readPage: async request => { reads.push(request); const messages = rows.filter(message => message.seq > request.afterSeq).slice(0, request.limit); return { messages, hasMore: messages.at(-1)?.seq < 6 }; },
        onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    await replay.notify('new-parent', rows.at(-1));
    assert.deepEqual(errors, []); assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(reads.map(request => [request.afterSeq, request.limit]), [[0, 2], [2, 2], [4, 2]]);
});

test('delivers contiguous live rows and ignores replayed notices without making a query', async () => {
    const seen = [], errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: () => { throw new Error('No gap exists'); },
        onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    await Promise.all([replay.notify('new-parent', { seq: 1 }), replay.notify('new-parent', { seq: 2 })]);
    await replay.notify('new-parent', { seq: 1 });
    assert.deepEqual(errors, []); assert.deepEqual(seen, [1, 2]);
});

test('serializes overlapping newest-row notices into one in-flight gap read', async () => {
    let finish;
    const page = new Promise(resolve => { finish = resolve; });
    let reads = 0;
    const seen = [], errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: async () => { reads++; return page; },
        onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    const first = replay.notify('new-parent', { seq: 4 });
    const second = replay.notify('new-parent', { seq: 6 });
    finish({ messages: Array.from({ length: 6 }, (_, index) => ({ seq: index + 1 })), hasMore: false });
    await Promise.all([first, second]);
    assert.equal(reads, 1); assert.deepEqual(errors, []); assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
});

test('fails a missing announced row once and never retries or queries on a timer', async () => {
    let reads = 0;
    const errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: async () => { reads++; return { messages: [], hasMore: false }; },
        onMessage: () => assert.fail('No message is available'), onError: error => errors.push(error) });
    await replay.notify('new-parent', { seq: 5 });
    await replay.notify('new-parent', { seq: 6 });
    assert.equal(reads, 1); assert.equal(errors.length, 1); assert.match(errors[0].message, /automatic query retries are disabled/);
});

test('does not re-query a final page that is missing its announced later row', async () => {
    let reads = 0;
    const errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: async () => { reads++; return { messages: [{ seq: 1 }], hasMore: false }; },
        onMessage: () => {}, onError: error => errors.push(error) });
    await replay.notify('new-parent', { seq: 5 });
    assert.equal(reads, 1); assert.equal(errors.length, 1);
});

test('stops an obsolete observer without delivering its late page or reading another page', async () => {
    let finish;
    const page = new Promise(resolve => { finish = resolve; });
    let reads = 0;
    const seen = [], errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: async () => { reads++; return page; },
        onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    const pending = replay.notify('new-parent', { seq: 5 }); replay.stop();
    finish({ messages: [{ seq: 1 }, { seq: 2 }], hasMore: true });
    await pending;
    await replay.notify('new-parent', { seq: 6 });
    assert.equal(reads, 1); assert.deepEqual(seen, []); assert.deepEqual(errors, []);
});

test('ignores a late read failure from an already stopped observer', async () => {
    let reject;
    const page = new Promise((_resolve, fail) => { reject = fail; });
    const errors = [];
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: () => page,
        onMessage: () => assert.fail('The obsolete page must not be delivered'), onError: error => errors.push(error) });
    const pending = replay.notify('new-parent', { seq: 5 }); replay.stop();
    reject(new Error('Late transport failure'));
    await pending;
    assert.deepEqual(errors, []);
});

test('never reads or decrypts foreign-session events', async () => {
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: () => assert.fail('Foreign scope must not be queried'),
        onMessage: () => assert.fail('Foreign content must not be read'), onError: () => assert.fail('Foreign scope is ignored') });
    await replay.notify('old-parent', { seq: 100 });
});

test('allows durable sequence gaps without repeating a query for deleted intermediate rows', async () => {
    const seen = [], errors = [];
    let reads = 0;
    const replay = createEventDrivenMessageReplay({ sessionId: 'new-parent', readPage: async () => { reads++; return { messages: [{ seq: 1 }, { seq: 3 }], hasMore: false }; },
        onMessage: message => seen.push(message.seq), onError: error => errors.push(error) });
    await replay.notify('new-parent', { seq: 3 });
    assert.equal(reads, 1); assert.deepEqual(seen, [1, 3]); assert.deepEqual(errors, []);
});
