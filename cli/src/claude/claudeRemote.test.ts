import { describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()

vi.mock('@/claude/sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {},
}))

// RED: current implementation waits for the session file to exist (up to 10s)
// which can block sessionId propagation and switching. We should not call this.
vi.mock('@/modules/watcher/awaitFileExist', () => ({
  awaitFileExist: vi.fn(() => {
    throw new Error('awaitFileExist should not be called')
  }),
}))

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}))

describe('claudeRemote', () => {
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

