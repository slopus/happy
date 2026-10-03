import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { readDaemonControlPort } from './browserClient';

vi.mock('./browserClient', () => ({ readDaemonControlPort: vi.fn() }));
describe.skipIf(!['darwin', 'linux'].includes(process.platform) || (process.platform === 'linux' && process.env.HAPPY_SCOPE_NATIVE_LINUX !== '1') || process.env.HAPPY_SCOPE_NATIVE_CODEX !== '1')('native Codex scope receipt', () => {
  it('confirms only after a real protected app-server initializes and exits it by EOF', async () => {
    const fixture = await mkdtemp(join(process.cwd(), '.scope-codex-'));
    const codexHome = join(fixture, 'codex'), home = join(fixture, 'home'); await mkdir(codexHome); await mkdir(home);
    const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', extraWritePaths: [fixture] });
    const token = randomUUID(), digest = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    let confirmed = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      confirmed = request.url === '/session-write-scope/confirm' && request.headers.authorization === 'Bearer fixture'
        && body.token === token && body.digest === digest && body.sessionId === 'fixture-session' && body.pid === process.pid;
      response.writeHead(confirmed ? 200 : 403, { 'Content-Type': 'application/json' }); response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    vi.mocked(readDaemonControlPort).mockResolvedValue({ port: (server.address() as { port: number }).port, controlSecret: 'fixture' });
    const overrides = { CODEX_HOME: codexHome, HOME: home, CLAUDE_CONFIG_DIR: join(fixture, 'claude'), HAPPY_WRITE_SCOPE_APPLY_TOKEN: token,
      HAPPY_WRITE_SCOPE_PROFILE_DIGEST: digest, APLUS_SESSION_ID: 'fixture-session' };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    const client = new CodexAppServerClient(config, undefined, undefined, 'mandatory', []);
    try {
      await client.connect();
      expect(client.isConnected).toBe(true); expect(confirmed).toBe(true);
      expect(process.env.HAPPY_WRITE_SCOPE_APPLY_TOKEN).toBeUndefined();
      const exit = await client.endInputAndAwaitExit(5000);
      expect(exit.exited).toBe(true);
    } finally {
      await client.disconnect();
      for (const key of Object.keys(overrides)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  }, 20000);
});
