import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  startDaemon: vi.fn(),
}))

// Exercise the real CLI dispatch, configuration bootstrap and settings I/O,
// but never contact, start or stop an operating daemon or provider.
vi.mock('@/claude/runClaude', () => ({}))
vi.mock('@/codex/runCodex', () => ({}))
vi.mock('@/ui/auth', () => ({}))
vi.mock('@/daemon/run', () => ({ startDaemon: mocks.startDaemon }))
vi.mock('@/daemon/controlClient', () => ({
  checkIfDaemonRunningAndCleanupStaleState: async () => true,
}))
vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: mocks.spawn,
  captureSpawnOutputStdio: () => 'ignore',
}))

describe('daemon MCP config CLI startup', () => {
  const originalArgv = process.argv
  let testDirectory: string
  let happyHome: string

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    testDirectory = mkdtempSync(join(tmpdir(), 'happy-daemon-config-startup-'))
    happyHome = join(testDirectory, 'pristine-home')
    vi.stubEnv('HAPPY_HOME_DIR', happyHome)
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', undefined)
    vi.stubEnv('HAPPY_APLUS_MCP_CALLER_GRANT', 'session-grant')
    vi.stubEnv('HAPPY_APLUS_CAPABILITY_TOKEN', 'session-capability')
    mocks.spawn.mockReturnValue({ unref: vi.fn(), once: vi.fn() }) // daemon start listens for the start-sync exit
    mocks.startDaemon.mockImplementation(async () => undefined)
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.argv = originalArgv
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.resetModules()
    rmSync(testDirectory, { recursive: true, force: true })
  })

  async function runCommand(...args: string[]) {
    process.argv = ['node', 'happy', 'daemon', ...args]
    vi.mocked(process.exit).mockClear()
    vi.resetModules()
    await import('./main')
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0))
  }

  function readPersistedSettings() {
    return JSON.parse(readFileSync(join(happyHome, 'settings.json'), 'utf8'))
  }

  it('bootstraps a pristine home, persists a preset and restores it on a later detached start', async () => {
    expect(existsSync(happyHome)).toBe(false)

    await runCommand('start', 'saycode')

    const endpoint = 'https://saycode.ai/api/me/mcp-config'
    expect(readPersistedSettings()).toEqual({
      schemaVersion: 2, onboardingCompleted: false, aplusMcpConfigUrl: endpoint,
    })
    expect(mocks.spawn).toHaveBeenCalledWith(['daemon', 'start-sync'], expect.objectContaining({
      detached: true, env: expect.objectContaining({ HAPPY_APLUS_MCP_CONFIG_URL: endpoint }),
    }))
    expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBeUndefined()
    expect(existsSync(join(happyHome, 'settings.json.lock'))).toBe(false)

    mocks.spawn.mockClear()
    await runCommand('start')

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(endpoint)
  })

  it('prefers and persists the explicit endpoint over a preset without persisting session secrets', async () => {
    const endpoint = 'https://explicit.example/custom/mcp-config'
    const sessionUrl = `${endpoint}?project_id=session&capability_token=query-secret#fragment-secret`
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', sessionUrl)

    await runCommand('start', 'saycode')

    expect(readPersistedSettings()).toEqual({
      schemaVersion: 2, onboardingCompleted: false, aplusMcpConfigUrl: endpoint,
    })
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(endpoint)
    expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(sessionUrl)
  })

  it('restores the endpoint into process.env before invoking startDaemon', async () => {
    // Configuration must run first, just as the actual CLI imports it.
    await import('./configuration')
    const endpoint = 'http://localhost:5174/api/me/mcp-config'
    writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({
      schemaVersion: 2, onboardingCompleted: true, aplusMcpConfigUrl: endpoint,
    }))
    mocks.startDaemon.mockImplementation(async () => {
      expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(endpoint)
    })

    await runCommand('start-sync')

    expect(mocks.startDaemon).toHaveBeenCalledTimes(1)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('normalizes and persists a direct start-sync URL before daemon startup', async () => {
    const endpoint = 'https://studio.example/api/me/mcp-config'
    vi.stubEnv('HAPPY_APLUS_MCP_CONFIG_URL', `${endpoint}?projectId=session&token=secret#private`)
    mocks.startDaemon.mockImplementation(async () => {
      expect(process.env.HAPPY_APLUS_MCP_CONFIG_URL).toBe(endpoint)
      expect(readPersistedSettings()).toEqual({
        schemaVersion: 2, onboardingCompleted: false, aplusMcpConfigUrl: endpoint,
      })
    })

    await runCommand('start-sync')

    expect(mocks.startDaemon).toHaveBeenCalledTimes(1)
  })

  it('leaves an unconfigured Happy daemon without an inferred endpoint or settings write', async () => {
    await runCommand('start')

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_APLUS_MCP_CONFIG_URL).toBeUndefined()
    expect(existsSync(join(happyHome, 'settings.json'))).toBe(false)
  })
})
