import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';

const mocks = vi.hoisted(() => ({
  handlers: null as any,
  webhook: null as any,
  persisted: {} as Record<string, any>,
  get: vi.fn(),
  spawn: vi.fn(),
  logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() },
}));

vi.mock('axios', () => ({ default: { get: mocks.get } }));
vi.mock('fs/promises', () => ({ default: { access: vi.fn(async () => undefined) } }));
vi.mock('@/ui/logger', () => ({ logger: mocks.logger }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://test.invalid', happyHomeDir: '/test-only' } }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'test-token' }, machineId: 'machine-1' }) }));
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }));
vi.mock('@/utils/caffeinate', () => ({ startCaffeinate: () => false, stopCaffeinate: vi.fn() }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: () => ({}) }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));
vi.mock('@/utils/tmux', () => ({}));
vi.mock('@/resume/localHappyAgentAuth', () => ({ detectResumeSupport: () => ({}), hasLocalHappyAgentAuth: () => false }));
vi.mock('./happyTerminalBoot', () => ({ startHappyTerminalDaemon: vi.fn() }));
vi.mock('@/persistence', () => ({
  readPersistedSessions: () => mocks.persisted,
  persistSession: vi.fn(), writeDaemonState: vi.fn(), readDaemonState: vi.fn(),
  acquireDaemonLock: async () => ({}), releaseDaemonLock: vi.fn(),
}));
vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: async () => false,
  stopDaemon: vi.fn(), cleanupDaemonState: vi.fn(),
}));
vi.mock('./controlServer', () => ({ startDaemonControlServer: async (options: any) => {
  mocks.webhook = options.onHappySessionWebhook;
  return { port: 0, stop: vi.fn() };
} }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({
  getOrCreateMachine: async () => ({ id: 'machine-1' }),
  machineSyncClient: () => ({
    setRPCHandlers: (handlers: any) => { mocks.handlers = handlers; },
    // Stop boot after capturing the real resume closure, before heartbeat timers.
    connect: () => { throw new Error('test boot complete'); },
  }),
}) } }));

import { startDaemon } from './run';

const dataKey = new Uint8Array(32).fill(1);
const metadata = { path: '/project', machineId: 'machine-1', flavor: 'claude', claudeSessionId: 'claude-old' };
const fallback = {
  metadata, metadataVersion: 3, agentStateVersion: 4, seq: 12,
  encryptionKey: encodeBase64(dataKey), encryptionVariant: 'dataKey',
};

async function boot() {
  await expect(startDaemon()).rejects.toThrow('test exit');
}

describe('daemon resume fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persisted = {};
    // Never register real process handlers, stop daemons, bind ports, or spawn providers.
    vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });
    mocks.get.mockResolvedValue({ data: { sessions: Array.from({ length: 150 }, (_, i) => ({ id: `recent-${i}`, metadata: '' })) } });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('old-session', { ...metadata, hostPid: 12345 }));
      return { pid: 12345, on: vi.fn() };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('resumes an untracked old session across fresh daemon boots without listing sessions', async () => {
    for (let restart = 0; restart < 2; restart++) {
      await boot();
      expect(await mocks.handlers.resumeSession('old-session', { fallback })).toEqual({ type: 'success', sessionId: 'old-session' });
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(
      ['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon', '--resume', 'claude-old'],
      expect.objectContaining({ cwd: '/project', env: expect.objectContaining({
        HAPPY_RECONNECT_SESSION_ID: 'old-session', HAPPY_RECONNECT_ENCRYPTION_KEY: fallback.encryptionKey,
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey', HAPPY_RECONNECT_SEQ: '12',
      }) }),
    );
  });

  it.each(['claude', 'codex'])('refreshes a missing %s provider ID from server metadata', async (flavor) => {
    await boot();
    const complete = flavor === 'codex'
      ? { path: '/project', machineId: 'machine-1', flavor, codexThreadId: 'thread-old' }
      : metadata;
    mocks.get.mockResolvedValue({ data: { sessions: [{ id: 'old-session', metadata: encodeBase64(encrypt(dataKey, 'dataKey', complete)) }] } });
    expect(await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: { path: '/project', machineId: 'machine-1', flavor } } }))
      .toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][0]).toContain(flavor === 'codex' ? 'thread-old' : 'claude-old');
  });

  it.each(['claude', 'codex'])('uses a client %s ID when persisted startup metadata is stale beyond the 150-row page', async (flavor) => {
    const complete = flavor === 'codex'
      ? { path: '/client-stale-path', machineId: 'machine-1', flavor, codexThreadId: 'thread-old' }
      : { ...metadata, path: '/client-stale-path' };
    mocks.persisted = { 'old-session': { ...fallback, metadata: { path: '/tracked-path', machineId: 'machine-1', flavor } } };
    await boot();
    expect(await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: complete } }))
      .toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls[0][1].cwd).toBe('/tracked-path');
    expect(mocks.spawn.mock.calls[0][0]).toContain(flavor === 'codex' ? 'thread-old' : 'claude-old');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('does not fill a tracked provider ID from a different provider fallback', async () => {
    mocks.persisted = { 'old-session': { ...fallback, metadata: { ...metadata, claudeSessionId: undefined } } };
    await boot();
    expect(await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: { ...metadata, flavor: 'codex', codexThreadId: 'other-thread' } } }))
      .toMatchObject({ type: 'error' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('preserves live tracked metadata and encryption over fallback', async () => {
    mocks.persisted = { 'old-session': { ...fallback, metadata: { ...metadata, claudeSessionId: 'tracked-id' }, encryptionVariant: 'legacy' } };
    await boot();
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls[0][0]).toContain('tracked-id');
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_RECONNECT_ENCRYPTION_VARIANT).toBe('legacy');
  });

  it('fails without spawning when an old session has no provider ID anywhere', async () => {
    await boot();
    const result = await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: { ...metadata, claudeSessionId: undefined } } });
    expect(result).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('missing its Claude session ID') });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('keeps untracked legacy sessions unsupported without asking for a master secret', async () => {
    await boot();
    expect(await mocks.handlers.resumeSession('old-session')).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('Legacy sessions') });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});