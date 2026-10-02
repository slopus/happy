import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from './configuration';
import {
    persistSession,
    readDaemonState,
    readDaemonStateSnapshot,
    readPersistedSessions,
    SandboxConfigSchema,
    writeDaemonState,
    writeDaemonStateIfUnchanged,
    type DaemonLocallyPersistedState,
    type PersistedSession,
} from './persistence';

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: true,
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

    it('keeps checkpoint protection opt-in and requires every policy value', () => {
        expect(SandboxConfigSchema.parse({})).not.toHaveProperty('checkpointProtection');

        const checkpointProtection = {
            secretPatterns: ['.env*'],
            maxFileBytes: 1_000_000,
            maxFiles: 10_000,
            maxTotalBytes: 100_000_000,
        };
        expect(SandboxConfigSchema.parse({ checkpointProtection }).checkpointProtection)
            .toEqual(checkpointProtection);
        expect(() => SandboxConfigSchema.parse({
            checkpointProtection: { secretPatterns: ['.env*'] },
        })).toThrow();
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

describe('session persistence retention', () => {
    const originalSessionsFile = configuration.sessionsFile;
    let testDirectory: string;

    beforeEach(() => {
        testDirectory = mkdtempSync(join(tmpdir(), 'happy-persistence-'));
        Object.defineProperty(configuration, 'sessionsFile', {
            configurable: true,
            value: join(testDirectory, 'sessions.json'),
        });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'sessionsFile', {
            configurable: true,
            value: originalSessionsFile,
        });
        rmSync(testDirectory, { recursive: true, force: true });
    });

    function session(savedAt: number): PersistedSession {
        return {
            encryptionKey: Buffer.alloc(32, 1).toString('base64'),
            encryptionVariant: 'dataKey',
            seq: 7,
            metadataVersion: 3,
            agentStateVersion: 2,
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/.happy/lib',
                happyToolsDir: '/tmp/.happy/tools',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
            savedAt,
            lastProcessedSeq: 6,
        };
    }

    it('reads a valid session saved more than 15 days ago', () => {
        const oldSession = session(Date.now() - 15 * 24 * 60 * 60 * 1000);
        writeFileSync(
            configuration.sessionsFile,
            JSON.stringify({ sessions: { old: oldSession } }),
            'utf8',
        );

        expect(readPersistedSessions()).toEqual({ old: oldSession });
    });

    it('keeps an old session when persisting another session', () => {
        const oldSession = session(Date.now() - 15 * 24 * 60 * 60 * 1000);
        writeFileSync(
            configuration.sessionsFile,
            JSON.stringify({ sessions: { old: oldSession } }),
            'utf8',
        );

        persistSession('new', session(Date.now()));

        const persisted = JSON.parse(readFileSync(configuration.sessionsFile, 'utf8')) as {
            sessions: Record<string, PersistedSession>;
        };
        expect(persisted.sessions).toEqual({
            old: oldSession,
            new: expect.objectContaining({ savedAt: expect.any(Number) }),
        });
    });
});

describe('daemon state compare-and-set', () => {
    const originalDaemonStateFile = configuration.daemonStateFile;
    let testDirectory: string;

    beforeEach(() => {
        testDirectory = mkdtempSync(join(tmpdir(), 'happy-daemon-state-'));
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: join(testDirectory, 'daemon.state.json'),
        });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: originalDaemonStateFile,
        });
        rmSync(testDirectory, { recursive: true, force: true });
    });

    function daemonState(pid: number): DaemonLocallyPersistedState {
        return {
            pid,
            httpPort: 33417,
            startTime: '8/17/2026, 12:05:29 PM',
            startedWithCliVersion: '1.1.10',
            daemonLogPath: join(testDirectory, 'daemon.log'),
            state: 'running',
            trackedSessions: [],
        };
    }

    it('writes when the file still holds the contents the caller read', async () => {
        writeDaemonState(daemonState(111));
        const { raw } = await readDaemonStateSnapshot();

        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(true);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(222);
    });

    it('refuses to write when another process rewrote the file first', async () => {
        writeDaemonState(daemonState(111));
        const { raw } = await readDaemonStateSnapshot();

        // A daemon starts and claims the file between our read and our write.
        writeDaemonState(daemonState(999));

        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(false);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(999);
    });

    it('writes when the caller read an absent file that is still absent', async () => {
        const { state, raw } = await readDaemonStateSnapshot();

        expect(state).toBeNull();
        expect(writeDaemonStateIfUnchanged(raw, daemonState(222))).toBe(true);
        expect((await readDaemonStateSnapshot()).state?.pid).toBe(222);
    });
});

