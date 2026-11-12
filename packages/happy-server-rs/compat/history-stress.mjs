// History offload against the Rust server alone.
// - stress (shadow): many sessions with burned seqs, duplicate localIds, equal
//   seqs, empty and large content and out-of-order createdAt, paged with tiny
//   caps; every page checked against the database row for row. Then shadow reads,
//   incremental pages, session delete, tampering.
// - crash: kill after each write step, restart, converge.
// - throttle.
// - retain: every v3 page (after/before, limits 1/7/100/500) and v1 compared with
//   the same reads in off mode, during and after deletion; rehydrate (one session,
//   crash, all, again) back to an identical table; the TS server on the rehydrated
//   database (the same reads, then phase1 against the Rust server on a copy);
//   duplicate localIds of deleted rows; session delete.
// - retain-crash: kill inside and after a deletion transaction, restart, converge.
//   node history-stress.mjs [all|stress|crash|throttle|retain|retain-crash]   (run by history-stress.sh)
// HISTORY_S3=1: pages go to the MinIO bucket happy-rs (withminio.sh), the default S3_BUCKET.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Recorder } from './lib.mjs';
import { connected, login } from './phase2.mjs';

const COMPAT = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK;
const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const S3 = process.env.HISTORY_S3 === '1';
const BUCKET = 'happy-rs'; // rsserver.sh: S3_BUCKET=happy plus -rs
// The object key prefix: hex HMAC-SHA256(PBKDF2-SHA512(master secret, label), session id).
const PREFIX_KEY = crypto.pbkdf2Sync(process.env.HANDY_MASTER_SECRET || 'test-master-secret', 'happy history object key', 210000, 64, 'sha512');
const prefixOf = (sid) => crypto.createHmac('sha256', PREFIX_KEY).update(sid).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;

let failures = 0;
function check(cond, what) {
    if (!cond) {
        failures++;
        console.log('  FAIL ' + what);
    }
    return cond;
}

