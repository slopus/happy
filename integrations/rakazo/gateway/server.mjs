import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { GatewayState, NativeSessionCache, bootstrapNative, sameSecret } from './state.mjs';

const loader = readFileSync(new URL('./loader.js', import.meta.url));
const worker = readFileSync(new URL('./bridge-sw.js', import.meta.url));
const HOP_HEADERS = new Set(['host', 'cookie', 'authorization', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-paws-rakazo-session', 'x-paws-bridge-secret', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']);
const AUTH_READ = new Set(['/api/auth/get-session', '/api/auth/capabilities']);

export function origin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Expected a root HTTP(S) origin');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only loopback development may use HTTP');
  return url.origin;
}

function privateUpstream(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Rakazo upstream must be a private loopback root URL');
  return url;
}

function assertSeparateOrigins(publicOrigin, parentOrigins) {
  if (parentOrigins.some((parent) => origin(parent) === origin(publicOrigin))) throw new Error('Bots runtime must use a separate origin from every Paws parent');
}

// Match the native sealed-capability envelope, not arbitrary /novnc paths. The
// native authority remains responsible for decrypting it and checking lifecycle.
export function sealedScreenPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.replace(/^\/{2,}/, '/');
  if (!/^\/novnc\/session\/(view|control)\/\d+\.[A-Za-z0-9_-]+(?:\/[^?#\\]*)?(?:\?[^#\\]*)?$/.test(path)) return null;
  if (/%2f|%5c/i.test(path.split('?', 1)[0])) return null;
  return path;
}

function upstreamUrl(base, pathname, search) {
  const target = new URL(base);
  const expectedOrigin = target.origin;
  target.pathname = pathname;
  target.search = search;
  target.hash = '';
  if (target.origin !== expectedOrigin) throw new Error('Upstream origin changed');
  return target;
}

export function configFromEnv(env = process.env) {
  const secretPath = env.PAWS_BOTS_IDENTITY_SECRET_FILE;
  if (!secretPath) throw new Error('PAWS_BOTS_IDENTITY_SECRET_FILE is required');
  const info = statSync(secretPath);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error('Identity secret must be a private 0600 file');
  const identitySecret = readFileSync(secretPath, 'utf8').trim();
  if (identitySecret.length < 32 || (env.PAWS_BOTS_BRIDGE_SECRET?.length ?? 0) < 32) throw new Error('Gateway secrets must contain at least 32 characters');
  const parentOrigins = (env.PAWS_BOTS_ALLOWED_PARENT_ORIGINS ?? '').split(',').filter(Boolean).map((value) => origin(value.trim()));
  if (!parentOrigins.length) throw new Error('PAWS_BOTS_ALLOWED_PARENT_ORIGINS is required');
  const publicOrigin = origin(env.PAWS_BOTS_PUBLIC_ORIGIN);
  assertSeparateOrigins(publicOrigin, parentOrigins);
  return {
    webUrl: privateUpstream(env.RAKAZO_WEB_URL),
    apiUrl: privateUpstream(env.RAKAZO_API_URL),
    authOrigin: origin(env.RAKAZO_AUTH_ORIGIN ?? env.PAWS_BOTS_PUBLIC_ORIGIN),
    publicOrigin,
    parentOrigins,
    bridgeSecret: env.PAWS_BOTS_BRIDGE_SECRET,
    identitySecret,
    realm: env.PAWS_BOTS_IDENTITY_REALM ?? 'paws',
  };
}

export function transformShell(html) {
  let count = 0;
  const result = html.replace(/<script\b([^>]*?)\btype\s*=\s*(["'])module\2([^>]*)>/gi, (_match, before, _quote, after) => {
    count++;
    return `<script${before}type="application/paws-module"${after}>`;
  });
  if (!count) throw new Error('Rakazo HTML has no native module entry');
  return result.replace(/<head\b[^>]*>/i, (head) => `${head}<script src="/__paws/loader.js"></script>`)
    .replace(/<body\b[^>]*>/i, (body) => `${body}<p id="paws-bootstrap-status" role="status">Connecting to Paws Bots…</p>`);
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function requestHeaders(req, config, lease) {
  const headers = {};
  const connectionTokens = String(req.headers.connection ?? '').toLowerCase().split(',').map((value) => value.trim());
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(name) && !connectionTokens.includes(name) && !name.startsWith('x-forwarded-') && value !== undefined) headers[name] = value;
  }
  headers['accept-encoding'] = 'identity';
  headers.origin = config.authOrigin;
  if (lease) headers.cookie = lease.cookie;
  return headers;
}

function responseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!['set-cookie', 'connection', 'transfer-encoding'].includes(name) && !name.startsWith('access-control-') && value !== undefined) headers[name] = value;
  }
  return headers;
}

