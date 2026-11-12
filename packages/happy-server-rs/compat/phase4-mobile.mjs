// The native apps' websocket handshakes, byte level. happy-ios (URLSessionWebSocketTask)
// and happy-android (OkHttp 5) speak Engine.IO 4 / Socket.IO 5 by hand
// (SocketIOClient.swift, SocketIoClient.kt), so this replays their upgrade requests
// header for header and records the 101 response, every server frame with its
// header bits, the heartbeat, a refused handshake, and both ways of closing.
import net from 'node:net';
import crypto from 'node:crypto';
import { login } from './phase2.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PATH = '/v1/updates/?EIO=4&transport=websocket';
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';

// CFNetwork's upgrade request (HTTP/1.1; URLSession offers permessage-deflate).
const ios = (host, deflate = true) => [
    `GET ${PATH} HTTP/1.1`,
    `Host: ${host}`,
    `Sec-WebSocket-Key: ${KEY}`,
    'Sec-WebSocket-Version: 13',
    'Upgrade: websocket',
    ...(deflate ? ['Sec-WebSocket-Extensions: permessage-deflate'] : []),
    'Accept: */*',
    'Accept-Language: en-US,en;q=0.9',
    'Connection: Upgrade',
    'Accept-Encoding: gzip, deflate',
    'User-Agent: Happy/2026.11 CFNetwork/3826.500.111 Darwin/24.4.0',
];

