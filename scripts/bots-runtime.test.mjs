import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(readFileSync(new URL('../packages/paws-bots/apps/web/src/paws/runtime.ts', import.meta.url), 'utf8').replace('import.meta.env.PAWS_EMBEDDED', 'true'));
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const store = () => {
    const map = new Map();
    return new Proxy({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), key: index => [...map.keys()][index] ?? null }, { ownKeys: () => [...map.keys()], getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
};
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
async function fixture(spaceId = 'space-alice', accountKey = 'account-key-for-' + spaceId) {
    const calls = [];
    const localStorage = store();
    globalThis.window = { location: { origin: 'https://paws.test' }, localStorage, sessionStorage: store() };
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/__paws/redeem')) return Response.json({ sessionKey: 'k'.repeat(43), spaceId, accountKey, expiresAt: Date.now() + 60_000, locale: 'zh', appearance: 'dark' });
        return Response.json({ ok: true });
    };
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(source + '\n//' + crypto.randomUUID()).toString('base64')}`);
    const root = { dataset: {} };
    await runtime.connect(root, { runtimeUrl: 'https://bots.test/', ticket: 't'.repeat(43), expiresAt: Date.now() + 60_000 });
    return { runtime, calls, localStorage, root };
}

test('embedded requests pin their own lease, strip host credentials, and reject redirects', async () => {
    const { runtime, calls } = await fixture();
    await runtime.pawsFetch(new Request('https://paws.test/rpc/threads/subscribe', { method: 'POST', headers: { Authorization: 'Bearer host-secret', Cookie: 'host-cookie', 'x-rakazo-space-id': 'space-alice' }, body: '{"json":{}}' }));
    const { url, init } = calls.at(-1);
    assert.equal(url, 'https://bots.test/rpc/threads/subscribe');
    assert.equal(init.headers.get('authorization'), null);
    assert.equal(init.headers.get('cookie'), null);
    assert.equal(init.headers.get('x-paws-rakazo-session'), 'k'.repeat(43));
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(await init.body.text(), '{"json":{}}');
    const count = calls.length;
    for (const path of ['https://evil.test/rpc/send', '/v1/sessions', 'https://bots.test/__paws/bootstrap']) await assert.rejects(runtime.pawsFetch(path), /Unsupported/);
    assert.equal(calls.length, count);
    runtime.disconnect();
});

test('unmount aborts all in-flight requests and revokes only this mount lease', async () => {
    const { runtime, calls } = await fixture();
    await runtime.pawsFetch('/rpc/threads/subscribe');
    const signal = calls.at(-1).init.signal;
    assert.equal(signal.aborted, false);
    runtime.disconnect();
    assert.equal(signal.aborted, true);
    assert.equal(calls.at(-1).url, 'https://bots.test/api/auth/sign-out');
    assert.equal(calls.at(-1).init.headers['x-paws-rakazo-session'], 'k'.repeat(43));
    await assert.rejects(runtime.pawsFetch('/rpc/bootstrap'), /ended/);
});

test('drafts are account namespaced and late old-account writes stay in the old namespace', async () => {
    const one = await fixture('shared-space', 'account-key-for-alice');
    one.runtime.localStore.setItem('draft', 'alice');
    const raw = one.localStorage;
    const two = await fixture('shared-space', 'account-key-for-bob');
    // Both instances share the same host Storage, as in a real account switch.
    window.localStorage = raw;
    assert.equal(two.runtime.localStore.getItem('draft'), null);
    two.runtime.localStore.setItem('draft', 'bob');
    one.runtime.disconnect();
    one.runtime.localStore.setItem('draft', 'late alice');
    assert.equal(two.runtime.localStore.getItem('draft'), 'bob');
    assert.equal(one.runtime.localStore.getItem('draft'), 'late alice');
    assert.equal(raw.getItem('draft'), null);
    two.runtime.localStore.clear();
    assert.equal(one.runtime.localStore.getItem('draft'), 'late alice');
    two.runtime.disconnect();
});

test('quote portal positions remain correct inside an offset transformed host', async () => {
    const source = stripTypeScriptTypes(readFileSync(new URL('../packages/paws-bots/apps/web/src/paws/quote-placement.ts', import.meta.url), 'utf8'));
    const { quotePlacement } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const button = { width: 100, height: 30 };
    const origin = quotePlacement({ left: 100, top: 60, bottom: 80, width: 120, height: 20 }, { left: 0, top: 0, width: 600, height: 400 }, button);
    const shifted = quotePlacement({ left: 170, top: 178, bottom: 198, width: 120, height: 20 }, { left: 70, top: 118, width: 600, height: 400 }, button);
    assert.deepEqual(shifted, origin);
    const edge = quotePlacement({ left: 660, top: 120, bottom: 137, width: 25, height: 17 }, { left: 70, top: 118, width: 600, height: 80 }, button);
    assert(edge.left + button.width / 2 <= 600 - 8);
    assert(edge.top >= 8 && edge.top + button.height <= 80 - 8);
});

test('embedded HTML and MCP shells stay on the bound Bots runtime without a credential URL', async () => {
    const { runtime } = await fixture();
    for (const path of ['/html-viewer.html', '/mcp-app-viewer.html']) {
        const url = new URL(runtime.hostViewerUrl(path));
        assert.equal(url.origin, 'https://bots.test');
        assert.equal(url.pathname, path);
        assert.equal(url.search, ''); assert.equal(url.hash, '');
        assert.equal(url.username, ''); assert.equal(url.password, '');
    }
    for (const path of ['/rpc/bootstrap', '//evil.test/html-viewer.html', '/html-viewer.html?ticket=secret', '/html-viewer.html/extra']) {
        assert.throws(() => runtime.hostViewerUrl(path), /Unsupported Bots viewer/);
    }
    runtime.disconnect();
    assert.throws(() => runtime.hostViewerUrl('/html-viewer.html'), /Bots session ended/);
});

test('standalone viewer paths retain their native same-origin routing', async () => {
    globalThis.window = { location: { origin: 'https://native-bots.test' } };
    const nativeSource = source.replace('export const embedded = Boolean(true)', 'export const embedded = Boolean(false)');
    assert.notEqual(nativeSource, source);
    const runtime = await import(`data:text/javascript;base64,${Buffer.from(nativeSource + '\n//' + crypto.randomUUID()).toString('base64')}`);
    assert.equal(runtime.hostViewerUrl('/html-viewer.html'), '/html-viewer.html');
    assert.equal(runtime.hostViewerUrl('/mcp-app-viewer.html'), '/mcp-app-viewer.html');
});
