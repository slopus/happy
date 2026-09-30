import type { CodexMultiAuthBundle } from './aiCredentialRuntime'

// Existing slots win: imported backups cannot prove that their tokens are newer.
// Append only, so active, pinned and family indexes retain their meaning.
export function mergeCodexAccounts(
  existing: CodexMultiAuthBundle['accounts'],
  incoming: CodexMultiAuthBundle['accounts'],
): CodexMultiAuthBundle['accounts'] {
  const identity = (account: CodexMultiAuthBundle['accounts']['accounts'][number]) => {
    if (typeof account.accountId === 'string' && account.accountId.trim()) return `id:${account.accountId.trim()}`
    if (typeof account.email === 'string' && account.email.trim()) return `email:${account.email.trim().toLowerCase()}`
    return `refresh:${account.refreshToken.trim()}`
  }
  const accounts = [...existing.accounts]
  const identities = new Set(accounts.map(identity))
  for (const account of incoming.accounts) {
    const key = identity(account)
    if (identities.has(key)) continue
    identities.add(key)
    accounts.push(account)
  }
  return { ...existing, accounts }
}
