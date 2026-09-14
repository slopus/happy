import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, encrypt } from '@/api/encryption';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  handlers: null as any,
  webhook: null as any,
  children: null as any,
  persisted: {} as Record<string, any>,
  get: vi.fn(),
  spawn: vi.fn(),
  access: vi.fn(),
  persistSession: vi.fn(),
  logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() },
}));

vi.mock('axios', () => ({ default: { get: mocks.get } }));
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, default: { ...original, homedir: () => process.env.HAPPY_HOME_DIR! } };
});
vi.mock('fs/promises', () => ({ default: { access: mocks.access } }));
vi.mock('@/ui/logger', () => ({ logger: mocks.logger }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://test.invalid', happyHomeDir: '/test-only' } }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'test-token' }, machineId: 'machine-1' }) }));
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }));
vi.mock('@/utils/caffeinate', () => ({ startCaffeinate: () => false, stopCaffeinate: vi.fn() }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: () => ({}) }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));
vi.mock('@/utils/tmux', () => ({ isTmuxAvailable: async () => false }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ detectResumeSupport: () => ({}), hasLocalHappyAgentAuth: () => false }));
vi.mock('./happyTerminalBoot', () => ({ startHappyTerminalDaemon: vi.fn() }));
vi.mock('@/persistence', () => ({
  readPersistedSessions: () => mocks.persisted,
  persistSession: mocks.persistSession, markSessionStopped: vi.fn(), writeDaemonState: vi.fn(), readDaemonState: vi.fn(),
  acquireDaemonLock: async () => ({}), releaseDaemonLock: vi.fn(),
}));
vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: async () => false,
  stopDaemon: vi.fn(), cleanupDaemonState: vi.fn(),
}));
vi.mock('./controlServer', () => ({ startDaemonControlServer: async (options: any) => {
  mocks.webhook = options.onHappySessionWebhook;
  mocks.children = options.getChildren;
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
const realKill = process.kill.bind(process);

async function boot() {
  await expect(startDaemon()).rejects.toThrow('test exit');
}

describe('daemon resume fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persisted = {};
    mocks.persistSession.mockReset();
    mocks.access.mockResolvedValue(undefined);
    // Never register real process handlers, stop daemons, bind ports, or spawn providers.
    vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });
    vi.spyOn(process, 'kill').mockReturnValue(true);
    mocks.get.mockResolvedValue({ data: { sessions: Array.from({ length: 150 }, (_, i) => ({ id: `recent-${i}`, metadata: '' })) } });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('old-session', { ...metadata, hostPid: 12345 }));
      return { pid: 12345, on: vi.fn() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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

  it('reuses a live Codex owner instead of starting another producer for the same session/thread', async () => {
    await boot();
    const codexMetadata = { ...metadata, flavor: 'codex', codexThreadId: 'thread-old', hostPid: 12344 };
    mocks.webhook('old-session', codexMetadata, { ...fallback, encryptionKey: dataKey });
    expect(await mocks.handlers.resumeSession('old-session')).toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls.length).toBe(0);
  });

  it('coalesces concurrent resumes into one owner before its webhook', async () => {
    await boot();
    let nextPid = 12345;
    mocks.spawn.mockImplementation(() => {
      const pid = nextPid++;
      queueMicrotask(() => mocks.webhook('old-session', { ...metadata, hostPid: pid }));
      return { pid, on: vi.fn() };
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => mocks.handlers.resumeSession('old-session', { fallback })));
    expect(results).toEqual(Array(5).fill({ type: 'success', sessionId: 'old-session' }));
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.children()).toHaveLength(1);
  });

  it('relaunches a dead tracked owner without waiting for the heartbeat', async () => {
    await boot();
    mocks.webhook('old-session', { ...metadata, hostPid: 12344 }, { ...fallback, encryptionKey: dataKey });
    vi.mocked(process.kill).mockImplementation((pid) => {
      if (pid === 12344) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    expect(await mocks.handlers.resumeSession('old-session')).toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    expect(mocks.children().map((child: any) => child.pid)).toEqual([12345]);
  });

  it('does not infer death from permission-denied liveness checks', async () => {
    await boot();
    mocks.webhook('old-session', { ...metadata, hostPid: 12344 }, { ...fallback, encryptionKey: dataKey });
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    await mocks.handlers.resumeSession('old-session');
    expect(mocks.spawn.mock.calls.length).toBe(0);
  });

  it('releases the inflight slot after failed spawn so retry can succeed', async () => {
    await boot();
    mocks.spawn.mockImplementationOnce(() => { throw new Error('spawn failed'); });
    const results = await Promise.all(Array.from({ length: 3 }, () => mocks.handlers.resumeSession('old-session', { fallback })));
    expect(results.every((result) => result.type === 'error')).toBe(true);
    expect(mocks.spawn.mock.calls.length).toBe(1);
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls.length).toBe(2);
  });

  it('keeps ownership after a webhook timeout, then reuses a late registration', async () => {
    vi.useFakeTimers();
    await boot();
    mocks.spawn.mockReturnValue({ pid: 12345, on: vi.fn() });
    const first = mocks.handlers.resumeSession('old-session', { fallback });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('timeout') });
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'error' });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    mocks.webhook('old-session', { ...metadata, hostPid: 12345 }, { ...fallback, encryptionKey: dataKey });
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toEqual({ type: 'success', sessionId: 'old-session' });
    expect(mocks.spawn.mock.calls.length).toBe(1);
  });

  it('persists the new owner before webhook so a daemon restart cannot duplicate it', async () => {
    vi.useFakeTimers();
    await boot();
    mocks.persistSession.mockImplementation((id, record) => { mocks.persisted[id] = record; });
    mocks.spawn.mockReturnValue({ pid: 12345, on: vi.fn() });
    const first = mocks.handlers.resumeSession('old-session', { fallback });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.persisted['old-session'].metadata.hostPid).toBe(12345);
    await boot();
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('ownership cannot be verified') });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toMatchObject({ type: 'error' });
  });

  it('rejects a mismatched reconnect webhook before persistence or registration', async () => {
    await boot();
    mocks.spawn.mockReturnValue({ pid: 12345, on: vi.fn() });
    const resume = mocks.handlers.resumeSession('old-session', { fallback });
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.length).toBe(1));
    const writes = mocks.persistSession.mock.calls.length;
    mocks.webhook('wrong-session', { ...metadata, hostPid: 12345 }, { ...fallback, encryptionKey: dataKey });
    expect(mocks.persistSession.mock.calls.length).toBe(writes);
    expect(mocks.children()[0].happySessionId).toBe('old-session');
    mocks.webhook('old-session', { ...metadata, hostPid: 12345 }, { ...fallback, encryptionKey: dataKey });
    expect(await resume).toMatchObject({ type: 'success', sessionId: 'old-session' });
  });

  it('allows distinct session IDs to launch in parallel', async () => {
    await boot();
    let nextPid = 12345;
    mocks.spawn.mockImplementation((_args, options) => {
      const pid = nextPid++;
      queueMicrotask(() => mocks.webhook(options.env.HAPPY_RECONNECT_SESSION_ID, { ...metadata, hostPid: pid }));
      return { pid, on: vi.fn() };
    });
    expect(await Promise.all(['one', 'two'].map((id) => mocks.handlers.resumeSession(id, { fallback })))).toEqual([
      { type: 'success', sessionId: 'one' }, { type: 'success', sessionId: 'two' },
    ]);
    expect(mocks.spawn.mock.calls.length).toBe(2);
  });

  it('cancels a resume stopped before directory validation completes', async () => {
    await boot();
    let releaseAccess!: () => void;
    mocks.access.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseAccess = resolve; }));
    const resume = mocks.handlers.resumeSession('old-session', { fallback });
    await vi.waitFor(() => expect(releaseAccess).toBeTypeOf('function'));
    expect(mocks.handlers.stopSession('old-session')).toBe(true);
    releaseAccess();
    expect(await resume).toMatchObject({ type: 'error' });
    expect(mocks.spawn.mock.calls.length).toBe(0);
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
  });

  it('retains a stopping owner until exit, then permits a clean relaunch', async () => {
    await boot();
    const child = Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() });
    mocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => mocks.webhook('old-session', { ...metadata, hostPid: child.pid }, { ...fallback, encryptionKey: dataKey }));
      return child;
    });
    await mocks.handlers.resumeSession('old-session', { fallback });
    expect(mocks.handlers.stopSession('old-session')).toBe(true);
    expect(mocks.children()).toHaveLength(1);
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('stopping') });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    child.emit('exit', 0, null);
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
    expect(mocks.spawn.mock.calls.length).toBe(2);
  });

  it('fails a child exit before webhook promptly and permits retry', async () => {
    await boot();
    const child = Object.assign(new EventEmitter(), { pid: 12344 });
    mocks.spawn.mockReturnValueOnce(child);
    const resume = mocks.handlers.resumeSession('old-session', { fallback });
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.length).toBe(1));
    child.emit('exit', 1, null);
    expect(await resume).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('exited') });
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
    expect(mocks.spawn.mock.calls.length).toBe(2);
  });

  it('handles no-PID spawn errors and permits retry', async () => {
    await boot();
    const child = new EventEmitter();
    mocks.spawn.mockReturnValueOnce(child);
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'error' });
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
  });

  it('rechecks ownership when another owner registers during async preparation', async () => {
    await boot();
    mocks.access.mockImplementationOnce(async () => {
      mocks.webhook('old-session', { ...metadata, hostPid: 12344 }, { ...fallback, encryptionKey: dataKey });
    });
    expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
    expect(mocks.spawn.mock.calls.length).toBe(0);
  });

  it('does not trust a live hostPid supplied only by a client fallback', async () => {
    await boot();
    expect(await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: { ...metadata, hostPid: 12344 } } })).toMatchObject({ type: 'success' });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    expect(vi.mocked(process.kill).mock.calls.length).toBe(0);
  });

  it('allows a pre-reboot persisted record even if that PID now exists', async () => {
    mocks.persisted = { 'old-session': { ...fallback, metadata: { ...metadata, hostPid: 12344 }, savedAt: 1 } };
    await boot();
    expect(await mocks.handlers.resumeSession('old-session')).toMatchObject({ type: 'success' });
    expect(mocks.spawn.mock.calls.length).toBe(1);
    expect(vi.mocked(process.kill).mock.calls.length).toBe(0);
  });

  it('prevents a fresh archive from starting a second real owner before the first exits', async () => {
    await boot();
    const owners: ChildProcess[] = [];
    const codexMetadata = { ...metadata, flavor: 'codex', codexThreadId: 'thread-old' };
    mocks.spawn.mockImplementation(() => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/resume-owner.cjs', import.meta.url))], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR, HAPPY_BOOT_AGENT: '0', HAPPY_EXPERIMENTAL: '0' },
      });
      owners.push(child);
      child.on('message', (message: any) => {
        if (message.backendPid) mocks.webhook('old-session', { ...codexMetadata, hostPid: child.pid }, { ...fallback, encryptionKey: dataKey });
      });
      return child;
    });
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      if (!owners.some((child) => child.pid === Math.abs(pid))) throw new Error('Unexpected fixture PID');
      return realKill(pid, signal);
    });
    try {
      expect(await mocks.handlers.spawnSession({ directory: '/project', agent: 'codex' })).toMatchObject({ type: 'success' });
      const stopping = once(owners[0], 'message');
      expect(mocks.handlers.stopSession('old-session')).toBe(true);
      await stopping;
      expect(realKill(owners[0].pid!, 0)).toBe(true);
      const result = await mocks.handlers.resumeSession('old-session', { fallback: { ...fallback, metadata: codexMetadata } });
      expect(owners.every((child) => realKill(child.pid!, 0))).toBe(true);
      expect(owners.length).toBe(1);
      expect(result.type).toBe('error');
    } finally {
      await Promise.all(owners.map(async (child) => {
        const exited = once(child, 'exit');
        child.send('finish');
        await exited;
      }));
    }
  });

  it('keeps one real owner/backend tree through concurrent resumes, archive, and daemon restart', async () => {
    await boot();
    const owners: ChildProcess[] = [];
    const backends: number[] = [];
    const codexMetadata = { ...metadata, flavor: 'codex', codexThreadId: 'thread-old' };
    mocks.spawn.mockImplementation(() => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/resume-owner.cjs', import.meta.url))], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR, HAPPY_BOOT_AGENT: '0', HAPPY_EXPERIMENTAL: '0' },
      });
      owners.push(child);
      child.on('message', (message: any) => {
        if (message.backendPid) {
          backends.push(message.backendPid);
          mocks.webhook('old-session', { ...codexMetadata, hostPid: child.pid }, { ...fallback, encryptionKey: dataKey });
        }
      });
      return child;
    });
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      // Only this fixture's explicit PIDs/process groups may be probed/signalled.
      if (!owners.some((child) => child.pid === Math.abs(pid))) throw new Error('Unexpected fixture PID');
      return realKill(pid, signal);
    });
    const finishOwner = async (child: ChildProcess) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.send('finish');
      await exited;
    };
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => mocks.handlers.resumeSession('old-session', {
        fallback: { ...fallback, metadata: codexMetadata },
      })));
      for (const child of owners) expect(realKill(child.pid!, 0)).toBe(true);
      for (const pid of backends) expect(realKill(pid, 0)).toBe(true);
      expect(results).toEqual(Array(3).fill({ type: 'success', sessionId: 'old-session' }));
      expect(owners).toHaveLength(1);
      expect(backends).toHaveLength(1);
      expect(await mocks.handlers.resumeSession('old-session')).toMatchObject({ type: 'success' });
      expect(owners).toHaveLength(1);

      const stopping = once(owners[0], 'message');
      expect(mocks.handlers.stopSession('old-session')).toBe(true);
      await stopping;
      expect(realKill(owners[0].pid!, 0)).toBe(true);
      expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('stopping') });
      expect(owners).toHaveLength(1);
      await finishOwner(owners[0]);
      expect(await mocks.handlers.resumeSession('old-session', { fallback })).toMatchObject({ type: 'success' });
      expect(owners).toHaveLength(2);

      mocks.persisted = { 'old-session': { ...fallback, metadata: { ...codexMetadata, hostPid: owners[1].pid }, savedAt: Date.now() } };
      await boot();
      expect(await mocks.handlers.resumeSession('old-session')).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('ownership cannot be verified') });
      expect(owners).toHaveLength(2);
      await finishOwner(owners[1]);
      expect(await mocks.handlers.resumeSession('old-session')).toMatchObject({ type: 'success' });
      expect(owners).toHaveLength(3);
    } finally {
      await Promise.all(owners.map(finishOwner));
      for (const child of owners) expect(() => realKill(child.pid!, 0)).toThrow();
      for (const pid of backends) expect(() => realKill(pid, 0)).toThrow();
    }
  });
});