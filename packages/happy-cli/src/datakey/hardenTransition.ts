/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — switching a
 * machine from compat to strict (`happy datakey harden`).
 *
 * The marks a strict start trusts live under the happy home, which compat
 * leaves open to the file RPCs of whoever holds the machine key. The switch
 * therefore drops them (see `planHarden`) while it holds the lock every daemon
 * start takes: no compat daemon runs to write them again, and the first strict
 * start makes its own key. The files are judged again under the lock, since
 * they could change until no daemon could run.
 */
import { planHarden } from './machineControlStatus'
import type { MachineControlMode } from './machineControl'

export type HardenState = { mode: MachineControlMode; rawCredentials: unknown | null; pendingExists: boolean }

export type HardenIo = {
  readState(): Promise<HardenState>
  /** Takes the daemon start lock and resolves to its release; null while a daemon holds it. */
  lockDaemonStart(): Promise<(() => Promise<void>) | null>
  dropNeverEscrowed(): Promise<void>
  discardPendingRotation(): Promise<void>
  setStrict(): Promise<void>
}

export type HardenOutcome =
  | { ok: true; alreadyStrict: true }
  | { ok: true; alreadyStrict: false; reset: { neverEscrowed: boolean; pending: boolean } }
  | { ok: false; reason: 'no-credentials' | 'not-datakey' | 'daemon-running' }

export async function runHarden(io: HardenIo): Promise<HardenOutcome> {
  const first = planHarden(await io.readState())
  if (!first.ok || first.alreadyStrict) return first
  const release = await io.lockDaemonStart()
  if (!release) return { ok: false, reason: 'daemon-running' }
  try {
    const plan = planHarden(await io.readState())
    if (!plan.ok || plan.alreadyStrict) return plan
    if (plan.dropNeverEscrowed) await io.dropNeverEscrowed()
    if (plan.discardPending) await io.discardPendingRotation()
    await io.setStrict()
    return { ok: true, alreadyStrict: false, reset: { neverEscrowed: plan.dropNeverEscrowed, pending: plan.discardPending } }
  } finally {
    await release()
  }
}
