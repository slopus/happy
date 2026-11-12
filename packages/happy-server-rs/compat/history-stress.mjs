// History offload (HISTORY_OFFLOAD=shadow) against the Rust server alone: many
// sessions with burned seqs, duplicate localIds, equal seqs, empty and large
// content and out-of-order createdAt, paged with tiny caps; every page checked
// against the database row for row. Then shadow reads, incremental pages, session
// delete, tampering, the throttle, and crash points (kill after each write step,
// restart, converge).
//   node history-stress.mjs [all|stress|crash|throttle]   (run by history-stress.sh)
// HISTORY_S3=1: pages go to the private MinIO bucket history-rs (withminio.sh).
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Recorder } from './lib.mjs';
import { login } from './phase2.mjs';

const COMPAT = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.WORK;
const PORT = 3202;
const BASE = `http://127.0.0.1:${PORT}`;
const S3 = process.env.HISTORY_S3 === '1';
const BUCKET = 'history-rs';
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
        if (!(await minioClient.bucketExists(BUCKET))) await minioClient.makeBucket(BUCKET, 'us-east-1'); // private: no policy
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
            for (const f of fs.readdirSync(path.join(dir, sid))) out.set(`history/${sid}/${f}`, fs.readFileSync(path.join(dir, sid, f)));
        }
    }
    return out;
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
        HAPPY_RS_TEST_HOOKS: '1',
        ...(S3 ? { HISTORY_S3_BUCKET: BUCKET } : {}),
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
            check(p.objectKey === `history/${sid}/${p.startSeq}-${p.endSeq}.json.zst`, `${label}: key ${p.objectKey}`);
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
    return require_('node:crypto').createHash('sha256').update(b).digest('hex');
}
const require_ = createRequire(import.meta.url);

async function freshdb(db) {
    execFileSync(path.join(COMPAT, 'freshdb.sh'), [db], { stdio: 'inherit' });
    fs.rmSync(path.join(WORK, `data-${db}`), { recursive: true, force: true });
    fs.rmSync(path.join(WORK, `hist-${db}.log`), { force: true });
    await resetBucket();
}

function logProblems(db) {
    const log = fs.readFileSync(path.join(WORK, `hist-${db}.log`), 'utf8');
    return log.split('\n').filter((l) => /is bad|shadow read mismatch|shadow read of session|offload of session .* stopped|offload sweep failed|page verifier failed|pending page .* not finished/.test(l));
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
    if (S3) {
        // Pages go to HISTORY_S3_BUCKET, not the public S3_BUCKET.
        const leaked = await new Promise((resolve, reject) => {
            const ks = [];
            const st = minioClient.listObjectsV2('happy-rs', 'history/', true);
            st.on('data', (o) => ks.push(o.name));
            st.on('end', () => resolve(ks));
            st.on('error', reject);
        });
        check(leaked.length === 0, `${leaked.length} pages in the public bucket`);
        console.log(`  public bucket happy-rs: ${leaked.length} history objects`);
    }
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
        const objs = (await objects(db)).size;
        check(code === 86, `${point}: exit code ${code}`);
        start(db);
        await ready();
        await drained(db);
        const r = await checkAll(db, `${point} (crashed with ${st || 'no pages'}, ${objs} objects) → restart`);
        const dup = json(db, `SELECT a."objectKey" FROM "SessionMessagePage" a JOIN "SessionMessagePage" b ON a."sessionId" = b."sessionId" AND a."id" <> b."id" AND a."startSeq" <= b."endSeq" AND b."startSeq" <= a."endSeq"`);
        check(dup.length === 0, `${point}: overlapping pages`);
        check(r.pages > 0, `${point}: pages written`);
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

const what = process.argv[2] || 'all';
try {
    if (what === 'all' || what === 'stress') await stress();
    if (what === 'all' || what === 'crash') await crash();
    if (what === 'all' || what === 'throttle') await throttle();
} finally {
    await stop();
}
console.log(failures ? `history-stress: ${failures} failures` : 'history-stress: ok');
process.exit(failures ? 1 : 0);
