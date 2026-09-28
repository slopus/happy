import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const crossSpawnCalls = vi.hoisted(() => [] as { command: string; args: string[] }[]);
vi.mock('cross-spawn', async () => {
  const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const record = (command: string, args: string[] = [], options?: object) => {
    crossSpawnCalls.push({ command, args });
    // The Windows tree kill has no taskkill here; end the recorded process instead.
    if (command === 'taskkill') {
      process.kill(Number(args[args.indexOf('/pid') + 1]), 'SIGKILL');
      return spawn(process.execPath, ['-e', ''], options);
    }
    return spawn(command, args, options);
  };
  return { default: record, spawn: record };
});

import { AcpBackend } from './AcpBackend';

const agent = fileURLToPath(new URL('./__fixtures__/fakeAcpAgent.mjs', import.meta.url));
const dirs: string[] = [];
const backends: AcpBackend[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  crossSpawnCalls.length = 0;
});

function backend(args: string[] = [], env: Record<string, string> = {}): AcpBackend {
  const created = new AcpBackend({ agentName: 'fake', cwd: process.cwd(), command: process.execPath, args: [agent, ...args], env });
  backends.push(created);
  return created;
}
const exited = async (b: AcpBackend) => {
  await vi.waitFor(() => expect(b.processExit()).not.toBeNull(), { timeout: 5000 });
  return b.processExit();
};

describe('AcpBackend process', () => {
  it('hands the agent its arguments as separate arguments, never as one shell line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-argv-')); dirs.push(dir);
    const out = join(dir, 'argv.json');
    const args = ['--label', 'two words', 'quote"d', '&echo injected'];
    const b = backend(args, { FAKE_ACP_ARGV_OUT: out });
    await b.startSession();
    expect(crossSpawnCalls[0]).toEqual({ command: process.execPath, args: [agent, ...args] });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(args);
  });

  it('ends the agent by closing its input and reports the exit it saw as unforced', async () => {
    const b = backend();
    await b.startSession();
    expect(b.processExit()).toBeNull();
    b.endInput();
    expect(await exited(b)).toEqual({ code: 0, signal: null, forced: false });
  });

  it('settles an unanswered prompt once the agent ends after its input was closed', async () => {
    const b = backend([], { FAKE_ACP_HOLD_PROMPT: '1' });
    await b.startSession();
    const prompt = b.sendPrompt('fake-session', 'hello').then(() => 'settled', () => 'rejected');
    await new Promise((resolve) => setTimeout(resolve, 200));
    b.endInput();
    await exited(b);
    const outcome = await Promise.race([prompt, new Promise((resolve) => setTimeout(() => resolve('pending'), 2000))]);
    expect(outcome).toBe('settled');
  });

  it('reports an agent it had to kill as forced, whatever the exit code said', async () => {
    const b = backend([], { FAKE_ACP_IGNORE_EOF: '1' });
    await b.startSession();
    b.endInput();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(b.processExit()).toBeNull();
    await b.dispose();
    expect(b.processExit()).toMatchObject({ forced: true });
  });

  it('kills the whole process tree on Windows, not just the direct child', async () => {
    const b = backend([], { FAKE_ACP_IGNORE_EOF: '1' });
    await b.startSession();
    const pid = b.processId();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await b.dispose();
    expect(crossSpawnCalls).toContainEqual({ command: 'taskkill', args: ['/pid', String(pid), '/t', '/f'] });
    expect(b.processExit()).toMatchObject({ forced: true });
  });
});
