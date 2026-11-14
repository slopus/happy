import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GatewayState, NativeSessionCache, bootstrapNative, identityFor } from './state.mjs';
import { createGateway, origin, sealedScreenPath, transformShell } from './server.mjs';

test('tickets are origin/platform bound, expire, and redeem only once under concurrency', async () => {
  let now = 10;
  const state = new GatewayState({ now: () => now });
  const launch = state.issue({ cookie: 'native=sessionA', spaceId: 'spaceA' }, { parentOrigin: 'https://paws.test', platform: 'web' });
  assert.equal(state.redeem(launch.ticket, 'https://evil.test', 'web'), null);
  assert.equal(state.redeem(launch.ticket, 'https://paws.test', 'native'), null);
  const redeemed = await Promise.all([1, 2].map(() => Promise.resolve().then(() => state.redeem(launch.ticket, 'https://paws.test', 'web'))));
  assert.equal(redeemed.filter(Boolean).length, 1);
  const session = redeemed.find(Boolean);
  assert.equal(state.lease(session.sessionKey).cookie, 'native=sessionA');
  now += 12 * 60 * 60_000;
  assert.equal(state.lease(session.sessionKey), null);
  const expired = state.issue({}, { parentOrigin: 'https://paws.test', platform: 'web' });
  now += 60_000;
  assert.equal(state.redeem(expired.ticket, 'https://paws.test', 'web'), null);
});

test('cancelling one concurrent launch does not cancel or duplicate account bootstrap', async () => {
  const state = new GatewayState();
  let finish;
  let calls = 0;
  const operation = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const abort = new AbortController();
  const first = state.bootstrap('alice', operation, abort.signal);
  const second = state.bootstrap('alice', operation);
  await Promise.resolve();
  abort.abort(new Error('cancelled'));
  await assert.rejects(first, /cancelled/);
  finish({ cookie: 'alice' });
  assert.deepEqual(await second, { cookie: 'alice' });
  assert.equal(calls, 1);
  assert.equal(state.bootstraps.size, 0);
});

test('stable native account/chief identity survives restart and secret rotation fails closed', async () => {
  const first = identityFor('alice', 'a'.repeat(64));
  const rotated = identityFor('alice', 'b'.repeat(64));
  assert.equal(first.email, rotated.email);
  assert.equal(first.chiefId, rotated.chiefId);
  assert.notEqual(first.password, rotated.password);
  assert.notEqual(first.email, identityFor('bob', 'a'.repeat(64)).email);
  assert.match(first.chiefId, /^c[a-z0-9]{24}$/);
  const bodies = [];
  const fetcher = async (url, init) => {
    bodies.push({ path: url.pathname, body: JSON.parse(init.body), headers: init.headers });
    if (url.pathname.endsWith('sign-in/email')) return new Response('{}', { status: 401 });
    if (url.pathname.endsWith('sign-up/email')) return new Response('{}', { status: 422 });
    throw new Error('Unexpected RPC after failed identity login');
  };
  await assert.rejects(bootstrapNative({ subject: 'alice', secret: 'b'.repeat(64), apiUrl: 'http://127.0.0.1:3001', authOrigin: 'https://bots.test', fetcher }), /unavailable/);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].body.email, first.email);
});

