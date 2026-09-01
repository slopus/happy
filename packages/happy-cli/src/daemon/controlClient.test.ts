import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockClearDaemonState: vi.fn(),
  mockReadDaemonState: vi.fn(),
  mockLoggerDebug: vi.fn(),
  mockLoggerWarn: vi.fn(),
}))

vi.mock('@/persistence', () => ({
  clearDaemonState: mocks.mockClearDaemonState,
  readDaemonState: mocks.mockReadDaemonState,
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.mockLoggerDebug,
    warn: mocks.mockLoggerWarn,
  },
}))

vi.mock('@/configuration', () => ({
  configuration: {
    currentCliVersion: '1.2.2',
  },
}))

import { checkIfDaemonRunningAndCleanupStaleState, stopDaemon } from './controlClient'

describe('checkIfDaemonRunningAndCleanupStaleState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockReadDaemonState.mockResolvedValue({
      pid: 1234,
      httpPort: 4321,
      startTime: 'now',
      startedWithCliVersion: '1.2.2',
      ownerToken: 'generation-current',
    })
    mocks.mockClearDaemonState.mockResolvedValue(undefined)
    vi.spyOn(process, 'kill').mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps a live daemon owner after one transient control timeout', async () => {
    const timeoutError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutError))

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
  })

  it('preserves ownership when the PID probe is denied', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(process.kill).mockImplementation(() => {
      const error = new Error('operation not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cleans generation-scoped state only when the PID is definitely absent', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      const error = new Error('no such process') as NodeJS.ErrnoException
      error.code = 'ESRCH'
      throw error
    })

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false)
    expect(mocks.mockClearDaemonState).toHaveBeenCalledWith({
      pid: 1234,
      httpPort: 4321,
      startTime: 'now',
      startedWithCliVersion: '1.2.2',
      ownerToken: 'generation-current',
    })
  })

  it('preserves ownership when a live PID has a transient connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
  })

  it('preserves ownership after one non-success control response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))

    await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(true)
    expect(mocks.mockClearDaemonState).not.toHaveBeenCalled()
  })

  it('does not force kill a PID when graceful stop cannot be verified', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new TypeError('stop endpoint unavailable')))

    const stopPromise = stopDaemon()
    await vi.advanceTimersByTimeAsync(2100)
    await stopPromise

    expect(process.kill).not.toHaveBeenCalledWith(1234, 'SIGKILL')
  })

  it('binds a replacement stop to the generation whose version was checked', async () => {
    vi.useFakeTimers()
    const observedGeneration = {
      pid: 1111,
      httpPort: 4111,
      startTime: 'old',
      startedWithCliVersion: '1.0.0',
      ownerToken: 'generation-g',
    }
    mocks.mockReadDaemonState.mockResolvedValue({
      pid: 2222,
      httpPort: 4222,
      startTime: 'successor',
      startedWithCliVersion: '1.2.2',
      ownerToken: 'generation-h',
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ status: 'stopping' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const stopPromise = (stopDaemon as any)(observedGeneration)
    await vi.advanceTimersByTimeAsync(2100)
    await stopPromise

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4111/stop',
      expect.objectContaining({ body: JSON.stringify({ expectedOwnerToken: 'generation-g' }) }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:4222/stop',
      expect.anything(),
    )
  })

  it('gracefully stops a live legacy owner after stable HTTP identity evidence', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ children: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: 'stopping' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const legacyState = {
      pid: 1111,
      httpPort: 4111,
      startTime: 'legacy',
      startedWithCliVersion: '1.0.0',
    }
    mocks.mockReadDaemonState.mockResolvedValue(legacyState)

    const stopPromise = stopDaemon(legacyState)
    await vi.advanceTimersByTimeAsync(2100)
    await stopPromise

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4111/list', expect.anything())
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4111/stop', expect.objectContaining({
      body: JSON.stringify({}),
    }))
    expect(process.kill).not.toHaveBeenCalledWith(1111, 'SIGKILL')
  })

  it('refuses a legacy stop when the fixed snapshot changes before the request', async () => {
    const legacyState = {
      pid: 1111,
      httpPort: 4111,
      startTime: 'legacy',
      startedWithCliVersion: '1.0.0',
    }
    mocks.mockReadDaemonState.mockResolvedValue({ ...legacyState, pid: 2222 })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await stopDaemon(legacyState)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(process.kill).not.toHaveBeenCalledWith(1111, 'SIGKILL')
  })

  it('refuses a legacy stop when a 2xx response has the wrong list shape', async () => {
    const legacyState = {
      pid: 1111,
      httpPort: 4111,
      startTime: 'legacy',
      startedWithCliVersion: '1.0.0',
    }
    mocks.mockReadDaemonState.mockResolvedValue(legacyState)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    })
    vi.stubGlobal('fetch', fetchMock)

    await stopDaemon(legacyState)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4111/list', expect.anything())
    expect(process.kill).not.toHaveBeenCalledWith(1111, 'SIGKILL')
  })
})
