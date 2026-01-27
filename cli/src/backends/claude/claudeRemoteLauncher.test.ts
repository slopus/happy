import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { Session } from './session'

const mockClaudeRemote = vi.fn()
vi.mock('./claudeRemote', () => ({
  claudeRemote: mockClaudeRemote,
}))

const mockResetParentChain = vi.fn()
const mockUpdateSessionId = vi.fn()
vi.mock('./utils/sdkToLogConverter', () => ({
  SDKToLogConverter: vi.fn().mockImplementation(() => ({
    resetParentChain: mockResetParentChain,
    updateSessionId: mockUpdateSessionId,
    convert: () => null,
    convertSidechainUserMessage: () => null,
    generateInterruptedToolResult: () => null,
  })),
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

  it('does not double-reset parent chain when sessionId changes during a remote run', async () => {
    const handlersByMethod: Record<string, any[]> = {}

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
      sendSessionEvent: vi.fn(),
    } as any

    const api = {
      push: () => ({ sendToAllDevices: vi.fn() }),
    } as any

    const session = new Session({
      api,
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_0',
      mcpServers: {},
      messageQueue: new MessageQueue2<any>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
    })

    mockClaudeRemote
      .mockImplementationOnce(async (opts: any) => {
        // Session changes while the remote run is active (system init / hook)
        opts.onSessionFound?.('sess_1')
      })
      .mockImplementationOnce(async (opts: any) => {
        // Block until aborted by a switch call.
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

    // Ensure we entered the 2nd iteration (where the regression happens).
    while (mockClaudeRemote.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // Trigger exit from the 2nd remote run
    const switchHandler = handlersByMethod.switch[0]
    expect(await switchHandler({ to: 'local' })).toBe(true)

    await expect(launcherPromise).resolves.toBe('switch')

    expect(mockClaudeRemote).toHaveBeenCalledTimes(2)

    // First iteration is a new session (sess_0 vs null) → one reset.
    // SessionId changes during the run (sess_1) should NOT cause a second reset on the next loop iteration.
    expect(mockResetParentChain).toHaveBeenCalledTimes(1)

    session.cleanup()
  }, 10_000)

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

  it('treats null sessionId as a new session boundary', async () => {
    const handlersByMethod: Record<string, any[]> = {}

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
      sendSessionEvent: vi.fn(),
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
      onModeChange: () => { },
      hookSettingsPath: '/tmp/hooks.json',
    })

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
    expect(await switchHandler({ to: 'local' })).toBe(true)
    await expect(launcherPromise).resolves.toBe('switch')

    expect(mockResetParentChain).toHaveBeenCalledTimes(1)

    session.cleanup()
  })
})
