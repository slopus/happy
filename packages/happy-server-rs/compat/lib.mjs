// Shared helpers for the differential harness: a recording HTTP client and the
// normalizer that makes two transcripts comparable.
import { createRequire } from 'node:module';
import net from 'node:net';
const require = createRequire(import.meta.url);
export const nacl = require('../../../node_modules/tweetnacl/nacl-fast.js');

export const b64 = (u8) => Buffer.from(u8).toString('base64');

/** Deterministic signing keypair n. */
export function signKey(n) {
    const seed = new Uint8Array(32).fill(n);
    return nacl.sign.keyPair.fromSeed(seed);
}

/** Deterministic box keypair n. */
export function boxKey(n) {
    const sk = new Uint8Array(32).fill(100 + n);
    return nacl.box.keyPair.fromSecretKey(sk);
}

const KEEP_HEADERS = ['content-type', 'content-encoding', 'cache-control', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials', 'location', 'allow', 'x-xss-protection'];

export class Recorder {
    constructor(base) {
        this.base = base;
        this.entries = [];
    }

    async req(name, method, path, { body, headers = {}, raw } = {}) {
        const init = { method, headers: { ...headers } };
        if (raw !== undefined) init.body = raw;
        else if (body !== undefined) {
            init.body = JSON.stringify(body);
            init.headers['content-type'] ??= 'application/json';
        }
        let res;
        try {
            res = await fetch(this.base + path, init);
        } catch (e) {
            this.entries.push({ name, method, path, status: 0, headers: {}, text: 'fetch failed: ' + (e.cause?.code || e.message) });
            return undefined;
        }
        let text;
        try {
            text = await res.text();
        } catch (e) {
            text = 'body failed: ' + (e.cause?.code || e.message);
        }
        const hdrs = {};
        for (const k of KEEP_HEADERS) {
            const v = res.headers.get(k);
            if (v !== null) hdrs[k] = v;
        }
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        this.entries.push({ name, method, path, status: res.status, headers: hdrs, text, json });
        return json === undefined ? text : json;
    }

    /** Sends a hand-written HTTP/1.1 request (for framing fetch() will not produce). */
    async raw(name, request, wait = 1500) {
        const url = new URL(this.base);
        const data = await new Promise((resolve, reject) => {
            const sock = net.connect(Number(url.port), url.hostname, () => sock.write(request));
            const chunks = [];
            sock.on('data', (c) => chunks.push(c));
            sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            sock.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
            setTimeout(() => sock.end(), wait);
        });
        const [head, ...rest] = data.split('\r\n\r\n');
        const lines = head.split('\r\n');
        const status = Number(lines[0].split(' ')[1]);
        const hdrs = {};
        for (const l of lines.slice(1)) {
            const i = l.indexOf(':');
            const k = l.slice(0, i).toLowerCase();
            if (KEEP_HEADERS.includes(k)) hdrs[k] = l.slice(i + 1).trim();
        }
        let text = rest.join('\r\n\r\n');
        if (/transfer-encoding: chunked/i.test(head)) text = text.replace(/^[0-9a-f]+\r\n/i, '').replace(/\r\n0\r\n\r\n$/, '');
        this.entries.push({ name, method: 'RAW', path: '', status, headers: hdrs, text });
    }

    note(name, value) {
        this.entries.push({ name, note: true, json: value });
    }
}

const CUID = /(?<![a-z0-9])c[a-z0-9]{24}(?![a-z0-9])/g;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g;
const MS = /\b1[7-9]\d{11}\b/g;
const RKEY = /"id":"[A-Za-z0-9]{12}"/g;
const SID = /"sid":"[A-Za-z0-9_-]{20}"/g;
const JSID = /\\"sid\\":\\"[A-Za-z0-9_-]{20}\\"/g;
const EIOSID = /([?&]sid=)[A-Za-z0-9_-]{20}/g;

/**
 * Normalizes raw response text: ids are numbered by first use (so the same id
 * must appear in the same places on both sides), tokens, ISO and millisecond
 * timestamps become placeholders. Everything else, including key order and
 * number formatting, must match byte for byte.
 */
export function normalizer() {
    const ids = new Map();
    const idOf = (s) => {
        if (!ids.has(s)) ids.set(s, `<id${ids.size + 1}>`);
        return ids.get(s);
    };
    const text = (t) => String(t).replace(SID, '"sid":"<sid>"').replace(JSID, '\\"sid\\":\\"<sid>\\"').replace(EIOSID, '$1<sid>').replace(RKEY, '"id":"<rkey>"').replace(JWT, '<jwt>').replace(ISO, '<iso>').replace(CUID, idOf).replace(MS, '<ts>').replace(/127\.0\.0\.1:320[12]|localhost:320[12]/g, '<host>');
    return (entry) => {
        const e = { name: entry.name, status: entry.status, headers: entry.headers };
        e.body = entry.note ? text(JSON.stringify(entry.json)) : text(entry.text ?? '');
        return e;
    };
}

/** Compares two transcripts; returns a list of human-readable differences. */
export function compare(a, b) {
    const na = normalizer();
    const nb = normalizer();
    const diffs = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a[i] ? na(a[i]) : undefined;
        const y = b[i] ? nb(b[i]) : undefined;
        const sx = JSON.stringify(x);
        const sy = JSON.stringify(y);
        if (sx !== sy) diffs.push(`#${i} ${(a[i] || b[i]).name}\n  ts: ${sx}\n  rs: ${sy}`);
    }
    return diffs;
}
