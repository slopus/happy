import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPath } from '@/projectPath';

describe('happy claude --effort', () => {
    let happyHomeDir: string;

    beforeEach(() => {
        happyHomeDir = mkdtempSync(join(tmpdir(), 'happy-cli-effort-'));
    });

    afterEach(() => {
        rmSync(happyHomeDir, { recursive: true, force: true });
    });

    it('rejects an unknown level with a one-line error instead of a stack trace', () => {
        // The CLI that the vitest global setup builds, started the way bin/happy.mjs starts it.
        const entrypoint = join(projectPath(), 'dist', 'index.mjs');
        const result = spawnSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, 'claude', '--effort', 'bogus'], {
            encoding: 'utf8',
            env: { ...process.env, HAPPY_HOME_DIR: happyHomeDir },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Invalid --effort value: bogus. Must be one of: low, medium, high, xhigh, max, ultracode');
        expect(result.stderr).not.toContain('ZodError');
        expect(result.stderr).not.toMatch(/^\s+at /m);
    }, 30_000);
});
