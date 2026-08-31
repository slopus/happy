import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockClearDaemonState: vi.fn(),
  mockReadDaemonState: vi.fn(),
  mockLoggerDebug: vi.fn(),
}))

vi.mock('@/persistence', () => ({
  clearDaemonState: mocks.mockClearDaemonState,
  readDaemonState: mocks.mockReadDaemonState,
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
  },
}))

vi.mock('@/configuration', () => ({
  configuration: {
    currentCliVersion: '1.2.2',
  },
}))

import { checkIfDaemonRunningAndCleanupStaleState } from './controlClient'

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockReadDaemonState.mockResolvedValue({
      pid: 1234,
      httpPort: 4321,
      startTime: 'now',
      startedWithCliVersion: '1.2.2',
    })
    mocks.mockClearDaemonState.mockResolvedValue(undefined)
    vi.spyOn(process, 'kill').mockReturnValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps a live daemon owner after one transient control timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError))

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
  })

  it('clears stale state when a live PID is not accepting daemon connections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)
    expect(mocks.mockClearDaemonState).toHaveBeenCalledWith(1234)
  })
})
