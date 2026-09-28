import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn as crossSpawn } from 'cross-spawn';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { preflightInstalledHappyCLI, resolveHappyCliSpawnCommand, spawnHappyCLI, spawnDetachedHappyCLI, startDetachedHappyCLI } from './spawnHappyCLI';

vi.mock('cross-spawn', () => ({ spawn: vi.fn(() => ({})) }));

describe('daemon working directory', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['start', 'start-sync'])('starts daemon %s outside the caller worktree', (subcommand) => {
    spawnHappyCLI(['daemon', subcommand], { cwd: '/tmp/automation-worktree', detached: true });
    expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ cwd: homedir(), detached: true }));
  });

  it('can restart the daemon even after its inherited cwd has been deleted', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => { throw new Error('ENOENT: uv_cwd'); });
    expect(() => spawnHappyCLI(['daemon', 'start-sync'])).not.toThrow();
    expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ cwd: homedir() }));
  });

  it('keeps the requested working directory for agent sessions', () => {
    spawnHappyCLI(['claude'], { cwd: '/tmp/project-session' });
    expect(crossSpawn).toHaveBeenLastCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/project-session' }));
  });
});

describe('resolveHappyCliSpawnCommand', () => {
  it('uses the source entrypoint when the current CLI is running from source', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['daemon', 'start-sync'], {
      projectRoot,
      execPath: '/node',
      execArgv: ['--import', '/repo/node_modules/tsx/loader.mjs'],
      argv: ['/node', join(projectRoot, 'src', 'index.ts'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('/node');
    expect(result.entrypoint).toBe(join(projectRoot, 'src', 'index.ts'));
    expect(result.tsconfigPath).toBe(join(projectRoot, 'tsconfig.json'));
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      '--import',
      '/repo/node_modules/tsx/loader.mjs',
      join(projectRoot, 'src', 'index.ts'),
      'daemon',
      'start-sync',
    ]);
  });

  it('uses the bundled dist entrypoint for production CLI processes', () => {
    const projectRoot = '/repo/packages/happy-cli';
    const result = resolveHappyCliSpawnCommand(['claude'], {
      projectRoot,
      execPath: '/node',
      execArgv: [],
      argv: ['/node', join(projectRoot, 'dist', 'index.mjs'), 'daemon', 'start-sync'],
      isBunRuntime: false,
    });

    expect(result.runtime).toBe('node');
    expect(result.entrypoint).toBe(join(projectRoot, 'dist', 'index.mjs'));
    expect(result.tsconfigPath).toBeUndefined();
    expect(result.args).toEqual([
      '--no-warnings',
      '--no-deprecation',
      join(projectRoot, 'dist', 'index.mjs'),
      'claude',
    ]);
  });
});

describe('preflightInstalledHappyCLI', () => {
  it('reports ready only when the candidate preflight exits successfully', async () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    const spawn = vi.fn(() => child)
    const preflight = preflightInstalledHappyCLI({ spawn, timeoutMs: 1_000 })

    child.emit('exit', 0)

    await expect(preflight).resolves.toBe(true)
    expect(spawn).toHaveBeenCalledWith(['daemon', 'preflight'], { stdio: 'ignore' })
  })

  it('reports not ready when the candidate preflight fails', async () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    const preflight = preflightInstalledHappyCLI({ spawn: () => child, timeoutMs: 1_000 })

    child.emit('exit', 1)

    await expect(preflight).resolves.toBe(false)
  })
})