test('native bootstrap uses native auth cookie and raw oRPC, then reuses existing chief without new intro', async () => {
  const id = identityFor('alice', 'a'.repeat(64)).chiefId;
  let existing = false;
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ path: url.pathname, ...init });
    if (url.pathname.endsWith('sign-in/email')) return new Response('{}', { headers: { 'set-cookie': 'better-auth.session_token=signed-native; Path=/; HttpOnly' } });
    assert.equal(init.headers.cookie, 'better-auth.session_token=signed-native');
    if (url.pathname.endsWith('get-session')) return Response.json({ user: { id: 'native-alice', email: identityFor('alice', 'a'.repeat(64)).email }, session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const { json } = JSON.parse(init.body);
    if (url.pathname === '/rpc/spaces/list') return Response.json({ json: { current: { id: 'space-a', bots: existing ? [{ id, pinned: true }] : [] }, spaces: [] } });
    assert.equal(init.headers['x-rakazo-space-id'], 'space-a');
    if (url.pathname === '/rpc/bots/create') {
      assert.equal(json.spawnKey, 'paws-chief-v1'); assert.equal(json.fleetManagement, true); assert.equal(json.name, 'Paws');
      existing = true;
      return Response.json({ json: { id: json.id, pinned: false } });
    }
    if (url.pathname === '/rpc/bots/update') { assert.deepEqual(json, { botId: id, pinned: true }); return Response.json({ json: { id, pinned: true } }); }
    throw new Error(`Unexpected path ${url.pathname}`);
  };
  const options = { subject: 'alice', secret: 'a'.repeat(64), apiUrl: 'http://127.0.0.1:3001', authOrigin: 'https://bots.test', fetcher };
  assert.equal((await bootstrapNative(options)).spaceId, 'space-a');
  await bootstrapNative(options);
  assert.equal(requests.filter((request) => request.path === '/rpc/bots/create').length, 1);
});