export function createGateway(config, dependencies = {}) {
  assertSeparateOrigins(config.publicOrigin, config.parentOrigins);
  const state = dependencies.state ?? new GatewayState();
  const sessionCache = dependencies.sessionCache ?? new NativeSessionCache();
  const bootstrap = dependencies.bootstrap ?? ((subject) => bootstrapNative({ ...config, subject, secret: config.identitySecret, sessionCache }));
  const gateway = http.createServer(async (req, res) => {
    const disconnect = new AbortController();
    res.once('close', () => { if (!res.writableEnded) disconnect.abort(new Error('Client disconnected')); });
    try {
      const requestPath = sealedScreenPath(req.url) ?? req.url;
      const url = new URL(requestPath, config.publicOrigin);
      // Absolute-form proxy requests must not turn this into a generic forward proxy.
      if (!requestPath?.startsWith('/') || requestPath.startsWith('//') || url.pathname.startsWith('//') || url.origin !== config.publicOrigin || /%2f|%5c/i.test(url.pathname) || url.pathname.includes('\\')) return json(res, 400, { error: 'Invalid path' });
      const pathname = decodeURIComponent(url.pathname);
      if (url.pathname === '/__paws/bootstrap') {
        if (req.method !== 'POST' || !sameSecret(req.headers['x-paws-bridge-secret'], config.bridgeSecret)) return json(res, 404, { error: 'Not found' });
        const input = await readJson(req);
        const parentOrigin = origin(input.parentOrigin);
        if (!config.parentOrigins.includes(parentOrigin) || typeof input.subject !== 'string' || !input.subject || input.subject.length > 256 || !['web', 'native'].includes(input.platform ?? 'web') || (input.locale !== undefined && !['en', 'zh'].includes(input.locale)) || (input.appearance !== undefined && !['light', 'dark', 'system'].includes(input.appearance))) return json(res, 400, { error: 'Invalid launch' });
        const identity = await state.bootstrap(input.subject, () => bootstrap(input.subject), disconnect.signal);
        disconnect.signal.throwIfAborted();
        return json(res, 200, { runtimeUrl: `${config.publicOrigin}/`, ...state.issue(identity, { subject: input.subject, parentOrigin, platform: input.platform ?? 'web', locale: input.locale, appearance: input.appearance }) });
      }
      if (url.pathname === '/__paws/redeem') {
        if (req.method !== 'POST' || req.headers.origin !== config.publicOrigin) return json(res, 403, { error: 'Invalid origin' });
        const input = await readJson(req);
        if (typeof input.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.ticket)) return json(res, 401, { error: 'Invalid ticket' });
        let parentOrigin = input.parentOrigin;
        if (input.platform === 'native') {
          if (parentOrigin !== config.publicOrigin) return json(res, 403, { error: 'Invalid native origin' });
          parentOrigin = state.tickets.get(input.ticket)?.parentOrigin;
        }
        const result = state.redeem(input.ticket, parentOrigin, input.platform);
        return result ? json(res, 200, result) : json(res, 401, { error: 'Invalid or expired ticket' });
      }
      if (url.pathname === '/__paws/loader.js' || url.pathname === '/sw.js') {
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'service-worker-allowed': '/', 'x-content-type-options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : url.pathname === '/sw.js' ? worker : loader);
      }
      if (url.pathname.startsWith('/__paws/')) return json(res, 404, { error: 'Not found' });
      const privateRoute = /^\/(?:api|rpc)(?:\/|$)/.test(pathname);
      const lease = state.lease(req.headers['x-paws-rakazo-session']);
      if (privateRoute && !lease) return json(res, 401, { error: 'A Paws Bots client lease is required' });
      if (pathname.startsWith('/api/auth/') && !AUTH_READ.has(pathname)) {
        if (pathname === '/api/auth/sign-out' && req.method === 'POST') {
          state.revoke(req.headers['x-paws-rakazo-session']);
          return json(res, 200, { success: true });
        }
        return json(res, 403, { error: 'Account authentication is managed by Paws' });
      }
      // noVNC's sealed, expiring capability is authorized by Rakazo's full web server.
      // Never attach a fallback user cookie to it or weaken its validation.
      const target = privateRoute ? config.apiUrl : config.webUrl;
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request(upstreamUrl(target, url.pathname, url.search), {
        method: req.method, headers: requestHeaders(req, config, privateRoute ? lease : undefined),
      });
      let completed = false;
      let unwatchLease;
      res.once('close', () => { unwatchLease?.(); if (!completed) upstream.destroy(); });
      req.once('aborted', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) json(res, 502, { error: 'Rakazo runtime is unavailable' }); else res.destroy(); });
      if (privateRoute) unwatchLease = state.watchLease(req.headers['x-paws-rakazo-session'], () => { upstream.destroy(); res.destroy(); });
      upstream.once('response', (response) => {
        const headers = responseHeaders(response);
        if (privateRoute || pathname.startsWith('/novnc/')) headers['cache-control'] = 'no-store';
        const html = String(headers['content-type'] ?? '').includes('text/html');
        if (!html || req.method === 'HEAD') {
          res.writeHead(response.statusCode ?? 502, headers);
          response.once('end', () => { completed = true; });
          response.on('error', () => res.destroy());
          response.pipe(res);
          return;
        }
        const chunks = [];
        let length = 0;
        response.on('data', (chunk) => { length += chunk.length; if (length > 5 * 1024 * 1024) { response.destroy(); res.destroy(); } else chunks.push(chunk); });
        response.once('error', () => res.destroy());
        response.once('end', () => {
          try {
            let body = Buffer.concat(chunks);
            const encoding = headers['content-encoding'];
            if (encoding === 'gzip') body = gunzipSync(body);
            else if (encoding === 'br') body = brotliDecompressSync(body);
            else if (encoding === 'deflate') body = inflateSync(body);
            else if (encoding) throw new Error('Unsupported document encoding');
            let text = body.toString('utf8');
            if (/<div\b[^>]*\bid=["']root["']/.test(text)) {
              text = transformShell(text);
              delete headers['x-frame-options'];
              const csp = String(headers['content-security-policy'] ?? "default-src 'self'; script-src 'self'; connect-src 'self'");
              headers['content-security-policy'] = `${csp.replace(/(?:^|;)\s*frame-ancestors\s+[^;]*/gi, '')}; frame-ancestors 'self' ${config.parentOrigins.join(' ')}`;
            }
            // Capabilities and native private documents must not survive sign-out via caches.
            headers['cache-control'] = 'no-store';
            for (const name of ['content-length', 'content-encoding', 'etag', 'last-modified']) delete headers[name];
            completed = true;
            res.writeHead(response.statusCode ?? 502, headers);
            res.end(text);
          } catch { json(res, 502, { error: 'Rakazo document could not be embedded' }); }
        });
      });
      req.pipe(upstream);
    } catch {
      if (!disconnect.signal.aborted) json(res, 503, { error: 'Paws Bots could not start. Check the private Rakazo runtime configuration.' });
    }
  });
  gateway.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    // SWs cannot intercept WS. Only the existing sealed-capability noVNC path is exposed.
    const path = sealedScreenPath(req.url);
    // Native screen iframes intentionally omit allow-same-origin. Their browser
    // WebSocket Origin is the literal "null"; only sealed screen paths accept it.
    if (!path || ![config.publicOrigin, 'null'].includes(req.headers.origin)) { socket.destroy(); return; }
    const parsed = new URL(path, config.publicOrigin);
    if (!sealedScreenPath(`${parsed.pathname}${parsed.search}`)) { socket.destroy(); return; }
    const target = upstreamUrl(config.webUrl, parsed.pathname, parsed.search);
    const transport = target.protocol === 'https:' ? https : http;
    const headers = requestHeaders(req, config);
    headers.connection = 'Upgrade'; headers.upgrade = 'websocket';
    // The native upstream uses its own configured auth origin; it still validates
    // the sealed capability and active control lease independently of this header.
    headers.origin = config.authOrigin;
    const upstream = transport.request(target, { method: 'GET', headers });
    upstream.on('upgrade', (response, peer, extra) => {
      peer.on('error', () => socket.destroy());
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([name]) => !['set-cookie', 'access-control-allow-origin'].includes(name)).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head);
      if (extra.length) socket.write(extra);
      socket.pipe(peer); peer.pipe(socket);
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.end();
  });
  return { server: gateway, state, sessionCache };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const config = configFromEnv();
  const port = Number(process.env.PAWS_BOTS_GATEWAY_PORT ?? 3490);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  const { server } = createGateway(config);
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Paws Bots private gateway listening on 127.0.0.1:${port}\n`));
}
