// S3 mode against a real MinIO (run under withminio.sh): presigned POST policies,
// presigned GETs and the attachment 302 are used for real, so MinIO judges every
// signature; uploads through the GitHub avatar path; cleanup on delete.
import { login } from './phase2.mjs';
import { startMock } from './mock.mjs';
import * as connect from './phase3-connect.mjs';
import { minio } from './minio-init.mjs';

/** Signatures, dates and per-server bucket names vary; MinIO checks them instead. */
export const normalize = (s) => s
    .replace(/happy-(ts|rs)/g, 'happy-<side>')
    .replace(/\d{8}T\d{6}Z/g, '<amzdate>')
    .replace(/\d{8}(%2F|\/)us-east-1/g, '<day>$1us-east-1')
    .replace(/(X-Amz-Signature=|x-amz-signature\\*":\\*")[0-9a-f]{64}/g, '$1<sig>')
    .replace(/(policy\\*":\\*")[A-Za-z0-9+/=]+/g, '$1<policy>')
    .replace(/(thumbhash\\*":\\*")[A-Za-z0-9+/=]+/g, '$1<thumbhash>'); // QUIRKS deviation 15

const xmlCode = (text) => (text.match(/<Code>([^<]*)/) || [])[1] || null;

async function s3post(t, name, up, bytes) {
    const form = new FormData();
    for (const [k, v] of Object.entries(up.formFields || {})) form.append(k, v);
    form.append('file', new Blob([bytes]));
    const r = await fetch(up.uploadUrl, { method: 'POST', body: form });
    t.note(`minio: ${name}`, { status: r.status, code: xmlCode(await r.text()) });
}

async function s3get(t, name, url) {
    const r = await fetch(url, { redirect: 'manual' });
    const text = await r.text();
    t.note(`minio: ${name}`, { status: r.status, body: r.status === 200 ? text : xmlCode(text) });
}

function policyNote(t, name, up) {
    if (!up?.formFields?.policy) return t.note(`policy: ${name}`, null);
    t.note(`policy: ${name}`, { fields: Object.keys(up.formFields), policy: JSON.parse(Buffer.from(up.formFields.policy, 'base64').toString()) });
}

async function listBucket(t, side, label) {
    const keys = [];
    for await (const o of minio().listObjectsV2(`happy-${side}`, '', true)) keys.push(o.name);
    t.note(`bucket ${label}`, keys.sort());
}

