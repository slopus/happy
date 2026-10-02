import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import tweetnacl from 'tweetnacl'
import {
  AUTHENTICATED_ENVELOPE_BYTES,
  AUTHENTICATED_ENVELOPE_VERSION,
  openAutomationPayloadForMachine,
  openSessionFollowupPayloadForMachine,
  type AutomationCryptoAdapter,
  type AutomationPayload,
  type MachinePayloadOpening,
  type SessionFollowupDaemon,
  type SessionFollowupPayload,
} from '@slopus/happy-wire'
import { judgePayload, type PayloadTrust } from './payloadTrust'

const PAYLOAD_MAX_BYTES = 128 * 1024
const ENVELOPE_BYTES = 1 + tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength
  + tweetnacl.box.overheadLength + tweetnacl.secretbox.keyLength

export interface EncryptedServerAutomation {
  automationId: string
  revision: number
  generation: number
  payloadVersion: 1
  payloadCiphertext: string
  machineKeyVersion: number
  machineKeyEnvelope: string
  paused: boolean
  migrationPending?: boolean
  enabledAt: number
  runRequestedAt?: number | null
}

export interface ServerAutomationCacheState {
  cursor: bigint
  serverTime: number
  syncedAt: number
  automations: EncryptedServerAutomation[]
  pendingAcknowledgements: Array<{ automationId: string; revision: number }>
}

export type ServerAutomationPayload = AutomationPayload

export interface ServerAutomationCache {
  read(): ServerAutomationCacheState
  applySync(value: unknown): { nextSeq: bigint; acknowledgements: Array<{ automationId: string; revision: number }> }
  markAcknowledged(items: Array<{ automationId: string; revision: number }>): void
}

function fail(): never {
  throw new Error('automation-sync-invalid')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail()
  return value
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail()
  return value as number
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
  return value as number
}

function sequence(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail()
  return BigInt(value)
}

function base64(value: unknown, maxBytes: number, exactBytes?: number): string {
  const encoded = nonEmptyString(value)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail()
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length > maxBytes || (exactBytes !== undefined && decoded.length !== exactBytes)) fail()
  return encoded
}

function parseUpsert(row: Record<string, unknown>): EncryptedServerAutomation {
  if (row.kind !== 'UPSERT' || row.payloadVersion !== 1 || typeof row.paused !== 'boolean') fail()
  const payloadCiphertext = base64(row.payloadCiphertext, PAYLOAD_MAX_BYTES)
  const machineKeyEnvelope = base64(row.machineKeyEnvelope, AUTHENTICATED_ENVELOPE_BYTES)
  const envelope = Buffer.from(machineKeyEnvelope, 'base64')
  const anonymous = envelope.length === ENVELOPE_BYTES && envelope[0] === 1
  const authenticated = envelope.length === AUTHENTICATED_ENVELOPE_BYTES && envelope[0] === AUTHENTICATED_ENVELOPE_VERSION
  if (Buffer.from(payloadCiphertext, 'base64')[0] !== 1 || !(anonymous || authenticated)) fail()
  return {
    automationId: nonEmptyString(row.automationId),
    revision: positiveInteger(row.revision),
    generation: positiveInteger(row.generation),
    payloadVersion: 1,
    payloadCiphertext,
    machineKeyVersion: positiveInteger(row.machineKeyVersion),
    machineKeyEnvelope,
    paused: row.paused,
    migrationPending: row.migrationPending === true,
    enabledAt: timestamp(row.enabledAt),
    runRequestedAt: row.runRequestedAt === null || row.runRequestedAt === undefined
      ? null
      : timestamp(row.runRequestedAt),
  }
}

function readState(filePath: string): ServerAutomationCacheState {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cursor: 0n, serverTime: 0, syncedAt: 0, automations: [], pendingAcknowledgements: [] }
    }
    throw error
  }
  try {
    const disk = object(JSON.parse(raw))
    if (disk.version !== 1 || !Array.isArray(disk.automations) || !Array.isArray(disk.pendingAcknowledgements)) throw new Error()
    const state = {
      cursor: sequence(disk.cursor),
      serverTime: timestamp(disk.serverTime),
      syncedAt: timestamp(disk.syncedAt),
      automations: disk.automations.map((entry) => parseUpsert({ ...object(entry), kind: 'UPSERT' })),
      pendingAcknowledgements: disk.pendingAcknowledgements.map((entry) => {
        const row = object(entry)
        return { automationId: nonEmptyString(row.automationId), revision: positiveInteger(row.revision) }
      }),
    }
    chmodSync(filePath, 0o600)
    return state
  } catch {
    throw new Error('automation-cache-invalid')
  }
}

function persist(filePath: string, state: ServerAutomationCacheState): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({
    version: 1,
    cursor: state.cursor.toString(),
    serverTime: state.serverTime,
    syncedAt: state.syncedAt,
    automations: state.automations,
    pendingAcknowledgements: state.pendingAcknowledgements,
  }), { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, filePath)
  chmodSync(filePath, 0o600)
}

