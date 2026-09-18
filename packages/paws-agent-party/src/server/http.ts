import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssetError, AssetStore, MAX_UPLOAD_BODY_BYTES } from './assets.js';
import { isAuthorized, validateRequestAuthority } from './auth.js';
import { createPartyService } from './party.js';
import { RunService } from './runs.js';
import { RunError } from './runs.js';
import { createRealPawsSdk, safeError, type PawsSdkBoundary } from './sdk.js';
import { ROLE_IDS, type FollowUpInput, type RoleId, type StartInput } from '../contracts.js';
import { ProfileService, type AgentProfileInput } from '../group-chat/profiles.js';
import { GroupRoomService, type CreateGroupRoomInput, type GroupMessageInput } from '../group-chat/rooms.js';

export type PocServer = {
  url: string;
  close(): Promise<void>;
  hasActiveWork?(): boolean;
};

export type CreatePocServerOptions = {
  dataDir?: string;
  accessToken?: string;
  host?: string;
  port?: number;
  sdk?: PawsSdkBoundary;
  staticDir?: string;
  turnTimeoutMs?: number;
};

export async function createPocServer(options: CreatePocServerOptions = {}): Promise<PocServer> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error('The POC service may bind only to loopback.');
  const packageDir = resolvePackageDir();
  const dataDir = resolve(options.dataDir ?? join(packageDir, '.data'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const lock = await acquireLock(dataDir);
  let accessToken!: string;
  let sdk!: PawsSdkBoundary;
  let assets!: AssetStore;
  let party!: Awaited<ReturnType<typeof createPartyService>>;
  let runs!: RunService;
  let profiles!: ProfileService;
  let groups!: GroupRoomService;
  try {
    accessToken = options.accessToken ?? await loadOrCreateAccessToken(dataDir);
    sdk = options.sdk ?? createRealPawsSdk();
    assets = new AssetStore(dataDir);
    party = await createPartyService(dataDir, accessToken);
    runs = await RunService.create({ dataDir, sdk, assets, party: party.bus, turnTimeoutMs: options.turnTimeoutMs });
    profiles = await ProfileService.create(dataDir);
    groups = await GroupRoomService.create({ dataDir, sdk, assets, party: party.bus, profiles, turnTimeoutMs: options.turnTimeoutMs });
  } catch (error) {
    const cleanup: Promise<unknown>[] = [lock.release()];
    if (party) cleanup.push(party.close());
    if (sdk) cleanup.push(sdk.dispose());
    await Promise.allSettled(cleanup);
    throw error;
  }
  let closed = false;
  let listeningPort = 0;
  let accountTransition: symbol | null = null;
  const eventResponses = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      const status = error instanceof RunError || error instanceof AssetError || error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: safeError(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!validateRequestAuthority({ host: request.headers.host, origin: request.headers.origin, port: listeningPort })) {
      return sendJson(response, 403, { error: 'Untrusted request authority' });
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/') && !isAuthorized(request.headers.authorization, accessToken)) {
      return sendJson(response, 401, { error: 'Unauthorized' });
    }

    if (request.method === 'GET' && url.pathname === '/api/paws/status') return sendJson(response, 200, sdk.status());
    if (request.method === 'POST' && url.pathname === '/api/paws/link') {
      if (accountTransition || runs.hasActiveWork() || groups.hasActiveWork()) return sendJson(response, 409, { error: 'Stop active agent work before changing the Paws account.' });
      const transition = Symbol('link');
      accountTransition = transition;
      try {
        const body = await readJson(request, 16 * 1024);
        if (accountTransition !== transition) return sendJson(response, 409, { error: 'Paws account link was cancelled.' });
        if (typeof body.serverUrl !== 'string') return sendJson(response, 400, { error: 'serverUrl is required' });
        return sendJson(response, 200, await sdk.link(body.serverUrl));
      } finally {
        if (accountTransition === transition) accountTransition = null;
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/paws/recover') {
      if (accountTransition || runs.hasActiveWork() || groups.hasActiveWork()) return sendJson(response, 409, { error: 'Stop active agent work before changing the Paws account.' });
      const transition = Symbol('recover');
      accountTransition = transition;
      try {
        const body = await readJson(request, 16 * 1024);
        if (accountTransition !== transition) return sendJson(response, 409, { error: 'Paws account recovery was cancelled.' });
        if (typeof body.serverUrl !== 'string' || typeof body.recoveryCode !== 'string') return sendJson(response, 400, { error: 'serverUrl and recoveryCode are required' });
        return sendJson(response, 200, await sdk.recover(body.serverUrl, body.recoveryCode));
      } finally {
        if (accountTransition === transition) accountTransition = null;
      }
    }
    if (request.method === 'DELETE' && url.pathname === '/api/paws/link') {
      if (runs.hasActiveWork() || groups.hasActiveWork()) return sendJson(response, 409, { error: 'Stop active agent work before changing the Paws account.' });
      const transition = Symbol('disconnect');
      accountTransition = transition;
      try {
        await sdk.disconnect();
        return sendJson(response, 200, sdk.status());
      } finally {
        if (accountTransition === transition) accountTransition = null;
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/paws/machines') {
      return sendJson(response, 200, { machines: await sdk.machines() });
    }
    const machineDirectoriesMatch = url.pathname.match(/^\/api\/paws\/machines\/([^/]+)\/directories$/);
    if (request.method === 'GET' && machineDirectoriesMatch) return sendJson(response, 200, await sdk.browseDirectory(decodeURIComponent(machineDirectoriesMatch[1]), url.searchParams.get('path') ?? undefined));
    const machineConfigurationMatch = url.pathname.match(/^\/api\/paws\/machines\/([^/]+)\/configuration$/);
    if (request.method === 'GET' && machineConfigurationMatch) return sendJson(response, 200, await sdk.configuration(decodeURIComponent(machineConfigurationMatch[1]), url.searchParams.get('sessionId') ?? undefined));
    if (request.method === 'GET' && url.pathname === '/api/group-chat/agents') return sendJson(response, 200, { agents: profiles.list() });
    if (request.method === 'POST' && url.pathname === '/api/group-chat/agents') return sendJson(response, 200, await profiles.create(await readJson(request, 32 * 1024) as AgentProfileInput));
    const agentProfileMatch = url.pathname.match(/^\/api\/group-chat\/agents\/([^/]+)$/);
    if (request.method === 'PATCH' && agentProfileMatch) return sendJson(response, 200, await profiles.update(decodeURIComponent(agentProfileMatch[1]), await readJson(request, 32 * 1024) as AgentProfileInput));
    if (request.method === 'GET' && url.pathname === '/api/group-chat/rooms') return sendJson(response, 200, { rooms: groups.list() });
    if (request.method === 'POST' && url.pathname === '/api/group-chat/rooms') {
      if (accountTransition) return sendJson(response, 409, { error: 'Wait for the Paws account transition to finish.' });
      return sendJson(response, 200, await groups.create(await readJson(request, 64 * 1024) as CreateGroupRoomInput));
    }
    const groupEventsMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/events$/);
    if (request.method === 'GET' && groupEventsMatch) {
      const id = decodeURIComponent(groupEventsMatch[1]); groups.get(id);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      eventResponses.add(response);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let blocked = false; let dirty = false; let ended = false;
      const write = () => {
        timer = undefined;
        if (ended || blocked) { dirty = true; return; }
        try { dirty = false; blocked = !response.write(`data: ${JSON.stringify(groups.get(id))}\n\n`); }
        catch (error) { if (error instanceof RunError && error.status === 404) { finish(); response.end(); } else throw error; }
      };
      const schedule = () => { dirty = true; if (!timer && !blocked && !ended) timer = setTimeout(write, 100); };
      const unsubscribe = groups.subscribe(id, schedule);
      const unsubscribeDeletion = groups.subscribeDeletion(id, () => { finish(); response.end(); });
      const finish = () => { if (ended) return; ended = true; if (timer) clearTimeout(timer); clearInterval(heartbeat); unsubscribe(); unsubscribeDeletion(); eventResponses.delete(response); };
      response.on('drain', () => { blocked = false; if (dirty) schedule(); });
      const heartbeat = setInterval(() => { if (!blocked && !ended) blocked = !response.write(': heartbeat\n\n'); }, 15_000);
      response.once('close', finish);
      write(); return;
    }
    const groupRoomMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)$/);
    if (request.method === 'GET' && groupRoomMatch) return sendJson(response, 200, groups.get(decodeURIComponent(groupRoomMatch[1])));
    if (request.method === 'DELETE' && groupRoomMatch) { await groups.delete(decodeURIComponent(groupRoomMatch[1])); return sendJson(response, 200, { ok: true }); }
    if (request.method === 'PATCH' && groupRoomMatch) {
      const body = await readJson(request, 4096);
      return sendJson(response, 200, await groups.configure(decodeURIComponent(groupRoomMatch[1]), body));
    }
    const groupMembersMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/members$/);
    if (request.method === 'POST' && groupMembersMatch) return sendJson(response, 200, await groups.addMembers(decodeURIComponent(groupMembersMatch[1]), await readJson(request, 64 * 1024) as never));
    const groupMessageMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/messages$/);
    if (request.method === 'POST' && groupMessageMatch) {
      if (accountTransition) return sendJson(response, 409, { error: 'Wait for the Paws account transition to finish.' });
      return sendJson(response, 200, await groups.message(decodeURIComponent(groupMessageMatch[1]), await readJson(request, 128 * 1024) as GroupMessageInput));
    }
    const groupStopMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/stop$/);
    const groupDebateStopMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/debate\/stop$/);
    if (request.method === 'POST' && groupDebateStopMatch) { await readJson(request, 1024); return sendJson(response, 200, await groups.stopDebate(decodeURIComponent(groupDebateStopMatch[1]))); }
    if (request.method === 'POST' && groupStopMatch) { await readJson(request, 1024); return sendJson(response, 200, await groups.stop(decodeURIComponent(groupStopMatch[1]))); }
    const groupAgentMessagesMatch = url.pathname.match(/^\/api\/group-chat\/rooms\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (request.method === 'GET' && groupAgentMessagesMatch) {
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return sendJson(response, 400, { error: 'afterSeq must be a non-negative integer.' });
      return sendJson(response, 200, await groups.agentMessages(decodeURIComponent(groupAgentMessagesMatch[1]), decodeURIComponent(groupAgentMessagesMatch[2]), afterSeq));
    }
    if (request.method === 'POST' && url.pathname === '/api/assets') {
      const bytes = await readBytes(request, MAX_UPLOAD_BODY_BYTES);
      try {
        const ref = await assets.put({
          name: firstHeader(request.headers['x-filename']),
          mimeType: String(request.headers['content-type'] ?? '').split(';')[0].trim(),
          bytes,
        });
        return sendJson(response, 200, ref);
      } catch (error) {
        if (error instanceof AssetError) return sendJson(response, error.status, { error: error.message });
        throw error;
      }
    }
    const assetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
    if (request.method === 'GET' && assetMatch) {
      const id = decodeURIComponent(assetMatch[1]);
      const ref = await assets.get(id);
      if (!ref) return sendJson(response, 404, { error: 'Unknown image asset.' });
      response.writeHead(200, { 'content-type': ref.mimeType, 'content-length': ref.size, 'x-content-type-options': 'nosniff' });
      response.end(await assets.read(id));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/consultations') {
      return sendJson(response, 200, { runs: runs.list() });
    }
    if (request.method === 'POST' && url.pathname === '/api/consultations') {
      const body = await readJson(request, 128 * 1024) as StartInput;
      if (accountTransition) return sendJson(response, 409, { error: 'Wait for the Paws account transition to finish.' });
      return sendJson(response, 200, await runs.start(body));
    }
    const consultationMatch = url.pathname.match(/^\/api\/consultations\/([^/]+)$/);
    if (request.method === 'GET' && consultationMatch) {
      return sendJson(response, 200, runs.get(decodeURIComponent(consultationMatch[1])));
    }
    const stopMatch = url.pathname.match(/^\/api\/consultations\/([^/]+)\/stop$/);
    if (request.method === 'POST' && stopMatch) {
      await readJson(request, 1024);
      return sendJson(response, 200, await runs.stop(decodeURIComponent(stopMatch[1])));
    }
    const followupMatch = url.pathname.match(/^\/api\/consultations\/([^/]+)\/messages$/);
    if (request.method === 'POST' && followupMatch) {
      const body = await readJson(request, 128 * 1024) as unknown as FollowUpInput;
      if (accountTransition) return sendJson(response, 409, { error: 'Wait for the Paws account transition to finish.' });
      await runs.followUp(
        decodeURIComponent(followupMatch[1]),
        body,
      );
      return sendJson(response, 200, { accepted: true });
    }
    const agentMessagesMatch = url.pathname.match(/^\/api\/consultations\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (request.method === 'GET' && agentMessagesMatch) {
      const role = decodeURIComponent(agentMessagesMatch[2]) as RoleId;
      if (!ROLE_IDS.includes(role)) return sendJson(response, 400, { error: 'Unknown role.' });
      const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return sendJson(response, 400, { error: 'afterSeq must be a non-negative integer.' });
      return sendJson(response, 200, await runs.agentMessages(decodeURIComponent(agentMessagesMatch[1]), role, afterSeq));
    }

    if (url.pathname.startsWith('/api/')) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readBytes(request, 1_100_000);
      const partyRequest = new Request(url, {
        method: request.method,
        headers: nodeHeaders(request),
        ...(body ? { body: Buffer.from(body).toString('utf8') } : {}),
      });
      const partyResponse = await party.api(partyRequest);
      if (partyResponse) return sendFetchResponse(response, partyResponse);
      return sendJson(response, 404, { error: 'Not found' });
    }
    return serveStatic(response, url.pathname, options.staticDir ?? join(packageDir, 'dist', 'web'));
  }

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, host, () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to resolve listening address.');
    listeningPort = address.port;
  } catch (error) {
    await Promise.allSettled([party.close(), sdk.dispose(), lock.release()]);
    throw error;
  }

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${listeningPort}`,
    hasActiveWork: () => runs.hasActiveWork() || groups.hasActiveWork(),
    async close() {
      if (closed) return;
      closed = true;
      for (const response of eventResponses) response.end();
      await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
      await Promise.allSettled([runs.close(), groups.close()]);
      await Promise.allSettled([party.close(), sdk.dispose()]);
      await lock.release();
    },
  };
}

async function acquireLock(dataDir: string): Promise<{ release(): Promise<void> }> {
  const path = join(dataDir, 'service.lock');
  const nonce = `${process.pid}:${randomUUID()}`;
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Data directory is already locked: ${dataDir}`);
    throw error;
  }
  await handle.writeFile(nonce);
  await handle.close();
  return {
    async release() {
      try {
        if (await readFile(path, 'utf8') === nonce) await rm(path, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

async function loadOrCreateAccessToken(dataDir: string): Promise<string> {
  const path = join(dataDir, 'access-token');
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('base64url');
  await writeFile(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

async function readJson(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, limit);
  try { return bytes.byteLength ? JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown> : {}; }
  catch { throw new HttpError(400, 'Invalid JSON body.'); }
}

async function readBytes(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(length) && length > limit) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.byteLength, 'cache-control': 'no-store' });
  response.end(bytes);
}

async function sendFetchResponse(response: ServerResponse, upstream: Response): Promise<void> {
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function serveStatic(response: ServerResponse, pathname: string, staticDir: string): Promise<void> {
  const root = resolve(staticDir);
  const requested = resolve(root, `.${normalize(pathname === '/' ? '/index.html' : pathname)}`);
  if (!requested.startsWith(`${root}/`)) return sendJson(response, 404, { error: 'Not found' });
  try {
    if (!(await stat(requested)).isFile()) return sendJson(response, 404, { error: 'Not found' });
    response.writeHead(200, { 'content-type': staticMime(requested), 'x-content-type-options': 'nosniff' });
    createReadStream(requested).pipe(response);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sendJson(response, 404, { error: 'Not found' });
    throw error;
  }
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function isLoopback(host: string): boolean { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }

function staticMime(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function resolvePackageDir(): string {
  const moduleDir = fileURLToPath(new URL('.', import.meta.url));
  return moduleDir.endsWith(`${join('src', 'server')}/`) || moduleDir.endsWith(`${join('src', 'server')}\\`)
    ? resolve(moduleDir, '..', '..')
    : resolve(moduleDir, '..');
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const dataDir = process.env.PAWS_AGENT_PARTY_DATA_DIR;
  createPocServer({ ...(dataDir ? { dataDir } : {}) }).then(server => {
    const tokenPath = join(resolve(dataDir ?? join(resolvePackageDir(), '.data')), 'access-token');
    console.log(`Paws AgentParty service: ${server.url}`);
    console.log(`Access token file: ${tokenPath}`);
    const stop = () => void server.close().finally(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => {
    console.error(`Unable to start Paws AgentParty service: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
