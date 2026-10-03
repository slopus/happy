import { mkdtemp, readFile as readTestFile, rm as removeTestDirectory } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  AiCredentialRuntimeError,
  createAiCredentialRuntime,
  runAiCredentialCommand,
  selectLeastRemainingCodexAccounts,
  withUvToolBinOnPath,
  type AiCredentialCommandResult,
  type AiCredentialRuntimeDependencies,
} from './aiCredentialRuntime'

const configuredClaudeList = JSON.stringify({
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [{ number: 1, email: 'owner@example.com', active: true }],
})

function claudeOauthPayload(
  accounts: Array<{ email: string; organizationUuid?: string; organizationName?: string }>,
): string {
  return JSON.stringify({
    version: 1,
    encrypted: false,
    activeAccountNumber: 1,
    accounts: accounts.map((account, index) => ({
      number: index + 1,
      email: account.email,
      organizationUuid: account.organizationUuid ?? '',
      organizationName: account.organizationName ?? '',
      credentials: { claudeAiOauth: { accessToken: `oauth-${index + 1}` } },
      config: { oauthAccount: { emailAddress: account.email } },
    })),
  })
}

function codexMultiAuthBundle() {
  return {
    version: 1,
    kind: 'codex-multi-auth',
    packageVersion: '2.16.0',
    accounts: {
      version: 3,
      activeIndex: 0,
      accounts: [
        { accountId: 'account-a', email: 'alpha@example.com', refreshToken: 'refresh-a', accessToken: 'access-a', addedAt: 1, lastUsed: 1 },
        { accountId: 'account-b', email: 'beta@example.com', refreshToken: 'refresh-b', accessToken: 'access-b', addedAt: 2, lastUsed: 2 },
        { accountId: 'account-c', email: 'gamma@example.com', refreshToken: 'refresh-c', accessToken: 'access-c', addedAt: 3, lastUsed: 3 },
      ],
    },
    settings: { version: 1, pluginConfig: {} },
  }
}

function setup(
  overrides: Partial<AiCredentialRuntimeDependencies> & { now?: () => number } = {},
) {
  const calls: Array<{ command: string; args: string[] }> = []
  const files = new Map<string, string>()
  files.set('/global/node_modules/codex-multi-auth/package.json', JSON.stringify({ version: '2.16.0' }))
  const execFile = vi.fn(async (
    command: string,
    args: string[],
    _options?: {
      maxOutputBytes?: number
      timeoutMs?: number
      acceptNonZeroExit?: boolean
      environment?: NodeJS.ProcessEnv
    },
  ): Promise<AiCredentialCommandResult> => {
    calls.push({ command, args })
    if (command === 'cswap' && args[0] === 'export') {
      return { stdout: '{"version":1,"encrypted":false,"accounts":[{}]}', stderr: '' }
    }
    if (command === 'cswap' && args[0] === '--version') {
      return { stdout: 'claude-swap 0.25.0', stderr: '' }
    }
    if (command === 'cswap' && args[0] === 'list') {
      return {
        stdout: configuredClaudeList,
        stderr: '',
      }
    }
    if (command === 'codex-multi-auth' && args[0] === '--version') {
      return { stdout: '2.16.0\n', stderr: '' }
    }
    if (command === 'claude' && args[0] === '--print') {
      return { stdout: JSON.stringify({ result: 'CLAUDE_AUTH_OK' }), stderr: '' }
    }
    if (command === 'npm' && args[0] === 'root') {
      return { stdout: '/global/node_modules\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  const supervisor = {
    enable: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })),
  }
  const writeFile = vi.fn(async (path: string, content: string) => { files.set(path, content) })
  const runtime = createAiCredentialRuntime({
    homeDir: '/home/operator',
    now: () => 0,
    env: {},
    execFile,
    readFile: vi.fn(async (path: string) => files.get(path) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))),
    writeFile,
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async (from: string, to: string) => {
      const value = files.get(from)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      files.set(to, value)
      files.delete(from)
    }),
    chmod: vi.fn(async () => undefined),
    rm: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
      for (const filePath of files.keys()) {
        if (filePath === path || (options?.recursive && filePath.startsWith(`${path}/`))) {
          files.delete(filePath)
        }
      }
    }),
    makeTempDir: vi.fn(async () => '/tmp/happy-ai-credential-fixed'),
    supervisor,
    ...overrides,
  })
  return { runtime, calls, files, supervisor, writeFile, execFile }
}

