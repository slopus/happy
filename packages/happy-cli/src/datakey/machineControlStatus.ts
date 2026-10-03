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

export type HardenPlan =
  | { ok: true; alreadyStrict: true }
  | { ok: true; alreadyStrict: false; dropNeverEscrowed: boolean; discardPending: boolean }
  | { ok: false; reason: 'no-credentials' | 'not-datakey' }

/**
 * Strict needs a machine key of its own; a legacy machine's key is the account
 * secret the server holds. Switching from compat drops the never-escrowed mark
 * and any pending rotation: while compat ran, whoever held the machine key
 * (the server included) could write them through the file RPCs, and the first
 * strict start would trust them instead of making its own key. A machine that
 * is already strict keeps them, since only a strict daemon could write them.
 */
export function planHarden(input: { mode: MachineControlMode; rawCredentials: unknown | null; pendingExists: boolean }): HardenPlan {
  const credentials = input.rawCredentials === null ? null : parseCredentials(input.rawCredentials)
  if (!credentials) return { ok: false, reason: 'no-credentials' }
  if (credentials.encryption.type !== 'dataKey') return { ok: false, reason: 'not-datakey' }
  if (input.mode === 'strict') return { ok: true, alreadyStrict: true }
  return {
    ok: true,
    alreadyStrict: false,
    dropNeverEscrowed: credentials.encryption.neverEscrowed === true,
    discardPending: input.pendingExists,
  }
}
