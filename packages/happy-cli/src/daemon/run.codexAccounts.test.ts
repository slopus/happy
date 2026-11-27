import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
const state = vi.hoisted(() => ({ control: null as any, handlers: null as any, tmux: false, spawned: [] as any[], workerArgs: [] as any[], children: [] as any[], rejectGrant: false, api: null as any, bundleMtime: 1, tmuxOptions: null as any, persisted: {} as Record<string, any> }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statSync: (...args: any[]) => String(args[0]).endsWith('/dist/index.mjs') ? { mtimeMs: state.bundleMtime } : (fs.statSync as any)(...args) };
});
vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: { sessions: [] } })) } }));
vi.mock('@/continuation/nativeHistory', () => ({ exportNativeConversation: async () => [{ kind: 'user', text: 'task' }], importClaudeConversation: async () => '00000000-0000-4000-8000-000000000010', importCodexConversation: async () => '00000000-0000-4000-8000-000000000011' }));
vi.mock('@/continuation/recoverToolResult', () => ({ readNativeToolResult: vi.fn(async () => ({ outputText: 'original stdout', isError: false, nextTextOffset: null })) }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'fake', encryption: { type: 'legacy', secret: new Uint8Array(32) } }, machineId: 'machine-1' }) }));
vi.mock('@/persistence', () => ({ writeDaemonState: vi.fn(), readDaemonState: async () => null, acquireDaemonLock: async () => ({}), releaseDaemonLock: async () => {}, readPersistedSessions: () => state.persisted, persistSession: vi.fn((id, saved) => { state.persisted[id] = saved; }) }));
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
vi.mock('./stopDetachedCodexWorker', () => ({ stopDetachedCodexWorker: vi.fn(async () => {}) }));
vi.mock('./nativeProcessGroup', () => ({ verifyNativeProcessGroup: vi.fn(async () => true), awaitNativeProcessGroupExit: vi.fn(async () => {}) }));
import { stopDetachedCodexWorker } from './stopDetachedCodexWorker';
import { startDaemon } from './run';
import axios from 'axios';
import { encrypt, encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { retainCodexAccountHistory, rememberCodexAccountSession } from '@/codex/codexAccountHistory';
import { startCodexAccountWorkerObserver } from '@/codex/codexAccountWorker';
import { readNativeToolResult } from '@/continuation/recoverToolResult';
import { PortableContextStore, PORTABLE_CONTEXT_DIRECTORY_NAME } from '@/continuation/portableContextStore';

let sourceHome: string; let daemon: Promise<void>; let savedHome: string | undefined;
let signalListeners: Map<string, Function[]>;
const originalHappyHome = configuration.happyHomeDir;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  signalListeners = new Map(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit'].map(s => [s, process.listeners(s as NodeJS.Signals)]));
  state.persisted = {};
  state.control = null; state.handlers = null; state.spawned = []; state.workerArgs = []; state.children = []; state.rejectGrant = false; state.bundleMtime = 1; state.tmuxOptions = null;
  sourceHome = await mkdtemp(join(tmpdir(), 'daemon-codex-test-')); await writeFile(join(sourceHome, 'auth.json'), 'global-auth');
  (configuration as { happyHomeDir: string }).happyHomeDir = sourceHome;
  savedHome = process.env.CODEX_HOME; process.env.CODEX_HOME = sourceHome;
  state.api = {
    getOrCreateMachine: async () => ({ id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }),
    machineSyncClient: () => ({ setScheduledTaskRunner: vi.fn(), setNativeSessionHooks: vi.fn(), setRPCHandlers: (h: any) => { state.handlers = h; }, connect: vi.fn(), shutdown: vi.fn(), updateDaemonState: async () => {}, isConnected: () => false }),
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
  it.each([false, true])('starts a cross-account fork with the selected credentials (tmux=%s)', async tmux => {
    state.tmux = tmux;
    const root = join(sourceHome, 'codex-session-cache');
    const native = join(sourceHome, 'native');
    await mkdir(join(native, 'sessions'), { recursive: true });
    const history = JSON.stringify({ type: 'session_meta', payload: { id: 'new-fork', forked_from_id: 'original-thread' } }) + '\n';
    await writeFile(join(native, 'sessions', 'rollout-new-fork.jsonl'), history);
    await retainCodexAccountHistory(root, 'old-profile', native);
    await rememberCodexAccountSession(root, 'parent-session', 'old-profile');
    const spawning = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43),
      parentSessionId: 'parent-session', resumeCodexThreadId: 'new-fork', environmentVariables: { TMUX_SESSION_NAME: 'test' } });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const env = state.spawned[0];
    expect(env.HAPPY_CODEX_ACCOUNT_PROFILE_ID).toBe('profile-1');
    expect(await readFile(join(env.CODEX_HOME, 'sessions', 'rollout-new-fork.jsonl'), 'utf8')).toBe(history);
    expect(JSON.parse(await readFile(join(env.CODEX_HOME, 'auth.json'), 'utf8')).tokens.account_id).toBe('account');
    state.control.onHappySessionWebhook('child-session', { hostPid: tmux ? 987602 : 987601, flavor: 'codex', startedBy: 'daemon' });
    await expect(spawning).resolves.toMatchObject({ type: 'success', sessionId: 'child-session' });
  });

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

  it('rejects the pending launch when the worker exits before the startup webhook', async () => {
    const spawning = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex' });
    await vi.waitFor(() => expect(state.children).toHaveLength(1));
    state.children[0].emit('exit', 1, null);
    await expect(spawning).resolves.toEqual({ type: 'error', errorMessage: 'Session process exited before startup completed' });
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
  it('restarts an inactive never-used thread in the same Paws session without requiring a rollout', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const firstHome = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'empty-thread', codexAccountProfileId: 'profile-1' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('empty-session', metadata, encryption); await first;
    state.children[0].emit('exit', 0);
    await vi.waitFor(async () => { await expect(stat(firstHome)).rejects.toThrow(); });
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    vi.mocked(axios.get).mockImplementation(async (url: any) => ({ data: String(url).endsWith('/messages')
      ? { messages: [{ seq: 1, content: { t: 'encrypted', c: encrypted({ role: 'agent', content: { type: 'event', data: { type: 'ready' } } }) } }] }
      : { sessions: [{ id: 'empty-session', active: false, seq: 1, metadataVersion: 2, metadata: encrypted(metadata) }] } }));
    const resumed = state.handlers.resumeSession('empty-session', { codexSessionGrant: 'b'.repeat(43) });
    try {
      await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
      expect(state.workerArgs[1]).not.toContain('--resume');
      expect(state.spawned[1].HAPPY_RECONNECT_SESSION_ID).toBe('empty-session');
      expect(JSON.parse(state.spawned[1].HAPPY_RECONNECT_METADATA_JSON).codexThreadId).toBeUndefined();
      state.control.onHappySessionWebhook('empty-session', { ...metadata, codexThreadId: undefined }, encryption);
      await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'empty-session' });
    } finally {
      vi.mocked(axios.get).mockImplementation(async () => ({ data: { sessions: [] } }));
    }
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
  it('does not restart a worker when another device has already recovered the failed turn', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ id: 'paws-session', active: true, metadata: encrypted(metadata), seq: 4, metadataVersion: 2,
      agentState: encrypted({ turnStatus: { status: 'running', updatedAt: 2, turnId: 'new-turn' } }) }] } });
    await expect(state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43), expectedFailedTurn: { turnId: 'failed-turn', updatedAt: 1 } }))
      .resolves.toEqual({ type: 'success', sessionId: 'paws-session' });
    expect(state.children[0].kill).not.toHaveBeenCalled();
    expect(state.spawned).toHaveLength(1);
    expect(state.api.redeemCodexSessionGrant).toHaveBeenCalledTimes(1);
    expect(stopDetachedCodexWorker).not.toHaveBeenCalled();
  });
  it.each([true, false])('keeps a legacy worker when an idle-upgrade races a newly started turn (presence active=%s)', async active => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const home = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(home, 'sessions')); await writeFile(join(home, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    const snapshot = (status: string) => ({ data: { sessions: [{ id: 'paws-session', active, metadata: encrypted(metadata), seq: 4, metadataVersion: 2,
      agentState: encrypted({ turnStatus: { status, updatedAt: 1, turnId: 'turn' } }) }] } });
    vi.mocked(axios.get).mockResolvedValueOnce(snapshot('completed')).mockResolvedValue(snapshot('running'));
    const result = await state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43), expectedWorkerPid: 987601 });
    expect(result).toEqual({ type: 'success', sessionId: 'paws-session' });
    expect(state.children[0].kill).not.toHaveBeenCalled();
    expect(state.spawned).toHaveLength(1);
    expect(state.api.attachCodexSession).not.toHaveBeenCalledWith('launch-2', expect.anything());
  });
  it('restores an offline modern completed worker with its original thread', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const home = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome,
      codexThreadId: 'thread-source', capabilities: { codexCredentialRecovery: true } };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(home, 'sessions')); await writeFile(join(home, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');
    state.children[0].emit('exit', 0);
    await vi.waitFor(async () => { await expect(stat(home)).rejects.toThrow(); });
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ id: 'paws-session', active: false, metadata: encrypted(metadata), seq: 200, metadataVersion: 2,
      agentState: encrypted({ turnStatus: { status: 'completed', updatedAt: 1, turnId: 'old-turn' } }) }] } });
    const resumed = state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43), expectedWorkerPid: 987601 });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
    expect(state.workerArgs[1]).toContain('thread-source');
    expect(state.spawned[1].HAPPY_RECONNECT_SESSION_ID).toBe('paws-session');
    state.control.onHappySessionWebhook('paws-session', metadata, encryption);
    await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'paws-session' });
  });

  it.each([true, false])('does not replace a modern worker that reconnects during recovery (initially active=%s)', async active => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const home = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome,
      codexThreadId: 'thread-source', capabilities: { codexCredentialRecovery: true } };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(home, 'sessions')); await writeFile(join(home, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    const snapshot = (active: boolean) => ({ data: { sessions: [{ id: 'paws-session', active, metadata: encrypted(metadata), seq: 200, metadataVersion: 2,
      agentState: encrypted({ turnStatus: { status: 'completed', updatedAt: 1, turnId: 'old-turn' } }) }] } });
    vi.mocked(axios.get).mockResolvedValueOnce(snapshot(active)).mockResolvedValue(snapshot(true));
    await expect(state.handlers.resumeSession('paws-session', { codexSessionGrant: 'b'.repeat(43), expectedWorkerPid: 987601 }))
      .resolves.toEqual({ type: 'success', sessionId: 'paws-session' });
    expect(state.children[0].kill).not.toHaveBeenCalled();
    expect(state.spawned).toHaveLength(1);
  });
  it('deduplicates the same failed-turn recovery after the first replacement has finished starting', async () => {
    state.tmux = false;
    const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    const home = state.spawned[0].CODEX_HOME;
    const metadata = { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', path: sourceHome, codexThreadId: 'thread-source' };
    const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
    state.control.onHappySessionWebhook('paws-session', metadata, encryption); await first;
    await mkdir(join(home, 'sessions')); await writeFile(join(home, 'sessions', 'rollout-thread-source.jsonl'), 'source-native-thread');
    const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
    vi.mocked(axios.get).mockResolvedValue({ data: { sessions: [{ id: 'paws-session', active: true, metadata: encrypted(metadata), seq: 4, metadataVersion: 2,
      agentState: encrypted({ turnStatus: { status: 'failed', updatedAt: 1, turnId: 'failed-turn' } }) }] } });
    const options = { codexSessionGrant: 'b'.repeat(43), expectedFailedTurn: { turnId: 'failed-turn', updatedAt: 1 } };
    const resume = state.handlers.resumeSession('paws-session', options);
    await vi.waitFor(() => expect(state.children[0].kill).toHaveBeenCalledOnce());
    state.children[0].emit('exit', 0);
    await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
    state.control.onHappySessionWebhook('paws-session', metadata, encryption);
    await expect(resume).resolves.toEqual({ type: 'success', sessionId: 'paws-session' });
    await expect(state.handlers.resumeSession('paws-session', options)).resolves.toEqual({ type: 'success', sessionId: 'paws-session' });
    expect(state.spawned).toHaveLength(2);
    expect(state.children[1].kill).not.toHaveBeenCalled();
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
  it('retries a finished ordinary session on the daemon heartbeat after an upload outage', async () => {
    state.tmux = false;
    const spawning = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43) });
    await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
    state.control.onHappySessionWebhook('recovery-session', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
    await spawning;
    const home = state.spawned[0].CODEX_HOME;
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
    const rotated = { ...auth, tokens: { ...auth.tokens, refresh_token: 'pending-exit-refresh' } };
    await writeFile(join(home, 'auth.json'), JSON.stringify(rotated));
    state.api.updateCodexAccountCredential.mockRejectedValue(new Error('upload unavailable'));
    state.children[0].emit('exit', 0);
    await vi.waitFor(async () => expect((await stat(join(home, '.paws-session-finished'))).isFile()).toBe(true));
    expect(JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'))).toEqual(rotated);
    state.api.updateCodexAccountCredential.mockResolvedValue({ profile: { credentialVersion: 2 } });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => { await expect(stat(home)).rejects.toThrow(); });
    expect(state.api.updateCodexAccountCredential).toHaveBeenLastCalledWith('profile-1', expect.objectContaining({ launchId: 'launch-1', expectedVersion: 1, auth: rotated }));
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


it('never marks a dispatched regular continuation as safe to repeat after webhook timeout', async () => {
 state.tmux = false;
 const result = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', crossAgentHistory: [{ kind: 'user', text: 'task' }], parentSessionId: 'source' });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 await vi.advanceTimersByTimeAsync(90_001);
 expect(await result).toMatchObject({ type: 'error' });
 expect((await result).notDispatched).not.toBe(true);
});

it('marks a rejected account launch as safe to retry before any worker is dispatched', async () => {
 state.rejectGrant = true;
 const result = await state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43), crossAgentHistory: [{ kind: 'user', text: 'task' }], parentSessionId: 'source' });
 expect(result).toMatchObject({ type: 'error', notDispatched: true }); expect(state.spawned).toHaveLength(0);
});

