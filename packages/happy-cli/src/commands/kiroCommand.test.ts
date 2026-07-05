import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuthAndSetupMachineIfNeeded: vi.fn(),
  mockEnsureDaemonRunning: vi.fn(),
  mockRunAcp: vi.fn(),
}))

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.mockAuthAndSetupMachineIfNeeded,
}))

vi.mock('@/daemon/ensureDaemonRunning', () => ({
  ensureDaemonRunning: mocks.mockEnsureDaemonRunning,
}))

vi.mock('@/agent/acp', () => ({
  runAcp: mocks.mockRunAcp,
}))

import { handleKiroCommand, parseKiroCommandArgs } from './kiroCommand'

describe('parseKiroCommandArgs', () => {
  it('maps Happy wrapper flags to Kiro ACP args', () => {
    expect(parseKiroCommandArgs([
      '--started-by', 'daemon',
      '--happy-starting-mode', 'remote',
      '--model', 'sonnet',
      '--effort', 'high',
      '--permission-mode', 'yolo',
    ])).toEqual({
      startedBy: 'daemon',
      compatAgent: undefined,
      verbose: false,
      backendArgs: ['--model', 'sonnet', '--effort', 'high', '--trust-all-tools'],
    })
  })

  it('passes Kiro-specific trust flags through', () => {
    expect(parseKiroCommandArgs([
      '--verbose',
      '--trust-tools', 'read_file,edit_file',
      '--agent-engine', 'v3',
      '--agent', 'builder',
    ])).toEqual({
      startedBy: undefined,
      compatAgent: undefined,
      verbose: true,
      backendArgs: ['--trust-tools', 'read_file,edit_file', '--agent-engine', 'v3', '--agent', 'builder'],
    })
  })

  it('omits default model values so Kiro can use its own default', () => {
    expect(parseKiroCommandArgs(['--model', 'default', '--effort', 'default'])).toEqual({
      startedBy: undefined,
      compatAgent: undefined,
      verbose: false,
      backendArgs: [],
    })
  })

  it('captures the hidden Claude compatibility flag without passing it to Kiro', () => {
    expect(parseKiroCommandArgs(['--compat-agent', 'claude', '--permission-mode', 'bypassPermissions'])).toEqual({
      startedBy: undefined,
      compatAgent: 'claude',
      verbose: false,
      backendArgs: ['--trust-all-tools'],
    })
  })
})

describe('handleKiroCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockAuthAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token' },
    })
    mocks.mockEnsureDaemonRunning.mockResolvedValue(undefined)
    mocks.mockRunAcp.mockResolvedValue(undefined)
  })

  it('ensures the daemon and starts Kiro through ACP', async () => {
    await handleKiroCommand(['--started-by', 'terminal', '--yolo'])

    expect(mocks.mockEnsureDaemonRunning).toHaveBeenCalledTimes(1)
    expect(mocks.mockRunAcp).toHaveBeenCalledWith({
      credentials: { token: 'token' },
      startedBy: 'terminal',
      verbose: false,
      sessionFlavor: undefined,
      compatAgent: undefined,
      agentName: 'kiro',
      command: 'kiro-cli',
      args: ['acp', '--trust-all-tools'],
      keepSessionAliveAfterCancel: true,
    })
    expect(
      mocks.mockEnsureDaemonRunning.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.mockRunAcp.mock.invocationCallOrder[0])
  })

  it('starts Kiro with Claude-compatible session metadata when requested by the daemon', async () => {
    await handleKiroCommand(['--started-by', 'daemon', '--compat-agent', 'claude'])

    expect(mocks.mockRunAcp).toHaveBeenCalledWith(expect.objectContaining({
      startedBy: 'daemon',
      sessionFlavor: 'claude',
      compatAgent: 'claude',
      agentName: 'kiro',
      command: 'kiro-cli',
      args: ['acp'],
    }))
  })
})
