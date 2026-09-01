import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
        linkSync: (existingPath: Parameters<typeof actual.linkSync>[0], newPath: Parameters<typeof actual.linkSync>[1]) => {
            if (String(newPath) === mixedVersionRace.lockPath && !mixedVersionRace.installed) {
                actual.writeFileSync(newPath, String(mixedVersionRace.legacyPid), 'utf-8');
                mixedVersionRace.installed = true;
            }
            return actual.linkSync(existingPath, newPath);
        },
    };
});
import {
    acquireDaemonLock,
    clearDaemonState,
    readDaemonState,
    releaseDaemonLock,
    SandboxConfigSchema,
    setDaemonPersistenceTestHooksForTests,
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
        mockConfiguration.daemonStateFile = join(testDir, 'daemon.state.json');
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

    it('keeps the legacy fixed lock and state paths as regular files', async () => {
        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(statSync(mockConfiguration.daemonLockFile).isFile()).toBe(true);
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));

        writeDaemonState(lockHandle!, {
            pid: process.pid,
            httpPort: 4000,
            startTime: 'fixed-path-compatible',
            startedWithCliVersion: '1.2.2',
        });
        expect(statSync(mockConfiguration.daemonStateFile).isFile()).toBe(true);
        expect(JSON.parse(readFileSync(mockConfiguration.daemonStateFile, 'utf-8'))).toMatchObject({
            pid: process.pid,
            httpPort: 4000,
            ownerToken: lockHandle!.ownerToken,
        });
        await releaseDaemonLock(lockHandle!);
    });

    it('clears a stale fixed state immediately after acquiring the fixed lock', async () => {
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({
            pid: 313131,
            httpPort: 4999,
            startTime: 'stale-predecessor',
            startedWithCliVersion: '1.0.0',
        }), 'utf-8');

        const lockHandle = await acquireDaemonLock(1, 0);

        expect(lockHandle).not.toBeNull();
        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
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

    it('reclaims a dead legacy lock and its matching fixed state', async () => {
        const legacyPid = 424242;
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({
            pid: legacyPid,
            httpPort: 4000,
            startTime: 'legacy-dead',
            startedWithCliVersion: '1.0.0',
        }), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, String(legacyPid), 'utf-8');
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === legacyPid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const lockHandle = await acquireDaemonLock(2, 0);

        expect(lockHandle).not.toBeNull();
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        await releaseDaemonLock(lockHandle!);
    });

    it('recovers a dead legacy cleanup claimant after a crash', async () => {
        const legacyPid = 424246;
        const crashedReclaimerPid = 424247;
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({
            pid: legacyPid,
            httpPort: 4000,
            startTime: 'legacy-dead',
            startedWithCliVersion: '1.0.0',
        }), 'utf-8');
        writeFileSync(mockConfiguration.daemonLockFile, String(legacyPid), 'utf-8');
        const lockStat = statSync(mockConfiguration.daemonLockFile);
        const fingerprint = `${lockStat.dev}:${lockStat.ino}:${lockStat.birthtimeMs}:${lockStat.size}`
            .replace(/[^A-Za-z0-9._-]/g, '-');
        const claimPath = `${mockConfiguration.daemonLockFile}.legacy-claim.${fingerprint}`;
        linkSync(mockConfiguration.daemonLockFile, claimPath);
        writeFileSync(`${claimPath}.guard`, JSON.stringify({ pid: crashedReclaimerPid, token: 'crashed' }), 'utf-8');
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === legacyPid || pid === crashedReclaimerPid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const lockHandle = await acquireDaemonLock(2, 0);

        expect(lockHandle).not.toBeNull();
        expect(existsSync(claimPath)).toBe(false);
        expect(existsSync(`${claimPath}.guard`)).toBe(false);
        await releaseDaemonLock(lockHandle!);
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
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(process.pid));
        expect(existsSync(lockHandle!.generationPath)).toBe(true);
    });
});