it('reads an exact source snapshot and preserves source identity when launching the opposite agent', async () => {
 const metadata = { machineId: 'machine-1', hostPid: 987603, flavor: 'claude', startedBy: 'terminal', path: sourceHome, claudeSessionId: '00000000-0000-4000-8000-000000000001' };
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 state.control.onHappySessionWebhook('old-source', metadata, encryption);
 const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
 vi.mocked(axios.get).mockResolvedValue({ data: { session: { id: 'old-source', metadata: encrypted(metadata), active: false, seq: 7, metadataVersion: 1, agentState: encrypted({ turnStatus: { status: 'completed' } }) } } });
 const request = { sourceSessionId: 'old-source', targetAgent: 'codex', requestId: '00000000-0000-4000-8000-000000000003' };
 const launching = state.handlers.continueWithAgent(request);
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 expect(vi.mocked(axios.get).mock.calls.at(-1)?.[0]).toContain('/v2/sessions/old-source');
 expect(state.spawned[0]).toMatchObject({ HAPPY_FORKED_FROM_SESSION_ID: 'old-source', HAPPY_CROSS_AGENT_SOURCE_AGENT: 'claude', HAPPY_CROSS_AGENT_REQUEST_ID: request.requestId });
 state.control.onHappySessionWebhook('converted', { machineId: 'machine-1', hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
 expect(await launching).toEqual({ type: 'success', sessionId: 'converted' });
});

it('recovers a target whose worker exited after its startup response was lost', async () => {
 const source = 'recovery-source'; const requestId = '00000000-0000-4000-8000-000000000071';
 const receipt = join(sourceHome, 'cross-agent-continuations', 'machine-1', `${requestId}.json`);
 await mkdir(join(sourceHome, 'cross-agent-continuations', 'machine-1'), { recursive: true });
 await writeFile(receipt, JSON.stringify({ sourceSessionId: source, targetAgent: 'codex', phase: 'starting' }));
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 const launching = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex' });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 state.control.onHappySessionWebhook('already-created', { hostPid: 987601, flavor: 'codex', parentSessionId: source, crossAgentRequestId: requestId, startedBy: 'daemon' }, encryption);
 await launching;
 state.children[0].emit('exit', 0);
 expect(await state.handlers.continueWithAgent({ sourceSessionId: source, targetAgent: 'codex', requestId })).toEqual({ type: 'success', sessionId: 'already-created' });
 expect(state.spawned).toHaveLength(1);
});

it.each([[true, true], [undefined, true], [true, false]])('rejects a Claude source with thinking=%s and active=%s before any output', async (thinking, active) => {
 const metadata = { machineId: 'machine-1', hostPid: 987603, flavor: 'claude', startedBy: 'terminal', path: sourceHome, claudeSessionId: '00000000-0000-4000-8000-000000000001' };
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 state.control.onHappySessionWebhook('busy-source', metadata, encryption);
 const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
 vi.mocked(axios.get).mockResolvedValue({ data: { session: { id: 'busy-source', metadata: encrypted(metadata), active, seq: 7, metadataVersion: 1,
  agentState: encrypted(thinking === undefined ? {} : { claudeThinking: thinking }) } } });
 await expect(state.handlers.continueWithAgent({ sourceSessionId: 'busy-source', targetAgent: 'codex', requestId: '00000000-0000-4000-8000-000000000072' })).rejects.toThrow(/finish running/);
 expect(state.spawned).toHaveLength(0);
});


it('recovers an unknown startup target from persisted metadata after daemon restart', async () => {
 const source = 'restarted-source'; const requestId = '00000000-0000-4000-8000-000000000073';
 const folder = join(sourceHome, 'cross-agent-continuations', 'machine-1'); await mkdir(folder, { recursive: true });
 await writeFile(join(folder, `${requestId}.json`), JSON.stringify({ sourceSessionId: source, targetAgent: 'codex', phase: 'starting' }));
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 const launching = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex' });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 state.control.onHappySessionWebhook('persisted-target', { hostPid: 987601, flavor: 'codex', parentSessionId: source, crossAgentRequestId: requestId, startedBy: 'daemon' }, encryption);
 await launching;
 state.control.requestShutdown();
 let stopped = false; void daemon.then(() => { stopped = true; });
 await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(150); expect(stopped).toBe(true); });
 state.handlers = null; daemon = startDaemon();
 await vi.waitFor(() => expect(state.handlers).toBeTruthy());
 expect(await state.handlers.continueWithAgent({ sourceSessionId: source, targetAgent: 'codex', requestId })).toEqual({ type: 'success', sessionId: 'persisted-target' });
 expect(state.spawned).toHaveLength(1);
});