const psql = (db, q) => execFileSync('psql', ['-U', 'postgres', '-d', db, '-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: q + ';', encoding: 'utf8', maxBuffer: 1 << 28 });
const json = (db, q) => JSON.parse(psql(db, `SELECT COALESCE(json_agg(x), '[]') FROM (${q}) x`).trim() || '[]');

let minioClient;
async function minio() {
    if (!minioClient) {
        const require = createRequire(fileURLToPath(new URL('../../happy-server/package.json', import.meta.url)));
        const { Client } = require('minio');
        minioClient = new Client({ endPoint: '127.0.0.1', port: Number(process.env.MINIO_PORT || 9187), useSSL: false, accessKey: 'compatadmin', secretKey: 'compatsecret', region: 'us-east-1' });
    }
    return minioClient;
}

/** Every page object as key → bytes. */
async function objects(db) {
    const out = new Map();
    if (S3) {
        const c = await minio();
        const keys = await new Promise((resolve, reject) => {
            const ks = [];
            const s = c.listObjectsV2(BUCKET, 'history/', true);
            s.on('data', (o) => ks.push(o.name));
            s.on('end', () => resolve(ks));
            s.on('error', reject);
        });
        for (const k of keys) {
            const st = await c.getObject(BUCKET, k);
            const chunks = [];
            for await (const ch of st) chunks.push(ch);
            out.set(k, Buffer.concat(chunks));
        }
    } else {
        const dir = path.join(WORK, `data-${db}`, 'history');
        if (!fs.existsSync(dir)) return out;
        for (const sid of fs.readdirSync(dir)) {
            for (const f of fs.readdirSync(path.join(dir, sid))) {
                // A write in progress (temporary file, renamed into place): see leftoverTmp.
                if (!f.endsWith('.tmp')) out.set(`history/${sid}/${f}`, fs.readFileSync(path.join(dir, sid, f)));
            }
        }
    }
    return out;
}

/** Local store: temporary files of interrupted writes still there. */
function leftoverTmp(db) {
    const dir = path.join(WORK, `data-${db}`, 'history');
    if (S3 || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((p) => fs.readdirSync(path.join(dir, p)).filter((f) => f.endsWith('.tmp')));
}

async function resetBucket() {
    if (!S3) return;
    const c = await minio();
    const all = await objects('');
    if (all.size) await c.removeObjects(BUCKET, [...all.keys()]);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let server;
function start(db, env = {}) {
    const e = {
        ...process.env,
        METRICS_ENABLED: 'true',
        HISTORY_OFFLOAD: 'shadow',
        HISTORY_DB_RETENTION: '1h',
        HISTORY_OFFLOAD_SETTLE: '1s',
        HISTORY_OFFLOAD_INTERVAL: '1s',
        HISTORY_VERIFY_INTERVAL: '1s',
        HISTORY_VERIFY_SAMPLE: '5',
        HISTORY_PAGE_MAX_ROWS: '7',
        HISTORY_PAGE_MAX_BYTES: '4000',
        HISTORY_OFFLOAD_ROWS_PER_SEC: '100000',
        HISTORY_OFFLOAD_CONCURRENCY: '4',
        HISTORY_RETAIN_ROWS_PER_SEC: '100000',
        HISTORY_SCAN_PAUSE: '20ms',
        HAPPY_RS_TEST_HOOKS: '1',
        ...env,
    };
    const log = fs.openSync(path.join(WORK, `hist-${db}.log`), 'a');
    const p = spawn(path.join(COMPAT, 'rsserver.sh'), [db, String(PORT)], { env: e, stdio: ['ignore', log, log] });
    server = { p, exited: new Promise((r) => p.on('exit', (code) => r(code))) };
    return server;
}

async function ready() {
    for (let i = 0; i < 120; i++) {
        try {
            await fetch(BASE + '/');
            return;
        } catch {
            await sleep(250);
        }
    }
    throw new Error('server did not start');
}

async function stop() {
    if (!server) return;
    server.p.kill('SIGTERM');
    await server.exited;
    server = undefined;
}

async function metrics() {
    const text = await (await fetch(`http://127.0.0.1:${PORT + 6000}/metrics`)).text();
    const m = {};
    for (const line of text.split('\n')) {
        const x = line.match(/^(history_\w+?)(?:\{(.*)\})? (\S+)$/);
        if (!x) continue;
        const label = (x[2] || '').split(',').filter((l) => !l.startsWith('app=')).map((l) => l.split('=')[1].replace(/"/g, '')).join(',');
        m[x[1] + (label ? ':' + label : '')] = Number(x[3]);
    }
    return m;
}

/**
 * Waits until the offloader is idle: no pending page and the page count stable
 * across a few sweeps. (The backlog gauge need not reach 0: old rows behind a
 * young one, or behind a bad page, are backlog that stays.)
 */
async function drained(db, { timeout = 120_000 } = {}) {
    const t0 = Date.now();
    let last = -1;
    let stable = 0;
    while (Date.now() - t0 < timeout) {
        await sleep(700);
        const [{ pending, total }] = json(db, `SELECT count(*) FILTER (WHERE "state" = 'pending') AS pending, count(*) AS total FROM "SessionMessagePage"`);
        if (Number(pending) === 0 && Number(total) === last) {
            if (++stable >= 4) return Date.now() - t0;
        } else stable = 0;
        last = Number(total);
    }
    throw new Error('offload did not drain');
}

/** The backlog gauge against the database: old rows past each session's last page. */
async function checkBacklog(db, label, retentionMs = HOUR) {
    await sleep(1500); // one more sweep
    // Old rows past the last page, in sessions whose next row is old.
    const want = Number(psql(db, `WITH l AS (SELECT s."id", COALESCE((SELECT max(p."endSeq") FROM "SessionMessagePage" p WHERE p."sessionId" = s."id"), 0) AS last FROM "Session" s),
        old AS (SELECT m.* FROM "SessionMessage" m JOIN l ON l."id" = m."sessionId" AND m."seq" > l.last)
        SELECT count(*) FROM old m WHERE m."createdAt" < now() AT TIME ZONE 'UTC' - interval '${retentionMs} milliseconds'
          AND (SELECT o."createdAt" FROM old o WHERE o."sessionId" = m."sessionId" ORDER BY o."seq" LIMIT 1) < now() AT TIME ZONE 'UTC' - interval '${retentionMs} milliseconds'`));
    const have = (await metrics()).history_offload_backlog_rows;
    console.log(`  ${label}: backlog gauge ${have}, database ${want}`);
    check(have === want, `${label}: backlog gauge ${have} vs ${want}`);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

let rnd = 12345;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];

function content() {
    const c = [
        () => ({ t: 'encrypted', c: Buffer.from(Array.from({ length: 20 + Math.floor(rand() * 200) }, () => Math.floor(rand() * 256))).toString('base64') }),
        () => ({}),
        () => ({ t: 'encrypted', c: '' }),
        () => ({ c: 'é ü 日本 🎉 "q" \\ \u0001 \n', t: 'encrypted' }),
        () => ({ t: 'x', c: { nested: [1, 2.5, 1e21, -0, null, true], z: 'a' } }),
        () => ({ t: 'encrypted', c: 'L'.repeat(1500 + Math.floor(rand() * 2500)) }), // past the 4000-byte page cap with company
    ];
    return JSON.stringify(pick(c)());
}

const lit = (s) => (s === null ? 'NULL' : `'${s.replace(/'/g, "''")}'`);
const ts = (ms) => `to_timestamp(${ms} / 1000.0) AT TIME ZONE 'UTC'`;

/** Inserts rows: [{seq, localId, content, createdAt, updatedAt}] and sets Session.seq. */
function insert(db, sid, rows) {
    if (!rows.length) return;
    const values = rows.map((r, i) => `('hm${sid.slice(-6)}${r.seq}x${i}${Math.floor(rand() * 1e9)}', ${lit(sid)}, ${lit(r.localId)}, ${r.seq}, ${lit(r.content)}::jsonb, ${ts(r.createdAt)}, ${ts(r.updatedAt)})`);
    for (let i = 0; i < values.length; i += 200) {
        psql(db, `INSERT INTO "SessionMessage" ("id","sessionId","localId","seq","content","createdAt","updatedAt") VALUES ${values.slice(i, i + 200).join(',')}`);
    }
    const max = Math.max(...rows.map((r) => r.seq));
    psql(db, `UPDATE "Session" SET "seq" = GREATEST("seq", ${max}) WHERE "id" = ${lit(sid)}`);
}

/** Synthetic history: burned seqs, equal seqs (one session), out-of-order createdAt. */
function synth(sid, n, { from = 1, now = Date.now(), kind = 'mixed' } = {}) {
    const rows = [];
    let seq = from - 1;
    let t = now - 3 * HOUR - n * 1000;
    for (let i = 0; i < n; i++) {
        seq += rand() < 0.12 ? 2 + Math.floor(rand() * 3) : 1; // burned seqs
        t += Math.floor(rand() * 2000);
        let createdAt = t;
        if (kind === 'mixed' && rand() < 0.05) createdAt = t - Math.floor(rand() * 600_000); // out of order, still old
        if (kind === 'young-hole' && i === Math.floor(n / 2)) createdAt = now - 60_000; // a young row inside old history
        if (kind === 'young') createdAt = now - Math.floor(rand() * 600_000);
        const localId = rand() < 0.6 ? `l-${seq}-${Math.floor(rand() * 1e6)}` : null;
        rows.push({ seq, localId, content: content(), createdAt, updatedAt: createdAt + (rand() < 0.2 ? 1234 : 0) });
        if (kind === 'equal-seq' && i % 5 === 3) rows.push({ seq, localId: null, content: content(), createdAt, updatedAt: createdAt });
    }
    return rows;
}

async function api(db) {
    const t = new Recorder(BASE);
    const token = await login(t, 7);
    const H = { authorization: 'Bearer ' + token };
    return {
        token,
        H,
        session: async (tag) => (await t.req('s', 'POST', '/v1/sessions', { headers: H, body: { tag, metadata: 'm' } })).session.id,
        send: (sid, messages) => t.req('send', 'POST', `/v3/sessions/${sid}/messages`, { headers: H, body: { messages } }),
        get: (sid, q) => t.req('get', 'GET', `/v3/sessions/${sid}/messages${q}`, { headers: H }),
        v1: (sid) => t.req('v1', 'GET', `/v1/sessions/${sid}/messages`, { headers: H }),
        del: (sid) => t.req('del', 'DELETE', `/v1/sessions/${sid}`, { headers: H }),
    };
}

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

const ROWS = `SELECT "id", "seq", "localId", "content"::text AS "content",
    (extract(epoch FROM "createdAt") * 1000)::bigint AS "createdAt", (extract(epoch FROM "updatedAt") * 1000)::bigint AS "updatedAt"
    FROM "SessionMessage"`;

const rowSize = (r) => Buffer.byteLength(r.content) + r.id.length + (r.localId ? Buffer.byteLength(r.localId) : 0) + 96;

/**
 * Every page and object of the database: contiguous verified pages from seq 1,
 * byte-equal to the rows, within the caps, covering exactly the eligible prefix;
 * localIds indexed; no orphan, duplicate or overlapping page.
 */
async function checkAll(db, label, { capRows = 7, capBytes = 4000, retentionMs = HOUR, blocked = [] } = {}) {
    const before = failures;
    const cutoff = Date.now() - retentionMs;
    const pages = json(db, `SELECT * FROM "SessionMessagePage" ORDER BY "sessionId", "startSeq"`);
    const objs = await objects(db);
    const sessions = json(db, `SELECT "id" FROM "Session" ORDER BY "id"`).map((s) => s.id);
    const rows = json(db, `${ROWS} ORDER BY "sessionId", "seq", "id"`.replace('FROM "SessionMessage"', ', "sessionId" FROM "SessionMessage"'));
    const bySession = new Map();
    for (const r of rows) {
        if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
        bySession.get(r.sessionId).push(r);
        delete r.sessionId;
        r.createdAt = Number(r.createdAt);
        r.updatedAt = Number(r.updatedAt);
    }
    const localIds = json(db, `SELECT * FROM "SessionMessageLocalId" ORDER BY "sessionId", "localId"`);
    const keys = new Set(pages.map((p) => p.objectKey));
    check(keys.size === pages.length, `${label}: duplicate object keys`);
    for (const k of objs.keys()) check(keys.has(k), `${label}: orphan object ${k}`);
    for (const p of pages) check(sessions.includes(p.sessionId), `${label}: page of a deleted session ${p.objectKey}`);
    let nPages = 0;
    let nRows = 0;
    for (const sid of sessions) {
        const ps = pages.filter((p) => p.sessionId === sid);
        const rs = bySession.get(sid) || [];
        let next = 1;
        for (const p of ps) {
            nPages++;
            const ok = blocked.includes(sid) ? ['verified', 'bad'] : ['verified'];
            check(ok.includes(p.state), `${label}: ${p.objectKey} is ${p.state}`);
            check(p.startSeq === next, `${label}: ${p.objectKey} starts at ${p.startSeq}, expected ${next}`);
            check(p.objectKey === `history/${prefixOf(sid)}/${p.startSeq}-${p.endSeq}.json.zst` && !p.objectKey.includes(sid), `${label}: key ${p.objectKey}`);
            next = p.endSeq + 1;
            const inRange = rs.filter((r) => r.seq >= p.startSeq && r.seq <= p.endSeq);
            nRows += inRange.length;
            check(inRange.length === p.count && p.count > 0, `${label}: ${p.objectKey} count ${p.count}, db ${inRange.length}`);
            check(inRange.length && inRange[inRange.length - 1].seq === p.endSeq, `${label}: ${p.objectKey} does not end on a row`);
            // The caps cut only between seqs: a page may pass them by the rest of its last seq.
            const lastRun = inRange.filter((r) => r.seq === p.endSeq);
            const head = inRange.slice(0, inRange.length - lastRun.length);
            check(head.length < capRows, `${label}: ${p.objectKey} has ${p.count} rows (cap ${capRows})`);
            if (head.length) check(head.reduce((a, r) => a + rowSize(r), 0) < capBytes, `${label}: ${p.objectKey} over the byte cap`);
            check(inRange.every((r) => r.createdAt < cutoff), `${label}: ${p.objectKey} holds a row inside the window`);
            const b = objs.get(p.objectKey);
            if (!check(b, `${label}: ${p.objectKey} object missing`)) continue;
            check(b.length === p.bytes, `${label}: ${p.objectKey} bytes ${b.length} vs ${p.bytes}`);
            check(createHash(b) === p.sha256, `${label}: ${p.objectKey} sha256`);
            const file = JSON.parse(zlib.zstdDecompressSync(b).toString('utf8'));
            check(file.v === 1 && file.sessionId === sid && file.startSeq === p.startSeq && file.endSeq === p.endSeq, `${label}: ${p.objectKey} header`);
            if (p.state === 'verified') check(JSON.stringify(file.rows) === JSON.stringify(inRange), `${label}: ${p.objectKey} rows differ from the db`);
            check(Math.min(...inRange.map((r) => r.createdAt)) === new Date(p.minCreatedAt + 'Z').getTime(), `${label}: ${p.objectKey} minCreatedAt`);
            check(Math.max(...inRange.map((r) => r.createdAt)) === new Date(p.maxCreatedAt + 'Z').getTime(), `${label}: ${p.objectKey} maxCreatedAt`);
        }
        // The pages cover the whole eligible prefix: the first row past them is young.
        const rest = rs.filter((r) => r.seq >= next);
        if (rest.length && !blocked.includes(sid)) check(rest[0].createdAt >= cutoff - 5000, `${label}: session ${sid} stops at seq ${next} though seq ${rest[0].seq} is old`);
        // localIds of the verified range, and nothing else.
        const verifiedEnd = ps.filter((p) => p.state === 'verified').reduce((a, p) => Math.max(a, p.endSeq), 0);
        const want = rs.filter((r) => r.seq <= verifiedEnd && r.localId !== null).map((r) => `${r.localId}=${r.seq}`).sort();
        const have = localIds.filter((l) => l.sessionId === sid).map((l) => `${l.localId}=${l.seq}`).sort();
        check(JSON.stringify(want) === JSON.stringify(have), `${label}: session ${sid} localIds ${have.length} vs ${want.length}`);
    }
    for (const l of localIds) check(sessions.includes(l.sessionId), `${label}: localId of a deleted session`);
    console.log(`  ${label}: ${sessions.length} sessions, ${nPages} pages, ${nRows} rows paged, ${objs.size} objects, ${localIds.length} localIds: ${failures === before ? 'ok' : failures - before + ' failures'}`);
    return { pages: nPages, rows: nRows };
}

function createHash(b) {
    return crypto.createHash('sha256').update(b).digest('hex');
}

async function freshdb(db) {
    execFileSync(path.join(COMPAT, 'freshdb.sh'), [db], { stdio: 'inherit' });
    fs.rmSync(path.join(WORK, `data-${db}`), { recursive: true, force: true });
    fs.rmSync(path.join(WORK, `hist-${db}.log`), { force: true });
    await resetBucket();
}

function logProblems(db) {
    const log = fs.readFileSync(path.join(WORK, `hist-${db}.log`), 'utf8');
    return log.split('\n').filter((l) => /is bad|is damaged|is missing|shadow read mismatch|shadow read of session|offload of session .* stopped|retain of session .* stopped|offload sweep failed|page verifier failed|pending page .* not finished|rehydrating page/.test(l));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function stress() {
    const db = 'd_hist_stress';
    console.log(`stress (${S3 ? 'MinIO bucket ' + BUCKET : 'local store'})`);
    await freshdb(db);
    // 1. Real writes through the server (offload off): duplicate localIds burn seqs.
    start(db, { HISTORY_OFFLOAD: 'off' });
    await ready();
    const a = await api(db);
    const sids = [];
    for (let i = 0; i < 60; i++) sids.push(await a.session(`hist-${i}`));
    for (const sid of sids.slice(0, 10)) {
        for (let k = 0; k < 6; k++) {
            await a.send(sid, [
                { localId: `a${k}`, content: content() },
                { localId: `b${k}`, content: content() },
                { localId: `a${k}`, content: content() }, // same request: first wins
            ]);
            await a.send(sid, [{ localId: `b${k}`, content: content() }, { localId: `c${k}`, content: content() }]); // b: duplicate, burns a seq
        }
    }
    await stop();
    // Those rows are now three hours old.
    psql(db, `UPDATE "SessionMessage" SET "createdAt" = "createdAt" - interval '3 hours', "updatedAt" = "updatedAt" - interval '3 hours'`);
    // 2. Synthetic history in the other sessions.
    const kinds = new Map();
    for (const [i, sid] of sids.slice(10).entries()) {
        const kind = i === 0 ? 'equal-seq' : i % 9 === 1 ? 'young-hole' : i % 9 === 2 ? 'young' : i % 9 === 3 ? 'empty' : 'mixed';
        kinds.set(sid, kind);
        if (kind !== 'empty') insert(db, sid, synth(sid, 5 + Math.floor(rand() * 90), { kind }));
    }
    const total = Number(psql(db, `SELECT count(*) FROM "SessionMessage"`));
    console.log(`  ${sids.length} sessions, ${total} messages`);
    // 3. Shadow mode drains the backlog.
    start(db);
    await ready();
    console.log(`  drained in ${await drained(db)} ms`);
    let c = await checkAll(db, 'after drain');
    await checkBacklog(db, 'after drain');
    check(c.rows > total / 2, `most rows paged (${c.rows} of ${total})`);
    // 4. Shadow reads: v3 paging both ways at several limits, and v1.
    const m0 = await metrics();
    for (const sid of sids) {
        for (const limit of [1, 7, 100, 500]) {
            let after = 0;
            for (let n = 0; n < 200; n++) {
                const r = await a.get(sid, `?after_seq=${after}&limit=${limit}`);
                if (!r.messages.length) break;
                after = r.messages[r.messages.length - 1].seq;
                if (!r.hasMore) break;
            }
            let before = 1_000_000;
            for (let n = 0; n < 200; n++) {
                const r = await a.get(sid, `?before_seq=${before}&limit=${limit}`);
                if (!r.messages.length) break;
                before = r.messages[r.messages.length - 1].seq;
                if (!r.hasMore) break;
            }
        }
        await a.v1(sid);
    }
    await sleep(1500);
    const m1 = await metrics();
    const shadowOk = (m1['history_shadow_reads_total:ok'] ?? 0) - (m0['history_shadow_reads_total:ok'] ?? 0);
    console.log(`  shadow reads: ${shadowOk} ok, ${m1['history_shadow_reads_total:mismatch'] ?? 0} mismatch, ${m1['history_shadow_reads_total:error'] ?? 0} error; verifier ${m1['history_verifier_checks_total:ok'] ?? 0} ok`);
    check(shadowOk > 500, 'shadow reads compared pages');
    check(!m1['history_shadow_reads_total:mismatch'] && !m1['history_shadow_reads_total:error'], 'no shadow mismatch or error');
    check((m1['history_verifier_checks_total:ok'] ?? 0) > 0 && !m1['history_verifier_checks_total:mismatch'], 'verifier ran clean');
    // 5. New history: old rows past the pages extend them, young rows stay out.
    for (const sid of sids.slice(10, 30)) {
        const top = Number(psql(db, `SELECT "seq" FROM "Session" WHERE "id" = ${lit(sid)}`));
        insert(db, sid, synth(sid, 3 + Math.floor(rand() * 12), { from: top + 1, kind: kinds.get(sid) === 'young' ? 'young' : 'mixed' }));
    }
    // A young row that ages: backdate it and its page follows.
    const hole = sids.slice(10).find((s) => kinds.get(s) === 'young-hole');
    await drained(db);
    c = await checkAll(db, 'after new rows');
    psql(db, `UPDATE "SessionMessage" SET "createdAt" = "createdAt" - interval '2 hours' WHERE "sessionId" = ${lit(hole)} AND "createdAt" > now() AT TIME ZONE 'UTC' - interval '1 hour'`);
    await drained(db);
    await checkAll(db, 'after the young hole aged');
    // 6. Session delete removes pages, objects and localIds.
    const doomed = sids.slice(11, 14);
    for (const sid of doomed) check((await a.del(sid)).success === true, 'delete');
    await sleep(1500);
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "sessionId" IN (${doomed.map(lit).join(',')})`)) === 0, 'deleted sessions have no pages');
    await checkAll(db, 'after session delete');
    // 7. Tampering is caught: a row changed under a verified page (shadow + verifier), then the session stops.
    await stop(); // the verifier now checks every page each second
    start(db, { HISTORY_VERIFY_SAMPLE: '100000' });
    await ready();
    const victim = sids[20];
    const [vrow] = json(db, `SELECT m."id", m."seq" FROM "SessionMessage" m JOIN "SessionMessagePage" p ON p."sessionId" = m."sessionId" AND m."seq" BETWEEN p."startSeq" AND p."endSeq" WHERE m."sessionId" = ${lit(victim)} ORDER BY m."seq" LIMIT 1`);
    psql(db, `UPDATE "SessionMessage" SET "content" = '{"t":"tampered"}' WHERE "id" = ${lit(vrow.id)}`);
    await a.get(victim, '?after_seq=0&limit=500');
    await sleep(3000);
    const m2 = await metrics();
    console.log(`  tampered seq ${vrow.seq}: shadow mismatch ${m2['history_shadow_reads_total:mismatch'] ?? 0}, verifier mismatch ${m2['history_verifier_checks_total:mismatch'] ?? 0}, pages bad ${m2['history_pages_total:bad'] ?? 0}`);
    check(m2['history_shadow_reads_total:mismatch'] >= 1, 'shadow read caught the tampered row');
    for (let i = 0; i < 40 && !m2['history_pages_total:bad']; i++) {
        await sleep(500);
        Object.assign(m2, await metrics());
    }
    check(m2['history_pages_total:bad'] >= 1, 'verifier marked the page bad');
    check(logProblems(db).some((l) => l.includes(`session ${victim}`) && l.includes(`seq ${vrow.seq}`)), 'the mismatch log names the session and seq');
    const before = Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "sessionId" = ${lit(victim)}`));
    const top = Number(psql(db, `SELECT "seq" FROM "Session" WHERE "id" = ${lit(victim)}`));
    insert(db, victim, synth(victim, 20, { from: top + 1 }));
    await sleep(3000);
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "sessionId" = ${lit(victim)}`)) === before, 'a bad page stops its session');
    await stop();
    const problems = logProblems(db).filter((l) => !l.includes(victim));
    check(problems.length === 0, `no other problem in the log (${problems.slice(0, 3).join(' | ')})`);
    // Restore the row so the final check sees the bad page as the only exception.
    return { db, victim };
}

async function crash() {
    console.log(`crash points (${S3 ? 'MinIO' : 'local store'})`);
    for (const point of ['after_pending', 'after_put', 'before_verified', 'after_verify']) {
        const db = `d_hist_crash_${point}`;
        await freshdb(db);
        start(db, { HISTORY_OFFLOAD: 'off' });
        await ready();
        const a = await api(db);
        const sids = [];
        for (let i = 0; i < 4; i++) sids.push(await a.session(`c-${i}`));
        await stop();
        for (const sid of sids) insert(db, sid, synth(sid, 30));
        start(db, { HAPPY_RS_OFFLOAD_CRASH: point });
        const code = await Promise.race([server.exited, sleep(60_000).then(() => 'timeout')]);
        server = undefined;
        const st = json(db, `SELECT "state", count(*) AS n FROM "SessionMessagePage" GROUP BY "state" ORDER BY "state"`).map((r) => `${r.state}=${r.n}`).join(' ');
        const keysBefore = new Map(json(db, `SELECT "id", "objectKey" FROM "SessionMessagePage"`).map((r) => [r.id, r.objectKey]));
        const objs = (await objects(db)).size;
        check(code === 86, `${point}: exit code ${code}`);
        start(db);
        await ready();
        await drained(db);
        const r = await checkAll(db, `${point} (crashed with ${st || 'no pages'}, ${objs} objects) → restart`);
        const dup = json(db, `SELECT a."objectKey" FROM "SessionMessagePage" a JOIN "SessionMessagePage" b ON a."sessionId" = b."sessionId" AND a."id" <> b."id" AND a."startSeq" <= b."endSeq" AND b."startSeq" <= a."endSeq"`);
        check(dup.length === 0, `${point}: overlapping pages`);
        check(r.pages > 0, `${point}: pages written`);
        // Recovery finishes a page under the key its row already has.
        const keysAfter = new Map(json(db, `SELECT "id", "objectKey" FROM "SessionMessagePage"`).map((r) => [r.id, r.objectKey]));
        check([...keysBefore].every(([id, k]) => keysAfter.get(id) === k), `${point}: a page changed its key in recovery`);
        check(new Set(keysAfter.values()).size === keysAfter.size, `${point}: duplicate keys`);
        check(leftoverTmp(db).length === 0, `${point}: temporary files left: ${leftoverTmp(db)}`);
        await stop();
        check(logProblems(db).length === 0, `${point}: problems in the log`);
    }
}

async function throttle() {
    const db = 'd_hist_throttle';
    console.log('throttle');
    await freshdb(db);
    start(db, { HISTORY_OFFLOAD: 'off' });
    await ready();
    const a = await api(db);
    const sids = [];
    for (let i = 0; i < 3; i++) sids.push(await a.session(`t-${i}`));
    await stop();
    for (const sid of sids) insert(db, sid, synth(sid, 200, { kind: 'plain' }));
    const n = Number(psql(db, `SELECT count(*) FROM "SessionMessage"`));
    const t0 = Date.now();
    start(db, { HISTORY_OFFLOAD_ROWS_PER_SEC: '200', HISTORY_PAGE_MAX_ROWS: '50', HISTORY_PAGE_MAX_BYTES: '4194304' });
    await ready();
    await drained(db);
    const secs = (Date.now() - t0) / 1000;
    console.log(`  ${n} rows at 200 rows/s: drained in ${secs.toFixed(1)} s (floor ${((n - 50) / 200).toFixed(1)} s)`);
    check(secs >= (n - 50) / 200, 'the offload is throttled');
    await checkAll(db, 'throttle', { capRows: 50, capBytes: 4194304 });
    await stop();
}


// ---------------------------------------------------------------------------
// Retain
// ---------------------------------------------------------------------------

/** Every SessionMessage row by session, ordered by (seq, id), as the routes see them. */
function dumpRows(db) {
    const rows = json(db, `${ROWS.replace('FROM "SessionMessage"', ', "sessionId" FROM "SessionMessage"')} ORDER BY "sessionId", "seq", "id"`);
    const by = new Map();
    for (const r of rows) {
        const sid = r.sessionId;
        delete r.sessionId;
        r.createdAt = Number(r.createdAt);
        r.updatedAt = Number(r.updatedAt);
        if (!by.has(sid)) by.set(sid, []);
        by.get(sid).push(r);
    }
    return by;
}

/** The whole table, every column, as one hash. */
const tableHash = (db) =>
    psql(db, `SELECT md5(COALESCE(string_agg(concat_ws('|', "id", "sessionId", "seq", "localId", "content"::text, "createdAt", "updatedAt"), E'\n' ORDER BY "id"), '')) FROM "SessionMessage"`).trim();

/** Raw response bodies of every v3 page (after and before, limits 1/7/100/500) and v1, per session. */
async function record(base, H, sids) {
    const out = new Map();
    const get = async (p) => (await fetch(base + p, { headers: H })).text();
    for (const sid of sids) {
        for (const limit of [1, 7, 100, 500]) {
            for (const dir of ['after', 'before']) {
                let cursor = dir === 'after' ? 0 : 1_000_000;
                for (let n = 0; n < 1000; n++) {
                    const path = `/v3/sessions/${sid}/messages?${dir}_seq=${cursor}&limit=${limit}`;
                    const text = await get(path);
                    out.set(path, text);
                    const r = JSON.parse(text);
                    if (!r.messages?.length || !r.hasMore) break;
                    cursor = r.messages[r.messages.length - 1].seq;
                }
            }
        }
        const path = `/v1/sessions/${sid}/messages`;
        out.set(path, await get(path));
    }
    return out;
}

function compareRecords(label, want, have) {
    let same = 0;
    const diffs = [];
    for (const [k, v] of want) {
        if (have.get(k) === v) same++;
        else diffs.push(k);
    }
    for (const k of have.keys()) if (!want.has(k)) diffs.push(k);
    console.log(`  ${label}: ${want.size} reads, ${same} identical, ${diffs.length} different${diffs.length ? ' (' + diffs.slice(0, 3).join(', ') + ')' : ''}`);
    check(diffs.length === 0 && same === want.size, `${label}: reads differ`);
}

/**
 * Pages against the truth (every row there should be, by session): contiguous
 * from seq 1, keyed by the derived prefix, objects equal to the truth; an
 * offloaded page's rows gone from the table, a verified page's all there; table
 * plus offloaded pages = the truth; localIds of the paged ranges; no orphans.
 * `drained`: no verified page past the window is left (blocked sessions aside).
 */
async function checkRetain(db, truth, label, { retentionMs = HOUR, drained = true } = {}) {
    const before = failures;
    const pages = json(db, `SELECT * FROM "SessionMessagePage" ORDER BY "sessionId", "startSeq"`);
    const objs = await objects(db);
    const table = dumpRows(db);
    const localIds = json(db, `SELECT * FROM "SessionMessageLocalId"`);
    const keys = new Set(pages.map((p) => p.objectKey));
    check(keys.size === pages.length, `${label}: duplicate keys`);
    for (const k of objs.keys()) check(keys.has(k), `${label}: orphan object ${k}`);
    const cutoff = Date.now() - retentionMs;
    const n = { offloaded: 0, verified: 0, rowsOut: 0 };
    for (const [sid, rows] of truth) {
        const ps = pages.filter((p) => p.sessionId === sid);
        const inTable = table.get(sid) || [];
        const blocked = ps.some((p) => p.state === 'bad');
        let next = 1;
        const merged = [...inTable];
        for (const p of ps) {
            check(p.startSeq === next, `${label}: page ${sid} ${p.startSeq} starts after a gap`);
            next = p.endSeq + 1;
            check(p.objectKey === `history/${prefixOf(sid)}/${p.startSeq}-${p.endSeq}.json.zst`, `${label}: key of ${sid} ${p.startSeq}`);
            const want = rows.filter((r) => r.seq >= p.startSeq && r.seq <= p.endSeq);
            const b = objs.get(p.objectKey);
            if (!b && p.state === 'pending') {
                // Killed before its PUT: the rows are all still in the table.
                const here = inTable.filter((r) => r.seq >= p.startSeq && r.seq <= p.endSeq);
                check(JSON.stringify(here) === JSON.stringify(want), `${label}: pending page ${sid} ${p.startSeq} lost rows`);
                continue;
            }
            if (!check(b, `${label}: object of ${sid} ${p.startSeq} missing`)) continue;
            check(createHash(b) === p.sha256, `${label}: sha256 of ${sid} ${p.startSeq}`);
            const file = JSON.parse(zlib.zstdDecompressSync(b).toString('utf8'));
            check(JSON.stringify(file.rows) === JSON.stringify(want), `${label}: page ${sid} ${p.startSeq} differs from the truth`);
            const here = inTable.filter((r) => r.seq >= p.startSeq && r.seq <= p.endSeq);
            if (p.state === 'offloaded') {
                n.offloaded++;
                n.rowsOut += want.length;
                check(here.length === 0, `${label}: offloaded page ${sid} ${p.startSeq} still has ${here.length} rows`);
                merged.push(...file.rows);
            } else {
                n.verified++;
                check(JSON.stringify(here) === JSON.stringify(want), `${label}: ${p.state} page ${sid} ${p.startSeq} lost rows`);
                if (drained && p.state === 'verified' && !blocked) {
                    check(new Date(p.maxCreatedAt + 'Z').getTime() >= cutoff, `${label}: verified page ${sid} ${p.startSeq} past the window kept its rows`);
                }
            }
        }
        merged.sort((x, y) => x.seq - y.seq || (x.id < y.id ? -1 : 1));
        check(JSON.stringify(merged) === JSON.stringify(rows), `${label}: session ${sid}: table plus pages differ from the truth`);
        const paged = ps.filter((p) => p.state === 'verified' || p.state === 'offloaded').reduce((a, p) => Math.max(a, p.endSeq), 0);
        const wantL = rows.filter((r) => r.seq <= paged && r.localId !== null).map((r) => `${r.localId}=${r.seq}`).sort();
        const haveL = localIds.filter((l) => l.sessionId === sid).map((l) => `${l.localId}=${l.seq}`).sort();
        check(JSON.stringify(wantL) === JSON.stringify(haveL), `${label}: session ${sid} localIds ${haveL.length} vs ${wantL.length}`);
    }
    for (const p of pages) check(truth.has(p.sessionId), `${label}: page of a deleted session`);
    console.log(`  ${label}: ${pages.length} pages (${n.offloaded} offloaded, ${n.verified} verified), ${n.rowsOut} rows only in pages, ${objs.size} objects: ${failures === before ? 'ok' : failures - before + ' failures'}`);
    return n;
}

/** Waits until nothing is pending and no verified page past the window is left to delete. */
async function retained(db, { timeout = 180_000, retention = '1 hour' } = {}) {
    const t0 = Date.now();
    let stable = 0;
    let last = '';
    while (Date.now() - t0 < timeout) {
        await sleep(700);
        const [r] = json(db, `SELECT count(*) FILTER (WHERE "state" = 'pending') AS pending, count(*) AS total, count(*) FILTER (WHERE "state" = 'offloaded') AS off,
            count(*) FILTER (WHERE "state" = 'verified' AND "maxCreatedAt" < now() AT TIME ZONE 'UTC' - interval '${retention}'
                AND NOT EXISTS (SELECT 1 FROM "SessionMessagePage" b WHERE b."sessionId" = p."sessionId" AND b."state" = 'bad')) AS deletable
            FROM "SessionMessagePage" p`);
        const now = `${r.total}/${r.off}`;
        if (Number(r.pending) === 0 && Number(r.deletable) === 0 && now === last) {
            if (++stable >= 3) return Date.now() - t0;
        } else stable = 0;
        last = now;
    }
    throw new Error('retain did not settle');
}

/** Runs the Rust binary's `rehydrate`; returns [exit code, output]. */
function rehydrateCmd(db, args = [], env = {}) {
    const r = spawnSync(path.join(COMPAT, 'rsserver.sh'), [db, String(PORT)], {
        env: { ...process.env, HAPPY_RS_TEST_HOOKS: '1', RS_COMMAND: ['rehydrate', ...args].join(' '), ...env },
        encoding: 'utf8',
    });
    return [r.status, (r.stdout + r.stderr).trim()];
}

async function seedRetain(db, nApi, nSynth) {
    start(db, { HISTORY_OFFLOAD: 'off' });
    await ready();
    const a = await api(db);
    const sids = [];
    for (let i = 0; i < nApi + nSynth; i++) sids.push(await a.session(`r-${i}`));
    for (const sid of sids.slice(0, nApi)) {
        for (let k = 0; k < 5; k++) {
            await a.send(sid, [{ localId: `a${k}`, content: content() }, { localId: `b${k}`, content: content() }]);
            await a.send(sid, [{ localId: `b${k}`, content: content() }, { localId: `c${k}`, content: content() }]); // b: duplicate
        }
    }
    await stop();
    psql(db, `UPDATE "SessionMessage" SET "createdAt" = "createdAt" - interval '3 hours', "updatedAt" = "updatedAt" - interval '3 hours'`);
    for (const [i, sid] of sids.slice(nApi).entries()) {
        const kind = i % 7 === 1 ? 'young-hole' : i % 7 === 2 ? 'young' : i % 7 === 3 ? 'empty' : 'mixed';
        if (kind !== 'empty') insert(db, sid, synth(sid, 5 + Math.floor(rand() * 80), { kind }));
    }
    return sids;
}

async function retain() {
    const db = 'd_hist_retain';
    console.log(`retain (${S3 ? 'MinIO bucket ' + BUCKET : 'local store'})`);
    await freshdb(db);
    const sids = await seedRetain(db, 8, 32);
    // 1. The reads with every row in Postgres (offload off).
    start(db, { HISTORY_OFFLOAD: 'off' });
    await ready();
    const a = await api(db);
    const baseline = await record(BASE, a.H, sids);
    await stop();
    const truth = dumpRows(db);
    for (const sid of sids) if (!truth.has(sid)) truth.set(sid, []);
    const hash0 = tableHash(db);
    console.log(`  ${sids.length} sessions, ${[...truth.values()].reduce((x, r) => x + r.length, 0)} messages, ${baseline.size} reads recorded in off mode`);
    // 2. Retain, deleting slowly; reads compared while it runs, then all of them.
    start(db, { HISTORY_OFFLOAD: 'retain', HISTORY_RETAIN_ROWS_PER_SEC: '60' });
    await ready();
    let during = 0;
    let duringBad = 0;
    const t0 = Date.now();
    for (let i = 0; Date.now() - t0 < 12_000; i++) {
        const sid = sids[i % sids.length];
        const one = await record(BASE, a.H, [sid]);
        for (const [k, v] of one) {
            during++;
            if (baseline.get(k) !== v) duringBad++;
        }
    }
    const mid = json(db, `SELECT count(*) FILTER (WHERE "state" = 'offloaded') AS off, count(*) AS total FROM "SessionMessagePage"`)[0];
    console.log(`  during deletion (${mid.off} of ${mid.total} pages offloaded after 12 s): ${during} reads, ${duringBad} different`);
    check(during > 0 && duringBad === 0, 'reads during deletion differ from off mode');
    check(Number(mid.off) > 0 && Number(mid.off) < Number(mid.total), 'the comparison ran mid-transition');
    console.log(`  settled in ${await retained(db)} ms more`);
    compareRecords('retain vs off', baseline, await record(BASE, a.H, sids));
    const n = await checkRetain(db, truth, 'after retain');
    check(n.rowsOut > 0, 'rows deleted');
    const m = await metrics();
    console.log(`  metrics: rows deleted ${m.history_rows_deleted_total}, pages offloaded ${m['history_pages_total:offloaded']}, shadow ok ${m['history_shadow_reads_total:ok'] ?? 0} mismatch ${m['history_shadow_reads_total:mismatch'] ?? 0}, blocked ${m.history_sessions_blocked}`);
    check(m.history_rows_deleted_total === n.rowsOut, 'history_rows_deleted_total');
    await stop();
    // 3. Off mode with offloaded pages still merges them.
    start(db, { HISTORY_OFFLOAD: 'off' });
    await ready();
    const some = sids.slice(0, 10);
    const subset = new Map([...baseline].filter(([k]) => some.some((sid) => k.includes(`/${sid}/`))));
    compareRecords('off mode with offloaded pages vs off', subset, await record(BASE, a.H, some));
    await stop();
    // 4. Rehydrate: one session, then a crash inside a page's transaction, then all, then again.
    const one = sids[0];
    let [code, out] = rehydrateCmd(db, ['--session', one]);
    console.log(`  rehydrate --session: exit ${code}: ${out.split('\n').pop()}`);
    check(code === 0, 'rehydrate --session');
    check(JSON.stringify(dumpRows(db).get(one)) === JSON.stringify(truth.get(one)), 'rehydrate --session restored its rows');
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "state" = 'offloaded' AND "sessionId" <> ${lit(one)}`)) > 0, 'rehydrate --session left the others');
    const offBefore = Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "state" = 'offloaded'`));
    [code, out] = rehydrateCmd(db, [], { HAPPY_RS_OFFLOAD_CRASH: 'rehydrate_in_tx' });
    const offAfter = Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "state" = 'offloaded'`));
    console.log(`  rehydrate killed inside a page's transaction: exit ${code}, offloaded pages ${offBefore} → ${offAfter}`);
    check(code === 86 && offAfter === offBefore, 'the crashed page rolled back');
    [code, out] = rehydrateCmd(db);
    console.log(`  rehydrate: exit ${code}: ${out.split('\n').pop()}`);
    check(code === 0, 'rehydrate');
    [code, out] = rehydrateCmd(db);
    console.log(`  rehydrate again: exit ${code}: ${out.split('\n').pop()}`);
    check(code === 0 && out.includes('done: 0 pages'), 'rehydrate is idempotent');
    const hash1 = tableHash(db);
    console.log(`  SessionMessage after the round trip: md5 ${hash1} (before: ${hash0})`);
    check(hash1 === hash0, 'the rehydrated table is identical');
    // 5. The TS server on the rehydrated database: the same reads, then phase1 against the Rust server on a copy.
    const copy = 'd_hist_retain_copy';
    psql('postgres', `DROP DATABASE IF EXISTS "${copy}"`);
    psql('postgres', `CREATE DATABASE "${copy}" TEMPLATE "${db}"`);
    const ts = spawn(path.join(COMPAT, 'tsserver.sh'), [db, '3201'], { env: process.env, stdio: ['ignore', fs.openSync(path.join(WORK, 'hist-ts.log'), 'w'), fs.openSync(path.join(WORK, 'hist-ts.log'), 'a')] });
    const tsExit = new Promise((r) => ts.on('exit', r));
    try {
        for (let i = 0; i < 240; i++) {
            try {
                await fetch('http://127.0.0.1:3201/');
                break;
            } catch {
                await sleep(250);
            }
        }
        const t = new Recorder('http://127.0.0.1:3201');
        const token = await login(t, 7);
        compareRecords('TS server on the rehydrated database vs off', baseline, await record('http://127.0.0.1:3201', { authorization: 'Bearer ' + token }, sids));
        start(copy, { HISTORY_OFFLOAD: 'off' });
        await ready();
        const r = spawnSync('node', [path.join(COMPAT, 'run.mjs'), 'phase1', 'http://127.0.0.1:3201', db, BASE, copy], { env: process.env, encoding: 'utf8' });
        const lines = (r.stdout || '').split('\n');
        const at = lines.findIndex((l) => l.startsWith('phase1:'));
        console.log(`  phase1, TS on the rehydrated database vs Rust on a copy: ${at < 0 ? r.stderr : lines.slice(at, at + 6).join('\n    ')}`);
        check(r.status === 0, 'phase1 on the rehydrated database');
        await stop();
    } finally {
        ts.kill('SIGTERM');
        await tsExit;
    }
    // phase1 wrote to both; the truth is the database from here on, and the pages verified again.
    const truth2 = dumpRows(db);
    // 6. Retain again, then duplicates of deleted rows and a session delete.
    start(db, { HISTORY_OFFLOAD: 'retain' });
    await ready();
    await retained(db);
    await checkRetain(db, truth2, 'retain again');
    const sid = sids[1];
    const old = truth.get(sid).find((r) => r.localId === 'a0');
    check(old && Number(psql(db, `SELECT count(*) FROM "SessionMessage" WHERE "sessionId" = ${lit(sid)} AND "localId" = 'a0'`)) === 0, 'a0 lives only in a page');
    const seq0 = Number(psql(db, `SELECT "seq" FROM "Session" WHERE "id" = ${lit(sid)}`));
    const sent = await a.send(sid, [{ localId: 'a0', content: 'again' }, { localId: 'n1', content: 'new' }]);
    const sentA0 = sent.messages.find((m) => m.localId === 'a0');
    const sentN1 = sent.messages.find((m) => m.localId === 'n1');
    check(JSON.stringify(sentA0) === JSON.stringify({ id: old.id, seq: old.seq, localId: 'a0', createdAt: old.createdAt, updatedAt: old.updatedAt }), `v3 duplicate of a deleted row answers with it (${JSON.stringify(sentA0)})`);
    check(sentN1?.seq === seq0 + 1, 'v3: the new message takes the next seq');
    const again = await a.send(sid, [{ localId: 'a0', content: 'third' }]);
    check(JSON.stringify(again.messages) === JSON.stringify([sentA0]), 'v3 all-duplicate send');
    const rec = new Recorder(BASE);
    const ss = await connected(rec, 'ss', { token: a.token, clientType: 'session-scoped', sessionId: sid });
    ss.emit('message', { sid, message: 'dup', localId: 'b0' }); // a deleted row's localId: burns a seq, writes nothing
    await sleep(500);
    ss.emit('message', { sid, message: 'fresh', localId: 'n2' });
    await sleep(800);
    const seqs = json(db, `SELECT "seq", "localId" FROM "SessionMessage" WHERE "sessionId" = ${lit(sid)} AND "seq" > ${seq0} ORDER BY "seq"`);
    const seq1 = Number(psql(db, `SELECT "seq" FROM "Session" WHERE "id" = ${lit(sid)}`));
    console.log(`  duplicates of deleted rows: v3 a0 → seq ${sentA0?.seq} (original ${old.seq}); new rows ${JSON.stringify(seqs)}; Session.seq ${seq0} → ${seq1}`);
    check(JSON.stringify(seqs) === JSON.stringify([{ seq: seq0 + 1, localId: 'n1' }, { seq: seq0 + 3, localId: 'n2' }]) && seq1 === seq0 + 3, 'socket duplicate burns a seq and writes nothing');
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessage" WHERE "sessionId" = ${lit(sid)} AND "localId" IN ('a0', 'b0')`)) === 0, 'no duplicate row');
    ss.close?.();
    const doomed = sids[2];
    check((await a.del(doomed)).success === true, 'delete');
    await sleep(1500);
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessagePage" WHERE "sessionId" = ${lit(doomed)}`)) === 0, 'deleted session: no pages');
    check(Number(psql(db, `SELECT count(*) FROM "SessionMessageLocalId" WHERE "sessionId" = ${lit(doomed)}`)) === 0, 'deleted session: no localIds');
    check(![...(await objects(db)).keys()].some((k) => k.startsWith(`history/${prefixOf(doomed)}/`)), 'deleted session: no objects');
    const truth3 = new Map(truth2);
    truth3.delete(doomed);
    truth3.set(sid, [...truth2.get(sid), ...dumpRows(db).get(sid).filter((r) => r.seq > seq0)]);
    await checkRetain(db, truth3, 'after duplicates and delete', { drained: false });
    await stop();
    const problems = logProblems(db);
    check(problems.length === 0, `problems in the log (${problems.slice(0, 3).join(' | ')})`);
}

