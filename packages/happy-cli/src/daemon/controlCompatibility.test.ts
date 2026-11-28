import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDaemonControlServer } from './controlServer';
import { checkIfDaemonRunningAndCleanupStaleState, notifyDaemonSessionStarted, stopDaemon } from './controlClient';
import { readDaemonState, writeDaemonState } from '@/persistence';

const config = vi.hoisted(() => ({ daemonStateFile: '', legacyDaemonStateFile: '', daemonLockFile: '' }));
vi.mock('@/configuration', () => ({ configuration: config }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

// Verbatim npm happy@1.2.6 excerpts (sha512-hOtG3emwdE29sHtdU2aklYRkSEYQs6GarmRstP4kXApzvBFIOczU0XjpqD0oMsYmRGgjg3BKgZkp4NYWkeuA2w==).
// persistence-CNBZjS7Z.mjs:196-207; index-rvVMj12o.mjs:3873-3932,3945-3978,4003-4040 and 4904-4919.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/legacy-${name}-1.2.6.txt`, import.meta.url), 'utf8');
const state = { pid: 12345, httpPort: 12345, startTime: '', startedWithCliVersion: '1.2.6' };
const metadata = { host: 'fixture', path: '.', happyHomeDir: '.', homeDir: '.', happyToolsDir: '.', happyLibDir: '.' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'happy-compat-'));
  config.daemonStateFile = join(dir, 'daemon.control.json');
  config.legacyDaemonStateFile = join(dir, 'daemon.state.json');
  config.daemonLockFile = join(dir, 'daemon.state.json.lock');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

it('1.2.6 client cannot discover the new daemon for registration or its force-kill fallback', async () => {
  const server = createDaemonControlServer({ getChildren: () => [], stopSession: vi.fn(), spawnSession: vi.fn(),
    onHappySessionWebhook: vi.fn(), requestShutdown: vi.fn() });
  try {
    writeDaemonState({ ...state, controlToken: server.controlToken });
    expect(existsSync(config.legacyDaemonStateFile)).toBe(false);
    const kill = vi.fn(); // Never signal a real process, even for the legacy fallback control case.
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const r = await server.app.inject({ method: 'POST', url: new URL(url).pathname,
        headers: Object.fromEntries(new Headers(init.headers)), payload: String(init.body) });
      return new Response(r.body, { status: r.statusCode });
    });
    let clock = 0;
    const legacy = runInNewContext(fixture('control') + '\n;({ notifyDaemonSessionStarted, stopDaemon, checkIfDaemonRunningAndCleanupStaleState })', {
      configuration: { daemonStateFile: config.legacyDaemonStateFile }, existsSync,
      readFile: async (path: string) => readFileSync(path, 'utf8'), process: { env: {}, kill }, fetch,
      AbortSignal, logger: { debug: vi.fn() }, Date: { now: () => clock },
      setTimeout: (fn: () => void, ms: number) => { clock += ms; fn(); },
    });
    expect(await legacy.checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
    expect(await legacy.notifyDaemonSessionStarted('fixture', metadata)).toHaveProperty('error');
    await legacy.stopDaemon();
    expect(fetch).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();

    // Counterfactual fixture: reusing the old filename lets 1.2.6 reach its fallback after 401.
    writeFileSync(config.legacyDaemonStateFile, JSON.stringify(state));
    await legacy.stopDaemon();
    expect(kill).toHaveBeenCalledWith(state.pid, 'SIGKILL');
  } finally { await server.app.close(); }
});

it('new client refuses legacy registration, but uses the exact 1.2.6 graceful stop contract', async () => {
  writeFileSync(config.legacyDaemonStateFile, JSON.stringify(state));
  let alive = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    expect(signal).toBe(0);
    if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' });
    return true;
  });
  const register = vi.fn();
  runInNewContext(fixture('stop-route'), { typed: { post: register }, z, logger: { debug: vi.fn() },
    setTimeout: (fn: () => void) => fn(), requestShutdown: () => { alive = false; } });
  const [route, , handler] = register.mock.calls[0];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).pathname).toBe(route);
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(init).toMatchObject({ redirect: 'error', body: '{}' });
    return Response.json(await handler());
  });
  vi.stubGlobal('fetch', fetch);
  const now = Date.now();
  let clock = now;
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 3001));
  expect(await notifyDaemonSessionStarted('fixture', metadata)).toHaveProperty('error');
  expect(fetch).not.toHaveBeenCalled();
  await stopDaemon();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(alive).toBe(false);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it.each(['401', 'timeout', 'still alive'])('new stop fails without signalling on %s', async failure => {
  writeDaemonState({ ...state, controlToken: '1'.repeat(64) });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 6000));
  const fetch = vi.fn(async () => {
    if (failure === 'timeout') throw new Error('Request timed out');
    return Response.json({ status: 'stopping' }, { status: failure === '401' ? 401 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(stopDaemon()).rejects.toThrow(/confirm/);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
});

it('never downgrades to legacy state on a corrupt authenticated state', async () => {
  writeFileSync(config.legacyDaemonStateFile, JSON.stringify(state));
  writeFileSync(config.daemonStateFile, JSON.stringify(state));
  await expect(readDaemonState()).rejects.toThrow('Invalid daemon state');
});

for (const generation of ['legacy', 'authenticated']) {
  it.each(['refused', '401', 'not a daemon', 'EPERM', 'timeout'])('%s during ' + generation + ' readiness', async outcome => {
    const path = generation === 'legacy' ? config.legacyDaemonStateFile : config.daemonStateFile;
    if (generation === 'legacy') writeFileSync(path, JSON.stringify(state));
    else writeDaemonState({ ...state, controlToken: '1'.repeat(64) });
    writeFileSync(config.daemonLockFile, String(state.pid));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      if (outcome === 'EPERM') throw Object.assign(new Error(), { code: 'EPERM' });
      return true;
    });
    const fetch = vi.fn(async () => {
      if (outcome === 'refused') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      if (outcome === 'timeout') throw new Error('timeout');
      return Response.json({}, { status: outcome === '401' ? 401 : 200 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
    expect(existsSync(path)).toBe(outcome === 'timeout');
    expect(existsSync(config.daemonLockFile)).toBe(outcome === 'timeout');
    if (outcome === 'timeout') await expect(stopDaemon()).rejects.toThrow('confirm');
    else await expect(stopDaemon()).resolves.toBeUndefined(); // next step in start-sync
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });
}

it.each([true, false])('recovers corrupt state only without a live lock owner (alive=%s)', async alive => {
  writeFileSync(config.daemonLockFile, String(state.pid));
  writeFileSync(config.daemonStateFile, '{');
  writeFileSync(config.legacyDaemonStateFile, JSON.stringify(state));
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' });
    return true;
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  if (alive) await expect(checkIfDaemonRunningAndCleanupStaleState()).rejects.toThrow('Invalid daemon state');
  else expect(await checkIfDaemonRunningAndCleanupStaleState()).toBe(false);
  expect(existsSync(config.daemonStateFile)).toBe(alive);
  expect(existsSync(config.legacyDaemonStateFile)).toBe(alive);
  expect(fetch).not.toHaveBeenCalled();
});