import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
const state = vi.hoisted(() => ({ control: null as any, handlers: null as any, tmux: false, spawned: [] as any[], workerArgs: [] as any[], children: [] as any[], rejectGrant: false, api: null as any, bundleMtime: 1, tmuxOptions: null as any }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statSync: (...args: any[]) => String(args[0]).endsWith('/dist/index.mjs') ? { mtimeMs: state.bundleMtime } : (fs.statSync as any)(...args) };
});
vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: { sessions: [] } })) } }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'fake', encryption: { type: 'legacy', secret: new Uint8Array(32) } }, machineId: 'machine-1' }) }));
vi.mock('@/persistence', () => ({ writeDaemonState: vi.fn(), readDaemonState: async () => null, acquireDaemonLock: async () => ({}), releaseDaemonLock: async () => {}, readPersistedSessions: () => ({}), persistSession: vi.fn() }));
vi.mock('./controlClient', () => ({ cleanupDaemonState: async () => {}, isDaemonRunningCurrentlyInstalledHappyVersion: async () => false, stopDaemon: async () => {} }));
vi.mock('./controlServer', () => ({ startDaemonControlServer: async (options: any) => { state.control = options; return { port: 45678, stop: async () => {} }; } }));
vi.mock('@/utils/caffeinate', () => ({ startCaffeinate: () => false, stopCaffeinate: async () => {} }));
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: () => ({}) }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ detectResumeSupport: () => ({}) }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() } }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => state.api } }));
vi.mock('@/utils/tmux', () => ({ isTmuxAvailable: async () => state.tmux,
  getTmuxUtilities: () => ({ spawnInTmux: async (_args: any, options: any, env: any) => { state.tmuxOptions = options; state.spawned.push(env); return { success: true, pid: 987602, sessionId: 'test:1' }; } }),
  parseTmuxSessionIdentifier: vi.fn(), formatTmuxSessionIdentifier: vi.fn(),
}));
vi.mock('@/utils/spawnHappyCLI', () => ({ resolveHappyCLIEntrypoint: () => '/fake/entry.mjs', spawnHappyCLI: (args: any, options: any) => {
  state.workerArgs.push(args);
  const child = Object.assign(new EventEmitter(), { pid: 987601, kill: vi.fn() }); state.children.push(child); state.spawned.push(options.env); return child;
} }));
import { startDaemon } from './run';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { startCodexAccountWorkerObserver } from '@/codex/codexAccountWorker';

