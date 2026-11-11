// Opt-in Phase 2 timers that take wall-clock time (about 70 s per server):
// the 30 s RPC ack timeout, the ping timeout, the 10 s upgrade timeout, and the
// 30 s close timeouts of a polling transport and of an unanswered close frame.
// Checks run concurrently; elapsed times are recorded in 5 s buckets.
import net from 'node:net';
import { Raw, connected, login, step } from './phase2.mjs';

const E = '/v1/updates/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bucket = (t0) => Math.round((Date.now() - t0) / 5000) * 5;

async function until(cond, ms) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(20);
}

/** The RPC target registers but never answers: `operation has timed out` after 30 s. */
async function rpcTimeout(t, token) {
    const ui = await connected(t, 'ui', { token, clientType: 'user-scoped' });
    const daemon = await connected(t, 'daemon', { token, clientType: 'machine-scoped', machineId: 'mach-1' });
    await step(t, 'rpc-register hang', [daemon], () => daemon.emit('rpc-register', { method: 'mach-1:hang' }));
    ui.take();
    const t0 = Date.now();
    ui.emit('rpc-call', { method: 'mach-1:hang' }, 1);
    await until(() => ui.frames.length > 0, 40_000);
    const r = { ui: ui.take(), daemon: daemon.take(), seconds: bucket(t0) };
    ui.close();
    daemon.close();
    return r;
}

/** A websocket client that never answers pings. */
async function pingTimeout(t, token) {
    const c = await Raw.open(t, 'nopong', undefined, { pong: false });
    const t0 = Date.now();
    c.send('40' + JSON.stringify({ token, clientType: 'user-scoped' }));
    await until(() => c.closed, 80_000);
    return { frames: c.take(), closed: c.closed, seconds: bucket(t0) };
}

/** Probe answered, but the client never sends `5`: the websocket is closed after 10 s; polling lives on. */
async function upgradeTimeout(t) {
    const open = await (await fetch(t.base + E + '?EIO=4&transport=polling')).text();
    const sid = JSON.parse(open.slice(1)).sid;
    const t0 = Date.now();
    const ws = new WebSocket(t.base.replace(/^http/, 'ws') + E + '?EIO=4&transport=websocket&sid=' + sid);
    const frames = [];
    let closed = null;
    let closedAt = 0;
    ws.onmessage = (e) => frames.push(String(e.data));
    ws.onclose = (e) => {
        closed = e.code;
        closedAt = bucket(t0);
    };
    await new Promise((res) => (ws.onopen = res));
    ws.send('2probe');
    await until(() => closed !== null, 20_000);
    const poll = await fetch(t.base + E + '?EIO=4&transport=polling&sid=' + sid);
    return { frames, closed, seconds: closedAt, pollAfter: { status: poll.status, body: await poll.text() }, pollSeconds: bucket(t0) };
}

/**
 * The connect timeout (20 s) closes a polling session. With packets still buffered
 * the close waits for them to drain (`drain`); with nothing buffered and no pending
 * GET it waits up to 30 s for one. `drainPing` takes the 15 s ping with a GET held
 * from the start, so the buffer is empty at 20 s and the 30 s timer runs.
 */
async function pollCloseTimeout(t, at, drainPing) {
    const open = await (await fetch(t.base + E + '?EIO=4&transport=polling')).text();
    const sid = JSON.parse(open.slice(1)).sid;
    const t0 = Date.now();
    const first = drainPing ? await (await fetch(t.base + E + '?EIO=4&transport=polling&sid=' + sid)).text() : null;
    await sleep(at * 1000 - (Date.now() - t0));
    const r = await fetch(t.base + E + '?EIO=4&transport=polling&sid=' + sid);
    return { drainPing, first, at, status: r.status, body: await r.text() };
}

/** A raw TCP websocket that never answers the server's close frame: dropped 30 s after it. */
async function wsCloseTimeout(t) {
    const u = new URL(t.base);
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise((res) => sock.once('connect', res));
    const t0 = Date.now();
    sock.write(
        `GET ${E}?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    let buf = Buffer.alloc(0);
    let headerDone = false;
    const frames = [];
    let closeFrameAt = null;
    let endedAt = null;
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!headerDone) {
            const i = buf.indexOf('\r\n\r\n');
            if (i < 0) return;
            frames.push({ status: buf.subarray(0, buf.indexOf('\r\n')).toString() });
            buf = buf.subarray(i + 4);
            headerDone = true;
        }
        while (buf.length >= 2) {
            const op = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let off = 2;
            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2);
                off = 4;
            }
            if (buf.length < off + len) return;
            const payload = buf.subarray(off, off + len);
            buf = buf.subarray(off + len);
            if (op === 8) {
                closeFrameAt = bucket(t0);
                frames.push({ op, code: payload.length >= 2 ? payload.readUInt16BE(0) : null });
            } else {
                frames.push({ op, text: payload.toString() });
            }
        }
    });
    sock.on('error', () => {});
    await new Promise((res) => {
        sock.once('close', res);
        setTimeout(res, 80_000);
    });
    endedAt = bucket(t0);
    sock.destroy();
    return { frames, closeFrameAt, endedAt };
}

export async function scenario(t, { sql }) {
    const token = await login(t, 1);
    const uid = (await sql(`SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1`)).trim();
    await sql(`INSERT INTO "Machine" ("id","accountId","metadata","daemonState","updatedAt","lastActiveAt") VALUES ('mach-1','${uid}','mm',NULL,now(),now() AT TIME ZONE 'UTC')`);
    const [rpc, ping, upgrade, pollBuffered, pollIn, pollOut, wsClose] = await Promise.all([
        rpcTimeout(t, token),
        pingTimeout(t, token),
        upgradeTimeout(t),
        pollCloseTimeout(t, 55, false),
        pollCloseTimeout(t, 45, true),
        pollCloseTimeout(t, 55, true),
        wsCloseTimeout(t),
    ]);
    t.note('rpc-call ack timeout', rpc);
    t.note('ping timeout', ping);
    t.note('upgrade timeout', upgrade);
    t.note('poll close with a buffered ping waits for drain', pollBuffered);
    t.note('poll close timeout: GET inside the window', pollIn);
    t.note('poll close timeout: GET after the window', pollOut);
    t.note('ws close frame never answered', wsClose);
}
