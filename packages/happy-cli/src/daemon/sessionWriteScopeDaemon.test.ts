import type { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { startDaemon } from './run';
import { createSessionWriteScopeRuntime } from './sessionWriteScopeRuntime';
import { startDaemonControlServer } from './controlServer';

vi.mock('@/sandbox/dependencyPreflight', () => ({ reportSandboxDependencyPreflight: vi.fn(), reportSandboxExecutionPreflight: vi.fn() }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: vi.fn(async () => ({
  credentials: { token: 'fixture', encryption: { type: 'dataKey', publicKey: new Uint8Array(32),
    machineKey: new Uint8Array(32), neverEscrowed: true } }, machineId: 'machine', serverPublicKey: null,
} satisfies Awaited<ReturnType<typeof import('@/ui/auth')['authAndSetupMachineIfNeeded']>>) ) }));
vi.mock('@/utils/caffeinate', () => ({ startCaffeinate: vi.fn(() => false), stopCaffeinate: vi.fn() }));
vi.mock('./installArtifactsHeal', () => ({ healInstallArtifacts: vi.fn() }));
vi.mock('./managedRuntimeIdentity', () => ({ managedProvisioningPath: vi.fn(), resolveManagedRuntimeIdentity: vi.fn(() => ({ status: 'absent' })) }));
vi.mock('./handoff', async original => ({ ...await original<typeof import('./handoff')>(), prepareDaemonStartup: vi.fn(async () => 'start') }));
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
  readDaemonState: vi.fn(async () => null), acquireDaemonLock: vi.fn(async () => ({})),
  hardenHappyHomePermissions: vi.fn(), readPersistedSessions: vi.fn(() => ({})),
}));
vi.mock('./stageUserCredentials', async original => ({ ...await original<typeof import('./stageUserCredentials')>(), sweepOrphanUserHomeDirs: vi.fn(async () => []) }));
vi.mock('./standaloneWindowsRuntime', async original => ({ ...await original<typeof import('./standaloneWindowsRuntime')>(), createStandaloneWindowsRuntime: vi.fn(async () => undefined) }));
vi.mock('./browserNativeHostRegistration', async original => ({ ...await original<typeof import('./browserNativeHostRegistration')>(), prepareBrowserNativeMessaging: vi.fn(async () => ({ token: 'fixture', manifestPath: null })) }));
vi.mock('./browserBridgeServer', async original => ({ ...await original<typeof import('./browserBridgeServer')>(), startBrowserBridgeServer: vi.fn(async () => ({ stop: vi.fn() })) }));
vi.mock('./sessionWriteScopeRuntime', async original => ({ ...await original<typeof import('./sessionWriteScopeRuntime')>(), createSessionWriteScopeRuntime: vi.fn(async () => null) }));
vi.mock('./controlServer', async original => ({ ...await original<typeof import('./controlServer')>(), startDaemonControlServer: vi.fn(async () => { throw new Error('fixture startup stopped'); }) }));

const events = process as EventEmitter;
const signals = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'] as const;
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('passes private host bootstrap through real daemon startup while scrubbing child lineage', async () => {
  const bootstrap = {
    HAPPY_WRITE_SCOPE_HOST_VERSION: '1', HAPPY_WRITE_SCOPE_HOST_ACCOUNT_ID: 'account',
    HAPPY_WRITE_SCOPE_HOST_INCARNATION: 'host', HAPPY_WRITE_SCOPE_HOST_PROTECTED_ROOTS: '["/fixture/protected"]',
    HAPPY_WRITE_SCOPE_HOST_PUBLIC_KEY: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  for (const [key, value] of Object.entries(bootstrap)) vi.stubEnv(key, value);
  vi.stubEnv('HAPPY_WRITE_SCOPE_SESSION', '1'); vi.stubEnv('HAPPY_RECONNECT_SESSION', 'poison');
  const listeners = signals.map(signal => [signal, new Set(events.rawListeners(signal))] as const);
  const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  vi.spyOn(logger, 'debugLargeJson').mockImplementation(() => {});
  vi.spyOn(process, 'chdir').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture exit'); });
  try {
    await expect(startDaemon()).rejects.toThrow('fixture exit');
    expect(debug.mock.calls.filter(([message]) => message.startsWith('[DAEMON RUN][FATAL]'))
      .map(([, error]) => (error as Error).message)).toEqual(['fixture startup stopped']);
    expect(createSessionWriteScopeRuntime).toHaveBeenCalledOnce();
    const input = vi.mocked(createSessionWriteScopeRuntime).mock.calls[0][0];
    expect(Object.keys(input.env).sort()).toEqual(Object.keys(bootstrap).sort());
    for (const [key, value] of Object.entries(bootstrap)) expect(input.env[key]).toBe(value);
    expect(input).toMatchObject({ machineId: 'machine', managed: false });
    expect(startDaemonControlServer).toHaveBeenCalledOnce();
    for (const key of [...Object.keys(bootstrap), 'HAPPY_WRITE_SCOPE_SESSION', 'HAPPY_RECONNECT_SESSION']) {
      expect(process.env[key]).toBeUndefined();
    }
  } finally {
    for (const [signal, previous] of listeners) {
      for (const listener of events.rawListeners(signal)) if (!previous.has(listener)) events.removeListener(signal, listener as (...args: unknown[]) => void);
    }
  }
});
