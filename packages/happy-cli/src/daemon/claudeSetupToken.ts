/**
 * Organisation-managed Claude setup-token accounts (specs/claude-setup-token-runtime).
 *
 * The payload shape is the Studio server's vault format and the stored metadata
 * is the marked cswap token runtime's (`saycode-setup-token-runtime-v1`). cswap
 * storage is authoritative for managed ID, generation and display name; Happy
 * keeps no parallel ledger. Tokens are only hashed for local comparison.
 */
import { createHash } from 'node:crypto'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const SYNTHETIC = new RegExp(`^managed-(${UUID})@setup-token\\.local$`)
export const SETUP_TOKEN_RUNTIME_ARTIFACT = 'saycode-setup-token-runtime-v1'

export function managedSetupTokenEmail(managedAccountId: string): string {
  const email = `managed-${managedAccountId}@setup-token.local`
  if (!SYNTHETIC.test(email)) throw new Error('AI_GROUP_INVALID_PAYLOAD')
  return email
}

export function managedSetupTokenId(email: unknown): string | null {
  return typeof email === 'string' ? SYNTHETIC.exec(email)?.[1] ?? null : null
}

/** Same as the server's group ref identity, so daemon receipts and server refs agree. */
export function setupTokenGroupIdentity(managedAccountId: string): string {
  return createHash('sha256').update(JSON.stringify(['claude-setup-token', managedAccountId])).digest('hex')
}

/**
 * A payload account claiming setup_token must match the server contract exactly;
 * anything else is rejected rather than imported as an ordinary OAuth slot.
 */
export function isManagedSetupTokenAccount(account: Record<string, unknown>): boolean {
  if (account.credentialType !== 'setup_token') return false
  const oauth = (account.credentials as { claudeAiOauth?: Record<string, unknown> } | undefined)?.claudeAiOauth
  if (typeof account.managedAccountId !== 'string' || account.email !== managedSetupTokenEmail(account.managedAccountId)
    || (account.organizationUuid ?? '') !== ''
    || !Number.isSafeInteger(account.credentialGeneration) || Number(account.credentialGeneration) < 1
    || typeof account.displayName !== 'string' || !account.displayName.trim() || account.displayName.length > 120
    || typeof oauth?.accessToken !== 'string' || !oauth.accessToken.startsWith('sk-ant-oat01-')
    || oauth.refreshToken !== undefined) throw new Error('AI_GROUP_INVALID_PAYLOAD')
  return true
}

function digest(account: Record<string, unknown>): string | null {
  const token = (account.credentials as { claudeAiOauth?: { accessToken?: unknown } } | undefined)?.claudeAiOauth?.accessToken
  return typeof token === 'string' ? createHash('sha256').update(token).digest('hex') : null
}

/** What must survive storage exactly: identity, generation, admin label and credential. */
export function sameManagedSetupToken(stored: Record<string, unknown> | undefined, incoming: Record<string, unknown>): boolean {
  return !!stored && stored.credentialType === 'setup_token' && stored.managedAccountId === incoming.managedAccountId
    && stored.credentialGeneration === incoming.credentialGeneration && stored.displayName === incoming.displayName
    && digest(stored) !== null && digest(stored) === digest(incoming)
}

/**
 * Only the marked runtime preserves managed metadata on import/export. Numeric
 * versions are not evidence: an upstream build with the same number drops it.
 */
export function supportsManagedSetupTokens(stdout: string): boolean {
  try {
    const value = JSON.parse(stdout)
    return value?.version === 1 && value.artifact === SETUP_TOKEN_RUNTIME_ARTIFACT && value.managedAccountMetadata === true
  } catch { return false }
}

export function parseCswapVersion(stdout: string): string | null {
  return /^(?:cswap|claude-swap) (\d+\.\d+\.\d+(?:[a-z]+\d+)?)\s*$/.exec(stdout)?.[1] ?? null
}

/** True when `version` is at least the 0.25.0 pin; a pre-release of 0.25.0 precedes it. */
export function cswapAtLeastPinned(version: string | null): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)
  if (!parts) return false
  const [major, minor, patch] = parts as [number, number, number]
  return major > 0 || minor > 25 || (minor === 25 && (patch > 0 || version === '0.25.0'))
}

export type SetupTokenAccountStatus = {
  managedAccountId: string
  active: boolean
  disabled: boolean
  /** Stored is not verified: only an explicit inference check may change this. */
  authState: 'unverified'
  usageState: 'fresh' | 'unavailable'
  usageReason: string | null
}

/** Secret-free, additive view of managed setup-token slots in `cswap list --json`. */
export function setupTokenRuntimeStatus(accounts: Array<Record<string, unknown>>, activeAccountNumber: number | null) {
  const rows: SetupTokenAccountStatus[] = []
  for (const account of accounts) {
    const managedAccountId = managedSetupTokenId(account.email)
    if (!managedAccountId) continue
    const status = typeof account.usageStatus === 'string' ? account.usageStatus : null
    rows.push({ managedAccountId, active: account.number === activeAccountNumber, disabled: account.disabled === true,
      authState: 'unverified', usageState: status === 'ok' ? 'fresh' : 'unavailable', usageReason: status === 'ok' ? null : status ?? 'unknown' })
  }
  return { version: 1 as const, accounts: rows }
}
