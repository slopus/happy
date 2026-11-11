// Phase 3 scenario: the remaining HTTP routes, with socket observers recording
// the updates each route emits.
import { connected, login, step } from './phase2.mjs';
import { startMock } from './mock.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dumpDb(t, sql, label, queries) {
    for (const [name, q] of queries) {
        t.note(`${label}: ${name}`, JSON.parse((await sql(`SELECT coalesce(json_agg(t), '[]') FROM (${q}) t`)) || '[]'));
    }
}

/** An HTTP request whose answer and resulting socket traffic are recorded together. */
function observed(t, clients) {
    return async (name, method, path, opts) => {
        let res;
        // After-commit work is not awaited by the response: allow it a wider quiet window.
        await step(t, name + ' (sockets)', clients, async () => {
            res = await t.req(name, method, path, opts);
        }, { quiet: 500 });
        return res;
    };
}

async function machines(t, sql, H, H2, obs) {
    const r = obs;
    await t.req('machines no auth', 'GET', '/v1/machines');
    await t.req('machine create no auth', 'POST', '/v1/machines', { body: { id: 'x', metadata: 'm' } });
    await t.req('machine create missing metadata', 'POST', '/v1/machines', { headers: H, body: { id: 'x' } });
    await t.req('machine create numeric id', 'POST', '/v1/machines', { headers: H, body: { id: 5, metadata: 'm' } });
    await t.req('machine create null daemonState', 'POST', '/v1/machines', { headers: H, body: { id: 'x', metadata: 'm', daemonState: null } });
    await r('machine create', 'POST', '/v1/machines', { headers: H, body: { id: 'mach-a', metadata: 'meta-a', daemonState: 'ds-a', dataEncryptionKey: 'AAEC' } });
    await r('machine create existing', 'POST', '/v1/machines', { headers: H, body: { id: 'mach-a', metadata: 'other', daemonState: 'other' } });
    await r('machine create empty optionals', 'POST', '/v1/machines', { headers: H, body: { id: 'mach-b', metadata: 'meta-b', daemonState: '', dataEncryptionKey: '' } });
    await r('machine create null dek', 'POST', '/v1/machines', { headers: H, body: { id: 'mach-c', metadata: 'meta-c', dataEncryptionKey: null } });
    await r('machine create lenient base64', 'POST', '/v1/machines', { headers: H, body: { id: 'mach-d', metadata: 'meta-d', dataEncryptionKey: '!!a b=c' } });
    await r('machine id of another account', 'POST', '/v1/machines', { headers: H2, body: { id: 'mach-a', metadata: 'theirs' } });
    await t.req('machines list', 'GET', '/v1/machines', { headers: H });
    await t.req('machines list user2', 'GET', '/v1/machines', { headers: H2 });
    await t.req('machine get', 'GET', '/v1/machines/mach-a', { headers: H });
    await t.req('machine get other user', 'GET', '/v1/machines/mach-a', { headers: H2 });
    await t.req('machine get encoded id', 'GET', '/v1/machines/mach%2Da', { headers: H });
    await t.req('machine get unknown', 'GET', '/v1/machines/nope', { headers: H });
    await r('machine delete unknown', 'DELETE', '/v1/machines/nope', { headers: H });
    await r('machine delete other user', 'DELETE', '/v1/machines/mach-a', { headers: H2 });
}

async function accessKeys(t, sql, H, H2, sid, r) {
    const P = (s, m) => `/v1/access-keys/${s}/${m}`;
    await t.req('access key no auth', 'GET', P(sid, 'mach-a'));
    await t.req('access key unknown session', 'GET', P('nope', 'mach-a'), { headers: H });
    await t.req('access key unknown machine', 'GET', P(sid, 'nope'), { headers: H });
    await t.req('access key other user', 'GET', P(sid, 'mach-a'), { headers: H2 });
    await t.req('access key none', 'GET', P(sid, 'mach-a'), { headers: H });
    await t.req('access key create missing data', 'POST', P(sid, 'mach-a'), { headers: H, body: {} });
    await t.req('access key create unknown session', 'POST', P('nope', 'mach-a'), { headers: H, body: { data: 'k' } });
    await r('access key create', 'POST', P(sid, 'mach-a'), { headers: H, body: { data: 'key-1' } });
    await t.req('access key create again', 'POST', P(sid, 'mach-a'), { headers: H, body: { data: 'key-2' } });
    await t.req('access key get', 'GET', P(sid, 'mach-a'), { headers: H });
    await t.req('access key update negative', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'x', expectedVersion: -1 } });
    await t.req('access key update float', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'x', expectedVersion: 1.5 } });
    await t.req('access key update mismatch', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'x', expectedVersion: 7 } });
    await t.req('access key update', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'key-1b', expectedVersion: 1 } });
    await t.req('access key update stale', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'key-1c', expectedVersion: 1 } });
    await t.req('access key update unknown', 'PUT', P(sid, 'mach-b'), { headers: H, body: { data: 'x', expectedVersion: 0 } });
    await t.req('access key update huge version', 'PUT', P(sid, 'mach-a'), { headers: H, body: { data: 'x', expectedVersion: 1e300 } });
    await t.req('access key second machine', 'POST', P(sid, 'mach-b'), { headers: H, body: { data: 'key-b' } });
}

