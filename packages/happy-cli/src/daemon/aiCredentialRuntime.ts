import { stagingParent } from './stagedCredentialRoot'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
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
import { overlayManagedCredentialEnvironment } from './sessionEnv'

const MAX_PAYLOAD_BYTES = 1024 * 1024
const CLAUDE_SWAP_VERSION = '0.25.0'
const CLAUDE_STATUS_TIMEOUT_MS = 120_000
const CODEX_MULTI_AUTH_VERSION = '2.16.0'
// Bundles captured by an earlier pin stay deployable when that release wrote
// the same account (v3) and settings (v1) files. 2.15.0 and 2.16.0 ship an
// identical `dist/lib/storage`, so a vault bundle captured before this bump
// must not start failing apply the moment machines update.
const READABLE_CODEX_MULTI_AUTH_BUNDLE_VERSIONS: ReadonlySet<string> = new Set([
  '2.15.0',
  CODEX_MULTI_AUTH_VERSION,
])
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
  lastSwitchAt?: string
  activeAccount?: string
  strategy?: 'sequential'
  threshold5h?: number
  threshold7d?: number
}

type CommandOptions = {
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
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  makeTempDir(): Promise<string>
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
        await assertPinnedCodexMultiAuthInstalled()
        try {
          const accounts = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'openai-codex-accounts.json')))
          const settings = JSON.parse(await deps.readFile(join(codexMultiAuthDir(), 'settings.json')))
          payload = JSON.stringify({
            version: 1,
            kind: 'codex-multi-auth',
            packageVersion: CODEX_MULTI_AUTH_VERSION,
            accounts,
            settings,
          })
        } catch {
          throw new AiCredentialRuntimeError('CODEX_FILE_STORE_REQUIRED')
        }
      }
      assertPayloadSize(payload)
      return { provider: selected, payload }
    }))
  }

  async function ensureClaudeSwap(): Promise<void> {
    await deps.execFile('uv', ['--version'])
    await deps.execFile('uv', ['python', 'find', '>=3.12'])
    let installed = false
    try {
      const version = await deps.execFile('cswap', ['--version'])
      installed = /^(?:cswap|claude-swap) 0\.25\.0\s*$/.test(version.stdout)
    } catch {
      installed = false
    }
    if (!installed) {
      await deps.execFile('uv', [
        'tool', 'install', `claude-swap==${CLAUDE_SWAP_VERSION}`,
        '--python', '>=3.12', '--force',
      ], { timeoutMs: 300_000 })
    }
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.threshold', '95'])
    await deps.execFile('cswap', ['config', 'set', 'autoswitch.strategy', 'consume-first'])
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
        provider: 'claude' as const,
        configured: true,
        credentialKind: 'api_key' as const,
        rotation: apiKeyRotationStatus(),
      }
    }
    if (!details.activeUsable) {
      if (details.usableAccountNumber === null) {
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
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
        throw new AiCredentialRuntimeError('CLAUDE_APPLY_VERIFICATION_FAILED')
      }
    }
    await deps.supervisor.enable()
    return {
      provider: 'claude' as const,
      configured: true,
      rotation: deps.supervisor.status(),
    }
  }

  async function applyCodex(payload: string) {
    const bundle = parseCodexMultiAuthBundle(payload)
    if (bundle) return applyCodexMultiAuth(bundle)
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
    const installed = await hasPinnedCodexMultiAuthInstalled()
    if (!installed) {
      await deps.execFile('npm', [
        'install', '--global', `codex-multi-auth@${CODEX_MULTI_AUTH_VERSION}`,
      ], { timeoutMs: 300_000 })
      if (!await hasPinnedCodexMultiAuthInstalled()) {
        throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
      }
    }
    await deps.execFile('codex', ['--version'])
  }

  async function assertPinnedCodexMultiAuthInstalled(): Promise<void> {
    if (!await hasPinnedCodexMultiAuthInstalled()) {
      throw new AiCredentialRuntimeError('CODEX_MULTI_AUTH_VERSION_MISMATCH')
    }
  }

  async function hasPinnedCodexMultiAuthInstalled(): Promise<boolean> {
    try {
      const version = await deps.execFile('codex-multi-auth', ['--version'])
      return version.stdout.trim() === CODEX_MULTI_AUTH_VERSION
        && await hasPinnedGlobalCodexMultiAuthPackage()
    } catch {
      return false
    }
  }

  async function hasPinnedGlobalCodexMultiAuthPackage(): Promise<boolean> {
    try {
      const root = nonEmptyTrimmed((await deps.execFile('npm', ['root', '--global'])).stdout)
      if (!root) return false
      const packageJson = JSON.parse(await deps.readFile(join(
        root,
        'codex-multi-auth',
        'package.json',
      ))) as unknown
      return isObject(packageJson) && packageJson.version === CODEX_MULTI_AUTH_VERSION
    } catch {
      return false
    }
  }

  async function applyCodexMultiAuth(bundle: CodexMultiAuthBundle) {
    await ensureCodexMultiAuth()
    const root = codexMultiAuthDir()
    await deps.mkdir(root, { recursive: true, mode: 0o700 })
    await deps.chmod(root, 0o700)
    const settings = enforceCodexRotationSettings(bundle.settings)
    const accountsPath = join(root, 'openai-codex-accounts.json')
    const settingsPath = join(root, 'settings.json')
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

  async function apply(input: {
    provider: AiCredentialProvider
    payload: string
    trialLease?: TrialAiCredentialLeaseMarker
  }) {
    const selected = provider(input?.provider)
    if (typeof input?.payload !== 'string') {
      throw new AiCredentialRuntimeError('INVALID_PAYLOAD')
    }
    assertPayloadSize(input.payload)
    return serialize(() => withSafeErrors(
      `${selected.toUpperCase()}_APPLY_FAILED`,
      async () => {
        const applyGeneration = await reserveApplyGeneration(selected)
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
          const result = selected === 'claude'
            ? await applyClaude(input.payload)
            : selected === 'zai'
              ? await applyZai(input.payload)
              : await applyCodex(input.payload)
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
          return { ...result, applyGeneration }
        } catch (error) {
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
        await assertPinnedCodexMultiAuthInstalled()
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

  async function sessionEnvironment(agent: string | undefined): Promise<Record<string, string>> {
    if (agent !== undefined && agent !== 'claude') return {}
    return serialize(async () => {
      const marker = await readTrialMarker()
      if (!marker.leases.zai) return {}
      return parseZaiEnvironment(await deps.readFile(zaiEnvironmentPath()))
    })
  }

  return { capture, apply, purge, status, rotation, sessionEnvironment }
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

function parseClaudeList(stdout: string): {
  configured: boolean
  activeAccount: string | null
  credentialKind?: 'oauth' | 'api_key'
} {
  const { configured, activeAccount, activeCredentialKind } = parseClaudeListDetails(stdout)
  return {
    configured,
    activeAccount,
    ...(activeCredentialKind ? { credentialKind: activeCredentialKind } : {}),
  }
}

type CodexMultiAuthAccount = CodexAccountIdentity & {
  refreshToken: string
  addedAt: number
  lastUsed: number
  [key: string]: unknown
}

type CodexMultiAuthBundle = {
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
    || !READABLE_CODEX_MULTI_AUTH_BUNDLE_VERSIONS.has(parsed.packageVersion)
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
    execFile: runAiCredentialCommand,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, content, options) => { await writeFile(path, content, options) },
    mkdir,
    rename,
    chmod,
    rm,
    makeTempDir: () => mkdtemp(join(stagingParent(), 'happy-ai-credential-')),
    supervisor,
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
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const fail = (kind: string) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      child.kill('SIGKILL')
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