function nativeSessionFixture({ maxEntries = 1000 } = {}) {
  const cache = new NativeSessionCache({ maxEntries });
  const sessions = new Map();
  const secret = 'a'.repeat(64);
  const subjects = ['alice', 'bob', 'charlie'];
  const requests = [];
  let serial = 0;
  let verificationStatus = 200;
  let verificationBody;
  let beforeVerification;
  const fetcher = async (url, init) => {
    requests.push({ path: url.pathname, cookie: init.headers.cookie });
    if (url.pathname.endsWith('sign-in/email')) {
      const { email } = JSON.parse(init.body);
      const subject = subjects.find((value) => identityFor(value, secret).email === email);
      assert(subject, 'Only the expected Paws subject may authenticate');
      const cookie = `better-auth.session_token=${subject}-${++serial}`;
      sessions.set(cookie, { subject, user: { id: `native-${subject}`, email }, session: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      return new Response('{}', { headers: { 'set-cookie': `${cookie}; Path=/; HttpOnly` } });
    }
    const session = sessions.get(init.headers.cookie);
    if (url.pathname.endsWith('get-session')) {
      assert.equal(url.searchParams.get('disableCookieCache'), 'true');
      if (beforeVerification) await beforeVerification();
      if (verificationStatus !== 200) return new Response('{}', { status: verificationStatus });
      if (verificationBody !== undefined) return Response.json(verificationBody);
      return Response.json(session?.revoked ? null : session ?? null);
    }
    assert(session && !session.revoked, 'RPC must never use a revoked or wrong account session');
    if (url.pathname === '/rpc/spaces/list') return Response.json({ json: { current: { id: `space-${session.subject}`, bots: [{ id: identityFor(session.subject, secret).chiefId, pinned: true }] }, spaces: [] } });
    throw new Error(`Unexpected native request ${url.pathname}`);
  };
  return {
    cache, sessions, requests,
    launch: (subject) => bootstrapNative({ apiUrl: 'http://127.0.0.1:3001', authOrigin: 'https://bots.test', subject, secret, sessionCache: cache, fetcher }),
    credentialCalls: () => requests.filter((request) => request.path.includes('/sign-in/')).length,
    setVerificationStatus: (value) => { verificationStatus = value; },
    setVerificationBody: (value) => { verificationBody = value; },
    setBeforeVerification: (value) => { beforeVerification = value; },
  };
}

test('native sessions are reused per subject and validated on every launch without repeated sign-in', async () => {
  const f = nativeSessionFixture();
  const first = await f.launch('alice');
  const second = await f.launch('alice');
  const bob = await f.launch('bob');
  await f.launch('alice');
  assert.equal(first.cookie, second.cookie);
  assert.notEqual(first.cookie, bob.cookie);
  assert.equal(first.spaceId, 'space-alice');
  assert.equal(bob.spaceId, 'space-bob');
  assert.equal(f.credentialCalls(), 2);
  assert.equal(f.requests.filter((request) => request.path.endsWith('/get-session')).length, 4);
});

test('revoked and expired native sessions reauthenticate only their own account', async () => {
  const f = nativeSessionFixture();
  const alice = await f.launch('alice');
  const bob = await f.launch('bob');
  f.sessions.get(alice.cookie).revoked = true;
  const renewed = await f.launch('alice');
  assert.notEqual(renewed.cookie, alice.cookie);
  assert.equal((await f.launch('bob')).cookie, bob.cookie);
  f.sessions.get(renewed.cookie).session.expiresAt = new Date(Date.now() - 1000).toISOString();
  const afterExpiry = await f.launch('alice');
  assert.notEqual(afterExpiry.cookie, renewed.cookie);
  assert.equal(f.credentialCalls(), 4);
});

test('native verification outages or account mismatches never trigger credential amplification', async () => {
  const f = nativeSessionFixture();
  const alice = await f.launch('alice');
  for (const status of [429, 503]) {
    f.setVerificationStatus(status);
    await assert.rejects(f.launch('alice'), /verification unavailable/);
    assert.equal(f.credentialCalls(), 1);
  }
  f.setVerificationStatus(200);
  f.sessions.get(alice.cookie).user.email = identityFor('bob', 'a'.repeat(64)).email;
  await assert.rejects(f.launch('alice'), /identity does not match/);
  assert.equal(f.credentialCalls(), 1);
  assert.equal(f.cache.get('alice'), undefined);
});

test('malformed successful session verification never submits more credentials', async () => {
  const f = nativeSessionFixture();
  const authenticated = await f.launch('alice');
  for (const body of [{}, { error: 'temporary failure' }, [], { user: {}, session: [] }]) {
    f.setVerificationBody(body);
    await assert.rejects(f.launch('alice'), /verification returned an invalid response/);
    assert.equal(f.credentialCalls(), 1);
    assert.equal(f.cache.get('alice').cookie, authenticated.cookie);
  }
});

test('native cache is bounded and a cancelled concurrent cached launch leaves its peer intact', async () => {
  const f = nativeSessionFixture({ maxEntries: 2 });
  await f.launch('alice'); await f.launch('bob'); await f.launch('charlie');
  assert.equal(f.cache.entries.size, 2);
  assert.equal(f.cache.get('alice'), undefined);
  const state = new GatewayState();
  let unblock;
  let entered;
  const verificationStarted = new Promise((resolve) => { entered = resolve; });
  f.setBeforeVerification(() => { entered(); return new Promise((resolve) => { unblock = resolve; }); });
  const controller = new AbortController();
  const first = state.bootstrap('bob', () => f.launch('bob'), controller.signal);
  const peer = state.bootstrap('bob', () => f.launch('bob'));
  await verificationStarted;
  controller.abort(new Error('cancelled cached launch'));
  await assert.rejects(first, /cancelled cached launch/);
  unblock();
  assert.equal((await peer).spaceId, 'space-bob');
  assert.equal(f.credentialCalls(), 3);
});

test('only exact HTTPS/loopback origins and a root native module shell are accepted', () => {
  assert.equal(origin('https://bots.test/'), 'https://bots.test');
  for (const value of ['http://public.test', 'https://a:b@bots.test', 'https://bots.test/path', 'https://bots.test/?ticket=x']) assert.throws(() => origin(value));
  const result = transformShell('<html><head></head><body><div id="root"></div><script type="module" src="/assets/native.js"></script></body></html>');
  assert.match(result, /application\/paws-module/);
  assert.match(result, /src="\/__paws\/loader.js"/);
  assert.doesNotMatch(result, /type="module"/);
  assert.throws(() => transformShell('<h1>upstream failure</h1>'));
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handle, overrides = {}) {
  const upstream = http.createServer(handle);
  const target = new URL(await listen(upstream));
  const config = { webUrl: target, apiUrl: target, authOrigin: 'https://bots.test', publicOrigin: 'https://bots.test', parentOrigins: ['https://paws.test'], bridgeSecret: 's'.repeat(64) };
  const gateway = createGateway(config, { state: overrides.state, bootstrap: async (subject) => ({ cookie: `native=${subject}`, spaceId: `space-${subject}` }) });
  const base = await listen(gateway.server);
  t.after(async () => { gateway.server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => gateway.server.close(r)), new Promise((r) => upstream.close(r))]); });
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const launch = async (subject = 'alice', platform = 'web') => {
    const response = await post('/__paws/bootstrap', { subject, parentOrigin: 'https://paws.test', platform }, { 'x-paws-bridge-secret': config.bridgeSecret });
    assert.equal(response.status, 200);
    return response.json();
  };
  const redeem = async (ticket, platform = 'web') => {
    const response = await post('/__paws/redeem', { ticket, parentOrigin: platform === 'web' ? 'https://paws.test' : config.publicOrigin, platform }, { origin: config.publicOrigin });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { gateway, config, base, upstream, post, launch, redeem };
}

test('HTTP gateway authenticates launch, rejects direct private access and separates native cookies', async (t) => {
  const seen = [];
  const f = await fixture(t, (req, res) => {
    seen.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, bridge: req.headers['x-paws-bridge-secret'], lease: req.headers['x-paws-rakazo-session'] });
    res.setHeader('set-cookie', 'upstream=must-not-reach-browser');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ cookie: req.headers.cookie }));
  });
  assert.equal((await f.post('/__paws/bootstrap', {})).status, 404);
  assert.equal((await fetch(`${f.base}/rpc/spaces/list`, { headers: { cookie: 'native=alice', authorization: 'Bearer paws-token' } })).status, 401);
  const a = await f.launch('alice'), b = await f.launch('bob');
  assert.equal(a.runtimeUrl, 'https://bots.test/');
  const keyA = (await f.redeem(a.ticket)).sessionKey;
  const keyB = (await f.redeem(b.ticket)).sessionKey;
  assert.notEqual(keyA, keyB);
  assert.equal((await f.post('/__paws/redeem', { ticket: a.ticket, parentOrigin: 'https://paws.test', platform: 'web' }, { origin: f.config.publicOrigin })).status, 401);
  for (const [sessionKey, user] of [[keyA, 'alice'], [keyB, 'bob']]) {
    const response = await fetch(`${f.base}/rpc/spaces/list`, { headers: { 'x-paws-rakazo-session': sessionKey, cookie: 'native=attacker', authorization: 'Bearer paws-token', 'x-paws-bridge-secret': 'browser-supplied' } });
    assert.deepEqual(await response.json(), { cookie: `native=${user}` });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert(seen.every((request) => !request.authorization && !request.bridge && !request.lease));
  assert.equal((await f.post('/api/auth/sign-up/email', {}, { 'x-paws-rakazo-session': keyA })).status, 403);
  assert.equal((await f.post('/api/auth/change-password', {}, { 'x-paws-rakazo-session': keyA })).status, 403);
  await f.post('/api/auth/sign-out', {}, { 'x-paws-rakazo-session': keyA });
  assert.equal((await fetch(`${f.base}/rpc/spaces/list`, { headers: { 'x-paws-rakazo-session': keyA } })).status, 401);
  assert.equal((await fetch(`${f.base}/rpc/spaces/list`, { headers: { 'x-paws-rakazo-session': keyB } })).status, 200);
});

