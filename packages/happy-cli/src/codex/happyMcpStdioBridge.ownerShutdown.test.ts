import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const cliRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function deadline<T>(promise: Promise<T>, label: string, milliseconds = 4_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function localMcpStub({ holdInitialization = false } = {}) {
  const initialized = deferred<void>();
  const initializationClosed = deferred<void>();
  const streamOpened = deferred<void>();
  const streamClosed = deferred<void>();
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.once('close', () => streamClosed.resolve());
      streamOpened.resolve();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(message.method);
    const reply = (result: unknown, headers = {}) => {
      response.writeHead(200, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      response.once('close', () => initializationClosed.resolve());
      initialized.resolve();
      if (holdInitialization) return;
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'local-stub', version: '1' } },
        { 'mcp-session-id': 'synthetic-owner-shutdown' });
    } else if (message.method === 'tools/call') {
      reply({ content: [{ type: 'text', text: 'Local stub only; no business operation.' }] });
    } else {
      response.writeHead(202); response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local stub did not listen');
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  cleanups.push(async () => { server.closeAllConnections(); await stop(); });
  return { url: `http://127.0.0.1:${address.port}/mcp`, requests, initialized, initializationClosed, streamOpened, streamClosed, stop };
}

function spawnBridge(url: string) {
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), join(cliRoot, 'src/codex/happyMcpStdioBridge.ts'), '--url', url],
    { cwd: cliRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const pending = new Map<number, ReturnType<typeof deferred<any>>>();
  void closed.then(() => {
    for (const response of pending.values()) response.reject(new Error('Dedicated test bridge closed'));
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.resolve(message);
    pending.delete(message.id);
  });
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (id: number, method: string, params: unknown) => {
    const response = deferred<any>(); pending.set(id, response);
    send({ jsonrpc: '2.0', id, method, params });
    return deadline(response.promise, `stdio response ${id}`);
  };
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await deadline(closed, 'dedicated test bridge cleanup'); lines.close();
  });
  return { child, closed, stderr: () => stderr, request, send,
    async initialize() {
      const response = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'owner-shutdown-test', version: '1' } });
      expect(response.error).toBeUndefined();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    callTool: (id: number) => request(id, 'tools/call', { name: 'agent_roles', arguments: { action: 'list' } }),
  };
}

describe('Happy MCP stdio bridge owner shutdown', () => {
  it('shares the first HTTP connection and closes its SSE client and stdio process when owner stdin ends', async () => {
    const stub = await localMcpStub();
    const bridge = spawnBridge(stub.url);
    await bridge.initialize();
    const replies = await Promise.all([bridge.callTool(2), bridge.callTool(3)]);
    for (const reply of replies) expect(reply.result?.isError).not.toBe(true);
    await deadline(stub.streamOpened.promise, 'local HTTP SSE handshake');
    bridge.child.stdin.end();
    expect(await deadline(bridge.closed, 'bridge exit after owner EOF')).toEqual({ code: 0, signal: null });
    await deadline(stub.streamClosed.promise, 'HTTP client stream close');
    await deadline(stub.stop(), 'local MCP server close');
    expect(stub.requests.filter(method => method === 'initialize')).toHaveLength(1);
    expect(bridge.stderr()).toBe('');
  }, 12_000);

  it('aborts a first HTTP initialization still awaiting its local server reply after owner stdin ends', async () => {
    const stub = await localMcpStub({ holdInitialization: true });
    const bridge = spawnBridge(stub.url);
    await bridge.initialize();
    const pending = bridge.callTool(2).catch(() => undefined);
    await deadline(stub.initialized.promise, 'pending local HTTP initialization');
    bridge.child.stdin.end();
    expect(await deadline(bridge.closed, 'bridge exit during first HTTP connection')).toEqual({ code: 0, signal: null });
    await deadline(stub.initializationClosed.promise, 'pending HTTP request abort');
    await deadline(stub.stop(), 'local MCP server close');
    await pending;
    expect(stub.requests).toEqual(['initialize']);
    expect(bridge.stderr()).toBe('');
  }, 12_000);

  it('handles owner EOF during stdio initialization without opening an HTTP client', async () => {
    const stub = await localMcpStub();
    const bridge = spawnBridge(stub.url);
    bridge.child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'early-owner-shutdown', version: '1' },
    } }) + '\n');
    expect(await deadline(bridge.closed, 'bridge exit during stdio initialization')).toEqual({ code: 0, signal: null });
    await deadline(stub.stop(), 'unused local MCP server close');
    expect(stub.requests).toEqual([]);
    expect(bridge.stderr()).toBe('');
  }, 12_000);
});
