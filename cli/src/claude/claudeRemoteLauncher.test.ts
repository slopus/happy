import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { Session } from './session'

const mockClaudeRemote = vi.fn()
vi.mock('./claudeRemote', () => ({
  claudeRemote: mockClaudeRemote,
}))

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}))

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('claudeRemoteLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('respects switch RPC params and is idempotent', async () => {
    const handlersByMethod: Record<string, any[]> = {}
    const sendSessionEvent = vi.fn()

    const client = {
      sessionId: 'happy_sess_1',
      keepAlive: vi.fn(),
      updateMetadata: vi.fn(),
      updateAgentState: vi.fn((updater: any) => updater({})),
      rpcHandlerManager: {
        registerHandler: vi.fn((method: string, handler: any) => {
          handlersByMethod[method] = handlersByMethod[method] || []
          handlersByMethod[method].push(handler)
        }),
      },
      sendClaudeSessionMessage: vi.fn(),
      sendSessionEvent,
    } as any

    const api = {
      push: () => ({ sendToAllDevices: vi.fn() }),
    } as any

    const session = new Session({
      api,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    })

    session.onSessionFound('sess_1', { transcript_path: '/tmp/sess_1.jsonl' } as any)

    mockClaudeRemote.mockImplementationOnce(async (opts: any) => {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve()
        opts.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    })

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher')

    const launcherPromise = claudeRemoteLauncher(session)

    while (!handlersByMethod.switch?.length) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const switchHandler = handlersByMethod.switch[0]

    // Already remote; should be a no-op
    expect(await switchHandler({ to: 'remote' })).toBe(false)

    // Switch to local should abort and exit remote launcher
    expect(await switchHandler({ to: 'local' })).toBe(true)
    await expect(launcherPromise).resolves.toBe('switch')

    session.cleanup()
  })
})

