import { describe, expect, it, vi } from 'vitest'
import { verifyLocalAiAccounts } from './aiCredentialVerification'
import type { AiCredentialRuntimeDependencies } from './aiCredentialRuntime'

function setup(stdout = JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' })) {
  const files = new Map<string, string>()
  const deps = {
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'personal-secret', OPENAI_API_KEY: 'personal-secret', ANTHROPIC_BASE_URL: 'http://wrong' },
    now: () => 1000,
    makeTempDir: vi.fn(async () => '/tmp/probe'),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, content: string) => { files.set(path, content) }),
    rm: vi.fn(async () => {}),
    execFile: vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 })),
  } as unknown as AiCredentialRuntimeDependencies
  return { deps, files }
}
const account = { email: 'shared@example.com', credentials: { claudeAiOauth: { accessToken: 'shared-token', refreshToken: 'must-not-refresh' } }, config: {} }

describe('shared account one-shot verification', () => {
  it('uses only the matching local account in an isolated home and removes it after success', async () => {
    const { deps, files } = setup()
    const result = await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])
    expect(result.accounts[0]).toMatchObject({ ok: true, model: 'haiku' })
    const [command, args, options] = vi.mocked(deps.execFile).mock.calls[0]
    expect(command).toBe('claude')
    expect(args).toEqual(expect.arrayContaining(['--print', '--no-session-persistence', '--tools', '', '--model', 'haiku']))
    expect(options?.environment?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(options?.environment?.OPENAI_API_KEY).toBeUndefined()
    expect(options?.environment?.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(options?.environment?.HOME).toBe('/tmp/probe')
    expect(files.get('/tmp/probe/.claude/.credentials.json')).toContain('shared-token')
    expect(files.get('/tmp/probe/.claude/.credentials.json')).not.toContain('must-not-refresh')
    expect(JSON.stringify(args)).not.toContain('shared-token')
    expect(deps.rm).toHaveBeenCalledWith('/tmp/probe', { recursive: true, force: true })
  })
  it('caps each request by the remaining stage budget and skips accounts after it expires', async () => {
    const { deps } = setup()
    let now = 1000
    deps.now = () => now
    vi.mocked(deps.execFile).mockImplementation(async (_command, _args, options) => {
      expect(options?.timeoutMs).toBe(5000)
      now += 5000
      return { stdout: JSON.stringify({ type: 'result', is_error: false, result: 'SHARED_AI_OK' }), stderr: '', exitCode: 0 }
    })
    const second = { ...account, email: 'second@example.com' }
    const result = await verifyLocalAiAccounts(deps, 'claude', [account, second], [account, second], { budgetMs: 5000 })
    expect(result.accounts).toMatchObject([{ ok: true }, { ok: false, errorKind: 'VERIFICATION_TIMEOUT' }])
    expect(deps.execFile).toHaveBeenCalledTimes(1)
  })

  it('does not start a fallback model request once the stage budget is exhausted', async () => {
    const { deps } = setup()
    let now = 1000
    deps.now = () => now
    vi.mocked(deps.execFile).mockImplementation(async () => {
      now += 5000
      return { stdout: '', stderr: 'model haiku is not available', exitCode: 1 }
    })
    const result = await verifyLocalAiAccounts(deps, 'claude', [account], [account], { budgetMs: 5000 })
    expect(result.accounts[0]).toMatchObject({ ok: false, errorKind: 'VERIFICATION_TIMEOUT' })
    expect(deps.execFile).toHaveBeenCalledTimes(1)
  })

  it('does not validate the personal account when the shared identity is missing', async () => {
    const { deps } = setup()
    const result = await verifyLocalAiAccounts(deps, 'claude', [{ email: 'missing@example.com' }], [account])
    expect(result.accounts[0]).toMatchObject({ ok: false, errorKind: 'ACCOUNT_NOT_INSTALLED' })
    expect(deps.execFile).not.toHaveBeenCalled()
  })
  it('rejects exit-zero error responses and cleans up on command failure', async () => {
    const { deps } = setup(JSON.stringify({ type: 'result', is_error: true, result: 'SHARED_AI_OK' }))
    expect((await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])).accounts[0].ok).toBe(false)
    vi.mocked(deps.execFile).mockRejectedValue(new Error('secret-token network failure'))
    const result = await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])
    expect(result.accounts[0]).toMatchObject({ ok: false, errorKind: 'REQUEST_FAILED' })
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(deps.rm).toHaveBeenCalledTimes(2)
  })
  it('requires a completed Codex turn and actual assistant response using ephemeral low-effort Luna', async () => {
    const { deps, files } = setup('{"type":"item.completed","item":{"type":"agent_message","text":"SHARED_AI_OK"}}\n{"type":"turn.completed"}\n')
    const local = { accountId: 'shared-id', email: account.email, accessToken: 'shared-access', refreshToken: 'shared-refresh' }
    const result = await verifyLocalAiAccounts(deps, 'codex', [{ accountId: 'shared-id' }], [local])
    expect(result.accounts[0]).toMatchObject({ ok: true, model: 'gpt-6-luna' })
    expect(vi.mocked(deps.execFile).mock.calls[0][1]).toEqual(expect.arrayContaining(['exec', '--ephemeral', '--json', 'gpt-6-luna', 'model_reasoning_effort="low"']))
    expect(JSON.parse(files.get('/tmp/probe/.codex/auth.json')!)).toEqual({ auth_mode: 'chatgptAuthTokens', access_token: 'shared-access', account_id: 'shared-id' })
    expect(files.get('/tmp/probe/.codex/auth.json')).not.toContain('shared-refresh')
    vi.mocked(deps.execFile).mockResolvedValue({ stdout: '{"type":"turn.completed"}', stderr: '', exitCode: 0 })
    expect((await verifyLocalAiAccounts(deps, 'codex', [{ accountId: 'shared-id' }], [local])).accounts[0].ok).toBe(false)
  })
  it('does not report success when temporary credential cleanup fails', async () => {
    const { deps } = setup()
    vi.mocked(deps.rm).mockRejectedValue(new Error('cleanup failed'))
    await expect(verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])).rejects.toThrow('cleanup failed')
  })
  it('distinguishes rejected authentication from an unavailable model without exposing provider output', async () => {
    const { deps } = setup()
    vi.mocked(deps.execFile).mockResolvedValue({ stdout: '', stderr: '401 Unauthorized: synthetic-secret', exitCode: 1 })
    const result = await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])
    expect(result.accounts[0]).toMatchObject({ ok: false, errorKind: 'AUTHENTICATION_FAILED' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })
  it('falls back only for an explicitly unavailable model, never for authentication failure', async () => {
    const { deps } = setup()
    vi.mocked(deps.execFile).mockResolvedValueOnce({ stdout: '', stderr: 'model haiku is not available', exitCode: 1 })
    expect((await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])).accounts[0].model).toBe('sonnet')
    vi.mocked(deps.execFile).mockClear().mockResolvedValue({ stdout: '', stderr: 'Unauthorized: model haiku is not available', exitCode: 1 })
    expect((await verifyLocalAiAccounts(deps, 'claude', [{ email: account.email }], [account])).accounts[0].ok).toBe(false)
    expect(deps.execFile).toHaveBeenCalledTimes(1)
  })
})
