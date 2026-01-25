import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { projectPath } from '@/projectPath';

function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe('daemon start-sync auth gating', () => {
  it('fails fast without creating a lock when started non-interactively with no credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happy-cli-home-'));
    const entry = join(projectPath(), 'dist', 'index.mjs');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPY_HOME_DIR: home,
      // Ensure we do not accidentally hit real infra
      HAPPY_SERVER_URL: 'http://127.0.0.1:9',
      HAPPY_WEBAPP_URL: 'http://127.0.0.1:9',
      DEBUG: '1',
    };

    try {
      const res = await runNode([entry, 'daemon', 'start-sync'], env, 3000);
      expect(res.code).not.toBe(0);
      expect(existsSync(join(home, 'daemon.state.json.lock'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

