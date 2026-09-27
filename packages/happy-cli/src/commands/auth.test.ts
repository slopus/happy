import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readDaemonStateSnapshot: vi.fn(),
  clearCredentials: vi.fn(async () => {}),
  clearMachineId: vi.fn(async () => {}),
  authAndSetupMachineIfNeeded: vi.fn(async () => ({ machineId: 'machine' })),
}))

vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  readCredentials: async () => ({ token: 'token' }),
  readDaemonStateSnapshot: mocks.readDaemonStateSnapshot,
  readDaemonState: async () => (await mocks.readDaemonStateSnapshot()).state,
  clearDaemonState: vi.fn(),
  writeDaemonStateIfUnchanged: vi.fn(() => true),
  clearCredentials: mocks.clearCredentials,
  clearMachineId: mocks.clearMachineId,
}))
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: mocks.authAndSetupMachineIfNeeded }))
vi.mock('node:readline', () => ({
  createInterface: () => ({ question: (_: string, answer: (value: string) => void) => answer('y'), close: () => {} }),
}))

import { configuration } from '@/configuration'
import { handleAuthCommand } from './auth'

describe('auth commands when the daemon refuses to stop', () => {
  let happyDir: string
  let originalHappyDir: string
  let kill: { mock: { calls: unknown[][] } }
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    happyDir = mkdtempSync(join(tmpdir(), 'happy-auth-refused-'))
    writeFileSync(join(happyDir, 'daemon.state.json'), '{}')
    originalHappyDir = configuration.happyHomeDir
    Object.defineProperty(configuration, 'happyHomeDir', { value: happyDir, configurable: true })
    const state = { pid: process.pid, httpPort: 33417, startTime: 'now', startedWithCliVersion: 'test',
      daemonLogPath: '/tmp/daemon.log', state: 'running', trackedSessions: [] }
    mocks.readDaemonStateSnapshot.mockResolvedValue({ state, raw: JSON.stringify(state) })
    kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    // A standalone trial daemon answers /stop with 409 drain-required.
    fetchSpy = vi.fn(async () => ({ ok: false, status: 409 }) as Response)
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(configuration, 'happyHomeDir', { value: originalHappyDir, configurable: true })
    rmSync(happyDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('logout keeps the happy home directory under a daemon that is still running', async () => {
    await expect(handleAuthCommand(['logout'])).rejects.toThrow('refused to stop')
    expect(existsSync(join(happyDir, 'daemon.state.json'))).toBe(true)
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('login --force keeps credentials and machine id under a daemon that is still running', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    await expect(handleAuthCommand(['login', '--force'])).rejects.toThrow('exit 1')
    expect(exit).toHaveBeenCalledWith(1)
    expect(mocks.clearCredentials).not.toHaveBeenCalled()
    expect(mocks.clearMachineId).not.toHaveBeenCalled()
    expect(mocks.authAndSetupMachineIfNeeded).not.toHaveBeenCalled()
  })
})
