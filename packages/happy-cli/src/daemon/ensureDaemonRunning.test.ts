import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockCheckIfDaemonRunningAndCleanupStaleState: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
  checkIfDaemonRunningAndCleanupStaleState: mocks.mockCheckIfDaemonRunningAndCleanupStaleState,
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.mockSpawnHappyCLI,
}))

import { ensureDaemonRunning } from './ensureDaemonRunning'

describe('ensureDaemonRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: vi.fn(),
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true)
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('starts the daemon and waits for readiness when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    const originalReconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID
    const originalReconnectEncryptionKey = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    process.env.HAPPY_RECONNECT_SESSION_ID = 'stale-session'
    process.env.HAPPY_RECONNECT_ENCRYPTION_KEY = 'stale-key'
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: mockUnref,
    })
    mocks.mockCheckIfDaemonRunningAndCleanupStaleState
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    try {
      await ensureDaemonRunning()

      expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          PATH: process.env.PATH,
        }),
      }))
      const spawnOptions = mocks.mockSpawnHappyCLI.mock.calls[0][1]
      expect(spawnOptions.env).not.toHaveProperty('HAPPY_RECONNECT_SESSION_ID')
      expect(spawnOptions.env).not.toHaveProperty('HAPPY_RECONNECT_ENCRYPTION_KEY')
      expect(mockUnref).toHaveBeenCalled()
      expect(mocks.mockCheckIfDaemonRunningAndCleanupStaleState).toHaveBeenCalledTimes(2)
      expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
      expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Happy background service is ready')
    } finally {
      if (originalReconnectSessionId === undefined) {
        delete process.env.HAPPY_RECONNECT_SESSION_ID
      } else {
        process.env.HAPPY_RECONNECT_SESSION_ID = originalReconnectSessionId
      }
      if (originalReconnectEncryptionKey === undefined) {
        delete process.env.HAPPY_RECONNECT_ENCRYPTION_KEY
      } else {
        process.env.HAPPY_RECONNECT_ENCRYPTION_KEY = originalReconnectEncryptionKey
      }
    }
  })
})