describe('startDetachedHappyCLI', () => {
  const makeChild = () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    child.unref = vi.fn()
    return child
  }

  // 2026-08-25: the replacement exec'd fine — the 'spawn' event fired — but
  // `happy daemon start` then polled for 5s, never saw a daemon, printed
  // "Failed to start daemon" and exited 1. The handoff had already reported
  // success on 'spawn' alone, so the old daemon exited and the machine had no
  // daemon for six hours. Exec success is not startup success.
  it('does not report success when the command exits non-zero after spawning', async () => {
    const child = makeChild()
    const started = startDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 1_000 })

    child.emit('spawn')
    child.emit('exit', 1)

    await expect(started).resolves.toBe(false)
  })

  it('reports success only once the command confirms startup by exiting zero', async () => {
    const child = makeChild()
    const started = startDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 1_000 })

    child.emit('spawn')

    let settled = false
    void started.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('exit', 0)

    await expect(started).resolves.toBe(true)
  })

  it('reports failure when the child errors instead of starting', async () => {
    const child = makeChild()
    const started = startDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 1_000 })

    child.emit('error', new Error('EAGAIN'))

    await expect(started).resolves.toBe(false)
  })

  it('reports failure when the command never reports either way', async () => {
    const child = makeChild()
    const started = startDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 10 })

    child.emit('spawn')

    await expect(started).resolves.toBe(false)
  })

  it('reports failure when spawning throws synchronously', async () => {
    const spawn = vi.fn(() => { throw new Error('entrypoint missing') })

    await expect(
      startDetachedHappyCLI(['daemon', 'start'], { spawn, timeoutMs: 1_000 })
    ).resolves.toBe(false)
  })

  // Unchanged from the previous contract and still load-bearing: an
  // unconfirmed child may be a daemon that is merely slow, and the retry is
  // safe because `daemon start` detects an already-running daemon.
  it('never kills the child, even when startup cannot be confirmed', async () => {
    const child = makeChild()

    await startDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 10 })

    expect(child.kill).not.toHaveBeenCalled()
  })

  it('spawns detached so the daemon survives this process exiting', async () => {
    const child = makeChild()
    const spawn = vi.fn(() => child)

    const started = startDetachedHappyCLI(['daemon', 'start'], { spawn, timeoutMs: 1_000 })
    child.emit('spawn')
    child.emit('exit', 0)
    await started

    expect(spawn).toHaveBeenCalledWith(['daemon', 'start'], expect.objectContaining({ detached: true }))
    expect(child.unref).toHaveBeenCalled()
  })
})

describe('spawnDetachedHappyCLI', () => {
  const makeChild = () => {
    const child = new EventEmitter() as ChildProcess
    child.kill = vi.fn()
    child.unref = vi.fn()
    return child
  }

  it('resolves only after the child reports it was spawned', async () => {
    const child = makeChild()
    const spawn = vi.fn(() => child)

    const started = spawnDetachedHappyCLI(['daemon', 'start'], { spawn, timeoutMs: 1_000 })

    // The OS has not exec'd the child yet — the handoff must not consider
    // itself done, because exiting here is what loses the replacement.
    let settled = false
    void started.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('spawn')

    await expect(started).resolves.toBe(true)
  })

  it('unrefs the child so the detached replacement outlives this process', async () => {
    const child = makeChild()
    const started = spawnDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 1_000 })

    child.emit('spawn')
    await started

    expect(child.unref).toHaveBeenCalled()
  })

  it('reports failure when the child errors instead of spawning', async () => {
    const child = makeChild()
    const started = spawnDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 1_000 })

    child.emit('error', new Error('EAGAIN'))

    await expect(started).resolves.toBe(false)
  })

  it('reports failure when the spawn never reports either way', async () => {
    const child = makeChild()
    const started = spawnDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 10 })

    await expect(started).resolves.toBe(false)
  })

  // Deliberately unlike preflightInstalledHappyCLI, which kills its child on
  // timeout. That child is a throwaway probe; this one may be the machine's
  // only daemon, merely slow to report. Killing it would recreate the very
  // outage this function exists to prevent.
  it('never kills the child, even when the spawn report times out', async () => {
    const child = makeChild()

    await spawnDetachedHappyCLI(['daemon', 'start'], { spawn: () => child, timeoutMs: 10 })

    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports failure when spawning throws synchronously', async () => {
    const spawn = vi.fn(() => { throw new Error('entrypoint missing') })

    await expect(
      spawnDetachedHappyCLI(['daemon', 'start'], { spawn, timeoutMs: 1_000 })
    ).resolves.toBe(false)
  })

  it('spawns detached so the replacement survives this process exiting', async () => {
    const child = makeChild()
    const spawn = vi.fn(() => child)

    const started = spawnDetachedHappyCLI(['daemon', 'start'], { spawn, timeoutMs: 1_000 })
    child.emit('spawn')
    await started

    expect(spawn).toHaveBeenCalledWith(['daemon', 'start'], expect.objectContaining({ detached: true }))
  })
})
