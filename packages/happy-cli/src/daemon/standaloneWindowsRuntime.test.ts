import { afterEach, expect, it, vi } from 'vitest';
import * as nativeLauncher from './windowsSessionLauncher';
import { inspectStandaloneCandidatePresence, resolveCandidateDaemonPresence, candidateDaemonPresence, assertStandaloneCandidateIdentity, readStandaloneCandidateId, createStandaloneWindowsRuntime, freezeWithTerminals } from './standaloneWindowsRuntime';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });
const input = { homeDir: '/unused', getChildren: () => [], managed: false };
it('does not infer support from an operating system or installed CLI version', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  expect(await createStandaloneWindowsRuntime({ ...input, env: {} })).toBeUndefined();
});
it.each([{ platform: 'darwin', arch: 'arm64', managed: false },
  { platform: 'win32', arch: 'arm64', managed: false },
  { platform: 'win32', arch: 'x64', managed: true }])('rejects an unverified activation target %j', async target => {
  Object.defineProperty(process, 'platform', { value: target.platform });
  Object.defineProperty(process, 'arch', { value: target.arch });
  await expect(createStandaloneWindowsRuntime({ ...input, managed: target.managed, env: {
    HAPPY_STANDALONE_WINDOWS_LAUNCHER: 'C:\\launcher.exe', HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256: 'a'.repeat(64),
  } })).rejects.toThrow('unmanaged Windows x64 trial');
});
it('rejects incomplete opt-in instead of silently allowing legacy Windows signals', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  Object.defineProperty(process, 'arch', { value: 'x64' });
  await expect(createStandaloneWindowsRuntime({ ...input, env: { HAPPY_STANDALONE_WINDOWS_LAUNCHER: 'C:\\launcher.exe' } })).rejects.toThrow();
});

it('consumes daemon-only activation and candidate identity before any asynchronous work', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const env = { HAPPY_STANDALONE_WINDOWS_LAUNCHER: 'C:\\helper.exe', HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256: 'a'.repeat(64),
    HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID: 'b'.repeat(64), KEEP: 'preserved' };
  const pending = createStandaloneWindowsRuntime({ ...input, env });
  expect(env).toEqual({ KEEP: 'preserved' });
  await expect(pending).rejects.toThrow('unmanaged Windows x64 trial');
});
it('requires a well-formed candidate identity and rejects candidate activation without a native helper', async () => {
  expect(readStandaloneCandidateId({})).toBeUndefined();
  expect(readStandaloneCandidateId({ HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID: 'a'.repeat(64) })).toBe('a'.repeat(64));
  expect(() => readStandaloneCandidateId({ HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID: '1' })).toThrow();
  await expect(createStandaloneWindowsRuntime({ ...input, env: { HAPPY_STANDALONE_WINDOWS_CANDIDATE_ID: 'a'.repeat(64) } })).rejects.toThrow('requires a native launcher');
});
it('refuses adopting or replacing a differently identified live daemon but preserves normal release behavior', () => {
  expect(() => assertStandaloneCandidateIdentity('a'.repeat(64), { state: 'running' })).toThrow('isolated home');
  expect(() => assertStandaloneCandidateIdentity(undefined, { state: 'running', windowsCandidateId: 'a'.repeat(64) })).toThrow('isolated home');
  expect(() => assertStandaloneCandidateIdentity('b'.repeat(64), { state: 'running', windowsCandidateId: 'a'.repeat(64) })).toThrow('isolated home');
  expect(() => assertStandaloneCandidateIdentity('a'.repeat(64), { state: 'running', windowsCandidateId: 'a'.repeat(64) }, 'live')).not.toThrow();
  expect(() => assertStandaloneCandidateIdentity('a'.repeat(64), { state: 'running', windowsCandidateId: 'a'.repeat(64) }, 'unknown')).toThrow('could not be verified');
  expect(() => assertStandaloneCandidateIdentity('b'.repeat(64), { state: 'stopped', windowsCandidateId: 'a'.repeat(64) }, 'gone')).not.toThrow();
  expect(() => assertStandaloneCandidateIdentity(undefined, { state: 'running' })).not.toThrow();
});

it('allows a proven-dead previous candidate but fails closed on denied liveness inspection', () => {
  const kill = vi.spyOn(process, 'kill');
  try {
    kill.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); });
    expect(candidateDaemonPresence(123)).toBe('gone');
    expect(() => assertStandaloneCandidateIdentity('b'.repeat(64), { state: 'running', windowsCandidateId: 'a'.repeat(64) }, candidateDaemonPresence(123))).not.toThrow();
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(candidateDaemonPresence(123)).toBe('unknown');
    expect(() => assertStandaloneCandidateIdentity('b'.repeat(64), { state: 'stopped', windowsCandidateId: 'a'.repeat(64) }, candidateDaemonPresence(123))).toThrow('isolated home');
  } finally { kill.mockRestore(); }
});