describe('daemon state ownership', () => {
    let testDir: string;

    const createDeadGeneration = (pid: number, ownerToken: string, publishState: boolean) => {
        const generationPath = join(testDir, `daemon.state.json.generation.${pid}.${ownerToken}`);
        mkdirSync(generationPath);
        const privateLock = join(generationPath, 'lock.pid');
        writeFileSync(privateLock, String(pid), 'utf-8');
        linkSync(privateLock, mockConfiguration.daemonLockFile);
        if (publishState) {
            const privateState = join(generationPath, 'state.json');
            writeFileSync(privateState, JSON.stringify({
                pid,
                httpPort: 4000,
                startTime: 'dead-generation',
                startedWithCliVersion: '1.0.0',
                ownerToken,
            }), 'utf-8');
            linkSync(privateState, mockConfiguration.daemonStateFile);
        }
        return generationPath;
    };

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'happy-daemon-state-'));
        mockConfiguration.daemonStateFile = join(testDir, 'daemon.state.json');
        mockConfiguration.daemonLockFile = join(testDir, 'daemon.state.json.lock');
        setDaemonPersistenceTestHooksForTests({});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(testDir, { recursive: true, force: true });
    });

    it('uses heartbeat as an ownership probe without rewriting immutable state', async () => {
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
        });
        await releaseDaemonLock(lockHandle!);
    });

    it('cannot let a delayed reclaimer touch successor H after final validation of G', async () => {
        const stalePid = 424241;
        createDeadGeneration(stalePid, 'generation-g', true);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        let releaseDelayed!: () => void;
        const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
        let enteredFinalBoundary!: () => void;
        const atFinalBoundary = new Promise<void>((resolve) => { enteredFinalBoundary = resolve; });
        let hookCalls = 0;
        setDaemonPersistenceTestHooksForTests({
            beforeGenerationClaim: async () => {
                hookCalls++;
                if (hookCalls === 1) {
                    enteredFinalBoundary();
                    await delayedGate;
                }
            },
        });

        const delayedReclaimer = acquireDaemonLock(1, 0);
        await atFinalBoundary;
        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        releaseDelayed();
        await expect(delayedReclaimer).resolves.toBeNull();
        expect(statSync(mockConfiguration.daemonLockFile).ino).toBe(statSync(successor!.lockFile).ino);

        await releaseDaemonLock(successor!);
    });

    it('allows exactly one of two real reclaimers to clean a dead generation', async () => {
        const stalePid = 424242;
        createDeadGeneration(stalePid, 'generation-race', true);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const results = await Promise.all([
            acquireDaemonLock(2, 0),
            acquireDaemonLock(2, 0),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        await releaseDaemonLock(results.find(Boolean)!);
    });

    it('recovers a dead generation that crashed after fixed-lock publication', async () => {
        const stalePid = 424243;
        createDeadGeneration(stalePid, 'lock-only', false);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        await releaseDaemonLock(successor!);
    });

    it('removes stale predecessor state while publishing a new fixed lock', async () => {
        const stalePid = 424251;
        writeFileSync(mockConfiguration.daemonStateFile, JSON.stringify({
            pid: 313131,
            httpPort: 4999,
            startTime: 'stale-predecessor',
            startedWithCliVersion: '1.0.0',
        }), 'utf-8');
        createDeadGeneration(stalePid, 'lock-with-stale-state', false);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(2, 0);

        expect(successor).not.toBeNull();
        expect(existsSync(mockConfiguration.daemonStateFile)).toBe(false);
        await releaseDaemonLock(successor!);
    });

    it('recovers state written privately before its fixed alias was published', async () => {
        const stalePid = 424249;
        const generationPath = createDeadGeneration(stalePid, 'private-state-only', false);
        writeFileSync(join(generationPath, 'state.json'), JSON.stringify({
            pid: stalePid,
            httpPort: 4000,
            startTime: 'private-state-only',
            startedWithCliVersion: '1.0.0',
            ownerToken: 'private-state-only',
        }), 'utf-8');
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        expect(existsSync(generationPath)).toBe(false);
        await releaseDaemonLock(successor!);
    });

    it('resumes retirement immediately after the generation-directory claim', async () => {
        const stalePid = 424250;
        const generationPath = createDeadGeneration(stalePid, 'retirement-start', true);
        const retiringPath = join(testDir, `daemon.state.json.retiring.${stalePid}.retirement-start`);
        renameSync(generationPath, retiringPath);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        expect(existsSync(retiringPath)).toBe(false);
        await releaseDaemonLock(successor!);
    });

    it('resumes retirement after fixed state was removed but before fixed lock', async () => {
        const stalePid = 424244;
        const generationPath = createDeadGeneration(stalePid, 'retirement-crash', true);
        const retiringPath = join(testDir, `daemon.state.json.retiring.${stalePid}.retirement-crash`);
        renameSync(generationPath, retiringPath);
        unlinkSync(mockConfiguration.daemonStateFile);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        expect(existsSync(retiringPath)).toBe(false);
        await releaseDaemonLock(successor!);
    });

    it('gives exactly one delayed reclaimer authority over an already-retiring generation', async () => {
        const stalePid = 424252;
        const generationPath = createDeadGeneration(stalePid, 'retiring-race', true);
        const retiringPath = join(testDir, `daemon.state.json.retiring.${stalePid}.retiring-race`);
        renameSync(generationPath, retiringPath);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        let releaseDelayed!: () => void;
        const delayedGate = new Promise<void>((resolve) => { releaseDelayed = resolve; });
        let enteredClaim!: () => void;
        const atClaim = new Promise<void>((resolve) => { enteredClaim = resolve; });
        let hookCalls = 0;
        setDaemonPersistenceTestHooksForTests({
            beforeGenerationClaim: async () => {
                hookCalls++;
                if (hookCalls === 1) {
                    enteredClaim();
                    await delayedGate;
                }
            },
        });

        const delayedReclaimer = acquireDaemonLock(1, 0);
        await atClaim;
        const successor = await acquireDaemonLock(2, 0);
        expect(successor).not.toBeNull();
        releaseDelayed();
        await expect(delayedReclaimer).resolves.toBeNull();
        expect(statSync(mockConfiguration.daemonLockFile).ino).toBe(statSync(successor!.lockFile).ino);
        await releaseDaemonLock(successor!);
    });

    it('does not let delayed orphan GC remove a concurrently published successor state', async () => {
        const stalePid = 424253;
        const orphanPath = join(testDir, `daemon.state.json.generation.${stalePid}.orphan-g`);
        mkdirSync(orphanPath);
        writeFileSync(join(orphanPath, 'lock.pid'), String(stalePid), 'utf-8');
        writeFileSync(join(orphanPath, 'state.json'), JSON.stringify({ pid: stalePid }), 'utf-8');
        linkSync(join(orphanPath, 'state.json'), mockConfiguration.daemonStateFile);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        let resumeGc!: () => void;
        const gcGate = new Promise<void>((resolve) => { resumeGc = resolve; });
        let gcObserved!: () => void;
        const atOrphanBoundary = new Promise<void>((resolve) => { gcObserved = resolve; });
        setDaemonPersistenceTestHooksForTests({
            beforeOrphanClaim: async () => {
                gcObserved();
                await gcGate;
            },
        });
        const delayedGc = acquireDaemonLock(1, 0);
        await atOrphanBoundary;

        const successorPath = join(testDir, `daemon.state.json.generation.${process.pid}.successor-h`);
        mkdirSync(successorPath);
        writeFileSync(join(successorPath, 'lock.pid'), String(process.pid), 'utf-8');
        linkSync(join(successorPath, 'lock.pid'), mockConfiguration.daemonLockFile);
        unlinkSync(mockConfiguration.daemonStateFile);
        const successorState = join(successorPath, 'state.json');
        writeFileSync(successorState, JSON.stringify({ pid: process.pid, ownerToken: 'successor-h' }), 'utf-8');
        linkSync(successorState, mockConfiguration.daemonStateFile);

        resumeGc();
        await expect(delayedGc).resolves.toBeNull();
        expect(statSync(mockConfiguration.daemonLockFile).ino).toBe(statSync(join(successorPath, 'lock.pid')).ino);
        expect(statSync(mockConfiguration.daemonStateFile).ino).toBe(statSync(successorState).ino);
        expect(existsSync(orphanPath)).toBe(false);
    });

    it('garbage-collects dead temp and rollback orphans but preserves live ones', async () => {
        const deadPid = 424245;
        const deadTemp = join(testDir, `daemon.state.json.generation.${deadPid}.temp-crash.tmp`);
        const deadRollback = join(testDir, `daemon.state.json.generation.${deadPid}.rollback-orphan`);
        const liveOrphan = join(testDir, `daemon.state.json.generation.${process.pid}.live-orphan`);
        for (const path of [deadTemp, deadRollback, liveOrphan]) {
            mkdirSync(path);
            const pid = path === liveOrphan ? process.pid : deadPid;
            if (path !== deadTemp) {
                writeFileSync(join(path, 'lock.pid'), String(pid), 'utf-8');
            }
        }
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === deadPid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const handle = await acquireDaemonLock(1, 0);

        expect(handle).not.toBeNull();
        expect(existsSync(deadTemp)).toBe(false);
        expect(existsSync(deadRollback)).toBe(false);
        expect(existsSync(liveOrphan)).toBe(true);
        await releaseDaemonLock(handle!);
    });

    it('supports old-binary fixed-path reads and cleans its rollback orphan later', async () => {
        const stalePid = 424248;
        const generationPath = createDeadGeneration(stalePid, 'rollback-smoke', true);
        const oldBinaryState = JSON.parse(readFileSync(mockConfiguration.daemonStateFile, 'utf-8'));
        expect(readFileSync(mockConfiguration.daemonLockFile, 'utf-8')).toBe(String(stalePid));
        expect(oldBinaryState).toMatchObject({ pid: stalePid, httpPort: 4000 });

        // Baseline release behavior removes only the two historical fixed files.
        unlinkSync(mockConfiguration.daemonStateFile);
        unlinkSync(mockConfiguration.daemonLockFile);
        vi.spyOn(process, 'kill').mockImplementation((pid) => {
            if (pid === stalePid) {
                const error = new Error('no such process') as NodeJS.ErrnoException;
                error.code = 'ESRCH';
                throw error;
            }
            return true;
        });

        const successor = await acquireDaemonLock(1, 0);
        expect(successor).not.toBeNull();
        expect(existsSync(generationPath)).toBe(false);
        await releaseDaemonLock(successor!);
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

    it('makes the current generation unreadable when scoped cleanup retires it', async () => {
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

    it('keeps generation artifacts bounded across repeated acquire and release', async () => {
        for (let index = 0; index < 10; index++) {
            const handle = await acquireDaemonLock(1, 0);
            expect(handle).not.toBeNull();
            writeDaemonState(handle!, {
                pid: process.pid,
                httpPort: 4000 + index,
                startTime: `iteration-${index}`,
                startedWithCliVersion: '1.2.2',
            });
            await releaseDaemonLock(handle!);
        }
        expect(readdirSync(testDir).filter((name) => name.includes('.generation.') || name.includes('.retiring.'))).toEqual([]);
    });
});