export async function scenario(t, { side }) {
    const mock = await startMock(t);
    await connect.routes(mock);
    const token = await login(t, 1);
    const H = { authorization: 'Bearer ' + token };
    const H2 = { authorization: 'Bearer ' + (await login(t, 2, 'auth user2')) };
    const s = await t.req('create session', 'POST', '/v1/sessions', { headers: H, body: { tag: 's3', metadata: 'm' } });
    const sid = s.session.id;
    const S = `/v1/sessions/${sid}`;

    // Attachments: presigned POST (0..10 MiB), presigned GET, 302.
    const at = await t.req('attachment request', 'POST', `${S}/attachments/request-upload`, { headers: H, body: { filename: 'a.bin', size: 5 } });
    policyNote(t, 'attachment', at);
    await s3post(t, 'attachment upload', at, 'hello');
    await t.req('attachment direct PUT', 'PUT', `${S}/attachments/x.enc`, { headers: { ...H, 'content-type': 'application/octet-stream' }, raw: 'x' });
    const dl = await t.req('attachment request download', 'POST', `${S}/attachments/request-download`, { headers: H, body: { ref: at.ref } });
    await s3get(t, 'attachment presigned GET', dl.downloadUrl);
    const file = at.ref.slice(at.ref.lastIndexOf('/') + 1);
    await t.req('attachment GET (302)', 'GET', `${S}/attachments/${file}`, { headers: H });
    const loc = t.entries[t.entries.length - 1].headers.location;
    if (loc) await s3get(t, 'attachment 302 target', loc);
    await t.req('attachment GET missing (302)', 'GET', `${S}/attachments/missing.enc`, { headers: H });
    const loc2 = t.entries[t.entries.length - 1].headers.location;
    if (loc2) await s3get(t, 'attachment 302 target missing', loc2);
    const big = await t.req('attachment request 2', 'POST', `${S}/attachments/request-upload`, { headers: H, body: { filename: 'b', size: 10 } });
    await s3post(t, 'attachment upload over the policy limit', big, Buffer.alloc(10 * 1024 * 1024 + 1));
    await s3post(t, 'attachment upload to another key', { ...big, formFields: { ...big.formFields, key: `sessions/${sid}/attachments/other.enc` } }, 'x');

    // Session avatar: presigned POST (1..), stat on activate, presigned GET.
    const sa = await t.req('session avatar request', 'POST', `${S}/avatar/request-upload`, { headers: H, body: { size: 3 } });
    policyNote(t, 'session avatar', sa);
    await t.req('session avatar activate before upload', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: sa.ref, preview: 'pv' } });
    await s3post(t, 'session avatar empty upload', sa, '');
    await s3post(t, 'session avatar upload', sa, 'abc');
    await t.req('session avatar direct PUT', 'PUT', `${S}/avatar/${sa.ref.slice(sa.ref.lastIndexOf('/') + 1)}`, { headers: { ...H, 'content-type': 'application/octet-stream' }, raw: 'abc' });
    await t.req('session avatar activate', 'PATCH', `${S}/avatar`, { headers: H, body: { ref: sa.ref, preview: 'pv' } });
    const sd = await t.req('session avatar request download', 'POST', `${S}/avatar/request-download`, { headers: H });
    if (sd?.downloadUrl) await s3get(t, 'session avatar presigned GET', sd.downloadUrl);
    await t.req('session avatar direct GET', 'GET', `${S}/avatar/x.enc`, { headers: H });

    // Project avatar.
    const p = await t.req('project create', 'POST', '/v1/projects', { headers: H, body: { externalId: 'p-s3', metadata: 'm' } });
    const P = `/v1/projects/${p.project?.id ?? p.id}`;
    const pa = await t.req('project avatar request', 'POST', `${P}/avatar/request-upload`, { headers: H, body: { size: 3 } });
    policyNote(t, 'project avatar', pa);
    await t.req('project avatar activate before upload', 'PATCH', `${P}/avatar`, { headers: H, body: { ref: pa.ref, preview: 'pv' } });
    await s3post(t, 'project avatar upload', pa, 'png');
    await t.req('project avatar activate', 'PATCH', `${P}/avatar`, { headers: H, body: { ref: pa.ref, preview: 'pv' } });
    const pd = await t.req('project avatar request download', 'POST', `${P}/avatar/request-download`, { headers: H });
    if (pd?.downloadUrl) await s3get(t, 'project avatar presigned GET', pd.downloadUrl);
    await t.req('project avatar direct PUT', 'PUT', `${P}/avatar/x.enc`, { headers: { ...H, 'content-type': 'application/octet-stream' }, raw: 'x' });
    await t.req('project avatar direct GET', 'GET', `${P}/avatar/x.enc`, { headers: H });
    await t.req('files route in S3 mode', 'GET', '/files/public/x.png');

    // GitHub avatar: putObject, then the public URL read anonymously.
    const params = await t.req('github params', 'GET', '/v1/connect/github/params', { headers: H2 });
    const state = new URL(params.url).searchParams.get('state');
    await t.req('github connect', 'GET', `/v1/connect/github/callback?code=user-b&state=${encodeURIComponent(state)}`);
    const profile = await t.req('profile', 'GET', '/v1/account/profile', { headers: H2 });
    if (profile?.avatar?.url) {
        const r = await fetch(profile.avatar.url);
        t.note('minio: public avatar', { status: r.status, bytes: (await r.arrayBuffer()).byteLength });
    }

    await listBucket(t, side, 'before deletes');
    await t.req('session delete', 'DELETE', S, { headers: H });
    await t.req('project delete', 'DELETE', P, { headers: H });
    await new Promise((r) => setTimeout(r, 1000)); // cleanup runs after the response
    await listBucket(t, side, 'after deletes');
    await mock.close();
}
