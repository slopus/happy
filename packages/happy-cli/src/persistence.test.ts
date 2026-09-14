import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    acquireDaemonLock,
    markSessionStopped,
    persistSession,
    readPersistedSessions,
    releaseDaemonLock,
    SandboxConfigSchema,
    type PersistedSession,
} from './persistence';
import { resolveLocalReconnectableSession } from './resume/localResumeStore';

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

// Records written before the current boot cannot be probed for liveness (PIDs
// are reused across reboots), so the machine's real uptime would decide these
// tests. Pin it.
const mockOs = vi.hoisted(() => ({ uptimeSeconds: 365 * 24 * 60 * 60 }));

vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    const uptime = () => mockOs.uptimeSeconds;
    return { ...actual, uptime, default: { ...actual, uptime } };
});

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

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionRecord(overrides: Partial<PersistedSession> & { hostPid?: number } = {}): PersistedSession {
    const { hostPid, ...rest } = overrides;
    return {
        encryptionKey: 'a2V5',
        encryptionVariant: 'dataKey',
        seq: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/tmp/project', hostPid } as PersistedSession['metadata'],
        savedAt: Date.now(),
        ...rest,
    };
}

function writeSessions(sessions: Record<string, PersistedSession>): void {
    writeFileSync(mockConfiguration.sessionsFile, JSON.stringify({ sessions }, null, 2), 'utf-8');
}

