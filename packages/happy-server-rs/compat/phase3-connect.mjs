// connectRoutes (GitHub OAuth, webhooks, vendor tokens) and voiceRoutes against
// the third-party mock. Run from phase3 with phase3.env.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../happy-server/package.json', import.meta.url)));
const sharp = require('sharp');
const MOCK = process.env.COMPAT_MOCK || 'http://127.0.0.1:3299';
const WEBHOOK_SECRET = 'compat-webhook-secret';

async function image(w, h, { alpha = false, format = 'png' } = {}) {
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        px[i] = (x * 255 / w) | 0;
        px[i + 1] = (y * 255 / h) | 0;
        px[i + 2] = ((x * y) % 255) | 0;
        px[i + 3] = alpha ? ((x + y) * 255 / (w + h)) | 0 : 255;
    }
    const img = sharp(px, { raw: { width: w, height: h, channels: 4 } });
    return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 90 }).toBuffer();
}

const profile = (id, login, name, avatar, extra = {}) => ({
    login, id, node_id: 'MDQ6VXNlcjE=', avatar_url: `${MOCK}/avatar/${avatar}`, gravatar_id: '', type: 'User', site_admin: false,
    name, company: null, blog: '', location: null, email: null, hireable: null, bio: 'bio', twitter_username: null,
    public_repos: 2, public_gists: 0, followers: 1, following: 0, created_at: '2020-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    plan: { name: 'free', space: 976562499, collaborators: 0, private_repos: 10000 }, ...extra,
});

export async function routes(mock) {
    const avatars = {
        'a.png': await image(100, 100),
        'b.jpg': await image(640, 480, { format: 'jpeg' }),
        'c.png': await image(37, 80, { alpha: true }),
        'd.png': await image(120, 90),
        'x.gif': Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
    };
    for (const [name, data] of Object.entries(avatars)) {
        mock.route(`/avatar/${name}`, () => ({ raw: data, type: name.endsWith('jpg') ? 'image/jpeg' : name.endsWith('gif') ? 'image/gif' : 'image/png' }));
    }
    mock.route('/github.com/login/oauth/access_token', ({ body }) => {
        switch (body.code) {
            case 'err': return { json: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } };
            case 'errarr': return { json: { error: ['a b', 'c/d', null] } };
            case 'errobj': return { json: { error: { toString: 1 } } };
            case 'badjson': return { raw: '<html>' };
            case 'null': return { raw: 'null' };
            case 'noaccess': return { json: { scope: '' } };
            default: return { json: { access_token: 'gho_' + body.code, token_type: 'bearer', scope: 'read:user' } };
        }
    });
    const users = {
        'user-a': profile(101, 'octo-a', '  Octo  Cat\tSmith ', 'a.png', { 42: 'answer' }),
        'user-b': profile(102, 'octo-b', null, 'b.jpg'),
        'user-gif': profile(104, 'octo-gif', 'Gif', 'x.gif'),
        'user-same': profile(105, 'octo-b', 'Same Login', 'd.png'),
        'user-nologin': (({ login, ...p }) => p)(profile(106, 'x', 'Ünïcode  Ñame', 'c.png')),
        'user-noid': { login: 'no-id' },
    };
    mock.route('/api.github.com/user', ({ headers }) => {
        const key = (headers.authorization || '').replace(/^Bearer gho_/, '');
        if (key === 'user-404') return { status: 404, json: { message: 'Not Found' } };
        if (key === 'user-badjson') return { raw: 'nope' };
        if (users[key]) return { json: users[key] };
        return { status: 401, json: { message: 'Requires authentication' } };
    });

    mock.voice = { pages: {}, token: { status: 200, json: {} } };
    mock.route('/api.elevenlabs.io/v1/convai/conversations', ({ url }) => {
        const page = mock.voice.pages[url.searchParams.get('cursor') || ''];
        return page || { status: 500, json: { detail: 'no page' } };
    });
    mock.route('/api.elevenlabs.io/v1/convai/conversation/token', () => mock.voice.token);
}

