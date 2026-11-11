// Phase 1 scenario: HTTP framework behaviour, auth, account, sessions, messages.
import { b64, nacl, signKey, boxKey } from './lib.mjs';

async function login(t, n, name = 'auth') {
    const kp = signKey(n);
    const challenge = new Uint8Array(32).fill(n + 1);
    const sig = nacl.sign.detached(challenge, kp.secretKey);
    const r = await t.req(name, 'POST', '/v1/auth', { body: { publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(sig) } });
    return { authorization: 'Bearer ' + r.token };
}

async function dumpDb(t, sql, label) {
    for (const [name, q] of [
        ['db accounts', `SELECT "publicKey","seq","settings","settingsVersion" FROM "Account" ORDER BY "publicKey"`],
        ['db sessions', `SELECT "id","tag","seq","metadata","agentState",encode("dataEncryptionKey",'base64') AS dek,"active","projectId" FROM "Session" ORDER BY "tag","metadata"`],
        ['db messages', `SELECT "seq","localId","content" FROM "SessionMessage" ORDER BY "seq"`],
        ['db term', `SELECT "publicKey","supportsV2","response" FROM "TerminalAuthRequest" ORDER BY "publicKey"`],
        ['db acct', `SELECT "publicKey","response" FROM "AccountAuthRequest" ORDER BY "publicKey"`],
    ]) {
        t.note(`${label}: ${name}`, JSON.parse((await sql(`SELECT coalesce(json_agg(t), '[]') FROM (${q}) t`)) || '[]'));
    }
}