async function artifacts(t, sql, H, H2, r) {
    const A = '9f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
    const B = 'A0B1C2D3-E4F5-4A6B-9C8D-7E6F5A4B3C2D';
    await t.req('artifacts no auth', 'GET', '/v1/artifacts');
    await t.req('artifacts empty', 'GET', '/v1/artifacts', { headers: H });
    await t.req('artifact create bad uuid', 'POST', '/v1/artifacts', { headers: H, body: { id: 'not-a-uuid', header: 'AA==', body: 'AA==', dataEncryptionKey: 'AA==' } });
    await t.req('artifact create missing body', 'POST', '/v1/artifacts', { headers: H, body: { id: A, header: 'AA==', dataEncryptionKey: 'AA==' } });
    await r('artifact create', 'POST', '/v1/artifacts', { headers: H, body: { id: A, header: 'aGVhZGVy', body: 'Ym9keQ==', dataEncryptionKey: 'a2V5' } });
    await r('artifact create existing', 'POST', '/v1/artifacts', { headers: H, body: { id: A, header: 'eA==', body: 'eA==', dataEncryptionKey: 'eA==' } });
    await r('artifact create other account', 'POST', '/v1/artifacts', { headers: H2, body: { id: A, header: 'eA==', body: 'eA==', dataEncryptionKey: 'eA==' } });
    await r('artifact create short base64', 'POST', '/v1/artifacts', { headers: H, body: { id: B, header: 'ab', body: 'eA==', dataEncryptionKey: 'eA==' } });
    await r('artifact create uppercase uuid', 'POST', '/v1/artifacts', { headers: H, body: { id: B, header: 'aGVsbG8', body: '', dataEncryptionKey: 'eA==' } });
    await t.req('artifacts list', 'GET', '/v1/artifacts', { headers: H });
    await t.req('artifact get', 'GET', '/v1/artifacts/' + A, { headers: H });
    await t.req('artifact get other user', 'GET', '/v1/artifacts/' + A, { headers: H2 });
    await t.req('artifact get unknown', 'GET', '/v1/artifacts/nope', { headers: H });
    const U = '/v1/artifacts/' + A;
    await t.req('artifact update negative', 'POST', U, { headers: H, body: { header: 'eA==', expectedHeaderVersion: -1 } });
    await t.req('artifact update unknown', 'POST', '/v1/artifacts/nope', { headers: H, body: {} });
    await r('artifact update header', 'POST', U, { headers: H, body: { header: 'aDI=', expectedHeaderVersion: 1 } });
    await r('artifact update both mismatch', 'POST', U, { headers: H, body: { header: 'aDM=', expectedHeaderVersion: 1, body: 'YjI=', expectedBodyVersion: 9 } });
    await r('artifact update body mismatch only', 'POST', U, { headers: H, body: { header: 'aDM=', expectedHeaderVersion: 2, body: 'YjI=', expectedBodyVersion: 9 } });
    await r('artifact update body without version', 'POST', U, { headers: H, body: { body: 'YjI=' } });
    await r('artifact update empty', 'POST', U, { headers: H, body: {} });
    await r('artifact update both', 'POST', U, { headers: H, body: { header: 'aDM=', expectedHeaderVersion: 2, body: 'YjI=', expectedBodyVersion: 1 } });
    await r('artifact update bad base64', 'POST', U, { headers: H, body: { body: 'x', expectedBodyVersion: 2 } });
    await r('artifact delete other user', 'DELETE', U, { headers: H2 });
    await r('artifact delete', 'DELETE', U, { headers: H });
    await r('artifact delete again', 'DELETE', U, { headers: H });
}

async function kv(t, H, H2, r) {
    const M = (mutations, headers = H) => ({ headers, body: { mutations } });
    await t.req('kv no auth', 'GET', '/v1/kv');
    await t.req('kv get missing', 'GET', '/v1/kv/a', { headers: H });
    await t.req('kv list empty', 'GET', '/v1/kv', { headers: H });
    await t.req('kv mutate empty', 'POST', '/v1/kv', M([]));
    await t.req('kv mutate missing version', 'POST', '/v1/kv', M([{ key: 'a', value: 'eA==' }]));
    await r('kv create', 'POST', '/v1/kv', M([{ key: 'a', value: 'dmFsdWUtYQ==', version: -1 }, { key: 'b', value: '!!Yg', version: -1 }, { key: 'pre%x', value: 'cA==', version: -1 }, { key: 'pre_y', value: 'cQ==', version: -1 }]));
    await r('kv create empty value', 'POST', '/v1/kv', M([{ key: 'e', value: '', version: -1 }]));
    await r('kv create null value', 'POST', '/v1/kv', M([{ key: 'n', value: null, version: -1 }]));
    await r('kv create existing', 'POST', '/v1/kv', M([{ key: 'a', value: 'eA==', version: -1 }, { key: 'zz', value: 'eA==', version: 3 }]));
    await r('kv float version', 'POST', '/v1/kv', M([{ key: 'f', value: 'eA==', version: 0.5 }]));
    await r('kv duplicate new keys', 'POST', '/v1/kv', M([{ key: 'd', value: 'eA==', version: -1 }, { key: 'd', value: 'eQ==', version: -1 }]));
    await r('kv update bad base64', 'POST', '/v1/kv', M([{ key: 'a', value: 'ab', version: 0 }]));
    await r('kv update and delete', 'POST', '/v1/kv', M([{ key: 'a', value: 'bmV3', version: 0 }, { key: 'b', value: null, version: 0 }]));
    await r('kv stale', 'POST', '/v1/kv', M([{ key: 'a', value: 'eA==', version: 0 }, { key: 'b', value: 'eA==', version: 1 }]));
    await r('kv recreate deleted', 'POST', '/v1/kv', M([{ key: 'b', value: 'Yg==', version: 1 }]));
    await t.req('kv get', 'GET', '/v1/kv/a', { headers: H });
    await t.req('kv get empty bytes', 'GET', '/v1/kv/b', { headers: H });
    await t.req('kv get null', 'GET', '/v1/kv/n', { headers: H });
    await t.req('kv get encoded key', 'GET', '/v1/kv/pre%25x', { headers: H });
    await t.req('kv get other user', 'GET', '/v1/kv/a', { headers: H2 });
    await t.req('kv list', 'GET', '/v1/kv', { headers: H });
    await t.req('kv list prefix', 'GET', '/v1/kv?prefix=pre', { headers: H });
    await t.req('kv list prefix wildcard', 'GET', '/v1/kv?prefix=pre%25', { headers: H });
    await t.req('kv list prefix underscore', 'GET', '/v1/kv?prefix=pre_', { headers: H });
    await t.req('kv list empty prefix', 'GET', '/v1/kv?prefix=&limit=2', { headers: H });
    await t.req('kv list limit 0', 'GET', '/v1/kv?limit=0', { headers: H });
    await t.req('kv list limit x', 'GET', '/v1/kv?limit=x', { headers: H });
    await t.req('kv list limit 1001', 'GET', '/v1/kv?limit=1001', { headers: H });
    await t.req('kv bulk', 'POST', '/v1/kv/bulk', { headers: H, body: { keys: ['a', 'b', 'n', 'zz', 'pre_y'] } });
    await t.req('kv bulk empty', 'POST', '/v1/kv/bulk', { headers: H, body: { keys: [] } });
    await t.req('kv bulk not strings', 'POST', '/v1/kv/bulk', { headers: H, body: { keys: [1] } });
}

