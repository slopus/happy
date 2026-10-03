import { join } from 'node:path'
import type { AiCredentialCommandResult, AiCredentialRuntimeDependencies } from './aiCredentialRuntime'

export type VerificationIdentity = { email?: string; organizationUuid?: string; accountId?: string }
export type AccountVerification = { account: number; ok: boolean; model?: string; errorKind?: string }
const SENTINEL = 'SHARED_AI_OK'
const PROMPT = `Reply with exactly ${SENTINEL}. Do not use tools.`

// Only network/runtime settings survive. Inherited credentials, routing and
// user configuration must never make a different account pass this probe.
function isolatedEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
    if (env[key] !== undefined) result[key] = env[key]
  }
  return { ...result, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
}

function successful(provider: 'claude' | 'codex', response: AiCredentialCommandResult): boolean {
  if (response.exitCode !== 0) return false
  try {
    if (provider === 'claude') {
      const result = JSON.parse(response.stdout)
      return result.type === 'result' && result.is_error === false && result.result?.trim() === SENTINEL
    }
    const events = response.stdout.trim().split('\n').map(line => JSON.parse(line))
    return !events.some(event => event.type === 'turn.failed' || event.type === 'error'
      || (event.type === 'item.completed' && !['agent_message', 'reasoning'].includes(event.item?.type)))
      && events.some(event => event.type === 'turn.completed')
      && events.some(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text?.trim() === SENTINEL)
  } catch { return false }
}

function unavailableModel(response: AiCredentialCommandResult): boolean {
  // Model fallback is not a retry for authentication, rate-limit or transport errors.
  return /(?:model[^\n]{0,100}(?:not available|not supported|not found|does not exist)|model_not_found|unsupported_model)/i.test(`${response.stderr}\n${response.stdout}`)
}

function requestError(response: AiCredentialCommandResult): string {
  const text = `${response.stderr}\n${response.stdout}`
  if (/unauthorized|authentication[_ ]error|invalid[_ ](?:token|grant)|\b401\b/i.test(text)) return 'AUTHENTICATION_FAILED'
  if (/rate[_ -]?limit|quota|\b429\b/i.test(text)) return 'RATE_LIMITED'
  if (/unknown (?:option|argument)|unexpected argument|unrecognized (?:option|argument)/i.test(text)) return 'CLI_UPDATE_REQUIRED'
  if (/ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network error/i.test(text)) return 'NETWORK_ERROR'
  return unavailableModel(response) ? 'MODEL_UNAVAILABLE' : 'REQUEST_FAILED'
}

export async function verifyLocalAiAccounts(
  deps: AiCredentialRuntimeDependencies,
  provider: 'claude' | 'codex',
  requested: VerificationIdentity[],
  local: Array<Record<string, unknown>>,
  options?: { budgetMs: number },
): Promise<{ checkedAt: number; accounts: AccountVerification[] }> {
  const accounts: AccountVerification[] = []
  const started = deps.now()
  const budgetMs = options?.budgetMs ?? 240_000
  for (const [index, identity] of requested.entries()) {
    const account = local.find(candidate => provider === 'claude'
      ? candidate.email === identity.email && (candidate.organizationUuid ?? '') === (identity.organizationUuid ?? '')
      : identity.accountId ? candidate.accountId === identity.accountId : candidate.email === identity.email)
    if (!account) { accounts.push({ account: index + 1, ok: false, errorKind: 'ACCOUNT_NOT_INSTALLED' }); continue }
    if (account.disabled === true || account.enabled === false) { accounts.push({ account: index + 1, ok: false, errorKind: 'ACCOUNT_DISABLED' }); continue }
    if (deps.now() - started >= budgetMs) { accounts.push({ account: index + 1, ok: false, errorKind: 'VERIFICATION_TIMEOUT' }); continue }
    const home = await deps.makeTempDir()
    let model = provider === 'claude' ? 'haiku' : 'gpt-6-luna'
    try {
      const config = join(home, provider === 'claude' ? '.claude' : '.codex')
      await deps.mkdir(config, { recursive: true, mode: 0o700 })
      if (provider === 'claude') {
        if (typeof account.credentials === 'string' && account.credentials.startsWith('sk-ant-api')) {
          await deps.writeFile(join(config, '.claude.json'), JSON.stringify({ primaryApiKey: account.credentials, hasCompletedOnboarding: true }), { mode: 0o600 })
        } else {
          const credentials = account.credentials as { claudeAiOauth?: { accessToken?: string } } | undefined
          if (!credentials?.claudeAiOauth?.accessToken) throw new Error('missing local OAuth credential')
          // Probe the current local token; never rotate shared refresh credentials
          // from an isolated verification process.
          const oauth = { ...credentials.claudeAiOauth }
          delete (oauth as { refreshToken?: unknown }).refreshToken
          await deps.writeFile(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 })
          await deps.writeFile(join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: (account.config as { oauthAccount?: unknown } | undefined)?.oauthAccount }), { mode: 0o600 })
        }
      } else {
        if (typeof account.accessToken !== 'string' || typeof account.accountId !== 'string') throw new Error('missing local OAuth credential')
        await deps.writeFile(join(config, 'auth.json'), JSON.stringify({ auth_mode: 'chatgptAuthTokens', access_token: account.accessToken, account_id: account.accountId }), { mode: 0o600 })
      }
      const run = () => {
        const remainingMs = budgetMs - (deps.now() - started)
        if (remainingMs <= 0) throw Object.assign(new Error('verification budget exhausted'), { kind: 'COMMAND_TIMED_OUT' })
        return deps.execFile(provider === 'claude' ? 'claude' : 'codex', provider === 'claude'
          ? ['--print', '--model', model, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--max-turns', '1', PROMPT]
          : ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', model, '-c', 'model_reasoning_effort="low"', '-c', 'cli_auth_credentials_store="file"', PROMPT],
        { environment: isolatedEnvironment(deps.env, home), cwd: home, terminateProcessTree: true, maxOutputBytes: 64 * 1024, timeoutMs: Math.min(30_000, remainingMs), acceptNonZeroExit: true })
      }
      let response = await run()
      if (!successful(provider, response) && requestError(response) === 'MODEL_UNAVAILABLE') {
        model = provider === 'claude' ? 'sonnet' : 'gpt-6.1-sol'
        response = await run()
      }
      accounts.push(successful(provider, response)
        ? { account: index + 1, ok: true, model }
        : { account: index + 1, ok: false, model, errorKind: requestError(response) })
    } catch (error) {
      const kind = (error as { kind?: string })?.kind
      if (kind === 'COMMAND_TREE_TERMINATION_FAILED') throw error
      accounts.push({ account: index + 1, ok: false, model, errorKind: kind === 'COMMAND_TIMED_OUT' ? 'VERIFICATION_TIMEOUT' : kind === 'COMMAND_NOT_AVAILABLE' ? 'CLI_UPDATE_REQUIRED' : 'REQUEST_FAILED' })
    } finally {
      // Cleanup failure is a failed operation, never a successful verification.
      await deps.rm(home, { recursive: true, force: true })
    }
  }
  return { checkedAt: deps.now(), accounts }
}
