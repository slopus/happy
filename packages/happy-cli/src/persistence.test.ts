import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonLock, clearDaemonState, DaemonSessionLimitsSchema, readSettings, releaseDaemonLock, SandboxConfigSchema, writeDaemonState } from './persistence';

const mockConfiguration = vi.hoisted(() => ({
    daemonLockFile: '',
    daemonStateFile: '',
    happyHomeDir: '',
    isDaemonProcess: false,
    logsDir: '/tmp',
    sessionsFile: '',
    settingsFile: '',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: false,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});

describe('DaemonSessionLimitsSchema', () => {
    it('accepts optional positive integer limits', () => {
        expect(DaemonSessionLimitsSchema.parse({})).toEqual({});
        expect(DaemonSessionLimitsSchema.parse({
            sessionIdleTimeoutMinutes: 60,
            maxConcurrentSessions: 3,
        })).toEqual({
            sessionIdleTimeoutMinutes: 60,
            maxConcurrentSessions: 3,
        });
    });

    it.each([
        { sessionIdleTimeoutMinutes: 0 },
        { sessionIdleTimeoutMinutes: 1.5 },
        { maxConcurrentSessions: -1 },
        { maxConcurrentSessions: '3' },
    ])('rejects invalid limits: %j', (value) => {
        expect(() => DaemonSessionLimitsSchema.parse(value)).toThrow();
    });
});

describe('daemon session limit settings', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-settings-'));
        mockConfiguration.happyHomeDir = testDir;
        mockConfiguration.settingsFile = join(testDir, 'settings.json');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('reads valid limits from settings.json', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            sessionIdleTimeoutMinutes: 45,
            maxConcurrentSessions: 4,
        }));

        await expect(readSettings()).resolves.toMatchObject({
            sessionIdleTimeoutMinutes: 45,
            maxConcurrentSessions: 4,
        });
    });

    it('disables only an invalid limit and preserves the valid sibling', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            sessionIdleTimeoutMinutes: 0,
            maxConcurrentSessions: 4,
        }));

        await expect(readSettings()).resolves.toMatchObject({
            sessionIdleTimeoutMinutes: undefined,
            maxConcurrentSessions: 4,
        });
    });
});

describe('acquireDaemonLock', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'));
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
        mockConfiguration.daemonStateFile = join(testDir, 'daemon.state.json');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it.each([
        ['empty', ''],
        ['non-numeric', 'not-a-pid'],
        ['zero-pid', '0'],
    ])('treats a %s lock file as stale and acquires a fresh lock', async (_label, lockContent) => {
        writeFileSync(mockConfiguration.daemonLockFile, lockContent, 'utf-8');

        // Lock creation is atomic including the PID payload (temp file +
        // hard link), so a payload-less lock can never belong to a live
        // acquirer and is reclaimed on first sight.
        const lockHandle = await acquireDaemonLock(2, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        await releaseDaemonLock(lockHandle!);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(false);
    });

    it('creates the lock with its PID payload atomically (no temp file left behind)', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        expect(existsSync(`${mockConfiguration.daemonLockFile}.${process.pid}.tmp`)).toBe(false);
        await releaseDaemonLock(lockHandle!);
    });

    it('does not clear a lock held by a live process', async () => {
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
    });

    it('does not remove a replacement lock when releasing an old handle', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);
        expect(lockHandle).not.toBeNull();

        await lockHandle!.close();
        rmSync(mockConfiguration.daemonLockFile);
        writeFileSync(mockConfiguration.daemonLockFile, '424242', 'utf-8');

        await releaseDaemonLock(lockHandle!);

        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe('424242');
    });

    it('only clears daemon files when the expected PID still owns the state', async () => {
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({ pid: 424242 }), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, '424242', 'utf-8');

        await expect(clearDaemonState(process.pid)).resolves.toBe(false);

        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(true);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(true);

        await expect(clearDaemonState(424242)).resolves.toBe(true);

        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(false);
    });

    it('preserves replacement files when state and lock ownership disagree', async () => {
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({ pid: process.pid }), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, '424242', 'utf-8');

        await expect(clearDaemonState(process.pid)).resolves.toBe(false);

        expect(JSON.parse(readFileSync(mockConfiguration.daemonStateFile, 'utf-8'))).toEqual({
            pid: process.pid,
        });
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe('424242');
    });

    it('publishes daemon state through an atomic same-directory rename', () => {
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({ pid: 1 }), 'utf-8');

        writeDaemonState({ pid: process.pid } as any);

        expect(JSON.parse(readFileSync(mockConfiguration.daemonStateFile, 'utf-8'))).toEqual({
            pid: process.pid,
        });
        expect(readdirSync(testDir).some((name) => name.endsWith('.tmp'))).toBe(false);
    });
});