async function social(t, sql, H, H2, H3, ids, r) {
    const [u1, u2, u3] = ids;
    await sql(`UPDATE "Account" SET "username" = 'alice', "firstName" = 'Alice', "lastName" = 'A', "avatar" = '{"path":"public/users/a.png","width":10,"height":20,"thumbhash":"th","extra":1}' WHERE "id" = '${u1}'`);
    await sql(`UPDATE "Account" SET "username" = 'Alicia_2', "firstName" = '' WHERE "id" = '${u2}'`);
    await sql(`INSERT INTO "GithubUser" ("id","profile","updatedAt") VALUES ('gh-3','{"login":"octo","bio":"hi","name":"Octo"}',now())`);
    await sql(`UPDATE "Account" SET "githubUserId" = 'gh-3', "avatar" = '{"path":"x/y.jpg"}' WHERE "id" = '${u3}'`);

    await t.req('user no auth', 'GET', '/v1/user/' + u2);
    await t.req('user get', 'GET', '/v1/user/' + u2, { headers: H });
    await t.req('user get github fallback', 'GET', '/v1/user/' + u3, { headers: H });
    await t.req('user get self', 'GET', '/v1/user/' + u1, { headers: H });
    await t.req('user get unknown', 'GET', '/v1/user/nope', { headers: H });
    await t.req('user search missing query', 'GET', '/v1/user/search', { headers: H });
    await t.req('user search', 'GET', '/v1/user/search?query=ali', { headers: H });
    await t.req('user search case', 'GET', '/v1/user/search?query=ALICIA', { headers: H });
    await t.req('user search wildcard', 'GET', '/v1/user/search?query=%25', { headers: H });
    await t.req('user search underscore', 'GET', '/v1/user/search?query=alicia_', { headers: H });
    await t.req('user search empty', 'GET', '/v1/user/search?query=', { headers: H });

    const add = (name, h, uid) => r(name, 'POST', '/v1/friends/add', { headers: h, body: { uid } });
    const rem = (name, h, uid) => r(name, 'POST', '/v1/friends/remove', { headers: h, body: { uid } });
    await t.req('friends add missing uid', 'POST', '/v1/friends/add', { headers: H, body: {} });
    await add('friends add self', H, u1);
    await add('friends add unknown', H, 'nope');
    await rem('friends remove unknown', H, 'nope');
    await add('friends u1 requests u2', H, u2);
    await add('friends u1 requests u2 again', H, u2);
    await t.req('friends list u2 pending', 'GET', '/v1/friends', { headers: H2 });
    await add('friends u2 accepts', H2, u1);
    await t.req('friends list u1', 'GET', '/v1/friends', { headers: H });
    await rem('friends u1 unfriends', H, u2);
    await rem('friends u2 rejects', H2, u1);
    await rem('friends u1 withdraws', H, u2);
    await add('friends u1 requests rejected u2', H, u2);
    await add('friends u3 requests u1', H3, u1);
    await rem('friends remove self', H, u1);
    await t.req('friends list u1 end', 'GET', '/v1/friends', { headers: H });
    await t.req('friends list u3', 'GET', '/v1/friends', { headers: H3 });
    await t.req('user get after', 'GET', '/v1/user/' + u2, { headers: H });

    await t.req('feed no auth', 'GET', '/v1/feed');
    await t.req('feed u1', 'GET', '/v1/feed', { headers: H });
    await t.req('feed u2', 'GET', '/v1/feed', { headers: H2 });
    await t.req('feed limit 1', 'GET', '/v1/feed?limit=1', { headers: H });
    await t.req('feed before', 'GET', '/v1/feed?before=0-2', { headers: H });
    await t.req('feed after', 'GET', '/v1/feed?after=0-1', { headers: H });
    await t.req('feed before and after', 'GET', '/v1/feed?before=0-1&after=0-1', { headers: H });
    await t.req('feed parseInt prefix', 'GET', '/v1/feed?before=0-%203x', { headers: H });
    await t.req('feed negative', 'GET', '/v1/feed?after=0--5', { headers: H });
    await t.req('feed bad cursor', 'GET', '/v1/feed?before=x', { headers: H });
    await t.req('feed NaN cursor', 'GET', '/v1/feed?before=0-abc', { headers: H });
    await t.req('feed empty cursor', 'GET', '/v1/feed?after=0-', { headers: H });
    await t.req('feed huge cursor', 'GET', '/v1/feed?before=0-99999999999999999999', { headers: H });
    await t.req('feed big cursor', 'GET', '/v1/feed?before=0-9007199254740993', { headers: H });
    await t.req('feed limit 0', 'GET', '/v1/feed?limit=0', { headers: H });
    await t.req('feed limit 201', 'GET', '/v1/feed?limit=201', { headers: H });
    await sql(`INSERT INTO "UserFeedItem" ("id","userId","counter","repeatKey","body","updatedAt") VALUES ('cfeedtext00000000000000001','${u1}',100,NULL,'{"text":"hello","kind":"text","x":1}',now())`);
    await t.req('feed text item', 'GET', '/v1/feed?limit=2', { headers: H });
    await sql(`INSERT INTO "UserFeedItem" ("id","userId","counter","repeatKey","body","updatedAt") VALUES ('cfeedbad000000000000000001','${u1}',101,NULL,'{"kind":"other"}',now())`);
    await t.req('feed invalid body', 'GET', '/v1/feed', { headers: H });
}

