import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapCommand } from './manager';

const RUN_NETWORK_INTEGRATION = process.env.HAPPY_RUN_SANDBOX_NETWORK_TESTS === '1';

function hasCommand(command: string): boolean {
    const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
        stdio: 'ignore',
    });
    return result.status === 0;
}

describe('sandbox network integration', () => {
    it.skipIf(!RUN_NETWORK_INTEGRATION)('allows outbound curl in allowed network mode', async () => {
        if (process.platform === 'win32') {
            return;
        }

        if (!hasCommand('curl') || !hasCommand('rg')) {
            return;
        }

        const sessionPath = mkdtempSync(join(tmpdir(), 'happy-sandbox-network-'));
        const sandboxConfig: SandboxConfig = {
            enabled: true,
            workspaceRoot: sessionPath,
            sessionIsolation: 'strict',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        };

        const cleanup = await initializeSandbox(sandboxConfig, sessionPath);
        try {
            const wrappedCommand = await wrapCommand('curl -sS -I --max-time 20 https://example.com');
            const result = spawnSync('sh', ['-lc', wrappedCommand], {
                encoding: 'utf8',
                timeout: 30000,
            });

            const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

            expect(result.status).toBe(0);
            expect(output).toMatch(/HTTP\/[0-9.]+\s+\d+/);
        } finally {
            await cleanup();
            rmSync(sessionPath, { recursive: true, force: true });
        }
    }, 60000);
});
