import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  runAcp: vi.fn(),
  order: [] as string[],
}))

// Exercise the real CLI dispatch for `happy acp`, but never start a daemon or an agent.
vi.mock('@/claude/runClaude', () => ({}))
vi.mock('@/codex/runCodex', () => ({}))
vi.mock('./ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'token' } }) }))
vi.mock('./daemon/ensureDaemonRunning', () => ({ ensureDaemonRunning: async () => undefined }))
vi.mock('@/agent/acp', async () => {
  const actual = await vi.importActual<typeof import('@/agent/acp')>('@/agent/acp')
  return { ...actual, runAcp: mocks.runAcp }
})

const originalArgv = process.argv
let testDirectory: string
beforeEach(() => {
  vi.resetModules()
  mocks.order.length = 0
  testDirectory = mkdtempSync(join(tmpdir(), 'happy-acp-exit-'))
  vi.stubEnv('HAPPY_HOME_DIR', join(testDirectory, 'home'))
  mocks.runAcp.mockImplementation(async () => { mocks.order.push('runAcp-finished') })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { mocks.order.push(`exit ${code}`) }) as never)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(testDirectory, { recursive: true, force: true })
})

it('leaves the process as soon as an ACP runner has closed its session', async () => {
  process.argv = ['node', 'happy', 'acp', 'opencode']
  await import('./main')
  await vi.waitFor(() => expect(mocks.order).toContain('exit 0'))
  expect(mocks.order).toEqual(['runAcp-finished', 'exit 0'])
  expect(mocks.runAcp).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'opencode' }))
})
