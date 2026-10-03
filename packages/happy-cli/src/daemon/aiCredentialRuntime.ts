import { createCredentialGroupSync, type CredentialGroupRequest } from './aiCredentialGroups'
import { createGroupProviderAdapters, groupPayloadIdentities } from './aiCredentialGroupAdapters'
import { spawn as crossSpawn } from 'cross-spawn'
import { verifyLocalAiAccounts, type VerificationIdentity } from './aiCredentialVerification'
import { mergeCodexAccounts } from './aiCredentialAdditive'
import { CODEX_MULTI_AUTH_VERSION, isSupportedCodexMultiAuthVersion, SUPPORTED_CODEX_MULTI_AUTH_VERSION_RANGE } from '../utils/codexMultiAuthVersions'
import { stagingParent } from './stagedCredentialRoot'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { logger } from '@/ui/logger'
import {
  getCodexMultiAuthProxyStatus,
  isManagedCodexRotationSettings,
} from '../codex/codexMultiAuthProxy'
import {
  buildZaiClaudeEnvironment,
  ZAI_CLAUDE_DEFAULT_MODEL,
  ZAI_CLAUDE_MODELS,
  ZAI_CLAUDE_TIMEOUT_MS,
} from '../managed/zaiClaudeEnvironment'
import {
  AI_CREDENTIAL_PROVENANCE_PATH,
  readActiveClaudeProvenance,
  parseClaudeProvenanceInput,
  serializeAppliedClaudeProvenance,
  serializeInvalidatedClaudeProvenance,
} from './aiCredentialProvenance'
import { overlayManagedCredentialEnvironment, type AiAuthSelection } from './sessionEnv'
import { CLAUDE_AUTH_OVERRIDE_ENV_KEYS } from '@/claude/utils/claudeAuthOverrideEnv'
import { HAPPY_AI_AUTH_SOURCE_ENV } from '@/usage/aiAuthSource'
import {
  cswapAtLeastPinned, isManagedSetupTokenAccount, managedSetupTokenEmail, managedSetupTokenId, parseCswapVersion, sameManagedSetupToken,
  setupTokenGroupIdentity, setupTokenRuntimeStatus, supportsManagedSetupTokens,
} from './claudeSetupToken'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const CLAUDE_SWAP_VERSION = '0.25.0'
const CLAUDE_STATUS_TIMEOUT_MS = 120_000
// Keep readable historical bundles separate from supported installed runtimes.
// Bundles from supported runtimes are readable; parseCodexMultiAuthBundle still
// requires the OAuth account v3 / settings v1 contract.
const READABLE_HISTORICAL_CODEX_MULTI_AUTH_BUNDLE_VERSIONS: ReadonlySet<string> = new Set(['2.15.0'])
function isReadableCodexMultiAuthBundleVersion(version: string): boolean {
  return READABLE_HISTORICAL_CODEX_MULTI_AUTH_BUNDLE_VERSIONS.has(version) || isSupportedCodexMultiAuthVersion(version)
}
const CODEX_MULTI_AUTH_THRESHOLD = 5

export type AiCredentialProvider = 'claude' | 'codex' | 'zai'

export type TrialAiCredentialLeaseMarker = {
  leaseId: string
  contentHash: string
  bundleVersion: number
}

type TrialAiCredentialMarkerFile = {
  version: 1
  leases: Partial<Record<AiCredentialProvider, TrialAiCredentialLeaseMarker>>
}

type AiCredentialApplyGenerationFile = {
  version: 1
  generations: Partial<Record<AiCredentialProvider, number>>
}

export type AiCredentialCommandResult = {
  stdout: string
  stderr: string
  exitCode?: number
}

export type AiCredentialRotationStatus = {
  state: 'stopped' | 'starting' | 'running' | 'needs-reauth' | 'blocked' | 'quota-unknown' | 'not-routed' | 'not-applicable'
  lastErrorKind: string | null
  warningKinds?: Array<'ACCOUNT_NEEDS_REAUTH' | 'NO_COMPARISON'>
  lastSwitchAt?: string
  activeAccount?: string
  strategy?: 'sequential'
  threshold5h?: number
  threshold7d?: number
}

type CommandOptions = {
  cwd?: string
  terminateProcessTree?: boolean
  maxOutputBytes?: number
  timeoutMs?: number
  acceptNonZeroExit?: boolean
  environment?: NodeJS.ProcessEnv
  input?: string
}

type Supervisor = {
  enable(): Promise<void>
  stop(): Promise<void>
  status(): AiCredentialRotationStatus
}

export type AiCredentialRuntimeDependencies = {
  homeDir: string
  now(): number
  env: Record<string, string | undefined>
  execFile(command: string, args: string[], options?: CommandOptions): Promise<AiCredentialCommandResult>
  readFile(path: string): Promise<string>
  readdir(path: string): Promise<string[]>
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  makeTempDir(): Promise<string>
  /** Unexpected but non-fatal conditions, e.g. a provenance record that could not be written. */
  warn?(message: string): void
  supervisor: Supervisor
  codexProxyStatus?: () => { activeRoutes: number }
}

export class AiCredentialRuntimeError extends Error {
  /** 프로브 실패 진단(종료 코드, stderr 마지막 줄). 데몬 로그의 오류 객체에 함께 찍힌다. */
  readonly probe?: { exitCode: number | undefined; stderrTail: string }

  constructor(
    public readonly kind: string,
    applyGeneration?: number,
    probe?: { exitCode: number | undefined; stderrTail: string },
  ) {
    super(
      `AI credential operation failed (${kind})`
      + (applyGeneration === undefined ? '' : ` [applyGeneration=${applyGeneration}]`),
    )
    if (probe) this.probe = probe
  }
}

/** An additive Claude apply that imported shared slots but could not activate one: the slots stay, so they keep their provenance. */
class ClaudeActivationError extends AiCredentialRuntimeError {
  constructor(kind: string, readonly importedAccounts: ClaudeListDetails['accounts']) {
    super(kind)
  }
}

const PROBE_STDERR_TAIL_MAX = 200

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines[lines.length - 1] ?? '').slice(0, PROBE_STDERR_TAIL_MAX)
}

type CodexQuotaWindow = { usedPercent?: unknown }
type CodexQuotaEntry = { primary?: CodexQuotaWindow; secondary?: CodexQuotaWindow }
type CodexQuotaCache = {
  byAccountId?: Record<string, CodexQuotaEntry>
  byEmail?: Record<string, CodexQuotaEntry>
}
type CodexAccountIdentity = { accountId?: unknown; email?: unknown; enabled?: unknown }

export function selectLeastRemainingCodexAccounts(
  accounts: CodexAccountIdentity[],
  quotaCache: CodexQuotaCache,
  threshold: number,
): { orderedIndexes: number[]; activeIndex: number; quotaKnown: boolean; hasReadyAccount: boolean } {
  const identities = accounts.map((account) => {
    const accountId = typeof account.accountId === 'string' ? nonEmptyTrimmed(account.accountId) : null
    const email = typeof account.email === 'string'
      ? nonEmptyTrimmed(account.email)?.toLowerCase() ?? null
      : null
    return { accountId, email }
  })
  const accountIdCounts = countNonNull(identities.map(({ accountId }) => accountId))
  const emailCounts = countNonNull(identities.map(({ email }) => email))
  const candidates = accounts.map((account, index) => {
    const { accountId, email } = identities[index]!
    const quota = (accountId && accountIdCounts.get(accountId) === 1
      ? quotaCache.byAccountId?.[accountId]
      : undefined)
      ?? (email && emailCounts.get(email) === 1 ? quotaCache.byEmail?.[email] : undefined)
    const remaining = quota ? restrictiveRemainingPercent(quota) : null
    return { index, enabled: account.enabled !== false, remaining }
  })
  const ready = candidates
    .filter((candidate) => candidate.enabled
      && candidate.remaining !== null
      && candidate.remaining > threshold)
    .sort((left, right) => left.remaining! - right.remaining! || left.index - right.index)
  const unknown = candidates.filter((candidate) => candidate.enabled && candidate.remaining === null)
  const unavailable = candidates.filter((candidate) => !candidate.enabled
    || (candidate.remaining !== null && candidate.remaining <= threshold))
  const orderedIndexes = [...ready, ...unknown, ...unavailable].map(({ index }) => index)
  return {
    orderedIndexes,
    activeIndex: 0,
    quotaKnown: unknown.length === 0,
    hasReadyAccount: ready.length > 0,
  }
}

function restrictiveRemainingPercent(entry: CodexQuotaEntry): number | null {
  const used = [entry.primary?.usedPercent, entry.secondary?.usedPercent]
  if (!used.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
    return null
  }
  return Math.min(...used.map((value) => Math.max(0, Math.min(100, 100 - value))))
}