describe('AI credential machine runtime', () => {
  it.each([
    ['ok', 'usage-readable', 1, 1],
    ['relogin_required', 'relogin-required', 0, 2],
    [undefined, 'unknown', 0, 1],
  ] as const)('returns active status and per-account relogin counts for %s without changing credentials', async (usageStatus, activeAccountStatus, usableAccountCount, reloginRequiredAccountCount) => {
    const { runtime, execFile, calls, supervisor } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'cswap' && args[0] === 'list'
      ? { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [
        { number: 1, email: 'shared@example.com', usageStatus },
        { number: 2, email: 'dead@example.com', usageStatus: 'relogin_required' },
      ] }), stderr: '' } : original(command, args, options))
    const result = await runtime.apply({ provider: 'claude', applyMode: 'merge', payload: claudeOauthPayload([{ email: 'shared@example.com' }, { email: 'dead@example.com' }]) })
    expect(result).toMatchObject({ activeAccountStatus, usableAccountCount, reloginRequiredAccountCount, accountCount: 2 })
    expect(await runtime.status({ provider: 'claude' })).toMatchObject({ activeAccountStatus, usableAccountCount, reloginRequiredAccountCount })
    expect(calls.some(call => call.command === 'cswap' && ['import', 'switch', 'remove', 'config'].includes(call.args[0]!))).toBe(false)
    expect(supervisor.enable).not.toHaveBeenCalled()
    expect(supervisor.stop).not.toHaveBeenCalled()
  })

  it.each([null, 1] as const)('does not claim disabled or unselected active credentials are usable (active=%s)', async activeAccountNumber => {
    const { runtime, execFile } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'cswap' && args[0] === 'list'
      ? { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber, accounts: [
        { number: 1, email: 'disabled@example.com', usageStatus: 'ok', disabled: true },
        { number: 2, email: 'ready@example.com', usageStatus: 'ok' },
      ] }), stderr: '' } : original(command, args, options))
    expect(await runtime.status({ provider: 'claude' })).toMatchObject({ activeAccountStatus: activeAccountNumber === null ? 'not-selected' : 'disabled', usableAccountCount: 1, reloginRequiredAccountCount: 0 })
  })

  it.each(['claude', 'codex'] as const)('verifies only the active %s account without changing selection', async (provider) => {
    const { runtime, execFile, files, supervisor } = setup()
    const original = execFile.getMockImplementation()!
    const pool = codexMultiAuthBundle().accounts
    pool.activeIndex = 1
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(pool))
    const payload = claudeOauthPayload([{ email: 'inactive@example.com' }, { email: 'active@example.com' }])
    let probes = 0
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 2,
        accounts: [{ number: 1, email: 'inactive@example.com' }, { number: 2, email: 'active@example.com', active: true }] }), stderr: '' }
      if (command === 'cswap' && args[0] === 'export') return { stdout: payload, stderr: '' }
      if (command === provider) {
        probes += 1
        const home = options?.environment?.HOME
        if (provider === 'claude') {
          expect(JSON.parse(files.get(`${home}/.claude/.credentials.json`)!).claudeAiOauth.accessToken).toBe('oauth-2')
          return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
        }
        expect(JSON.parse(files.get(`${home}/.codex/auth.json`)!).account_id).toBe('account-b')
        return { stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SHARED_AI_OK' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }), stderr: '', exitCode: 0 }
      }
      return original(command, args, options)
    })
    const result = await runtime.verify({ provider, scope: 'active' } as never)
    expect(result).toMatchObject({ scope: 'active', activeAccountNumber: 2, accounts: [{ account: 1, ok: true }] })
    expect(probes).toBe(1)
    expect(execFile.mock.calls.some(([, args]) => ['import', 'switch', 'remove'].includes(args[0]!))).toBe(false)
    expect(supervisor.stop).not.toHaveBeenCalled()
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it.each([null, 1])('does not report active verification success when selection is missing or changes to %s', async (after) => {
    const { runtime, execFile } = setup()
    const original = execFile.getMockImplementation()!
    let lists = 0
    let probes = 0
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') {
        lists += 1
        return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: after === null ? null : lists === 1 ? 2 : after,
          accounts: [{ number: 1, email: 'inactive@example.com' }, { number: 2, email: 'active@example.com' }] }), stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'export') return { stdout: claudeOauthPayload([{ email: 'inactive@example.com' }, { email: 'active@example.com' }]), stderr: '' }
      if (command === 'claude') { probes += 1; return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 } }
      return original(command, args, options)
    })
    await expect(runtime.verify({ provider: 'claude', scope: 'active' })).rejects.toMatchObject({
      kind: after === null ? 'ACTIVE_ACCOUNT_NOT_SELECTED' : 'ACTIVE_ACCOUNT_CHANGED',
    })
    expect(probes).toBe(after === null ? 0 : 1)
  })

  it.each([[7, false], [9, false], [7, true]] as const)('repairs matching shared or personal credentials while preserving selected slot %i and enabled rotation %s', async (active, rotating) => {
    const { runtime, files, calls, execFile, supervisor } = setup()
    supervisor.status.mockReturnValue({ state: rotating ? 'running' : 'stopped' as never, lastErrorKind: null })
    supervisor.stop.mockImplementation(async () => { supervisor.status.mockReturnValue({ state: 'stopped' as never, lastErrorKind: null }) })
    supervisor.enable.mockImplementation(async () => { supervisor.status.mockReturnValue({ state: 'running', lastErrorKind: null }) })
    const accounts = [
      { number: 7, email: 'shared@example.com', organizationUuid: 'shared-org', usageStatus: 'relogin_required' },
      { number: 9, email: 'personal@example.com', organizationUuid: 'private-org', usageStatus: 'ok' },
      { number: 10, email: 'disabled@example.com', organizationUuid: '', usageStatus: 'relogin_required', disabled: true },
    ]
    const payload = claudeOauthPayload([
      { email: 'shared@example.com', organizationUuid: 'shared-org' },
      { email: 'disabled@example.com' },
    ])
    let imported = false
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts }), stderr: '' }
      if (command === 'claude') return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
      if (command === 'cswap' && args[0] === 'export') return { stdout: payload, stderr: '' }
      if (command === 'cswap' && args[0] === 'import') {
        const envelope = JSON.parse(files.get(args[1]!)!)
        expect(envelope.accounts.map((a: { email: string }) => a.email)).toEqual(['shared@example.com'])
        expect(args).toContain('--force')
        accounts[0]!.usageStatus = 'ok'
        imported = true
        calls.push({ command, args })
        return { stdout: '', stderr: '' }
      }
      return original(command, args, options)
    })
    const result = await runtime.apply({ provider: 'claude', applyMode: 'repair', payload,
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 } } as never)
    expect(imported).toBe(true)
    expect(result).toMatchObject({ applyMode: 'repair', verification: { accounts: [
      { account: 1, ok: true, model: 'haiku' }, { account: 2, ok: false, errorKind: 'ACCOUNT_DISABLED' },
    ] } })
    expect(accounts[1]).toMatchObject({ number: 9, usageStatus: 'ok' })
    expect(accounts[2]).toMatchObject({ number: 10, disabled: true })
    expect(calls.filter(c => c.args[0] === 'switch')).toEqual(active === 7
      ? [{ command: 'cswap', args: ['switch', '7', '--force', '--json'] }] : [])
    expect(supervisor.stop).toHaveBeenCalledTimes(rotating ? 1 : 0)
    expect(supervisor.enable).toHaveBeenCalledTimes(rotating ? 1 : 0)
    expect(result).toMatchObject({ rotation: { state: rotating ? 'running' : 'stopped' } })
    const provenance = JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!)
    expect(provenance.claude.identities).toEqual([['shared@example.com', 'shared-org', '']])
  })

  it('does not repair the same email under a different organization', async () => {
    const { runtime, execFile } = setup()
    await expect(runtime.apply({ provider: 'claude', applyMode: 'repair',
      payload: claudeOauthPayload([{ email: 'owner@example.com', organizationUuid: 'another-org' }]),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 },
    })).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED' })
    expect(execFile.mock.calls.some(([command, args]) => command === 'claude' || args[0] === 'import' || args[0] === 'switch')).toBe(false)
  })

  it.each(['repair', 'merge'] as const)('rejects %s success if the imported credential fails its installed request and restores rotation', async applyMode => {
    const { runtime, execFile, supervisor, files } = setup()
    const payload = claudeOauthPayload([{ email: 'owner@example.com' }, { email: 'new@example.com' }])
    const original = execFile.getMockImplementation()!
    let requests = 0
    let imported = false
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1,
        accounts: [{ number: 1, email: 'owner@example.com', usageStatus: 'relogin_required' }] }), stderr: '' }
      if (command === 'claude') {
        requests += 1
        const isolated = JSON.parse(files.get(`${options?.environment?.HOME}/.claude/.credentials.json`)!)
        if (isolated.claudeAiOauth.accessToken === 'local-token') {
          requests -= 1
          return { stdout: '', stderr: '401 authentication_error', exitCode: 1 }
        }
        expect(isolated.claudeAiOauth.accessToken).toBe('oauth-1')
        expect(isolated.claudeAiOauth.refreshToken).toBeUndefined()
        return requests === 1 ? { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '401 authentication_error', exitCode: 1 }
      }
      if (command === 'cswap' && args[0] === 'export') return { stdout: imported ? payload : payload.replace('oauth-1', 'local-token'), stderr: '' }
      if (command === 'cswap' && args[0] === 'import') imported = true
      return original(command, args, options)
    })
    await expect(runtime.apply({ provider: 'claude', applyMode, payload,
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 },
    })).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_VERIFICATION_FAILED' })
    expect(requests).toBe(2)
    const imports = execFile.mock.calls.filter(([command, args]) => command === 'cswap' && args[0] === 'import')
    expect(imports).toHaveLength(1)
    expect(imports[0]![1]).toContain('--force')
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.enable).toHaveBeenCalledTimes(1)
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude).toEqual({ state: 'applying', generation: 1 })
  })

  it.each(['healthy', 'disabled', 'selected', 'slot'] as const)('skips automatic repair and adds new identities if destination becomes %s during verification', async change => {
    const { runtime, execFile, supervisor, files } = setup()
    const original = execFile.getMockImplementation()!
    let probed = false
    let added = false
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1,
        activeAccountNumber: probed && change === 'selected' ? 2 : probed && change === 'slot' ? 3 : 1, accounts: [
          { number: probed && change === 'slot' ? 3 : 1, email: 'owner@example.com', usageStatus: probed && change === 'healthy' ? 'ok' : 'relogin_required', disabled: probed && change === 'disabled' },
          { number: 2, email: 'personal@example.com', usageStatus: 'ok' },
          ...(added ? [{ number: 4, email: 'new@example.com', usageStatus: 'ok' }] : []),
        ] }), stderr: '' }
      if (command === 'cswap' && args[0] === 'export') return { stdout: claudeOauthPayload([{ email: 'owner@example.com' }]).replace('oauth-1', 'local-token'), stderr: '' }
      if (command === 'claude') {
        const token = JSON.parse(files.get(`${options?.environment?.HOME}/.claude/.credentials.json`)!).claudeAiOauth.accessToken
        if (token === 'local-token') return { stdout: '', stderr: '401 authentication_error', exitCode: 1 }
        probed = true
        return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
      }
      if (command === 'cswap' && args[0] === 'import') {
        expect(args).not.toContain('--force')
        expect(JSON.parse(files.get(args[1]!)!).accounts.map((a: { email: string }) => a.email)).toEqual(['new@example.com'])
        added = true
      }
      return original(command, args, options)
    })
    const result = await runtime.apply({ provider: 'claude', applyMode: 'merge', payload: claudeOauthPayload([{ email: 'owner@example.com' }, { email: 'new@example.com' }]),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 } })
    expect(result).toMatchObject({ repairedAccountCount: 0, credentialRepairFailedAccountCount: 1, accountCount: 3 })
    expect(probed).toBe(true)
    expect(added).toBe(true)
    expect(execFile.mock.calls.some(([, args]) => args.includes('--force') || args[0] === 'switch')).toBe(false)
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude.identities).toEqual([['new@example.com', '', '']])
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.enable).toHaveBeenCalledTimes(1)
  })

  it('excludes disabled dead credentials from relogin counts on status and merge', async () => {
    const { runtime, execFile } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'cswap' && args[0] === 'list'
      ? { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [
        { number: 1, email: 'owner@example.com', usageStatus: 'ok' },
        { number: 2, email: 'disabled@example.com', usageStatus: 'relogin_required', disabled: true },
      ] }), stderr: '' } : original(command, args, options))
    expect(await runtime.status({ provider: 'claude' })).toMatchObject({ reloginRequiredAccountCount: 0 })
    expect(await runtime.apply({ provider: 'claude', applyMode: 'merge', payload: claudeOauthPayload([{ email: 'disabled@example.com' }]) }))
      .toMatchObject({ reloginRequiredAccountCount: 0, credentialRepairFailedAccountCount: 0 })
    expect(execFile.mock.calls.some(([command, args]) => command === 'claude' || args[0] === 'import')).toBe(false)
  })

  it('does not import rejected repair credentials or claim a newer bundle was applied', async () => {
    const { runtime, files, execFile } = setup()
    const prior = JSON.stringify({ version: 1, claude: { state: 'applied', generation: 1,
      companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 1, identities: [['shared@example.com', '', '']] } })
    files.set('/home/operator/.happy/ai-credential-apply-generations.json', JSON.stringify({ version: 1, generations: { claude: 1 } }))
    files.set('/home/operator/.happy/ai-credential-provenance.json', prior)
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'claude'
      ? { stdout: '', stderr: '401 authentication_error', exitCode: 1 }
      : command === 'cswap' && args[0] === 'list'
        ? { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1, accounts: [{ number: 1, email: 'shared@example.com', usageStatus: 'relogin_required' }] }), stderr: '' }
        : original(command, args, options))
    await expect(runtime.apply({ provider: 'claude', applyMode: 'repair',
      payload: claudeOauthPayload([{ email: 'shared@example.com' }]),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 } } as never)).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED' })
    expect(execFile.mock.calls.some(([, args]) => args[0] === 'import' || args[0] === 'switch')).toBe(false)
    expect(files.get('/home/operator/.happy/ai-credential-provenance.json')).toBe(prior)
  })

  it('verifies only requested local Claude identities without importing, switching or restarting rotation', async () => {
    const { runtime, execFile, supervisor, calls } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'cswap' && args[0] === 'export'
      ? { stdout: claudeOauthPayload([{ email: 'shared@example.com' }]), stderr: '' }
      : command === 'claude' ? { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
      : original(command, args, options))
    const result = await runtime.verify({ provider: 'claude', accounts: [{ email: 'shared@example.com' }] })
    expect(result.accounts).toEqual([{ account: 1, ok: true, model: 'haiku' }])
    expect(supervisor.enable).not.toHaveBeenCalled()
    expect(supervisor.stop).not.toHaveBeenCalled()
    expect(calls.some(call => call.args[0] === 'import' || call.args[0] === 'switch')).toBe(false)
  })

  it('adds Claude accounts, retains personal active/disabled slots and attributes only new shared identities', async () => {
    const { runtime, files, calls, execFile, supervisor } = setup()
    let accounts: Array<Record<string, unknown>> = [
      { number: 7, email: 'personal@example.com', organizationUuid: '', active: true, usageStatus: 'ok' },
      { number: 9, email: 'disabled@example.com', organizationUuid: '', disabled: true, usageStatus: 'relogin_required' },
    ]
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: 7, accounts }), stderr: '' }
      if (command === 'cswap' && args[0] === 'import') {
        calls.push({ command, args })
        const payload = JSON.parse(files.get(args[1]!)!)
        expect(payload.accounts.map((account: { email: string }) => account.email)).toEqual(['shared@example.com'])
        accounts = [...accounts, { number: 10, email: 'shared@example.com', organizationUuid: '', usageStatus: 'ok' }]
        return { stdout: '', stderr: '' }
      }
      return original(command, args, options)
    })
    const input = { provider: 'claude' as const, applyMode: 'merge' as const,
      payload: claudeOauthPayload([{ email: 'shared@example.com' }, { email: 'disabled@example.com' }]),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 1 } }
    await runtime.apply(input)
    await runtime.apply(input)
    expect(accounts).toHaveLength(3)
    expect(accounts[1]).toMatchObject({ number: 9, disabled: true })
    expect(calls.filter(call => call.command === 'cswap' && call.args[0] === 'import')).toHaveLength(1)
    expect(calls.some(call => call.command === 'cswap' && ['remove', 'switch', 'config'].includes(call.args[0]!))).toBe(false)
    expect(supervisor.stop).not.toHaveBeenCalled()
    expect(supervisor.enable).not.toHaveBeenCalled()
    const provenance = JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!)
    expect(provenance.claude.identities).toEqual([['shared@example.com', '', '']])
  })

  it.each([
    ['ok', 'ok', 7, false, false],
    ['auth', 'ok', 7, true, false],
    ['auth', 'ok', 9, true, false],
    ['network', 'ok', 7, false, false],
    ['quota', 'ok', 7, false, false],
    ['timeout', 'ok', 7, false, false],
    ['auth', 'auth', 7, false, false],
    ['auth', 'network', 7, false, false],
    ['auth', 'ok', null, true, false],
    ['changed', 'ok', 7, false, false],
    ['auth', 'ok', 7, true, true],
    ['auth', 'auth', 7, false, true],
  ] as const)('merge keeps or refreshes duplicate credentials for local %s / shared %s with active %i, refreshed %s and new account %s', async (localResult, sharedResult, active, refreshed, withNew) => {
    const { runtime, files, calls, execFile, supervisor } = setup()
    const incoming = JSON.parse(claudeOauthPayload([{ email: 'shared@example.com', organizationUuid: 'company-org' }, ...(withNew ? [{ email: 'new@example.com', organizationUuid: 'company-org' }] : [])]))
    let stored = { ...incoming.accounts[0], number: 7, credentials: { claudeAiOauth: { accessToken: 'local-token' } } }
    const accounts = [
      { number: 7, email: 'shared@example.com', organizationUuid: 'company-org', usageStatus: 'ok' },
      { number: 9, email: 'personal@example.com', organizationUuid: 'private-org', usageStatus: 'ok' },
    ]
    // Source metadata must not disable an enabled local slot or prevent its repair.
    incoming.accounts[0].disabled = true
    const probes: string[] = []
    let activeNumber: number | null = active
    let exports = 0
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: activeNumber, accounts }), stderr: '' }
      if (command === 'cswap' && args[0] === 'export') {
        exports += 1
        if (localResult === 'changed' && exports > 1) stored = { ...stored, credentials: { claudeAiOauth: { accessToken: 'rotated-local' } } }
        return { stdout: JSON.stringify({ version: 1, encrypted: false, accounts: [stored] }), stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'switch') activeNumber = Number(args[1])
      if (command === 'claude') {
        const token = JSON.parse(files.get(`${options?.environment?.HOME}/.claude/.credentials.json`)!).claudeAiOauth.accessToken
        probes.push(token)
        const result = token === 'local-token' ? localResult : sharedResult
        if (result === 'timeout') throw Object.assign(new Error('timeout'), { kind: 'COMMAND_TIMED_OUT' })
        return result === 'ok'
          ? { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: result === 'auth' || result === 'changed' ? 'authentication_error 401' : result === 'quota' ? 'rate_limit 429' : 'network error ECONNRESET', exitCode: 1 }
      }
      if (command === 'cswap' && args[0] === 'import') {
        calls.push({ command, args })
        const imported = JSON.parse(files.get(args[1]!)!).accounts
        expect(imported).toHaveLength(1)
        if (imported[0].email === 'new@example.com') {
          expect(args).not.toContain('--force')
          expect(imported[0].credentials.claudeAiOauth.accessToken).toBe('oauth-2')
          accounts.push({ number: 10, email: 'new@example.com', organizationUuid: 'company-org', usageStatus: 'ok' })
          return { stdout: '', stderr: '' }
        }
        expect(imported[0].credentials.claudeAiOauth.accessToken).toBe('oauth-1')
        expect(args).toContain('--force')
        stored = { ...imported[0], number: 7 }
        return { stdout: '', stderr: '' }
      }
      return original(command, args, options)
    })
    const result = await runtime.apply({ provider: 'claude', applyMode: 'merge', payload: JSON.stringify(incoming),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 } })
    expect(result).toMatchObject({
      repairedAccountCount: refreshed ? 1 : 0,
      credentialRepairFailedAccountCount: !refreshed && (localResult === 'auth' || localResult === 'changed') ? 1 : 0,
    })
    expect(probes).toEqual(localResult === 'auth' || localResult === 'changed'
      ? refreshed ? ['local-token', 'oauth-1', 'oauth-1'] : ['local-token', 'oauth-1']
      : ['local-token'])
    expect(stored.credentials.claudeAiOauth.accessToken).toBe(localResult === 'changed' ? 'rotated-local' : refreshed ? 'oauth-1' : 'local-token')
    expect(calls.filter(call => call.command === 'cswap' && call.args[0] === 'import')).toHaveLength((refreshed ? 1 : 0) + (withNew ? 1 : 0))
    expect(calls.filter(call => call.command === 'cswap' && call.args[0] === 'switch')).toEqual(refreshed && (active === 7 || active === null)
      ? [{ command: 'cswap', args: ['switch', '7', '--force', '--json'] }] : [])
    if (refreshed) expect(stored.disabled).not.toBe(true)
    expect(accounts[1]).toMatchObject({ number: 9, organizationUuid: 'private-org', usageStatus: 'ok' })
    expect(activeNumber).toBe(active ?? 7)
    expect(supervisor.stop).toHaveBeenCalledTimes(refreshed ? 1 : 0)
    expect(supervisor.enable).toHaveBeenCalledTimes(refreshed ? 1 : 0)
    if (refreshed) expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude.identities).toContainEqual(['shared@example.com', 'company-org', ''])
    if (withNew) expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude.identities).toContainEqual(['new@example.com', 'company-org', ''])
  })

  function freshMachineAdding(added: Array<Record<string, unknown>>) {
    const setupResult = setup()
    const state: { active: number | null; accounts: Array<Record<string, unknown>> } = { active: null, accounts: [] }
    const original = setupResult.execFile.getMockImplementation()!
    setupResult.execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: state.active, accounts: state.accounts }), stderr: '' }
      if (command === 'cswap' && args[0] === 'import') state.accounts = added
      if (command === 'cswap' && args[0] === 'switch') state.active = Number(args[1])
      return original(command, args, options)
    })
    const input = { provider: 'claude' as const, applyMode: 'merge' as const,
      payload: claudeOauthPayload(added.map(account => ({ email: String(account.email) }))),
      provenance: { companyId: 'company-1', bundleId: 'bundle-1', bundleVersion: 2 } }
    return { ...setupResult, state, input }
  }

  it('activates a usable shared Claude account on a machine that had none, instead of reporting success without one', async () => {
    // A fresh Windows PC (2026-10-02): seven shared accounts were added, none became active, so Claude Code stayed
    // signed out ("사용 가능한 agent가 없습니다") while the deploy reported configured: true.
    const { runtime, calls, supervisor, state, input } = freshMachineAdding([
      { number: 1, email: 'expired@example.com', organizationUuid: '', usageStatus: 'relogin_required' },
      { number: 2, email: 'shared@example.com', organizationUuid: '', usageStatus: 'ok' },
    ])
    expect(await runtime.apply(input)).toMatchObject({ configured: true })
    expect(state.active).toBe(2)
    expect(calls.filter(call => call.command === 'cswap' && call.args[0] === 'switch').map(call => call.args.slice(0, 2))).toEqual([['switch', '2']])
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('fails an additive Claude apply that leaves a machine without an active account because every account needs re-login', async () => {
    const { runtime, calls, files, state, input } = freshMachineAdding([
      { number: 1, email: 'expired@example.com', organizationUuid: '', usageStatus: 'relogin_required' },
    ])
    await expect(runtime.apply(input)).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED' })
    expect(state.active).toBeNull()
    expect(calls.some(call => call.command === 'cswap' && call.args[0] === 'switch')).toBe(false)
    // The imported slots stay on the machine, so they stay attributed to the organization (a later merge sees them as existing).
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude.identities).toEqual([['expired@example.com', '', '']])
  })

  it('keeps the imported shared Claude slots attributed when the switch to one of them does not take', async () => {
    const { runtime, execFile, files, state, input } = freshMachineAdding([
      { number: 2, email: 'shared@example.com', organizationUuid: '', usageStatus: 'ok' },
    ])
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'cswap' && args[0] === 'switch'
      ? { stdout: '', stderr: '' } // the switch reports nothing and leaves no active account
      : original(command, args, options))
    await expect(runtime.apply(input)).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_VERIFICATION_FAILED' })
    expect(state.active).toBeNull()
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-provenance.json')!).claude.identities).toEqual([['shared@example.com', '', '']])
  })

  it('rolls back both Codex files if an additive write fails without touching live auth', async () => {
    const { runtime, files, writeFile } = setup()
    const path = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
    const settings = '/home/operator/.codex/multi-auth/settings.json'
    const existing = JSON.stringify(codexMultiAuthBundle().accounts)
    files.set(path, existing)
    files.set(settings, 'original-settings')
    files.set('/home/operator/.codex/auth.json', JSON.stringify({ tokens: { account_id: 'account-a', access_token: 'live-access', refresh_token: 'live-refresh' } }))
    // Invalid prior state is rejected before any writes, rather than reset.
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' })).rejects.toThrow()
    expect(files.get(path)).toBe(existing)
    const validSettings = JSON.stringify({ version: 1, pluginConfig: {} })
    files.set(settings, validSettings)
    const originalWrite = writeFile.getMockImplementation()!
    writeFile.mockImplementation(async (target, content) => {
      if (target === `${settings}.happy-tmp`) throw new Error('disk full')
      await originalWrite(target, content)
    })
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' })).rejects.toThrow('CODEX_MULTI_AUTH_APPLY_FAILED')
    expect(files.get(path)).toBe(existing)
    expect(files.get(settings)).toBe(validSettings)
    expect(files.get('/home/operator/.codex/auth.json')).toBe(JSON.stringify({ tokens: { account_id: 'account-a', access_token: 'live-access', refresh_token: 'live-refresh' } }))
  })

  it('merges shared Codex accounts without changing personal credentials, indexes, pin or settings', async () => {
    const { runtime, files, calls } = setup()
    const root = '/home/operator/.codex/multi-auth'
    const personal = { ...codexMultiAuthBundle().accounts.accounts[0], accountId: 'personal', email: 'me@example.com', enabled: false }
    const existing = { version: 3, accounts: [personal], activeIndex: 0, pinnedAccountIndex: 0, activeIndexByFamily: { codex: 0 } }
    const settings = { version: 1, pluginConfig: { custom: true } }
    files.set(`${root}/openai-codex-accounts.json`, JSON.stringify(existing))
    files.set(`${root}/settings.json`, JSON.stringify(settings))
    files.set('/home/operator/.codex/auth.json', JSON.stringify({ tokens: { account_id: personal.accountId, access_token: 'personal-access', refresh_token: personal.refreshToken } }))
    const input = { provider: 'codex' as const, payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' as const }
    await runtime.apply(input)
    await runtime.apply(input)
    const pool = JSON.parse(files.get(`${root}/openai-codex-accounts.json`)!)
    expect(pool.accounts).toHaveLength(4)
    expect(pool.accounts[0]).toEqual(personal)
    expect(pool).toMatchObject({ activeIndex: 0, pinnedAccountIndex: 0, activeIndexByFamily: { codex: 0 } })
    expect(JSON.parse(files.get(`${root}/settings.json`)!)).toEqual(settings)
    expect(files.get('/home/operator/.codex/auth.json')).toBe(JSON.stringify({ tokens: { account_id: personal.accountId, access_token: 'personal-access', refresh_token: personal.refreshToken } }))
    expect(calls.some(call => call.command === 'codex-multi-auth' && ['forecast', 'check', 'switch'].includes(call.args[0]!))).toBe(false)
  })

  it('preserves existing Codex tokens when the same identity is sent again', async () => {
    const { runtime, files } = setup()
    const bundle = codexMultiAuthBundle()
    bundle.accounts.accounts[0]!.refreshToken = 'newer-personal-token'
    const path = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
    files.set(path, JSON.stringify(bundle.accounts))
    await runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' })
    expect(JSON.parse(files.get(path)!).accounts[0].refreshToken).toBe('newer-personal-token')
  })

  it.each(['auth', 'ok', 'network', 'invalid-shared'])('refreshes Codex duplicate only for proven auth failure with valid shared credentials: %s', async (kind) => {
    const { runtime, files, execFile } = setup()
    const bundle = codexMultiAuthBundle()
    const root = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
    const local = structuredClone(bundle.accounts)
    local.accounts[0]!.accessToken = 'local-token'
    local.accounts[0]!.refreshToken = 'local-refresh'
    Object.assign(local, { pinnedAccountIndex: 0 })
    files.set(root, JSON.stringify(local))
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'codex' && args[0] === 'exec') {
        const auth = JSON.parse(files.get(`${options?.environment?.HOME}/.codex/auth.json`)!)
        const bad = auth.access_token === 'local-token' ? kind !== 'ok' : kind === 'invalid-shared'
        if (bad) return { exitCode: 1, stdout: '', stderr: kind === 'network' ? 'network error' : '401 unauthorized' }
        return { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SHARED_AI_OK' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) }
      }
      return original(command, args, options)
    })
    await runtime.apply({ provider: 'codex', payload: JSON.stringify(bundle), applyMode: 'merge' })
    const result = JSON.parse(files.get(root)!)
    expect(result.accounts[0].refreshToken).toBe(kind === 'auth' ? 'refresh-a' : 'local-refresh')
    expect(result).toMatchObject({ activeIndex: 0, pinnedAccountIndex: 0 })
  })

  it('rejects an invalid explicit active account before changing any pool', async () => {
    const { runtime, files, execFile } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => command === 'codex' && args[0] === 'exec'
      ? { exitCode: 1, stdout: '', stderr: '401 unauthorized' } : original(command, args, options))
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge', activeAccountIndex: 1 } as never)).rejects.toThrow('AI_CREDENTIAL_ACTIVE_INVALID')
    expect(files.has('/home/operator/.codex/multi-auth/openai-codex-accounts.json')).toBe(false)
  })

  it('explicitly activates the selected installed Codex identity using its local index', async () => {
    const { runtime, calls, execFile, files } = setup()
    const bundle = codexMultiAuthBundle()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'codex' && args[0] === 'exec') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SHARED_AI_OK' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) }
      if (command === 'codex-multi-auth' && args[0] === 'switch') {
        const path = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
        const pool = JSON.parse(files.get(path)!); pool.activeIndex = Number(args[1]) - 1; files.set(path, JSON.stringify(pool));
        const active = pool.accounts[pool.activeIndex]; files.set('/home/operator/.codex/auth.json', JSON.stringify({ tokens: { account_id: active.accountId, access_token: active.accessToken, refresh_token: active.refreshToken } }))
      }
      return original(command, args, options)
    })
    const result = await runtime.apply({ provider: 'codex', payload: JSON.stringify(bundle), applyMode: 'merge', activeAccountIndex: 1 } as never)
    expect(result).toMatchObject({ activeAccountIndex: 1 })
    expect(calls).toContainEqual({ command: 'codex-multi-auth', args: ['switch', '2'] })
  })

  it('explicitly activates the selected shared Claude account without losing a personal slot', async () => {
    const { runtime, execFile, files } = setup()
    let active = 7
    const accounts = [
      { number: 7, email: 'personal@example.com', usageStatus: 'ok', organizationUuid: '' },
      { number: 9, email: 'shared@example.com', usageStatus: 'ok', organizationUuid: '' },
    ]
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts }), stderr: '' }
      if (command === 'cswap' && args[0] === 'export') return { stdout: claudeOauthPayload(accounts), stderr: '' }
      if (command === 'cswap' && args[0] === 'switch') active = Number(args[1])
      if (command === 'claude' && args[0] === '--print') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }) }
      return original(command, args, options)
    })
    await runtime.apply({ provider: 'claude', payload: claudeOauthPayload([{ email: 'shared@example.com' }]), applyMode: 'merge', activeAccountIndex: 0 })
    expect(active).toBe(9)
    expect(accounts[0]).toMatchObject({ number: 7, email: 'personal@example.com' })
    expect(files.has('/home/operator/.happy/ai-credential-apply-generations.json')).toBe(true)
  })

  it('rejects a Codex switch that changes the pool but fails to synchronize live auth', async () => {
    const { runtime, files, execFile } = setup()
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'codex' && args[0] === 'exec') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SHARED_AI_OK' } }) + '\n' + JSON.stringify({ type: 'turn.completed' }) }
      if (command === 'codex-multi-auth' && args[0] === 'switch') {
        const path = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
        const pool = JSON.parse(files.get(path)!); pool.activeIndex = Number(args[1]) - 1; files.set(path, JSON.stringify(pool))
      }
      return original(command, args, options)
    })
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge', activeAccountIndex: 1 })).rejects.toThrow('AI_CREDENTIAL_ACTIVE_INVALID')
    expect(JSON.parse(files.get('/home/operator/.codex/multi-auth/openai-codex-accounts.json')!).activeIndex).toBe(0)
  })

  it('registers an unpooled personal Codex login before adding shared accounts without switching', async () => {
    const { runtime, files, calls } = setup()
    const token = `header.${Buffer.from(JSON.stringify({ email: 'personal@example.com', exp: 9999999999 })).toString('base64url')}.signature`
    const live = JSON.stringify({ tokens: { account_id: 'personal-id', access_token: token, refresh_token: 'personal-refresh' } })
    files.set('/home/operator/.codex/auth.json', live)
    await runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' })
    const pool = JSON.parse(files.get('/home/operator/.codex/multi-auth/openai-codex-accounts.json')!)
    expect(pool.accounts).toHaveLength(4)
    expect(pool.accounts[pool.activeIndex]).toMatchObject({ accountId: 'personal-id', refreshToken: 'personal-refresh' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe(live)
    expect(calls.some(call => call.command === 'codex-multi-auth' && call.args[0] === 'switch')).toBe(false)
  })

  it('keeps unreadable personal Codex credentials and aborts before adding shared accounts', async () => {
    const { runtime, files } = setup()
    files.set('/home/operator/.codex/auth.json', 'unreadable-personal-login')
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge' })).rejects.toThrow()
    expect(files.get('/home/operator/.codex/auth.json')).toBe('unreadable-personal-login')
    expect(files.has('/home/operator/.codex/multi-auth/openai-codex-accounts.json')).toBe(false)
  })

  it('captures a live unregistered Claude identity before import and retains it as active', async () => {
    const { runtime, execFile, files, calls } = setup()
    files.set('/home/operator/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'personal@example.com' } }))
    let registered = false, imported = false
    const original = execFile.getMockImplementation()!
    execFile.mockImplementation(async (command, args, options) => {
      if (command === 'cswap' && args[0] === 'add') registered = true
      if (command === 'cswap' && args[0] === 'import') imported = true
      if (command === 'cswap' && args[0] === 'list') return { stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: registered ? 7 : null, accounts: [
        ...(registered ? [{ number: 7, email: 'personal@example.com', usageStatus: 'ok' }] : []),
        ...(imported ? [{ number: 8, email: 'shared@example.com', usageStatus: 'ok' }] : []),
      ] }), stderr: '' }
      return original(command, args, options)
    })
    await runtime.apply({ provider: 'claude', payload: claudeOauthPayload([{ email: 'shared@example.com' }]), applyMode: 'merge' })
    expect(registered).toBe(true)
    expect(calls.some(call => call.command === 'cswap' && call.args[0] === 'switch')).toBe(false)
  })

  it('creates a shared Codex pool when no personal login exists without enabling imported automatic rotation settings', async () => {
    const { runtime, files } = setup()
    const payload = codexMultiAuthBundle()
    payload.settings.pluginConfig = { codexRuntimeRotationProxy: true }
    const result = await runtime.apply({ provider: 'codex', payload: JSON.stringify(payload), applyMode: 'merge' })
    expect(result).toMatchObject({ configured: true, applyMode: 'merge', accountCount: 3 })
    expect(JSON.parse(files.get('/home/operator/.codex/multi-auth/settings.json')!)).toEqual({ version: 1, pluginConfig: {} })
  })

  it('rejects merge into a trial lease before changing any credentials', async () => {
    const { runtime, files } = setup()
    await expect(runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), applyMode: 'merge', trialLease: { leaseId: 'trial', contentHash: 'a'.repeat(64), bundleVersion: 1 } })).rejects.toThrow('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    expect(files.has('/home/operator/.codex/multi-auth/openai-codex-accounts.json')).toBe(false)
  })


  const trialLease = {
    leaseId: 'lease-claude-1',
    contentHash: 'a'.repeat(64),
    bundleVersion: 1,
  }

  const zaiPayload = JSON.stringify({
    version: 1,
    kind: 'zai-anthropic',
    apiKey: 'zai-secret-key',
  })

  it('stores a Z.AI fallback with mode 0600 and exposes it only to Claude sessions', async () => {
    const { runtime, files, supervisor, writeFile } = setup()
    const zaiLease = { ...trialLease, leaseId: 'lease-zai-1' }

    await expect(runtime.apply({ provider: 'zai', payload: zaiPayload, trialLease: zaiLease }))
      .resolves.toEqual({
        provider: 'zai', configured: true, accountCount: 1, applyGeneration: 1,
      })

    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(writeFile).toHaveBeenCalledWith(
      '/home/operator/.happy/zai-claude-env.json.happy-tmp',
      expect.any(String),
      { mode: 0o600 },
    )
    expect(JSON.parse(files.get('/home/operator/.happy/zai-claude-env.json')!)).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    })
    expect(files.get('/home/operator/.happy/trial-ai-credential-leases.json'))
      .not.toContain('zai-secret-key')
    await expect(runtime.sessionEnvironment('claude')).resolves.toEqual({
      ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    })
    await expect(runtime.sessionEnvironment('codex')).resolves.toEqual({})
  })

  it('removes stale managed Claude credentials before enabling a Z.AI fallback', async () => {
    const { runtime, files, execFile } = setup()
    files.set('/home/operator/.claude/.credentials.json', 'stale-oauth-secret')
    files.set('/home/operator/.claude-swap/accounts/1.json', 'stale-profile-secret')
    files.set('/home/operator/.config/claude-swap/config.json', 'stale-profile-secret')

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    expect(files.has('/home/operator/.claude/.credentials.json')).toBe(false)
    expect(files.has('/home/operator/.claude-swap/accounts/1.json')).toBe(false)
    expect(files.has('/home/operator/.config/claude-swap/config.json')).toBe(false)
  })

  it('removes a stale managed Z.AI secret before enabling native Claude', async () => {
    const { runtime, files } = setup()
    files.set('/home/operator/.happy/zai-claude-env.json', JSON.stringify({
      ANTHROPIC_AUTH_TOKEN: 'stale-zai-secret',
    }))

    await runtime.apply({ provider: 'claude', payload: '{}', trialLease })

    expect(files.has('/home/operator/.happy/zai-claude-env.json')).toBe(false)
  })

  it('validates, reports, and purges a matching Z.AI fallback lease', async () => {
    const { runtime, files, execFile } = setup()
    const zaiLease = { ...trialLease, leaseId: 'lease-zai-1' }

    await runtime.apply({ provider: 'zai', payload: zaiPayload, trialLease: zaiLease })
    await expect(runtime.status({ provider: 'zai' })).resolves.toEqual({
      provider: 'zai', configured: true, accountCount: 1,
    })
    expect(execFile).toHaveBeenCalledWith(
      'claude',
      [
        '--print',
        '--no-session-persistence',
        '--safe-mode',
        '--output-format',
        'json',
        '--model',
        'sonnet',
        'Reply with exactly: CLAUDE_AUTH_OK',
        '--tools',
        '',
      ],
      expect.objectContaining({
        acceptNonZeroExit: true,
        environment: expect.objectContaining({
          ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
          ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        }),
      }),
    )
    await expect(runtime.purge({ provider: 'zai', leaseId: zaiLease.leaseId }))
      .resolves.toEqual({ provider: 'zai', purged: true, alreadyPurged: false })
    expect(files.has('/home/operator/.happy/zai-claude-env.json')).toBe(false)
    await expect(runtime.sessionEnvironment('claude')).resolves.toEqual({})
  })

  it('isolates the Z.AI probe from inherited native Claude credentials and model overrides', async () => {
    const { runtime, execFile } = setup({
      env: {
        SAFE_INHERITED_VALUE: 'kept',
        ANTHROPIC_API_KEY: 'stale-api-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth-token',
        ANTHROPIC_MODEL: 'claude-opus-5',
        ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
      },
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })
    await runtime.status({ provider: 'zai' })

    const probeEnvironment = execFile.mock.calls.find(([command]) => command === 'claude')?.[2]
      ?.environment
    expect(probeEnvironment).toEqual(expect.objectContaining({
      SAFE_INHERITED_VALUE: 'kept',
      ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      // 상속된 claude-opus-5 를 지우는 데서 그치지 않고 z.ai 가 실제로 서빙하는
      // 기본 모델로 덮어쓴다. 이 변수가 "아무것도 고르지 않았을 때" 의 최종
      // 기준점이라, 개별 코드 경로를 일일이 패치하지 않아도 기본값이 하나로 모인다.
      ANTHROPIC_MODEL: 'glm-5.3-flash',
    }))
    expect(probeEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(probeEnvironment).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(probeEnvironment).not.toHaveProperty('ANTHROPIC_SMALL_FAST_MODEL')
  })

  it('reports a missing or corrupt managed Z.AI environment as unconfigured', async () => {
    const { runtime, files } = setup()
    const zaiLease = { ...trialLease, leaseId: 'lease-zai-1' }

    await runtime.apply({ provider: 'zai', payload: zaiPayload, trialLease: zaiLease })
    files.delete('/home/operator/.happy/zai-claude-env.json')
    await expect(runtime.status({ provider: 'zai' })).resolves.toEqual({
      provider: 'zai', configured: false, accountCount: 0,
    })

    files.set('/home/operator/.happy/zai-claude-env.json', '{"unexpected":true}')
    await expect(runtime.status({ provider: 'zai' })).resolves.toEqual({
      provider: 'zai', configured: false, accountCount: 0,
    })
  })

  // ANTHROPIC_MODEL 은 머신이 이미 돌고 있는 상태에서 추가된 키다. 디스크의 파일은
  // 다음 apply 때까지 예전 6키 형태로 남아 있으므로, 그 사이 이 CLI 가 배포되면
  // 기존 파일을 계속 읽을 수 있어야 한다 — 거부하면 재적용 전까지 z.ai 자격이
  // 통째로 무효가 된다. 반대로 모르는 키가 하나라도 끼면 여전히 거부해야 한다.
  it('still accepts the pre-ANTHROPIC_MODEL environment written by an older CLI', async () => {
    const { runtime, files } = setup()
    const legacyEnvironment = {
      ANTHROPIC_AUTH_TOKEN: 'zai-secret-key',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
    }

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })
    files.set(
      '/home/operator/.happy/zai-claude-env.json',
      JSON.stringify(legacyEnvironment),
    )

    await expect(runtime.sessionEnvironment('claude')).resolves.toEqual(legacyEnvironment)

    // 닫힌 키 집합은 그대로 — 임의 env 주입은 조용히 무시되는 게 아니라 거부된다.
    files.set(
      '/home/operator/.happy/zai-claude-env.json',
      JSON.stringify({ ...legacyEnvironment, SOMETHING_ELSE: 'injected' }),
    )
    await expect(runtime.sessionEnvironment('claude')).rejects.toThrow(/ZAI_ENV_INVALID/)
  })

  it('reports a Z.AI key as unconfigured when the live Claude probe is not exact', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({ result: 'not authenticated' }),
        stderr: '',
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).resolves.toEqual({
      provider: 'zai', configured: false, accountCount: 0,
    })
  })

  it('does not accept exact Z.AI probe text from a failed Claude process', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({ result: 'CLAUDE_AUTH_OK' }),
        stderr: '401 Unauthorized: invalid API key',
        exitCode: 1,
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).resolves.toMatchObject({
      provider: 'zai', configured: false,
    })
  })

  it('does not quarantine a Z.AI key for a transient live probe failure', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: '',
        stderr: '429 Too Many Requests',
        exitCode: 1,
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).rejects.toMatchObject({
      kind: 'ZAI_PROBE_FAILED',
      // 운영자가 데몬 로그만 보고 원인을 알 수 있게 종료 코드와 stderr 마지막 줄을 싣는다.
      probe: { exitCode: 1, stderrTail: '429 Too Many Requests' },
    })
  })

  it('does not treat unrelated stdout text as a rejected Z.AI credential', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: 'plugin diagnostic: invalid key mapping',
        stderr: 'plugin initialization failed',
        exitCode: 1,
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).rejects.toMatchObject({
      kind: 'ZAI_PROBE_FAILED',
    })
  })

  it('does not treat an unrelated invalid-key stderr line as a rejected Z.AI credential', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: '',
        stderr: 'plugin initialization failed: invalid key mapping',
        exitCode: 1,
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).rejects.toMatchObject({
      kind: 'ZAI_PROBE_FAILED',
    })
  })

  it('still recognizes an explicit invalid API key Z.AI error', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: '',
        stderr: 'Invalid API key',
        exitCode: 1,
      })),
    })

    await runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })

    await expect(runtime.status({ provider: 'zai' })).resolves.toEqual({
      provider: 'zai', configured: false, accountCount: 0,
    })
  })

  it('removes the secret temporary file when Z.AI environment installation fails', async () => {
    let filesRef!: Map<string, string>
    const prepared = setup({
      rename: vi.fn(async (from: string, to: string) => {
        if (to.endsWith('/zai-claude-env.json')) throw new Error('rename failed')
        const value = filesRef.get(from)
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        filesRef.set(to, value)
        filesRef.delete(from)
      }),
    })
    filesRef = prepared.files

    await expect(prepared.runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })).rejects.toMatchObject({ kind: 'ZAI_APPLY_FAILED' })

    expect(prepared.files.has('/home/operator/.happy/zai-claude-env.json.happy-tmp')).toBe(false)
    expect(prepared.files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(false)
  })

  it('does not orphan an installed Z.AI secret on a redundant post-rename chmod', async () => {
    const prepared = setup({
      chmod: vi.fn(async (path: string) => {
        if (path.endsWith('/zai-claude-env.json')) throw new Error('chmod failed')
      }),
    })

    await expect(prepared.runtime.apply({
      provider: 'zai',
      payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })).resolves.toMatchObject({ provider: 'zai', configured: true })

    expect(prepared.files.has('/home/operator/.happy/zai-claude-env.json')).toBe(true)
    expect(prepared.files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(true)
  })

  it('rejects malformed Z.AI payloads and native/Z.AI lease overlap', async () => {
    const { runtime } = setup()
    await expect(runtime.apply({
      provider: 'zai', payload: '{"version":1,"kind":"zai-anthropic","apiKey":""}',
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })).rejects.toMatchObject({ kind: 'ZAI_PAYLOAD_INVALID' })

    await runtime.apply({ provider: 'claude', payload: '{}', trialLease })
    await expect(runtime.apply({
      provider: 'zai', payload: zaiPayload,
      trialLease: { ...trialLease, leaseId: 'lease-zai-1' },
    })).rejects.toMatchObject({ kind: 'TRIAL_LEASE_CONFLICT' })
  })

  it('writes only a non-secret trial ownership marker after a successful apply', async () => {
    const { runtime, files } = setup()

    await runtime.apply({ provider: 'claude', payload: '{"oauth":"trial-secret"}', trialLease })

    const marker = files.get('/home/operator/.happy/trial-ai-credential-leases.json')
    expect(JSON.parse(marker!)).toEqual({
      version: 1,
      leases: {
        claude: { ...trialLease },
      },
    })
    expect(marker).not.toContain('trial-secret')
  })

  it('clears a prior trial marker only after a non-trial replacement succeeds', async () => {
    const { runtime, files } = setup()
    files.set('/home/operator/.happy/trial-ai-credential-leases.json', JSON.stringify({
      version: 1,
      leases: { claude: { ...trialLease } },
    }))

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(false)
  })

  it('refuses to replace a marker owned by a different active lease', async () => {
    const { runtime, files, calls } = setup()
    files.set('/home/operator/.happy/trial-ai-credential-leases.json', JSON.stringify({
      version: 1,
      leases: { claude: { ...trialLease, leaseId: 'other-lease' } },
    }))

    await expect(runtime.apply({
      provider: 'claude', payload: '{"oauth":"must-not-apply"}', trialLease,
    })).rejects.toMatchObject({ kind: 'TRIAL_LEASE_CONFLICT' })
    expect(calls.some(({ command, args }) => command === 'cswap' && args[0] === 'import')).toBe(false)
    expect(files.get('/home/operator/.happy/trial-ai-credential-leases.json'))
      .toContain('other-lease')
  })

  it('purges only a matching Claude trial lease and is idempotent', async () => {
    const { runtime, files, supervisor } = setup()
    await runtime.apply({ provider: 'claude', payload: '{}', trialLease })
    files.set('/home/operator/.claude/.credentials.json', 'claude-secret')
    files.set('/home/operator/.claude-swap/accounts/1.json', 'profile-secret')
    files.set('/home/operator/.config/claude-swap/config.json', 'profile-secret')

    await expect(runtime.purge({ provider: 'claude', leaseId: trialLease.leaseId }))
      .resolves.toEqual({ provider: 'claude', purged: true, alreadyPurged: false })
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(files.has('/home/operator/.claude/.credentials.json')).toBe(false)
    expect(files.has('/home/operator/.claude-swap/accounts/1.json')).toBe(false)
    expect(files.has('/home/operator/.config/claude-swap/config.json')).toBe(false)
    expect(files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(false)

    await expect(runtime.purge({ provider: 'claude', leaseId: trialLease.leaseId }))
      .resolves.toEqual({ provider: 'claude', purged: true, alreadyPurged: true })
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
  })

  it('does not purge credentials when the expected lease id differs', async () => {
    const { runtime, files, supervisor } = setup()
    await runtime.apply({ provider: 'claude', payload: '{}', trialLease })
    files.set('/home/operator/.claude/.credentials.json', 'keep-this-secret')

    await expect(runtime.purge({ provider: 'claude', leaseId: 'stale-lease' }))
      .rejects.toMatchObject({ kind: 'TRIAL_LEASE_MISMATCH' })
    expect(files.get('/home/operator/.claude/.credentials.json')).toBe('keep-this-secret')
    expect(supervisor.stop).not.toHaveBeenCalled()
  })

  it('keeps the marker fail-closed when purge only partially removes files', async () => {
    let files!: Map<string, string>
    const configured = setup({
      rm: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        if (path === '/home/operator/.claude-swap') throw new Error('secret-path permission denied')
        for (const filePath of files.keys()) {
          if (filePath === path || (options?.recursive && filePath.startsWith(`${path}/`))) {
            files.delete(filePath)
          }
        }
      }),
    })
    files = configured.files
    await configured.runtime.apply({ provider: 'claude', payload: '{}', trialLease })
    files.set('/home/operator/.claude/.credentials.json', 'removed-first')
    files.set('/home/operator/.claude-swap/accounts/1.json', 'still-present')

    const error = await configured.runtime.purge({
      provider: 'claude', leaseId: trialLease.leaseId,
    }).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'TRIAL_PURGE_FAILED' })
    expect(error.message).not.toContain('secret-path')
    expect(files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(true)
    expect(files.get('/home/operator/.claude-swap/accounts/1.json')).toBe('still-present')
  })

  it('purges managed Codex auth and multi-auth files for the matching lease', async () => {
    const { runtime, files } = setup()
    const codexLease = { ...trialLease, leaseId: 'lease-codex-1' }
    await runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()), trialLease: codexLease,
    })
    files.set('/home/operator/.codex/auth.json', 'legacy-secret')

    await expect(runtime.purge({ provider: 'codex', leaseId: codexLease.leaseId }))
      .resolves.toMatchObject({ provider: 'codex', purged: true })
    expect(files.has('/home/operator/.codex/auth.json')).toBe(false)
    expect(files.has('/home/operator/.codex/multi-auth/openai-codex-accounts.json')).toBe(false)
    expect(files.has('/home/operator/.happy/trial-ai-credential-leases.json')).toBe(false)
  })

  it('orders ready Codex accounts by the least remaining quota instead of storage order', () => {
    const accounts = [
      { accountId: 'account-a', enabled: true },
      { accountId: 'account-b', enabled: true },
      { accountId: 'account-c', enabled: true },
    ]
    const quotaCache = {
      version: 1,
      byAccountId: {
        'account-a': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 40 }, secondary: { usedPercent: 20 } },
        'account-b': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 90 }, secondary: { usedPercent: 70 } },
        'account-c': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 60 }, secondary: { usedPercent: 30 } },
      },
      byEmail: {},
    }

    expect(selectLeastRemainingCodexAccounts(accounts, quotaCache, 5)).toEqual({
      orderedIndexes: [1, 2, 0],
      activeIndex: 0,
      quotaKnown: true,
      hasReadyAccount: true,
    })
  })

  it('distinguishes known exhausted Codex quota from unknown quota', () => {
    expect(selectLeastRemainingCodexAccounts([
      { accountId: 'account-a', enabled: true },
      { accountId: 'account-b', enabled: true },
    ], {
      byAccountId: {
        'account-a': { primary: { usedPercent: 95 }, secondary: { usedPercent: 50 } },
        'account-b': { primary: { usedPercent: 100 }, secondary: { usedPercent: 100 } },
      },
    }, 5)).toMatchObject({
      quotaKnown: true,
      hasReadyAccount: false,
    })
  })

  it('treats a missing quota window as unknown and normalizes email cache keys', () => {
    const accounts = [
      { email: ' First@Example.com ', enabled: true },
      { email: 'second@example.com', enabled: true },
    ]

    expect(selectLeastRemainingCodexAccounts(accounts, {
      byEmail: {
        'first@example.com': {
          primary: { usedPercent: 80 },
          secondary: { usedPercent: 40 },
        },
        'second@example.com': { primary: { usedPercent: 90 } },
      },
    }, 5)).toMatchObject({
      orderedIndexes: [0, 1],
      quotaKnown: false,
      hasReadyAccount: true,
    })
  })

  it('does not use an ambiguous email quota cache entry', () => {
    expect(selectLeastRemainingCodexAccounts([
      { accountId: 'account-a', email: 'shared@example.com' },
      { email: 'shared@example.com' },
    ], {
      byAccountId: {
        'account-a': { primary: { usedPercent: 50 }, secondary: { usedPercent: 40 } },
      },
      byEmail: {
        'shared@example.com': { primary: { usedPercent: 90 }, secondary: { usedPercent: 80 } },
      },
    }, 5)).toMatchObject({
      orderedIndexes: [0, 1],
      quotaKnown: false,
      hasReadyAccount: true,
    })
  })

  it('prepends the managed uv tool bin without mutating the daemon environment', () => {
    const environment = { PATH: '/usr/bin', UV_TOOL_BIN_DIR: '/managed/bin' }

    expect(withUvToolBinOnPath(environment, '/home/operator')).toEqual({
      PATH: ['/managed/bin', '/usr/bin'].join(delimiter),
      UV_TOOL_BIN_DIR: '/managed/bin',
    })
    expect(environment.PATH).toBe('/usr/bin')

    expect(withUvToolBinOnPath({ PATH: '/usr/bin' }, '/home/operator').PATH)
      .toBe([join('/home/operator', '.local', 'bin'), '/usr/bin'].join(delimiter))
    expect(withUvToolBinOnPath({
      PATH: '/usr/bin',
      XDG_BIN_HOME: '/xdg/bin',
      XDG_DATA_HOME: '/ignored/data',
    }, '/home/operator').PATH).toBe(['/xdg/bin', '/usr/bin'].join(delimiter))
    expect(withUvToolBinOnPath({
      PATH: '/usr/bin',
      XDG_DATA_HOME: '/xdg/data',
    }, '/home/operator').PATH).toBe([
      join('/xdg/data', '..', 'bin'),
      '/usr/bin',
    ].join(delimiter))

    expect(withUvToolBinOnPath({
      PATH: ['/usr/local/bin', '/managed/bin', '/usr/bin', '/managed/bin'].join(delimiter),
      UV_TOOL_BIN_DIR: '/managed/bin',
    }, '/home/operator').PATH).toBe([
      '/managed/bin',
      '/usr/local/bin',
      '/usr/bin',
    ].join(delimiter))
  })

  it('exports Claude credentials with fixed argv and a payload size cap', async () => {
    const { runtime, calls } = setup()

    await expect(runtime.capture({ provider: 'claude' })).resolves.toEqual({
      provider: 'claude',
      payload: '{"version":1,"encrypted":false,"accounts":[{}]}',
    })
    expect(calls).toEqual([{ command: 'cswap', args: ['export', '-'] }])

    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const { runtime: capped } = setup({
      execFile: vi.fn(async () => ({ stdout: oversized, stderr: '' })),
    })
    await expect(capped.capture({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'PAYLOAD_TOO_LARGE',
    })
  })

  it('does not fall back to legacy Codex auth outside the managed multi-auth pool', async () => {
    const { runtime, files } = setup({ env: { CODEX_HOME: '/fixed/codex' } })
    files.set('/fixed/codex/auth.json', '{"OPENAI_API_KEY":"secret"}')

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_FILE_STORE_REQUIRED',
    })
    await expect(runtime.capture({ provider: '../etc/passwd' as never })).rejects.toThrow(/provider/i)
  })

  it.each(['2.16.0', '2.17.0'])('captures a Codex %s account pool with default settings when settings.json is absent without writing source files', async (packageVersion) => {
    const execFile = vi.fn(async (command: string, args: string[]) => ({
      stdout: command === 'npm' ? '/global/node_modules\n' : `${packageVersion}\n`, stderr: '',
    }))
    const warn = vi.fn()
    const { runtime, files } = setup({ env: { CODEX_HOME: '/fixed/codex' }, execFile, warn })
    const bundle = codexMultiAuthBundle()
    bundle.packageVersion = packageVersion
    files.set('/global/node_modules/codex-multi-auth/package.json', JSON.stringify({ version: packageVersion }))
    files.set('/fixed/codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/fixed/codex/auth.json', '{"OPENAI_API_KEY":"unrelated-secret"}')
    const beforeCapture = new Map(files)

    const captured = await runtime.capture({ provider: 'codex' })

    expect(JSON.parse(captured.payload)).toEqual(bundle)
    expect(captured.provider).toBe('codex')
    expect(files).toEqual(beforeCapture)
    expect(execFile.mock.calls.some(([command, args]) => command === 'npm' && args[0] === 'install')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('captures the fixed Codex multi-auth account pool and settings as one versioned bundle', async () => {
    const { runtime, files } = setup({ env: { CODEX_HOME: '/fixed/codex' } })
    const bundle = codexMultiAuthBundle()
    files.set('/fixed/codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/fixed/codex/multi-auth/settings.json', JSON.stringify(bundle.settings))

    const captured = await runtime.capture({ provider: 'codex' })

    expect(captured.provider).toBe('codex')
    expect(JSON.parse(captured.payload)).toEqual(bundle)
  })

  it.each(['openai-codex-accounts.json', 'settings.json'])('fails closed on malformed Codex %s without leaking its contents', async (fileName) => {
    const warn = vi.fn()
    const { runtime, files } = setup({ warn })
    const bundle = codexMultiAuthBundle()
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify(bundle.settings))
    files.set(`/home/operator/.codex/multi-auth/${fileName}`, '{"token":"fixture-secret",')
    const beforeCapture = new Map(files)

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_CAPTURE_FAILED', message: 'AI credential operation failed (CODEX_CAPTURE_FAILED)',
    })
    expect(files).toEqual(beforeCapture)
    expect(warn).toHaveBeenCalledExactlyOnceWith(`Codex credential capture could not read ${fileName} (INVALID_JSON)`)
  })

  it.each([
    ['openai-codex-accounts.json', 'EACCES'],
    ['openai-codex-accounts.json', 'EIO'],
    ['settings.json', 'EACCES'],
    ['settings.json', 'EPERM'],
    ['settings.json', 'EIO'],
  ])('fails closed on %s read error %s instead of using default settings', async (fileName, code) => {
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === join('/home/operator', '.codex', 'multi-auth', fileName)) {
        throw Object.assign(new Error('/private/path fixture-secret'), { code })
      }
      if (filePath.endsWith('package.json')) return JSON.stringify({ version: '2.16.0' })
      return JSON.stringify(codexMultiAuthBundle().accounts)
    })
    const warn = vi.fn()
    const { runtime } = setup({ readFile, warn })

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_CAPTURE_FAILED', message: 'AI credential operation failed (CODEX_CAPTURE_FAILED)',
    })
    expect(readFile).toHaveBeenCalledWith(join('/home/operator', '.codex', 'multi-auth', fileName))
    expect(warn).toHaveBeenCalledExactlyOnceWith(`Codex credential capture could not read ${fileName} (${code})`)
  })

  it('redacts unexpected filesystem codes in Codex capture diagnostics', async () => {
    const warn = vi.fn()
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('settings.json')) {
        throw Object.assign(new Error('/private/path fixture-secret'), { code: 'fixture-secret' })
      }
      if (filePath.endsWith('package.json')) return JSON.stringify({ version: '2.16.0' })
      return JSON.stringify(codexMultiAuthBundle().accounts)
    })
    const { runtime } = setup({ readFile, warn })

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({ kind: 'CODEX_CAPTURE_FAILED' })
    expect(warn).toHaveBeenCalledExactlyOnceWith('Codex credential capture could not read settings.json (READ_FAILED)')
  })

  it('preserves the Codex capture failure when the diagnostic callback throws', async () => {
    const warn = vi.fn(() => { throw new AiCredentialRuntimeError('DIAGNOSTIC_CALLBACK_FAILED') })
    const { runtime, files } = setup({ warn })
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', '{"token":"fixture-secret",')

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_CAPTURE_FAILED', message: 'AI credential operation failed (CODEX_CAPTURE_FAILED)',
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith('Codex credential capture could not read openai-codex-accounts.json (INVALID_JSON)')
  })

  it.each(['2.16.0', '2.17.0', '2.19.0'])('captures and reapplies the actual supported runtime %s without installing', async (version) => {
    const execFile = vi.fn(async (command: string, args: string[]) => ({
      stdout: command === 'codex-multi-auth' && args[0] === '--version' ? version
        : command === 'npm' && args[0] === 'root' ? '/global/node_modules' : '',
      stderr: '',
    }))
    const { runtime, files } = setup({ execFile })
    files.set('/global/node_modules/codex-multi-auth/package.json', JSON.stringify({ version }))
    const bundle = codexMultiAuthBundle()
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify(bundle.settings))
    const captured = await runtime.capture({ provider: 'codex' })
    expect(JSON.parse(captured.payload)).toEqual({ ...bundle, packageVersion: version })
    await expect(runtime.apply(captured)).resolves.toMatchObject({ configured: true, accountCount: 3 })
    expect(execFile.mock.calls.some(([command, args]) => command === 'npm' && args[0] === 'install')).toBe(false)
  })

  it.each(['2.16.0', '2.18.0'])('rejects capture when CLI 2.17.0 disagrees with global package %s', async (version) => {
    const { runtime, files } = setup({ execFile: vi.fn(async (command: string) => ({
      stdout: command === 'npm' ? '/global/node_modules' : '2.17.0', stderr: '',
    })) })
    files.set('/global/node_modules/codex-multi-auth/package.json', JSON.stringify({ version }))
    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({ kind: 'CODEX_MULTI_AUTH_VERSION_MISMATCH', message: expect.stringContaining(`installed=2.17.0 global=${version} supported=>=2.16.0`) })
  })

  it('rejects Codex capture when the installed multi-auth package is not the pinned version', async () => {
    const { runtime, files } = setup({
      execFile: vi.fn(async (command: string, args: string[]) => {
        if (command === 'codex-multi-auth' && args[0] === '--version') {
          return { stdout: '2.8.4\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
    })
    const bundle = codexMultiAuthBundle()
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify(bundle.settings))

    await expect(runtime.capture({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_MULTI_AUTH_VERSION_MISMATCH',
    })
  })

  it('pins Codex multi-auth 2.16.0 and applies least-remaining 5% rotation settings', async () => {
    let files!: Map<string, string>
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex-multi-auth' && args[0] === '--version') {
        return { stdout: '2.16.0\n', stderr: '' }
      }
      if (command === 'npm' && args[0] === 'root') {
        return { stdout: '/global/node_modules\n', stderr: '' }
      }
      if (command === 'codex-multi-auth' && args[0] === 'forecast') {
        files.set('/home/operator/.codex/multi-auth/quota-cache.json', JSON.stringify({
          version: 1,
          byAccountId: {
            'account-a': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 40 }, secondary: { usedPercent: 20 } },
            'account-b': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 90 }, secondary: { usedPercent: 70 } },
            'account-c': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 60 }, secondary: { usedPercent: 30 } },
          },
          byEmail: {},
        }))
        return { stdout: '{"command":"forecast"}', stderr: '' }
      }
      if (command === 'codex-multi-auth' && args[0] === 'check') {
        return { stdout: '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const configured = setup({ execFile })
    files = configured.files

    await expect(configured.runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })).resolves.toMatchObject({
      provider: 'codex',
      configured: true,
      accountCount: 3,
      rotation: {
        state: 'running',
        strategy: 'sequential',
        threshold5h: 5,
        threshold7d: 5,
      },
    })

    const storedAccounts = JSON.parse(files.get('/home/operator/.codex/multi-auth/openai-codex-accounts.json')!)
    expect(storedAccounts.accounts.map((account: { accountId: string }) => account.accountId))
      .toEqual(['account-b', 'account-c', 'account-a'])
    expect(storedAccounts.activeIndex).toBe(0)
    const storedSettings = JSON.parse(files.get('/home/operator/.codex/multi-auth/settings.json')!)
    expect(storedSettings.pluginConfig).toMatchObject({
      codexRuntimeRotationProxy: true,
      schedulingStrategy: 'sequential',
      preemptiveQuotaEnabled: true,
      preemptiveQuotaRemainingPercent5h: 5,
      preemptiveQuotaRemainingPercent7d: 5,
      routingMutex: 'enabled',
    })
    expect(execFile).toHaveBeenCalledWith('codex-multi-auth', ['forecast', '--live', '--json'], expect.anything())
    expect(JSON.stringify(execFile.mock.calls)).not.toContain('refresh-a')
  })

  it.each(['2.15.0', '2.17.0', '2.19.0'])('applies a compatible bundle from %s on runtime 2.16.0', async (packageVersion) => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex-multi-auth' && args[0] === '--version') {
        return { stdout: '2.16.0\n', stderr: '' }
      }
      if (command === 'npm' && args[0] === 'root') {
        return { stdout: '/global/node_modules\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'codex',
      payload: JSON.stringify({ ...codexMultiAuthBundle(), packageVersion }),
    })).resolves.toMatchObject({ provider: 'codex', configured: true, accountCount: 3 })
  })

  it('rejects a Codex bundle captured by a codex-multi-auth version it cannot read', async () => {
    const { runtime } = setup()

    await expect(runtime.apply({
      provider: 'codex',
      payload: JSON.stringify({ ...codexMultiAuthBundle(), packageVersion: '2.8.5' }),
    })).rejects.toMatchObject({ kind: 'CODEX_MULTI_AUTH_PAYLOAD_INVALID' })
  })

  it('preserves OAuth tokens refreshed by the live quota forecast when sorting accounts', async () => {
    let files!: Map<string, string>
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex-multi-auth' && args[0] === '--version') {
        return { stdout: '2.16.0\n', stderr: '' }
      }
      if (command === 'npm' && args[0] === 'root') {
        return { stdout: '/global/node_modules\n', stderr: '' }
      }
      if (command === 'codex-multi-auth' && args[0] === 'forecast') {
        const path = '/home/operator/.codex/multi-auth/openai-codex-accounts.json'
        const accounts = JSON.parse(files.get(path)!)
        accounts.accounts[0] = {
          ...accounts.accounts[0],
          refreshToken: 'rotated-refresh-a',
          accessToken: 'rotated-access-a',
        }
        files.set(path, JSON.stringify(accounts))
        files.set('/home/operator/.codex/multi-auth/quota-cache.json', JSON.stringify({
          version: 1,
          byAccountId: {
            'account-a': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 90 }, secondary: { usedPercent: 80 } },
            'account-b': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 50 }, secondary: { usedPercent: 40 } },
            'account-c': { updatedAt: 3, status: 200, model: 'gpt-5.5', primary: { usedPercent: 30 }, secondary: { usedPercent: 20 } },
          },
          byEmail: {},
        }))
      }
      return { stdout: '', stderr: '' }
    })
    const configured = setup({ execFile })
    files = configured.files

    await configured.runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })

    const stored = JSON.parse(files.get('/home/operator/.codex/multi-auth/openai-codex-accounts.json')!)
    expect(stored.accounts[0]).toMatchObject({
      accountId: 'account-a',
      refreshToken: 'rotated-refresh-a',
      accessToken: 'rotated-access-a',
    })
  })

  it('fails closed when the pinned Codex multi-auth version is still unavailable after install', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex-multi-auth' && args[0] === '--version') {
        return { stdout: '2.8.4\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })).rejects.toMatchObject({ kind: 'CODEX_MULTI_AUTH_VERSION_MISMATCH' })
    expect(execFile).toHaveBeenCalledWith('npm', [
      'install', '--global', 'codex-multi-auth@2.16.0',
    ], expect.anything())
  })

  it('installs the pinned npm-global package when PATH exposes an unrelated exact-version CLI', async () => {
    let files!: Map<string, string>
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex-multi-auth' && args[0] === '--version') {
        return { stdout: '2.16.0\n', stderr: '' }
      }
      if (command === 'npm' && args[0] === 'root') {
        return { stdout: '/alternate/global/node_modules\n', stderr: '' }
      }
      if (command === 'npm' && args[0] === 'install') {
        files.set('/alternate/global/node_modules/codex-multi-auth/package.json', JSON.stringify({
          version: '2.16.0',
        }))
      }
      return { stdout: '', stderr: '' }
    })
    const configured = setup({ execFile })
    files = configured.files

    await configured.runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })

    expect(execFile).toHaveBeenCalledWith('npm', [
      'install', '--global', 'codex-multi-auth@2.16.0',
    ], expect.anything())
  })

  it('preserves untouched Codex multi-auth files when a later backup fails', async () => {
    let files!: Map<string, string>
    let failedSettingsBackup = false
    const configured = setup({
      rename: vi.fn(async (from: string, to: string) => {
        if (to.endsWith('settings.json.happy-backup') && !failedSettingsBackup) {
          failedSettingsBackup = true
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        const value = files.get(from)
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        files.set(to, value)
        files.delete(from)
      }),
    })
    files = configured.files
    const oldAccounts = JSON.stringify(codexMultiAuthBundle().accounts)
    const oldSettings = JSON.stringify({ version: 1, pluginConfig: { schedulingStrategy: 'round-robin' } })
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', oldAccounts)
    files.set('/home/operator/.codex/multi-auth/settings.json', oldSettings)

    await expect(configured.runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })).rejects.toMatchObject({ kind: 'CODEX_MULTI_AUTH_APPLY_FAILED' })
    expect(files.get('/home/operator/.codex/multi-auth/openai-codex-accounts.json')).toBe(oldAccounts)
    expect(files.get('/home/operator/.codex/multi-auth/settings.json')).toBe(oldSettings)
  })

  it('installs, configures, and imports Claude credentials without putting the secret in argv', async () => {
    const { runtime, calls, files, supervisor } = setup()
    const payload = '{"token":"never-in-argv"}'

    await expect(runtime.apply({ provider: 'claude', payload })).resolves.toMatchObject({
      provider: 'claude',
      configured: true,
      rotation: { state: 'running' },
    })

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ['uv', ['--version']],
      ['uv', ['python', 'find', '>=3.12']],
      ['cswap', ['--version']],
      ['cswap', ['config', 'set', 'autoswitch.threshold', '95']],
      ['cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first']],
      ['cswap', ['import', '/tmp/happy-ai-credential-fixed/claude-swap.json', '--force']],
      ['cswap', ['list', '--json']],
    ])
    expect(JSON.stringify(calls.map(({ command, args }) => ({ command, args })))).not.toContain('never-in-argv')
    expect(files.has('/tmp/happy-ai-credential-fixed/claude-swap.json')).toBe(false)
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it.each(['relogin_required', 'ok', 'no_credentials'])(
    'activates imported credentials even when the existing live slot reports %s',
    async (previousUsageStatus) => {
      let activated = false
      const execFile = vi.fn(async (command: string, args: string[]) => {
        if (command === 'cswap' && args[0] === '--version') {
          return { stdout: 'cswap 0.25.0', stderr: '' }
        }
        if (command === 'cswap' && args[0] === 'switch') {
          // Import resolves by identity, so exported slot 1 is local slot 7.
          if (args[1] === '7' && args.includes('--force')) activated = true
        }
        if (command === 'cswap' && args[0] === 'list') {
          return {
            stdout: JSON.stringify({
              schemaVersion: 1,
              activeAccountNumber: 7,
              accounts: [{
                number: 7, email: 'owner@example.com', organizationUuid: 'org-a',
                usageStatus: activated ? 'ok' : previousUsageStatus,
              }],
            }),
            stderr: '',
          }
        }
        return { stdout: '', stderr: '' }
      })
      const { runtime, supervisor, files } = setup({ execFile })

      await expect(runtime.apply({
        provider: 'claude',
        payload: claudeOauthPayload([{ email: 'owner@example.com', organizationUuid: 'org-a' }]),
      })).resolves.toMatchObject({ provider: 'claude', configured: true })

      expect(activated).toBe(true)
      expect(execFile).toHaveBeenCalledWith(
        'cswap', ['switch', '7', '--force', '--json'], expect.anything(),
      )
      const switchIndex = execFile.mock.calls.findIndex(([, args]) => args[0] === 'switch')
      expect(execFile.mock.calls.slice(switchIndex + 1).some(([, args]) => args[0] === 'list')).toBe(true)
      expect(supervisor.enable).toHaveBeenCalledOnce()
      expect(files.has('/tmp/happy-ai-credential-fixed/claude-swap.json')).toBe(false)
    },
  )

  it.each(['relogin_required', 'wrong_slot', 'command_failure', 'foreign_identity', 'extra_account'])(
    'does not report an imported active credential as applied after %s',
    async (failure) => {
      let activationAttempted = false
      const execFile = vi.fn(async (command: string, args: string[]) => {
        if (command === 'cswap' && args[0] === '--version') {
          return { stdout: 'cswap 0.25.0', stderr: '' }
        }
        if (command === 'cswap' && args[0] === 'switch') {
          activationAttempted = true
          if (failure === 'command_failure') throw new Error('secret-command-output')
        }
        if (command === 'cswap' && args[0] === 'list') {
          return {
            stdout: JSON.stringify({
              schemaVersion: 1,
              activeAccountNumber: activationAttempted && failure === 'wrong_slot' ? null : 1,
              accounts: [{
                number: 1, email: 'owner@example.com',
                organizationUuid: activationAttempted && failure === 'foreign_identity' ? 'foreign-org' : '',
                usageStatus: activationAttempted && failure === 'relogin_required' ? failure : 'ok',
              }, ...(activationAttempted && failure === 'extra_account'
                ? [{ number: 2, email: 'foreign@example.com', organizationUuid: '', usageStatus: 'ok' }]
                : [])],
            }),
            stderr: '',
          }
        }
        return { stdout: '', stderr: '' }
      })
      const { runtime, supervisor, files } = setup({ execFile })

      await expect(runtime.apply({
        provider: 'claude', payload: claudeOauthPayload([{ email: 'owner@example.com' }]),
      })).rejects.toMatchObject({
        kind: failure === 'command_failure'
          ? 'CLAUDE_APPLY_FAILED'
          : failure === 'relogin_required'
            ? 'CLAUDE_APPLY_RELOGIN_REQUIRED'
            : 'CLAUDE_APPLY_VERIFICATION_FAILED',
        message: expect.not.stringContaining('secret-command-output'),
      })

      expect(activationAttempted).toBe(true)
      expect(supervisor.enable).not.toHaveBeenCalled()
      expect(files.has('/tmp/happy-ai-credential-fixed/claude-swap.json')).toBe(false)
    },
  )

  it('activates a replacement API key even when the same local account is already active', async () => {
    const { runtime, execFile, supervisor } = setup()
    const payload = JSON.parse(claudeOauthPayload([{ email: 'owner@example.com' }]))
    payload.accounts[0].credentials = `sk-ant-api${'a'.repeat(20)}`
    execFile.mockImplementation(async (_command, args) => ({
      stdout: args[0] === 'list'
        ? JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: 1,
          accounts: [{ number: 1, email: 'owner@example.com', usageStatus: 'api_key' }],
        })
        : '',
      stderr: '',
    }))

    await expect(runtime.apply({ provider: 'claude', payload: JSON.stringify(payload) }))
      .resolves.toMatchObject({ provider: 'claude', configured: true, credentialKind: 'api_key' })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '1', '--force', '--json'], expect.anything(),
    )
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('activates a usable Claude account when import leaves no active account', async () => {
    let switched = false
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber: switched ? 2 : null,
            accounts: [
              {
                number: 1,
                email: 'expired@example.com',
                disabled: false,
                usageStatus: 'relogin_required',
              },
              {
                number: 2,
                email: 'ready@example.com',
                disabled: false,
                usageStatus: 'ok',
              },
            ],
          }),
          stderr: '',
        }
      }
      if (command === 'cswap' && args[0] === 'switch') switched = true
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({ provider: 'claude', payload: '{}' }))
      .resolves.toMatchObject({ provider: 'claude', configured: true })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '2', '--force', '--json'], expect.anything(),
    )
    expect(execFile.mock.calls.filter(([, args]) => args[0] === 'list')).toHaveLength(2)
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it('replaces an unusable active Claude account with a usable account', async () => {
    let activeAccountNumber = 1
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber,
            accounts: [
              {
                number: 1,
                email: 'expired@example.com',
                disabled: false,
                usageStatus: 'relogin_required',
              },
              {
                number: 2,
                email: 'ready@example.com',
                disabled: false,
                usageStatus: 'ok',
              },
            ],
          }),
          stderr: '',
        }
      }
      if (command === 'cswap' && args[0] === 'switch') activeAccountNumber = Number(args[1])
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({ provider: 'claude', payload: '{}' }))
      .resolves.toMatchObject({ provider: 'claude', configured: true })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '2', '--force', '--json'], expect.anything(),
    )
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it('removes prior OAuth accounts and verifies only the imported bundle', async () => {
    let activeAccountNumber: number | null = 1
    let accounts = [
      { number: 1, email: 'old-company@example.com', organizationUuid: 'old-org', usageStatus: 'ok' },
      { number: 2, email: 'new-company@example.com', organizationUuid: 'new-org', usageStatus: 'ok' },
    ]
    const execFile = vi.fn(async (
      command: string,
      args: string[],
      options?: { input?: string },
    ) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber, accounts }),
          stderr: '',
        }
      }
      if (command === 'cswap' && args[0] === 'remove' && options?.input === 'y\n') {
        const removed = Number(args[1])
        accounts = accounts.filter((account) => account.number !== removed)
        if (activeAccountNumber === removed) activeAccountNumber = null
      }
      if (command === 'cswap' && args[0] === 'switch') activeAccountNumber = Number(args[1])
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'claude',
      payload: claudeOauthPayload([{
        email: 'new-company@example.com', organizationUuid: 'new-org',
      }]),
    })).resolves.toMatchObject({ provider: 'claude', configured: true })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['remove', '1'], expect.objectContaining({ input: 'y\n' }),
    )
    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '2', '--force', '--json'], expect.anything(),
    )
    expect(accounts).toEqual([
      { number: 2, email: 'new-company@example.com', organizationUuid: 'new-org', usageStatus: 'ok' },
    ])
    const importCallOrder = execFile.mock.invocationCallOrder[
      execFile.mock.calls.findIndex(([, args]) => args[0] === 'import')
    ]
    expect(supervisor.stop.mock.invocationCallOrder[0]).toBeLessThan(importCallOrder)
    expect(supervisor.stop).toHaveBeenCalledBefore(supervisor.enable)
  })

  it('does not accept a usable prior OAuth account for an unusable imported bundle', async () => {
    let activeAccountNumber: number | null = 1
    let accounts = [
      { number: 1, email: 'old-company@example.com', organizationUuid: 'old-org', usageStatus: 'ok' },
      { number: 2, email: 'new-company@example.com', organizationUuid: 'new-org', usageStatus: 'relogin_required' },
    ]
    const execFile = vi.fn(async (
      command: string,
      args: string[],
      options?: { input?: string },
    ) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber, accounts }),
          stderr: '',
        }
      }
      if (command === 'cswap' && args[0] === 'remove' && options?.input === 'y\n') {
        const removed = Number(args[1])
        accounts = accounts.filter((account) => account.number !== removed)
        if (activeAccountNumber === removed) activeAccountNumber = null
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'claude',
      payload: claudeOauthPayload([{
        email: 'new-company@example.com', organizationUuid: 'new-org',
      }]),
    })).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED' })

    expect(accounts).toEqual([
      { number: 2, email: 'new-company@example.com', organizationUuid: 'new-org', usageStatus: 'relogin_required' },
    ])
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'every imported account requires login',
      statuses: [{ usageStatus: 'relogin_required' }, { usageStatus: 'relogin_required' }],
      kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED',
    },
    {
      name: 'the only enabled imported account requires login',
      statuses: [{ usageStatus: 'relogin_required' }, { usageStatus: 'ok', disabled: true }],
      kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED',
    },
    {
      name: 'only some imported accounts require login',
      statuses: [{ usageStatus: 'relogin_required' }, { usageStatus: 'rate_limited' }],
      kind: 'CLAUDE_APPLY_VERIFICATION_FAILED',
    },
    {
      name: 'every imported account is disabled',
      statuses: [
        { usageStatus: 'relogin_required', disabled: true },
        { usageStatus: 'relogin_required', disabled: true },
      ],
      kind: 'CLAUDE_APPLY_VERIFICATION_FAILED',
    },
  ])('reports $kind when $name', async ({ statuses, kind }) => {
    const accounts = statuses.map((status, index) => ({
      number: index + 1,
      email: `account-${index + 1}@example.com`,
      organizationUuid: 'org-a',
      ...status,
    }))
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({ schemaVersion: 1, activeAccountNumber: null, accounts }),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'claude',
      payload: claudeOauthPayload(accounts.map(({ email }) => ({ email, organizationUuid: 'org-a' }))),
    })).rejects.toMatchObject({ kind })

    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('reports relogin required when the imported account expires after switching to it', async () => {
    let switched = false
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'switch') switched = true
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber: switched ? 1 : null,
            accounts: [{
              number: 1, email: 'owner@example.com', organizationUuid: 'org-a',
              usageStatus: switched ? 'relogin_required' : 'ok',
            }],
          }),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({
      provider: 'claude',
      payload: claudeOauthPayload([{ email: 'owner@example.com', organizationUuid: 'org-a' }]),
    })).rejects.toMatchObject({ kind: 'CLAUDE_APPLY_RELOGIN_REQUIRED' })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '1', '--force', '--json'], expect.anything(),
    )
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('activates an imported Claude API key, removes prior accounts, and stops OAuth rotation', async () => {
    let activeAccountNumber: number | null = 1
    let accounts = [
      { number: 1, email: 'oauth@example.com', usageStatus: 'ok' },
      { number: 2, email: 'api-key-1@token.local', usageStatus: 'api_key' },
    ]
    const execFile = vi.fn(async (
      command: string,
      args: string[],
      options?: { input?: string },
    ) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber,
            accounts,
          }),
          stderr: '',
        }
      }
      if (command === 'cswap' && args[0] === 'switch') activeAccountNumber = Number(args[1])
      if (command === 'cswap' && args[0] === 'remove' && options?.input === 'y\n') {
        const removed = Number(args[1])
        accounts = accounts.filter((account) => account.number !== removed)
        if (activeAccountNumber === removed) activeAccountNumber = null
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })
    const payload = JSON.stringify({
      version: 1,
      encrypted: false,
      activeAccountNumber: 1,
      accounts: [{
        number: 1,
        email: 'api-key-1@token.local',
        credentials: `sk-ant-api${'a'.repeat(20)}`,
        config: { oauthAccount: { emailAddress: 'api-key-1@token.local' } },
      }],
    })

    await expect(runtime.apply({ provider: 'claude', payload })).resolves.toMatchObject({
      provider: 'claude', configured: true, credentialKind: 'api_key',
    })

    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['switch', '2', '--force', '--json'], expect.anything(),
    )
    expect(execFile).toHaveBeenCalledWith(
      'cswap', ['remove', '1'], expect.objectContaining({ input: 'y\n' }),
    )
    expect(execFile.mock.calls.filter(([, args]) => args[0] === 'list')).toHaveLength(3)
    expect(supervisor.stop).toHaveBeenCalledOnce()
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('rejects imported Claude credentials when every account requires login', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber: null,
            accounts: [{
              number: 1,
              email: 'expired@example.com',
              disabled: false,
              usageStatus: 'relogin_required',
            }],
          }),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, supervisor } = setup({ execFile })

    await expect(runtime.apply({ provider: 'claude', payload: '{}' }))
      .rejects.toMatchObject({ kind: 'CLAUDE_APPLY_VERIFICATION_FAILED' })

    expect(execFile.mock.calls.some(([, args]) => args[0] === 'switch')).toBe(false)
    expect(supervisor.enable).not.toHaveBeenCalled()
  })

  it('installs the managed claude-swap version when the current version differs', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.24.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(execFile).toHaveBeenCalledWith('uv', [
      'tool', 'install', 'claude-swap==0.25.0', '--python', '>=3.12', '--force',
    ], expect.anything())
  })

  it('installs claude-swap with a physical uv Python when Windows refuses the version link', async () => {
    const root = 'C:/Users/saycode test/AppData/Roaming/uv/python'
    const physical = join(root, 'cpython-3.12.13-windows-x86_64-none', 'python.exe')
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'uv' && args[0] === 'python' && args[1] === 'find') {
        throw new AiCredentialRuntimeError('COMMAND_FAILED')
      }
      if (command === 'uv' && args[0] === 'python' && args[1] === 'dir') {
        return { stdout: `${root}\r\n`, stderr: '' }
      }
      if (command === physical && args[0] === '--version') {
        return { stdout: 'Python 3.12.13', stderr: '' }
      }
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'cswap 0.24.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return { stdout: configuredClaudeList, stderr: '' }
      }
      if (args[0] === '--version' && command !== 'uv') throw new AiCredentialRuntimeError('COMMAND_NOT_AVAILABLE')
      return { stdout: '', stderr: '' }
    })
    const readdir = vi.fn(async (path: string) => (path === root
      ? ['.lock', 'cpython-3.12-windows-x86_64-none', 'cpython-3.12.13-windows-x86_64-none']
      : []))
    const { runtime } = setup({ execFile, readdir })

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(execFile).toHaveBeenCalledWith('uv', [
      'tool', 'install', 'claude-swap==0.25.0', '--python', physical, '--force',
    ], expect.anything())
  })

  it.each(['cswap 0.25.0', 'cswap 0.26.0', 'claude-swap 0.27.0b1'])('keeps installed %s instead of downgrading to the pin', async version => {
    const base = setup().execFile
    const execFile = vi.fn(async (command: string, args: string[], options?: object) => (
      command === 'cswap' && args[0] === '--version' ? { stdout: version, stderr: '' } : base(command, args, options)))
    const { runtime } = setup({ execFile })
    await runtime.apply({ provider: 'claude', payload: '{}' })
    expect(execFile.mock.calls.some(([command, args]) => command === 'uv' && args[0] === 'tool')).toBe(false)
  })

  it('keeps the uv Python failure when no physical Python 3.12+ installation runs', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'uv' && args[0] === 'python' && args[1] === 'find') {
        throw new AiCredentialRuntimeError('COMMAND_FAILED')
      }
      if (command === 'uv' && args[0] === 'python' && args[1] === 'dir') {
        return { stdout: '/uv/python\n', stderr: '' }
      }
      if (args[0] === '--version' && command !== 'uv') throw new AiCredentialRuntimeError('COMMAND_FAILED')
      return { stdout: '', stderr: '' }
    })
    const readdir = vi.fn(async () => ['cpython-3.11.9-windows-x86_64-none', 'cpython-3.12.13-windows-x86_64-none'])
    const { runtime } = setup({ execFile, readdir })

    await expect(runtime.apply({ provider: 'claude', payload: '{}' }))
      .rejects.toMatchObject({ kind: 'COMMAND_FAILED' })
    expect(execFile).not.toHaveBeenCalledWith('uv', expect.arrayContaining(['tool', 'install']), expect.anything())
    expect(execFile).not.toHaveBeenCalledWith(join('/uv/python', 'cpython-3.11.9-windows-x86_64-none', 'python.exe'), expect.anything())
  })

  it('does not accept a version string that merely contains the managed version', async () => {
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.25.0-beta.1', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile })

    await runtime.apply({ provider: 'claude', payload: '{}' })

    expect(execFile).toHaveBeenCalledWith('uv', [
      'tool', 'install', 'claude-swap==0.25.0', '--python', '>=3.12', '--force',
    ], expect.anything())
  })

  it('atomically applies Codex auth with mode 0600 and reports only login status', async () => {
    const chmod = vi.fn(async () => undefined)
    const { runtime, files, calls } = setup({ chmod })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).resolves.toEqual({
      provider: 'codex', configured: true, status: 'authenticated', applyGeneration: 1,
    })

    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"new-secret"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
    expect(chmod).toHaveBeenCalledWith('/home/operator/.codex/auth.json', 0o600)
    expect(calls.at(-1)).toEqual({ command: 'codex', args: ['login', 'status'] })
    expect(JSON.stringify(calls)).not.toContain('new-secret')
  })

  it('preserves the existing Codex auth when the backup cannot be created', async () => {
    let files!: Map<string, string>
    const rename = vi.fn(async (from: string, to: string) => {
      if (from.endsWith('ai-credential-apply-generations.json.happy-tmp')) {
        files.set(to, files.get(from)!)
        files.delete(from)
        return
      }
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const configured = setup({ rename })
    files = configured.files
    const { runtime } = configured
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({
      kind: 'CODEX_BACKUP_FAILED',
      message: 'AI credential operation failed (CODEX_BACKUP_FAILED) [applyGeneration=1]',
    })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
  })

  it('restores the existing Codex auth when successful-apply backup cleanup fails', async () => {
    let files!: Map<string, string>
    const configured = setup({
      rm: vi.fn(async (path: string) => {
        if (path.endsWith('auth.json.happy-backup')) throw new Error('permission denied')
        files.delete(path)
      }),
    })
    files = configured.files
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(configured.runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({ kind: 'CODEX_BACKUP_CLEANUP_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
  })

  it('removes a stale Codex backup after applying without a current auth file', async () => {
    const { runtime, files } = setup()
    files.set('/home/operator/.codex/auth.json.happy-backup', '{"OPENAI_API_KEY":"stale"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).resolves.toEqual({
      provider: 'codex', configured: true, status: 'authenticated', applyGeneration: 1,
    })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"new-secret"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
  })

  it('restores a stale Codex backup when its cleanup fails', async () => {
    let files!: Map<string, string>
    const configured = setup({
      rm: vi.fn(async (path: string) => {
        if (path.endsWith('auth.json.happy-backup')) throw new Error('permission denied')
        files.delete(path)
      }),
    })
    files = configured.files
    files.set('/home/operator/.codex/auth.json.happy-backup', '{"OPENAI_API_KEY":"stale"}')

    await expect(configured.runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({ kind: 'CODEX_BACKUP_CLEANUP_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"stale"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
  })

  it('restores the existing Codex auth when backup permission tightening fails', async () => {
    const chmod = vi.fn(async (path: string) => {
      if (path.endsWith('auth.json.happy-backup')) throw new Error('permission denied')
    })
    const { runtime, files } = setup({ chmod })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).rejects.toMatchObject({ kind: 'CODEX_BACKUP_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
    expect(files.has('/home/operator/.codex/auth.json.happy-backup')).toBe(false)
  })

  it('serializes concurrent applies so credential file replacements cannot overlap', async () => {
    let releaseFirst!: () => void
    const firstStatusBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
    let statusCalls = 0
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'codex' && args[0] === 'login') {
        statusCalls += 1
        if (statusCalls === 1) await firstStatusBlocked
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime, files } = setup({ execFile })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    const first = runtime.apply({ provider: 'codex', payload: '{"OPENAI_API_KEY":"one"}' })
    await vi.waitFor(() => expect(statusCalls).toBe(1))
    const second = runtime.apply({ provider: 'codex', payload: '{"OPENAI_API_KEY":"two"}' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(statusCalls).toBe(1)

    releaseFirst()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(statusCalls).toBe(2)
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"two"}')
    expect(firstResult).toMatchObject({ applyGeneration: 1 })
    expect(secondResult).toMatchObject({ applyGeneration: 2 })
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-apply-generations.json')!))
      .toEqual({ version: 1, generations: { codex: 2 } })
  })

  it('advances a restored apply counter to the current clock epoch', async () => {
    const now = 1_700_000_000_000
    const { runtime, files } = setup({ now: () => now })
    files.set('/home/operator/.happy/ai-credential-apply-generations.json', JSON.stringify({
      version: 1,
      generations: { codex: 7 },
    }))

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new-secret"}',
    })).resolves.toMatchObject({ applyGeneration: now * 1000 })
    expect(JSON.parse(files.get('/home/operator/.happy/ai-credential-apply-generations.json')!))
      .toEqual({ version: 1, generations: { codex: now * 1000 } })
  })

  it('serializes capture behind an in-progress credential replacement', async () => {
    let releaseWrite!: () => void
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve })
    let tempWriteStarted = false
    let files!: Map<string, string>
    const configured = setup({
      writeFile: vi.fn(async (path: string, content: string) => {
        if (path.endsWith('openai-codex-accounts.json.happy-tmp')) {
          tempWriteStarted = true
          await writeBlocked
        }
        files.set(path, content)
      }),
    })
    files = configured.files

    const apply = configured.runtime.apply({
      provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()),
    })
    await vi.waitFor(() => expect(tempWriteStarted).toBe(true))
    let captureSettled = false
    const capture = configured.runtime.capture({ provider: 'codex' })
      .finally(() => { captureSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(captureSettled).toBe(false)

    releaseWrite()
    await apply
    const captured = await capture
    expect(captured.provider).toBe('codex')
    expect(JSON.parse(captured.payload)).toMatchObject({
      kind: 'codex-multi-auth',
      packageVersion: '2.16.0',
      accounts: { version: 3 },
      settings: { pluginConfig: { schedulingStrategy: 'sequential' } },
    })
  })

  it('orders rotation changes after an in-progress Claude apply', async () => {
    let releaseList!: () => void
    const listBlocked = new Promise<void>((resolve) => { releaseList = resolve })
    const events: string[] = []
    const supervisor = {
      enable: vi.fn(async () => { events.push('enable') }),
      stop: vi.fn(async () => { events.push('stop') }),
      status: vi.fn(() => ({ state: 'running' as const, lastErrorKind: null })),
    }
    const execFile = vi.fn(async (command: string, args: string[]) => {
      if (command === 'cswap' && args[0] === '--version') {
        return { stdout: 'claude-swap 0.25.0', stderr: '' }
      }
      if (command === 'cswap' && args[0] === 'list') {
        events.push('verify')
        await listBlocked
        return { stdout: configuredClaudeList, stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })
    const { runtime } = setup({ execFile, supervisor })

    const apply = runtime.apply({ provider: 'claude', payload: '{}' })
    await vi.waitFor(() => expect(events).toEqual(['verify']))
    const stop = runtime.rotation({ action: 'stop' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(['verify'])

    releaseList()
    await Promise.all([apply, stop])
    expect(events).toEqual(['verify', 'enable', 'stop'])
  })

  it('restores Codex auth and reports rollback failure when temporary cleanup fails', async () => {
    let files!: Map<string, string>
    const configured = setup({
      execFile: vi.fn(async (command: string) => {
        if (command === 'codex') throw new Error('not authenticated')
        return { stdout: '', stderr: '' }
      }),
      rm: vi.fn(async (path: string) => {
        if (path.endsWith('.auth.json.happy-tmp')) throw new Error('cleanup failed')
        files.delete(path)
      }),
    })
    files = configured.files
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(configured.runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new"}',
    })).rejects.toMatchObject({ kind: 'CODEX_APPLY_ROLLBACK_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
  })

  it('reports rollback failure when a rejected Codex auth cannot be removed', async () => {
    let files!: Map<string, string>
    const configured = setup({
      execFile: vi.fn(async (command: string) => {
        if (command === 'codex') throw new Error('not authenticated')
        return { stdout: '', stderr: '' }
      }),
      rm: vi.fn(async (path: string) => {
        if (path.endsWith('/auth.json')) throw new Error('permission denied')
        files.delete(path)
      }),
    })
    files = configured.files

    await expect(configured.runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"rejected"}',
    })).rejects.toMatchObject({ kind: 'CODEX_APPLY_ROLLBACK_FAILED' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"rejected"}')
  })

  it('preserves a concrete Codex command error after restoring the previous auth', async () => {
    const { runtime, files } = setup({
      execFile: vi.fn(async (command: string) => {
        if (command === 'codex') throw new AiCredentialRuntimeError('COMMAND_NOT_AVAILABLE')
        return { stdout: '', stderr: '' }
      }),
    })
    files.set('/home/operator/.codex/auth.json', '{"OPENAI_API_KEY":"old"}')

    await expect(runtime.apply({
      provider: 'codex', payload: '{"OPENAI_API_KEY":"new"}',
    })).rejects.toMatchObject({ kind: 'COMMAND_NOT_AVAILABLE' })
    expect(files.get('/home/operator/.codex/auth.json')).toBe('{"OPENAI_API_KEY":"old"}')
  })

  it('redacts Claude account status instead of returning command output', async () => {
    const { runtime } = setup()

    await expect(runtime.status({ provider: 'claude' })).resolves.toEqual({
      provider: 'claude',
      configured: true,
      accountCount: 1, activeAccountStatus: 'unknown', usableAccountCount: 0, reloginRequiredAccountCount: 0,
      credentialKind: 'oauth',
      activeAccount: 'o***@example.com',
      rotation: { state: 'running', lastErrorKind: null },
    })
  })

  it('reports an active Claude API key as rotation-not-applicable', async () => {
    const { runtime, supervisor } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: 2,
          accounts: [{
            number: 2,
            email: 'api-key-aabbcc@token.local',
            usageStatus: 'api_key',
          }],
        }),
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).resolves.toEqual({
      provider: 'claude',
      configured: true,
      accountCount: 1, activeAccountStatus: 'api-key', usableAccountCount: 1, reloginRequiredAccountCount: 0,
      credentialKind: 'api_key',
      activeAccount: 'a***@token.local',
      rotation: { state: 'not-applicable', lastErrorKind: null },
    })
    await expect(runtime.rotation({ action: 'start' })).resolves.toMatchObject({
      credentialKind: 'api_key',
      rotation: { state: 'not-applicable' },
    })
    expect(supervisor.enable).not.toHaveBeenCalled()
    expect(supervisor.stop).toHaveBeenCalledOnce()
  })

  it('reports managed Codex routing with the least-remaining active account masked', async () => {
    const { runtime, files } = setup({
      codexProxyStatus: vi.fn(() => ({ activeRoutes: 1 })),
      execFile: vi.fn(async (command: string, args: string[]) => {
        if (command === 'codex-multi-auth' && args[0] === '--version') {
          return { stdout: '2.16.0\n', stderr: '' }
        }
        if (command === 'npm' && args[0] === 'root') {
          return { stdout: '/global/node_modules\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      }),
    })
    const bundle = codexMultiAuthBundle()
    bundle.accounts.accounts = [
      bundle.accounts.accounts[1]!,
      bundle.accounts.accounts[2]!,
      bundle.accounts.accounts[0]!,
    ]
    files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify({
      version: 1,
      pluginConfig: {
        codexRuntimeRotationProxy: true,
        schedulingStrategy: 'sequential',
        preemptiveQuotaEnabled: true,
        preemptiveQuotaRemainingPercent5h: 5,
        preemptiveQuotaRemainingPercent7d: 5,
        routingMutex: 'enabled',
        sessionAffinity: false,
        pidOffsetEnabled: false,
      },
    }))
    files.set('/home/operator/.codex/multi-auth/quota-cache.json', JSON.stringify({
      version: 1,
      byAccountId: {
        'account-a': { primary: { usedPercent: 40 }, secondary: { usedPercent: 20 } },
        'account-b': { primary: { usedPercent: 90 }, secondary: { usedPercent: 70 } },
        'account-c': { primary: { usedPercent: 60 }, secondary: { usedPercent: 30 } },
      },
    }))

    await expect(runtime.status({ provider: 'codex' })).resolves.toEqual({
      provider: 'codex',
      configured: true,
      accountCount: 3,
      activeAccount: 'b***@example.com',
      rotation: {
        state: 'running',
        lastErrorKind: null,
        strategy: 'sequential',
        threshold5h: 5,
        threshold7d: 5,
      },
    })
  })

  it('does not report direct Codex execution as routed rotation', async () => {
    const configured = setup({ codexProxyStatus: vi.fn(() => ({ activeRoutes: 0 })) })
    const bundle = codexMultiAuthBundle()
    configured.files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    configured.files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify({
      version: 1,
      pluginConfig: {
        codexRuntimeRotationProxy: true,
        schedulingStrategy: 'sequential',
        preemptiveQuotaEnabled: true,
        preemptiveQuotaRemainingPercent5h: 5,
        preemptiveQuotaRemainingPercent7d: 5,
        routingMutex: 'enabled',
        sessionAffinity: false,
        pidOffsetEnabled: false,
      },
    }))
    configured.files.set('/home/operator/.codex/multi-auth/quota-cache.json', JSON.stringify({
      version: 1,
      byAccountId: Object.fromEntries(bundle.accounts.accounts.map((account) => [
        account.accountId,
        { primary: { usedPercent: 50 }, secondary: { usedPercent: 40 } },
      ])),
    }))

    await expect(configured.runtime.status({ provider: 'codex' })).resolves.toMatchObject({
      rotation: { state: 'not-routed' },
    })
  })

  it('reports unknown Codex quota without guessing a rotation account', async () => {
    const configured = setup({ codexProxyStatus: vi.fn(() => ({ activeRoutes: 1 })) })
    const bundle = codexMultiAuthBundle()
    configured.files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    configured.files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify({
      version: 1,
      pluginConfig: {
        codexRuntimeRotationProxy: true,
        schedulingStrategy: 'sequential',
        preemptiveQuotaEnabled: true,
        preemptiveQuotaRemainingPercent5h: 5,
        preemptiveQuotaRemainingPercent7d: 5,
        routingMutex: 'enabled',
        sessionAffinity: false,
        pidOffsetEnabled: false,
      },
    }))

    await expect(configured.runtime.status({ provider: 'codex' })).resolves.toMatchObject({
      accountCount: 3,
      rotation: { state: 'quota-unknown' },
    })
  })

  it('rejects Codex status when the npm-global runtime package is missing', async () => {
    const configured = setup()
    configured.files.delete('/global/node_modules/codex-multi-auth/package.json')
    const bundle = codexMultiAuthBundle()
    configured.files.set('/home/operator/.codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    configured.files.set('/home/operator/.codex/multi-auth/settings.json', JSON.stringify(bundle.settings))

    await expect(configured.runtime.status({ provider: 'codex' })).rejects.toMatchObject({
      kind: 'CODEX_MULTI_AUTH_VERSION_MISMATCH',
    })
  })

  it('reports an empty Claude account list as not configured', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: '{"schemaVersion":1,"activeAccountNumber":null,"accounts":[]}',
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).resolves.toMatchObject({
      provider: 'claude',
      configured: false,
      activeAccount: null,
    })
  })

  it('bootstraps claude-swap before starting rotation directly', async () => {
    const { runtime, calls, supervisor } = setup()

    await runtime.rotation({ action: 'start' })

    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      ['uv', ['--version']],
      ['uv', ['python', 'find', '>=3.12']],
      ['cswap', ['--version']],
      ['cswap', ['config', 'set', 'autoswitch.threshold', '95']],
      ['cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first']],
      ['cswap', ['list', '--json']],
    ])
    expect(supervisor.enable).toHaveBeenCalledOnce()
  })

  it('redacts unexpected dependency errors at the RPC boundary', async () => {
    const { runtime } = setup({
      makeTempDir: vi.fn(async () => { throw new Error('token=secret-value') }),
    })

    const error = await runtime.apply({ provider: 'claude', payload: '{}' }).catch((caught) => caught)
    expect(error).toMatchObject({ kind: 'CLAUDE_APPLY_FAILED' })
    expect(String(error)).not.toContain('secret-value')
  })

  it('rejects malformed Claude list output instead of reporting configured', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({ stdout: '{"schemaVersion":1,"error":{"message":"secret"}}', stderr: '' })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('rejects malformed Claude account identity fields', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: 1,
          accounts: [{ number: 1, email: 'owner@example.com', organizationUuid: 42 }],
        }),
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('rejects duplicate Claude account slot numbers', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: 1,
          accounts: [
            { number: 1, email: 'first@example.com', organizationUuid: 'first-org' },
            { number: 1, email: 'second@example.com', organizationUuid: 'second-org' },
          ],
        }),
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('rejects non-positive Claude account slot numbers', async () => {
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: null,
          accounts: [{ number: 0, email: 'owner@example.com', organizationUuid: 'org' }],
        }),
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('rejects Claude account slot numbers outside the safe integer range', async () => {
    const unsafeSlot = Number.MAX_SAFE_INTEGER + 1
    const { runtime } = setup({
      execFile: vi.fn(async () => ({
        stdout: JSON.stringify({
          schemaVersion: 1,
          activeAccountNumber: unsafeSlot,
          accounts: [{
            number: unsafeSlot,
            email: 'owner@example.com',
            organizationUuid: 'org',
          }],
        }),
        stderr: '',
      })),
    })

    await expect(runtime.status({ provider: 'claude' })).rejects.toMatchObject({
      kind: 'CLAUDE_STATUS_INVALID',
    })
  })

  it('applies Claude credentials when uv is installed outside the daemon PATH', async () => {
    const baseline = setup()
    const environment = { Path: join(homedir(), 'system-bin'), UV_TOOL_BIN_DIR: '/separate-tools' }
    const spawnCommand = vi.fn((_command, _args, options) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      })
      queueMicrotask(() => {
        if (!options.env?.Path?.split(delimiter).includes(join(homedir(), '.local', 'bin'))) {
          child.emit('error', Object.assign(new Error('uv not found'), { code: 'ENOENT' }))
        } else {
          child.emit('close', 0)
        }
      })
      return child
    }) as unknown as typeof spawn
    const { runtime, supervisor } = setup({
      execFile: (command, args, options) => command === 'uv'
        ? runAiCredentialCommand(command, args, { ...options, environment }, spawnCommand)
        : baseline.execFile(command, args, options),
    })

    await expect(runtime.apply({ provider: 'claude', payload: '{"token":"never-in-argv"}' }))
      .resolves.toMatchObject({ provider: 'claude', configured: true })
    expect(supervisor.enable).toHaveBeenCalledOnce()
    expect(environment.Path).toBe(join(homedir(), 'system-bin'))
  })

  it.each([
    ['uv', {}, join(homedir(), '.local', 'bin')],
    ['uv', { UV_INSTALL_DIR: '/uv-bin', UV_TOOL_BIN_DIR: '/tool-bin' }, '/uv-bin'],
    ['uv', { XDG_BIN_HOME: '/xdg-bin', UV_TOOL_BIN_DIR: '/tool-bin' }, '/xdg-bin'],
    ['cswap', { UV_INSTALL_DIR: '/uv-bin', UV_TOOL_BIN_DIR: '/tool-bin' }, '/tool-bin'],
  ] as const)('resolves %s using its own installation directory (%j)', async (command, overrides, binDir) => {
    const environment = { Path: ['/system-bin', binDir].join(delimiter), ...overrides }
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn
    const result = runAiCredentialCommand(command, ['--version'], { environment }, spawnCommand)
    child.emit('close', 0)
    await result

    expect(spawnCommand).toHaveBeenCalledWith(command, ['--version'], expect.objectContaining({
      env: { ...environment, Path: [binDir, '/system-bin'].join(delimiter) },
      windowsHide: true,
    }))
    expect(environment.Path).toBe(['/system-bin', binDir].join(delimiter))
  })

  it.each([
    ['ENOENT', 'COMMAND_NOT_AVAILABLE'],
    ['EACCES', 'COMMAND_FAILED'],
    ['EPERM', 'COMMAND_FAILED'],
    ['EINVAL', 'COMMAND_FAILED'],
  ])('reports %s from credential command startup as %s without leaking output', async (code, kind) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn
    const result = runAiCredentialCommand('uv', ['--version'], {}, spawnCommand)
    child.stderr.emit('data', Buffer.from('secret-from-stderr'))
    child.emit('error', Object.assign(new Error('secret-from-error'), { code }))

    await expect(result).rejects.toMatchObject({ kind, message: `AI credential operation failed (${kind})` })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('terminates commands that exceed their timeout without returning process output', async () => {
    await expect(runAiCredentialCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 20 },
    )).rejects.toMatchObject({ kind: 'COMMAND_TIMED_OUT' })
  })

  it.skipIf(process.platform === 'win32')('terminates the native child of a one-shot CLI wrapper on timeout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'one-shot-tree-test-'))
    const pidFile = join(directory, 'child.pid')
    let descendant = 0
    try {
      const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('node:fs').writeFileSync(process.argv[1],String(c.pid)); setInterval(()=>{},1000)`
      await expect(runAiCredentialCommand(process.execPath, ['-e', script, pidFile], { timeoutMs: 500, terminateProcessTree: true })).rejects.toMatchObject({ kind: 'COMMAND_TIMED_OUT' })
      descendant = Number(await readTestFile(pidFile, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow(), { timeout: 3000 })
    } finally {
      if (descendant > 0) { try { process.kill(descendant, 'SIGKILL') } catch {} }
      await removeTestDirectory(directory, { recursive: true, force: true })
    }
  })

  it('waits for command stdio to close before returning captured output', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn

    const result = runAiCredentialCommand('cswap', ['export', '-'], {}, spawnCommand)
    expect(spawnCommand).toHaveBeenCalledWith('cswap', ['export', '-'], {
      env: expect.any(Object),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.emit('exit', 0)
    child.stdout.emit('data', Buffer.from('{"complete":true}'))
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ stdout: '{"complete":true}', stderr: '' })
  })

  it('pipes fixed confirmation input to interactive credential commands', async () => {
    const stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn

    const result = runAiCredentialCommand('cswap', ['remove', '1'], {
      input: 'y\n',
    }, spawnCommand)

    expect(spawnCommand).toHaveBeenCalledWith('cswap', ['remove', '1'], {
      env: expect.any(Object),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    expect(stdin.end).toHaveBeenCalledWith('y\n')
    child.emit('close', 0)
    await expect(result).resolves.toEqual({ stdout: '', stderr: '' })
  })

  it('caps stdout and stderr independently so diagnostics do not consume the payload budget', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn

    const result = runAiCredentialCommand('cswap', ['export', '-'], {
      maxOutputBytes: 4,
    }, spawnCommand)
    child.stdout.emit('data', Buffer.from('1234'))
    child.stderr.emit('data', Buffer.from('note'))
    child.emit('close', 0)

    await expect(result).resolves.toEqual({ stdout: '1234', stderr: 'note' })
  })

  it('returns a nonzero exit code only when the caller explicitly accepts it', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const spawnCommand = vi.fn(() => child) as unknown as typeof spawn
    const result = runAiCredentialCommand('claude', ['--print'], {
      acceptNonZeroExit: true,
    }, spawnCommand)

    child.stdout.emit('data', Buffer.from('{"result":"CLAUDE_AUTH_OK"}'))
    child.emit('close', 1)

    await expect(result).resolves.toEqual({
      stdout: '{"result":"CLAUDE_AUTH_OK"}',
      stderr: '',
      exitCode: 1,
    })
  })

  it('does not let the uv tool bin shadow non-cswap commands', async () => {
    const previousPath = process.env.PATH
    const previousToolBin = process.env.UV_TOOL_BIN_DIR
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    })
    const spawnCommand = vi.fn((
      _command: string,
      _args: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      spawnedEnvironment = options.env
      return child
    }) as unknown as typeof spawn

    try {
      process.env.PATH = '/usr/bin'
      process.env.UV_TOOL_BIN_DIR = '/managed/bin'
      const result = runAiCredentialCommand('codex', ['login', 'status'], {}, spawnCommand)
      expect(spawnedEnvironment?.PATH).toBe('/usr/bin')
      child.emit('close', 0)
      await expect(result).resolves.toEqual({ stdout: '', stderr: '' })
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousToolBin === undefined) delete process.env.UV_TOOL_BIN_DIR
      else process.env.UV_TOOL_BIN_DIR = previousToolBin
    }
  })
})

describe('org deployment provenance (specs/agent-ai-source-routing observation increment)', () => {
  const HOME = '/home/operator'
  const provenance = { companyId: 'co-1', bundleId: 'bundle-1', bundleVersion: 3 }

  /** cswap that imports one OAuth account and reports it active once switched. */
  function workingClaudeExecFile(options: { failVerification?: boolean } = {}) {
    let activated = false
    return vi.fn(async (command: string, args: string[]): Promise<AiCredentialCommandResult> => {
      if (command === 'cswap' && args[0] === '--version') return { stdout: 'cswap 0.25.0', stderr: '' }
      if (command === 'cswap' && args[0] === 'switch') activated = true
      if (command === 'cswap' && args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            schemaVersion: 1,
            activeAccountNumber: 7,
            accounts: [{
              number: 7,
              email: options.failVerification ? 'someone-else@example.com' : 'owner@example.com',
              organizationUuid: 'org-a',
              organizationName: 'Corp Inc',
              usageStatus: activated ? 'ok' : 'relogin_required',
            }],
          }),
          stderr: '',
        }
      }
      if (command === 'npm' && args[0] === 'root') return { stdout: '/global/node_modules\n', stderr: '' }
      if (command === 'codex-multi-auth' && args[0] === '--version') return { stdout: '2.16.0\n', stderr: '' }
      return { stdout: '', stderr: '' }
    })
  }

  // The outer export names the organization differently from what cswap
  // imported: the record must carry what was verified after the import, since
  // that is what the login metadata and accountInfo() will report.
  const payload = claudeOauthPayload([
    { email: 'owner@example.com', organizationUuid: 'org-a', organizationName: 'Outer Name' },
  ])

  async function recorded(files: Map<string, string>) {
    const { readActiveClaudeProvenance } = await import('./aiCredentialProvenance')
    return readActiveClaudeProvenance({
      homeDir: HOME,
      readFile: async (path) => files.get(path)
        ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    })
  }

  /** The raw record on disk — "records nothing" must hold for the file, not only for the reader. */
  function wroteAppliedRecord(files: Map<string, string>): boolean {
    const raw = files.get(`${HOME}/.happy/ai-credential-provenance.json`)
    if (raw === undefined) return false
    return (JSON.parse(raw) as { claude?: { state?: string } }).claude?.state === 'applied'
  }

  it('records the deployment and the verified account identities after a successful apply', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })

    const response = await runtime.apply({ provider: 'claude', payload, provenance })

    await expect(recorded(files)).resolves.toEqual({
      ...provenance,
      generation: response.applyGeneration,
      identities: new Set([JSON.stringify(['owner@example.com', 'org-a', 'Corp Inc'])]),
    })
  })

  it('does not put the account identities in the RPC response — they would reach the server', async () => {
    const { runtime } = setup({ execFile: workingClaudeExecFile() })
    const response = await runtime.apply({ provider: 'claude', payload, provenance })
    expect(JSON.stringify(response)).not.toContain('owner@example.com')
  })

  it('records nothing when the server sent no provenance (trial, older server)', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({ provider: 'claude', payload })
    await expect(recorded(files)).resolves.toBeNull()
    expect(wroteAppliedRecord(files)).toBe(false)
  })

  it('records nothing for a malformed provenance', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({ provider: 'claude', payload, provenance: { ...provenance, bundleVersion: 0 } })
    await expect(recorded(files)).resolves.toBeNull()
    expect(wroteAppliedRecord(files)).toBe(false)
  })

  it('records nothing when the bundle accounts cannot be identified — nothing was verified', async () => {
    // An encrypted export hides the account list, so applyClaude skips the
    // identity check. The apply still succeeds; it just proves nothing.
    const { runtime, files } = setup()
    await expect(runtime.apply({
      provider: 'claude',
      payload: JSON.stringify({ version: 1, encrypted: true, data: 'opaque' }),
      provenance,
    })).resolves.toMatchObject({ provider: 'claude', configured: true })
    await expect(recorded(files)).resolves.toBeNull()
    expect(wroteAppliedRecord(files)).toBe(false)
  })

  it('records nothing for a trial lease, even if provenance came along', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({
      provider: 'claude',
      payload,
      provenance,
      trialLease: { leaseId: 'lease-1', contentHash: 'a'.repeat(64), bundleVersion: 1 },
    })
    await expect(recorded(files)).resolves.toBeNull()
    expect(wroteAppliedRecord(files)).toBe(false)
  })

  it('drops an earlier record when a later apply fails verification', async () => {
    const execFile = workingClaudeExecFile()
    const { runtime, files } = setup({ execFile })
    await runtime.apply({ provider: 'claude', payload, provenance })
    await expect(recorded(files)).resolves.not.toBeNull()

    const failing = workingClaudeExecFile({ failVerification: true })
    execFile.mockImplementation(failing)
    await expect(runtime.apply({ provider: 'claude', payload, provenance })).rejects.toThrow()

    await expect(recorded(files)).resolves.toBeNull()
  })

  it('drops the Claude record when a Z.AI lease replaces the Claude credential', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({ provider: 'claude', payload, provenance })

    await runtime.apply({
      provider: 'zai',
      payload: JSON.stringify({ version: 1, kind: 'zai-anthropic', apiKey: 'zai-secret-key' }),
    })

    await expect(recorded(files)).resolves.toBeNull()
  })

  it('fences off the Claude record on a Z.AI apply even when the invalidation write fails', async () => {
    // A Z.AI lease purges the Claude login. The explicit invalidation is only a
    // write, and writes can fail; the generation bump is what makes it certain.
    const { runtime, files, writeFile } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({ provider: 'claude', payload, provenance })
    await expect(recorded(files)).resolves.not.toBeNull()

    const original = writeFile.getMockImplementation()!
    writeFile.mockImplementation(async (path: string, content: string) => {
      if (path.includes('ai-credential-provenance')) throw new Error('disk full')
      return original(path, content)
    })
    await runtime.apply({
      provider: 'zai',
      payload: JSON.stringify({ version: 1, kind: 'zai-anthropic', apiKey: 'zai-secret-key' }),
    })

    await expect(recorded(files)).resolves.toBeNull()
  })

  it('keeps the Claude record when only the Codex credential changes', async () => {
    const { runtime, files } = setup({ execFile: workingClaudeExecFile() })
    await runtime.apply({ provider: 'claude', payload, provenance })

    await runtime.apply({ provider: 'codex', payload: JSON.stringify(codexMultiAuthBundle()) }).catch(() => undefined)

    await expect(recorded(files)).resolves.not.toBeNull()
  })

  it('still applies the credential when the record cannot be written, and says so', async () => {
    const warn = vi.fn()
    const { runtime, writeFile } = setup({ execFile: workingClaudeExecFile(), warn })
    // Wrap the harness writer so every other file still lands in its map.
    const original = writeFile.getMockImplementation()!
    writeFile.mockImplementation(async (path: string, content: string) => {
      if (path.includes('ai-credential-provenance')) throw new Error('disk full')
      return original(path, content)
    })

    await expect(runtime.apply({ provider: 'claude', payload, provenance }))
      .resolves.toMatchObject({ provider: 'claude', configured: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provenance'))
  })
})

describe('resident personal runtime wiring',()=>{
 it('uses generation CAS and cancels the pending collect before applying revocation',async()=>{
  const ref='11111111-1111-4111-8111-111111111111';let enabled=true;let collecting=false;let aborted=false
  const row=()=>({accountRef:ref,credentialGeneration:1,number:1,roster:{email:'personal@token.local',organizationUuid:'',uuid:''},credentialType:'setup_token',probeEnabled:enabled,authState:'usable',usageStatus:'partial',reasonCodes:['coverage_unknown'],probeBudget:{scope:'local-per-token',accountUsed24h:0,accountLimit24h:96,accountRemaining24h:96,nextProbeAt:null,failureStreak:0,minIntervalSeconds:300,recommendedIntervalSeconds:900}})
  const invoke=vi.fn(async(_command:string,args:string[],options?:{signal?:AbortSignal})=>{
   if(options?.signal?.aborted)throw new Error('cancelled')
   if(args[1]==='capabilities')return {stdout:JSON.stringify({artifact:'saycode-setup-token-runtime-v1',setupTokenObservation:true,durableProbeBudget:true,personalProbeVersion:1}),stderr:''}
   if(args[1]==='status')return {stdout:JSON.stringify({accounts:[row()],budget:{machineUsed24h:0,machineLimit24h:288,machineRemaining24h:288,machineSlotFreesAt:null,accountLimit24h:96}}),stderr:''}
   if(args[1]==='collect'){
    expect(args).toContain('--generation');collecting=true
    await new Promise<void>(resolve=>options?.signal?.addEventListener('abort',()=>{aborted=true;resolve()}))
    throw new Error('cancelled')
   }
   if(args[1]==='consent'){expect(aborted).toBe(true);enabled=false;return {stdout:'{}',stderr:''}}
   throw new Error('unexpected command')
  })
  const {runtime}=setup({execFile:invoke,now:()=>1000000})
  await runtime.personalSchedulerTick({online:true,inUse:true})
  await vi.waitFor(()=>expect(collecting).toBe(true))
  expect(await runtime.tokenProbe({version:1,operation:'consent',accountRef:ref,credentialGeneration:1,enabled:false})).toMatchObject({enabled:false,scope:'personal'})
  expect(aborted).toBe(true)
  runtime.stopPersonalScheduler()
 })
 it('cancels a native command without returning buffered output',async()=>{
  const controller=new AbortController()
  const pending=runAiCredentialCommand(process.execPath,['-e','process.stdout.write("private"); setInterval(()=>{},1000)'],{signal:controller.signal,timeoutMs:5000})
  setTimeout(()=>controller.abort(),20)
  await expect(pending).rejects.toMatchObject({kind:'COMMAND_CANCELLED'})
 })
})

it.each(['OFF','offline'])('fences manual collection queued behind organization work when %s arrives before execution',async(action)=>{
 const ref='11111111-1111-4111-8111-111111111111';let enabled=true;let entered=false;let release!:()=>void
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Promise<Response>(resolve=>{entered=true;release=()=>resolve(new Response('{}',{status:503}))}))
 const invoke=vi.fn(async(_command:string,args:string[])=>{
  if(args[1]==='capabilities')return {stdout:JSON.stringify({artifact:'saycode-setup-token-runtime-v1',setupTokenObservation:true,durableProbeBudget:true,personalProbeVersion:1}),stderr:''}
  if(args[1]==='status')return {stdout:JSON.stringify({accounts:[{accountRef:ref,credentialGeneration:1,number:1,roster:{email:'personal@token.local',organizationUuid:'',uuid:''},credentialType:'setup_token',probeEnabled:enabled,authState:'usable',usageStatus:'partial',reasonCodes:['coverage_unknown'],probeBudget:{scope:'local-per-token',accountUsed24h:0,accountLimit24h:96,accountRemaining24h:96,nextProbeAt:null,failureStreak:0,minIntervalSeconds:300,recommendedIntervalSeconds:900}}],budget:{machineUsed24h:0,machineLimit24h:288,machineRemaining24h:288,machineSlotFreesAt:null,accountLimit24h:96}}),stderr:''}
  if(args[1]==='consent')enabled=false
  return {stdout:'{}',stderr:''}
 })
 const {runtime}=setup({execFile:invoke,env:{HAPPY_APLUS_STUDIO_ORIGIN:'https://studio.test'}})
 try {
  const org=runtime.collectorProbe({version:1,companyId:'c',userId:'u',machineId:'m',managedAccountId:ref,accountRef:ref,credentialGeneration:1,policyRevision:1,permitId:ref,grant:'a.b'},'m')
  await vi.waitFor(()=>expect(entered).toBe(true))
  const queued=runtime.tokenProbe({version:1,operation:'collect',accountRef:ref,credentialGeneration:1})
  const off=action==='OFF'?runtime.tokenProbe({version:1,operation:'consent',accountRef:ref,credentialGeneration:1,enabled:false}):runtime.personalSchedulerTick({online:false,inUse:false})
  expect(invoke).not.toHaveBeenCalled()
  release();await org
  expect(await queued).toMatchObject({status:action==='OFF'?'disabled':'unavailable',error:'TOKEN_PROBE_CANCELLED'})
  if(action==='OFF')expect(await off).toMatchObject({enabled:false,status:'disabled'})
  else await off
  expect(invoke.mock.calls.filter(([,args])=>args[1]==='collect')).toHaveLength(0)
  expect(invoke.mock.calls.map(([,args])=>args[1])).toEqual(action==='OFF'?['capabilities','status','consent','status']:[])
 }finally{release?.();fetcher.mockRestore();runtime.stopPersonalScheduler()}
})

describe('cswap collector command options', () => {
  it('gives collect-org a 30 s outer bound with process-tree termination; metadata reads keep 10 s', async () => {
    const { cswapCollectorCommandOptions } = await import('./aiCredentialRuntime')
    expect(cswapCollectorCommandOptions(['token-runtime', 'collect-org'])).toMatchObject({ timeoutMs: 30_000, terminateProcessTree: true })
    for (const read of [['token-runtime', 'capabilities'], ['token-runtime', 'status']]) {
      const options = cswapCollectorCommandOptions(read)
      expect(options.timeoutMs).toBe(10_000)
      expect(options.terminateProcessTree).toBeUndefined()
    }
  })

  it('is what the collector adapter uses for every cswap call', async () => {
    const source = await readTestFile(join(__dirname, 'aiCredentialRuntime.ts'), 'utf8')
    expect(source).toMatch(/invoke: async \(args, input\) => \(await deps\.execFile\('cswap', args, \{\s*input, \.\.\.cswapCollectorCommandOptions\(args\), environment: deps\.env,/)
  })
})