async function projects(t, sql, H, H2, sid, r) {
    const P = '/v1/projects';
    const bin = (bytes, h = H) => ({ headers: { ...h, 'content-type': 'application/octet-stream' }, raw: bytes });
    await t.req('projects no auth', 'GET', P);
    await t.req('project create missing metadata', 'POST', P, { headers: H, body: { externalId: 'e1' } });
    await t.req('project create empty externalId', 'POST', P, { headers: H, body: { externalId: '', metadata: 'm' } });
    const p1 = await r('project create', 'POST', P, { headers: H, body: { externalId: 'ext-1', metadata: 'meta-1', dataEncryptionKey: 'a2V5' } });
    await r('project create existing', 'POST', P, { headers: H, body: { externalId: 'ext-1', metadata: 'other' } });
    const p2 = await r('project create null dek', 'POST', P, { headers: H, body: { externalId: 'ext-2', metadata: 'meta-2', dataEncryptionKey: null } });
    await r('project create bad dek', 'POST', P, { headers: H, body: { externalId: 'ext-3', metadata: 'meta-3', dataEncryptionKey: 'ab' } });
    await r('project create same external other user', 'POST', P, { headers: H2, body: { externalId: 'ext-1', metadata: 'theirs' } });
    const id1 = p1.id;
    const id2 = p2.id;
    await t.req('projects list', 'GET', P, { headers: H });
    await t.req('projects list ids', 'GET', `${P}?ids=${id2},nope,${id2}`, { headers: H });
    await t.req('projects list empty id', 'GET', `${P}?ids=${id1},`, { headers: H });
    await t.req('projects list too many ids', 'GET', `${P}?ids=${Array.from({ length: 101 }, (_, i) => 'x' + i).join(',')}`, { headers: H });
    await t.req('projects list empty ids param', 'GET', `${P}?ids=`, { headers: H });
    await t.req('projects list changedSince', 'GET', `${P}?changedSince=1`, { headers: H });
    await t.req('projects list changedSince future', 'GET', `${P}?changedSince=99999999999999`, { headers: H });
    await t.req('projects list changedSince huge', 'GET', `${P}?changedSince=9999999999999999`, { headers: H });
    await t.req('projects list changedSince 0', 'GET', `${P}?changedSince=0`, { headers: H });
    await t.req('project get', 'GET', `${P}/${id1}`, { headers: H });
    await t.req('project get other user', 'GET', `${P}/${id1}`, { headers: H2 });
    await t.req('project patch unknown key', 'PATCH', `${P}/${id1}`, { headers: H, body: { metadata: 'x', extra: 1 } });
    await r('project patch mismatch', 'PATCH', `${P}/${id1}`, { headers: H, body: { metadata: 'x', expectedMetadataVersion: 5 } });
    await r('project patch same metadata', 'PATCH', `${P}/${id1}`, { headers: H, body: { metadata: 'meta-1' } });
    await r('project patch nothing', 'PATCH', `${P}/${id1}`, { headers: H, body: {} });
    await r('project patch', 'PATCH', `${P}/${id1}`, { headers: H, body: { metadata: 'meta-1b', expectedMetadataVersion: 1 } });
    await r('project patch without version', 'PATCH', `${P}/${id1}`, { headers: H, body: { metadata: 'meta-1c' } });
    await r('project patch unknown', 'PATCH', `${P}/nope`, { headers: H, body: { metadata: 'x' } });

    await t.req('project upload request bad size', 'POST', `${P}/${id1}/avatar/request-upload`, { headers: H, body: { size: -1 } });
    const up = await t.req('project upload request', 'POST', `${P}/${id1}/avatar/request-upload`, { headers: { ...H, 'x-forwarded-host': 'example.test', 'x-forwarded-proto': 'https' }, body: { size: 3 } });
    await t.req('project upload request host header', 'POST', `${P}/${id1}/avatar/request-upload`, { headers: H, body: { size: 3 } });
    await t.req('project upload request unknown', 'POST', `${P}/nope/avatar/request-upload`, { headers: H, body: { size: 3 } });
    const file = up.ref.slice(up.ref.lastIndexOf('/') + 1);
    await t.req('project upload json body', 'PUT', `${P}/${id1}/avatar/${file}`, { headers: H, body: { a: 1 } });
    await t.req('project upload bad file', 'PUT', `${P}/${id1}/avatar/x.enc`, bin('abc'));
    await t.req('project upload other user', 'PUT', `${P}/${id1}/avatar/${file}`, bin('abc', H2));
    await t.req('project upload', 'PUT', `${P}/${id1}/avatar/${file}`, bin('abc'));
    await t.req('project upload empty', 'PUT', `${P}/${id1}/avatar/00000000-0000-4000-8000-000000000000.enc`, bin(''));
    await t.req('project download before activate', 'GET', `${P}/${id1}/avatar/${file}`, { headers: H });
    await t.req('project request download none', 'POST', `${P}/${id1}/avatar/request-download`, { headers: H });
    await r('project avatar bad ref', 'PATCH', `${P}/${id1}/avatar`, { headers: H, body: { ref: 'projects/x/avatar/' + file, preview: 'pv' } });
    await r('project avatar missing upload', 'PATCH', `${P}/${id1}/avatar`, { headers: H, body: { ref: `projects/${id1}/avatar/11111111-1111-4111-8111-111111111111.enc`, preview: 'pv' } });
    await r('project avatar activate', 'PATCH', `${P}/${id1}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv' } });
    await r('project avatar activate same', 'PATCH', `${P}/${id1}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv' } });
    await t.req('project request download', 'POST', `${P}/${id1}/avatar/request-download`, { headers: H });
    await t.req('project download', 'GET', `${P}/${id1}/avatar/${file}`, { headers: H });
    await t.req('project download other file', 'GET', `${P}/${id1}/avatar/00000000-0000-4000-8000-000000000000.enc`, { headers: H });
    await t.req('project download bad name', 'GET', `${P}/${id1}/avatar/nope`, { headers: H });
    await r('project avatar delete', 'DELETE', `${P}/${id1}/avatar`, { headers: H });
    await r('project avatar delete again', 'DELETE', `${P}/${id1}/avatar`, { headers: H });

    await t.req('session link to project', 'POST', '/v1/sessions', { headers: H, body: { tag: 'proj-linked', metadata: 'm', projectId: id2 } });
    await r('project delete other user', 'DELETE', `${P}/${id2}`, { headers: H2 });
    await r('project delete', 'DELETE', `${P}/${id2}`, { headers: H });
    await r('project delete again', 'DELETE', `${P}/${id2}`, { headers: H });
    await t.req('sessions after project delete', 'GET', '/v1/sessions', { headers: H });
    for (let i = 0; i < 59; i++) await fetch(t.base + `${P}/nope/avatar/request-upload`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{"size":1}' });
    await t.req('project upload rate limit', 'POST', `${P}/${id1}/avatar/request-upload`, { headers: H, body: { size: 3 } });
}

async function sessionFiles(t, sql, H, H2, sid, r) {
    const S = `/v1/sessions/${sid}`;
    const bin = (bytes, h = H) => ({ headers: { ...h, 'content-type': 'application/octet-stream' }, raw: bytes });
    // Session avatars
    await t.req('session avatar request bad id', 'POST', '/v1/sessions/a.b/avatar/request-upload', { headers: H, body: { size: 3 } });
    await t.req('session avatar request size 0', 'POST', `${S}/avatar/request-upload`, { headers: H, body: { size: 0 } });
    await t.req('session avatar request other user', 'POST', `${S}/avatar/request-upload`, { headers: H2, body: { size: 3 } });
    const up = await t.req('session avatar request', 'POST', `${S}/avatar/request-upload`, { headers: H, body: { size: 3 } });
    const file = up.ref.slice(up.ref.lastIndexOf('/') + 1);
    await t.req('session avatar upload bad name', 'PUT', `${S}/avatar/x.enc`, bin('abc'));
    await t.req('session avatar upload empty', 'PUT', `${S}/avatar/${file}`, bin(''));
    await t.req('session avatar upload text', 'PUT', `${S}/avatar/${file}`, { headers: { ...H, 'content-type': 'text/plain' }, raw: 'abc' });
    await t.req('session avatar upload too large', 'PUT', `${S}/avatar/${file}`, bin(Buffer.alloc(10 * 1024 * 1024 + 1)));
    await t.req('session avatar upload', 'PUT', `${S}/avatar/${file}`, bin('abc'));
    await t.req('session avatar upload same bytes', 'PUT', `${S}/avatar/${file}`, bin('abc'));
    await t.req('session avatar upload different bytes', 'PUT', `${S}/avatar/${file}`, bin('abd'));
    await t.req('session avatar request download none', 'POST', `${S}/avatar/request-download`, { headers: H });
    await r('session avatar activate extra key', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv', x: 1 } });
    await r('session avatar activate bad ref', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: 'sessions/other/avatar/' + file, preview: 'pv' } });
    await r('session avatar activate missing', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: `sessions/${sid}/avatar/11111111-1111-4111-8111-111111111111.enc`, preview: 'pv' } });
    await r('session avatar activate', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv' } });
    await r('session avatar activate same', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv' } });
    await r('session avatar activate new preview', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: up.ref, preview: 'pv2' } });
    await t.req('session avatar request download', 'POST', `${S}/avatar/request-download`, { headers: { ...H, host: 'h.example:9' } });
    await t.req('session avatar download', 'GET', `${S}/avatar/${file}`, { headers: H });
    await t.req('session avatar download other', 'GET', `${S}/avatar/00000000-0000-4000-8000-000000000000.enc`, { headers: H });
    await t.req('session with avatar', 'GET', '/v1/sessions', { headers: H });
    await r('session avatar delete', 'DELETE', `${S}/avatar`, { headers: H });
    await r('session avatar delete again', 'DELETE', `${S}/avatar`, { headers: H });
    await r('session avatar delete unknown', 'DELETE', '/v1/sessions/nope/avatar', { headers: H });

    // Attachments
    const A = `${S}/attachments`;
    await t.req('attachment request missing filename', 'POST', `${A}/request-upload`, { headers: H, body: { size: 1 } });
    await t.req('attachment request too large', 'POST', `${A}/request-upload`, { headers: H, body: { filename: 'a', size: 10 * 1024 * 1024 + 1 } });
    await t.req('attachment request negative size', 'POST', `${A}/request-upload`, { headers: H, body: { filename: 'a', size: -5.5 } });
    await t.req('attachment request unknown session', 'POST', '/v1/sessions/nope/attachments/request-upload', { headers: H, body: { filename: 'a', size: 1 } });
    const at = await t.req('attachment request', 'POST', `${A}/request-upload`, { headers: H, body: { filename: 'a.png', size: 3 } });
    const afile = at.ref.slice(at.ref.lastIndexOf('/') + 1);
    await t.req('attachment upload', 'PUT', `${A}/${afile}`, bin('xyz'));
    await t.req('attachment upload text', 'PUT', `${A}/text.enc`, { headers: { ...H, 'content-type': 'text/plain' }, raw: 'héllo' });
    await t.req('attachment upload json object', 'PUT', `${A}/obj.enc`, { headers: H, body: { a: 1 } });
    await t.req('attachment upload json string', 'PUT', `${A}/str.enc`, { headers: H, body: 'abc' });
    await t.req('attachment upload no body', 'PUT', `${A}/none.enc`, { headers: H });
    await t.req('attachment upload traversal', 'PUT', `${A}/..x`, bin('x'));
    await t.req('attachment upload other user', 'PUT', `${A}/${afile}`, bin('x', H2));
    await t.req('attachment download', 'GET', `${A}/${afile}`, { headers: H });
    await t.req('attachment download text', 'GET', `${A}/text.enc`, { headers: H });
    await t.req('attachment download missing', 'GET', `${A}/missing.enc`, { headers: H });
    await t.req('attachment download traversal', 'GET', `${A}/a..b`, { headers: H });
    await t.req('attachment request download', 'POST', `${A}/request-download`, { headers: H, body: { ref: at.ref } });
    await t.req('attachment request download other session', 'POST', `${A}/request-download`, { headers: H, body: { ref: 'sessions/x/attachments/a' } });
    await t.req('attachment request download empty file', 'POST', `${A}/request-download`, { headers: H, body: { ref: `sessions/${sid}/attachments/` } });
    await t.req('attachment request download nested', 'POST', `${A}/request-download`, { headers: H, body: { ref: `sessions/${sid}/attachments/a/b` } });
    await t.req('attachment request download bad body', 'POST', `${A}/request-download`, { headers: H, body: { ref: 5 } });
    await t.req('attachment request download no auth', 'POST', `${A}/request-download`, { body: { ref: at.ref } });
}