test('native one-time launch still requires origin and a native-bound ticket', async (t) => {
  const f = await fixture(t, (_req, res) => res.end('unused'));
  const launch = await f.launch('alice', 'native');
  assert.equal((await f.post('/__paws/redeem', { ticket: launch.ticket, parentOrigin: f.config.publicOrigin, platform: 'native' }, { origin: 'https://evil.test' })).status, 403);
  const lease = await f.redeem(launch.ticket, 'native');
  assert.match(lease.sessionKey, /^[A-Za-z0-9_-]{43}$/);
});

test('gateway embeds only native shell and serves its own non-caching worker', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; script-src 'self'");
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    res.end('<html><head></head><body><div id="root"></div><script type="module" src="/assets/native.js"></script></body></html>');
  });
  const page = await fetch(f.base);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/paws.test/);
  assert.equal(page.headers.get('x-frame-options'), null);
  assert.match(await page.text(), /application\/paws-module/);
  const sw = await fetch(`${f.base}/sw.js`);
  assert.equal(sw.headers.get('cache-control'), 'no-store');
  assert.match(await sw.text(), /const leases = new Map/);
});

test('SSE stays streaming and disconnect cancels the upstream request', async (t) => {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const f = await fixture(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    req.once('close', close);
  });
  const { ticket } = await f.launch();
  const { sessionKey } = await f.redeem(ticket);
  const controller = new AbortController();
  const response = await fetch(`${f.base}/rpc/events`, { signal: controller.signal, headers: { 'x-paws-rakazo-session': sessionKey } });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  controller.abort();
  await Promise.race([closed, new Promise((_r, reject) => setTimeout(() => reject(new Error('upstream was not cancelled')), 1000))]);
});