// OkHttp's: the caller's headers, RealWebSocket's, then BridgeInterceptor's.
const android = (host) => [
    `GET ${PATH} HTTP/1.1`,
    'X-Happy-Client: android/2.0.0',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${KEY}`,
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Extensions: permessage-deflate',
    `Host: ${host}`,
    'Accept-Encoding: gzip',
    'User-Agent: okhttp/5.5.0',
];

/** A websocket over a plain socket: the handshake bytes as sent, frames with their header bits. */
class Wire {
    static async open(base, lines) {
        const w = new Wire();
        const u = new URL(base);
        w.buf = Buffer.alloc(0);
        w.frames = [];
        w.ended = false;
        w.sock = net.connect(Number(u.port), u.hostname);
        w.sock.on('data', (c) => {
            w.buf = Buffer.concat([w.buf, c]);
            w.parse();
        });
        w.sock.on('end', () => (w.ended = true));
        w.sock.on('close', () => (w.ended = true));
        w.sock.on('error', () => (w.ended = true));
        await new Promise((r) => w.sock.once('connect', r));
        w.sock.write(lines.join('\r\n') + '\r\n\r\n');
        const end = Date.now() + 5000;
        while (!w.head && !w.ended && Date.now() < end) await sleep(5);
        await w.until(1);
        return w;
    }

    parse() {
        if (!this.head) {
            const i = this.buf.indexOf('\r\n\r\n');
            if (i < 0) return;
            const [status, ...hs] = this.buf.subarray(0, i).toString('latin1').split('\r\n');
            const headers = hs
                .map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])
                .filter(([k]) => k !== 'date')
                .map(([k, v]) => `${k}: ${v}`)
                .sort();
            this.head = { status, headers };
            this.buf = this.buf.subarray(i + 4);
        }
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) {
                if (this.buf.length < 4) return;
                len = this.buf.readUInt16BE(2);
                off = 4;
            } else if (len === 127) {
                if (this.buf.length < 10) return;
                len = Number(this.buf.readBigUInt64BE(2));
                off = 10;
            }
            if (b1 & 0x80) off += 4;
            if (this.buf.length < off + len) return;
            const payload = this.buf.subarray(off, off + len);
            const op = b0 & 0x0f;
            this.frames.push({
                fin: b0 >> 7,
                rsv: (b0 >> 4) & 7,
                op,
                masked: b1 >> 7,
                ...(op === 8 ? { code: len >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString() } : { text: payload.toString() }),
            });
            this.buf = this.buf.subarray(off + len);
        }
    }

    /** One masked client frame, as both apps send them. */
    frame(op, payload) {
        const data = Buffer.from(payload);
        const mask = crypto.randomBytes(4);
        const head = data.length < 126 ? Buffer.from([0x80 | op, 0x80 | data.length]) : Buffer.from([0x80 | op, 0x80 | 126, data.length >> 8, data.length & 0xff]);
        const body = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
        if (!this.sock.destroyed) this.sock.write(Buffer.concat([head, mask, body]));
    }

    send(text) {
        this.frame(1, text);
    }

    close(code) {
        const p = Buffer.alloc(2);
        p.writeUInt16BE(code);
        this.frame(8, p);
    }

    async until(n, ms = 5000) {
        const end = Date.now() + ms;
        while (this.frames.length < n && !this.ended && Date.now() < end) await sleep(5);
    }

    /** Waits until nothing new arrives for `quiet` ms, then hands over what came. */
    async settle(quiet = 300) {
        let last = -1;
        while (this.frames.length + (this.ended ? 1000 : 0) !== last) {
            last = this.frames.length + (this.ended ? 1000 : 0);
            await sleep(quiet);
        }
        const f = this.frames.map((x) => {
            if (x.text === undefined) return x;
            const i = x.text.search(/[[{"]/);
            if (i < 0) return x;
            try {
                return { ...x, text: undefined, p: x.text.slice(0, i), d: JSON.parse(x.text.slice(i)) };
            } catch {
                return x;
            }
        });
        this.frames = [];
        return { frames: f, ended: this.ended };
    }
}

/** One app's life on the socket: handshake, auth, an acked call, the heartbeat, and its way of closing. */
async function app(t, name, lines, auth, { heartbeat, goodbye, record = true }) {
    const out = {};
    const w = await Wire.open(t.base, lines);
    out.upgrade = w.head;
    out.open = await w.settle();
    w.send('40' + JSON.stringify(auth));
    await w.until(1);
    out.connect = await w.settle();
    w.send('420' + JSON.stringify(['ping']));
    await w.until(1);
    out.ack = await w.settle();
    if (heartbeat) {
        await w.until(1, 20000); // pingInterval 15 s
        out.ping = await w.settle(100);
        w.send('3');
        out.afterPong = await w.settle();
    }
    await goodbye(w);
    out.goodbye = await w.settle(500);
    w.sock.destroy();
    if (record) t.note(name, out);
    return out;
}

export async function scenario(t) {
    const token = await login(t, 1);
    const host = new URL(t.base).host;
    const auth = (client, appState = 'active') => ({ token, clientType: 'user-scoped', happyClient: client, appState });

    // Both heartbeats in parallel, so the 15 s wait is paid once; noted in a fixed order.
    const [i, a] = await Promise.all([
        // SocketIOClient.disconnect(): "41", then URLSessionWebSocketTask.cancel(.normalClosure).
        app(t, 'ios', ios(host), auth('ios/2.0.0'), {
            heartbeat: true,
            record: false,
            goodbye: async (w) => {
                w.send('41');
                w.close(1000);
            },
        }),
        // OkHttp's WebSocket.close(1000, null) without a Socket.IO disconnect first.
        app(t, 'android', android(host), auth('android/2.0.0', 'background'), {
            heartbeat: true,
            record: false,
            goodbye: async (w) => w.close(1000),
        }),
    ]);
    t.note('ios', i);
    t.note('android', a);

    await app(t, 'ios without deflate offer', ios(host, false), auth('ios/2.0.0'), { goodbye: async (w) => w.close(1000) });
    // Android's X-Happy-Client header stands in for a missing happyClient.
    await app(t, 'android header client', android(host), { token, clientType: 'user-scoped' }, { goodbye: async (w) => w.close(1001) });
    // A refused handshake: both apps expect "44{message}" and then close the socket themselves.
    await app(t, 'ios bad token', ios(host), { ...auth('ios/2.0.0'), token: 'not-a-token' }, { goodbye: async () => sleep(1000) });
    // The app goes away without a close frame (killed, network lost).
    await app(t, 'android vanishes', android(host), auth('android/2.0.0'), { goodbye: async (w) => w.sock.destroy() });
}
