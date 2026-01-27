import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()

vi.mock('@/backends/claude/sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {},
}))

// RED: current implementation waits for the session file to exist (up to 10s)
// which can block sessionId propagation and switching. We should not call this.
vi.mock('@/integrations/watcher/awaitFileExist', () => ({
  awaitFileExist: vi.fn(() => {
    throw new Error('awaitFileExist should not be called')
  }),
}))


vi.mock('./utils/claudeCheckSession', () => ({
  claudeCheckSession: vi.fn(() => false),
}))

vi.mock('./utils/claudeFindLastSession', () => ({
  claudeFindLastSession: vi.fn(() => 'last-session-id'),
}))

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}))

describe('claudeRemote', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('keeps resume sessionId even if claudeCheckSession returns false (avoid false-negative context loss)', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'result' } as any
      })(),
    )

    const { claudeRemote } = await import('./claudeRemote')

    const onSessionFound = vi.fn()
    const onReady = vi.fn()
    const onMessage = vi.fn()
    const canCallTool = vi.fn()

    const nextMessage = vi.fn(async () => ({ message: 'hello', mode: { permissionMode: 'default' } as any }))

    await claudeRemote({
      sessionId: 'sess_should_resume',
      transcriptPath: null,
      path: '/tmp',
      allowedTools: [],
      mcpServers: {},
      hookSettingsPath: '/tmp/hooks.json',
      canCallTool,
      isAborted: () => false,
      nextMessage,
      onReady,
      onSessionFound,
      onMessage,
    } as any)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const call = mockQuery.mock.calls[0]?.[0]
    expect(call?.options?.resume).toBe('sess_should_resume')
  })

  it('honors --continue in remote mode by passing continue=true to the SDK', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'result' } as any
      })(),
    )

    const { claudeRemote } = await import('./claudeRemote')

    const nextMessage = vi.fn(async () => ({ message: 'hello', mode: { permissionMode: 'default' } as any }))

    await claudeRemote({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      allowedTools: [],
      mcpServers: {},
      hookSettingsPath: '/tmp/hooks.json',
      claudeArgs: ['--continue'],
      canCallTool: vi.fn(),
      isAborted: () => false,
      nextMessage,
      onReady: vi.fn(),
      onSessionFound: vi.fn(),
      onMessage: vi.fn(),
    } as any)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const call = mockQuery.mock.calls[0]?.[0]
    expect(call?.options?.continue).toBe(true)
  })

  it('treats --resume (no id) as resume-last-session in remote mode', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'result' } as any
      })(),
    )

    const { claudeRemote } = await import('./claudeRemote')

    const nextMessage = vi.fn(async () => ({ message: 'hello', mode: { permissionMode: 'default' } as any }))

    await claudeRemote({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      allowedTools: [],
      mcpServers: {},
      hookSettingsPath: '/tmp/hooks.json',
      claudeArgs: ['--resume'],
      canCallTool: vi.fn(),
      isAborted: () => false,
      nextMessage,
      onReady: vi.fn(),
      onSessionFound: vi.fn(),
      onMessage: vi.fn(),
    } as any)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const call = mockQuery.mock.calls[0]?.[0]
    expect(call?.options?.resume).toBe('last-session-id')
  })

  it('calls onSessionFound from system init without waiting for transcript file', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sess_1' } as any
        yield { type: 'result' } as any
      })(),
    )

    const { claudeRemote } = await import('./claudeRemote')

    const onSessionFound = vi.fn()
    const onReady = vi.fn()
    const onMessage = vi.fn()
    const canCallTool = vi.fn()

    let nextCount = 0
    const nextMessage = vi.fn(async () => {
      nextCount++
      if (nextCount === 1) {
        return { message: 'hello', mode: { permissionMode: 'default' } as any }
      }
      return null
    })

    await claudeRemote({
      sessionId: null,
      transcriptPath: null,
      path: '/tmp',
      allowedTools: [],
      mcpServers: {},
      hookSettingsPath: '/tmp/hooks.json',
      canCallTool,
      isAborted: () => false,
      nextMessage,
      onReady,
      onSessionFound,
      onMessage,
    } as any)

    expect(onSessionFound).toHaveBeenCalledWith('sess_1')
  })
})
