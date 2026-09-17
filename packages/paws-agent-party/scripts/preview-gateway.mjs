import { createServer, request as httpRequest } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DAY = 24 * 60 * 60 * 1000;
const MAX_BODY = 11 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();
const publicAsset = path => path === '/' || path === '/index.html' || /^\/assets\/[A-Za-z0-9._-]+\.(?:js|css|svg|png|ico|woff2?)$/.test(path);

/** Explicit, temporary exception to the POC's loopback-only hosting contract.
 * Only this fixed backend is reachable. The account secret never enters this gateway.
 * Browser uses the existing token-entry UI with a separate short-lived password.
 */
export async function createPreviewGateway({ backendUrl, backendToken, password, lifetimeMs = DAY, onExpire = () => {} }) {
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1' || !backend.port || backend.pathname !== '/' || backend.search || backend.hash || backend.username || backend.password) throw Error('A fixed loopback backend origin is required');
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > DAY) throw Error('Preview lifetime must be within 24 hours');
  if (typeof password !== 'string' || password.length < 32 || typeof backendToken !== 'string' || backendToken.length < 32) throw Error('Strong independent tokens required');
  if (password === backendToken) throw Error('Preview password must differ from backend token');
  const passwordDigest = digest(password);
  let origin, closed = false, closing, inFlight = 0;
  const started = performance.now(), expiresAt = Date.now() + lifetimeMs;
  const upstreams = new Set();
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 60000, headersTimeout: 15000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const fail = (status, error) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      if (!res.writableEnded) res.end(JSON.stringify({ error }));
    };
    if (closed || performance.now() - started >= lifetimeMs) return fail(410, 'Temporary preview expired');
    if (!origin) return fail(503, 'Temporary preview is starting');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https')) return fail(403, 'Untrusted preview authority');
    if (!['GET', 'HEAD', 'POST', 'DELETE', 'PATCH', 'PUT'].includes(req.method)) return fail(405, 'Method not allowed');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) return fail(403, 'Same-origin mutation required');
    const target = req.url ?? '/';
    let parsed, decoded;
    try {
      if (!target.startsWith('/') || target.startsWith('//') || /[\\\r\n#]/.test(target)) throw Error();
      parsed = new URL(target, origin); decoded = decodeURIComponent(target.split('?')[0]);
      if (decoded.includes('\\') || decoded.split('/').includes('..') || /[\r\n]/.test(decoded)) throw Error();
      if (['token', 'password', 'access_token', 'authorization'].some(key => parsed.searchParams.has(key))) throw Error();
    } catch { return fail(400, 'Invalid request target'); }
    const api = parsed.pathname.startsWith('/api/');
    if (!api && (!publicAsset(parsed.pathname) || !['GET', 'HEAD'].includes(req.method))) return fail(404, 'Not found');
    if (api) {
      const header = req.headers.authorization;
      if (typeof header !== 'string' || header.length > 1024 || !header.startsWith('Bearer ') || !timingSafeEqual(digest(header.slice(7)), passwordDigest)) return fail(401, '访问口令无效或已过期');
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) return fail(413, 'Request too large');
    if (inFlight >= 64) return fail(429, 'Too many concurrent preview requests');
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('close', release); res.once('finish', release);
    const headers = { host: backend.host };
    for (const name of ['accept', 'content-type', 'content-length', 'x-filename']) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (api) headers.authorization = `Bearer ${backendToken}`;
    if (req.headers.origin) headers.origin = backend.origin;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: backend.port, method: req.method, path: target, headers, timeout: 70000 }, incoming => {
      if (closed) { incoming.destroy(); return; }
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.resume(); fail(502, 'Unexpected upstream redirect'); return; }
      for (const name of ['content-type', 'content-length', 'content-encoding', 'content-range', 'accept-ranges']) if (incoming.headers[name] !== undefined) res.setHeader(name, incoming.headers[name]);
      res.writeHead(incoming.statusCode ?? 502);
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.once('error', () => fail(502, 'Preview backend unavailable'));
    upstream.once('timeout', () => { upstream.destroy(); fail(504, 'Preview backend timed out'); });
    req.once('aborted', () => upstream.destroy());
    req.once('error', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_BODY) { req.unpipe(upstream); upstream.destroy(); fail(413, 'Request too large'); }
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.maxConnections = 80;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { void close(); void Promise.resolve().then(onExpire).catch(() => {}); }, lifetimeMs);
  async function close() {
    if (closing) return closing;
    closed = true; clearTimeout(timer); passwordDigest.fill(0);
    for (const upstream of upstreams) upstream.destroy();
    server.closeAllConnections();
    closing = new Promise(resolve => server.close(resolve)); return closing;
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`, expiresAt, close,
    setPublicOrigin(value) {
      if (closed || origin || !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(value)) throw Error('Pin exactly one Cloudflare temporary HTTPS origin');
      origin = value;
    },
  };
}