describe('persisted session retention', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'happy-sessions-'));
        mockConfiguration.sessionsFile = join(dir, 'sessions.json');
        mockOs.uptimeSeconds = 365 * 24 * 60 * 60;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    it('keeps a session that was in use yesterday but started long ago', () => {
        // A session used daily for months: it started 60 days ago and stopped
        // yesterday. Measuring age from when it STARTED would throw it away.
        writeSessions({
            's1': sessionRecord({ savedAt: Date.now() - 60 * DAY_MS, lastAliveAt: Date.now() - DAY_MS }),
        });

        expect(Object.keys(readPersistedSessions())).toEqual(['s1']);
    });

    it('keeps a session whose process is still running, however old the record', () => {
        writeSessions({
            's1': sessionRecord({
                savedAt: Date.now() - 60 * DAY_MS,
                lastAliveAt: Date.now() - 60 * DAY_MS,
                hostPid: process.pid,
            }),
        });

        expect(Object.keys(readPersistedSessions())).toEqual(['s1']);
    });

    it.each(['EPERM', 'EACCES'])('keeps an old session when liveness is unknown (%s)', (code) => {
        writeSessions({ s1: sessionRecord({ savedAt: Date.now() - 60 * DAY_MS, hostPid: 12345 }) });
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('probe failed'), { code }); });
        expect(Object.keys(readPersistedSessions())).toEqual(['s1']);
    });

    it('drops an expired session when ESRCH proves its process is absent', () => {
        writeSessions({ s1: sessionRecord({ savedAt: Date.now() - 60 * DAY_MS, hostPid: 12345 }) });
        vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
        expect(readPersistedSessions()).toEqual({});
    });

    it('drops a session that stopped more than the retention window ago', () => {
        writeSessions({
            's1': sessionRecord({ savedAt: Date.now() - 90 * DAY_MS, lastAliveAt: Date.now() - 20 * DAY_MS }),
        });

        expect(readPersistedSessions()).toEqual({});
    });

    it('treats a record with no lastAliveAt as dating from when it was written', () => {
        writeSessions({
            'fresh': sessionRecord({ savedAt: Date.now() - DAY_MS }),
            'stale': sessionRecord({ savedAt: Date.now() - 20 * DAY_MS }),
        });

        expect(Object.keys(readPersistedSessions())).toEqual(['fresh']);
    });

    it('does not resurrect a dead process whose PID a new process now reuses', () => {
        // Record predates the current boot, so its PID says nothing about what
        // is running now.
        mockOs.uptimeSeconds = 60 * 60;
        writeSessions({
            's1': sessionRecord({
                savedAt: Date.now() - 30 * DAY_MS,
                lastAliveAt: Date.now() - 30 * DAY_MS,
                hostPid: process.pid,
            }),
        });

        expect(readPersistedSessions()).toEqual({});
    });

    it('restarts the retention window when a session stops', () => {
        const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
        expect(child.status).toBe(0);
        const record = sessionRecord({ savedAt: Date.now() - 60 * DAY_MS, lastAliveAt: Date.now() - 60 * DAY_MS, hostPid: child.pid });
        persistSession('s1', record);

        markSessionStopped('s1');

        const stored = JSON.parse(readFileSync(mockConfiguration.sessionsFile, 'utf-8')).sessions.s1;
        expect(stored.lastAliveAt).toBeGreaterThan(Date.now() - 5000);
        expect(stored.savedAt).toBeLessThan(Date.now() - 59 * DAY_MS);
        expect(readPersistedSessions().s1).toEqual({ ...record, lastAliveAt: stored.lastAliveAt });
    });

    it.each([
        [14 * DAY_MS - 1, true],
        [14 * DAY_MS, false],
        [14 * DAY_MS + 1, false],
    ])('retains an idle session aged %i ms: %s', (age, retained) => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        writeSessions({ s1: sessionRecord({ savedAt: now - 60 * DAY_MS, lastAliveAt: now - age }) });

        expect(Boolean(readPersistedSessions().s1)).toBe(retained);
    });

    it('preserves a live session and its key when another session is persisted', async () => {
        const record = sessionRecord({ savedAt: Date.now() - 60 * DAY_MS, hostPid: process.pid });
        record.metadata.claudeSessionId = 'claude-session-1';
        writeSessions({ s1: record, stale: sessionRecord({ savedAt: Date.now() - 20 * DAY_MS }) });

        persistSession('s2', sessionRecord());

        const stored = JSON.parse(readFileSync(mockConfiguration.sessionsFile, 'utf-8')).sessions;
        expect(stored.s1).toEqual(record);
        expect(stored.stale).toBeUndefined();
        const resumed = await resolveLocalReconnectableSession('s1');
        expect(resumed.encryptionKey).toEqual(new Uint8Array(Buffer.from(record.encryptionKey, 'base64')));
        expect(resumed).toMatchObject({
            id: 's1',
            encryptionVariant: record.encryptionVariant,
            seq: record.seq,
            metadataVersion: record.metadataVersion,
            agentStateVersion: record.agentStateVersion,
            metadata: record.metadata,
        });
    });

    it('keeps the stop timestamp across a reboot, then expires the idle record', () => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        writeSessions({ s1: sessionRecord({ savedAt: now - 60 * DAY_MS, hostPid: process.pid }) });
        markSessionStopped('s1');

        // A new boot invalidates old PIDs but must not discard recent activity.
        mockOs.uptimeSeconds = 60;
        vi.spyOn(Date, 'now').mockReturnValue(now + DAY_MS);
        expect(readPersistedSessions().s1.lastAliveAt).toBe(now);
        vi.spyOn(Date, 'now').mockReturnValue(now + 14 * DAY_MS);
        expect(readPersistedSessions()).toEqual({});
    });

    it('does not recreate missing sessions or refresh unrelated stale records', () => {
        markSessionStopped('missing');
        expect(existsSync(mockConfiguration.sessionsFile)).toBe(false);
        writeSessions({ stale: sessionRecord({ savedAt: Date.now() - 20 * DAY_MS }) });
        const before = readFileSync(mockConfiguration.sessionsFile, 'utf-8');

        markSessionStopped('missing');

        expect(readFileSync(mockConfiguration.sessionsFile, 'utf-8')).toBe(before);
        expect(readPersistedSessions()).toEqual({});
    });
});
