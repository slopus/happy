import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('readDaemonState', () => {
    const previousHomeDir = process.env.HAPPY_HOME_DIR;

    afterEach(() => {
        process.env.HAPPY_HOME_DIR = previousHomeDir;
    });

    it('retries when the daemon state file appears shortly after the call starts', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happy-cli-daemon-state-'));

        vi.resetModules();
        process.env.HAPPY_HOME_DIR = homeDir;

        const [{ configuration }, { readDaemonState }] = await Promise.all([
            import('./configuration'),
            import('./persistence'),
        ]);

        setTimeout(() => {
            writeFileSync(
                configuration.daemonStateFile,
                JSON.stringify(
                    {
                        pid: 123,
                        httpPort: 5173,
                        startTime: new Date().toISOString(),
                        startedWithCliVersion: '0.0.0-test',
                    },
                    null,
                    2
                ),
                'utf-8'
            );
        }, 5);

        const state = await readDaemonState();
        expect(state?.pid).toBe(123);
    });
});