it('allows a stopped Claude worker with a stale thinking flag to be continued', async () => {
 const metadata = { machineId: 'machine-1', hostPid: 987603, flavor: 'claude', startedBy: 'terminal', path: sourceHome, claudeSessionId: '00000000-0000-4000-8000-000000000001' };
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 state.control.onHappySessionWebhook('crashed-source', metadata, encryption);
 vi.mocked(process.kill).mockImplementation((pid: number) => { if (pid === 987603) throw Object.assign(new Error('worker exited'), { code: 'ESRCH' }); return true; });
 const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
 vi.mocked(axios.get).mockResolvedValue({ data: { session: { id: 'crashed-source', metadata: encrypted(metadata), active: false, seq: 7, metadataVersion: 1,
  agentState: encrypted({ claudeThinking: true, turnStatus: { status: 'running' } }) } } });
 const launching = state.handlers.continueWithAgent({ sourceSessionId: 'crashed-source', targetAgent: 'codex', requestId: '00000000-0000-4000-8000-000000000074' });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 state.control.onHappySessionWebhook('crash-continuation', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon' });
 expect(await launching).toEqual({ type: 'success', sessionId: 'crash-continuation' });
});

async function nativeConversationFixture() {
 const nativeId = '00000000-0000-4000-8000-000000000081';
 const requestId = '00000000-0000-4000-8000-000000000082';
 const encryption = { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const, seq: 0, metadataVersion: 1, agentStateVersion: 1 };
 const first = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'a'.repeat(43) });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 const oldHome = state.spawned[0].CODEX_HOME;
 const rootMetadata = { machineId: 'machine-1', path: sourceHome, hostPid: 987601, flavor: 'codex', startedBy: 'daemon',
  codexThreadId: nativeId, codexAccountProfileId: 'profile-1', capabilities: { conversationNativeResume: 1 },
  conversationActiveSessionId: 'current-claude', conversationSwitch: { id: requestId, sourceSessionId: 'current-claude' } };
 state.control.onHappySessionWebhook('conversation-root', rootMetadata, encryption); await first;
 await mkdir(join(oldHome, 'sessions'), { recursive: true });
 const history = JSON.stringify({ type: 'session_meta', payload: { id: nativeId } }) + '\n';
 await writeFile(join(oldHome, 'sessions', `rollout-${nativeId}.jsonl`), history);
 const sourceMetadata = { machineId: 'machine-1', path: sourceHome, hostPid: 987603, flavor: 'claude', startedBy: 'daemon',
  continuationOfSessionId: 'conversation-root', conversationRootSessionId: 'conversation-root' };
 state.control.onHappySessionWebhook('current-claude', sourceMetadata, encryption);
 const encrypted = (value: unknown) => encodeBase64(encrypt(encryption.encryptionKey, 'legacy', value));
 const rows = [
  { id: 'conversation-root', active: true, seq: 12, metadataVersion: 2, metadata: encrypted(rootMetadata),
   agentState: encrypted({ turnStatus: { status: 'completed' }, claudeThinking: false }) },
  { id: 'current-claude', active: true, seq: 24, metadataVersion: 2, metadata: encrypted(sourceMetadata),
   agentState: encrypted({ turnStatus: { status: 'completed' }, claudeThinking: false }) },
 ];
 const nativeRows = [
  { seq: 1, localId: 'original-input', content: { role: 'user', content: { type: 'text', text: 'Fix parser' } } },
  { seq: 2, content: { role: 'session', content: { role: 'agent', turn: 'native-turn', ev: { t: 'turn-start', localIds: ['original-input'] } } } },
  ...Array.from({ length: 9 }, (_, i) => ({ seq: i + 3, content: { role: 'session', content: { role: 'agent', turn: 'native-turn', ev: { t: 'text', text: 'native result' } } } })),
  { seq: 12, content: { role: 'session', content: { role: 'agent', turn: 'native-turn', ev: { t: 'turn-end', status: 'completed' } } } },
 ];
 const messageRows: Record<string, any[]> = { 'conversation-root': nativeRows.map(row => ({ seq: row.seq, localId: 'localId' in row ? row.localId : undefined,
  content: { t: 'encrypted', c: encrypted(row.content) } })) };
 vi.mocked(axios.get).mockImplementation(async (url: any) => ({ data: String(url).includes('/messages')
  ? { messages: messageRows[decodeURIComponent(String(url).match(/\/sessions\/([^/]+)\/messages/)?.[1] ?? '')] ?? [], hasMore: false }
  : String(url).includes('/v2/sessions/') ? { session: rows.find(row => String(url).endsWith('/' + row.id)) } : { sessions: rows } }));
 Object.assign(state.children[0], { exitCode: null, signalCode: null });
 return { nativeId, requestId, oldHome, encryption, history, rootMetadata, rows, encrypted, messageRows,
  request: { rootSessionId: 'conversation-root', sourceSessionId: 'current-claude', requestId,
   targetAgent: 'codex', expectedCodexAccountProfileId: 'profile-1', codexSessionGrant: 'b'.repeat(43) } };
}

