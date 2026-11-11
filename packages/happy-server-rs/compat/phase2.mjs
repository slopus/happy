// Phase 2 scenario: Engine.IO transports and errors, the Socket.IO handshake,
// every socket handler, RPC routing, and socket.io-client 4.8 end to end.
import { createRequire } from 'node:module';
import { b64, nacl, signKey } from './lib.mjs';
const require = createRequire(import.meta.url);
const { io } = require('../../../node_modules/socket.io-client');

const E = '/v1/updates/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function login(t, n, name = 'auth') {
    const kp = signKey(n);
    const challenge = new Uint8Array(32).fill(n + 1);
    const sig = nacl.sign.detached(challenge, kp.secretKey);
    const r = await t.req(name, 'POST', '/v1/auth', { body: { publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(sig) } });
    return r.token;
}

/** A frame as data: the packet prefix plus its parsed JSON, so ids normalize. */
function parseFrame(f) {
    if (f.startsWith('BIN:')) return f;
    const i = f.search(/[[{"]/);
    if (i < 0) return f;
    try {
        return { p: f.slice(0, i), d: JSON.parse(f.slice(i)) };
    } catch {
        return f;
    }
}

/** A hand-driven Engine.IO + Socket.IO client over a WebSocket (what the iOS and Android apps do). */
export class Raw {
    static async open(t, name, query = '?EIO=4&transport=websocket', { pong = true } = {}) {
        const c = new Raw();
        c.name = name;
        c.frames = [];
        c.closed = null;
        c.ws = new WebSocket(t.base.replace(/^http/, 'ws') + E + query);
        c.ws.binaryType = 'arraybuffer';
        c.ws.onmessage = (e) => {
            const d = typeof e.data === 'string' ? e.data : 'BIN:' + Buffer.from(e.data).toString('base64');
            if (d === '2' && pong) {
                c.ws.send('3');
                return;
            }
            c.frames.push(d);
        };
        c.ws.onclose = (e) => {
            c.closed = { code: e.code };
        };
        await new Promise((res) => {
            c.ws.onopen = res;
            c.ws.onerror = res;
        });
        await c.until(1);
        return c;
    }

    send(s) {
        if (this.ws.readyState === 1) this.ws.send(s);
    }

    emit(event, data, ack) {
        this.send('42' + (ack ?? '') + JSON.stringify(data === undefined ? [event] : [event, data]));
    }

    take() {
        const f = this.frames;
        this.frames = [];
        return f.map(parseFrame);
    }

    async until(n, ms = 5000) {
        const end = Date.now() + ms;
        while (this.frames.length < n && !this.closed && Date.now() < end) await sleep(10);
    }

    close() {
        try {
            this.ws.close();
        } catch {}
    }
}

/** Runs an action, waits until every client has been quiet for `quiet` ms, records what each received. */
// QUIET_SCALE stretches the quiet windows on a loaded host, where the TS server can
// stall for longer than a window and its late frames land in the next step.
const QUIET_SCALE = Number(process.env.QUIET_SCALE) || 1;

export async function step(t, name, clients, action, { quiet = 250, max = 8000 } = {}) {
    quiet *= QUIET_SCALE;
    max *= QUIET_SCALE;
    await action();
    const end = Date.now() + max;
    let last = -1;
    while (Date.now() < end) {
        const n = clients.reduce((a, c) => a + c.frames.length + (c.closed ? 1000 : 0), 0);
        if (n === last) break;
        last = n;
        await sleep(quiet);
    }
    const out = {};
    for (const c of clients) {
        out[c.name] = c.take();
        if (c.closed) out[c.name].push({ closed: c.closed.code });
    }
    t.note(name, out);
}

export async function connected(t, name, auth, query) {
    const c = await Raw.open(t, name, query);
    c.take();
    c.send('40' + JSON.stringify(auth));
    await c.until(1);
    c.take();
    return c;
}

async function sioSmoke(t, label, transports, token) {
    const s = io(t.base, { path: '/v1/updates', transports, auth: { token, clientType: 'user-scoped', happyClient: 'smoke/1' }, reconnection: false, forceNew: true });
    const r = {};
    try {
        await new Promise((res, rej) => {
            s.on('connect', res);
            s.on('connect_error', rej);
            setTimeout(() => rej(new Error('timeout')), 5000);
        });
        r.connected = s.connected;
        r.idLength = s.id.length;
        r.firstTransport = transports[0];
        await sleep(600);
        r.transportAfter = s.io.engine.transport.name;
        r.ack = await s.timeout(3000).emitWithAck('ping');
        const upd = new Promise((res) => s.once('update', res));
        await t.req(`${label}: create session`, 'POST', '/v1/sessions', { headers: { authorization: 'Bearer ' + token }, body: { tag: 'smoke-' + label, metadata: 'm' } });
        r.update = await Promise.race([upd, sleep(3000).then(() => 'no update')]);
        r.rpcMissing = await s.timeout(1000).emitWithAck('rpc-call', { method: '' });
    } catch (e) {
        r.error = e.message;
    }
    s.disconnect();
    t.note(`socket.io-client ${label}`, r);
}

export async function scenario(t, { sql }) {
    const token = await login(t, 1);
    const token2 = await login(t, 2, 'auth user2');
    const H = { authorization: 'Bearer ' + token };
    const uid = (await sql(`SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1`)).trim();
    const s1 = await t.req('create s1', 'POST', '/v1/sessions', { headers: H, body: { tag: 't1', metadata: 'meta-1' } });
    const sid = s1.session.id;
    const s2 = await t.req('create s2', 'POST', '/v1/sessions', { headers: H, body: { tag: 't2', metadata: 'meta-2' } });
    const sid2 = s2.session.id;
    await sql(`INSERT INTO "Machine" ("id","accountId","metadata","daemonState","updatedAt","lastActiveAt") VALUES ('mach-1','${uid}','mm',NULL,now(),now() AT TIME ZONE 'UTC'), ('mach-2','${uid}','mm2','ds',now(),now() AT TIME ZONE 'UTC')`);
    await sql(`INSERT INTO "AccessKey" ("id","accountId","machineId","sessionId","data","updatedAt") VALUES ('ak1','${uid}','mach-1','${sid}','secret',now())`);

    // lastActiveAt in UTC: the server session is UTC, the harness Postgres may not be,
    // and a stale row would be swept by presence at a boot-relative moment.
    // Never-connected sessions, checked at the end (connectTimeout is 20 s).
    const idle = await Raw.open(t, 'idle');
    idle.take();
    const idleOpen = await t.req('idle poll handshake', 'GET', E + '?EIO=4&transport=polling');
    const idleSid = JSON.parse(idleOpen.slice(1)).sid;
    const idlePolls = (async () => {
        await sleep(21_500);
        const out = [];
        for (let i = 0; i < 3; i++) {
            const r = await fetch(t.base + E + '?EIO=4&transport=polling&sid=' + idleSid);
            out.push({ status: r.status, body: await r.text() });
        }
        return out;
    })();

    // --- Engine.IO HTTP: verify() errors, CORS ---
    await t.req('eio no query', 'GET', E);
    await t.req('eio unknown transport', 'GET', E + '?EIO=4&transport=xhr');
    await t.req('eio webtransport', 'GET', E + '?EIO=4&transport=webtransport');
    await t.req('eio v3', 'GET', E + '?EIO=3&transport=polling');
    await t.req('eio no version', 'GET', E + '?transport=polling');
    await t.req('eio unknown sid', 'GET', E + '?EIO=4&transport=polling&sid=nope');
    await t.req('eio post handshake', 'POST', E + '?EIO=4&transport=polling', { raw: '40' });
    await t.req('eio websocket without upgrade', 'GET', E + '?EIO=4&transport=websocket');
    await t.req('eio preflight', 'OPTIONS', E + '?EIO=4&transport=polling', { headers: { origin: 'http://x', 'access-control-request-method': 'GET' } });
    await t.req('eio bare options', 'OPTIONS', E);
    await t.req('no slash is not engine', 'GET', '/v1/updates?EIO=4&transport=polling');
    await t.req('engine prefix any path', 'GET', '/v1/updates/x/y?EIO=4&transport=xhr');

    // --- Polling session ---
    const P = (psid) => E + '?EIO=4&transport=polling&sid=' + psid;
    const open = await t.req('poll handshake', 'GET', E + '?EIO=4&transport=polling&t=abc');
    const psid = JSON.parse(open.slice(1)).sid;
    await t.req('poll post no auth', 'POST', P(psid), { raw: '40', headers: { 'content-type': 'text/plain;charset=UTF-8' } });
    await t.req('poll get connect error', 'GET', P(psid));
    await t.req('poll wrong transport', 'POST', E + '?EIO=4&transport=websocket&sid=' + psid, { raw: '40' });
    await t.req('poll put', 'PUT', P(psid), { raw: 'x' });
    await t.req('poll post connect', 'POST', P(psid), { raw: '40' + JSON.stringify({ token, clientType: 'user-scoped' }) });
    await t.req('poll get connected', 'GET', P(psid));
    await t.req('poll batch ping acks', 'POST', P(psid), { raw: '421["ping"]\x1e422["ping",1]\x1e423["ping"]\x1e3' });
    await t.req('poll get acks', 'GET', P(psid));
    const big = 'x'.repeat(3000);
    await t.req('poll rpc register big', 'POST', P(psid), { raw: '42["rpc-register",{"method":"' + big + '"}]' });
    await t.req('poll get compressed', 'GET', P(psid), { headers: { 'accept-encoding': 'gzip, deflate' } });
    await t.req('poll rpc register big 2', 'POST', P(psid), { raw: '42["rpc-register",{"method":"' + big + '"}]' });
    await t.req('poll get deflate', 'GET', P(psid), { headers: { 'accept-encoding': 'deflate, gzip' } });
    await t.req('poll too large', 'POST', P(psid), { raw: 'x'.repeat(8 * 1024 * 1024 + 1) });
    // A pending poll answered with noop when another one overlaps (session dies).
    const pending = t.req('poll pending', 'GET', P(psid));
    await sleep(300);
    await t.req('poll overlap', 'GET', P(psid));
    await pending;
    // Both answers are written together; record them in a fixed order.
    t.entries.splice(-2, 2, ...t.entries.slice(-2).sort((a, b) => a.name.localeCompare(b.name)));
    await t.req('poll after overlap', 'GET', P(psid));

    const open2 = await t.req('poll handshake 2', 'GET', E + '?EIO=4&transport=polling');
    const psid2 = JSON.parse(open2.slice(1)).sid;
    await t.req('poll client close', 'POST', P(psid2), { raw: '1' });
    await t.req('poll after client close', 'GET', P(psid2));
    const open3 = await t.req('poll handshake 3', 'GET', E + '?EIO=4&transport=polling');
    const psid3 = JSON.parse(open3.slice(1)).sid;
    await t.req('poll parse error', 'POST', P(psid3), { raw: 'x' });
    await t.req('poll after parse error', 'GET', P(psid3));
    const open4 = await t.req('poll handshake 4', 'GET', E + '?EIO=4&transport=polling');
    const psid4 = JSON.parse(open4.slice(1)).sid;
    await t.req('poll bad socket.io packet', 'POST', P(psid4), { raw: '4x' });
    await t.req('poll after forced close', 'GET', P(psid4));
    await t.req('poll after forced close 2', 'GET', P(psid4));
    const open5 = await t.req('poll handshake 5', 'GET', E + '?EIO=4&transport=polling');
    const psid5 = JSON.parse(open5.slice(1)).sid;
    await t.req('poll event before connect', 'POST', P(psid5), { raw: '42["ping"]' });
    await t.req('poll after event before connect', 'GET', P(psid5));

    // JSONP polling (?j=) and the IE X-XSS-Protection header.
    const jopen = await t.req('jsonp handshake', 'GET', E + '?EIO=4&transport=polling&j=7', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0)' } });
    const jsid = JSON.parse(JSON.parse(jopen.slice('___eio[7]('.length, -2)).slice(1)).sid;
    const J = E + '?EIO=4&transport=polling&j=7&sid=' + jsid;
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    await t.req('jsonp post connect', 'POST', J, { headers: form, raw: 'd=' + encodeURIComponent('40' + JSON.stringify({ token, clientType: 'user-scoped' })) });
    await t.req('jsonp get connected', 'GET', J, { headers: { 'user-agent': 'Mozilla/4.0 (compatible;MSIE 9.0)' } });
    await t.req('jsonp post escaped newline', 'POST', J, { headers: { ...form, 'user-agent': 'Mozilla/4.0 (compatible;MSIE 9.0)' }, raw: 'd=' + encodeURIComponent('421["ping"\\n]\x1e422["ping",\\n1]\x1e423["ping","a\\\\nb"]') });
    await t.req('jsonp get after newline', 'GET', J);
    await t.req('jsonp post no d', 'POST', J, { headers: form, raw: 'x=1' });
    await t.req('jsonp get after no d', 'GET', J);
    await t.req('jsonp bad j', 'GET', E + '?EIO=4&transport=polling&j=x');

    const open7 = await t.req('poll handshake abort', 'GET', E + '?EIO=4&transport=polling');
    const psid7 = JSON.parse(open7.slice(1)).sid;
    {
        const ac = new AbortController();
        const p = fetch(t.base + P(psid7), { signal: ac.signal }).catch(() => 'aborted');
        await sleep(200);
        ac.abort();
        t.note('poll aborted by client', await p);
        await sleep(300);
    }
    await t.req('poll after client abort', 'GET', P(psid7));

    // --- Upgrade polling → websocket ---
    const open6 = await t.req('poll handshake upgrade', 'GET', E + '?EIO=4&transport=polling');
    const psid6 = JSON.parse(open6.slice(1)).sid;
    await t.req('upgrade: connect', 'POST', P(psid6), { raw: '40' + JSON.stringify({ token, clientType: 'user-scoped' }) });
    await t.req('upgrade: connected', 'GET', P(psid6));
    const up = await Raw.open(t, 'up', '?EIO=4&transport=websocket&sid=' + psid6).catch(() => null);
    const pollDuringUpgrade = t.req('upgrade: poll during probe', 'GET', P(psid6));
    await sleep(100);
    await step(t, 'upgrade: probe', [up], () => up.send('2probe'));
    await pollDuringUpgrade;
    await step(t, 'upgrade: upgrade', [up], () => up.send('5'));
    await step(t, 'upgrade: ping over ws', [up], () => up.emit('ping', undefined, 7));
    await t.req('upgrade: polling now rejected', 'GET', P(psid6));
    const up2 = await Raw.open(t, 'up2', '?EIO=4&transport=websocket&sid=' + psid6);
    await step(t, 'upgrade: second upgrade refused', [up2, up], () => {});
    up.close();
    await sleep(200);

    // --- WebSocket handshakes and aborts (raw HTTP) ---
    const U = (path, extra = '') => `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
    const KEY = 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';
    await t.raw('ws ok handshake', U(E + '?EIO=4&transport=websocket', KEY), 400);
    await t.raw('ws subprotocol', U(E + '?EIO=4&transport=websocket', KEY + 'Sec-WebSocket-Protocol: a, b\r\n'), 400);
    await t.raw('ws bad subprotocol', U(E + '?EIO=4&transport=websocket', KEY + 'Sec-WebSocket-Protocol: a, a\r\n'), 400);
    await t.raw('ws no key', U(E + '?EIO=4&transport=websocket'));
    await t.raw('ws bad version', U(E + '?EIO=4&transport=websocket', KEY).replace('Version: 13', 'Version: 12'));
    await t.raw('ws bad upgrade header', U(E + '?EIO=4&transport=websocket', KEY).replace('Upgrade: websocket', 'Upgrade: h2c'));
    await t.raw('ws unknown transport', U(E + '?EIO=4&transport=foo', KEY));
    await t.raw('ws unknown sid', U(E + '?EIO=4&transport=websocket&sid=nope', KEY));
    await t.raw('ws post handshake', U(E + '?EIO=4&transport=websocket', KEY).replace('GET ', 'POST '));
    await t.raw('ws eio3', U(E + '?EIO=3&transport=websocket', KEY));
    await t.raw('ws polling transport', U(E + '?EIO=4&transport=polling', KEY));
    await t.raw('upgrade on api route', U('/v1/sessions', KEY), 2500);

    // --- Socket.IO handshake over websocket ---
    const w = await Raw.open(t, 'w');
    t.note('ws open packet', w.take());
    await step(t, 'connect without auth', [w], () => w.send('40'));
    await step(t, 'connect junk token', [w], () => w.send('40{"token":"junk"}'));
    await step(t, 'connect numeric token', [w], () => w.send('40{"token":5}'));
    await step(t, 'session-scoped without id', [w], () => w.send('40' + JSON.stringify({ token, clientType: 'session-scoped' })));
    await step(t, 'machine-scoped without id', [w], () => w.send('40' + JSON.stringify({ token, clientType: 'machine-scoped', machineId: '' })));
    await step(t, 'unknown namespace', [w], () => w.send('40/admin,{"token":"x"}'));
    await step(t, 'connect', [w], () => w.send('40' + JSON.stringify({ token, clientType: 'user-scoped', happyClient: 'ios/1.2.3', appState: 'active' })));
    await step(t, 'ping ack', [w], () => w.emit('ping', undefined, 1));
    await step(t, 'ping with data never acks', [w], () => w.emit('ping', 1, 2));
    await step(t, 'unknown event', [w], () => w.emit('nope', {}, 3));
    await step(t, 'numeric event', [w], () => w.send('425[1]'));
    await step(t, 'event without data', [w], () => w.send('42'));
    await step(t, 'stray ack', [w], () => w.send('4399[1]'));
    await step(t, 'namespace disconnect', [w], () => w.send('41'));
    await step(t, 'reconnect same engine', [w], () => w.send('40' + JSON.stringify({ token })));
    await step(t, 'second connect closes', [w], () => w.send('40' + JSON.stringify({ token })));
    {
        const c = await connected(t, 'c', { token });
        await step(t, 'namespace disconnect 2', [c], () => c.send('41'));
        await step(t, 'event after namespace disconnect', [c], () => c.emit('ping', undefined, 4));
        c.close();
    }

    for (const [label, frame] of [
        ['empty array event', '42[]'],
        ['reserved event', '42["disconnect"]'],
        ['bad json', '42[1'],
        ['unknown packet type', '4x'],
        ['message without data', '4'],
        ['client ping', '2'],
        ['probe on open socket', '2probe'],
        ['empty frame', ''],
        ['disconnect with data', '41{}'],
        ['binary without placeholder header', '51-["message",{"_placeholder":true,"num":0}]'],
    ]) {
        const c = await connected(t, 'c', { token });
        await step(t, `protocol: ${label}`, [c], () => c.send(frame));
        c.close();
    }
    {
        const c = await connected(t, 'c', { token });
        await step(t, 'protocol: frame over maxPayload', [c], () => c.send('42["ping","' + 'x'.repeat(8 * 1024 * 1024) + '"]'));
        c.close();
    }
    {
        const c = await connected(t, 'c', { token });
        await step(t, 'protocol: unexpected binary frame', [c], () => c.ws.send(new Uint8Array([1, 2, 3])));
        c.close();
    }
    {
        const c = await connected(t, 'c', { token });
        await step(t, 'protocol: close packet over ws ignored', [c], () => c.send('1'));
        await step(t, 'protocol: noop ignored', [c], () => c.send('6'));
        await step(t, 'protocol: still alive', [c], () => c.emit('ping', undefined, 1));
        c.close();
    }
    w.close();

    // --- Connected clients for the handlers ---
    const ui = await connected(t, 'ui', { token, clientType: 'user-scoped' });
    const ui2 = await connected(t, 'ui2', { token: token2, clientType: 'user-scoped' });
    const ss = await connected(t, 'ss', { token, clientType: 'session-scoped', sessionId: sid });
    const all = [ui, ui2, ss];
    const daemon = await Raw.open(t, 'daemon');
    daemon.take();
    await step(t, 'machine connects (online ephemeral)', [ui, ui2, ss, daemon], () => daemon.send('40' + JSON.stringify({ token, clientType: 'machine-scoped', machineId: 'mach-1' })));
    all.push(daemon);

    // sessionUpdateHandler
    const um = (d, ack) => () => ss.emit('update-metadata', d, ack);
    await step(t, 'update-metadata invalid', all, um({ sid, metadata: 1, expectedVersion: 0 }, 10));
    await step(t, 'update-metadata no data', all, () => ss.emit('update-metadata', undefined, 11));
    await step(t, 'update-metadata null data', all, um(null, 12));
    await step(t, 'update-metadata unknown session', all, um({ sid: 'nope', metadata: 'x', expectedVersion: 0 }, 13));
    await step(t, 'update-metadata numeric sid', all, um({ sid: 5, metadata: 'x', expectedVersion: 0 }, 14));
    await step(t, 'update-metadata mismatch', all, um({ sid, metadata: 'x', expectedVersion: 5 }, 15));
    await step(t, 'update-metadata float version', all, um({ sid, metadata: 'x', expectedVersion: 0.5 }, 16));
    await step(t, 'update-metadata ok', all, um({ sid, metadata: 'meta-1b', expectedVersion: 0 }, 17));
    await step(t, 'update-metadata no ack', all, um({ sid, metadata: 'meta-1c', expectedVersion: 1 }));
    await step(t, 'update-metadata other user', [ui2, ui], () => ui2.emit('update-metadata', { sid, metadata: 'x', expectedVersion: 2 }, 18));
    const us = (d, ack) => () => ss.emit('update-state', d, ack);
    await step(t, 'update-state unknown session', all, us({ sid: 'nope', agentState: 'a', expectedVersion: 0 }, 20));
    await step(t, 'update-state ok', all, us({ sid, agentState: 'state-1', expectedVersion: 0 }, 21));
    await step(t, 'update-state null', all, us({ sid, agentState: null, expectedVersion: 1 }, 22));
    await step(t, 'update-state mismatch', all, us({ sid, agentState: 'x', expectedVersion: 0 }, 23));
    await step(t, 'update-state bad type', all, us({ sid, agentState: 5, expectedVersion: 2 }, 24));

    const now = () => Date.now();
    await step(t, 'session-alive', all, () => ss.emit('session-alive', { sid, time: now(), thinking: true }));
    await step(t, 'session-alive truthy thinking', all, () => ss.emit('session-alive', { sid, time: now(), thinking: 'yes' }));
    await step(t, 'session-alive future clamps', all, () => ss.emit('session-alive', { sid, time: now() + 3600_000 }));
    await step(t, 'session-alive too old', all, () => ss.emit('session-alive', { sid, time: now() - 11 * 60_000 }));
    await step(t, 'session-alive unknown', all, () => ss.emit('session-alive', { sid: 'nope', time: now() }));
    await step(t, 'session-alive numeric sid', all, () => ss.emit('session-alive', { sid: 7, time: now() }));
    await step(t, 'session-alive string time', all, () => ss.emit('session-alive', { sid, time: String(now()) }));
    await step(t, 'session-alive other user', [ui, ui2], () => ui2.emit('session-alive', { sid, time: now() }));

    await step(t, 'message', all, () => ss.emit('message', { sid, message: 'enc-1', localId: 'l1' }));
    await step(t, 'message duplicate localId', all, () => ss.emit('message', { sid, message: 'enc-dup', localId: 'l1' }));
    await step(t, 'message object content', all, () => ss.emit('message', { sid, message: { b: 1, a: [1.0, 2e3, 'x'], 1: true }, localId: 5 }));
    // A client-made object shaped like the Rust server's internal Buffer marker stays plain JSON.
    await step(t, 'message forged buffer marker', all, () => ss.emit('message', { sid, message: { '\u0000buffer': 'AQI=' } }));
    await step(t, 'message from ui', all, () => ui.emit('message', { sid, message: 'enc-ui' }));
    await step(t, 'message missing', all, () => ss.emit('message', { sid }));
    await step(t, 'message unknown session', all, () => ss.emit('message', { sid: 'nope', message: 'x' }));
    await step(t, 'message other user session', [ui, ui2], () => ui2.emit('message', { sid, message: 'x' }));
    await step(t, 'messages burst in order', all, async () => {
        for (let i = 0; i < 5; i++) ss.emit('message', { sid, message: 'burst-' + i });
    });
    await step(t, 'message binary content', all, () => {
        ss.send('451-["message",{"sid":"' + sid + '","message":{"_placeholder":true,"num":0}}]');
        ss.ws.send(new Uint8Array([7, 8, 9]));
    });

    await step(t, 'session-end other user', [ui, ui2], () => ui2.emit('session-end', { sid, time: now() }));
    await step(t, 'session-end bad time', all, () => ss.emit('session-end', { sid, time: 'x' }));
    await step(t, 'session-end unknown', all, () => ss.emit('session-end', { sid: 'nope', time: now() }));
    await step(t, 'session-end', all, () => ss.emit('session-end', { sid: sid2, time: now() }));

    // usageHandler
    const ur = (d, ack) => () => ss.emit('usage-report', d, ack);
    await step(t, 'usage invalid key', all, ur({ key: '', tokens: {}, cost: {} }, 30));
    await step(t, 'usage invalid tokens', all, ur({ key: 'k', tokens: { total: '1' }, cost: { total: 1 } }, 31));
    await step(t, 'usage array tokens', all, ur({ key: 'k', tokens: [], cost: { total: 1 } }, 32));
    await step(t, 'usage invalid cost', all, ur({ key: 'k', tokens: { total: 1 }, cost: null }, 33));
    await step(t, 'usage invalid sessionId', all, ur({ key: 'k', tokens: { total: 1 }, cost: { total: 1 }, sessionId: 5 }, 34));
    await step(t, 'usage without session', all, ur({ key: 'k', tokens: { total: 1 }, cost: { total: 1 } }, 35));
    await step(t, 'usage unknown session', all, ur({ key: 'k', tokens: { total: 1 }, cost: { total: 1 }, sessionId: 'nope' }, 36));
    await step(t, 'usage ok', all, ur({ key: 'k', tokens: { total: 10, in: 4 }, cost: { total: 0.5 }, sessionId: sid }, 37));
    await step(t, 'usage upsert', all, ur({ key: 'k', tokens: { total: 11 }, cost: { total: 0.75 }, sessionId: sid }, 38));
    await step(t, 'usage no ack', all, ur({ key: 'k2', tokens: { total: 1 }, cost: { total: 1 }, sessionId: sid }));
    await step(t, 'usage null data', all, ur(null, 39));

    // machineUpdateHandler
    await step(t, 'machine-alive', all, () => daemon.emit('machine-alive', { machineId: 'mach-1', time: now() }));
    await step(t, 'machine-alive unknown', all, () => daemon.emit('machine-alive', { machineId: 'nope', time: now() }));
    await step(t, 'machine-alive bad', all, () => daemon.emit('machine-alive', { machineId: 'mach-1' }));
    const mu = (ev, d, ack) => () => daemon.emit(ev, d, ack);
    await step(t, 'machine-update-metadata invalid', all, mu('machine-update-metadata', { machineId: 'mach-1', metadata: 5, expectedVersion: 0 }, 40));
    await step(t, 'machine-update-metadata unknown', all, mu('machine-update-metadata', { machineId: 'nope', metadata: 'x', expectedVersion: 0 }, 41));
    await step(t, 'machine-update-metadata mismatch', all, mu('machine-update-metadata', { machineId: 'mach-1', metadata: 'x', expectedVersion: 3 }, 42));
    await step(t, 'machine-update-metadata ok', all, mu('machine-update-metadata', { machineId: 'mach-1', metadata: 'mm-b', expectedVersion: 0 }, 43));
    await step(t, 'machine-update-state mismatch null state', all, mu('machine-update-state', { machineId: 'mach-1', daemonState: 'x', expectedVersion: 1 }, 44));
    await step(t, 'machine-update-state ok', all, mu('machine-update-state', { machineId: 'mach-1', daemonState: 'ds-1', expectedVersion: 0 }, 45));
    await step(t, 'machine-update-state other machine', all, mu('machine-update-state', { machineId: 'mach-2', daemonState: 'ds-2', expectedVersion: 0 }, 46));
    await step(t, 'machine-update-state numeric id', all, mu('machine-update-state', { machineId: 9, daemonState: 'x', expectedVersion: 0 }, 47));

    // sessionSubscribeHandler
    await step(t, 'subscribe from ui', all, () => ui.emit('session-subscribe', { sids: [sid] }, 50));
    await step(t, 'subscribe invalid', all, () => daemon.emit('session-subscribe', { sids: [] }, 51));
    await step(t, 'subscribe invalid type', all, () => daemon.emit('session-subscribe', { sids: [1] }, 52));
    await step(t, 'subscribe no data', all, () => daemon.emit('session-subscribe', undefined, 53));
    await step(t, 'subscribe', all, () => daemon.emit('session-subscribe', { sids: [sid, 'nope', sid, sid2] }, 54));
    await step(t, 'message reaches subscriber', all, () => ss.emit('message', { sid, message: 'to-daemon' }));
    await step(t, 'update reaches subscriber', all, um({ sid, metadata: 'meta-1d', expectedVersion: 2 }, 55));
    await step(t, 'unsubscribe', all, () => daemon.emit('session-unsubscribe', { sids: [sid, 'zzz'] }, 56));
    await step(t, 'message after unsubscribe', all, () => ss.emit('message', { sid, message: 'after-unsub' }));

    // artifactUpdateHandler
    const A = 'a1b2c3d4-0000-4000-8000-000000000001';
    const ar = (ev, d, ack) => () => ui.emit(ev, d, ack);
    await step(t, 'artifact-create invalid', all, ar('artifact-create', { id: A, header: 'aGVsbG8=', body: 1, dataEncryptionKey: 'a2V5' }, 60));
    await step(t, 'artifact-create bad base64', all, ar('artifact-create', { id: A, header: '!!!', body: 'Ym9keQ==', dataEncryptionKey: 'a2V5' }, 61));
    await step(t, 'artifact-create', all, ar('artifact-create', { id: A, header: 'aGVsbG8=', body: 'Ym9keQ==', dataEncryptionKey: 'a2V5' }, 62));
    await step(t, 'artifact-create idempotent', all, ar('artifact-create', { id: A, header: 'eA==', body: 'eA==', dataEncryptionKey: 'eA==' }, 63));
    await step(t, 'artifact-create other account', [ui2], () => ui2.emit('artifact-create', { id: A, header: 'eA==', body: 'eA==', dataEncryptionKey: 'eA==' }, 64));
    await step(t, 'artifact-read', all, ar('artifact-read', { artifactId: A }, 65));
    await step(t, 'artifact-read missing', all, ar('artifact-read', { artifactId: 'nope' }, 66));
    await step(t, 'artifact-read invalid', all, ar('artifact-read', {}, 67));
    await step(t, 'artifact-update nothing', all, ar('artifact-update', { artifactId: A }, 68));
    await step(t, 'artifact-update bad header', all, ar('artifact-update', { artifactId: A, header: { data: 1, expectedVersion: 1 } }, 69));
    await step(t, 'artifact-update bad body', all, ar('artifact-update', { artifactId: A, body: 'x' }, 70));
    await step(t, 'artifact-update mismatch', all, ar('artifact-update', { artifactId: A, header: { data: 'eQ==', expectedVersion: 5 }, body: { data: 'eQ==', expectedVersion: 1 } }, 71));
    await step(t, 'artifact-update header', all, ar('artifact-update', { artifactId: A, header: { data: 'aGVhZGVyMg==', expectedVersion: 1 } }, 72));
    await step(t, 'artifact-update both', all, ar('artifact-update', { artifactId: A, header: { data: 'aDM=', expectedVersion: 2 }, body: { data: 'YjI=', expectedVersion: 1 } }, 73));
    await step(t, 'artifact-update bad base64', all, ar('artifact-update', { artifactId: A, body: { data: '@@', expectedVersion: 2 } }, 74));
    await step(t, 'artifact-delete missing', all, ar('artifact-delete', { artifactId: 'nope' }, 75));
    await step(t, 'artifact-delete', all, ar('artifact-delete', { artifactId: A }, 76));
    await step(t, 'artifact-read after delete', all, ar('artifact-read', { artifactId: A }, 77));

    // accessKeyHandler
    await step(t, 'access-key-get', all, () => daemon.emit('access-key-get', { sessionId: sid, machineId: 'mach-1' }, 80));
    await step(t, 'access-key-get none', all, () => daemon.emit('access-key-get', { sessionId: sid2, machineId: 'mach-1' }, 81));
    await step(t, 'access-key-get missing machine', all, () => daemon.emit('access-key-get', { sessionId: sid, machineId: 'nope' }, 82));
    await step(t, 'access-key-get invalid', all, () => daemon.emit('access-key-get', { sessionId: sid }, 83));
    await step(t, 'access-key-get null data', all, () => daemon.emit('access-key-get', null, 84));

    // rpcHandler
    await step(t, 'rpc-register invalid', all, () => daemon.emit('rpc-register', { method: '' }));
    await step(t, 'rpc-register null', all, () => daemon.emit('rpc-register', null));
    await step(t, 'rpc-register', all, () => daemon.emit('rpc-register', { method: 'mach-1:bash' }));
    await step(t, 'rpc-call invalid', all, () => ui.emit('rpc-call', { params: 1 }, 90));
    const users = [ui, ui2, ss];
    const request = async (label, n = 1) => {
        await daemon.until(n);
        const r = daemon.take();
        t.note(label, r);
        return r.length && r[0].p ? r[0].p.replace(/^4(2|51-)/, '') : 'none';
    };
    await step(t, 'rpc-call to daemon', users, () => ui.emit('rpc-call', { method: 'mach-1:bash', params: { cmd: 'ls' } }, 91));
    const reqId = await request('rpc-call: daemon request');
    await step(t, 'rpc-call: daemon answers', all, () => daemon.send('43' + reqId + '[{"out":"file"},2]'));
    await step(t, 'rpc-call: daemon answers twice ignored', all, () => daemon.send('43' + reqId + '[{"out":"again"}]'));
    await step(t, 'rpc-call no params', users, () => ui.emit('rpc-call', { method: 'mach-1:bash' }, 92));
    const reqId2 = await request('rpc-call: daemon request 2');
    await step(t, 'rpc-call: empty ack', all, () => daemon.send('43' + reqId2 + '[]'));
    await step(t, 'rpc-call: null result', users, () => ui.emit('rpc-call', { method: 'mach-1:bash', params: null }, 97));
    const reqId4 = await request('rpc-call: daemon request null params');
    await step(t, 'rpc-call: null answer', all, () => daemon.send('43' + reqId4 + '[null]'));
    await step(t, 'rpc-call forged buffer marker', users, () => ui.emit('rpc-call', { method: 'mach-1:bash', params: { '\u0000buffer': 'AQI=' } }, 99));
    const reqId5 = await request('rpc-call: daemon request forged marker');
    await step(t, 'rpc-call: forged marker answer', all, () => daemon.send('43' + reqId5 + '[{"\\u0000buffer":"AwQ="}]'));
    await step(t, 'rpc-call self', all, () => daemon.emit('rpc-call', { method: 'mach-1:bash' }, 93));
    await step(t, 'rpc-call binary params', users, () => {
        ui.send('451-98["rpc-call",{"method":"mach-1:bash","params":{"_placeholder":true,"num":0}}]');
        ui.ws.send(new Uint8Array([1, 2, 3, 4]));
    });
    const reqId3 = await request('rpc-call: binary request', 2);
    await step(t, 'rpc-call: binary answer', all, () => {
        daemon.send('461-' + reqId3 + '[{"_placeholder":true,"num":0}]');
        daemon.ws.send(new Uint8Array([5, 6]));
    });
    await step(t, 'rpc-unregister', all, () => daemon.emit('rpc-unregister', { method: 'mach-1:bash' }));
    await step(t, 'rpc-unregister invalid', all, () => daemon.emit('rpc-unregister', {}));
    // A daemon reconnecting inside the 15 s grace window is found.
    await step(t, 'rpc-call waits for daemon', all, async () => {
        ui.emit('rpc-call', { method: 'mach-1:late' }, 94);
        await sleep(1000);
        daemon.emit('rpc-register', { method: 'mach-1:late' });
        await daemon.until(2);
        const r = daemon.frames.map(parseFrame).find((f) => f.p && f.p.startsWith('42') && f.d[0] === 'rpc-request');
        if (r) daemon.send('43' + r.p.slice(2) + '["late-ok"]');
    }, { quiet: 600 });
    // The target disconnects mid-call: two presence misses (about 4 s).
    const d2 = await connected(t, 'd2', { token, clientType: 'machine-scoped', machineId: 'mach-2' });
    await step(t, 'second daemon online', [ui, d2], () => d2.emit('rpc-register', { method: 'mach-2:slow' }));
    await step(t, 'rpc-call target disconnects', [ui, d2], async () => {
        ui.emit('rpc-call', { method: 'mach-2:slow' }, 95);
        await d2.until(1);
        d2.close();
        await sleep(5000);
    }, { quiet: 600 });
    await step(t, 'rpc-call not available (15 s)', [ui], async () => {
        ui.emit('rpc-call', { method: 'mach-9:none' }, 96);
        await ui.until(1, 20000);
    });

    // Machine goes offline.
    await step(t, 'machine disconnects (offline ephemeral)', [ui, ui2, ss], () => daemon.close());
    for (const c of [ui, ui2, ss]) c.close();
    await sleep(300);

    // --- socket.io-client 4.8 end to end ---
    await sioSmoke(t, 'websocket only', ['websocket'], token);
    await sioSmoke(t, 'polling then upgrade', ['polling', 'websocket'], token);
    {
        const s = io(t.base, { path: '/v1/updates', transports: ['websocket'], auth: { token: 'junk' }, reconnection: false, forceNew: true });
        const err = await new Promise((res) => s.on('connect_error', (e) => res(e.message)));
        s.close();
        t.note('socket.io-client bad token', err);
    }

    // --- connectTimeout: sessions that never joined a namespace ---
    t.note('idle websocket after connect timeout', { frames: idle.take(), closed: idle.closed });
    t.note('idle polling after connect timeout', await idlePolls);

    // --- Database after the socket traffic ---
    for (const [name, q] of [
        ['db sessions', `SELECT "tag","seq","metadata","metadataVersion","agentState","agentStateVersion","active" FROM "Session" ORDER BY "tag"`],
        ['db messages', `SELECT "seq","localId","content" FROM "SessionMessage" ORDER BY "seq"`],
        ['db machines', `SELECT "id","metadata","metadataVersion","daemonState","daemonStateVersion","active" FROM "Machine" ORDER BY "id"`],
        ['db usage', `SELECT "key","data" FROM "UsageReport" ORDER BY "key"`],
        ['db artifacts', `SELECT "id" FROM "Artifact"`],
        ['db account seq', `SELECT "seq" FROM "Account" ORDER BY "createdAt"`],
    ]) {
        t.note(name, JSON.parse((await sql(`SELECT coalesce(json_agg(t), '[]') FROM (${q}) t`)) || '[]'));
    }
}