/** Expo answers by token: `ok`, `gone` (DeviceNotRegistered), `bad`, `num`, `null`;
 * a token naming a batch mode (`http500`, `badjson`, `nodata`, `strdata`, `extra`) sets the whole answer. */
function expo(mock) {
    mock.route('/exp.host/--/api/v2/push/send', ({ body }) => {
        const tokens = body.map((m) => m.to);
        const has = (s) => tokens.some((x) => x.includes(s));
        if (has('http500')) return { status: 500, json: { errors: [] } };
        if (has('badjson')) return { raw: '{nope' };
        if (has('nodata')) return { json: {} };
        if (has('strdata')) return { json: { data: 'ab' } };
        const tickets = tokens.map((x) =>
            x.includes('gone') ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
                : x.includes('bad') ? { status: 'error', message: 'bad token' }
                : x.includes('num') ? { status: 'error', details: { error: 7 } }
                : x.includes('null') ? null
                : { status: 'ok', id: 'ticket' });
        if (has('extra')) tickets.push({ status: 'error', details: { error: 'DeviceNotRegistered' } });
        return { json: { data: tickets } };
    });
}

async function push(t, sql, H, H2, sid, mock, ui, r) {
    expo(mock);
    const E = (s = sid) => `/v1/sessions/${s}/push-event`;
    const ev = { kind: 'done', title: 'Ready', body: 'It is ready' };
    const tokens = async (H, label) => t.req(label, 'GET', '/v1/push-tokens', { headers: H });
    const setTokens = async (list) => {
        await sql(`DELETE FROM "AccountPushToken"`);
        for (const x of list) await t.req(`register ${x}`, 'POST', '/v1/push-tokens', { headers: H, body: { token: x } });
    };

    await t.req('push tokens no auth', 'GET', '/v1/push-tokens');
    await tokens(H, 'push tokens empty');
    await t.req('push token register missing', 'POST', '/v1/push-tokens', { headers: H, body: {} });
    await t.req('push token register number', 'POST', '/v1/push-tokens', { headers: H, body: { token: 5 } });
    await t.req('push token register', 'POST', '/v1/push-tokens', { headers: H, body: { token: 'ExponentPushToken[ok-1]' } });
    await sleep(5);
    await t.req('push token register again', 'POST', '/v1/push-tokens', { headers: H, body: { token: 'ExponentPushToken[ok-1]' } });
    await t.req('push token register empty', 'POST', '/v1/push-tokens', { headers: H, body: { token: '' } });
    await t.req('push token register user2', 'POST', '/v1/push-tokens', { headers: H2, body: { token: 'ExponentPushToken[ok-1]' } });
    await tokens(H, 'push tokens list');
    t.note('push tokens updatedAt bumped', JSON.parse(await sql(`SELECT json_agg("updatedAt" > "createdAt" ORDER BY "token") FROM "AccountPushToken"`)));
    await t.req('push token delete encoded', 'DELETE', '/v1/push-tokens/' + encodeURIComponent('ExponentPushToken[ok-1]'), { headers: H2 });
    await t.req('push token delete unknown', 'DELETE', '/v1/push-tokens/nope', { headers: H });
    await t.req('push token delete no auth', 'DELETE', '/v1/push-tokens/nope');
    await tokens(H2, 'push tokens user2 after delete');

    await t.req('push event no auth', 'POST', E(), { body: ev });
    await t.req('push event bad kind', 'POST', E(), { headers: H, body: { ...ev, kind: 'other' } });
    await t.req('push event empty title', 'POST', E(), { headers: H, body: { ...ev, title: '' } });
    await t.req('push event long body', 'POST', E(), { headers: H, body: { ...ev, body: 'x'.repeat(501) } });
    await t.req('push event data array', 'POST', E(), { headers: H, body: { ...ev, data: [1] } });
    await t.req('push event data null', 'POST', E(), { headers: H, body: { ...ev, data: null } });
    await r('push event unknown session', 'POST', E('nope'), { headers: H, body: ev });
    await r('push event other user', 'POST', E(), { headers: H2, body: ev });
    const s2 = await t.req('create user2 session', 'POST', '/v1/sessions', { headers: H2, body: { tag: 'push-2', metadata: 'm' } });
    await r('push event no tokens', 'POST', E(s2.session.id), { headers: H2, body: ev });

    await r('push event sent', 'POST', E(), { headers: H, body: { ...ev, kind: 'permission', data: { b: 1, 2: 'x', sessionId: 'override', kind: 'zzz', nested: { z: 1, a: 2 } } } });
    for (const [label, list] of [
        ['partial', ['ExponentPushToken[ok-2]', 'ExponentPushToken[gone-1]', 'ExponentPushToken[bad-1]']],
        ['all gone', ['ExponentPushToken[gone-2]', 'ExponentPushToken[num-1]']],
        ['null ticket', ['ExponentPushToken[null-1]']],
        ['extra ticket', ['ExponentPushToken[ok-3]', 'ExponentPushToken[extra]']],
        ['http 500', ['ExponentPushToken[ok-4]', 'ExponentPushToken[http500]']],
        ['bad json', ['ExponentPushToken[badjson]']],
        ['no data', ['ExponentPushToken[nodata]']],
        ['string data', ['ExponentPushToken[strdata]']],
    ]) {
        await setTokens(list);
        await t.req(`push event ${label}`, 'POST', E(), { headers: H, body: { ...ev, kind: 'question' } });
        await sleep(200);
        t.note(`push tokens after ${label}`, JSON.parse(await sql(`SELECT coalesce(json_agg("token" ORDER BY "token"), '[]') FROM "AccountPushToken"`)));
    }
    await setTokens(['ExponentPushToken[ok-5]']);
    await t.req('push tokens order', 'GET', '/v1/push-tokens', { headers: H });

    // 205 tokens: three Expo batches.
    await sql(`DELETE FROM "AccountPushToken"`);
    await sql(`INSERT INTO "AccountPushToken" ("id","accountId","token","updatedAt") SELECT 'tok' || lpad(g::text, 4, '0'), (SELECT "accountId" FROM "Session" WHERE "id" = '${sid}'), 'ExponentPushToken[ok-many-' || lpad(g::text, 3, '0') || ']', now() FROM generate_series(0, 204) g`);
    await t.req('push event batched', 'POST', E(), { headers: H, body: ev });

    await setTokens(['ExponentPushToken[ok-6]']);
    ui.send('42' + JSON.stringify(['app-state', { state: 'active' }]));
    await sleep(100);
    await r('push event suppressed', 'POST', E(), { headers: H, body: ev });
    ui.send('42' + JSON.stringify(['app-state', { state: 'background' }]));
    await sleep(100);
    await r('push event after background', 'POST', E(), { headers: H, body: ev });
    ui.send('42' + JSON.stringify(['app-state', 'active']));
    await sleep(100);
    await r('push event app-state string', 'POST', E(), { headers: H, body: ev });
}

