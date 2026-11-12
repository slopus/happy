// Group commit (writer.rs) against the TS server's one-at-a-time handlers.
//
// The Rust side forms each batch deterministically: a test hook holds the
// session's next batch until K items are queued, and every item is sent only
// after the previous one is in the queue (so queue order is send order). The TS
// side runs the same items one after another, each waited for by a condition
// (its session seq reached, its row present, or its HTTP response). Then both
// sides' update streams, v3 responses and final rows/seqs are compared, and the
// Rust side asserts that each phase was written as one batch.
import { connected, login, step } from './phase2.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await cond()) return true;
        await sleep(10);
    }
    return false;
}

export async function scenario(t, { sql, side }) {
    const tok1 = await login(t, 1);
    const tok2 = await login(t, 2);
    const H1 = { authorization: 'Bearer ' + tok1 };
    const H2 = { authorization: 'Bearer ' + tok2 };
    const S = (await t.req('session', 'POST', '/v1/sessions', { headers: H1, body: { tag: 'batch', metadata: 'm' } })).session.id;
    const S2 = (await t.req('session 2', 'POST', '/v1/sessions', { headers: H1, body: { tag: 'other', metadata: 'm' } })).session.id;
    await t.req('stored', 'POST', `/v3/sessions/${S}/messages`, { headers: H1, body: { messages: [{ localId: 'old-1', content: 'o1' }, { localId: 'old-2', content: 'o2' }] } });

    const sender = await connected(t, 'sender', { token: tok1, clientType: 'session-scoped', sessionId: S });
    const sender2 = await connected(t, 'sender2', { token: tok1, clientType: 'user-scoped' });
    const ui = await connected(t, 'ui', { token: tok1, clientType: 'user-scoped' });
    const intruder = await connected(t, 'intruder', { token: tok2, clientType: 'user-scoped' });
    const sockets = [sender, sender2, ui, intruder];

    const sessionSeq = async () => Number((await sql(`SELECT "seq" FROM "Session" WHERE "id" = '${S}'`)).trim());
    const hasSeq = async (seq) => (await sql(`SELECT count(*) FROM "SessionMessage" WHERE "sessionId" = '${S}' AND "seq" = ${seq}`)).trim() === '1';
    const hook = async (q = '') => (await fetch(`${t.base}/__test/writer/${S}${q}`)).json();
    const responses = [];

    // An item: a socket message (`seq` = the session seqs it takes in TS, `row` = whether
    // it inserts) or a v3 POST (awaited on TS; collected later on Rust, where it waits
    // for its batch).
    async function phase(name, items) {
        if (side === 'rs') await hook(`?items=${items.length}`);
        const pending = [];
        for (const [i, it] of items.entries()) {
            const before = side === 'ts' ? await sessionSeq() : 0;
            if (it.socket) {
                it.socket.emit('message', it.data);
            } else {
                const p = fetch(`${t.base}/v3/sessions/${S}/messages`, { method: 'POST', headers: { ...it.headers, 'content-type': 'application/json' }, body: JSON.stringify({ messages: it.messages }) }).then(async (r) => ({ status: r.status, body: await r.text() }));
                pending.push(p);
                if (side === 'ts') await p;
            }
            if (side === 'rs') {
                // In the queue before the next is sent (the last one starts the batch).
                if (i < items.length - 1 && !(await until(async () => (await hook()).queued === i + 1))) throw new Error(`${name}: item ${i} never queued`);
            } else if (it.socket && it.seq) {
                await until(async () => (await sessionSeq()) === before + it.seq);
                if (it.row) await until(() => hasSeq(before + it.seq));
            }
        }
        for (const p of pending) responses.push({ phase: name, ...(await p) });
        await step(t, name, sockets, async () => {});
        if (side === 'rs') {
            await until(async () => (await hook()).queued === 0);
            return (await hook()).batches;
        }
    }

    const m = (socket, data, seq, row) => ({ socket, data: { sid: S, ...data }, seq, row });
    const v3 = (headers, messages) => ({ headers, messages });

    // A: one clean batch. Duplicates inside the batch and of stored rows, a v3 request
    // that finds a localId inserted earlier in the same batch, first-wins inside a
    // request, empty content (stored, not published), a non-string message, and
    // another account's socket message and v3 POST (dropped / 404).
    const a = await phase('batch A', [
        m(sender, { message: 'a1', localId: 'x1' }, 1, true),
        m(sender, { message: 'a2', localId: 'x1' }, 1, false),
        m(sender2, { message: 'a3', localId: 'old-1' }, 1, false),
        v3(H1, [{ localId: 'x1', content: 'v-dupe' }, { localId: 'y1', content: 'y1' }, { localId: 'y1', content: 'y1-second' }, { localId: 'old-2', content: 'z' }, { localId: 'y2', content: '' }]),
        m(sender, { message: 'a5' }, 1, true),
        m(sender2, { message: { k: 1, a: 'b' }, localId: 'obj' }, 1, true),
        v3(H1, [{ localId: 'y1', content: 'again' }]),
        m(sender, { message: 'a8', localId: 'y2' }, 1, false),
        m(intruder, { message: 'evil', localId: 'evil' }, 0, false),
        v3(H2, [{ localId: 'evil-2', content: 'evil' }]),
        m(sender2, { message: 'a11', localId: 'a11' }, 1, true),
    ]);

    // B: a batch that fails (jsonb rejects \u0000) and is replayed message by message:
    // the bad socket message burns its seqs, its localId stays free for a later
    // message, the bad v3 request rolls back (500), the rest is written in order.
    const b = await phase('batch B', [
        m(sender, { message: 'b1', localId: 'b1' }, 1, true),
        m(sender, { message: 'bad\u0000', localId: 'b2' }, 1, false),
        v3(H1, [{ localId: 'b3', content: 'b3' }]),
        m(sender2, { message: 'b4', localId: 'b2' }, 1, true),
        v3(H1, [{ localId: 'b5', content: 'has \u0000' }, { localId: 'b6', content: 'b6' }]),
        m(sender, { message: 'b7', localId: 'b1' }, 1, false),
        m(sender, { message: 'b8', localId: 'b6' }, 1, true),
    ]);

    // C: one socket switching sessions waits for its previous message (TS's per-socket lock).
    await step(t, 'cross-session order', sockets, async () => {
        sender2.emit('message', { sid: S, message: 'c1', localId: 'c1' });
        sender2.emit('message', { sid: S2, message: 'c2', localId: 'c2' });
        sender2.emit('message', { sid: S, message: 'c3', localId: 'c3' });
    });

    if (side === 'rs') {
        const shape = (bs) => JSON.stringify(bs.map((x) => [x.items, x.replayed]));
        if (shape(a) !== '[[1,false],[11,false]]') throw new Error('batch A was not one batch: ' + JSON.stringify(a));
        if (shape(b) !== '[[1,false],[11,false],[7,true]]') throw new Error('batch B was not one replayed batch: ' + JSON.stringify(b));
    }

    for (const r of responses) t.note(`v3 ${r.phase}`, r);
    const rows = await sql(`SELECT "sessionId" = '${S}', "seq", coalesce("localId", '-'), "content"::text, "createdAt" = "updatedAt" FROM "SessionMessage" ORDER BY "sessionId" = '${S}' DESC, "seq"`);
    t.note('rows', rows.trim().split('\n'));
    t.note('seqs', (await sql(`SELECT 'session', "tag", "seq" FROM "Session" UNION ALL SELECT 'account', "publicKey", "seq" FROM "Account" ORDER BY 1, 2`)).trim().split('\n'));
    // v1 reads newest first by (createdAt, seq): same order on both.
    t.note('v1 order', (await t.req('v1 messages', 'GET', `/v1/sessions/${S}/messages`, { headers: H1 })).messages.map((x) => x.seq));
    for (const s of sockets) s.close();
}
