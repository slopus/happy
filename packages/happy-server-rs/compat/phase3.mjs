// Phase 3 scenario: the remaining HTTP routes, with socket observers recording
// the updates each route emits.
import { connected, login, step } from './phase2.mjs';

async function dumpDb(t, sql, label, queries) {
    for (const [name, q] of queries) {
        t.note(`${label}: ${name}`, JSON.parse((await sql(`SELECT coalesce(json_agg(t), '[]') FROM (${q}) t`)) || '[]'));
    }
}

/** An HTTP request whose answer and resulting socket traffic are recorded together. */
function observed(t, clients) {
    return async (name, method, path, opts) => {
        let res;
        await step(t, name + ' (sockets)', clients, async () => {
            res = await t.req(name, method, path, opts);
        });
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

export async function scenario(t, { sql }) {
    const token = await login(t, 1);
    const token2 = await login(t, 2, 'auth user2');
    const H = { authorization: 'Bearer ' + token };
    const H2 = { authorization: 'Bearer ' + token2 };
    const s1 = await t.req('create s1', 'POST', '/v1/sessions', { headers: H, body: { tag: 't1', metadata: 'meta-1' } });
    const sid = s1.session.id;

    const ui = await connected(t, 'ui', { token, clientType: 'user-scoped' });
    const ui2 = await connected(t, 'ui2', { token: token2, clientType: 'user-scoped' });
    const daemon = await connected(t, 'daemon', { token, clientType: 'machine-scoped', machineId: 'mach-a' });
    const obs = observed(t, [ui, ui2, daemon]);

    await machines(t, sql, H, H2, obs);
    await accessKeys(t, sql, H, H2, sid, obs);
    await artifacts(t, sql, H, H2, obs);

    await dumpDb(t, sql, 'before deletes', [
        ['machines', `SELECT "id","metadata","metadataVersion","daemonState","daemonStateVersion",encode("dataEncryptionKey",'base64') AS dek,"seq","active" FROM "Machine" ORDER BY "id"`],
        ['access keys', `SELECT "machineId","data","dataVersion","createdAt" <= "updatedAt" AS ordered FROM "AccessKey" ORDER BY "machineId"`],
        ['artifacts', `SELECT "id",encode("header",'base64') AS h,"headerVersion",encode("body",'base64') AS b,"bodyVersion",encode("dataEncryptionKey",'base64') AS k,"seq" FROM "Artifact" ORDER BY "id"`],
        ['accounts', `SELECT "publicKey","seq" FROM "Account" ORDER BY "publicKey"`],
    ]);
    await obs('machine delete', 'DELETE', '/v1/machines/mach-a', { headers: H });
    await t.req('machine get after delete', 'GET', '/v1/machines/mach-a', { headers: H });
    await t.req('access key after machine delete', 'GET', `/v1/access-keys/${sid}/mach-a`, { headers: H });
    await dumpDb(t, sql, 'end', [
        ['machines', `SELECT "id" FROM "Machine" ORDER BY "id"`],
        ['access keys', `SELECT "machineId","data" FROM "AccessKey" ORDER BY "machineId"`],
        ['accounts', `SELECT "publicKey","seq" FROM "Account" ORDER BY "publicKey"`],
    ]);
    for (const c of [ui, ui2, daemon]) c.close();
}
