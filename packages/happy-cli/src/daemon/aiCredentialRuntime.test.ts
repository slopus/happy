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

function claudeOauthPayload(accounts: Array<{ email: string; organizationUuid?: string }>): string {
  return JSON.stringify({
    version: 1,
    encrypted: false,
    activeAccountNumber: 1,
    accounts: accounts.map((account, index) => ({
      number: index + 1,
      email: account.email,
      organizationUuid: account.organizationUuid ?? '',
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

  it('captures the fixed Codex multi-auth account pool and settings as one versioned bundle', async () => {
    const { runtime, files } = setup({ env: { CODEX_HOME: '/fixed/codex' } })
    const bundle = codexMultiAuthBundle()
    files.set('/fixed/codex/multi-auth/openai-codex-accounts.json', JSON.stringify(bundle.accounts))
    files.set('/fixed/codex/multi-auth/settings.json', JSON.stringify(bundle.settings))

    const captured = await runtime.capture({ provider: 'codex' })

    expect(captured.provider).toBe('codex')
    expect(JSON.parse(captured.payload)).toEqual(bundle)
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

  it('applies a Codex bundle captured by the previous 2.15.0 pin because its storage format is unchanged', async () => {
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
      payload: JSON.stringify({ ...codexMultiAuthBundle(), packageVersion: '2.15.0' }),
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