async function retainCrash() {
    console.log(`retain crash points (${S3 ? 'MinIO' : 'local store'})`);
    for (const point of ['retain_in_tx', 'retain_after_commit']) {
        const db = `d_hist_rcrash_${point}`;
        await freshdb(db);
        const sids = await seedRetain(db, 2, 6);
        start(db, { HISTORY_OFFLOAD: 'off' });
        await ready();
        const a = await api(db);
        const baseline = await record(BASE, a.H, sids);
        await stop();
        const truth = dumpRows(db);
        for (const sid of sids) if (!truth.has(sid)) truth.set(sid, []);
        start(db, { HISTORY_OFFLOAD: 'retain', HAPPY_RS_OFFLOAD_CRASH: point });
        const code = await Promise.race([server.exited, sleep(60_000).then(() => 'timeout')]);
        server = undefined;
        const st = json(db, `SELECT "state", count(*) AS n FROM "SessionMessagePage" GROUP BY "state" ORDER BY "state"`).map((r) => `${r.state}=${r.n}`).join(' ');
        check(code === 86, `${point}: exit code ${code}`);
        await checkRetain(db, truth, `${point}: killed with ${st}`, { drained: false });
        start(db, { HISTORY_OFFLOAD: 'retain' });
        await ready();
        await retained(db);
        await checkRetain(db, truth, `${point}: restarted`);
        check(leftoverTmp(db).length === 0, `${point}: temporary files left: ${leftoverTmp(db)}`);
        compareRecords(`${point}: reads vs off`, baseline, await record(BASE, a.H, sids));
        await stop();
        check(logProblems(db).length === 0, `${point}: problems in the log`);
    }
}

const what = process.argv[2] || 'all';
try {
    if (what === 'all' || what === 'stress') await stress();
    if (what === 'all' || what === 'crash') await crash();
    if (what === 'all' || what === 'throttle') await throttle();
    if (what === 'all' || what === 'retain') await retain();
    if (what === 'all' || what === 'retain-crash') await retainCrash();
} finally {
    await stop();
}
console.log(failures ? `history-stress: ${failures} failures` : 'history-stress: ok');
process.exit(failures ? 1 : 0);
