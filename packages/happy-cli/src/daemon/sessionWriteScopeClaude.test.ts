import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { prepareSessionWriteScopeClaude } from './sessionWriteScopeClaude';
import { readDaemonControlPort } from './browserClient';

vi.mock('./browserClient', () => ({ readDaemonControlPort: vi.fn() }));
it('refuses disabled, checkpoint and unsupported-platform Claude profiles before provider creation', async () => {
  for (const input of [
    { config: undefined }, { config: SandboxConfigSchema.parse({ enabled: false }) },
    { config: SandboxConfigSchema.parse({}), platform: 'win32' as const },
    { config: SandboxConfigSchema.parse({ checkpointProtection: { secretPatterns: [], maxFileBytes: 1000, maxFiles: 10, maxTotalBytes: 10000 } }) },
  ]) await expect(prepareSessionWriteScopeClaude({ path: process.cwd(), confirmation: null, ...input })).rejects.toThrow('SCOPE_CLAUDE_UNSUPPORTED');
});

describe.skipIf(!['darwin', 'linux'].includes(process.platform) || process.env.HAPPY_SCOPE_NATIVE_CLAUDE !== '1')('actual Claude protected profile', () => {
  it('initializes without a model turn, binds receipt, and protects every subsequent SDK spawn', async () => {
    const fixture = await realpath(await mkdtemp(join(process.cwd(), '.scope-claude-')));
    const project = join(fixture, 'project'), root = join(fixture, 'tools'), sibling = join(fixture, 'sibling'), home = join(fixture, 'home');
    await Promise.all([project, root, sibling, home].map(path => mkdir(path)));
    await symlink(sibling, join(root, 'escape'));
    const config = SandboxConfigSchema.parse({ sessionIsolation: 'strict', extraWritePaths: [root] });
    const confirmation = { token: 'private-fixture', sessionId: 'fixture-session', digest: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
    let received = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received = body.token === confirmation.token && body.digest === confirmation.digest && body.sessionId === confirmation.sessionId && body.pid === process.pid;
      response.writeHead(received ? 200 : 403); response.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    vi.mocked(readDaemonControlPort).mockResolvedValue({ port: (server.address() as { port: number }).port, controlSecret: 'fixture' });
    const overrides = { HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), TMPDIR: project };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    let prepared: Awaited<ReturnType<typeof prepareSessionWriteScopeClaude>> | undefined;
    try {
      prepared = await prepareSessionWriteScopeClaude({ path: project, config, confirmation });
      expect(received).toBe(true);
      config.extraWritePaths.push(sibling); // Mutating the caller must never change the prepared boundary.
      async function execute(path: string) {
        const code = `const fs=require('fs');let result;try{fs.writeFileSync(process.argv[1],'fixture');result={allowed:true}}catch(e){result={code:e.code}};result.leaked=process.env.HAPPY_SCOPE_CLAUDE_COMMAND!==undefined;console.log(JSON.stringify(result))`;
        const child = prepared!.spawn({ command: process.execPath, args: ['-e', code, path], cwd: project, env: { ...process.env }, signal: new AbortController().signal });
        child.stdin!.end();
        let output = ''; child.stdout!.on('data', chunk => { output += chunk; });
        await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('sandbox child failed'))); });
        return JSON.parse(output.trim());
      }
      expect(await execute(join(home, '.claude', 'scope-state'))).toEqual({ allowed: true, leaked: false });
      expect(await execute(join(root, "quote'$`file"))).toEqual({ allowed: true, leaked: false });
      for (const path of [join(sibling, 'denied'), join(root, 'escape', 'denied')]) {
        const result = await execute(path); expect(['EPERM', 'EACCES', 'EROFS']).toContain(result.code); expect(result.leaked).toBe(false);
      }
      expect(() => prepared!.spawn({ command: process.execPath, args: [], cwd: sibling, env: {}, signal: new AbortController().signal })).toThrow('SCOPE_CLAUDE_SPAWN_REJECTED');
      await prepared.close();
      expect(() => prepared!.spawn({ command: process.execPath, args: [], cwd: project, env: {}, signal: new AbortController().signal })).toThrow('SCOPE_CLAUDE_SPAWN_REJECTED');
    } finally {
      await prepared?.close();
      for (const key of Object.keys(overrides)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(fixture, { recursive: true, force: true });
    }
  }, 30000);
});
