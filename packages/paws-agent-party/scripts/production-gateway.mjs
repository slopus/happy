import { createServer, request } from 'node:http';

export const PRODUCTION_ORIGIN = 'https://47.115.228.20:8443';
const PREFIX = '/agent-party/';
const MAX_BODY = 11 * 1024 * 1024;

/** Loopback-only Caddy upstream. No credential injection: API bearer auth remains
 * enforced by the application. External authority is checked before rewriting. */
export async function createProductionGateway({ backendUrl, port = 3847, revision }) {
  if (revision !== undefined && !/^[a-f0-9]{40}$/.test(revision)) throw Error('Invalid revision');
  const backend = new URL(backendUrl);
  if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1' || !backend.port || backend.pathname !== '/' || backend.search || backend.hash || backend.username || backend.password) throw Error('Fixed loopback backend required');
  const upstreams = new Set();
  let closed = false, closing, inFlight = 0;
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 60000, headersTimeout: 15000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const fail = (status, error) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error }));
    };
    if (closed) return fail(503, 'Service stopping');
    if (req.headers.host !== new URL(PRODUCTION_ORIGIN).host || (req.headers.origin && req.headers.origin !== PRODUCTION_ORIGIN)) return fail(403, 'Untrusted authority');
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) return fail(405, 'Method not allowed');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== PRODUCTION_ORIGIN) return fail(403, 'Same-origin mutation required');
    const target = req.url ?? '/';
    try {
      const decoded = decodeURIComponent(target.split('?')[0]);
      if (!target.startsWith('/') || target.startsWith('//') || /[\\\r\n#]/.test(target) || /[\\\r\n]/.test(decoded) || decoded.split('/').some(segment => segment === '..' || segment === '.')) throw Error();
      const parsed = new URL(target, PRODUCTION_ORIGIN);
      if (['token', 'password', 'access_token', 'authorization'].some(key => parsed.searchParams.has(key))) throw Error();
    } catch { return fail(400, 'Invalid request target'); }
    if (target === '/agent-party') { res.writeHead(308, { location: PREFIX }); res.end(); return; }
    if (!target.startsWith(PREFIX)) return fail(404, 'Not found');
    if (target === PREFIX + 'revision' && ['GET', 'HEAD'].includes(req.method) && revision) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : revision + '\n'); return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY) return fail(413, 'Request too large');
    if (inFlight >= 64) return fail(429, 'Too many requests');
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('close', release); res.once('finish', release);
    const headers = { host: backend.host };
    for (const name of ['authorization', 'accept', 'content-type', 'content-length', 'x-filename']) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (req.headers.origin) headers.origin = backend.origin;
    const upstream = request(backend, { path: '/' + target.slice(PREFIX.length), method: req.method, headers, timeout: 70000 }, incoming => {
      if (closed) { incoming.destroy(); return; }
      if (incoming.statusCode >= 300 && incoming.statusCode < 400) { incoming.resume(); fail(502, 'Unexpected upstream redirect'); return; }
      for (const name of ['content-type', 'content-length', 'content-encoding']) if (incoming.headers[name] !== undefined) res.setHeader(name, incoming.headers[name]);
      res.writeHead(incoming.statusCode ?? 502);
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.once('error', () => fail(502, 'Backend unavailable'));
    upstream.once('timeout', () => { fail(504, 'Backend timed out'); upstream.destroy(); });
    req.once('aborted', () => upstream.destroy()); req.once('error', () => upstream.destroy());
    res.once('close', () => upstream.destroy());
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BODY) { req.unpipe(upstream); fail(413, 'Request too large'); upstream.destroy(); } });
    req.pipe(upstream);
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
  server.maxConnections = 80;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (closing) return closing;
      closed = true;
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      closing = new Promise(resolve => server.close(resolve)); return closing;
    },
  };
}
