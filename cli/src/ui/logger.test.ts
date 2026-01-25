import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('logger.debugLargeJson', () => {
    const originalDebug = process.env.DEBUG;
    const originalHappyHomeDir = process.env.HAPPY_HOME_DIR;
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'happy-cli-logger-test-'));
        process.env.HAPPY_HOME_DIR = tempDir;
        delete process.env.DEBUG;
        vi.resetModules();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
        if (originalHappyHomeDir === undefined) delete process.env.HAPPY_HOME_DIR;
        else process.env.HAPPY_HOME_DIR = originalHappyHomeDir;

        if (originalDebug === undefined) delete process.env.DEBUG;
        else process.env.DEBUG = originalDebug;
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('writes to log file when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] debugLargeJson');
    });

    it('does not throw if log file cannot be written (even when DEBUG is set)', async () => {
        // Make logs dir read-only so appendFileSync fails deterministically.
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        chmodSync(logsDir, 0o555);

        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        try {
            expect(() => {
                logger.debugLargeJson('[TEST] debugLargeJson write should not throw', { secret: 'value' });
            }).not.toThrow();
        } finally {
            chmodSync(logsDir, 0o755);
        }
    });
});