it('waits for the old native wrapper and final history checkpoint before restoring a fresh App segment', async () => {
 const f = await nativeConversationFixture();
 const oldChild = state.children[0];
 oldChild.kill.mockImplementation(() => { oldChild.exitCode = 0; oldChild.signalCode = 'SIGTERM'; oldChild.emit('exit', 0); return true; });
 const launching = state.handlers.spawnConversationSession(f.request);
 await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
 expect(oldChild.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
 expect(state.workerArgs[1]).toEqual(expect.arrayContaining(['--resume', f.nativeId]));
 expect(state.spawned[1].HAPPY_RECONNECT_SESSION_ID).toBeUndefined();
 expect(state.spawned[1].HAPPY_FORK_CODEX_THREAD_ID).toBeUndefined();
 expect(state.spawned[1].HAPPY_CONVERSATION_NATIVE_RESUME).toBe('1');
 expect(await readFile(join(state.spawned[1].CODEX_HOME, 'sessions', `rollout-${f.nativeId}.jsonl`), 'utf8')).toBe(f.history);
 await expect(stat(f.oldHome)).rejects.toThrow();
 state.control.onHappySessionWebhook('new-native-segment', { machineId: 'machine-1', path: sourceHome, hostPid: 987601, flavor: 'codex',
  startedBy: 'daemon', parentSessionId: 'current-claude', crossAgentRequestId: f.requestId }, f.encryption);
 expect(await launching).toMatchObject({ type: 'success', sessionId: 'new-native-segment', nativeResume: {
  sourceSessionId: 'conversation-root', coverage: [{ sessionId: 'conversation-root', throughSeq: 12, afterSeq: 0 }], contextEpoch: null,
  contextSources: [{ sessionId: 'current-claude', identity: expect.any(String) }, { sessionId: 'conversation-root', identity: expect.any(String) }] } });
 expect(await state.handlers.spawnConversationSession(f.request)).toMatchObject({ sessionId: 'new-native-segment' });
 expect(state.spawned).toHaveLength(2);
});

it('keeps the native writer alive when the newly selected account grant fails', async () => {
 const f = await nativeConversationFixture();
 state.rejectGrant = true;
 expect(await state.handlers.spawnConversationSession(f.request)).toMatchObject({ type: 'error', notDispatched: true });
 expect(state.children[0].kill).not.toHaveBeenCalled();
 expect(state.spawned).toHaveLength(1);
 expect((await stat(f.oldHome)).isDirectory()).toBe(true);
});

it('recovers a legacy tool body only from fresh decrypted native/source bindings', async () => {
 const f = await nativeConversationFixture();
 Object.assign(f.rootMetadata, { lifecycleState: 'archived' }); f.rows[0].metadata = f.encrypted(f.rootMetadata);
 const result = await state.handlers.readConversationToolResult({ sourceSessionId: 'conversation-root', toolCallId: 'tool-123', textOffset: 50 });
 expect(result).toEqual({ success: true, outputText: 'original stdout', isError: false, nextTextOffset: null });
 expect(readNativeToolResult).toHaveBeenLastCalledWith({ id: 'conversation-root', agent: 'codex', nativeId: f.nativeId,
  directory: sourceHome, accountProfileId: 'profile-1', revision: 12, boundaryId: undefined, connectionKey: undefined }, 'tool-123', 50);
 expect(await state.handlers.readConversationToolResult({ sourceSessionId: 'not-owned', toolCallId: 'tool-123' })).toMatchObject({ success: false });
 expect(state.spawned).toHaveLength(1);
});

it.each([false, true, 'partial-history'])('cancels only an unsent, fully stopped candidate (alreadyDelivered=%s)', async alreadyDelivered => {
 const f = await nativeConversationFixture();
 const old = state.children[0]; old.kill.mockImplementation(() => { old.exitCode = 0; old.signalCode = null; old.emit('exit', 0); return true; });
 const launching = state.handlers.spawnConversationSession(f.request);
 await vi.waitFor(() => expect(state.spawned).toHaveLength(2));
 const metadata = { machineId: 'machine-1', path: sourceHome, hostPid: 987601, flavor: 'codex', startedBy: 'daemon',
  parentSessionId: 'current-claude', crossAgentRequestId: f.requestId };
 state.control.onHappySessionWebhook('cancel-target', metadata, f.encryption); await launching;
 f.rows.push({ id: 'cancel-target', active: true, seq: alreadyDelivered === 'partial-history' ? 2 : alreadyDelivered ? 1 : 0, metadataVersion: 1, metadata: f.encrypted(metadata),
  agentState: f.encrypted({ turnStatus: { status: 'completed' }, claudeThinking: false }) });
 if (alreadyDelivered === 'partial-history') f.messageRows['cancel-target'] = [{ seq: 2, content: { t: 'encrypted', c: f.encrypted({ role: 'agent', content: { type: 'event', data: {} } }) } }];
 else if (alreadyDelivered) f.messageRows['cancel-target'] = [{ seq: 1, localId: 'current-input', content: { t: 'encrypted', c: f.encrypted({ role: 'user', content: { type: 'text', text: 'current prompt' } }) } }];
 const child = state.children[1]; child.kill.mockImplementation(() => { child.exitCode = 0; child.signalCode = null; child.emit('exit', 0); return true; });
 const result = await state.handlers.cancelConversationLaunch(f.request);
 expect(result.success).toBe(!alreadyDelivered);
 if (alreadyDelivered) expect(child.kill).not.toHaveBeenCalled();
 else {
  expect(result).toEqual({ success: true, cancelled: true, targetSessionId: 'cancel-target' });
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(await state.handlers.spawnConversationSession(f.request)).toMatchObject({ type: 'error', conversationCancelled: true });
 }
 expect(state.spawned).toHaveLength(2);
});

it.each([
 ['antigravity', true, 'missing-ready', true], ['codex', true, 'full-ready', true], ['antigravity', false, 'missing-ready', true],
 ['antigravity', true, 'parent-conflict', false], ['antigravity', true, 'request-conflict', false],
 ['antigravity', true, 'agent-conflict', false], ['antigravity', true, 'missing-starting', false], ['antigravity', true, 'missing-receipt', false],
] as const)('proves persisted %s cancellation after daemon restart (live=%s, lineage=%s)', async (agent, alive, scenario, success) => {
 const f = await nativeConversationFixture();
 const targetId = 'persisted-cancel-target'; const targetPid = 987605;
 const metadata: Record<string, unknown> = { machineId: 'machine-1', path: sourceHome, hostPid: targetPid, flavor: agent, startedBy: 'daemon' };
 if (scenario === 'full-ready') Object.assign(metadata, { parentSessionId: 'current-claude', crossAgentRequestId: f.requestId });
 if (scenario === 'parent-conflict') metadata.parentSessionId = 'other-source';
 if (scenario === 'request-conflict') metadata.crossAgentRequestId = 'other-request';
 state.control.onHappySessionWebhook(targetId, metadata, f.encryption);
 Object.assign(f.rootMetadata.conversationSwitch, { targetSessionId: targetId });
 f.rows[0].metadata = f.encrypted(f.rootMetadata);
 f.rows.push({ id: targetId, active: true, seq: 1, metadataVersion: 1, metadata: f.encrypted(metadata),
  agentState: f.encrypted({ turnStatus: { status: 'completed' }, claudeThinking: false }) });
 f.messageRows[targetId] = [{ seq: 1, localId: 'session-envelope:ready',
  content: { t: 'encrypted', c: f.encrypted({ role: 'agent', content: { type: 'event', data: { type: 'ready' } } }) } }];
 const receiptDir = join(sourceHome, 'conversation-session-launches', 'machine-1'); await mkdir(receiptDir, { recursive: true });
 if (scenario !== 'missing-receipt') await writeFile(join(receiptDir, `${f.requestId}.json`), JSON.stringify({
  phase: scenario === 'missing-starting' ? 'starting' : 'ready',
  identity: JSON.stringify(['conversation-root', 'current-claude', scenario === 'agent-conflict' ? 'codex' : agent, null, null]),
  ...(scenario === 'missing-starting' ? {} : { result: { type: 'success', sessionId: targetId } }) }));
 state.control.requestShutdown();
 let stopped = false; void daemon.then(() => { stopped = true; });
 await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(150); expect(stopped).toBe(true); });
 const callSessionRpc = vi.fn(async (_id, _encryption, method) => method === 'delegation-context'
  ? { agent, hostPid: targetPid } : { success: true });
 const originalMachineClient = state.api.machineSyncClient;
 state.api.machineSyncClient = () => ({ ...originalMachineClient(), callSessionRpc });
 state.handlers = null; daemon = startDaemon(); await vi.waitFor(() => expect(state.handlers).toBeTruthy());
 if (!alive) vi.mocked(process.kill).mockImplementation((pid: number) => {
  if (Math.abs(pid) === targetPid) throw Object.assign(new Error('already exited'), { code: 'ESRCH' });
  return true;
 });
 const before = vi.mocked(process.kill).mock.calls.length;
 const result = await state.handlers.cancelConversationLaunch(f.request);
 expect(result.success).toBe(success);
 if (success) expect(result).toEqual({ success: true, cancelled: true, targetSessionId: targetId });
 expect(callSessionRpc.mock.calls.map(([, , method]) => method)).toEqual(success && alive ? ['delegation-context', 'killSession'] : []);
 expect(vi.mocked(process.kill).mock.calls.slice(before).every(([, signal]) => signal === 0)).toBe(true);
 expect(state.children[0].kill).not.toHaveBeenCalled();
 expect(state.spawned).toHaveLength(1);
});