let sourceHome: string; let daemon: Promise<void>; let savedHome: string | undefined;
let signalListeners: Map<string, Function[]>;
const originalHappyHome = configuration.happyHomeDir;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  signalListeners = new Map(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'].map(s => [s, process.listeners(s as NodeJS.Signals)]));
  state.control = null; state.handlers = null; state.spawned = []; state.workerArgs = []; state.children = []; state.rejectGrant = false; state.bundleMtime = 1; state.tmuxOptions = null;
  sourceHome = await mkdtemp(join(tmpdir(), 'daemon-codex-test-')); await writeFile(join(sourceHome, 'auth.json'), 'global-auth');
  (configuration as { happyHomeDir: string }).happyHomeDir = sourceHome;
  savedHome = process.env.CODEX_HOME; process.env.CODEX_HOME = sourceHome;
  state.api = {
    getOrCreateMachine: async () => ({ id: 'machine-1' }),
    machineSyncClient: () => ({ setRPCHandlers: (h: any) => { state.handlers = h; }, connect: vi.fn(), shutdown: vi.fn(), updateDaemonState: async () => {}, isConnected: () => false }),
    redeemCodexSessionGrant: vi.fn(async () => { if (state.rejectGrant) throw new Error('secret-canary'); return { auth: { tokens: { id_token: 'id', access_token: 'access', refresh_token: 'refresh', account_id: 'account' } }, launchId: 'launch-1', profile: { id: 'profile-1', displayName: 'Codex · ABCD', credentialVersion: 1 } }; }),
    attachCodexSession: vi.fn(async () => ({ success: true })), updateCodexAccountCredential: vi.fn(), reportCodexAccountQuota: vi.fn(), reportCodexAccountStatus: vi.fn(),
  };
  daemon = startDaemon();
  await vi.waitFor(() => expect(state.handlers).toBeTruthy());
});
afterEach(async () => {
  state.control?.requestShutdown();
  let stopped = false;
  void daemon.then(() => { stopped = true; });
  // A surviving launch adds real filesystem checkpoint work before the
  // daemon's 100ms shutdown delay. Keep advancing until that delay is scheduled.
  await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(150); expect(stopped).toBe(true); });
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const [signal, previous] of signalListeners) for (const listener of process.listeners(signal as NodeJS.Signals)) if (!previous.includes(listener)) process.removeListener(signal, listener as any);
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  (configuration as { happyHomeDir: string }).happyHomeDir = originalHappyHome;
  await rm(sourceHome, { recursive: true, force: true });
});
describe('real daemon Codex spawn paths', () => {
  it('forwards model and effort only to the spawned Codex worker', async () => {
    state.tmux = false;
    const spawning = state.handlers.spawnSession({
      directory: sourceHome,
      agent: 'codex',
      codexSessionGrant: 'g'.repeat(43),
      model: 'gpt-5.6-luna',
      effort: 'low',
    });

    await vi.waitFor(() => expect(state.workerArgs).toHaveLength(1));
    expect(state.workerArgs[0]).toEqual(expect.arrayContaining([
      'codex',
      '--model', 'gpt-5.6-luna',
      '--effort', 'low',
    ]));
    state.control.onHappySessionWebhook('model-session', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
    await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'model-session' });
  });

  it('keeps worker rotation observation and final cleanup after bundle replacement while the session stays alive', async () => {
    state.tmux = false;
    const spawning = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    state.control.onHappySessionWebhook('surviving-session', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
    await spawning;
    const launchHome = state.spawned[0].CODEX_HOME;
    state.bundleMtime = 2;
    await vi.advanceTimersByTimeAsync(61_500);
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
    // The fake process exit above cannot cancel timers; emulate the departed
    // daemon's process boundary before running the surviving worker's timer.
    vi.clearAllTimers();
    const observer = startCodexAccountWorkerObserver(state.api, launchHome);
    const auth = JSON.parse(await readFile(join(launchHome, 'auth.json'), 'utf8'));
    state.api.updateCodexAccountCredential.mockResolvedValue({ profile: { credentialVersion: 2 } });
    await writeFile(join(launchHome, 'auth.json'), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: 'post-replacement-refresh' } }));
    vi.mocked(process.kill).mockImplementation((pid) => {
      if (pid === process.pid) throw Object.assign(new Error('original daemon exited'), { code: 'ESRCH' });
      return true;
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(state.api.updateCodexAccountCredential).toHaveBeenCalledOnce());
      expect(state.api.updateCodexAccountCredential.mock.calls[0][1]).toMatchObject({ launchId: 'launch-1', expectedVersion: 1, auth: { tokens: { refresh_token: 'post-replacement-refresh' } } });
      expect((await stat(launchHome)).isDirectory()).toBe(true);
      state.api.updateCodexAccountCredential.mockResolvedValue({ profile: { credentialVersion: 3 } });
      await writeFile(join(launchHome, 'auth.json'), JSON.stringify({ ...auth, tokens: { ...auth.tokens, refresh_token: 'exit-refresh' } }));
      await observer.finish();
      expect(state.api.updateCodexAccountCredential.mock.calls[1][1]).toMatchObject({ launchId: 'launch-1', expectedVersion: 2, auth: { tokens: { refresh_token: 'exit-refresh' } } });
      await expect(stat(launchHome)).rejects.toThrow();
      expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('global-auth');
    } finally { await observer.finish(); }
  });
  it.each(['shutdown', 'bundle replacement'])('drains exited-child finalizers before %s, even beyond the startup fallback timeout', async mode => {
    state.tmux = false;
    const spawning = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    state.control.onHappySessionWebhook('actual-session', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
    await spawning;
    const launchHome = state.spawned[0].CODEX_HOME;
    const auth = JSON.parse(await readFile(join(launchHome, 'auth.json'), 'utf8'));
    await writeFile(join(launchHome, 'auth.json'), JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }));
    let resolveUpdate!: () => void;
    state.api.updateCodexAccountCredential.mockImplementation(() => new Promise(resolve => {
      resolveUpdate = () => resolve({ profile: { credentialVersion: 2 } });
    }));
    state.children[0].emit('exit', 0);
    await vi.waitFor(() => expect(state.api.updateCodexAccountCredential).toHaveBeenCalledOnce());
    try {
      if (mode === 'shutdown') state.control.requestShutdown();
      else state.bundleMtime = 2;
      await vi.advanceTimersByTimeAsync(mode === 'shutdown' ? 1500 : 61_500);
      expect(process.exit).not.toHaveBeenCalled();
      expect((await stat(launchHome)).isDirectory()).toBe(true);
    } finally { resolveUpdate(); }
    await vi.waitFor(async () => { await expect(stat(launchHome)).rejects.toThrow(); });
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  });
  it('rejects resuming an audited session under a different account before spawning', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const firstHome = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(firstHome, 'sessions')); await writeFile(join(firstHome, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');
    await writeFile(join(firstHome, 'sessions', 'rollout-unrelated.jsonl'), 'unrelated');
    state.children[0].emit('exit', 0);
    await vi.waitFor(async () => { await expect(stat(firstHome)).rejects.toThrow(); });
    state.api.redeemCodexSessionGrant.mockResolvedValue({ auth: { tokens: { id_token: 'b-id', access_token: 'b-access', refresh_token: 'b-refresh', account_id: 'b-account' } }, launchId: 'launch-b', profile: { id: 'profile-b', displayName: 'Codex · BBBB', credentialVersion: 2 } });
    const resumed = await state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43) });
    expect(resumed).toEqual({ type: 'error', errorMessage: expect.stringContaining('different account') });
    expect(state.spawned).toHaveLength(1);
    expect(state.api.attachCodexSession).not.toHaveBeenCalledWith('launch-b', expect.anything());
  });
  it('keeps the live worker running when resume authorization cannot be prepared', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption);
    await first;

    state.rejectGrant = true;
    const resumed = await state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43) });

    expect(resumed).toEqual({ type: 'error', errorMessage: expect.stringContaining('account launch failed') });
    expect(state.children[0].kill).not.toHaveBeenCalled();
    expect(state.spawned).toHaveLength(1);
  });
  it('deduplicates concurrent resume requests for the same live session', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const firstHome = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption);
    await first;
    await mkdir(join(firstHome, 'sessions'));
    await writeFile(join(firstHome, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');

    const firstResume = state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43) });
    const secondResume = state.handlers.resumeSession('paws-session', { codexSessionGrant: 'c'.repeat(43) });
    await vi.waitFor(() => expect(state.children[0].kill).toHaveBeenCalledTimes(1));
    expect(state.api.redeemCodexSessionGrant).toHaveBeenCalledTimes(2);

    state.children[0].emit('exit', 0);
    await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
    state.control.onHappySessionWebhook('paws-session', metadata, encryption);
    await expect(Promise.all([firstResume, secondResume])).resolves.toEqual([
      { type: 'success', sessionId: 'paws-session' },
      { type: 'success', sessionId: 'paws-session' },
    ]);
  });
  it('does not spawn a replacement when the live worker misses the stop deadline', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const firstHome = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(firstHome, 'sessions')); await writeFile(join(firstHome, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');

    const resumed = state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43) });
    await vi.waitFor(() => expect(state.children[0].kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resumed).resolves.toEqual({ type: 'error', errorMessage: expect.stringContaining('did not stop cleanly') });
    expect(state.spawned).toHaveLength(1);
  });
  it('refuses to replace a live tmux session that the daemon cannot stop safely', async () => {
    state.tmux = true;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43), environmentVariables: { TMUX_SESSION_NAME: 'test' } });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const firstHome = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987602, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(firstHome, 'sessions')); await writeFile(join(firstHome, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');

    const resumed = await state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43) });

    expect(resumed).toEqual({ type: 'error', errorMessage: expect.stringContaining('cannot be safely restarted remotely') });
    expect(state.spawned).toHaveLength(1);
  });
  it.each([false, true])('redeems and attaches the actual direct/tmux spawn (tmux=%s)', async tmux => {
    state.tmux = tmux;
    const result = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43), environmentVariables: { TMUX_SESSION_NAME: 'test', CODEX_HOME: sourceHome, OPENAI_API_KEY: 'caller-secret' } });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const env = state.spawned[0]; expect(env.CODEX_HOME).not.toBe(sourceHome); expect(env.OPENAI_API_KEY).toBeUndefined();
    if (tmux) expect(state.tmuxOptions.unsetEnvironmentVariables).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY', 'HAPPY_CODEX_APP_SERVER_SOCKET']));
    const pid = tmux ? 987602 : 987601;
    state.control.onHappySessionWebhook('actual-session', { hostPid: pid, flavor: 'codex', startedBy: 'daemon' });
    expect(await result).toEqual({ type: 'success', sessionId: 'actual-session' });
    expect(state.api.attachCodexSession).toHaveBeenCalledWith('launch-1', { machineId: 'machine-1', sourceSessionId: 'actual-session' });
    if (tmux) {
      vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
      await vi.advanceTimersByTimeAsync(60_000);
    } else state.children[0].emit('exit', 0);
    await vi.waitFor(async () => { await expect(stat(env.CODEX_HOME)).rejects.toThrow(); });
    expect(await readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe('global-auth');
  });
  it.each([false, true])('never spawns on a rejected grant (tmux=%s)', async tmux => {
    state.tmux = tmux; state.rejectGrant = true;
    const result = await state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43), environmentVariables: { TMUX_SESSION_NAME: 'test' } });
    expect(result.type).toBe('error'); expect(state.spawned).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('secret-canary');
  });
});
