import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    acquireDaemonLock,
    clearDaemonState,
    readDaemonState,
    releaseDaemonLock,
    SandboxConfigSchema,
    writeDaemonState,
    writeDaemonStateIfOwned,
} from './persistence';

const mockConfiguration = vi.hoisted(() => ({
    daemonLockFile: '',
    daemonStateFile: '',
    isDaemonProcess: false,
    logsDir: '/tmp',
    sessionsFile: '',
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

describe('acquireDaemonLock', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-lock-'));
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
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
});

describe('daemon state ownership', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-state-'));
        mockConfiguration.daemonStateFile = join(testDir, 'daemon.state.json');
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('refreshes state while both state and lock still belong to this daemon', async () => {
        const ownedState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'owner',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(ownedState);
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        await expect(writeDaemonStateIfOwned({
            ...ownedState,
            lastHeartbeat: 'later',
        })).resolves.toBe(true);
        await expect(readDaemonState()).resolves.toEqual({
            ...ownedState,
            lastHeartbeat: 'later',
        });
    });

    it('does not overwrite state owned by a successor daemon', async () => {
        const successorState = {
            pid: process.pid + 1,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorState);

        const wroteHeartbeat = await writeDaemonStateIfOwned({
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
            lastHeartbeat: 'later',
        });

        expect(wroteHeartbeat).toBe(false);
        await expect(readDaemonState()).resolves.toEqual(successorState);
    });

    it('does not write a heartbeat after lock ownership moves to a successor', async () => {
        const predecessorState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(predecessorState);
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid + 1), 'utf-8');

        const wroteHeartbeat = await writeDaemonStateIfOwned({
            ...predecessorState,
            lastHeartbeat: 'later',
        });

        expect(wroteHeartbeat).toBe(false);
        await expect(readDaemonState()).resolves.toEqual(predecessorState);
    });

    it('does not clear state or lock owned by a successor daemon', async () => {
        const successorPid = process.pid + 1;
        const successorState = {
            pid: successorPid,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorState);
        writeFileSync(mockConfiguration.daemonLockFile, String(successorPid), 'utf-8');

        await clearDaemonState(process.pid);

        await expect(readDaemonState()).resolves.toEqual(successorState);
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(successorPid));
    });

    it('clears state and lock that still belong to the expected daemon', async () => {
        const ownedState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'owner',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(ownedState);
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        await clearDaemonState(process.pid);

        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(false);
    });

    it('does not delete a successor lock when releasing a predecessor handle', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();

        unlinkSync(mockConfiguration.daemonLockFile);
        const successorPid = process.pid + 1;
        writeFileSync(mockConfiguration.daemonLockFile, String(successorPid), 'utf-8');

        await releaseDaemonLock(predecessorHandle!);

        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(successorPid));
    });
});