async function version(t) {
    const V = (name, platform, version) => t.req(name, 'POST', '/v1/version', { body: { platform, version, app_id: 'x' } });
    await t.req('version missing app_id', 'POST', '/v1/version', { body: { platform: 'ios', version: '1.0.0' } });
    for (const [p, v] of [
        ['ios', '1.4.1'], ['ios', '1.4.0'], ['IOS', '2.0.0'], ['android', '1.3.9'], ['Android', 'v1.5.0'], ['ios', ' 1.5.0 '],
        ['ios', '1.5.0-beta.1'], ['ios', '1.5.0+build.7'], ['ios', '01.5.0'], ['ios', '1.5'], ['ios', 'vv1.5.0'], ['ios', '=1.5.0'],
        ['ios', ''], ['ios', '99999999999999999.0.0'], ['ios', '1.٥.0'], ['web', '0.0.1'], ['ios', 'x'.repeat(300)],
    ]) await V(`version ${p} ${JSON.stringify(v).slice(0, 20)}`, p, v);
    await t.req('dev log route disabled', 'POST', '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', { body: {} });
}

export async function scenario(t, { sql }) {
    const mock = await startMock(t);
    const token = await login(t, 1);
    const token2 = await login(t, 2, 'auth user2');
    const H = { authorization: 'Bearer ' + token };
    const H2 = { authorization: 'Bearer ' + token2 };
    const s1 = await t.req('create s1', 'POST', '/v1/sessions', { headers: H, body: { tag: 't1', metadata: 'meta-1' } });
    const sid = s1.session.id;

    const token3 = await login(t, 3, 'auth user3');
    const H3 = { authorization: 'Bearer ' + token3 };
    const sub = (tok) => JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub;
    const ids = [token, token2, token3].map(sub);

    const ui = await connected(t, 'ui', { token, clientType: 'user-scoped' });
    const ui2 = await connected(t, 'ui2', { token: token2, clientType: 'user-scoped' });
    const ui3 = await connected(t, 'ui3', { token: token3, clientType: 'user-scoped' });
    const daemon = await connected(t, 'daemon', { token, clientType: 'machine-scoped', machineId: 'mach-a' });
    const obs = observed(t, [ui, ui2, daemon]);

    await machines(t, sql, H, H2, obs);
    await accessKeys(t, sql, H, H2, sid, obs);
    await artifacts(t, sql, H, H2, obs);
    await kv(t, H, H2, obs);
    await social(t, sql, H, H2, H3, ids, observed(t, [ui, ui2, ui3]));
    await projects(t, sql, H, H2, sid, obs);
    await sessionFiles(t, sql, H, H2, sid, obs);
    await version(t);
    await push(t, sql, H, H2, sid, mock, ui, obs);

    await dumpDb(t, sql, 'before deletes', [
        ['machines', `SELECT "id","metadata","metadataVersion","daemonState","daemonStateVersion",encode("dataEncryptionKey",'base64') AS dek,"seq","active" FROM "Machine" ORDER BY "id"`],
        ['access keys', `SELECT "machineId","data","dataVersion","createdAt" <= "updatedAt" AS ordered FROM "AccessKey" ORDER BY "machineId"`],
        ['artifacts', `SELECT "id",encode("header",'base64') AS h,"headerVersion",encode("body",'base64') AS b,"bodyVersion",encode("dataEncryptionKey",'base64') AS k,"seq" FROM "Artifact" ORDER BY "id"`],
        ['accounts', `SELECT "publicKey","seq","feedSeq" FROM "Account" ORDER BY "publicKey"`],
        ['kv', `SELECT "key",encode("value",'base64') AS v,"version" FROM "UserKVStore" ORDER BY "key"`],
        ['relationships', `SELECT a."publicKey" AS "from", b."publicKey" AS "to", r."status", r."acceptedAt" IS NOT NULL AS accepted, r."lastNotifiedAt" IS NOT NULL AS notified FROM "UserRelationship" r JOIN "Account" a ON a."id" = r."fromUserId" JOIN "Account" b ON b."id" = r."toUserId" ORDER BY 1, 2`],
        ['feed', `SELECT a."publicKey", f."counter", f."repeatKey", f."body" FROM "UserFeedItem" f JOIN "Account" a ON a."id" = f."userId" ORDER BY 1, 2`],
        ['projects', `SELECT "externalId","metadata","metadataVersion",encode("dataEncryptionKey",'base64') AS dek,"avatarRef" IS NOT NULL AS has_avatar,"avatarPreview","avatarVersion","seq" FROM "Project" ORDER BY "externalId","metadata"`],
        ['sessions', `SELECT "tag","projectId" FROM "Session" ORDER BY "tag"`],
    ]);
    await obs('machine delete', 'DELETE', '/v1/machines/mach-a', { headers: H });
    await t.req('machine get after delete', 'GET', '/v1/machines/mach-a', { headers: H });
    await t.req('access key after machine delete', 'GET', `/v1/access-keys/${sid}/mach-a`, { headers: H });
    await dumpDb(t, sql, 'end', [
        ['machines', `SELECT "id" FROM "Machine" ORDER BY "id"`],
        ['access keys', `SELECT "machineId","data" FROM "AccessKey" ORDER BY "machineId"`],
        ['accounts', `SELECT "publicKey","seq" FROM "Account" ORDER BY "publicKey"`],
    ]);
    for (const c of [ui, ui2, ui3, daemon]) c.close();
    await mock.close();
}
