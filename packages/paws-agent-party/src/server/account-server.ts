import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http';
import { join } from 'node:path';
import { createPocServer, type PocServer } from './http.js';
import { createRealPawsSdk, type PawsSdkBoundary } from './sdk.js';
import { AccountAccess, AccessError } from './account-access.js';
import { validateRequestAuthority } from './auth.js';

type Tenant = { accountId: string; backend: PocServer; sdk: PawsSdkBoundary; token: string; lastUsed: number; attaching?: Promise<unknown> };
export async function createAccountServer(options: { dataDir: string; masterKey: string; serverUrl: string; publicServerUrl?: string; staticDir: string; access?: AccountAccess; sdkFactory?: () => PawsSdkBoundary }): Promise<PocServer> {
  const access = options.access ?? new AccountAccess(options.serverUrl, options.masterKey);
  const tenants = new Map<string, Promise<Tenant>>();
  const retiring = new Set<string>();
  const requests = new Set<ClientRequest>();
  const sessions = new Map<string, Set<ClientRequest>>();
  const shell = await createPocServer({ dataDir: join(options.dataDir, 'public-shell'), accessToken: options.masterKey, staticDir: options.staticDir });
  let port = 0, stopping = false, logins = 0;
  async function tenant(id: string): Promise<Tenant> {
    const key = access.tenantKey(id);
    if (retiring.has(key)) throw new AccessError(503, '空间正在重新连接，请稍后重试。');
    let pending = tenants.get(key);
    if (!pending) {
      if (tenants.size >= 64) {
        await evictIdle();
        if (retiring.has(key)) throw new AccessError(503, '空间正在重新连接，请稍后重试。');
        pending = tenants.get(key);
        if (pending) { const value = await pending; value.lastUsed = Date.now(); return value; }
      }
      if (tenants.size >= 64) throw new AccessError(503, '服务容量已满，请稍后重试。');
      pending = (async () => {
        const sdk = options.sdkFactory?.() ?? createRealPawsSdk();
        const token = access.tenantToken(id);
        const backend = await createPocServer({ dataDir: join(options.dataDir, 'accounts', key), accessToken: token, staticDir: options.staticDir, sdk });
        return { accountId: id, backend, sdk, token, lastUsed: Date.now() };
      })();
      tenants.set(key, pending);
      void pending.catch(() => { if (tenants.get(key) === pending) tenants.delete(key); });
    }
    const value = await pending; value.lastUsed = Date.now(); return value;
  }
  async function evictIdle() {
    for (const [key, pending] of tenants) {
      const space = await pending.catch(() => null);
      if (!space || space.attaching || retiring.has(key) || Date.now() - space.lastUsed < 30 * 60000 || space.backend.hasActiveWork?.()) continue;
      retiring.add(key);
      access.revokeAccount(space.accountId);
      try { await space.backend.close(); tenants.delete(key); }
      finally { retiring.delete(key); }
    }
  }
  const eviction = setInterval(() => { void evictIdle().catch(() => undefined); }, 60000); eviction.unref();
  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage) {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new AccessError(413, '请求过大。'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new AccessError(400, '请求无效。'); }
  }
  function proxy(req: IncomingMessage, res: ServerResponse, backendUrl: string, token: string, session?: string) {
    const backend = new URL(backendUrl);
    const headers: Record<string, string | string[]> = { host: backend.host, authorization: `Bearer ${token}` };
    for (const name of ['accept', 'content-type', 'content-length', 'x-filename']) if (req.headers[name]) headers[name] = req.headers[name]!;
    if (req.headers.origin) headers.origin = backend.origin;
    const upstream = httpRequest(backend, { path: req.url, method: req.method, headers }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, { 'content-type': incoming.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      if (incoming.headers['content-type']?.startsWith('text/event-stream')) { const lease = setTimeout(() => res.destroy(), 55000); res.once('close', () => clearTimeout(lease)); }
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    requests.add(upstream);
    if (session) { const active = sessions.get(session) ?? new Set(); active.add(upstream); sessions.set(session, active); }
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: '服务暂不可用。' }); else res.destroy(); });
    upstream.once('close', () => { requests.delete(upstream); if (session) { sessions.get(session)?.delete(upstream); if (!sessions.get(session)?.size) sessions.delete(session); } });
    req.once('aborted', () => upstream.destroy()); res.once('close', () => upstream.destroy()); req.pipe(upstream);
  }
  const server = createServer({ requestTimeout: 60000, headersTimeout: 15000 }, (req, res) => {
    void (async () => {
      if (stopping) throw new AccessError(503, '服务正在更新。');
      if (!validateRequestAuthority({ host: req.headers.host, origin: req.headers.origin, port })) throw new AccessError(403, 'Untrusted authority');
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!path.startsWith('/api/')) { proxy(req, res, shell.url, ''); return; }
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      if (path === '/api/access/config' && req.method === 'GET') { json(res, 200, { accountMode: true }); return; }
      if (path === '/api/access/ticket' && req.method === 'POST') {
        if (logins >= 8) throw new AccessError(429, '连接较多，请稍后重试。');
        logins++;
        try {
          const input = await body(req);
          const account = await access.verify(token);
          const credentials = await access.credentials(account, input.secret);
          try {
            if (stopping || res.destroyed) throw new AccessError(503, '连接已取消。');
            const space = await tenant(account.id);
            space.attaching ??= Promise.resolve(space.sdk.attach?.(options.serverUrl, credentials)).finally(() => { space.attaching = undefined; });
            await space.attaching;
            if (space.sdk.status().state !== 'ready') throw new AccessError(503, 'Paws 连接失败，请重试。');
            json(res, 200, { ticket: access.issue(account, token), account, serverUrl: options.publicServerUrl ?? options.serverUrl });
          } finally { credentials.secret.fill(0); credentials.contentKeyPair.secretKey.fill(0); }
        } finally { logins--; }
        return;
      }
      if (path === '/api/access/exchange' && req.method === 'POST') { json(res, 200, access.exchange((await body(req)).ticket)); return; }
      if (path === '/api/access/logout' && req.method === 'POST') {
        access.logout(token); for (const active of sessions.get(token) ?? []) active.destroy(); sessions.delete(token); json(res, 200, { ok: true }); return;
      }
      const session = await access.authenticate(token);
      if (path === '/api/access/account' && req.method === 'GET') { json(res, 200, { account: session.account, serverUrl: options.publicServerUrl ?? options.serverUrl }); return; }
      if (path === '/api/paws/link' || path === '/api/paws/recover') throw new AccessError(403, '请在 Paws 中切换账号后重新打开群聊。');
      const space = await tenant(session.account.id);
      access.assertActive(token, session);
      proxy(req, res, space.backend.url, space.token, token);
    })().catch(error => { if (!res.headersSent) json(res, error instanceof AccessError ? error.status : 500, { error: error instanceof AccessError ? error.message : '请求失败，请重试。' }); else res.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, async close() {
    stopping = true; clearInterval(eviction); for (const req of requests) req.destroy(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled([...tenants.values()].map(async value => (await value).backend.close())); await shell.close();
  } };
}