// aplus §6-1 Phase 3b (aplus-dev-studio specs/20260818-e2ee-account-keypair) —
// access.key 에 secret(legacy, 활성) + encryption(provisioned dataKey 재료)이
// **병기**된 파일의 파싱 계약. secret 우선이라 RPC 는 legacy 그대로지만,
// provisioned 재료는 버리지 않고 실어 나른다 (getOrCreateMachine 이
// dataEncryptionKey 를 서버에 등록하는 데 쓴다).
describe('daemon state file permissions', () => {
    const originalDaemonStateFile = configuration.daemonStateFile;
    let testDirectory: string;
    let stateFile: string;

    beforeEach(() => {
        testDirectory = mkdtempSync(join(tmpdir(), 'happy-daemon-state-perms-'));
        stateFile = join(testDirectory, 'daemon.state.json');
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: stateFile,
        });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'daemonStateFile', {
            configurable: true,
            value: originalDaemonStateFile,
        });
        rmSync(testDirectory, { recursive: true, force: true });
    });

    function daemonState(controlSecret?: string): DaemonLocallyPersistedState {
        return {
            pid: 111,
            httpPort: 33417,
            startTime: '8/17/2026, 12:05:29 PM',
            startedWithCliVersion: '1.1.10',
            state: 'running',
            trackedSessions: [],
            controlSecret,
        };
    }

    // Loopback control server auth (ADR-061) relies on this file being
    // unreadable by other local users — a world/group-readable secret defeats
    // the whole point of the Bearer check.
    it.skipIf(process.platform === 'win32')('writes the daemon state file with 0600 permissions', () => {
        writeDaemonState(daemonState('s3cr3t'));

        const mode = statSync(stateFile).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it.skipIf(process.platform === 'win32')('tightens permissions on a file that pre-existed with looser mode', () => {
        writeFileSync(stateFile, '{}', { mode: 0o644 });

        writeDaemonState(daemonState('s3cr3t'));

        const mode = statSync(stateFile).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('round-trips controlSecret through write and read', async () => {
        writeDaemonState(daemonState('s3cr3t'));

        expect((await readDaemonState())?.controlSecret).toBe('s3cr3t');
    });
});

describe('parseCredentials', () => {
    it('keeps plain legacy files as pure legacy (no provisioned)', async () => {
        const { parseCredentials } = await import('./persistence');
        const parsed = parseCredentials({ token: 't', secret: Buffer.alloc(32, 1).toString('base64') });
        expect(parsed).not.toBeNull();
        expect(parsed!.encryption.type).toBe('legacy');
        expect((parsed!.encryption as any).provisioned).toBeUndefined();
    });

    it('keeps pure dataKey files as dataKey', async () => {
        const { parseCredentials } = await import('./persistence');
        const parsed = parseCredentials({
            token: 't',
            encryption: {
                publicKey: Buffer.alloc(32, 2).toString('base64'),
                machineKey: Buffer.alloc(32, 3).toString('base64'),
            },
        });
        expect(parsed!.encryption.type).toBe('dataKey');
    });

    it('parses a combined file as legacy-active with provisioned material attached', async () => {
        const { parseCredentials } = await import('./persistence');
        const parsed = parseCredentials({
            token: 't',
            secret: Buffer.alloc(32, 1).toString('base64'),
            encryption: {
                publicKey: Buffer.alloc(32, 2).toString('base64'),
                machineKey: Buffer.alloc(32, 3).toString('base64'),
            },
        });
        expect(parsed!.encryption.type).toBe('legacy');
        const legacy = parsed!.encryption as Extract<
            NonNullable<ReturnType<typeof parseCredentials>>['encryption'],
            { type: 'legacy' }
        >;
        expect(legacy.secret).toEqual(new Uint8Array(Buffer.alloc(32, 1)));
        expect(legacy.provisioned?.publicKey).toEqual(new Uint8Array(Buffer.alloc(32, 2)));
        expect(legacy.provisioned?.machineKey).toEqual(new Uint8Array(Buffer.alloc(32, 3)));
    });

    it('returns null for malformed payloads', async () => {
        const { parseCredentials } = await import('./persistence');
        expect(parseCredentials({ token: 't' })).toBeNull();
        expect(parseCredentials('nonsense')).toBeNull();
    });

    /*
     * aplus-dev-studio specs/e2ee-machine-control-boundary R4 — only a key
     * recorded as never escrowed is spared a strict-mode rotation; a file that
     * says nothing counts as escrowed.
     */
    it('keeps the never-escrowed mark of a dataKey file and assumes nothing without it', async () => {
        const { parseCredentials } = await import('./persistence');
        const encryption = {
            publicKey: Buffer.alloc(32, 2).toString('base64'),
            machineKey: Buffer.alloc(32, 3).toString('base64'),
        };
        const marked = parseCredentials({ token: 't', encryption: { ...encryption, neverEscrowed: true } });
        const unmarked = parseCredentials({ token: 't', encryption });

        const contradicted = parseCredentials({ token: 't', encryption: { ...encryption, neverEscrowed: false } });

        expect(marked!.encryption).toMatchObject({ type: 'dataKey', neverEscrowed: true });
        expect(unmarked!.encryption).not.toHaveProperty('neverEscrowed');
        expect(contradicted!.encryption).not.toHaveProperty('neverEscrowed');
    });
});

describe('replaceCredentialsDataKey', () => {
    it('replaces access.key owner-only, carrying the never-escrowed mark only when set', async () => {
        const { readCredentials, replaceCredentialsDataKey } = await import('./persistence');
        const machineKey = new Uint8Array(Buffer.alloc(32, 4));
        const publicKey = new Uint8Array(Buffer.alloc(32, 5));

        await replaceCredentialsDataKey({ token: 't', publicKey, machineKey, neverEscrowed: true });
        expect((await readCredentials())!.encryption).toEqual({ type: 'dataKey', publicKey, machineKey, neverEscrowed: true });
        if (process.platform !== 'win32') {
            expect(statSync(configuration.privateKeyFile).mode & 0o777).toBe(0o600);
        }

        await replaceCredentialsDataKey({ token: 't', publicKey, machineKey });
        expect(JSON.parse(readFileSync(configuration.privateKeyFile, 'utf8')).encryption).not.toHaveProperty('neverEscrowed');
    });
});

describe('serializeProvisionedLegacyCredentials', () => {
    it('round-trips through parseCredentials preserving both secret and provisioned material', async () => {
        const { parseCredentials, serializeProvisionedLegacyCredentials } = await import('./persistence');
        const serialized = serializeProvisionedLegacyCredentials({
            token: 't',
            secret: new Uint8Array(Buffer.alloc(32, 1)),
            publicKey: new Uint8Array(Buffer.alloc(32, 2)),
            machineKey: new Uint8Array(Buffer.alloc(32, 3)),
        });
        // 구버전 CLI 호환: 구 스키마도 파싱 가능해야 한다 (secret 우선, 미지
        // 필드 무시). serialized 는 plain JSON object 다.
        expect(serialized.secret).toBeDefined();
        expect(serialized.token).toBe('t');

        const parsed = parseCredentials(serialized);
        expect(parsed!.encryption.type).toBe('legacy');
        expect((parsed!.encryption as any).provisioned.machineKey).toEqual(new Uint8Array(Buffer.alloc(32, 3)));
    });
});

describe('buildProvisionedLegacyCredentials', () => {
    const legacy = (): any => ({
        token: 't',
        encryption: { type: 'legacy', secret: new Uint8Array(Buffer.alloc(32, 1)) },
    });

    it('attaches the machine key wrapped target and serializes the combined file', async () => {
        const { buildProvisionedLegacyCredentials } = await import('./persistence');
        const machineKey = new Uint8Array(Buffer.alloc(32, 9));
        const accountPublicKey = Buffer.alloc(32, 2).toString('base64');

        const { updated, serialized } = buildProvisionedLegacyCredentials(legacy(), accountPublicKey, machineKey);

        expect(updated.encryption.type).toBe('legacy');
        expect((updated.encryption as any).secret).toEqual(new Uint8Array(Buffer.alloc(32, 1)));
        expect((updated.encryption as any).provisioned.publicKey).toEqual(new Uint8Array(Buffer.alloc(32, 2)));
        expect((updated.encryption as any).provisioned.machineKey).toEqual(machineKey);
        expect(serialized.secret).toBe(Buffer.alloc(32, 1).toString('base64'));
        expect(serialized.encryption.machineKey).toBe(Buffer.from(machineKey).toString('base64'));
    });

    it('rejects an account public key that is not 32 bytes', async () => {
        const { buildProvisionedLegacyCredentials } = await import('./persistence');
        expect(() => buildProvisionedLegacyCredentials(legacy(), Buffer.alloc(16, 2).toString('base64'), new Uint8Array(32)))
            .toThrow(/32/);
    });

    it('rejects non-legacy or already-provisioned credentials', async () => {
        const { buildProvisionedLegacyCredentials } = await import('./persistence');
        const dataKey: any = {
            token: 't',
            encryption: { type: 'dataKey', publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) },
        };
        expect(() => buildProvisionedLegacyCredentials(dataKey, Buffer.alloc(32).toString('base64'), new Uint8Array(32))).toThrow();

        const provisioned = legacy();
        provisioned.encryption.provisioned = { publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) };
        expect(() => buildProvisionedLegacyCredentials(provisioned, Buffer.alloc(32).toString('base64'), new Uint8Array(32))).toThrow();
    });
});