export function createServerAutomationCache(options: { filePath: string; now?: () => number }): ServerAutomationCache {
  return {
    read: () => readState(options.filePath),
    applySync(value) {
      const response = object(value)
      const serverTime = timestamp(response.serverTime)
      const nextSeq = sequence(response.nextSeq)
      if (!Array.isArray(response.changes)) fail()
      const current = readState(options.filePath)
      if (nextSeq < current.cursor) fail()

      const byId = new Map(current.automations.map((automation) => [automation.automationId, automation]))
      const acknowledgements = new Map(current.pendingAcknowledgements.map((item) => [item.automationId, item.revision]))
      let previousSeq = current.cursor
      for (const value of response.changes) {
        const row = object(value)
        const seq = sequence(row.seq)
        if (seq <= previousSeq || seq > nextSeq) fail()
        previousSeq = seq
        const automationId = nonEmptyString(row.automationId)
        const revision = positiveInteger(row.revision)
        positiveInteger(row.generation)
        const existing = byId.get(automationId)
        if (row.kind === 'TOMBSTONE') {
          if (!existing || revision >= existing.revision) byId.delete(automationId)
          continue
        }
        const upsert = parseUpsert(row)
        if (!existing || upsert.revision > existing.revision) byId.set(automationId, upsert)
        acknowledgements.set(automationId, Math.max(acknowledgements.get(automationId) ?? 0, revision))
      }

      const pendingAcknowledgements = [...acknowledgements]
        .map(([automationId, revision]) => ({ automationId, revision }))
      persist(options.filePath, {
        cursor: nextSeq,
        serverTime,
        syncedAt: (options.now ?? Date.now)(),
        automations: [...byId.values()],
        pendingAcknowledgements,
      })
      return {
        nextSeq,
        acknowledgements: pendingAcknowledgements,
      }
    },
    markAcknowledged(items) {
      const state = readState(options.filePath)
      const acknowledged = new Map(items.map((item) => [item.automationId, item.revision]))
      const pendingAcknowledgements = state.pendingAcknowledgements.filter((item) => (
        (acknowledged.get(item.automationId) ?? 0) < item.revision
      ))
      if (pendingAcknowledgements.length === state.pendingAcknowledgements.length) return
      persist(options.filePath, { ...state, pendingAcknowledgements })
    },
  }
}

/** tweetnacl behind the wire's adapter; the daemon only ever opens with it. */
const machineCrypto: AutomationCryptoAdapter = {
  randomBytes: (length) => tweetnacl.randomBytes(length),
  secretBoxSeal: (plaintext, key) => {
    const nonce = tweetnacl.randomBytes(tweetnacl.secretbox.nonceLength)
    return new Uint8Array([...nonce, ...tweetnacl.secretbox(plaintext, nonce, key)])
  },
  secretBoxOpen: (bundle, key) => tweetnacl.secretbox.open(
    bundle.subarray(tweetnacl.secretbox.nonceLength), bundle.subarray(0, tweetnacl.secretbox.nonceLength), key,
  ),
  boxSeal: (plaintext, publicKey) => {
    const ephemeral = tweetnacl.box.keyPair()
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength)
    return new Uint8Array([...ephemeral.publicKey, ...nonce, ...tweetnacl.box(plaintext, nonce, publicKey, ephemeral.secretKey)])
  },
  boxOpen: (bundle, secretKey) => tweetnacl.box.open(
    bundle.subarray(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength),
    bundle.subarray(tweetnacl.box.publicKeyLength, tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength),
    bundle.subarray(0, tweetnacl.box.publicKeyLength),
    secretKey,
  ),
  sha256: async (value) => new Uint8Array(createHash('sha256').update(value).digest()),
  encodeBase64: (value) => Buffer.from(value).toString('base64'),
  decodeBase64: (value) => new Uint8Array(Buffer.from(value, 'base64')),
}

export function openServerAutomationPayload(
  automation: EncryptedServerAutomation,
  machineSecretKey: Uint8Array,
): MachinePayloadOpening<ServerAutomationPayload> {
  return openAutomationPayloadForMachine({
    payloadVersion: 1,
    payloadCiphertext: automation.payloadCiphertext,
    machineKeyEnvelope: automation.machineKeyEnvelope,
    recipientSecretKey: machineSecretKey,
    crypto: machineCrypto,
  })
}

export function openSessionFollowupDaemonPayload(
  followup: SessionFollowupDaemon,
  machineSecretKey: Uint8Array,
): MachinePayloadOpening<SessionFollowupPayload> {
  return openSessionFollowupPayloadForMachine({
    payloadVersion: 1,
    payloadCiphertext: followup.payloadCiphertext,
    machineKeyEnvelope: followup.machineKeyEnvelope,
    recipientSecretKey: machineSecretKey,
    crypto: machineCrypto,
  })
}

interface TrustedPayloadInput {
  machineSecretKey: Uint8Array
  trust: PayloadTrust
  machineId: string
  /** Called when compat runs an anonymous payload, so it can be recorded (R14). */
  onUnauthenticated?: () => void
}

/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R13/R14 — the payload
 * this daemon may run, or an Error named by the refusal code. A sender-sealed
 * automation must have been sealed for this machine.
 */
export function trustedServerAutomationPayload(
  automation: EncryptedServerAutomation,
  input: TrustedPayloadInput,
): ServerAutomationPayload {
  const verdict = judgePayload({
    trust: input.trust,
    opening: openServerAutomationPayload(automation, input.machineSecretKey),
    contextMatches: (payload) => payload.seal?.machineId === input.machineId,
  })
  if (!verdict.run) throw new Error(verdict.code)
  if (!verdict.authenticated) input.onUnauthenticated?.()
  return verdict.payload
}

/** As trustedServerAutomationPayload; a sender-sealed follow-up must name this machine, its project and its session. */
export function trustedSessionFollowupPayload(
  followup: SessionFollowupDaemon,
  input: TrustedPayloadInput,
): SessionFollowupPayload {
  const verdict = judgePayload({
    trust: input.trust,
    opening: openSessionFollowupDaemonPayload(followup, input.machineSecretKey),
    contextMatches: (payload) => payload.seal?.machineId === input.machineId
      && payload.seal.projectId === followup.projectId
      && payload.seal.sessionId === followup.sessionId,
  })
  if (!verdict.run) throw new Error(verdict.code)
  if (!verdict.authenticated) input.onUnauthenticated?.()
  return verdict.payload
}