it('launches a fresh managed Codex child without inheriting a parent native account audit', async () => {
 await rememberCodexAccountSession(join(sourceHome, 'codex-session-cache'), 'claude-parent', 'old-parent-profile');
 const launching = state.handlers.spawnSession({ directory: sourceHome, agent: 'codex', codexSessionGrant: 'g'.repeat(43), parentSessionId: 'claude-parent' });
 await vi.waitFor(() => expect(state.spawned).toHaveLength(1));
 expect(state.workerArgs[0]).not.toContain('--resume');
 expect(state.spawned[0].HAPPY_CODEX_ACCOUNT_PROFILE_ID).toBe('profile-1');
 state.control.onHappySessionWebhook('fresh-child', { hostPid: 987601, flavor: 'codex', startedBy: 'daemon', parentSessionId: 'claude-parent' });
 expect(await launching).toEqual({ type: 'success', sessionId: 'fresh-child' });
});

it('reads the exact frozen root archive while archived/busy and rejects a later durable clear', async () => {
 const f = await nativeConversationFixture();
 let descriptor: unknown;
 const store = new PortableContextStore({ directory: join(sourceHome, PORTABLE_CONTEXT_DIRECTORY_NAME), sessionId: 'conversation-root',
  serverUrl: configuration.serverUrl, token: 'fake', encryptionKey: f.encryption.encryptionKey, descriptor: () => descriptor });
 const snapshotId = '00000000-0000-4000-8000-000000000090';
 const archive = { snapshot: { version: 1, id: snapshotId, rootSessionId: 'original-root', sourceSessionId: 'original-source',
  heads: [{ sessionId: 'original-source', throughSeq: 1, afterSeq: 0 }],
  items: [{ id: 'original-message', sourceSessionId: 'original-source', seq: 1, role: 'user', text: 'frozen prefix '.repeat(5000) }] }, blobKeys: {} };
 const text = JSON.stringify(archive); const count = Math.ceil(text.length / 48000);
 for (let index = 0; index < count; index++) await store.upload({ action: 'append', snapshotId, index, chunk: text.slice(index * 48000, (index + 1) * 48000) });
 const committed = await store.upload({ action: 'commit', snapshotId, chunks: count, sha256: createHash('sha256').update(text).digest('hex') });
 descriptor = committed.descriptor;
 Object.assign(f.rootMetadata, { portableContext: descriptor, lifecycleState: 'archived' });
 f.rows[0].metadata = f.encrypted(f.rootMetadata); f.rows[0].agentState = f.encrypted({ turnStatus: { status: 'running' } });
 const first = await state.handlers.readConversationContext({ sourceSessionId: 'conversation-root' });
 expect(first.success).toBe(true); expect(first.chunk).toHaveLength(48000);
 const second = await state.handlers.readConversationContext({ sourceSessionId: 'conversation-root', textOffset: first.nextTextOffset });
 expect(second.success).toBe(true); expect(second.nextTextOffset).toBeNull(); expect(first.chunk + second.chunk).toBe(text);
 expect(state.spawned).toHaveLength(1);
 await store.revoke({ id: '00000000-0000-4000-8000-000000000091', afterSeq: 12 });
 expect(await state.handlers.readConversationContext({ sourceSessionId: 'conversation-root' })).toMatchObject({ success: false });
 await store.dispose();
});
