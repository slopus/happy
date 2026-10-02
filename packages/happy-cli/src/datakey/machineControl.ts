/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R4/R5 — the machine key
 * the server may not hold.
 *
 * Compat, the default, registers as before: the server receives the machine
 * key wrapped to its own key, and with it every daemon RPC. Strict withholds
 * it, and first replaces any key the server may already hold. Only a key
 * generated here under strict, and recorded as never escrowed next to the key
 * in access.key, is kept. The server is not asked whether it holds a copy: a
 * server that kept one would say it had none.
 *
 * A replacement survives a crash at any point. The new key and its envelopes
 * are recorded in a pending file before the server sees them, the server swap
 * succeeds again when repeated, access.key is replaced in one rename only after
 * the swap, and the pending record is removed last. The next start resumes
 * whatever was left.
 *
 * settleMachineControl decides; MachineControlIo does the file and network
 * work, so every path here runs without either.
 */
import { createHash } from 'node:crypto'
import * as z from 'zod'
import { buildMachineKeyEnvelopes, decodeBase64, encodeBase64, encrypt } from '@/api/encryption'
import type { MachineMetadata } from '@/api/types'
import type { Credentials } from '@/persistence'

export type MachineControlMode = 'compat' | 'strict'

type DataKeyEncryption = Extract<Credentials['encryption'], { type: 'dataKey' }>

const pendingSchema = z.object({
  version: z.literal(1),
  machineId: z.string().min(1),
  /** sha256 (hex) of the machine key this rotation replaces. */
  fromKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
  machineKey: z.string().base64(),
  dataEncryptionKey: z.string().min(1),
  serverRpcKeyEnvelope: z.string().min(1).nullable(),
  lastError: z.string().optional(),
  lastAttemptAt: z.number().optional(),
})
export type PendingMachineKeyRotation = z.infer<typeof pendingSchema>

export function parsePendingMachineKeyRotation(raw: unknown): PendingMachineKeyRotation | null {
  const parsed = pendingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** What the rotation needs from the server's machine record. */
export type ServerMachineKeyState = { dataEncryptionKey: string | null; metadataVersion: number }

/** Body of POST /v1/machines/:id/key-rotation. It never carries a machine key envelope for the server. */
export type MachineKeyRotationRequest = {
  expectedDataEncryptionKey: string
  dataEncryptionKey: string
  serverRpcKeyEnvelope: string | null
  metadata: string
  expectedMetadataVersion: number
  daemonState: null
}

export interface MachineControlIo {
  readPending(): Promise<unknown | null>
  writePending(pending: PendingMachineKeyRotation): Promise<void>
  deletePending(): Promise<void>
  /** Replaces access.key in one rename. */
  writeCredentials(credentials: Credentials): Promise<void>
  /** Null when the server has no such machine for this account; throws when it cannot tell. */
  fetchMachine(machineId: string): Promise<ServerMachineKeyState | null>
  /** Throws MachineKeyRotationConflict when the server's record moved since it was read. */
  rotate(machineId: string, request: MachineKeyRotationRequest): Promise<void>
  randomKey(): Uint8Array
  now(): number
}

export class MachineKeyRotationConflict extends Error {
  constructor() {
    super('The machine record changed while its key was being replaced')
    this.name = 'MachineKeyRotationConflict'
  }
}

export class StrictMachineControlError extends Error {
  constructor(
    readonly reason: 'requires-datakey' | 'rotation-failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StrictMachineControlError'
  }
}

/** Attempts at the swap when the record keeps moving underneath it. */
const ROTATION_ATTEMPTS = 3

const keySha256 = (key: Uint8Array) => createHash('sha256').update(key).digest('hex')

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}

function withKey(credentials: Credentials, encryption: DataKeyEncryption, machineKey: Uint8Array, neverEscrowed: boolean): Credentials {
  return {
    token: credentials.token,
    encryption: {
      type: 'dataKey',
      publicKey: encryption.publicKey,
      machineKey,
      ...(neverEscrowed ? { neverEscrowed: true as const } : {}),
    },
  }
}

/**
 * The credentials this daemon registers and serves RPC with. Throws
 * StrictMachineControlError when strict mode cannot be put in force, so a
 * daemon never comes up on a key the server may hold while strict is on.
 */
