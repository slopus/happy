import { createHash } from 'node:crypto'
import * as z from 'zod'
import { decodeBase64, encodeBase64 } from '@/api/encryption'
import type { Credentials } from '@/persistence'

/**
 * What a re-login on the same computer needs to come back as the same server
 * machine (specs/machine-identity-reuse). The server keeps the wrapped
 * machineKey write-once, so the id is reused only together with its key.
 * The legacy secret is recorded as a hash, never in the clear.
 */
const identitySchema = z.object({
  machineId: z.string().min(1),
  accountPublicKey: z.string().base64().optional(),
  legacySecretSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  machineKey: z.string().base64().optional(),
})
export type MachineIdentity = z.infer<typeof identitySchema>

export function parseMachineIdentity(raw: unknown): MachineIdentity | null {
  const parsed = identitySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function accountMarks(credentials: Credentials): Pick<MachineIdentity, 'accountPublicKey' | 'legacySecretSha256'> {
  const encryption = credentials.encryption
  if (encryption.type === 'dataKey') return { accountPublicKey: encodeBase64(encryption.publicKey) }
  return {
    legacySecretSha256: createHash('sha256').update(encryption.secret).digest('hex'),
    ...(encryption.provisioned ? { accountPublicKey: encodeBase64(encryption.provisioned.publicKey) } : {}),
  }
}

function credentialMachineKey(credentials: Credentials): Uint8Array | null {
  const encryption = credentials.encryption
  if (encryption.type === 'dataKey') return encryption.machineKey
  return encryption.provisioned?.machineKey ?? null
}

/**
 * `previous` of the same machine fills what these credentials do not carry yet — a returning legacy
 * login is provisioned later, and must then get the key its server machine already has.
 */
export function buildMachineIdentity(machineId: string, credentials: Credentials, previous?: MachineIdentity | null): MachineIdentity {
  const machineKey = credentialMachineKey(credentials)
  const kept = previous?.machineId === machineId ? previous : { machineId }
  return { ...kept, ...accountMarks(credentials), ...(machineKey ? { machineKey: encodeBase64(machineKey) } : {}) }
}

function sameAccount(identity: MachineIdentity, credentials: Credentials): boolean {
  const marks = accountMarks(credentials)
  return (!!marks.accountPublicKey && marks.accountPublicKey === identity.accountPublicKey)
    || (!!marks.legacySecretSha256 && marks.legacySecretSha256 === identity.legacySecretSha256)
}

/** The machine key to reuse when a dataKey login for `accountPublicKey` creates its credentials. */
export function reusableDataKeyMachineKey(identity: MachineIdentity | null, accountPublicKey: Uint8Array): Uint8Array | null {
  if (!identity?.machineKey || identity.accountPublicKey !== encodeBase64(accountPublicKey)) return null
  return decodeBase64(identity.machineKey)
}

/** The previous machine id, when these credentials are the same account with a compatible machine key. */
export function reusableMachineId(identity: MachineIdentity | null, credentials: Credentials): string | null {
  if (!identity || !sameAccount(identity, credentials)) return null
  const machineKey = credentialMachineKey(credentials)
  // dataKey machines are read with their key; a new key under the old id would be unreadable.
  if (credentials.encryption.type === 'dataKey' && !identity.machineKey) return null
  if (machineKey && identity.machineKey && encodeBase64(machineKey) !== identity.machineKey) return null
  return identity.machineId
}
