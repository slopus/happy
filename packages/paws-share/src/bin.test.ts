import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('packed CLI entrypoint', () => {
    it('propagates the command exit code to the process', () => {
        const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../bin/paws-share.mjs'), 'inspect'], {
            encoding: 'utf8',
        });

        expect(result.status).toBe(2);
        expect(result.stderr).toContain('Use --current or provide both --source and --session');
    });
});