export async function settleMachineControl(input: {
  mode: MachineControlMode
  credentials: Credentials
  machineId: string
  /** The server service key (base64) registration wraps to, if configured. */
  serverPublicKey: string | null
  /** Re-encrypted under the new key in place of whatever the server stored under the old one. */
  metadata: MachineMetadata
  io: MachineControlIo
}): Promise<Credentials> {
  const { mode, credentials, machineId, io } = input
  const encryption = credentials.encryption
  if (encryption.type !== 'dataKey') {
    if (mode === 'strict') {
      throw new StrictMachineControlError(
        'requires-datakey',
        'Strict machine control needs dataKey credentials; this machine key is the account secret',
      )
    }
    return credentials
  }

  const pending = await claimPending(io, machineId, encryption.machineKey)
  if (!pending && (mode === 'compat' || encryption.neverEscrowed)) {
    // Compat registration wraps the key for the server again, so the mark
    // would no longer be true by the time anyone read it.
    if (mode === 'compat' && encryption.neverEscrowed && input.serverPublicKey) {
      const marked = withKey(credentials, encryption, encryption.machineKey, false)
      await io.writeCredentials(marked)
      return marked
    }
    return credentials
  }

  const rotation = pending ?? await startRotation(input, encryption)
  try {
    await swapOnServer(input, rotation)
    const replaced = withKey(credentials, encryption, decodeBase64(rotation.machineKey), mode === 'strict')
    await io.writeCredentials(replaced)
    await io.deletePending()
    return replaced
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await io.writePending({ ...rotation, lastError: message, lastAttemptAt: io.now() }).catch(() => {})
    if (mode === 'strict') {
      throw new StrictMachineControlError('rotation-failed', `Could not replace the machine key: ${message}`, { cause: error })
    }
    // Compat can serve on the current key; the next start tries again.
    return credentials
  }
}

/**
 * The pending rotation that continues from `currentKey`, or null. A record
 * for another machine or key, or one already promoted into access.key, is
 * removed.
 */
async function claimPending(io: MachineControlIo, machineId: string, currentKey: Uint8Array): Promise<PendingMachineKeyRotation | null> {
  const raw = await io.readPending()
  if (raw === null) return null
  const pending = parsePendingMachineKeyRotation(raw)
  if (pending
    && pending.machineId === machineId
    && pending.fromKeySha256 === keySha256(currentKey)
    && !sameKey(decodeBase64(pending.machineKey), currentKey)) {
    return pending
  }
  await io.deletePending()
  return null
}

async function startRotation(
  input: { machineId: string; serverPublicKey: string | null; io: MachineControlIo },
  encryption: DataKeyEncryption,
): Promise<PendingMachineKeyRotation> {
  const machineKey = input.io.randomKey()
  const envelopes = buildMachineKeyEnvelopes(
    { machineKey, accountPublicKey: encryption.publicKey },
    input.serverPublicKey ? decodeBase64(input.serverPublicKey) : null,
    { escrowMachineKey: false },
  )
  const pending: PendingMachineKeyRotation = {
    version: 1,
    machineId: input.machineId,
    fromKeySha256: keySha256(encryption.machineKey),
    machineKey: encodeBase64(machineKey),
    dataEncryptionKey: encodeBase64(envelopes.dataEncryptionKey!),
    serverRpcKeyEnvelope: envelopes.serverRpcKeyEnvelope ? encodeBase64(envelopes.serverRpcKeyEnvelope) : null,
  }
  await input.io.writePending(pending)
  return pending
}

/** Swaps the server's envelopes for the pending ones; a machine the server does not have needs no swap. */
async function swapOnServer(
  input: { machineId: string; metadata: MachineMetadata; io: MachineControlIo },
  rotation: PendingMachineKeyRotation,
): Promise<void> {
  const metadata = encodeBase64(encrypt(decodeBase64(rotation.machineKey), 'dataKey', input.metadata))
  for (let attempt = 1; ; attempt++) {
    const current = await input.io.fetchMachine(input.machineId)
    if (current === null) return
    if (!current.dataEncryptionKey) {
      throw new Error('The server holds no account envelope for this machine')
    }
    try {
      await input.io.rotate(input.machineId, {
        expectedDataEncryptionKey: current.dataEncryptionKey,
        dataEncryptionKey: rotation.dataEncryptionKey,
        serverRpcKeyEnvelope: rotation.serverRpcKeyEnvelope,
        metadata,
        expectedMetadataVersion: current.metadataVersion,
        daemonState: null,
      })
      return
    } catch (error) {
      if (!(error instanceof MachineKeyRotationConflict) || attempt >= ROTATION_ATTEMPTS) throw error
    }
  }
}
