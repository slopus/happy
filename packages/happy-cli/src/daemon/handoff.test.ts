import { describe, expect, it, vi } from 'vitest'
import { handoffToReplacedBundle, prepareDaemonStartup, resolveStatePreservation } from './handoff'

describe('prepareDaemonStartup', () => {
  it('never adopts or stops the process reusing a proven-gone candidate PID', async () => {
    const preflightCandidate = vi.fn(async () => {})
    const runningVersionMatches = vi.fn(async () => true)
    const stopRunningDaemon = vi.fn(async () => {})
    expect(await prepareDaemonStartup({ preflightCandidate, runningVersionMatches, stopRunningDaemon,
      previousDaemonGone: true })).toBe('start')
    expect(preflightCandidate).toHaveBeenCalledOnce()
    expect(runningVersionMatches).not.toHaveBeenCalled()
    expect(stopRunningDaemon).not.toHaveBeenCalled()
  })

  it('does not inspect or stop the running daemon when candidate preflight fails', async () => {
    const events: string[] = []
    const preflightCandidate = vi.fn(async () => {
      events.push('preflight')
      throw new Error('candidate runtime is incomplete')
    })
    const runningVersionMatches = vi.fn(async () => {
      events.push('version-check')
      return false
    })
    const stopRunningDaemon = vi.fn(async () => {
      events.push('stop')
    })

    await expect(prepareDaemonStartup({
      preflightCandidate,
      runningVersionMatches,
      stopRunningDaemon,
    })).rejects.toThrow('candidate runtime is incomplete')

    expect(events).toEqual(['preflight'])
    expect(runningVersionMatches).not.toHaveBeenCalled()
    expect(stopRunningDaemon).not.toHaveBeenCalled()
  })

  it('preflights before stopping a daemon with a different version', async () => {
    const events: string[] = []

    const result = await prepareDaemonStartup({
      preflightCandidate: async () => { events.push('preflight') },
      runningVersionMatches: async () => { events.push('version-check'); return false },
      stopRunningDaemon: async () => { events.push('stop') },
    })

    expect(result).toBe('start')
    expect(events).toEqual(['preflight', 'version-check', 'stop'])
  })
})

describe('resolveStatePreservation', () => {
  const withSessions = {
    pid: 1094,
    httpPort: 42001,
    startTime: 'x',
    startedWithCliVersion: '1.1.9',
    state: 'running' as const,
    trackedSessions: [{ pid: 117331, startedBy: 'daemon', startedAt: 1 }],
  }

  // Daemons at or below 1.1.9 unlink the state file when told to stop, taking
  // their live children's only record with them. That code runs inside the OLD
  // process, so the replacement can't fix it there — it has to restore the
  // snapshot it took before asking the old daemon to die.
  it('restores the pre-stop snapshot when the old daemon deleted the state file', () => {
    expect(resolveStatePreservation({ before: withSessions, after: null }))
      .toEqual({ ...withSessions, state: 'stopped' })
  })

  it('leaves a state file the old daemon preserved alone', () => {
    const after = { ...withSessions, state: 'stopped' as const }
    expect(resolveStatePreservation({ before: withSessions, after })).toBeNull()
  })

  it('has nothing to restore when the old daemon tracked no sessions', () => {
    expect(resolveStatePreservation({
      before: { ...withSessions, trackedSessions: [] },
      after: null,
    })).toBeNull()
  })

  it('has nothing to restore when there was no daemon to begin with', () => {
    expect(resolveStatePreservation({ before: null, after: null })).toBeNull()
  })
})

describe('handoffToReplacedBundle', () => {
  it('keeps all current daemon resources when the new bundle preflight fails', async () => {
    const teardownCurrentDaemon = vi.fn(async () => {})
    const spawnReplacement = vi.fn()

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => false,
      teardownCurrentDaemon,
      spawnReplacement,
    })

    expect(result).toBe('kept-current')
    expect(teardownCurrentDaemon).not.toHaveBeenCalled()
    expect(spawnReplacement).not.toHaveBeenCalled()
  })

  it('tears down and spawns only after the new bundle preflight succeeds', async () => {
    const events: string[] = []

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => { events.push('preflight'); return true },
      teardownCurrentDaemon: async () => { events.push('teardown') },
      spawnReplacement: async () => { events.push('spawn'); return true },
    })

    expect(result).toBe('handed-off')
    expect(events).toEqual(['preflight', 'teardown', 'spawn'])
  })

  it('defers after preflight when activity starts before teardown', async () => {
    const events: string[] = []
    const teardownCurrentDaemon = vi.fn(async () => {})
    const spawnReplacement = vi.fn(async () => true)

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => { events.push('preflight'); return true },
      canHandoff: () => { events.push('activity-check'); return false },
      teardownCurrentDaemon,
      spawnReplacement,
    })

    expect(result).toBe('deferred')
    expect(events).toEqual(['preflight', 'activity-check'])
    expect(teardownCurrentDaemon).not.toHaveBeenCalled()
    expect(spawnReplacement).not.toHaveBeenCalled()
  })

  it('retries the spawn when the replacement process never starts', async () => {
    const spawnReplacement = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => true,
      teardownCurrentDaemon: async () => { },
      spawnReplacement,
      spawnAttempts: 3,
    })

    expect(result).toBe('handed-off')
    expect(spawnReplacement).toHaveBeenCalledTimes(2)
  })

  it('reports the replacement never started after exhausting every attempt', async () => {
    const spawnReplacement = vi.fn(async () => false)

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => true,
      teardownCurrentDaemon: async () => { },
      spawnReplacement,
      spawnAttempts: 3,
    })

    expect(result).toBe('replacement-not-started')
    expect(spawnReplacement).toHaveBeenCalledTimes(3)
  })

  it('waits between attempts so a transient spawn failure has time to clear', async () => {
    const events: string[] = []
    const spawnReplacement = vi.fn(async (attempt: number) => {
      events.push(`spawn-${attempt}`)
      return attempt === 3
    })

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => true,
      teardownCurrentDaemon: async () => { },
      spawnReplacement,
      spawnAttempts: 3,
      waitBetweenAttempts: async () => { events.push('wait') },
    })

    expect(result).toBe('handed-off')
    // No wait before the first attempt, and none after the one that succeeded.
    expect(events).toEqual(['spawn-1', 'wait', 'spawn-2', 'wait', 'spawn-3'])
  })

  it('does not wait after the final failed attempt', async () => {
    const events: string[] = []

    await handoffToReplacedBundle({
      preflightReplacement: async () => true,
      teardownCurrentDaemon: async () => { },
      spawnReplacement: async (attempt) => { events.push(`spawn-${attempt}`); return false },
      spawnAttempts: 2,
      waitBetweenAttempts: async () => { events.push('wait') },
    })

    expect(events).toEqual(['spawn-1', 'wait', 'spawn-2'])
  })

  it('keeps retrying when a spawn attempt throws', async () => {
    const spawnReplacement = vi.fn()
      .mockRejectedValueOnce(new Error('EAGAIN'))
      .mockResolvedValueOnce(true)

    const result = await handoffToReplacedBundle({
      preflightReplacement: async () => true,
      teardownCurrentDaemon: async () => { },
      spawnReplacement,
      spawnAttempts: 3,
    })

    expect(result).toBe('handed-off')
    expect(spawnReplacement).toHaveBeenCalledTimes(2)
  })
})