export async function scenario(t, { sql }) {
    // Framework behaviour
    await t.req('root', 'GET', '/');
    await t.req('root head', 'HEAD', '/');
    await t.req('health', 'GET', '/health');
    await t.req('404', 'GET', '/nope?x=1&y=%20');
    await t.req('404 post', 'POST', '/nope', { body: {} });
    await t.req('404 trailing slash', 'GET', '/v1/sessions/');
    await t.req('405-less', 'PUT', '/v1/sessions');
    await t.req('preflight', 'OPTIONS', '/v1/sessions', { headers: { origin: 'http://x', 'access-control-request-method': 'POST' } });
    await t.req('bad preflight', 'OPTIONS', '/v1/sessions');
    await t.req('no auth', 'GET', '/v1/sessions');
    await t.req('junk token', 'GET', '/v1/sessions', { headers: { authorization: 'Bearer junk' } });
    await t.req('basic auth', 'GET', '/v1/sessions', { headers: { authorization: 'Basic x' } });
    await t.req('lowercase bearer', 'GET', '/v1/sessions', { headers: { authorization: 'bearer x' } });
    await t.req('validation before auth', 'POST', '/v1/sessions', { body: {} });
    await t.req('auth empty body', 'POST', '/v1/auth', { body: {} });
    await t.req('auth wrong types', 'POST', '/v1/auth', { body: { publicKey: 1, challenge: null, signature: [] } });
    await t.req('auth bad json', 'POST', '/v1/auth', { raw: '{bad json', headers: { 'content-type': 'application/json' } });
    await t.req('auth trailing json', 'POST', '/v1/auth', { raw: '{"a":1} x', headers: { 'content-type': 'application/json' } });
    await t.req('auth empty json', 'POST', '/v1/auth', { raw: '', headers: { 'content-type': 'application/json' } });
    await t.req('auth text/plain', 'POST', '/v1/auth', { raw: 'hello', headers: { 'content-type': 'text/plain' } });
    await t.req('auth form', 'POST', '/v1/auth', { raw: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    await t.req('auth json charset', 'POST', '/v1/auth', { raw: '{}', headers: { 'content-type': 'application/json; charset=utf-8' } });
    await t.req('auth bad b64', 'POST', '/v1/auth', { body: { publicKey: '!!!', challenge: 'a', signature: 'b' } });
    await t.req('auth bad sizes', 'POST', '/v1/auth', { body: { publicKey: 'AAAA', challenge: 'AAAA', signature: 'AAAA' } });
    const kp = signKey(1);
    const ch = new Uint8Array(32).fill(9);
    const badSig = nacl.sign.detached(ch, signKey(2).secretKey);
    await t.req('auth bad signature', 'POST', '/v1/auth', { body: { publicKey: b64(kp.publicKey), challenge: b64(ch), signature: b64(badSig) } });

    const H = await login(t, 1);
    const H2 = await login(t, 2, 'auth user2');
    await login(t, 1, 'auth again');

    // URL and body parsing edge cases
    await t.req('malformed escape param', 'GET', '/v1/sessions/%E0%A4%A/messages', { headers: H });
    await t.req('encoded slash param', 'GET', '/v1/sessions/a%2Fb/messages', { headers: H });
    await t.req('double slash', 'GET', '//v1/sessions', { headers: H });
    await t.req('empty param', 'GET', '/v1/sessions//messages', { headers: H });
    await t.req('empty trailing param', 'DELETE', '/v1/sessions/', { headers: H });
    await t.req('long param', 'GET', '/v1/sessions/' + 'a'.repeat(101) + '/messages', { headers: H });
    await t.req('param 100', 'GET', '/v1/sessions/' + 'a'.repeat(100) + '/messages', { headers: H });
    await t.req('long escaped param', 'GET', '/v1/sessions/' + '%41'.repeat(60) + '/messages', { headers: H });
    await t.req('percent param', 'GET', '/v1/sessions/a%25b%2F%3F/messages', { headers: H });
    await t.req('escaped static', 'GET', '/v1/%73essions', { headers: H });
    await t.req('bad escape in query', 'GET', '/v2/sessions?limit=%zz', { headers: H });
    await t.req('bad escape 404', 'GET', '/nope/%zz?x=1');
    await t.req('overlong utf8', 'GET', '/v1/sessions/%C0%80/messages', { headers: H });
    await t.req('empty query', 'GET', '/v1/sessions?', { headers: H });
    await t.req('case sensitive', 'GET', '/V1/SESSIONS', { headers: H });
    await t.req('head json route', 'HEAD', '/v1/account/settings', { headers: H });
    await t.req('json no space charset', 'POST', '/v1/sessions', { raw: '{"tag":1}', headers: { ...H, 'content-type': 'application/json;charset=utf-8' } });
    await t.req('json upper', 'POST', '/v1/sessions', { raw: '{"tag":1}', headers: { ...H, 'content-type': 'APPLICATION/JSON' } });
    await t.req('jsonx', 'POST', '/v1/sessions', { raw: '{"tag":1}', headers: { ...H, 'content-type': 'application/jsonx' } });
    await t.req('json null', 'POST', '/v1/sessions', { raw: 'null', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('json array', 'POST', '/v1/sessions', { raw: '[]', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('json string', 'POST', '/v1/sessions', { raw: '"x"', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('json proto', 'POST', '/v1/sessions', { raw: '{"__proto__":{"tag":"x"},"metadata":5}', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('json numbers', 'POST', '/v1/account/settings', { raw: '{"settings":"\\u00e9\\ud83d","expectedVersion":1e400}', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('json escape', 'POST', '/v1/account/settings', { raw: '{"settings":"\\x","expectedVersion":0}', headers: { ...H, 'content-type': 'application/json' } });
    await t.raw('body too large', 'POST /v1/auth HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 104857601\r\nConnection: close\r\n\r\n{}');
    await t.raw('body at limit header', 'POST /v1/auth HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    await t.raw('no content-type with body', 'POST /v1/auth HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    await t.raw('chunked json', 'POST /v1/auth HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n');
    await t.raw('chunked no content-type', 'POST /v1/auth HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n');
    await t.req('octet stream', 'POST', '/v1/sessions', { raw: 'abc', headers: { ...H, 'content-type': 'application/octet-stream' } });

    // Terminal auth flow
    const box = boxKey(1);
    await t.req('term req bad key', 'POST', '/v1/auth/request', { body: { publicKey: 'AAAA' } });
    await t.req('term status bad key', 'GET', '/v1/auth/request/status?publicKey=AAAA');
    await t.req('term status missing', 'GET', '/v1/auth/request/status');
    await t.req('term status unknown', 'GET', '/v1/auth/request/status?publicKey=' + encodeURIComponent(b64(boxKey(9).publicKey)));
    await t.req('term req', 'POST', '/v1/auth/request', { body: { publicKey: b64(box.publicKey), supportsV2: true } });
    await t.req('term req again', 'POST', '/v1/auth/request', { body: { publicKey: b64(box.publicKey), supportsV2: false } });
    await t.req('term status pending', 'GET', '/v1/auth/request/status?publicKey=' + encodeURIComponent(b64(box.publicKey)));
    await t.req('term resp no auth', 'POST', '/v1/auth/response', { body: { response: 'r', publicKey: b64(box.publicKey) } });
    await t.req('term resp bad key', 'POST', '/v1/auth/response', { body: { response: 'r', publicKey: 'AAAA' }, headers: H });
    await t.req('term resp unknown', 'POST', '/v1/auth/response', { body: { response: 'r', publicKey: b64(boxKey(8).publicKey) }, headers: H });
    await t.req('term resp', 'POST', '/v1/auth/response', { body: { response: 'resp-1', publicKey: b64(box.publicKey) }, headers: H });
    await t.req('term resp again', 'POST', '/v1/auth/response', { body: { response: 'resp-2', publicKey: b64(box.publicKey) }, headers: H2 });
    await t.req('term status authorized', 'GET', '/v1/auth/request/status?publicKey=' + encodeURIComponent(b64(box.publicKey)));
    const authorized = await t.req('term req authorized', 'POST', '/v1/auth/request', { body: { publicKey: b64(box.publicKey) } });
    await t.req('term token works', 'GET', '/v1/account/settings', { headers: { authorization: 'Bearer ' + authorized.token } });
    await t.req('term req null v2', 'POST', '/v1/auth/request', { body: { publicKey: b64(boxKey(2).publicKey), supportsV2: null } });
    await t.req('term status v2 false', 'GET', '/v1/auth/request/status?publicKey=' + encodeURIComponent(b64(boxKey(2).publicKey)));

    // Account auth flow
    const abox = boxKey(3);
    await t.req('acct req', 'POST', '/v1/auth/account/request', { body: { publicKey: b64(abox.publicKey) } });
    await t.req('acct resp unknown', 'POST', '/v1/auth/account/response', { body: { response: 'x', publicKey: b64(boxKey(7).publicKey) }, headers: H });
    await t.req('acct resp', 'POST', '/v1/auth/account/response', { body: { response: 'acct-resp', publicKey: b64(abox.publicKey) }, headers: H });
    const acct = await t.req('acct req authorized', 'POST', '/v1/auth/account/request', { body: { publicKey: b64(abox.publicKey) } });
    await t.req('acct token works', 'GET', '/v1/account/settings', { headers: { authorization: 'Bearer ' + acct.token } });
    await t.req('acct req bad key', 'POST', '/v1/auth/account/request', { body: { publicKey: 'AAAA' } });

    // Account
    await t.req('profile', 'GET', '/v1/account/profile', { headers: H });
    await t.req('settings', 'GET', '/v1/account/settings', { headers: H });
    await t.req('settings neg', 'POST', '/v1/account/settings', { body: { settings: 'x', expectedVersion: -1 }, headers: H });
    await t.req('settings float', 'POST', '/v1/account/settings', { body: { settings: 'x', expectedVersion: 1.5 }, headers: H });
    await t.req('settings missing', 'POST', '/v1/account/settings', { body: { expectedVersion: 0 }, headers: H });
    await t.req('settings mismatch', 'POST', '/v1/account/settings', { body: { settings: 'x', expectedVersion: 3 }, headers: H });
    await t.req('settings ok', 'POST', '/v1/account/settings', { body: { settings: 's1', expectedVersion: 0 }, headers: H });
    await t.req('settings ok 2', 'POST', '/v1/account/settings', { body: { settings: null, expectedVersion: 1 }, headers: H });
    await t.req('settings after', 'GET', '/v1/account/settings', { headers: H });
    await t.req('settings stale', 'POST', '/v1/account/settings', { body: { settings: 'zz', expectedVersion: 1 }, headers: H });

    // Sessions
    await t.req('sessions empty', 'GET', '/v1/sessions', { headers: H });
    await t.req('create bad project', 'POST', '/v1/sessions', { body: { tag: 't0', metadata: 'm', projectId: 'nope' }, headers: H });
    const s1 = await t.req('create', 'POST', '/v1/sessions', { body: { tag: 't1', metadata: 'm1', agentState: 'ignored', dataEncryptionKey: 'AAEC' }, headers: H });
    await t.req('create same tag', 'POST', '/v1/sessions', { body: { tag: 't1', metadata: 'm2' }, headers: H });
    await t.req('create same tag null project', 'POST', '/v1/sessions', { body: { tag: 't1', metadata: 'm2', projectId: null }, headers: H });
    const s2 = await t.req('create 2', 'POST', '/v1/sessions', { body: { tag: 't2', metadata: 'm', dataEncryptionKey: 'not base64!!' }, headers: H });
    const s3 = await t.req('create 3', 'POST', '/v1/sessions', { body: { tag: 't3', metadata: 'm', dataEncryptionKey: '' }, headers: H });
    await t.req('create other user', 'POST', '/v1/sessions', { body: { tag: 't1', metadata: 'other' }, headers: H2 });
    await t.req('list v1', 'GET', '/v1/sessions', { headers: H });
    await t.req('active', 'GET', '/v2/sessions/active', { headers: H });
    await t.req('active limit', 'GET', '/v2/sessions/active?limit=2', { headers: H });
    await t.req('active limit 0', 'GET', '/v2/sessions/active?limit=0', { headers: H });
    await t.req('active limit big', 'GET', '/v2/sessions/active?limit=501', { headers: H });
    await t.req('active limit float', 'GET', '/v2/sessions/active?limit=1.5', { headers: H });
    await t.req('active limit empty', 'GET', '/v2/sessions/active?limit=', { headers: H });
    await t.req('active limit twice', 'GET', '/v2/sessions/active?limit=1&limit=2', { headers: H });
    const p1 = await t.req('v2 page 1', 'GET', '/v2/sessions?limit=1', { headers: H });
    const p2 = await t.req('v2 page 2', 'GET', '/v2/sessions?limit=1&cursor=' + p1.nextCursor, { headers: H });
    await t.req('v2 page 3', 'GET', '/v2/sessions?limit=5&cursor=' + p2.nextCursor, { headers: H });
    await t.req('v2 bad cursor', 'GET', '/v2/sessions?cursor=bad', { headers: H });
    await t.req('v2 empty cursor', 'GET', '/v2/sessions?cursor=', { headers: H });
    await t.req('v2 bare cursor prefix', 'GET', '/v2/sessions?cursor=cursor_v1_', { headers: H });
    await t.req('v2 changedSince', 'GET', '/v2/sessions?changedSince=1', { headers: H });
    await t.req('v2 changedSince future', 'GET', '/v2/sessions?changedSince=4102444800000', { headers: H });
    await t.req('v2 changedSince 0', 'GET', '/v2/sessions?changedSince=0', { headers: H });
    await t.req('v2 changedSince huge', 'GET', '/v2/sessions?changedSince=9007199254740991', { headers: H });
    await t.req('v2 limit abc', 'GET', '/v2/sessions?limit=abc', { headers: H });
    await t.req('v2 limit 201', 'GET', '/v2/sessions?limit=201', { headers: H });

    // Messages
    const sid = s1.session.id;
    const M = (p) => `/v3/sessions/${sid}/messages${p}`;
    await t.req('v3 send', 'POST', M(''), { body: { messages: [{ content: 'c1', localId: 'l1' }, { content: 'c2', localId: 'l2' }, { content: 'c3', localId: 'l1' }] }, headers: H });
    await t.req('v3 send dup', 'POST', M(''), { body: { messages: [{ content: 'c4', localId: 'l2' }, { content: 'c5', localId: 'l5' }] }, headers: H });
    await t.req('v3 send all dup', 'POST', M(''), { body: { messages: [{ content: 'x', localId: 'l5' }] }, headers: H });
    await t.req('v3 send unicode', 'POST', M(''), { body: { messages: [{ content: 'é\u2028"\\\n\u0001😀', localId: 'u1' }] }, headers: H });
    await t.req('v3 send empty', 'POST', M(''), { body: { messages: [] }, headers: H });
    await t.req('v3 send empty localId', 'POST', M(''), { body: { messages: [{ content: 'x', localId: '' }] }, headers: H });
    await t.req('v3 send extra keys', 'POST', M(''), { body: { messages: [{ content: 'x', localId: 'e1', extra: 1 }], more: true }, headers: H });
    await t.req('v3 send other user', 'POST', M(''), { body: { messages: [{ content: 'x', localId: 'z' }] }, headers: H2 });
    await t.req('v3 send no session', 'POST', '/v3/sessions/nope/messages', { body: { messages: [{ content: 'x', localId: 'z' }] }, headers: H });
    const many = Array.from({ length: 101 }, (_, i) => ({ content: 'm' + i, localId: 'big' + i }));
    await t.req('v3 send 101', 'POST', M(''), { body: { messages: many }, headers: H });
    await t.req('v3 send 100', 'POST', M(''), { body: { messages: many.slice(0, 100) }, headers: H });
    await t.req('v3 get', 'GET', M(''), { headers: H });
    await t.req('v3 get after', 'GET', M('?after_seq=3&limit=2'), { headers: H });
    await t.req('v3 get before', 'GET', M('?before_seq=5&limit=2'), { headers: H });
    await t.req('v3 get before 1', 'GET', M('?before_seq=1'), { headers: H });
    await t.req('v3 get both', 'GET', M('?after_seq=1&before_seq=2'), { headers: H });
    await t.req('v3 get limit 0', 'GET', M('?limit=0'), { headers: H });
    await t.req('v3 get limit 501', 'GET', M('?limit=501'), { headers: H });
    await t.req('v3 get after -1', 'GET', M('?after_seq=-1'), { headers: H });
    await t.req('v3 get before 0', 'GET', M('?before_seq=0'), { headers: H });
    await t.req('v3 get after abc', 'GET', M('?after_seq=abc'), { headers: H });
    await t.req('v3 get after float', 'GET', M('?after_seq=1.5'), { headers: H });
    await t.req('v3 get after empty', 'GET', M('?after_seq='), { headers: H });
    await t.req('v3 get after hex', 'GET', M('?after_seq=0x10&limit=1e1'), { headers: H });
    await t.req('v3 get after int4', 'GET', M('?after_seq=3000000000'), { headers: H });
    await t.req('v3 get before int4', 'GET', M('?before_seq=2147483648'), { headers: H });
    await t.req('v3 get other user', 'GET', M(''), { headers: H2 });
    await t.req('v1 messages', 'GET', `/v1/sessions/${sid}/messages`, { headers: H });
    await t.req('v1 messages 404', 'GET', `/v1/sessions/nope/messages`, { headers: H });
    await t.req('sessions after messages', 'GET', '/v1/sessions', { headers: H });

    // Usage
    const uid = (await sql(`SELECT "id" FROM "Account" ORDER BY "createdAt" LIMIT 1`)).trim();
    await sql(`INSERT INTO "UsageReport" ("id","key","accountId","sessionId","data","createdAt","updatedAt") VALUES
        ('cusage00000000000000000001','k1','${uid}',NULL,'{"tokens":{"total":10,"input":4,"2":1},"cost":{"total":0.1,"input":0.2}}','2025-01-02 03:04:05','2025-01-02 03:04:05'),
        ('cusage00000000000000000002','k2','${uid}',NULL,'{"tokens":{"total":5,"x":"s"},"cost":{"total":0.2}}','2025-01-02 05:04:05','2025-01-02 05:04:05'),
        ('cusage00000000000000000003','k3','${uid}',NULL,'{"tokens":{"total":1},"cost":{"total":0.3}}','2025-01-05 05:04:05','2025-01-05 05:04:05')`);
    await t.req('usage', 'POST', '/v1/usage/query', { body: {}, headers: H });
    await t.req('usage hour', 'POST', '/v1/usage/query', { body: { groupBy: 'hour' }, headers: H });
    await t.req('usage range', 'POST', '/v1/usage/query', { body: { startTime: 1735787045, endTime: 1735800000 }, headers: H });
    await t.req('usage bad group', 'POST', '/v1/usage/query', { body: { groupBy: 'week' }, headers: H });
    await t.req('usage neg', 'POST', '/v1/usage/query', { body: { startTime: -1 }, headers: H });
    await t.req('usage session 404', 'POST', '/v1/usage/query', { body: { sessionId: 'nope' }, headers: H });
    await t.req('usage session', 'POST', '/v1/usage/query', { body: { sessionId: sid }, headers: H });
    await t.req('usage huge time', 'POST', '/v1/usage/query', { body: { startTime: 9007199254740991 }, headers: H });
    await sql(`INSERT INTO "UsageReport" ("id","key","accountId","sessionId","data","createdAt","updatedAt") VALUES
        ('cusage00000000000000000004','k4','${uid}',NULL,'{"cost":{}}','2025-01-06 05:04:05','2025-01-06 05:04:05')`);
    await t.req('usage broken data', 'POST', '/v1/usage/query', { body: {}, headers: H });

    await dumpDb(t, sql, 'before delete');

    // Archive / delete
    await t.req('archive', 'POST', `/v1/sessions/${s2.session.id}/archive`, { headers: H });
    await t.req('archive 404', 'POST', `/v1/sessions/nope/archive`, { headers: H });
    await t.req('archive other user', 'POST', `/v1/sessions/${s2.session.id}/archive`, { headers: H2 });
    await t.req('active after archive', 'GET', '/v2/sessions/active', { headers: H });
    await t.req('delete other user', 'DELETE', `/v1/sessions/${s3.session.id}`, { headers: H2 });
    await t.req('delete', 'DELETE', `/v1/sessions/${s3.session.id}`, { headers: H });
    await t.req('delete again', 'DELETE', `/v1/sessions/${s3.session.id}`, { headers: H });
    await t.req('delete with messages', 'DELETE', `/v1/sessions/${sid}`, { headers: H });
    await t.req('messages after delete', 'GET', M(''), { headers: H });
    await t.req('delete json body', 'DELETE', `/v1/sessions/x`, { raw: '', headers: { ...H, 'content-type': 'application/json' } });
    await t.req('recreate deleted tag', 'POST', '/v1/sessions', { body: { tag: 't1', metadata: 'again' }, headers: H });
    await new Promise((r) => setTimeout(r, 300)); // after-commit work

    await dumpDb(t, sql, 'end');
}