export function createAiCredentialRuntime(deps: AiCredentialRuntimeDependencies) {
  let operationTail: Promise<void> = Promise.resolve()

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation)
    operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  function provider(value: unknown): AiCredentialProvider {
    if (value !== 'claude' && value !== 'codex' && value !== 'zai') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_PROVIDER')
    }
    return value
  }

  function assertPayloadSize(payload: string): void {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new AiCredentialRuntimeError('PAYLOAD_TOO_LARGE')
    }
  }

  function codexHome(): string {
    const configured = deps.env.CODEX_HOME
    return configured && configured.length > 0 ? configured : join(deps.homeDir, '.codex')
  }

  function codexMultiAuthDir(): string {
    const configured = deps.env.CODEX_MULTI_AUTH_DIR
    return configured && configured.length > 0 ? configured : join(codexHome(), 'multi-auth')
  }

  function trialMarkerPath(): string {
    return join(deps.homeDir, '.happy', 'trial-ai-credential-leases.json')
  }

  function applyGenerationPath(): string {
    return join(deps.homeDir, '.happy', 'ai-credential-apply-generations.json')
  }

  async function reserveApplyGeneration(
    selected: AiCredentialProvider,
  ): Promise<number> {
    let generations: AiCredentialApplyGenerationFile['generations'] = {}
    try {
      const parsed = JSON.parse(await deps.readFile(applyGenerationPath())) as unknown
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.generations)) {
        throw new Error('invalid apply generation file')
      }
      generations = {}
      for (const candidate of ['claude', 'codex', 'zai'] as const) {
        const value = parsed.generations[candidate]
        if (value !== undefined) {
          if (!Number.isSafeInteger(value) || Number(value) < 1) {
            throw new Error('invalid apply generation')
          }
          generations[candidate] = Number(value)
        }
      }
      if (Object.keys(parsed.generations).some((key) => (
        key !== 'claude' && key !== 'codex' && key !== 'zai'
      ))) {
        throw new Error('invalid provider')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
      }
    }
    const current = generations[selected] ?? 0
    const now = deps.now()
    const clockGeneration = now * 1000
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(clockGeneration)) {
      throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
    }
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new AiCredentialRuntimeError('APPLY_GENERATION_INVALID')
    }
    const next = Math.max(current + 1, clockGeneration)
    generations[selected] = next
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, applyGenerationPath(), JSON.stringify({
      version: 1,
      generations,
    } satisfies AiCredentialApplyGenerationFile))
    return next
  }

  function trialLease(value: unknown): TrialAiCredentialLeaseMarker {
    if (!isObject(value)
      || typeof value.leaseId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(value.leaseId)
      || typeof value.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.contentHash)
      || !Number.isInteger(value.bundleVersion)
      || Number(value.bundleVersion) < 1) {
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
    return {
      leaseId: value.leaseId,
      contentHash: value.contentHash,
      bundleVersion: Number(value.bundleVersion),
    }
  }

  async function readTrialMarker(): Promise<TrialAiCredentialMarkerFile> {
    let raw: string
    try {
      raw = await deps.readFile(trialMarkerPath())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, leases: {} }
      }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.leases)) {
        throw new Error('invalid marker')
      }
      const leases: TrialAiCredentialMarkerFile['leases'] = {}
      for (const selected of ['claude', 'codex', 'zai'] as const) {
        if (parsed.leases[selected] !== undefined) {
          leases[selected] = trialLease(parsed.leases[selected])
        }
      }
      if (Object.keys(parsed.leases).some((key) => (
        key !== 'claude' && key !== 'codex' && key !== 'zai'
      ))) {
        throw new Error('invalid provider')
      }
      return { version: 1, leases }
    } catch (error) {
      if (error instanceof AiCredentialRuntimeError) throw error
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
  }

  async function writeTrialMarker(marker: TrialAiCredentialMarkerFile): Promise<void> {
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, trialMarkerPath(), JSON.stringify(marker))
  }

  function warnCodexCaptureReadFailure(
    fileName: 'openai-codex-accounts.json' | 'settings.json',
    error: unknown,
  ): void {
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code
    const reason = error instanceof SyntaxError
      ? 'INVALID_JSON'
      : ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EBUSY', 'EAGAIN'].includes(errorCode ?? '')
        ? errorCode
        : 'READ_FAILED'
    try {
      deps.warn?.(`Codex credential capture could not read ${fileName} (${reason})`)
    } catch {}
  }

  async function capture(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    return serialize(() => withSafeErrors(`${selected.toUpperCase()}_CAPTURE_FAILED`, async () => {
      if (selected === 'zai') {
        throw new AiCredentialRuntimeError('ZAI_CAPTURE_UNSUPPORTED')
      }
      let payload: string
      if (selected === 'claude') {
        const result = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
        payload = result.stdout
      } else {
        const packageVersion = await assertSupportedCodexMultiAuthInstalled()
        let accounts: unknown
        try {
          accounts = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnCodexCaptureReadFailure('openai-codex-accounts.json', error)
            throw error
          }
          throw new AiCredentialRuntimeError('CODEX_FILE_STORE_REQUIRED')
        }
        let settings: unknown = { version: 1, pluginConfig: {} }
        try {
          settings = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'settings.json')))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            warnCodexCaptureReadFailure('settings.json', error)
            throw error
          }
        }
        payload = JSON.stringify({
          version: 1,
          kind: 'codex-multi-auth',
          packageVersion,
          accounts,
          settings,
        })
      }
      assertPayloadSize(payload)
      return { provider: selected, payload }
    }))
  }

  async function claudeSwapPython(): Promise<string> {
    try {
      await deps.execFile('uv', ['python', 'find', '>=3.12'])
      return '>=3.12'
    } catch (error) {
      // Windows can refuse uv's minor-version junction (os error 448); use the real patch install.
      const physical = await physicalUvPython()
      if (!physical) throw error
      deps.warn?.('uv Python version link was unusable; using the physical patch installation')
      return physical
    }
  }

  async function physicalUvPython(): Promise<string | null> {
    const root = (await deps.execFile('uv', ['python', 'dir'])).stdout.trim()
    if (!root) return null
    const installs = (await deps.readdir(root))
      .map((name) => ({ name, version: /^cpython-3\.(\d+)\.(\d+)-/.exec(name) }))
      .filter((entry) => entry.version && Number(entry.version[1]) >= 12)
      .sort((a, b) => Number(b.version![1]) - Number(a.version![1]) || Number(b.version![2]) - Number(a.version![2]))
    for (const { name } of installs) {
      for (const python of [join(root, name, 'python.exe'), join(root, name, 'bin', 'python3')]) {
        try {
          await deps.execFile(python, ['--version'])
          return python
        } catch {
          // Not this layout or not runnable; try the next candidate.
        }
      }
    }
    return null
  }

  async function installedClaudeSwapVersion(): Promise<string | null> {
    try { return parseCswapVersion((await deps.execFile('cswap', ['--version'])).stdout) } catch { return null }
  }

  async function ensureClaudeSwap(preserveSettings = false): Promise<void> {
    await deps.execFile('uv', ['--version'])
    const python = await claudeSwapPython()
    // A newer installed build is kept: replacing it with the pin would be a silent downgrade.
    if (!cswapAtLeastPinned(await installedClaudeSwapVersion())) {
      await deps.execFile('uv', [
        'tool', 'install', `claude-swap==${CLAUDE_SWAP_VERSION}`,
        '--python', python, '--force',
      ], { timeoutMs: 300_000 })
    }
    if (preserveSettings) return
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.threshold', '95'])
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first'])
  }

  async function setupTokenRuntimeSupported(): Promise<boolean> {
    try {
      return supportsManagedSetupTokens((await deps.execFile('cswap', ['token-runtime', 'capabilities'], {
        maxOutputBytes: 64 * 1024, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
    } catch { return false }
  }

  async function applyClaudeAdditive(payload: string, knownCompanyIdentities: Set<string>, groupOwned: ReadonlySet<string> = new Set()) {
    const incoming = claudeImportedAccountIdentities(payload)
    if (!incoming) throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    let managed: Array<Record<string, unknown> & { email: string }>
    try { managed = JSON.parse(payload).accounts.filter(isManagedSetupTokenAccount) } catch { throw new AiCredentialRuntimeError('INVALID_PAYLOAD') }
    // Unsupported or missing runtimes need action before anything installs or changes.
    if (managed.length > 0 && !await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
    await ensureClaudeSwap(true)
    const list = async () => parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    let before = await list()
    const config = await readOptionalJson(deps.env.CLAUDE_CONFIG_DIR
      ? join(deps.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(deps.homeDir, '.claude.json'))
    const liveIdentity = isObject(config?.oauthAccount) ? config.oauthAccount : null
    const unregistered = typeof liveIdentity?.emailAddress === 'string' && !!liveIdentity.emailAddress
      && !before.accounts.some(account => account.email === liveIdentity.emailAddress
        && (account.organizationUuid ?? '') === (liveIdentity.organizationUuid ?? ''))
    if (unregistered || before.activeAccountNumber === null) {
      const live = await readOptionalJson(join(deps.env.CLAUDE_CONFIG_DIR || join(deps.homeDir, '.claude'), '.credentials.json'))
      if (unregistered || isObject(live?.claudeAiOauth)) {
        await deps.execFile('cswap', ['add'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        before = await list()
        if (before.activeAccountNumber === null) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
      }
    }
    const envelope = JSON.parse(payload)
    let repairRequestedAccountCount = 0
    const repairedIdentities = new Set<string>()
    // Managed setup-token slots are replaced by generation below; they never take the inference repair path.
    const duplicates: Array<Record<string, unknown> & { email: string }> = envelope.accounts.filter((account: { email: string }) =>
      managedSetupTokenId(account.email) === null && before.accounts.some(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account) && local.disabled !== true))
    if (duplicates.length > 0) {
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const identities = (accounts: Array<Record<string, unknown> & { email: string }>) => accounts.map(account => ({
        email: account.email, organizationUuid: typeof account.organizationUuid === 'string' ? account.organizationUuid : '',
      }))
      // Authentication failure is the only proof that permits replacing a duplicate.
      // Quota, transport, missing credentials and exhausted budgets keep it untouched.
      const localVerification = await verifyLocalAiAccounts(deps, 'claude', identities(duplicates), exported.accounts, { budgetMs: 60_000 })
      const invalid = duplicates.filter((_account, index) => localVerification.accounts[index]?.errorKind === 'AUTHENTICATION_FAILED')
        .map(account => ({ ...account, disabled: before.accounts.find(local =>
          claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.disabled }))
      if (invalid.length > 0) {
        repairRequestedAccountCount = invalid.length
        const requested = identities(invalid)
        const verification = await verifyLocalAiAccounts(deps, 'claude', requested, invalid, { budgetMs: 60_000 })
        let accepted = invalid.filter((_account, index) => verification.accounts[index]?.ok)
        if (accepted.length > 0) {
          const current = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
          if (current.version !== 1 || current.encrypted === true || !Array.isArray(current.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
          // A login or refresh during the probes wins over the older failed snapshot.
          for (const [index, account] of invalid.entries()) {
            const find = (accounts: Array<{ email: string; credentials?: unknown; config?: unknown }>) => accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))
            const original = find(exported.accounts), latest = find(current.accounts)
            if (!original || !latest || JSON.stringify([original.credentials, original.config]) !== JSON.stringify([latest.credentials, latest.config])) {
              verification.accounts[index] = { account: index + 1, ok: false, errorKind: 'LOCAL_ACCOUNT_CHANGED' }
            }
          }
          accepted = invalid.filter((_account, index) => verification.accounts[index]?.ok)
        }
        if (accepted.length > 0) {
          const repaired = await applyClaudeRepair({ before, envelope: { ...envelope, accounts: accepted }, requested, verification, automatic: true }, { budgetMs: 60_000 })
          for (const account of repaired?.verifiedAccounts ?? []) {
            repairedIdentities.add(claudeListAccountIdentity(account))
            knownCompanyIdentities.add(JSON.stringify([account.email, account.organizationUuid ?? '', account.organizationName ?? '']))
          }
        }
      }
    }
    // Probes can span rotation ticks and user changes; preserve the latest state
    // even when an automatic repair was skipped before any credential write.
    if (duplicates.length > 0) before = await list()
    const existing = new Set(before.accounts.map(claudeListAccountIdentity))
    // Existing slots that were not proven invalid remain outside the import,
    // which also preserves their local disabled metadata.
    envelope.accounts = envelope.accounts.filter((account: { email: string }) => !existing.has(claudeListAccountIdentity(account)))
    if (envelope.accounts.length > 0) {
      const tempDir = await deps.makeTempDir()
      const file = join(tempDir, 'claude-swap.json')
      try {
        await deps.writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
        await deps.chmod(file, 0o600)
        await deps.execFile('cswap', ['import', file])
      } finally {
        await deps.rm(tempDir, { recursive: true, force: true })
      }
    }
    // cswap storage is authoritative for managed metadata. A managed slot is replaced only
    // when this deployment proves it owns the slot; a personal import of the same synthetic
    // email is a conflict, never a silent takeover. --force drops `disabled`, so restore it.
    const exportedAccounts = async () => {
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      return exported.accounts as Array<Record<string, unknown>>
    }
    const owns = (account: Record<string, unknown> & { email: string }) => groupOwned.has(setupTokenGroupIdentity(account.managedAccountId as string))
      || [...knownCompanyIdentities].some(identity => JSON.parse(identity)[0] === account.email)
    const managedExisting = managed.filter(account => existing.has(claudeListAccountIdentity(account)))
    if (managedExisting.length > 0) {
      const local = await exportedAccounts()
      const changed = managedExisting.filter(account => !sameManagedSetupToken(local.find(slot => slot.email === account.email), account))
      for (const account of changed) {
        const stored = local.find(slot => slot.email === account.email)
        if (!owns(account) || !stored || stored.managedAccountId !== account.managedAccountId) throw new AiCredentialRuntimeError('AI_GROUP_CREDENTIAL_CONFLICT')
        const storedGeneration = Number(stored.credentialGeneration)
        if (storedGeneration > Number(account.credentialGeneration)) throw new AiCredentialRuntimeError('AI_GROUP_GENERATION_STALE')
        if (storedGeneration === account.credentialGeneration) throw new AiCredentialRuntimeError('AI_GROUP_GENERATION_CONFLICT')
      }
      if (changed.length > 0) {
        const tempDir = await deps.makeTempDir()
        const file = join(tempDir, 'claude-swap.json')
        try {
          await deps.writeFile(file, JSON.stringify({ ...envelope, accounts: changed }), { mode: 0o600 })
          await deps.chmod(file, 0o600)
          await deps.execFile('cswap', ['import', file, '--force'])
        } finally {
          await deps.rm(tempDir, { recursive: true, force: true })
        }
        const current = await list()
        for (const account of changed) {
          const prior = before.accounts.find(slot => claudeListAccountIdentity(slot) === claudeListAccountIdentity(account))
          if (prior?.disabled === true && current.accounts.find(slot => slot.number === prior.number)?.disabled !== true) {
            await deps.execFile('cswap', ['disable', String(prior.number)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
          }
        }
      }
      for (const account of managedExisting.filter(owns)) knownCompanyIdentities.add(JSON.stringify([account.email, '', '']))
    }
    let after = await list()
    if (managed.length > 0) {
      // Presence is not enough: ID, generation, label and credential must all be this payload's.
      const local = await exportedAccounts()
      if (managed.some(account => !sameManagedSetupToken(local.find(slot => slot.email === account.email), account))) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    // Only newly imported slots are proven organizational material. Matching
    // personal credentials were deliberately not overwritten by this import.
    const sharedAccounts = (details: ClaudeListDetails) => details.accounts.filter(account => incoming.has(claudeListAccountIdentity(account)) && (!existing.has(claudeListAccountIdentity(account)) || knownCompanyIdentities.has(JSON.stringify([account.email, account.organizationUuid ?? '', account.organizationName ?? '']))))
    const present = new Set(after.accounts.map(claudeListAccountIdentity))
    if ([...existing, ...incoming].some(identity => !present.has(identity))
      || before.accounts.some(account => {
        const retained = after.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== account.number || retained?.disabled !== account.disabled
      })) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    if (before.activeAccountNumber !== null) {
      if (after.activeAccountNumber !== before.activeAccountNumber) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    } else {
      // Nothing personal is active to keep. Like a replace, activate a usable account rather than report
      // "configured" while Claude Code stays signed out (a fresh Windows PC, 2026-10-02).
      const imported = sharedAccounts(after)
      try {
        // A stored setup-token is activatable without readable usage; its usage scope is a separate state.
        const setupToken = (details: ClaudeListDetails) => details.accounts.find(account => account.number === details.activeAccountNumber
          && account.disabled !== true && managed.some(incomingAccount => incomingAccount.email === account.email))
        const target = after.activeAccountNumber !== null && (after.activeUsable || after.activeCredentialKind === 'api_key' || setupToken(after))
          ? after.activeAccountNumber
          : after.usableAccountNumber ?? after.accounts.find(account => account.disabled !== true
            && managed.some(incomingAccount => incomingAccount.email === account.email))?.number ?? null
        if (target === null) throw new AiCredentialRuntimeError(claudeNoUsableAccountKind(after))
        await deps.execFile('cswap', ['switch', String(target), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        after = await list()
        if (!after.activeUsable && after.activeCredentialKind !== 'api_key' && !setupToken(after)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      } catch (error) {
        // The imported slots stay on the machine, so a failed activation must not leave them unattributed.
        throw new ClaudeActivationError(error instanceof AiCredentialRuntimeError ? error.kind : 'CLAUDE_APPLY_FAILED', imported)
      }
    }
    return {
      result: { provider: 'claude' as const, configured: true, ...claudeAccountHealth(after),
        repairedAccountCount: repairedIdentities.size,
        credentialRepairFailedAccountCount: repairRequestedAccountCount - repairedIdentities.size,
        rotation: deps.supervisor.status() },
      verifiedAccounts: sharedAccounts(after),
    }
  }

  async function prepareClaudeRepair(payload: string) {
    if (!claudeImportedAccountIdentities(payload)) throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    await ensureClaudeSwap(true)
    const before = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    const envelope = JSON.parse(payload)
    const requested: Array<{ email: string; organizationUuid: string }> = envelope.accounts.map((account: { email: string; organizationUuid?: string }) => ({
      email: account.email, organizationUuid: account.organizationUuid ?? '',
    }))
    // The explicit repair may replace a matching personal identity, as approved
    // by the user. Other identities and locally disabled slots stay untouched.
    const candidates = envelope.accounts.filter((account: { email: string }) =>
      before.accounts.some(existing => claudeListAccountIdentity(existing) === claudeListAccountIdentity(account)))
      .map((account: { email: string }) => ({ ...account, disabled: before.accounts.find(existing =>
        claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled === true }))
    const verification = await verifyLocalAiAccounts(deps, 'claude', requested, candidates)
    const accepted = envelope.accounts.filter((_account: unknown, index: number) => verification.accounts[index]?.ok)
      .map((account: { email: string }) => ({ ...account, disabled: before.accounts.find(existing =>
        claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled }))
    if (accepted.length === 0) throw new AiCredentialRuntimeError('CLAUDE_APPLY_RELOGIN_REQUIRED')
    return { before, envelope: { ...envelope, accounts: accepted }, requested, verification }
  }

  async function applyClaudeRepair(prepared: Awaited<ReturnType<typeof prepareClaudeRepair>> & { automatic?: boolean }, verificationOptions?: { budgetMs: number }) {
    const list = async () => parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })).stdout)
    const { before, envelope, requested, verification } = prepared
    const restoreRotation = deps.supervisor.status().state !== 'stopped'
    let rotationStopped = false
    const tempDir = await deps.makeTempDir()
    let after: ClaudeListDetails
    let installed: Awaited<ReturnType<typeof verifyLocalAiAccounts>>
    let accounts = verification.accounts
    try {
      if (restoreRotation) {
        await deps.supervisor.stop()
        rotationStopped = true
      }
      const current = await list()
      const changed = current.activeAccountNumber !== before.activeAccountNumber || before.accounts.some(account => {
        const retained = current.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== account.number || retained?.disabled !== account.disabled
      }) || (prepared.automatic && envelope.accounts.some((account: { email: string }) =>
        before.accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.usageStatus === 'relogin_required'
        && current.accounts.find(local => claudeListAccountIdentity(local) === claudeListAccountIdentity(account))?.usageStatus !== 'relogin_required'))
      if (changed) {
        if (prepared.automatic) return null
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
      const file = join(tempDir, 'claude-swap.json')
      await deps.writeFile(file, JSON.stringify(envelope), { mode: 0o600 })
      await deps.chmod(file, 0o600)
      await deps.execFile('cswap', ['import', file, '--force'])
      const repairedIdentities = new Set(envelope.accounts.map(claudeListAccountIdentity))
      const active = before.accounts.find(account => account.number === before.activeAccountNumber)
      if (active && repairedIdentities.has(claudeListAccountIdentity(active))) {
        // Import repairs the backup only. The selected slot's live credential
        // must be restored without backing its broken login over that backup.
        await deps.execFile('cswap', ['switch', String(active.number), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
      }
      after = await list()
      if (after.activeAccountNumber !== before.activeAccountNumber || before.accounts.some(account => {
        const retained = after.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))
        return retained?.number !== account.number || retained?.disabled !== account.disabled
      })) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      if (exported.version !== 1 || exported.encrypted === true || !Array.isArray(exported.accounts)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const acceptedIndices = requested.flatMap((_identity, index) => verification.accounts[index]?.ok ? [index] : [])
      installed = await verifyLocalAiAccounts(deps, 'claude', acceptedIndices.map(index => requested[index]!), exported.accounts.map((account: { email: string }) => ({
        ...account, disabled: after.accounts.find(existing => claudeListAccountIdentity(existing) === claudeListAccountIdentity(account))?.disabled === true,
      })), verificationOptions)
      accounts = verification.accounts.map((account, index) => account.ok
        ? { ...installed.accounts[acceptedIndices.indexOf(index)]!, account: index + 1 } : account)
      if (!accounts.some(account => account.ok)) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    } finally {
      try { await deps.rm(tempDir, { recursive: true, force: true }) }
      finally { if (rotationStopped) await deps.supervisor.enable() }
    }
    return {
      result: { provider: 'claude' as const, configured: true, ...claudeAccountHealth(after),
        verification: { checkedAt: installed.checkedAt, accounts }, rotation: deps.supervisor.status() },
      verifiedAccounts: after.accounts.filter(account => requested.some((identity, index) => accounts[index]?.ok
        && claudeListAccountIdentity(account) === claudeListAccountIdentity(identity))),
    }
  }

  async function applyClaude(payload: string) {
    await purgeManagedProvider('zai')
    const apiKeyTargetEmail = claudeApiKeyTargetEmail(payload)
    const importedAccountIdentities = claudeImportedAccountIdentities(payload)
    const verifyImportedAccounts = (details: ClaudeListDetails) => {
      if (importedAccountIdentities === null) return
      const remainingIdentities = new Set(details.accounts.map(claudeListAccountIdentity))
      if (details.accounts.length !== importedAccountIdentities.size
        || remainingIdentities.size !== importedAccountIdentities.size
        || [...importedAccountIdentities].some((identity) => !remainingIdentities.has(identity))) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    if (importedAccountIdentities !== null) await deps.supervisor.stop()
    await ensureClaudeSwap()
    const tempDir = await deps.makeTempDir()
    const tempFile = join(tempDir, 'claude-swap.json')
    try {
      await deps.writeFile(tempFile, payload, { mode: 0o600 })
      await deps.chmod(tempFile, 0o600)
      await deps.execFile('cswap', ['import', tempFile, '--force'])
    } finally {
      await deps.rm(tempDir, { recursive: true, force: true })
    }
    let status = await deps.execFile('cswap', ['list', '--json'], {
      maxOutputBytes: MAX_PAYLOAD_BYTES,
      timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
    })
    let details = parseClaudeListDetails(status.stdout)
    if (!details.configured) {
      throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
    }
    if (importedAccountIdentities !== null) {
      const previousAccounts = details.accounts.filter((account) => (
        !importedAccountIdentities.has(claudeListAccountIdentity(account))
      ))
      for (const account of previousAccounts) {
        await deps.execFile('cswap', ['remove', String(account.number)], {
          input: 'y\n',
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
      }
      if (previousAccounts.length > 0) {
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
      }
      verifyImportedAccounts(details)
      const active = details.accounts.find((account) => (
        account.number === details.activeAccountNumber && account.disabled !== true
      ))
      if (active) {
        // Import replaces the stored backup, not the live credential (including
        // macOS Keychain). Even an "ok" or "relogin_required" active slot still
        // describes the old login. Force activation skips backing that login
        // up over the imported credential; use the resolved local slot number.
        await deps.execFile('cswap', [
          'switch', String(active.number), '--force', '--json',
        ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
        verifyImportedAccounts(details)
        if (details.activeAccountNumber !== active.number) {
          throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
        }
      }
    }
    if (apiKeyTargetEmail !== null) {
      let target = details.accounts.find((account) => (
        account.email === apiKeyTargetEmail
        && account.usageStatus === 'api_key'
        && account.disabled !== true
      ))
      if (!target) throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      const targetNumber = target.number
      if (details.activeAccountNumber !== targetNumber) {
        await deps.execFile('cswap', [
          'switch', String(targetNumber), '--force', '--json',
        ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        status = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        details = parseClaudeListDetails(status.stdout)
        verifyImportedAccounts(details)
        target = details.accounts.find((account) => (
          account.email === apiKeyTargetEmail
          && account.usageStatus === 'api_key'
          && account.disabled !== true
        ))
        if (!target || details.activeAccountNumber !== target.number) {
          throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
        }
      }
      return {
        result: {
          provider: 'claude' as const,
          configured: true,
          credentialKind: 'api_key' as const,
          rotation: apiKeyRotationStatus(),
        },
        verifiedAccounts: importedAccountIdentities === null ? null : details.accounts,
      }
    }
    // Only once the list is verified to be exactly the imported bundle can
    // "every enabled account needs login" be blamed on the bundle itself.
    const noUsableAccountKind = (current: ClaudeListDetails) => {
      if (importedAccountIdentities === null) return 'CLAUDE_APPLY_VERIFICATION_FAILED'
      const enabled = current.accounts.filter((account) => account.disabled !== true)
      return enabled.length > 0 && enabled.every((account) => account.usageStatus === 'relogin_required')
        ? 'CLAUDE_APPLY_RELOGIN_REQUIRED'
        : 'CLAUDE_APPLY_VERIFICATION_FAILED'
    }
    if (!details.activeUsable) {
      if (details.usableAccountNumber === null) {
        throw new AiCredentialRuntimeError(noUsableAccountKind(details))
      }
      await deps.execFile('cswap', [
        'switch', String(details.usableAccountNumber), '--force', '--json',
      ], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
      status = await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      details = parseClaudeListDetails(status.stdout)
      verifyImportedAccounts(details)
      if (!details.activeUsable) {
        throw new AiCredentialRuntimeError(noUsableAccountKind(details))
      }
    }
    await deps.supervisor.enable()
    return {
      result: {
        provider: 'claude' as const,
        configured: true,
        rotation: deps.supervisor.status(),
      },
      // What cswap holds after the import, checked against the payload's
      // accounts. `null` when the payload's accounts could not be identified.
      verifiedAccounts: importedAccountIdentities === null ? null : details.accounts,
    }
  }

  async function applyCodex(payload: string, applyMode: 'merge' | 'replace' = 'replace') {
    const bundle = parseCodexMultiAuthBundle(payload)
    if (bundle) return applyCodexMultiAuth(bundle, applyMode)
    if (applyMode === 'merge') throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    const home = codexHome()
    const authPath = join(home, 'auth.json')
    const backupPath = join(home, 'auth.json.happy-backup')
    const tempPath = join(home, '.auth.json.happy-tmp')
    await deps.mkdir(home, { recursive: true, mode: 0o700 })
    let hadExisting = false
    try {
      await deps.rename(authPath, backupPath)
      hadExisting = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new AiCredentialRuntimeError('CODEX_BACKUP_FAILED')
      }
    }
    if (hadExisting) {
      try {
        await deps.chmod(backupPath, 0o600)
      } catch {
        try {
          await deps.rename(backupPath, authPath)
        } catch {
          throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
        }
        throw new AiCredentialRuntimeError('CODEX_BACKUP_FAILED')
      }
    }
    try {
      await deps.writeFile(tempPath, payload, { mode: 0o600 })
      await deps.chmod(tempPath, 0o600)
      await deps.rename(tempPath, authPath)
      await deps.chmod(authPath, 0o600)
      await deps.execFile('codex', ['login', 'status'])
      try {
        await deps.rm(backupPath, { force: true })
      } catch {
        throw new AiCredentialRuntimeError('CODEX_BACKUP_CLEANUP_FAILED')
      }
    } catch (error) {
      let tempCleanupFailed = false
      try {
        await deps.rm(tempPath, { force: true })
      } catch {
        tempCleanupFailed = true
      }
      let authRemovalFailed = false
      try {
        await deps.rm(authPath, { force: true })
      } catch {
        authRemovalFailed = true
      }
      if (hadExisting) {
        try {
          await deps.rename(backupPath, authPath)
        } catch {
          throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
        }
      } else if (authRemovalFailed) {
        throw new AiCredentialRuntimeError('CODEX_APPLY_ROLLBACK_FAILED')
      } else {
        try {
          await deps.rename(backupPath, authPath)
          await deps.chmod(authPath, 0o600)
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new AiCredentialRuntimeError('CODEX_BACKUP_RESTORE_FAILED')
          }
        }
      }
      if (tempCleanupFailed) {
        throw new AiCredentialRuntimeError('CODEX_APPLY_ROLLBACK_FAILED')
      }
      if (error instanceof AiCredentialRuntimeError) throw error
      throw new AiCredentialRuntimeError('CODEX_APPLY_FAILED')
    }
    return { provider: 'codex' as const, configured: true, status: 'authenticated' as const }
  }

  async function ensureCodexMultiAuth(): Promise<void> {
    const installed = await supportedCodexMultiAuthInstalled()
    if (!installed) {
      await deps.execFile('npm', [
        'install', '--global', `codex-multi-auth@${CODEX_MULTI_AUTH_VERSION}`,
      ], { timeoutMs: 300_000 })
      if (!await supportedCodexMultiAuthInstalled()) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
      }
    }
    await deps.execFile('codex', ['--version'])
  }

  async function assertSupportedCodexMultiAuthInstalled(): Promise<string> {
    const installed = await inspectCodexMultiAuthInstallation()
    if (isSupportedCodexMultiAuthVersion(installed.cli) && installed.cli === installed.global) return installed.cli
    const error = new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
    error.message += ` [codex-multi-auth installed=${installed.cli} global=${installed.global} supported=${SUPPORTED_CODEX_MULTI_AUTH_VERSION_RANGE}]`
    throw error
  }

  async function supportedCodexMultiAuthInstalled(): Promise<string | null> {
    const installed = await inspectCodexMultiAuthInstallation()
    return isSupportedCodexMultiAuthVersion(installed.cli) && installed.cli === installed.global ? installed.cli : null
  }

  async function inspectCodexMultiAuthInstallation(): Promise<{ cli: string; global: string }> {
    const installed = { cli: 'unknown', global: 'unknown' }
    const safeVersion = (value: unknown): string => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : 'unknown'
    try {
      installed.cli = safeVersion((await deps.execFile('codex-multi-auth', ['--version'])).stdout.trim())
    } catch {
      // Preserve unknown for the diagnostic; never include command output or secrets.
    }
    try {
      const root = nonEmptyTrimmed((await deps.execFile('npm', ['root', '--global'])).stdout)
      if (root) {
        const packageJson = JSON.parse(await deps.readFile(join(root, 'codex-multi-auth', 'package.json'))) as unknown
        installed.global = isObject(packageJson) ? safeVersion(packageJson.version) : 'unknown'
      }
    } catch {
      // Missing/unreadable global metadata is a failed compatibility check.
    }
    return installed
  }

  async function readOptionalJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const parsed = JSON.parse(await deps.readFile(path))
      if (!isObject(parsed)) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async function applyCodexMultiAuth(bundle: CodexMultiAuthBundle, applyMode: 'merge' | 'replace') {
    await ensureCodexMultiAuth()
    const root = codexMultiAuthDir()
    await deps.mkdir(root, { recursive: true, mode: 0o700 })
    await deps.chmod(root, 0o700)
    const settings = enforceCodexRotationSettings(bundle.settings)
    const accountsPath = join(root, 'openai-codex-accounts.json')
    const settingsPath = join(root, 'settings.json')
    if (applyMode === 'merge') {
      let current = bundle
      let savedSettings: CodexMultiAuthBundle['settings'] = { version: 1, pluginConfig: {} }
      try {
        const raw = await deps.readFile(accountsPath)
        current = parseCodexMultiAuthBundle(JSON.stringify({ ...bundle, accounts: JSON.parse(raw) }))!
        if (!current) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const live = await readOptionalJson(deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json'))
      if (live) {
        const tokens = isObject(live.tokens) ? live.tokens : null
        if (!tokens || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token
          || typeof tokens.access_token !== 'string' || !tokens.access_token) {
          throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
        }
        const claims = (token: unknown): Record<string, unknown> => {
          try { const parsed = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString()); return isObject(parsed) ? parsed : {} } catch { return {} }
        }
        const access = claims(tokens.access_token), id = claims(tokens.id_token)
        const auth = id['https://api.openai.com/auth'] || access['https://api.openai.com/auth']
        const accountId = tokens.account_id || (isObject(auth) ? auth.chatgpt_account_id : null)
        if (typeof accountId !== 'string' || !accountId) throw new AiCredentialRuntimeError('AI_CREDENTIAL_PERSONAL_CAPTURE_REQUIRED')
        const candidate: CodexMultiAuthAccount = {
          accountId, refreshToken: tokens.refresh_token, accessToken: tokens.access_token,
          ...(typeof (id.email || access.email) === 'string' ? { email: String(id.email || access.email) } : {}),
          ...(typeof access.exp === 'number' ? { expiresAt: access.exp * 1000 } : {}),
          addedAt: deps.now(), lastUsed: deps.now(),
        }
        // Capture first, before importing any shared material. A fresh pool starts on the live identity.
        let hasPool = true
        try { await deps.readFile(accountsPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hasPool = false }
        const personalPool = hasPool ? mergeCodexAccounts(current.accounts, { ...bundle.accounts, accounts: [candidate] })
          : { version: 3 as const, activeIndex: 0, accounts: [candidate] }
        current = { ...bundle, accounts: personalPool }
        await replaceCodexMultiAuthFiles(deps, [{ path: accountsPath, content: JSON.stringify(personalPool) }], async () => {
          if (await deps.readFile(accountsPath) !== JSON.stringify(personalPool)) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        })
      }
      try {
        savedSettings = JSON.parse(await deps.readFile(settingsPath))
        if (!isObject(savedSettings) || savedSettings.version !== 1 || !isObject(savedSettings.pluginConfig)) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const identity = (account: CodexMultiAuthAccount): VerificationIdentity => typeof account.accountId === 'string' && account.accountId
        ? { accountId: account.accountId } : { email: typeof account.email === 'string' ? account.email : undefined }
      const matching = (account: CodexMultiAuthAccount, other: CodexMultiAuthAccount) => account.accountId
        ? account.accountId === other.accountId : account.email === other.email
      const duplicates = bundle.accounts.accounts.filter(incoming => current.accounts.accounts.some(local => matching(local, incoming)
        && local.enabled !== false && (local.accessToken !== incoming.accessToken || local.refreshToken !== incoming.refreshToken)))
      const localCheck = await verifyLocalAiAccounts(deps, 'codex', duplicates.map(identity), current.accounts.accounts, { budgetMs: 60_000 })
      const invalid = duplicates.filter((_account, index) => localCheck.accounts[index]?.errorKind === 'AUTHENTICATION_FAILED')
      const sharedCheck = await verifyLocalAiAccounts(deps, 'codex', invalid.map(identity), invalid, { budgetMs: 60_000 })
      const accepted = invalid.filter((_account, index) => sharedCheck.accounts[index]?.ok)
      const refreshed = { ...current.accounts, accounts: current.accounts.accounts.map(local => {
        const incoming = accepted.find(account => matching(local, account))
        return incoming ? { ...local, refreshToken: incoming.refreshToken, accessToken: incoming.accessToken,
          expiresAt: incoming.expiresAt } : local
      }) }
      const repairedActive = accepted.some(account => {
        const active = current.accounts.accounts[current.accounts.activeIndex]
        return active && matching(active, account) && !!live && isObject(live.tokens) && live.tokens.account_id === active.accountId
      })
      const merged = mergeCodexAccounts(refreshed, bundle.accounts)
      // A refresh/login performed while probing wins over our older snapshot.
      try {
        if (JSON.stringify(JSON.parse(await deps.readFile(accountsPath))) !== JSON.stringify(current.accounts)) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await replaceCodexMultiAuthFiles(deps, [
        { path: accountsPath, content: JSON.stringify(merged) },
        { path: settingsPath, content: JSON.stringify(savedSettings) },
      ], async () => {
        if (await deps.readFile(accountsPath) !== JSON.stringify(merged)
          || await deps.readFile(settingsPath) !== JSON.stringify(savedSettings)) {
          throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        }
      })
      if (repairedActive) {
        // Refresh the same live identity, never switch a valid personal login to another account.
        await deps.execFile('codex-multi-auth', ['switch', String(merged.activeIndex + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        const selected = JSON.parse(await deps.readFile(accountsPath)) as CodexMultiAuthBundle['accounts']
        await assertCodexLiveAccount(selected.accounts[merged.activeIndex]!)
        await writeAtomicFile(deps, accountsPath, JSON.stringify({ ...merged, accounts: selected.accounts }))
      }
      return { provider: 'codex' as const, configured: true, accountCount: merged.accounts.length }
    }
    const applied = await replaceCodexMultiAuthFiles(deps, [
      { path: accountsPath, content: JSON.stringify(bundle.accounts) },
      { path: settingsPath, content: JSON.stringify(settings) },
    ], async () => {
      await deps.execFile('codex-multi-auth', ['forecast', '--live', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      const currentBundle = parseCodexMultiAuthBundle(JSON.stringify({
        ...bundle,
        accounts: JSON.parse(await deps.readFile(accountsPath)),
      }))
      if (!currentBundle
        || currentBundle.accounts.accounts.length !== bundle.accounts.accounts.length) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
      }
      const quotaCache = await readCodexQuotaCache(deps, root)
      const selection = selectLeastRemainingCodexAccounts(
        currentBundle.accounts.accounts,
        quotaCache,
        CODEX_MULTI_AUTH_THRESHOLD,
      )
      const orderedAccounts = selection.orderedIndexes
        .map((index) => currentBundle.accounts.accounts[index]!)
      const sorted = {
        ...currentBundle.accounts,
        accounts: orderedAccounts,
        activeIndex: selection.activeIndex,
        activeIndexByFamily: resetActiveIndexes(currentBundle.accounts.activeIndexByFamily),
        pinnedAccountIndex: undefined,
      }
      await writeAtomicFile(deps, accountsPath, JSON.stringify(sorted))
      await deps.execFile('codex-multi-auth', ['check'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      return { selection, accountCount: currentBundle.accounts.accounts.length }
    })
    return {
      provider: 'codex' as const,
      configured: true,
      accountCount: applied.accountCount,
      rotation: codexRotationStatus(
        applied.selection.quotaKnown,
        applied.selection.hasReadyAccount,
      ),
    }
  }

  function zaiEnvironmentPath(): string {
    return join(deps.homeDir, '.happy', 'zai-claude-env.json')
  }

  function parseZaiPayload(payload: string): Record<string, string> {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new AiCredentialRuntimeError('ZAI_PAYLOAD_INVALID')
    }
    if (!isObject(parsed)
      || parsed.version !== 1
      || parsed.kind !== 'zai-anthropic'
      || typeof parsed.apiKey !== 'string'
      || !/^[\x21-\x7e]{1,1024}$/.test(parsed.apiKey)) {
      throw new AiCredentialRuntimeError('ZAI_PAYLOAD_INVALID')
    }
    return buildZaiClaudeEnvironment(parsed.apiKey)
  }

  function parseZaiEnvironment(raw: string): Record<string, string> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    }
    if (!isObject(parsed)) throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    const values = Object.values(parsed)
    // ANTHROPIC_MODEL was added after machines were already running, and the
    // file on disk is only rewritten on the next apply. Rejecting the older
    // six-key form would invalidate the Z.AI credential of every machine
    // between this CLI landing and that apply, so both shapes are accepted —
    // such a session still reaches the flash default through the per-path
    // fallbacks. The key set stays closed either way: an extra key is still
    // rejected, so this file cannot smuggle arbitrary env into a session.
    const hasDefaultModel = 'ANTHROPIC_MODEL' in parsed
    if (Object.keys(parsed).length !== (hasDefaultModel ? 7 : 6)
      || values.some((value) => typeof value !== 'string')
      || parsed.ANTHROPIC_BASE_URL !== 'https://api.z.ai/api/anthropic'
      || parsed.API_TIMEOUT_MS !== ZAI_CLAUDE_TIMEOUT_MS
      || (hasDefaultModel && parsed.ANTHROPIC_MODEL !== ZAI_CLAUDE_DEFAULT_MODEL)
      || parsed.ANTHROPIC_DEFAULT_OPUS_MODEL !== ZAI_CLAUDE_MODELS.opus
      || parsed.ANTHROPIC_DEFAULT_SONNET_MODEL !== ZAI_CLAUDE_MODELS.sonnet
      || parsed.ANTHROPIC_DEFAULT_HAIKU_MODEL !== ZAI_CLAUDE_MODELS.haiku
      || typeof parsed.ANTHROPIC_AUTH_TOKEN !== 'string'
      || !/^[\x21-\x7e]{1,1024}$/.test(parsed.ANTHROPIC_AUTH_TOKEN)) {
      throw new AiCredentialRuntimeError('ZAI_ENV_INVALID')
    }
    return parsed as Record<string, string>
  }

  function isAuthenticatedZaiProbe(raw: string): boolean {
    try {
      const parsed = JSON.parse(raw) as unknown
      return isObject(parsed)
        && typeof parsed.result === 'string'
        && parsed.result.trim() === 'CLAUDE_AUTH_OK'
    } catch {
      return false
    }
  }

  function isRejectedZaiAuthentication(probe: AiCredentialCommandResult): boolean {
    const stderrLines = probe.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const diagnostic = stderrLines[stderrLines.length - 1] ?? ''
    return /\b401\b|\bunauthorized\b|authentication[_ -]*error|invalid[_ -]*api[_ -]*key/i
      .test(diagnostic)
  }

  async function applyZai(payload: string) {
    const environment = parseZaiPayload(payload)
    await purgeManagedProvider('claude')
    await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
    await writeAtomicFile(deps, zaiEnvironmentPath(), JSON.stringify(environment))
    return { provider: 'zai' as const, configured: true, accountCount: 1 }
  }

  function provenancePath(): string {
    return join(deps.homeDir, AI_CREDENTIAL_PROVENANCE_PATH)
  }

  /**
   * Bookkeeping for the observed-source check. A failure here must never fail
   * the apply itself — the credential is already in place — so it is reported
   * and swallowed. The generation fence keeps an unwritten record harmless.
   */
  async function writeClaudeProvenance(content: string): Promise<void> {
    try {
      await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 })
      await writeAtomicFile(deps, provenancePath(), content)
    } catch (error) {
      deps.warn?.(`[ai-credential] could not write the Claude provenance record: ${
        error instanceof Error ? error.message : String(error)
      }`)
    }
  }

  async function recordClaudeProvenance(
    input: { trialLease?: unknown; provenance?: unknown },
    applyGeneration: number,
    verifiedAccounts: ClaudeListDetails['accounts'] | null,
  ): Promise<void> {
    if (input.trialLease !== undefined) return
    const provenance = parseClaudeProvenanceInput(input.provenance)
    if (!provenance || !verifiedAccounts || verifiedAccounts.length === 0) return
    // Taken from cswap's own list after the import, not from the payload: the
    // organization name is what the login metadata and accountInfo() will
    // report, and the payload's copy of it was never checked.
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    const identities = new Set(verifiedAccounts.map((account) => JSON.stringify([
      account.email,
      text(account.organizationUuid),
      text(account.organizationName),
    ])))
    await writeClaudeProvenance(serializeAppliedClaudeProvenance({
      ...provenance,
      generation: applyGeneration,
      identities,
    }))
  }

  async function requestedActivation(input: { provider: AiCredentialProvider; payload: string; activeAccountIndex?: number }) {
    if (input.activeAccountIndex === undefined) return null
    const parsed = JSON.parse(input.payload)
    const accounts = input.provider === 'claude' ? parsed.accounts : parsed.accounts?.accounts
    const index = input.activeAccountIndex
    if (!Number.isSafeInteger(index) || index < 0 || !Array.isArray(accounts) || index >= accounts.length) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    const account = accounts[index]
    const requested: VerificationIdentity = input.provider === 'claude'
      ? { email: account.email, organizationUuid: account.organizationUuid ?? '' }
      : account.accountId ? { accountId: account.accountId } : { email: account.email }
    const verification = await verifyLocalAiAccounts(deps, input.provider as 'claude' | 'codex', [requested], [account], { budgetMs: 60_000 })
    if (!verification.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
    return requested
  }

  async function assertCodexLiveAccount(account: CodexMultiAuthAccount) {
    const live = await readOptionalJson(deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json'))
    if (!isObject(live?.tokens) || typeof account.accountId !== 'string' || live.tokens.account_id !== account.accountId
      || typeof account.accessToken !== 'string' || live.tokens.access_token !== account.accessToken) {
      throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
    }
  }

  async function activateInstalledAccount(selected: 'claude' | 'codex', identity: VerificationIdentity) {
    if (selected === 'claude') {
      const before = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'])).stdout)
      const account = before.accounts.find(item => item.email === identity.email && (item.organizationUuid ?? '') === (identity.organizationUuid ?? ''))
      if (!account || account.disabled) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      const verified = await verifyLocalAiAccounts(deps, selected, [identity], exported.accounts, { budgetMs: 60_000 })
      if (!verified.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      try {
        await deps.execFile('cswap', ['switch', String(account.number), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        const after = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'])).stdout)
        if (after.activeAccountNumber !== account.number) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      } catch (error) {
        if (before.activeAccountNumber !== null) await deps.execFile('cswap', ['switch', String(before.activeAccountNumber), '--force', '--json'], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS }).catch(() => undefined)
        throw error
      }
    } else {
      const path = join(codexMultiAuthDir(), 'openai-codex-accounts.json')
      const before = JSON.parse(await deps.readFile(path)) as CodexMultiAuthBundle['accounts']
      const livePath = deps.env.CODEX_CLI_AUTH_PATH || join(codexHome(), 'auth.json')
      let previousLive: string | null = null
      try { previousLive = await deps.readFile(livePath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const index = before.accounts.findIndex(account => identity.accountId ? account.accountId === identity.accountId : account.email === identity.email)
      if (index < 0 || before.accounts[index]?.enabled === false) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      const verified = await verifyLocalAiAccounts(deps, selected, [identity], before.accounts, { budgetMs: 60_000 })
      if (!verified.accounts[0]?.ok) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
      try {
        await deps.execFile('codex-multi-auth', ['switch', String(index + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })
        const after = JSON.parse(await deps.readFile(path))
        if (after.activeIndex !== index) throw new AiCredentialRuntimeError('AI_CREDENTIAL_ACTIVE_INVALID')
        await assertCodexLiveAccount(after.accounts[index])
      } catch (error) {
        await deps.execFile('codex-multi-auth', ['switch', String(before.activeIndex + 1)], { timeoutMs: CLAUDE_STATUS_TIMEOUT_MS }).catch(() => undefined)
        await writeAtomicFile(deps, path, JSON.stringify(before))
        if (previousLive !== null) await writeAtomicFile(deps, livePath, previousLive)
        else await deps.rm(livePath, { force: true })
        throw error
      }
    }
  }

  async function apply(input: {
    provider: AiCredentialProvider
    payload: string
    trialLease?: TrialAiCredentialLeaseMarker
    applyMode?: 'merge' | 'replace' | 'repair'
    activeAccountIndex?: number
    /** Sent only by the org deployment: which company bundle this is. */
    provenance?: unknown
  }) {
    const selected = provider(input?.provider)
    if (typeof input?.payload !== 'string') {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    assertPayloadSize(input.payload)
    const applyMode = input.applyMode ?? 'replace'
    if (applyMode !== 'merge' && applyMode !== 'replace' && applyMode !== 'repair') throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    if (input.activeAccountIndex !== undefined && (applyMode !== 'merge' || selected === 'zai')) throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    if (applyMode === 'repair' && (selected !== 'claude' || input.trialLease !== undefined || !parseClaudeProvenanceInput(input.provenance))) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    if (applyMode === 'merge' && (input.trialLease !== undefined || selected === 'zai')) {
      throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
    }
    return serialize(() => withSafeErrors(
      `${selected.toUpperCase()}_APPLY_FAILED`,
      async () => {
        if (applyMode === 'merge' || applyMode === 'repair') {
          const marker = await readTrialMarker()
          if (marker.leases[selected] || (selected === 'claude' && marker.leases.zai)) {
            throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
          }
        }
        // Verify incoming repair material before advancing the apply fence:
        // rejected source credentials never invalidate the installed provenance.
        const activation = await requestedActivation(input)
        const repair = applyMode === 'repair' ? await prepareClaudeRepair(input.payload) : null
        const previousProvenance = selected === 'claude' && applyMode === 'merge'
          ? await readActiveClaudeProvenance({ homeDir: deps.homeDir, readFile: deps.readFile })
          : null
        const incomingProvenance = parseClaudeProvenanceInput(input.provenance)
        const knownCompanyIdentities = previousProvenance && incomingProvenance
          && previousProvenance.companyId === incomingProvenance.companyId
          ? previousProvenance.identities : new Set<string>()
        // A manual/legacy apply can supersede managed slots. Never use an old group receipt as proof.
        let touched: string[] | null = null
        if (applyMode === 'merge' && selected !== 'zai') { try { touched = groupPayloadIdentities(selected, input.payload) } catch {} }
        await groups.invalidate(selected === 'zai' ? 'claude' : selected, touched)
        const applyGeneration = await reserveApplyGeneration(selected)
        // A Claude record is only believed for the current claude generation.
        // A Claude apply just bumped it; a Z.AI apply purges the Claude login,
        // so it bumps it too — the fence then holds even if the explicit
        // invalidation below cannot be written.
        if (selected === 'zai') await reserveApplyGeneration('claude')
        if (selected === 'claude' || selected === 'zai') {
          await writeClaudeProvenance(serializeInvalidatedClaudeProvenance(applyGeneration))
        }
        let requestedLease: TrialAiCredentialLeaseMarker | undefined
        let marker: TrialAiCredentialMarkerFile | undefined
        let previousLease: TrialAiCredentialLeaseMarker | undefined
        let markerChanged = false
        try {
          if (input.trialLease !== undefined) {
            requestedLease = trialLease(input.trialLease)
            marker = await readTrialMarker()
            const currentLease = marker.leases[selected]
            if (currentLease && currentLease.leaseId !== requestedLease.leaseId) {
              throw new AiCredentialRuntimeError('TRIAL_LEASE_CONFLICT')
            }
            const conflictingClaudeRuntime = selected === 'zai'
              ? marker.leases.claude
              : selected === 'claude'
                ? marker.leases.zai
                : undefined
            if (conflictingClaudeRuntime) {
              throw new AiCredentialRuntimeError('TRIAL_LEASE_CONFLICT')
            }
            previousLease = currentLease
            marker.leases[selected] = requestedLease
            await writeTrialMarker(marker)
            markerChanged = true
          }
          const claudeApplied = selected === 'claude'
            ? await (repair ? applyClaudeRepair(repair) : applyMode === 'merge' ? applyClaudeAdditive(input.payload, knownCompanyIdentities) : applyClaude(input.payload))
            : null
          const result = claudeApplied
            ? claudeApplied.result
            : selected === 'zai'
              ? await applyZai(input.payload)
              : await applyCodex(input.payload, applyMode === 'merge' ? 'merge' : 'replace')
          if (!requestedLease) {
            const nonTrialMarker = await readTrialMarker()
            const providersToClear: AiCredentialProvider[] = selected === 'claude'
              ? ['claude', 'zai']
              : selected === 'zai'
                ? ['zai', 'claude']
                : ['codex']
            let changed = false
            for (const providerToClear of providersToClear) {
              if (nonTrialMarker.leases[providerToClear]) {
                delete nonTrialMarker.leases[providerToClear]
                changed = true
              }
            }
            if (changed) {
              if (Object.keys(nonTrialMarker.leases).length === 0) {
                await deps.rm(trialMarkerPath(), { force: true })
              } else {
                await writeTrialMarker(nonTrialMarker)
              }
            }
          }
          if (activation) await activateInstalledAccount(selected as 'claude' | 'codex', activation)
          if (claudeApplied) await recordClaudeProvenance(input, applyGeneration, claudeApplied.verifiedAccounts)
          return { ...result, applyGeneration, ...(activation ? { activeAccountIndex: input.activeAccountIndex } : {}), ...(input.applyMode ? { applyMode } : {}) }
        } catch (error) {
          if (error instanceof ClaudeActivationError) {
            await recordClaudeProvenance(input, applyGeneration, error.importedAccounts)
              .catch(() => deps.warn?.('Claude provenance could not be recorded after a failed activation'))
          }
          if (requestedLease && marker && markerChanged) {
            if (previousLease) marker.leases[selected] = previousLease
            else delete marker.leases[selected]
            try {
              if (Object.keys(marker.leases).length === 0) {
                await deps.rm(trialMarkerPath(), { force: true })
              } else {
                await writeTrialMarker(marker)
              }
            } catch {
              // Keep the newly written ownership marker when rollback fails so
              // the server can still issue a matching purge RPC.
            }
          }
          throw error instanceof AiCredentialRuntimeError
            ? new AiCredentialRuntimeError(error.kind, applyGeneration)
            : new AiCredentialRuntimeError(`${selected.toUpperCase()}_APPLY_FAILED`, applyGeneration)
        }
      },
    ))
  }

  const groupAdapters = createGroupProviderAdapters(deps)
  const groupJournalPath = join(deps.homeDir, '.happy', 'ai-credential-groups.json')
  const groups = createCredentialGroupSync({
    read: async () => { try { return await deps.readFile(groupJournalPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
    write: async content => { await deps.mkdir(join(deps.homeDir, '.happy'), { recursive: true, mode: 0o700 }); await deps.chmod(join(deps.homeDir, '.happy'), 0o700); await writeAtomicFile(deps, groupJournalPath, content) },
    snapshot: groupAdapters.snapshot, incoming: groupPayloadIdentities, remove: groupAdapters.remove,
    apply: async (selected, payload, owned) => {
      const marker = await readTrialMarker()
      if (marker.leases[selected] || (selected === 'claude' && marker.leases.zai)) throw new AiCredentialRuntimeError('AI_CREDENTIAL_MERGE_UNSUPPORTED')
      if (selected === 'claude') return applyClaudeAdditive(payload, new Set(), new Set(owned))
      return applyCodex(payload, 'merge')
    },
  })
  async function groupSync(input: CredentialGroupRequest) {
    return serialize(() => withSafeErrors('AI_GROUP_SYNC_FAILED', async () => {
      // The journal snapshots cswap before applying, so the runtime gate must come first.
      if (input?.provider === 'claude' && typeof input.payload === 'string' && containsManagedSetupTokens(input.payload)
        && !await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
      return groups.sync(input)
    }))
  }

  async function purgeManagedProvider(selected: AiCredentialProvider): Promise<void> {
    if (selected === 'claude') {
      await deps.supervisor.stop()
      const claudeConfig = deps.env.CLAUDE_CONFIG_DIR || join(deps.homeDir, '.claude')
      await deps.rm(join(claudeConfig, '.credentials.json'), { force: true })
      await deps.rm(join(deps.homeDir, '.claude-swap'), { recursive: true, force: true })
      await deps.rm(join(deps.homeDir, '.config', 'claude-swap'), { recursive: true, force: true })
      return
    }
    if (selected === 'zai') {
      await deps.rm(zaiEnvironmentPath(), { force: true })
      return
    }
    const home = codexHome()
    await deps.rm(join(home, 'auth.json'), { force: true })
    await deps.rm(join(home, 'auth.json.happy-backup'), { force: true })
    await deps.rm(join(home, '.auth.json.happy-tmp'), { force: true })
    await deps.rm(codexMultiAuthDir(), { recursive: true, force: true })
  }

  async function purge(input: { provider: AiCredentialProvider; leaseId: string }) {
    const selected = provider(input?.provider)
    if (typeof input?.leaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.leaseId)) {
      throw new AiCredentialRuntimeError('TRIAL_MARKER_INVALID')
    }
    return serialize(() => withSafeErrors('TRIAL_PURGE_FAILED', async () => {
      const marker = await readTrialMarker()
      const currentLease = marker.leases[selected]
      if (!currentLease) {
        return { provider: selected, purged: true, alreadyPurged: true }
      }
      if (currentLease.leaseId !== input.leaseId) {
        throw new AiCredentialRuntimeError('TRIAL_LEASE_MISMATCH')
      }
      await purgeManagedProvider(selected)
      delete marker.leases[selected]
      if (Object.keys(marker.leases).length === 0) {
        await deps.rm(trialMarkerPath(), { force: true })
      } else {
        await writeTrialMarker(marker)
      }
      return { provider: selected, purged: true, alreadyPurged: false }
    }))
  }

  async function status(input: { provider: AiCredentialProvider }) {
    const selected = provider(input?.provider)
    return serialize(() => withSafeErrors(`${selected.toUpperCase()}_STATUS_FAILED`, async () => {
      if (selected === 'zai') {
        const marker = await readTrialMarker()
        if (!marker.leases.zai) {
          return { provider: selected, configured: false, accountCount: 0 }
        }
        let environment: Record<string, string>
        try {
          environment = parseZaiEnvironment(await deps.readFile(zaiEnvironmentPath()))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT'
            || (error instanceof AiCredentialRuntimeError && error.kind === 'ZAI_ENV_INVALID')) {
            return { provider: selected, configured: false, accountCount: 0 }
          }
          throw error
        }
        const probe = await deps.execFile(
          'claude',
          [
            '--print',
            '--no-session-persistence',
            '--safe-mode',
            '--output-format',
            'json',
            '--model',
            'sonnet',
            // `--tools <tools...>` 는 가변 인자라 뒤에 오는 프롬프트까지 삼킨다
            // (Claude Code 2.1.246: "Input must be provided ... when using --print").
            // 프롬프트를 먼저 두고 빈 `--tools` 를 마지막에 둔다.
            'Reply with exactly: CLAUDE_AUTH_OK',
            '--tools',
            '',
          ],
          {
            maxOutputBytes: MAX_PAYLOAD_BYTES,
            timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
            acceptNonZeroExit: true,
            environment: overlayManagedCredentialEnvironment(
              Object.fromEntries(
                Object.entries(deps.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              environment,
            ),
          },
        )
        if (probe.exitCode !== undefined && probe.exitCode !== 0) {
          if (isRejectedZaiAuthentication(probe)) {
            return { provider: selected, configured: false, accountCount: 0 }
          }
          throw new AiCredentialRuntimeError('ZAI_PROBE_FAILED', undefined, {
            exitCode: probe.exitCode,
            stderrTail: lastLine(probe.stderr),
          })
        }
        if (!isAuthenticatedZaiProbe(probe.stdout)) {
          return { provider: selected, configured: false, accountCount: 0 }
        }
        return { provider: selected, configured: true, accountCount: 1 }
      }
      if (selected === 'codex') {
        const root = codexMultiAuthDir()
        const bundle = parseCodexMultiAuthBundle(JSON.stringify({
          version: 1,
          kind: 'codex-multi-auth',
          packageVersion: CODEX_MULTI_AUTH_VERSION,
          accounts: JSON.parse(await deps.readFile(join(root, 'openai-codex-accounts.json'))),
          settings: JSON.parse(await deps.readFile(join(root, 'settings.json'))),
        }))
        if (!bundle) throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
        await assertSupportedCodexMultiAuthInstalled()
        await deps.execFile('codex-multi-auth', ['check'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        const quotaCache = await readCodexQuotaCache(deps, root)
        const selection = selectLeastRemainingCodexAccounts(
          bundle.accounts.accounts,
          quotaCache,
          CODEX_MULTI_AUTH_THRESHOLD,
        )
        const activeAccount = bundle.accounts.accounts[bundle.accounts.activeIndex]
        const activeRoutes = (deps.codexProxyStatus ?? getCodexMultiAuthProxyStatus)().activeRoutes
        const settingsValid = isManagedCodexRotationSettings(bundle.settings)
        const state = !settingsValid
          ? 'blocked' as const
          : !selection.quotaKnown
            ? 'quota-unknown' as const
            : !selection.hasReadyAccount
              ? 'blocked' as const
              : activeRoutes > 0
                ? 'running' as const
                : 'not-routed' as const
        return {
          provider: selected,
          configured: true,
          accountCount: bundle.accounts.accounts.length,
          ...(typeof activeAccount?.email === 'string'
            ? { activeAccount: maskEmail(activeAccount.email) }
            : {}),
          rotation: {
            ...codexRotationStatus(selection.quotaKnown, selection.hasReadyAccount),
            state,
          },
        }
      }
      const result = await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES,
        timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
      })
      const claudeStatus = parseClaudeList(result.stdout)
      return {
        provider: selected,
        ...claudeStatus,
        rotation: claudeStatus.credentialKind === 'api_key'
          ? apiKeyRotationStatus()
          : deps.supervisor.status(),
      }
    }))
  }

  async function verify(input: { provider: AiCredentialProvider; accounts?: VerificationIdentity[]; scope?: 'active' | 'accounts' }) {
    const selected = provider(input?.provider)
    const scope = input.scope ?? 'accounts'
    if (selected === 'zai' || !['active', 'accounts'].includes(scope) || (scope === 'accounts' && (!Array.isArray(input.accounts) || input.accounts.length === 0 || input.accounts.length > 100
      || input.accounts.some(identity => !isObject(identity)
        || (selected === 'claude' ? typeof identity.email !== 'string' || !identity.email
          : !(typeof identity.accountId === 'string' && identity.accountId) && !(typeof identity.email === 'string' && identity.email)))))) {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    return serialize(() => withSafeErrors('AI_CREDENTIAL_VERIFICATION_FAILED', async () => {
      let accounts: Array<Record<string, unknown>>
      let requested = input.accounts ?? []
      let activeAccountNumber: number | null = null
      let activeAccount = ''
      if (selected === 'claude') {
        const listed = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
        if (scope === 'active') {
          const active = listed.accounts.find(account => account.number === listed.activeAccountNumber)
          if (!active) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_NOT_SELECTED')
          activeAccountNumber = active.number
          activeAccount = active.email
          requested = [{ email: active.email, organizationUuid: typeof active.organizationUuid === 'string' ? active.organizationUuid : '' }]
        }
        const exported = await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })
        const parsed = JSON.parse(exported.stdout)
        if (parsed.version !== 1 || parsed.encrypted === true || !Array.isArray(parsed.accounts)) throw new Error('invalid local export')
        accounts = parsed.accounts.map((account: Record<string, unknown> & { email: string }) => ({
          ...account,
          disabled: listed.accounts.find(candidate => claudeListAccountIdentity(candidate) === claudeListAccountIdentity(account))?.disabled === true,
        }))
      } else {
        const parsed = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
        if (parsed.version !== 3 || !Array.isArray(parsed.accounts)) throw new Error('invalid local pool')
        accounts = parsed.accounts
        if (scope === 'active') {
          const active = Number.isInteger(parsed.activeIndex) ? accounts[parsed.activeIndex] : undefined
          if (!active || (!active.accountId && !active.email)) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_NOT_SELECTED')
          activeAccountNumber = parsed.activeIndex + 1
          activeAccount = typeof active.email === 'string' ? active.email : ''
          requested = [{ accountId: active.accountId as string | undefined, email: active.email as string | undefined }]
        }
      }
      const verification = await verifyLocalAiAccounts(deps, selected, requested, accounts)
      if (scope !== 'active') return verification
      if (selected === 'claude') {
        const current = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], { maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout)
        const active = current.accounts.find(account => account.number === current.activeAccountNumber)
        if (!active || active.number !== activeAccountNumber || active.email !== requested[0]?.email
          || (active.organizationUuid ?? '') !== requested[0]?.organizationUuid) throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
      } else {
        const current = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
        const active = current.accounts?.[current.activeIndex]
        if (current.activeIndex + 1 !== activeAccountNumber || !active
          || (requested[0]?.accountId ? active.accountId !== requested[0].accountId : active.email !== requested[0]?.email)) {
          throw new AiCredentialRuntimeError('ACTIVE_ACCOUNT_CHANGED')
        }
      }
      return { ...verification, scope: 'active' as const, activeAccountNumber, activeAccount: maskEmail(activeAccount) }
    }))
  }

  async function rotation(input: { action: 'start' | 'stop' }) {
    if (input?.action !== 'start' && input?.action !== 'stop') {
      throw new AiCredentialRuntimeError('UNSUPPORTED_ROTATION_ACTION')
    }
    return serialize(() => withSafeErrors('ROTATION_UPDATE_FAILED', async () => {
      if (input.action === 'start') {
        await ensureClaudeSwap()
        const result = await deps.execFile('cswap', ['list', '--json'], {
          maxOutputBytes: MAX_PAYLOAD_BYTES,
          timeoutMs: CLAUDE_STATUS_TIMEOUT_MS,
        })
        if (parseClaudeListDetails(result.stdout).activeCredentialKind === 'api_key') {
          await deps.supervisor.stop()
          return {
            provider: 'claude' as const,
            credentialKind: 'api_key' as const,
            rotation: apiKeyRotationStatus(),
          }
        }
        await deps.supervisor.enable()
      } else {
        await deps.supervisor.stop()
      }
      return { provider: 'claude' as const, rotation: deps.supervisor.status() }
    }))
  }

  /**
   * Binds one new Claude spawn to a managed setup-token slot. The token reaches only
   * that child's environment (as with a Z.AI lease); every other Claude auth override
   * is written empty so neither inherited nor tmux-server values can win. Fails
   * closed: no substitute credential is ever returned.
   */
  async function setupTokenSessionEnvironment(agent: string | undefined, managedAccountId: string) {
    if (agent !== undefined && agent !== 'claude') throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
    return serialize(() => withSafeErrors('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE', async () => {
      if (!await setupTokenRuntimeSupported()) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_UNSUPPORTED')
      const email = managedSetupTokenEmail(managedAccountId)
      const listed = parseClaudeListDetails((await deps.execFile('cswap', ['list', '--json'], {
        maxOutputBytes: MAX_PAYLOAD_BYTES, timeoutMs: CLAUDE_STATUS_TIMEOUT_MS })).stdout).accounts.find(account => account.email === email)
      const exported = JSON.parse((await deps.execFile('cswap', ['export', '-'], { maxOutputBytes: MAX_PAYLOAD_BYTES })).stdout)
      const slot = Array.isArray(exported?.accounts) ? exported.accounts.find((account: Record<string, unknown>) => account?.email === email) : undefined
      const token = slot?.credentials?.claudeAiOauth?.accessToken
      if (!listed || listed.disabled === true || slot?.credentialType !== 'setup_token' || slot.managedAccountId !== managedAccountId
        || typeof token !== 'string' || !token.startsWith('sk-ant-oat01-')) throw new AiCredentialRuntimeError('CLAUDE_SETUP_TOKEN_BINDING_UNAVAILABLE')
      const cleared = Object.fromEntries(CLAUDE_AUTH_OVERRIDE_ENV_KEYS.map(key => [key, '']))
      return { ...cleared, CLAUDE_CODE_OAUTH_TOKEN: token, [HAPPY_AI_AUTH_SOURCE_ENV]: 'org-bundle' }
    }))
  }

  async function sessionEnvironment(agent: string | undefined, selection?: AiAuthSelection): Promise<Record<string, string>> {
    if (selection?.kind === 'claude-setup-token') return setupTokenSessionEnvironment(agent, selection.managedAccountId)
    if (agent !== undefined && agent !== 'claude') return {}
    return serialize(async () => {
      const marker = await readTrialMarker()
      if (!marker.leases.zai) return {}
      return parseZaiEnvironment(await deps.readFile(zaiEnvironmentPath()))
    })
  }

  return { capture, apply, groupSync, groupReceipt: (scope: string, selected: 'claude' | 'codex') => serialize(() => groups.receipt(scope, selected)), purge, status, verify, rotation, sessionEnvironment, capabilities: async () => { const setupToken = await setupTokenRuntimeSupported(); return { version: 1, groupAssignmentVersion: 1, activeSelectionVersion: 1, verificationVersion: 1, verificationScopes: ['accounts', 'active'], applyModes: ['merge', 'replace', 'repair'],
    // Managed setup-token import with metadata verification, only on the marked cswap token runtime.
    ...(setupToken ? { setupTokenVersion: 1, setupTokenStatusVersion: 1 } : {}),
    // New spawns can be pinned with aiAuthSelection {kind:'claude-setup-token'} on the same runtime.
    newSessionProfileBinding: setupToken, ...(setupToken ? { setupTokenSessionBindingVersion: 1 } : {}) } } }
}

type ClaudeListDetails = {
  configured: boolean
  activeAccount: string | null
  activeAccountNumber: number | null
  activeUsable: boolean
  usableAccountNumber: number | null
  activeCredentialKind: 'oauth' | 'api_key' | null
  accounts: Array<Record<string, unknown> & { number: number; email: string }>
}

function claudeApiKeyTargetEmail(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!isObject(parsed) || parsed.version !== 1 || parsed.encrypted === true
      || !Array.isArray(parsed.accounts) || parsed.accounts.length !== 1) return null
    const account = parsed.accounts[0]
    if (!isObject(account)
      || typeof account.email !== 'string'
      || typeof account.credentials !== 'string'
      || !account.credentials.startsWith('sk-ant-api')) return null
    return account.email
  } catch {
    return null
  }
}

function containsManagedSetupTokens(payload: string): boolean {
  try { return JSON.parse(payload)?.accounts?.some((account: Record<string, unknown>) => account?.credentialType === 'setup_token') === true } catch { return false }
}

function claudeImportedAccountIdentities(payload: string): Set<string> | null {
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!isObject(parsed) || parsed.version !== 1 || parsed.encrypted === true
      || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) return null
    const identities = new Set<string>()
    for (const account of parsed.accounts) {
      if (!isObject(account)
        || typeof account.email !== 'string'
        || (account.organizationUuid !== undefined
          && typeof account.organizationUuid !== 'string')) return null
      identities.add(JSON.stringify([account.email, account.organizationUuid ?? '']))
    }
    return identities.size === parsed.accounts.length ? identities : null
  } catch {
    return null
  }
}

function claudeListAccountIdentity(
  account: Record<string, unknown> & { email: string },
): string {
  return JSON.stringify([
    account.email,
    typeof account.organizationUuid === 'string' ? account.organizationUuid : '',
  ])
}

/** Why no Claude account can be made active: every enabled account needs re-login, or the list is not as expected. */
function claudeNoUsableAccountKind(details: ClaudeListDetails): 'CLAUDE_APPLY_RELOGIN_REQUIRED' | 'CLAUDE_APPLY_VERIFICATION_FAILED' {
  const enabled = details.accounts.filter((account) => account.disabled !== true)
  return enabled.length > 0 && enabled.every((account) => account.usageStatus === 'relogin_required')
    ? 'CLAUDE_APPLY_RELOGIN_REQUIRED'
    : 'CLAUDE_APPLY_VERIFICATION_FAILED'
}

function parseClaudeListDetails(stdout: string): ClaudeListDetails {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!isObject(parsed)
      || parsed.schemaVersion !== 1
      || !Array.isArray(parsed.accounts)
      || (parsed.activeAccountNumber !== null
        && !Number.isSafeInteger(parsed.activeAccountNumber))) {
      throw new Error('invalid status')
    }
    const accounts: Array<Record<string, unknown>> = []
    const accountNumbers = new Set<number>()
    for (const account of parsed.accounts) {
      if (!isObject(account)
        || !Number.isSafeInteger(account.number)
        || Number(account.number) < 1
        || typeof account.email !== 'string'
        || (account.organizationUuid !== undefined
          && typeof account.organizationUuid !== 'string')
        || accountNumbers.has(Number(account.number))) {
        throw new Error('invalid account')
      }
      accountNumbers.add(Number(account.number))
      accounts.push(account)
    }
    const hasUsageStatus = accounts.some(({ usageStatus }) => typeof usageStatus === 'string')
    const usable = (account: Record<string, unknown>) => account.disabled !== true
      && (!hasUsageStatus || account.usageStatus === 'ok')
    const usableAccount = accounts.find(usable)
    if (parsed.activeAccountNumber === null) {
      return {
        configured: accounts.length > 0,
        activeAccount: null,
        activeAccountNumber: null,
        activeUsable: false,
        usableAccountNumber: typeof usableAccount?.number === 'number'
          ? usableAccount.number
          : null,
        activeCredentialKind: null,
        accounts: accounts as ClaudeListDetails['accounts'],
      }
    }
    const active = accounts.find((account) => account.number === parsed.activeAccountNumber)
    if (!active || typeof active.email !== 'string') {
      throw new Error('active account missing')
    }
    return {
      configured: true,
      activeAccount: maskEmail(active.email),
      activeAccountNumber: Number(parsed.activeAccountNumber),
      activeUsable: usable(active),
      usableAccountNumber: typeof usableAccount?.number === 'number'
        ? usableAccount.number
        : null,
      activeCredentialKind: active.usageStatus === 'api_key' ? 'api_key' : 'oauth',
      accounts: accounts as ClaudeListDetails['accounts'],
    }
  } catch {
    throw new AiCredentialRuntimeError('CLAUDE_STATUS_INVALID')
  }
}

function apiKeyRotationStatus(): AiCredentialRotationStatus {
  return { state: 'not-applicable', lastErrorKind: null }
}

function claudeAccountHealth(details: ClaudeListDetails) {
  const active = details.accounts.find(account => account.number === details.activeAccountNumber)
  const activeAccountStatus = !active ? 'not-selected' as const
    : active.disabled === true ? 'disabled' as const
    : active.usageStatus === 'ok' ? 'usage-readable' as const
    : active.usageStatus === 'api_key' ? 'api-key' as const
    : managedSetupTokenId(active.email) !== null ? 'unknown' as const
    : active.usageStatus === 'relogin_required' ? 'relogin-required' as const
    : 'unknown' as const
  return {
    accountCount: details.accounts.length,
    activeAccountStatus,
    usableAccountCount: details.accounts.filter(account => account.disabled !== true
      && (account.usageStatus === 'ok' || account.usageStatus === 'api_key')).length,
    // A setup-token has no refresh token; cswap's relogin verdict is not an authentication result for it.
    reloginRequiredAccountCount: details.accounts.filter(account => account.disabled !== true && account.usageStatus === 'relogin_required'
      && managedSetupTokenId(account.email) === null).length,
  }
}

function parseClaudeList(stdout: string) {
  const details = parseClaudeListDetails(stdout)
  const { configured, activeAccount, activeCredentialKind } = details
  const setupToken = setupTokenRuntimeStatus(details.accounts, details.activeAccountNumber)
  return {
    configured,
    activeAccount,
    ...claudeAccountHealth(details),
    ...(setupToken.accounts.length > 0 ? { setupToken } : {}),
    ...(activeCredentialKind ? { credentialKind: activeCredentialKind } : {}),
  }
}

type CodexMultiAuthAccount = CodexAccountIdentity & {
  refreshToken: string
  addedAt: number
  lastUsed: number
  [key: string]: unknown
}

export type CodexMultiAuthBundle = {
  version: 1
  kind: 'codex-multi-auth'
  packageVersion: string
  accounts: {
    version: 3
    accounts: CodexMultiAuthAccount[]
    activeIndex: number
    activeIndexByFamily?: Record<string, number | undefined>
    pinnedAccountIndex?: number
    [key: string]: unknown
  }
  settings: {
    version: 1
    pluginConfig: Record<string, unknown>
    [key: string]: unknown
  }
}

function parseCodexMultiAuthBundle(payload: string): CodexMultiAuthBundle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.kind !== 'codex-multi-auth') return null
  if (parsed.version !== 1
    || typeof parsed.packageVersion !== 'string'
    || !isReadableCodexMultiAuthBundleVersion(parsed.packageVersion)
    || !isObject(parsed.accounts)
    || parsed.accounts.version !== 3
    || !Array.isArray(parsed.accounts.accounts)
    || parsed.accounts.accounts.length === 0
    || !Number.isInteger(parsed.accounts.activeIndex)
    || Number(parsed.accounts.activeIndex) < 0
    || Number(parsed.accounts.activeIndex) >= parsed.accounts.accounts.length
    || !isObject(parsed.settings)
    || parsed.settings.version !== 1
    || !isObject(parsed.settings.pluginConfig)) {
    throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
  }
  const identities = new Set<string>()
  for (const account of parsed.accounts.accounts) {
    if (!isObject(account)
      || typeof account.refreshToken !== 'string'
      || !nonEmptyTrimmed(account.refreshToken)
      || typeof account.addedAt !== 'number'
      || !Number.isFinite(account.addedAt)
      || typeof account.lastUsed !== 'number'
      || !Number.isFinite(account.lastUsed)) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
    }
    const accountId = typeof account.accountId === 'string'
      ? nonEmptyTrimmed(account.accountId)
      : null
    const email = typeof account.email === 'string'
      ? nonEmptyTrimmed(account.email)?.toLowerCase() ?? null
      : null
    const identity = accountId
      ? `id:${accountId}`
      : email
        ? `email:${email}`
        : `refresh:${account.refreshToken.trim()}`
    if (identities.has(identity)) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_PAYLOAD_INVALID')
    }
    identities.add(identity)
  }
  return parsed as CodexMultiAuthBundle
}

function enforceCodexRotationSettings(
  settings: CodexMultiAuthBundle['settings'],
): CodexMultiAuthBundle['settings'] {
  return {
    ...settings,
    pluginConfig: {
      ...settings.pluginConfig,
      codexRuntimeRotationProxy: true,
      schedulingStrategy: 'sequential',
      preemptiveQuotaEnabled: true,
      preemptiveQuotaRemainingPercent5h: CODEX_MULTI_AUTH_THRESHOLD,
      preemptiveQuotaRemainingPercent7d: CODEX_MULTI_AUTH_THRESHOLD,
      routingMutex: 'enabled',
      sessionAffinity: false,
      pidOffsetEnabled: false,
    },
  }
}

function resetActiveIndexes(
  indexes: Record<string, number | undefined> | undefined,
): Record<string, number> | undefined {
  if (!indexes) return undefined
  return Object.fromEntries(Object.keys(indexes).map((family) => [family, 0]))
}

function codexRotationStatus(quotaKnown: boolean, hasReadyAccount: boolean) {
  return {
    state: !quotaKnown
      ? 'quota-unknown' as const
      : hasReadyAccount
        ? 'running' as const
        : 'blocked' as const,
    lastErrorKind: null,
    strategy: 'sequential' as const,
    threshold5h: CODEX_MULTI_AUTH_THRESHOLD,
    threshold7d: CODEX_MULTI_AUTH_THRESHOLD,
  }
}

async function readCodexQuotaCache(
  deps: AiCredentialRuntimeDependencies,
  root: string,
): Promise<CodexQuotaCache> {
  try {
    const parsed = JSON.parse(await deps.readFile(join(root, 'quota-cache.json'))) as unknown
    return isObject(parsed) && parsed.version === 1 ? parsed as CodexQuotaCache : {}
  } catch {
    return {}
  }
}

type ManagedCodexFile = { path: string; content: string }

async function replaceCodexMultiAuthFiles<T>(
  deps: AiCredentialRuntimeDependencies,
  files: ManagedCodexFile[],
  verify: () => Promise<T>,
): Promise<T> {
  const backups = new Set<string>()
  const installed = new Set<string>()
  let verified = false
  try {
    for (const file of files) {
      const backup = `${file.path}.happy-backup`
      try {
        await deps.rename(file.path, backup)
        backups.add(file.path)
        await deps.chmod(backup, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    for (const file of files) {
      installed.add(file.path)
      await writeAtomicFile(deps, file.path, file.content)
    }
    const result = await verify()
    verified = true
    for (const path of backups) await deps.rm(`${path}.happy-backup`, { force: true })
    return result
  } catch (error) {
    if (verified) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_BACKUP_CLEANUP_FAILED')
    }
    for (const file of files) {
      await deps.rm(`${file.path}.happy-tmp`, { force: true }).catch(() => undefined)
      await deps.rm(`${file.path}.happy-sort-tmp`, { force: true }).catch(() => undefined)
      if (installed.has(file.path)) {
        await deps.rm(file.path, { force: true }).catch(() => undefined)
      }
    }
    for (const path of backups) {
      try {
        await deps.rename(`${path}.happy-backup`, path)
        await deps.chmod(path, 0o600)
      } catch {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_ROLLBACK_FAILED')
      }
    }
    if (error instanceof AiCredentialRuntimeError) throw error
    throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_APPLY_FAILED')
  }
}

async function writeAtomicFile(
  deps: AiCredentialRuntimeDependencies,
  path: string,
  content: string,
): Promise<void> {
  const tempPath = `${path}.happy-tmp`
  try {
    await deps.writeFile(tempPath, content, { mode: 0o600 })
    await deps.chmod(tempPath, 0o600)
    await deps.rename(tempPath, path)
  } catch (error) {
    await deps.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function withSafeErrors<T>(kind: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AiCredentialRuntimeError) throw error
    throw new AiCredentialRuntimeError(kind)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyTrimmed(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function countNonNull(values: Array<string | null>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function createNodeAiCredentialRuntime(
  supervisor: Supervisor,
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homedir(),
) {
  return createAiCredentialRuntime({
    homeDir,
    now: Date.now,
    env,
    execFile: (command, args, options) => runAiCredentialCommand(command, args, options, options?.terminateProcessTree ? crossSpawn as typeof spawn : spawn),
    readFile: (path) => readFile(path, 'utf8'),
    readdir: (path) => readdir(path),
    writeFile: async (path, content, options) => { await writeFile(path, content, options) },
    mkdir,
    rename,
    chmod,
    rm,
    makeTempDir: () => mkdtemp(join(stagingParent(), 'happy-ai-credential-')),
    supervisor,
    warn: (message) => logger.debug(message),
  })
}

export function runAiCredentialCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
  spawnCommand: typeof spawn = spawn,
): Promise<AiCredentialCommandResult> {
  return new Promise((resolve, reject) => {
    const environment = options.environment ?? process.env
    const child = spawnCommand(command, args, {
      env: command === 'uv' || command === 'cswap'
        ? withUvToolBinOnPath(environment, homedir(), command)
        : environment,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.terminateProcessTree && process.platform !== 'win32' ? { detached: true } : {}),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const fail = (kind: string) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (options.terminateProcessTree && child.pid) {
        if (process.platform === 'win32') {
          const killer = spawnCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
          const killTimeout = setTimeout(() => { killer.kill('SIGKILL'); child.kill('SIGKILL'); reject(new AiCredentialRuntimeError('COMMAND_TREE_TERMINATION_FAILED')) }, 5_000)
          killer.on('error', () => { clearTimeout(killTimeout); child.kill('SIGKILL'); reject(new AiCredentialRuntimeError('COMMAND_TREE_TERMINATION_FAILED')) })
          killer.on('close', (code) => { clearTimeout(killTimeout); reject(new AiCredentialRuntimeError(code === 0 ? kind : 'COMMAND_TREE_TERMINATION_FAILED')) })
          return
        }
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else {
        child.kill('SIGKILL')
      }
      reject(new AiCredentialRuntimeError(kind))
    }
    const collect = (target: Buffer[]) => {
      let outputBytes = 0
      return (chunk: Buffer) => {
        if (settled) return
        outputBytes += chunk.length
        if (outputBytes > (options.maxOutputBytes ?? MAX_PAYLOAD_BYTES)) {
          fail('COMMAND_OUTPUT_TOO_LARGE')
          return
        }
        target.push(chunk)
      }
    }
    child.stdout!.on('data', collect(stdout))
    child.stderr!.on('data', collect(stderr))
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT' ? 'COMMAND_NOT_AVAILABLE' : 'COMMAND_FAILED')
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (code !== 0) {
        if (!options.acceptNonZeroExit) {
          reject(new AiCredentialRuntimeError('COMMAND_FAILED'))
          return
        }
      }
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(options.acceptNonZeroExit && { exitCode: code ?? -1 }),
      })
    })
    timeout = setTimeout(() => fail('COMMAND_TIMED_OUT'), options.timeoutMs ?? 30_000)
    if (options.input !== undefined) {
      child.stdin?.on('error', () => fail('COMMAND_FAILED'))
      child.stdin?.end(options.input)
    }
  })
}

export function withUvToolBinOnPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
  command: 'uv' | 'cswap' = 'cswap',
): NodeJS.ProcessEnv {
  const toolBin = (command === 'uv' ? environment.UV_INSTALL_DIR : environment.UV_TOOL_BIN_DIR)
    || environment.XDG_BIN_HOME
    || (environment.XDG_DATA_HOME
      ? join(environment.XDG_DATA_HOME, '..', 'bin')
      : join(homeDir, '.local', 'bin'))
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const currentPath = environment[pathKey] ?? ''
  const remainingPath = currentPath
    .split(delimiter)
    .filter((entry) => entry && entry !== toolBin)
  return {
    ...environment,
    [pathKey]: [toolBin, ...remainingPath].join(delimiter),
  }
}

export type AiCredentialRuntime = ReturnType<typeof createAiCredentialRuntime>
