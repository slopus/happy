import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials, readSettings } from '@/persistence';

/**
 * The offline branch of `runClaude` returns long before the prepared-start
 * helper runs, so the helper's own required-confirmation check cannot cover it.
 * These drive the real module to prove the refusal happens at that branch.
 */

const {
    mockGetOrCreateSession,
    mockClaudeLocal,
    mockStartOfflineReconnection,
    mockInstallBroadKillShims,
    mockReadSettings,
} = vi.hoisted(() => ({
    mockGetOrCreateSession: vi.fn(async () => null),
    mockClaudeLocal: vi.fn(async () => undefined),
    mockStartOfflineReconnection: vi.fn(() => ({ cancel: () => {}, stop: () => {}, promise: new Promise(() => {}) })),
    mockInstallBroadKillShims: vi.fn(),
    mockReadSettings: vi.fn(),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: async () => ({
            getOrCreateSession: (...args: unknown[]) => mockGetOrCreateSession(...(args as [])),
            getOrCreateMachine: async () => ({ id: 'machine-1' }),
            machineSyncClient: () => ({ shutdown: () => {}, setRPCHandlers: () => {} }),
            sessionSyncClient: () => { throw new Error('not reached'); },
            push: async () => undefined,
        }),
    },
}));
vi.mock('@/claude/claudeLocal', () => ({ claudeLocal: mockClaudeLocal }));
// Without this the run reads the developer's real Happy settings and exits 1
// when no machineId is present — the offline branch would never be reached and
// the test would pass for the wrong reason.
vi.mock('@/persistence', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/persistence')>()),
    readSettings: mockReadSettings,
}));
vi.mock('@/utils/serverConnectionErrors', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/serverConnectionErrors')>()),
    startOfflineReconnection: mockStartOfflineReconnection,
}));
vi.mock('@/utils/broadKillShims', () => ({ installBroadKillShims: mockInstallBroadKillShims }));
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: async () => ({}) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: () => ({}) }));

// Imported statically, as runClaude.test.ts does: loading runClaude's whole
// module graph costs ~1.1–1.3s of CPU on a cold worker, and on a loaded host
// that stretched past the 5s test timeout when it happened inside the first
// test's body. Collection has no per-test timeout, so each test now measures
// only the run it asserts on. The branch env is read when runClaude runs, so
// setting it per test before the call is unchanged.
import { runClaude } from './runClaude';

const ORIGINAL_ENV = { ...process.env };

/** The real shape, so a fixture that drifts from it fails to compile. */
const CREDENTIALS: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
};

/**
 * Enough of the real settings for the run to get past its startup checks. The
 * type is taken from the real reader so a drift in that shape breaks here.
 */
const SETTINGS: Awaited<ReturnType<typeof readSettings>> = {
    schemaVersion: 1,
    onboardingCompleted: true,
    machineId: 'machine-under-test',
};

/**
 * Prefixes of every variable that steers a branch this file exercises.
 *
 * Cleared by prefix rather than by an enumerated list: `readReconnectSessionEnvironment`
 * treats *any* of `HAPPY_RECONNECT_SESSION_ID`, `_ENCRYPTION_KEY`,
 * `_ENCRYPTION_VARIANT` and `_SNAPSHOT` as "a reconnect was requested" and then
 * throws when the rest are missing. A list that named only some of them let a
 * single leftover variable in the runner's environment decide the outcome — the
 * run never reached the branch under test, and the failure looked like a
 * product bug. A prefix also covers keys added later.
 */
const BRANCH_ENV_PREFIXES = [
    'HAPPY_INITIAL_PROMPT',
    'HAPPY_MANAGED_',
    'HAPPY_AUTOMATION_',
    'HAPPY_RECONNECT_',
];

function branchEnvKeys(): string[] {
    return Object.keys(process.env)
        .filter((key) => BRANCH_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

/**
 * The offline path ends in `process.exit(0)`. Replacing it with a throw lets
 * the test assert that the run reached exactly that ending, instead of letting
 * any failure pass as "offline ran".
 */
class ProcessExited extends Error {
    constructor(readonly code: number | undefined) {
        super(`process.exit(${code})`);
    }
}
let exitSpy: { mockRestore: () => void };

beforeEach(() => {
    vi.clearAllMocks();
    for (const key of branchEnvKeys()) delete process.env[key];
    // Self-checking: if the isolation ever stops covering something, this fails
    // here rather than surfacing as a confusing product-looking failure later.
    // Names only — no values are read or reported.
    expect(branchEnvKeys()).toEqual([]);
    mockGetOrCreateSession.mockResolvedValue(null);
    mockReadSettings.mockResolvedValue(SETTINGS);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new ProcessExited(typeof code === 'number' ? code : undefined);
    });
});

afterEach(() => {
    exitSpy.mockRestore();
    // Restore the runner's environment exactly: keys this file added go, and
    // anything it cleared comes back.
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) delete process.env[key];
    }
    Object.assign(process.env, ORIGINAL_ENV);
});

async function runOffline(env: Record<string, string>) {
    Object.assign(process.env, env);
    return runClaude({ kind: 'account', credentials: CREDENTIALS }, {});
}

describe('runClaude offline start with required confirmed delivery', () => {
    it('refuses instead of starting a local session', async () => {
        await expect(runOffline({
            HAPPY_INITIAL_PROMPT: '배포 상태 확인',
            HAPPY_INITIAL_PROMPT_LOCAL_ID: 'local-1',
            HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1',
        })).rejects.toThrowError(/durab|confirm/i);

        // The whole point: no turn may begin on a prompt whose landing cannot
        // be confirmed, and the offline path never reaches the helper.
        expect(mockClaudeLocal).not.toHaveBeenCalled();
        expect(mockStartOfflineReconnection).not.toHaveBeenCalled();
    });

    it('still runs offline when confirmation was not required', async () => {
        // Asserting the exact ending, not merely "something threw": a
        // swallowed failure here would look identical to the offline path
        // working.
        await expect(runOffline({
            HAPPY_INITIAL_PROMPT: '배포 상태 확인',
            HAPPY_INITIAL_PROMPT_LOCAL_ID: 'local-1',
        })).rejects.toMatchObject({ code: 0 });

        // BYOS offline behaviour is untouched: the local session ran and the
        // process ended the way that path always ends.
        expect(mockStartOfflineReconnection).toHaveBeenCalledTimes(1);
        expect(mockClaudeLocal).toHaveBeenCalledTimes(1);
    });
});