for (const invalidation of ['expiry', 'signout']) test(`active private SSE is closed on lease ${invalidation}`, async (t) => {
  let nativeStream;
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const f = await fixture(t, (req, res) => {
    nativeStream = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: initial\n\n');
    req.once('close', upstreamClosed);
  }, { state: new GatewayState({ leaseTtl: invalidation === 'expiry' ? 150 : 60_000 }) });
  const { sessionKey } = await f.redeem((await f.launch()).ticket);
  const headers = { 'x-paws-rakazo-session': sessionKey };
  const response = await fetch(`${f.base}/rpc/events`, { headers });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /initial/);
  // Begin observing closure immediately: a lease revoked later must terminate
  // an already authorized stream, without waiting for another business request.
  const ended = reader.read().then((value) => value.done, () => true);
  if (invalidation === 'signout') assert.equal((await f.post('/api/auth/sign-out', {}, headers)).status, 200);
  let timeout;
  try {
    assert.equal(await Promise.race([ended, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Private stream survived revoked lease')), 1000); })]), true);
    await closed;
  } finally { clearTimeout(timeout); }
  nativeStream.write('data: forbidden-after-revocation\n\n');
  assert.equal((await fetch(`${f.base}/rpc/spaces/list`, { headers })).status, 401);
  assert.equal(f.gateway.state.revocations.size, 0);
});

test('gateway rejects a same-origin runtime/parent configuration', () => {
  assert.throws(() => createGateway({ publicOrigin: 'https://paws.test', parentOrigins: ['https://paws.test/'] }), /separate origin/);
});

test('normalized path authorities cannot escape the fixed upstream origin', async (t) => {
  const seen = [];
  const f = await fixture(t, (req, res) => { seen.push(req.url); res.end('native-static'); });
  const trap = http.createServer((_req, res) => { seen.push('SSRF'); res.end('forbidden'); });
  const trapUrl = new URL(await listen(trap));
  t.after(async () => { trap.closeAllConnections(); await new Promise((resolve) => trap.close(resolve)); });
  for (const prefix of ['/.//', '/foo/..//', '/%2e//']) {
    const result = await new Promise((resolve, reject) => {
      const req = http.request(`${f.base}/`, { path: `${prefix}${trapUrl.host}/api/auth/capabilities` }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(result, 400);
  }
  assert.deepEqual(seen, []);
});

test('only strict native sealed-screen WS routes accept opaque origin, retaining native validation', async (t) => {
  const f = await fixture(t, (_req, res) => { res.statusCode = 403; res.end('native-capability-refused'); });
  const seen = [];
  f.upstream.on('upgrade', (req, socket) => {
    seen.push({ url: req.url, origin: req.headers.origin, cookie: req.headers.cookie });
    // Emulate the native authority refusing an invalid/expired sealed capability.
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  const upgrade = (path, requestOrigin) => new Promise((resolve) => {
    const req = http.request(`${f.base}/`, { path, headers: { connection: 'Upgrade', upgrade: 'websocket', origin: requestOrigin } });
    req.on('error', () => resolve()); req.on('response', (res) => { res.resume(); resolve(); }); req.end();
  });
  const nativePath = `/novnc/session/view/${Date.now() + 60_000}.not-a-real-seal/websockify`;
  assert.equal(sealedScreenPath(`/${nativePath}`), nativePath);
  await upgrade(`/${nativePath}`, 'null');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, nativePath);
  assert.equal(seen[0].cookie, undefined);
  await upgrade('/rpc/events', 'null');
  await upgrade('/novnc/arbitrary/socket', 'null');
  await upgrade(nativePath, 'https://evil.test');
  assert.equal(seen.length, 1);
  assert.equal((await fetch(`${f.base}/rpc/spaces/list`, { headers: { origin: 'null' } })).status, 401);
});

test('worker binds the sending client only and fails closed without a client lease', async () => {
  const handlers = {};
  const requests = [];
  const context = vm.createContext({ URL, Map, Date, Headers, Request, Response, Number, MessageChannel, setTimeout, clearTimeout,
    self: { location: { origin: 'https://bots.test' }, addEventListener: (name, callback) => { handlers[name] = callback; }, clients: { get: async () => null } },
    fetch: async (request) => { requests.push(request); return Response.json({ ok: true }); },
  });
  vm.runInContext(readFileSync(new URL('./bridge-sw.js', import.meta.url), 'utf8'), context);
  const bind = (client, key) => {
    let reply;
    handlers.message({ data: { type: 'paws:bind', sessionKey: key, expiresAt: Date.now() + 10_000 }, source: { id: client, url: 'https://bots.test/' }, ports: [{ postMessage: (value) => { reply = value; } }] });
    return reply;
  };
  assert.equal(bind('alice-tab', 'a'.repeat(43)).ok, true);
  assert.equal(bind('alice-tab', 'b'.repeat(43)).ok, false);
  assert.equal(bind('bob-tab', 'b'.repeat(43)).ok, true);
  const request = async (clientId) => {
    let response;
    handlers.fetch({ clientId, request: new Request('https://bots.test/rpc/spaces/list'), respondWith: (value) => { response = value; } });
    return response;
  };
  assert.equal((await request('unknown-tab')).status, 401);
  await request('alice-tab'); await request('bob-tab');
  assert.equal(requests[0].headers.get('x-paws-rakazo-session'), 'a'.repeat(43));
  assert.equal(requests[1].headers.get('x-paws-rakazo-session'), 'b'.repeat(43));
  // Re-evaluate in a fresh worker global: there is no disk/localStorage recovery.
  const restarted = {};
  const fresh = vm.createContext({ URL, Map, Date, Headers, Request, Response, Number, MessageChannel, setTimeout, clearTimeout,
    self: { location: { origin: 'https://bots.test' }, addEventListener: (name, callback) => { restarted[name] = callback; }, clients: { get: async () => null } },
    fetch: () => { throw new Error('A restarted worker must not forward private traffic'); },
  });
  vm.runInContext(readFileSync(new URL('./bridge-sw.js', import.meta.url), 'utf8'), fresh);
  let response;
  restarted.fetch({ clientId: 'alice-tab', request: new Request('https://bots.test/rpc/spaces/list'), respondWith: (value) => { response = value; } });
  assert.equal((await response).status, 401);
});

test('a restarted worker restores only the requesting document memory lease, without shared storage', async () => {
  const handlers = {};
  const requests = [];
  const clientsAsked = [];
  const context = vm.createContext({ URL, Map, Date, Headers, Request, Response, Number, MessageChannel, setTimeout, clearTimeout,
    self: { location: { origin: 'https://bots.test' }, addEventListener: (name, callback) => { handlers[name] = callback; },
      clients: { get: async (id) => ({ postMessage(message, ports) {
        clientsAsked.push(id);
        if (message.type === 'paws:restore-lease') ports[0].postMessage(id === 'original-tab' ? { sessionKey: 'a'.repeat(43), expiresAt: Date.now() + 10_000 } : null);
      } }) },
    },
    fetch: async (request) => { requests.push(request); return Response.json({ ok: true }); },
  });
  vm.runInContext(readFileSync(new URL('./bridge-sw.js', import.meta.url), 'utf8'), context);
  const request = async (clientId) => {
    let response;
    handlers.fetch({ clientId, request: new Request('https://bots.test/rpc/spaces/list'), respondWith: (value) => { response = value; } });
    return response;
  };
  assert.equal((await request('original-tab')).status, 200);
  assert.equal((await request('new-tab')).status, 401);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get('x-paws-rakazo-session'), 'a'.repeat(43));
  assert.deepEqual(clientsAsked.slice(0, 2), ['original-tab', 'new-tab']);
});
