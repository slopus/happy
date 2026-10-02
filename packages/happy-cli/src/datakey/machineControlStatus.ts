/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — the decisions
 * behind `happy datakey status`, `harden` and `compat`. Pure, like
 * activation.ts: the command reads the files and prints.
 */
import { parseCredentials } from '@/persistence'
import { parsePendingMachineKeyRotation, type MachineControlMode } from './machineControl'

export type MachineControlStatus = {
  mode: MachineControlMode
  /** Whether the server can hold the key this machine serves RPC with. */
  key: 'none' | 'account-secret' | 'may-be-escrowed' | 'never-escrowed'
  /** A key replacement that has not finished; never carries the key itself. */
  pending: { lastError?: string; lastAttemptAt?: number } | null
  /** Strict is set and the current key is one the server was never sent. */
  inForce: boolean
}

export function describeMachineControl(input: {
  mode: MachineControlMode
  rawCredentials: unknown | null
  rawPending: unknown | null
}): MachineControlStatus {
  const credentials = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  const key: MachineControlStatus['key'] = !credentials
    ? 'none'
    : credentials.encryption.type !== 'dataKey'
      ? 'account-secret'
      : credentials.encryption.neverEscrowed ? 'never-escrowed' : 'may-be-escrowed'
  const rotation = input.rawPending === null ? null : parsePendingMachineKeyRotation(input.rawPending)
  const pending = input.rawPending === null ? null : {
    ...(rotation?.lastError !== undefined ? { lastError: rotation.lastError } : {}),
    ...(rotation?.lastAttemptAt !== undefined ? { lastAttemptAt: rotation.lastAttemptAt } : {}),
  }
  return { mode: input.mode, key, pending, inForce: input.mode === 'strict' && key === 'never-escrowed' }
}

export type HardenPlan = { ok: true } | { ok: false; reason: 'no-credentials' | 'not-datakey' }

/** Strict needs a machine key of its own; a legacy machine's key is the account secret the server holds. */
export function planHarden(input: { rawCredentials: unknown | null }): HardenPlan {
  const credentials = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  if (!credentials) return { ok: false, reason: 'no-credentials' }
  if (credentials.encryption.type !== 'dataKey') return { ok: false, reason: 'not-datakey' }
  return { ok: true }
}
