import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DaemonLocallyPersistedState } from '@/persistence'

const mocks = vi.hoisted(() => ({
  mockReadDaemonStateSnapshot: vi.fn(),
  mockWriteDaemonState: vi.fn(),
  mockWriteDaemonStateIfUnchanged: vi.fn(),
  mockClearDaemonState: vi.fn(),
  mockLoggerDebug: vi.fn(),
}))

vi.mock('@/persistence', () => ({
  readDaemonStateSnapshot: mocks.mockReadDaemonStateSnapshot,
  readDaemonState: async () => (await mocks.mockReadDaemonStateSnapshot()).state,
  writeDaemonState: mocks.mockWriteDaemonState,
  writeDaemonStateIfUnchanged: mocks.mockWriteDaemonStateIfUnchanged,
  clearDaemonState: mocks.mockClearDaemonState,
}))

vi.mock('@/ui/logger', () => ({
  logger: { debug: mocks.mockLoggerDebug },
}))

import { checkIfDaemonRunningAndCleanupStaleState, stopDaemon } from './controlClient'

const DEAD_PID = 3058947
const HTTP_PORT = 33417

function stateWithPid(pid: number): DaemonLocallyPersistedState {
  return {
    pid,
    httpPort: HTTP_PORT,
    startTime: '8/17/2026, 12:05:29 PM',
    startedWithCliVersion: '1.1.10-aplus.116',
    daemonLogPath: '/tmp/daemon.log',
    state: 'running',
    trackedSessions: [],
  }
}

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockWriteDaemonStateIfUnchanged.mockReturnValue(true)
  })

  it('reports not running and marks the state crashed when the recorded pid is dead', async () => {
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockWriteDaemonStateIfUnchanged).toHaveBeenCalledWith(
      JSON.stringify(state),
      { ...state, state: 'crashed', stateReason: 'Daemon PID not running' },
    )
  })

  it('never writes the crashed marker with an unguarded write', async () => {
    // Regression: an unguarded write resurrects the dead pid on top of the state a
    // daemon that started in the meantime just wrote, and that daemon then shuts
    // itself down on its next heartbeat.
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })

    await checkIfDaemonRunningAndCleanupStaleState()

    expect(mocks.mockWriteDaemonState).not.toHaveBeenCalled()
  })

  it('skips the crashed marker when another process rewrote the state file first', async () => {
    const state = stateWithPid(DEAD_PID)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    mocks.mockWriteDaemonStateIfUnchanged.mockReturnValue(false)

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      '[DAEMON RUN] Daemon state file changed while we were checking it, leaving it to its owner',
    )
  })

  it('returns false without writing when there is no state file', async () => {
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state: null, raw: null })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)

    expect(mocks.mockWriteDaemonStateIfUnchanged).not.toHaveBeenCalled()
  })

  it('reports running when the recorded pid is alive and answers the control server', async () => {
    const state = stateWithPid(process.pid)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    try {
      await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
      expect(fetchSpy).toHaveBeenCalledWith(
        `http://127.0.0.1:${HTTP_PORT}/list`,
        expect.objectContaining({ method: 'POST' }),
      )
      expect(mocks.mockWriteDaemonStateIfUnchanged).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  // ADR-061: the control server rejects every request without this header.
  it('authenticates the control server call with the persisted controlSecret', async () => {
    const state = { ...stateWithPid(process.pid), controlSecret: 's3cr3t-value' }
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    try {
      await checkIfDaemonRunningAndCleanupStaleState()
      expect(fetchSpy).toHaveBeenCalledWith(
        `http://127.0.0.1:${HTTP_PORT}/list`,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer s3cr3t-value' }),
        }),
      )
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('stopDaemon', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([409, 401, 403])('preserves the daemon when HTTP stop is refused (%s)', async (status) => {
    const state = stateWithPid(process.pid)
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status } as Response)
    try {
      await expect(stopDaemon()).rejects.toThrow(`HTTP ${status}`)
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
      expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
    } finally { killSpy.mockRestore(); fetchSpy.mockRestore() }
  })

  it('does not signal a reused pid after stale daemon state was marked stopped', async () => {
    const state = { ...stateWithPid(process.pid), state: 'stopped' as const }
    mocks.mockReadDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('stale control port'))

    try {
      await stopDaemon()

      expect(killSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
      fetchSpy.mockRestore()
    }
  })
})