it.each([{ creationFileTime: '101', expected: 'gone' }, { creationFileTime: '100', expected: 'live' }])(
  'compares the saved process incarnation before rejecting a candidate ($expected)', async ({ creationFileTime, expected }) => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const probe = vi.fn(async () => ({ pid: 123, creationFileTime }));
    try {
      expect(await resolveCandidateDaemonPresence({ pid: 123, windowsProcessIdentity: { pid: 123, creationFileTime: '100' } }, probe)).toBe(expected);
      expect(probe).toHaveBeenCalledWith(123);
    } finally { kill.mockRestore(); }
  });
it('keeps failed or mismatched native identity observations unknown and legacy live PIDs protected', async () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const state = { pid: 123, windowsProcessIdentity: { pid: 123, creationFileTime: '100' } };
    await expect(resolveCandidateDaemonPresence(state, async () => { throw new Error('denied'); })).resolves.toBe('unknown');
    await expect(resolveCandidateDaemonPresence(state, async () => ({ pid: 456, creationFileTime: '101' }))).resolves.toBe('unknown');
    const probe = vi.fn(async () => ({ pid: 123, creationFileTime: '101' }));
    await expect(resolveCandidateDaemonPresence({ pid: 123 }, probe)).resolves.toBe('live');
    expect(probe).not.toHaveBeenCalled();
    kill.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); });
    await expect(resolveCandidateDaemonPresence(state, probe)).resolves.toBe('gone');
    expect(probe).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); }
});

it('never executes an unverified helper while inspecting a saved candidate incarnation', async () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const probe = vi.spyOn(nativeLauncher, 'probeWindowsProcessIdentity');
  const verify = vi.spyOn(nativeLauncher, 'verifyWindowsSessionLauncher').mockRejectedValue(new Error('digest mismatch'));
  try {
    expect(await inspectStandaloneCandidatePresence('/unused', {
      HAPPY_STANDALONE_WINDOWS_LAUNCHER: 'C:\\untrusted.exe', HAPPY_STANDALONE_WINDOWS_LAUNCHER_SHA256: 'a'.repeat(64),
    }, { pid: 123, windowsProcessIdentity: { pid: 123, creationFileTime: '100' } })).toBe('unknown');
    expect(verify).toHaveBeenCalledOnce(); expect(probe).not.toHaveBeenCalled();
  } finally { kill.mockRestore(); probe.mockRestore(); verify.mockRestore(); }
});

it('launches and advertises exactly the providers with a session drain: Codex, Claude (the daemon default), opencode and Grok', async () => {
  const { acceptsStandaloneWindowsProvider, acceptsStandaloneWindowsLaunch, STANDALONE_WINDOWS_TARGETS } = await import('./standaloneWindowsRuntime');
  expect(STANDALONE_WINDOWS_TARGETS).toEqual(['codex', 'claude', 'opencode', 'grok'].map(provider =>
    ({ platform: 'win32', arch: 'x64', provider, mode: 'standard' })));
  for (const accepted of ['codex', 'claude', 'opencode', 'grok', undefined]) expect(acceptsStandaloneWindowsProvider(accepted)).toBe(true);
  for (const refused of ['acp', 'gemini', 'openclaw', '']) expect(acceptsStandaloneWindowsProvider(refused)).toBe(false);
  // The Happy CLI arguments the daemon launches: opencode runs over ACP.
  for (const accepted of [['codex'], ['claude'], ['grok'], ['acp', 'opencode']]) expect(acceptsStandaloneWindowsLaunch(accepted)).toBe(true);
  for (const refused of [['acp'], ['acp', 'gemini'], ['opencode'], ['gemini'], []]) expect(acceptsStandaloneWindowsLaunch(refused)).toBe(false);
});

// Desktop specs/windows-build-support W0-5h: terminals are owned too, so an app-close drain closes
// them with the sessions and cannot complete while one is not proven gone.
it('closes terminals alongside the session freeze and reports an unproven one as unresolved', async () => {
  const order: string[] = [];
  const ownerFreeze = () => { order.push('sessions-frozen'); return Promise.resolve({ launchIds: ['a'], unresolved: false }); };
  const closed = await freezeWithTerminals(ownerFreeze, () => { order.push('terminals-closed'); return Promise.resolve(['killed', 'already-gone'] as const); });
  expect(closed).toEqual({ launchIds: ['a'], unresolved: false });
  // The session gate closes first, in the same tick, so no terminal can open behind the teardown.
  expect(order).toEqual(['sessions-frozen', 'terminals-closed']);

  const escaped = await freezeWithTerminals(ownerFreeze, () => Promise.resolve(['killed', 'escaped'] as const));
  expect(escaped).toEqual({ launchIds: ['a'], unresolved: true });
  const unresolvedSessions = await freezeWithTerminals(() => Promise.resolve({ launchIds: [], unresolved: true }), () => Promise.resolve([]));
  expect(unresolvedSessions.unresolved).toBe(true);
});