const sign = (body) => 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url')}.c2ln`;

export async function github(t, sql, H, H2, H3, other, r) {
    const stateFor = async (H, label = 'github params') => {
        const res = await t.req(label, 'GET', '/v1/connect/github/params', { headers: H });
        return new URL(res.url).searchParams.get('state');
    };
    const cb = (name, code, state) => r(name, 'GET', `/v1/connect/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);

    await t.req('github params no auth', 'GET', '/v1/connect/github/params');
    const s1 = await stateFor(H);
    await t.req('github callback missing code', 'GET', `/v1/connect/github/callback?state=${s1}`);
    await t.req('github callback repeated code', 'GET', `/v1/connect/github/callback?code=a&code=b&state=${s1}`);
    await cb('github callback bad state', 'user-a', 'nope');
    await cb('github callback session token as state', 'user-a', H.authorization.slice(7));
    await cb('github callback token error', 'err', s1);
    await cb('github callback token error array', 'errarr', s1);
    await cb('github callback token error object', 'errobj', s1);
    await cb('github callback token bad json', 'badjson', s1);
    await cb('github callback token null', 'null', s1);
    await cb('github callback no access token', 'noaccess', s1);
    await cb('github callback user 404', 'user-404', s1);
    await cb('github callback user bad json', 'user-badjson', s1);
    await cb('github callback user without id', 'user-noid', s1);

    // A state minted by the other server: the token formats must agree.
    const foreign = await (await fetch(other + '/v1/connect/github/params', { headers: H })).json();
    await cb('github callback connect (state from other server)', 'user-a', new URL(foreign.url).searchParams.get('state'));
    await t.req('profile after connect', 'GET', '/v1/account/profile', { headers: H });
    await cb('github callback same account again', 'user-a', s1);
    const s2 = await stateFor(H2, 'github params user2');
    await cb('github callback gif avatar', 'user-gif', s2);
    await cb('github callback jpeg avatar', 'user-b', s2);
    const s3 = await stateFor(H3, 'github params user3');
    await cb('github callback takes over account', 'user-a', s3);
    await t.req('profile user1 after takeover', 'GET', '/v1/account/profile', { headers: H });
    await t.req('profile user3 after takeover', 'GET', '/v1/account/profile', { headers: H3 });
    await cb('github callback username taken', 'user-same', s1);
    await cb('github callback without login', 'user-nologin', s1);
    await t.req('profile after nologin', 'GET', '/v1/account/profile', { headers: H });

    await r('github disconnect', 'DELETE', '/v1/connect/github', { headers: H2 });
    await r('github disconnect again', 'DELETE', '/v1/connect/github', { headers: H2 });
    await t.req('github disconnect no auth', 'DELETE', '/v1/connect/github');
    await t.req('profile after disconnect', 'GET', '/v1/account/profile', { headers: H2 });
}

export async function webhooks(t) {
    const W = '/v1/connect/github/webhook';
    const hook = (name, event, body, { sig, type = 'application/json' } = {}) => t.req(name, 'POST', W, {
        raw: body,
        headers: { ...(type ? { 'content-type': type } : {}), 'x-hub-signature-256': sig ?? sign(body ?? ''), 'x-github-event': event, 'x-github-delivery': 'delivery-1' },
    });
    const full = { action: 'opened', repository: { full_name: 'o/r' }, pusher: { name: 'p' }, sender: { login: 's' }, pull_request: { number: 1, title: 't' }, issue: { number: 2, title: 'i' } };

    await t.req('webhook missing headers', 'POST', W, { body: {} });
    await t.req('webhook missing event', 'POST', W, { body: {}, headers: { 'x-hub-signature-256': 'x' } });
    await hook('webhook no body', 'ping', undefined, { type: null });
    await hook('webhook text body', 'ping', 'hello', { type: 'text/plain' });
    await hook('webhook empty json', 'ping', '', {});
    await hook('webhook whitespace json', 'ping', '  ', {});
    await hook('webhook invalid json', 'ping', '{x', {});
    await hook('webhook bad signature', 'ping', '{"zen":"x"}', { sig: 'sha256=00' });
    await hook('webhook uppercase signature', 'ping', '{"zen":"x"}', { sig: sign('{"zen":"x"}').toUpperCase() });
    await hook('webhook empty signature', 'ping', '{"zen":"x"}', { sig: '' });
    await hook('webhook ping', 'ping', '{"zen":"x", "hook_id": 1}');
    await hook('webhook charset', 'ping', '{"zen":"é"}', { type: 'application/json; charset=utf-8' });
    await hook('webhook empty event', '', '{"zen":"x"}');
    for (const [name, event, payload] of [
        ['push full', 'push', full],
        ['push empty', 'push', {}],
        ['push null pusher', 'push', { ...full, pusher: null }],
        ['push string repository', 'push', { ...full, repository: 'r' }],
        ['pull_request full', 'pull_request', full],
        ['pull_request no pr', 'pull_request', { ...full, pull_request: undefined }],
        ['issues toString title', 'issues', { ...full, issue: { number: 1, title: { toString: 1 } } }],
        ['issues array title', 'issues', { ...full, issue: { number: [1, null, [2]], title: ['a', { b: 1 }] } }],
        ['star created', 'star', { action: 'created', repository: { full_name: 'o/r' }, sender: { login: 's' } }],
        ['star created no sender', 'star', { action: 'created', repository: { full_name: 'o/r' } }],
        ['star array action', 'star', { action: ['created'] }],
        ['star other action', 'star', { action: 'other' }],
        ['star toString action', 'star', { action: { toString: 'x' } }],
        ['repository', 'repository', { action: 'renamed', repository: { full_name: 'o/r' } }],
        ['repository missing', 'repository', { action: 'renamed' }],
        ['unknown event', 'workflow_run', {}],
        ['array payload ping', 'ping', []],
        ['array payload push', 'push', []],
        ['zero payload', 'ping', 0],
        ['false payload', 'ping', false],
        ['null payload', 'ping', null],
        ['number payload', 'ping', 5],
        ['string payload', 'ping', 's'],
        ['null action', 'push', { ...full, action: null }],
    ]) await hook(`webhook ${name}`, event, JSON.stringify(payload));
}

export async function vendors(t, H, H2) {
    await t.req('vendor register bad vendor', 'POST', '/v1/connect/github/register', { headers: H, body: { token: 'x' } });
    await t.req('vendor register missing token', 'POST', '/v1/connect/openai/register', { headers: H, body: {} });
    await t.req('vendor register both invalid', 'POST', '/v1/connect/nope/register', { headers: H, body: {} });
    await t.req('vendor register no auth', 'POST', '/v1/connect/openai/register', { body: { token: 'x' } });
    await t.req('vendor tokens empty', 'GET', '/v1/connect/tokens', { headers: H });
    await t.req('vendor token missing', 'GET', '/v1/connect/openai/token', { headers: H });
    await t.req('vendor register openai', 'POST', '/v1/connect/openai/register', { headers: H, body: { token: 'sk-openai-1' } });
    await t.req('vendor register anthropic', 'POST', '/v1/connect/anthropic/register', { headers: H, body: { token: 'sk-ant-é ✓' } });
    await t.req('vendor register empty', 'POST', '/v1/connect/gemini/register', { headers: H, body: { token: '' } });
    await t.req('vendor token', 'GET', '/v1/connect/anthropic/token', { headers: H });
    await t.req('vendor token other user', 'GET', '/v1/connect/anthropic/token', { headers: H2 });
    await t.req('vendor token github', 'GET', '/v1/connect/github/token', { headers: H });
    await t.req('vendor register openai again', 'POST', '/v1/connect/openai/register', { headers: H, body: { token: 'sk-openai-2' } });
    await t.req('vendor tokens', 'GET', '/v1/connect/tokens', { headers: H });
    await t.req('vendor delete', 'DELETE', '/v1/connect/openai', { headers: H });
    await t.req('vendor delete again', 'DELETE', '/v1/connect/openai', { headers: H });
    await t.req('vendor delete with json body', 'DELETE', '/v1/connect/gemini', { headers: { ...H, 'content-type': 'application/json' }, raw: '' });
    await t.req('vendor tokens after delete', 'GET', '/v1/connect/tokens', { headers: H });
}

export async function voice(t, H, mock) {
    const V = mock.voice;
    const page = (conversations, has_more = false, next_cursor = null) => ({ json: { conversations, has_more, next_cursor } });
    const usage = (name) => t.req(`voice usage ${name}`, 'GET', '/v1/voice/usage', { headers: H });
    const conv = (name, agentId = 'agent_1') => t.req(`voice conversation ${name}`, 'POST', '/v1/voice/conversations', { headers: H, body: { agentId } });

    await t.req('voice usage no auth', 'GET', '/v1/voice/usage');
    await t.req('voice conversation missing agent', 'POST', '/v1/voice/conversations', { headers: H, body: {} });
    V.pages = { '': page([{ call_duration_secs: 10.5 }, { call_duration_secs: null }, {}, 7]) };
    await usage('one page');
    V.pages = { '': page([{ call_duration_secs: 0.1 }], true, 'c1'), c1: page([{ call_duration_secs: 0.2 }], true, 'c2'), c2: page([{ call_duration_secs: 3 }]) };
    await usage('three pages');
    for (const [name, pages] of [
        ['missing cursor', { '': page([], true) }],
        ['repeated cursor', { '': page([], true, 'c1'), c1: page([], true, 'c1') }],
        ['number cursor', { '': page([], true, 5) }],
        ['string duration', { '': page([{ call_duration_secs: '5' }]) }],
        ['negative duration', { '': page([{ call_duration_secs: -1 }]) }],
        ['huge duration', { '': { raw: '{"conversations":[{"call_duration_secs":1e999}],"has_more":false}' } }],
        ['null conversation', { '': page([null]) }],
        ['has_more string', { '': { json: { conversations: [], has_more: 'false' } } }],
        ['conversations object', { '': { json: { conversations: {}, has_more: false } } }],
        ['http 500', {}],
        ['bad json', { '': { raw: 'x' } }],
    ]) {
        V.pages = pages;
        await usage(name);
    }
    V.pages = { '': page([{ call_duration_secs: 7000 }], true, 'c1'), c1: page([{ call_duration_secs: 200 }], true, 'c2') };
    await usage('cap reached mid-way');
    await conv('cap reached');
    V.pages = { '': page([{ call_duration_secs: 7199.5 }]) };
    for (const [name, token, agent] of [
        ['granted', { json: { token: jwt({ video: { room: 'room_conv_AbC123_x' } }) } }],
        ['agent id in url', { json: { token: jwt({ video: { room: 'conv_1' } }) } }, 'a b&c=d#frag'],
        ['token http 403', { status: 403, json: { detail: 'forbidden' } }],
        ['token no room', { json: { token: jwt({ video: {} }) } }],
        ['token number room', { json: { token: jwt({ video: { room: 5 } }) } }],
        ['token null payload', { json: { token: jwt('null') } }],
        ['token bad payload', { json: { token: jwt('{x') } }],
        ['token without dots', { json: { token: 'abc' } }],
        ['token number', { json: { token: 5 } }],
        ['token null body', { raw: 'null' }],
        ['token bad json', { raw: 'x' }],
    ]) {
        V.token = token;
        await conv(name, agent);
    }
    V.pages = {};
    await conv('usage failure');
}
