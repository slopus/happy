import { describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'

const mockClaudeLocalLauncher = vi.fn()
vi.mock('./claudeLocalLauncher', () => ({
  claudeLocalLauncher: mockClaudeLocalLauncher,
}))

const mockClaudeRemoteLauncher = vi.fn()
vi.mock('./claudeRemoteLauncher', () => ({
  claudeRemoteLauncher: mockClaudeRemoteLauncher,
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
    logFilePath: '/tmp/happy-cli-test.log',
  },
}))

describe('loop', () => {
  it('updates Session.mode so keepAlive reports correct mode', async () => {
    mockClaudeLocalLauncher.mockResolvedValueOnce('switch')
    mockClaudeRemoteLauncher.mockResolvedValueOnce('exit')

    const keepAlive = vi.fn()
    const client = {
      keepAlive,
      updateMetadata: vi.fn(),
    } as any

    const messageQueue = new MessageQueue2<any>(() => 'mode')

    const { loop } = await import('./loop')

    let capturedSession: any = null
    await loop({
      path: '/tmp',
      onModeChange: () => {},
      mcpServers: {},
      session: client,
      api: {} as any,
      messageQueue,
      hookSettingsPath: '/tmp/hooks.json',
      onSessionReady: (s: any) => {
        capturedSession = s
      },
    } as any)

    expect(keepAlive.mock.calls.some((call) => call[1] === 'remote')).toBe(true)
    capturedSession?.cleanup()
  })
})
