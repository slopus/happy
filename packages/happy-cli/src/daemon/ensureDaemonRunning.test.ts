import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockLoggerDebug: vi.fn(),
  mockIsDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  mockSpawnHappyCLI: vi.fn(),
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion,
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
  })

  it('returns without spawning when the daemon is already running', async () => {
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true)

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).not.toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith(
      'Ensuring Happy background service is running & matches our version...',
    )
  })

  it('starts the daemon when the installed version is not running', async () => {
    const mockUnref = vi.fn()
    mocks.mockIsDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false)
    mocks.mockSpawnHappyCLI.mockReturnValue({
      unref: mockUnref,
    })

    await ensureDaemonRunning()

    expect(mocks.mockSpawnHappyCLI).toHaveBeenCalledWith(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    expect(mockUnref).toHaveBeenCalled()
    expect(mocks.mockLoggerDebug).toHaveBeenCalledWith('Starting Happy background service...')
  })
})
