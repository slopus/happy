import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mixedVersionRace = vi.hoisted(() => ({
    lockPath: '',
    legacyPid: 0,
    installed: false,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
            const existed = actual.existsSync(path);
            if (String(path) === mixedVersionRace.lockPath && !existed && !mixedVersionRace.installed) {
                actual.writeFileSync(path, String(mixedVersionRace.legacyPid), 'utf-8');
                mixedVersionRace.installed = true;
            }
            return existed;
        },
        mkdirSync: (path: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) => {
            if (String(path) === mixedVersionRace.lockPath && !mixedVersionRace.installed) {
                actual.writeFileSync(path, String(mixedVersionRace.legacyPid), 'utf-8');
                mixedVersionRace.installed = true;
            }
            return actual.mkdirSync(path, options as any);
        },
    };
});
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
        mixedVersionRace.lockPath = '';
        mixedVersionRace.legacyPid = 0;
        mixedVersionRace.installed = false;
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it.each([
        ['empty', ''],
        ['non-numeric', 'not-a-pid'],
        ['zero-pid', '0'],
    ])('does not reclaim an untrusted %s lock observation', async (_label, lockContent) => {
        writeFileSync(mockConfiguration.daemonLockFile, lockContent, 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(lockContent);
    });

    it('claims the shared directory atomically and publishes its generation payload before returning', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(JSON.parse(readFileSync(join(mockConfiguration.daemonLockFile, 'owner.json'), 'utf-8'))).toEqual({
            pid: process.pid,
            ownerToken: lockHandle!.ownerToken,
        });
        expect(readdirSync(testDir).some(name => name.includes('.candidate.'))).toBe(false);
        await releaseDaemonLock(lockHandle!);
    });

    it('does not clear a lock held by a live process', async () => {
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
    });

    it('does not reclaim an ownerless directory left during generation publication', async () => {
        mkdirSync(mockConfiguration.daemonLockFile);

        await expect(acquireDaemonLock(1, 0)).resolves.toBeNull();
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(true);
        expect(readdirSync(mockConfiguration.daemonLockFile)).toEqual([]);
    });

    it('does not overwrite a legacy lock installed at the mixed-version acquisition boundary', async () => {
        mixedVersionRace.lockPath = mockConfiguration.daemonLockFile;
        mixedVersionRace.legacyPid = process.pid;

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
    });

    it('does not probe or reclaim legacy ownership without a generation token', async () => {
        const legacyPid = 424242;
        writeFileSync(mockConfiguration.daemonLockFile, String(legacyPid), 'utf-8');
        const killSpy = vi.spyOn(process, 'kill');

        await expect(acquireDaemonLock(1, 0)).resolves.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(legacyPid));
        expect(killSpy).not.toHaveBeenCalled();
    });

    it('does not treat an EPERM process probe as proof that the owner died', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);
        expect(lockHandle).not.toBeNull();
        vi.spyOn(process, 'kill').mockImplementation(() => {
            const error = new Error('operation not permitted') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
        });

        await expect(acquireDaemonLock(1, 0)).resolves.toBeNull();
        expect(JSON.parse(readFileSync(join(mockConfiguration.daemonLockFile, 'owner.json'), 'utf-8')))
            .toMatchObject({ ownerToken: lockHandle!.ownerToken });
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
        vi.restoreAllMocks();
        rmSync(testDir, { recursive: true, force: true });
    });

    it('refreshes state while both state and lock still belong to this daemon', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);
        expect(lockHandle).not.toBeNull();
        const ownedState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'owner',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(lockHandle!, ownedState);

        await expect(writeDaemonStateIfOwned(lockHandle!, {
            ...ownedState,
            lastHeartbeat: 'later',
        })).resolves.toBe(true);
        await expect(readDaemonState()).resolves.toEqual({
            ...ownedState,
            ownerToken: lockHandle!.ownerToken,
            lastHeartbeat: 'later',
        });
        await releaseDaemonLock(lockHandle!);
    });

    it('does not delete a successor lock generation that reused the predecessor PID', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();

        const delayedRelease = releaseDaemonLock(predecessorHandle!);
        expect(existsSync(mockConfiguration.daemonLockFile)).toBe(true);

        renameSync(
            mockConfiguration.daemonLockFile,
            `${mockConfiguration.daemonLockFile}.retired.${predecessorHandle!.ownerToken}`,
        );
        const successorToken = 'same-pid-successor';
        mkdirSync(mockConfiguration.daemonLockFile);
        writeFileSync(
            join(mockConfiguration.daemonLockFile, 'owner.json'),
            JSON.stringify({ pid: process.pid, ownerToken: successorToken }),
            'utf-8',
        );

        await delayedRelease;
        expect(JSON.parse(readFileSync(join(mockConfiguration.daemonLockFile, 'owner.json'), 'utf-8'))).toEqual({
            pid: process.pid,
            ownerToken: successorToken,
        });
    });

    it('does not let a delayed stale-lock reclaimer retire the successor generation', async () => {
        const staleHandle = await acquireDaemonLock(1, 0);
        expect(staleHandle).not.toBeNull();
        writeDaemonState(staleHandle!, {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'stale',
            startedWithCliVersion: '1.2.2',
        });
        writeFileSync(
            join(mockConfiguration.daemonLockFile, 'owner.json'),
            JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, ownerToken: staleHandle!.ownerToken }),
            'utf-8',
        );
        vi.spyOn(process, 'kill').mockImplementation(() => {
            const error = new Error('no such process') as NodeJS.ErrnoException;
            error.code = 'ESRCH';
            throw error;
        });

        const successorHandle = await acquireDaemonLock(2, 0);
        expect(successorHandle).not.toBeNull();
        expect(existsSync(staleHandle!.stateFile)).toBe(false);

        // This models a reclaimer that observed the stale generation before
        // the successor acquired the shared lock path, then resumes late.
        await releaseDaemonLock(staleHandle!);

        const contenderHandle = await acquireDaemonLock(1, 0);
        expect(contenderHandle).toBeNull();

        await releaseDaemonLock(successorHandle!);
    });

    it('does not retire a successor installed while stale ownership is being validated', async () => {
        const staleHandle = await acquireDaemonLock(1, 0);
        expect(staleHandle).not.toBeNull();
        const stalePid = Number.MAX_SAFE_INTEGER;
        writeFileSync(
            join(mockConfiguration.daemonLockFile, 'owner.json'),
            JSON.stringify({ pid: stalePid, ownerToken: staleHandle!.ownerToken }),
            'utf-8',
        );

        const successorToken = 'successor-generation';
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                renameSync(
                    mockConfiguration.daemonLockFile,
                    `${mockConfiguration.daemonLockFile}.retired.${staleHandle!.ownerToken}`,
                );
                mkdirSync(mockConfiguration.daemonLockFile);
                writeFileSync(
                    join(mockConfiguration.daemonLockFile, 'owner.json'),
                    JSON.stringify({ pid: process.pid, ownerToken: successorToken }),
                    'utf-8',
                );
                const error = new Error('stale owner is dead') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        await expect(acquireDaemonLock(1, 0)).resolves.toBeNull();
        expect(JSON.parse(readFileSync(join(mockConfiguration.daemonLockFile, 'owner.json'), 'utf-8'))).toEqual({
            pid: process.pid,
            ownerToken: successorToken,
        });
    });

    it('does not publish a predecessor heartbeat after the same PID acquires a successor generation', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();
        const predecessorState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(predecessorHandle!, predecessorState);

        await releaseDaemonLock(predecessorHandle!);
        const successorHandle = await acquireDaemonLock(1, 0);
        expect(successorHandle).not.toBeNull();
        const successorState = {
            pid: process.pid,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorHandle!, successorState);

        await expect(writeDaemonStateIfOwned(predecessorHandle!, {
            ...predecessorState,
            lastHeartbeat: 'late',
        })).resolves.toBe(false);
        await expect(readDaemonState()).resolves.toEqual({
            ...successorState,
            ownerToken: successorHandle!.ownerToken,
        });

        await releaseDaemonLock(successorHandle!);
    });

    it('rejects a heartbeat when ownership changes after its initial validation', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();
        const predecessorState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(predecessorHandle!, predecessorState);

        const lateHeartbeat = writeDaemonStateIfOwned(predecessorHandle!, {
            ...predecessorState,
            lastHeartbeat: 'late',
        });
        renameSync(
            mockConfiguration.daemonLockFile,
            `${mockConfiguration.daemonLockFile}.retired.${predecessorHandle!.ownerToken}`,
        );
        const successorToken = 'heartbeat-successor';
        mkdirSync(mockConfiguration.daemonLockFile);
        writeFileSync(
            join(mockConfiguration.daemonLockFile, 'owner.json'),
            JSON.stringify({ pid: process.pid, ownerToken: successorToken }),
            'utf-8',
        );
        const successorHandle = {
            ownerToken: successorToken,
            pid: process.pid,
            stateFile: `${mockConfiguration.daemonStateFile}.owner.${successorToken}`,
            released: false,
        };
        const successorState = {
            pid: process.pid,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorHandle!, successorState);

        await expect(lateHeartbeat).resolves.toBe(false);
        await expect(readDaemonState()).resolves.toEqual({
            ...successorState,
            ownerToken: successorHandle.ownerToken,
        });
    });

    it('does not expose predecessor state while a successor generation is starting', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();
        const predecessorState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(predecessorHandle!, predecessorState);

        await releaseDaemonLock(predecessorHandle!);
        const successorHandle = await acquireDaemonLock(1, 0);
        expect(successorHandle).not.toBeNull();

        await expect(writeDaemonStateIfOwned(predecessorHandle!, {
            ...predecessorState,
            lastHeartbeat: 'late',
        })).resolves.toBe(false);
        await expect(readDaemonState()).resolves.toBeNull();

        await releaseDaemonLock(successorHandle!);
    });

    it('retries a state read when ownership changes during the asynchronous read', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();
        writeDaemonState(predecessorHandle!, {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        });

        const stateRead = readDaemonState();
        await releaseDaemonLock(predecessorHandle!);
        const successorHandle = await acquireDaemonLock(1, 0);
        expect(successorHandle).not.toBeNull();
        const successorState = {
            pid: process.pid,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorHandle!, successorState);

        await expect(stateRead).resolves.toEqual({
            ...successorState,
            ownerToken: successorHandle!.ownerToken,
        });

        await releaseDaemonLock(successorHandle!);
    });

    it('leaves PID-only legacy ownership untouched because a PID is not a generation', async () => {
        const legacyState = {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'legacy',
            startedWithCliVersion: '1.2.2',
        };
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify(legacyState), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, String(process.pid), 'utf-8');

        await clearDaemonState(legacyState);

        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        await expect(readDaemonState()).resolves.toEqual(legacyState);
    });

    it('does not combine a legacy lock owner with a predecessor fixed-state snapshot', async () => {
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({
            pid: 1111,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.0.0',
        }), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, '2222', 'utf-8');

        await expect(readDaemonState()).resolves.toBeNull();
    });

    it('makes the current generation unreadable as soon as scoped cleanup retires it', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);
        expect(lockHandle).not.toBeNull();
        writeDaemonState(lockHandle!, {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'owner',
            startedWithCliVersion: '1.2.2',
        });

        await clearDaemonState(lockHandle!);

        await expect(readDaemonState()).resolves.toBeNull();
        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        expect(existsSync(lockHandle!.stateFile)).toBe(false);
    });

    it('cleans only the predecessor generation after the same PID acquires a successor', async () => {
        const predecessorHandle = await acquireDaemonLock(1, 0);
        expect(predecessorHandle).not.toBeNull();
        writeDaemonState(predecessorHandle!, {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'predecessor',
            startedWithCliVersion: '1.2.2',
        });

        const delayedCleanup = clearDaemonState(predecessorHandle!);
        expect(existsSync(predecessorHandle!.stateFile)).toBe(true);

        renameSync(
            mockConfiguration.daemonLockFile,
            `${mockConfiguration.daemonLockFile}.retired.${predecessorHandle!.ownerToken}`,
        );
        const successorToken = 'cleanup-successor';
        mkdirSync(mockConfiguration.daemonLockFile);
        writeFileSync(
            join(mockConfiguration.daemonLockFile, 'owner.json'),
            JSON.stringify({ pid: process.pid, ownerToken: successorToken }),
            'utf-8',
        );
        const successorHandle = {
            ownerToken: successorToken,
            pid: process.pid,
            stateFile: `${mockConfiguration.daemonStateFile}.owner.${successorToken}`,
            released: false,
        };
        const successorState = {
            pid: process.pid,
            httpPort: 4001,
            startTime: 'successor',
            startedWithCliVersion: '1.2.2',
        };
        writeDaemonState(successorHandle, successorState);

        await delayedCleanup;

        expect(existsSync(predecessorHandle!.stateFile)).toBe(false);
        await expect(readDaemonState()).resolves.toEqual({
            ...successorState,
            ownerToken: successorHandle.ownerToken,
        });
        const contenderHandle = await acquireDaemonLock(1, 0);
        expect(contenderHandle).toBeNull();
    });
});
