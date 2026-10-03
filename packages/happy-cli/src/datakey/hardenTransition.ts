/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary R17 — switching a
 * machine from compat to strict (`happy datakey harden`).
 *
 * The marks a strict start trusts live under the happy home, which compat
 * leaves open to the file RPCs of whoever holds the machine key. The switch
 * therefore drops them (see `planHarden`) while it holds the lock every daemon
 * start takes: no compat daemon runs to write them again, and the first strict
 * start makes its own key. The files are judged again under the lock, since
 * they could change until no daemon could run. A machine already marked strict
 * is reset the same way, since the mark is a file compat could write too. The
 * automation key is replaced for the same reason: compat left it readable, and
 * its holder could make envelopes that open as sent by the customer.
 */
import { planHarden } from './machineControlStatus'
import type { MachineControlMode } from './machineControl'

export type HardenState = { mode: MachineControlMode; rawCredentials: unknown | null; pendingExists: boolean }

export type HardenIo = {
  readState(): Promise<HardenState>
  /** Takes the daemon start lock and resolves to its release; null while a daemon holds it. */
  lockDaemonStart(): Promise<(() => Promise<void>) | null>
  /** Happy session processes still running (`hardenBlockingSessions`). */
  liveSessions(): Promise<Array<{ pid: number; command: string }>>
  dropNeverEscrowed(): Promise<void>
  discardPendingRotation(): Promise<void>
  /** 'absent' when the daemon has not made an automation key yet. */
  rotateAutomationKey(): Promise<'rotated' | 'absent'>
  setStrict(): Promise<void>
}

export type HardenOutcome =
  | { ok: true; markedStrict: boolean; reset: { neverEscrowed: boolean; pending: boolean; automationKey: boolean } }
  | { ok: false; reason: 'no-credentials' | 'not-datakey' | 'daemon-running' }
  | { ok: false; reason: 'sessions-running'; sessions: Array<{ pid: number; command: string }> }

export async function runHarden(io: HardenIo): Promise<HardenOutcome> {
  const first = planHarden(await io.readState())
  if (!first.ok) return first
  const release = await io.lockDaemonStart()
  if (!release) return { ok: false, reason: 'daemon-running' }
  try {
    // Sessions are detached and outlive the daemon. One started under compat would keep
    // compat's RPC policy, and a session key the server could have read, after the switch.
    const sessions = await io.liveSessions()
    if (sessions.length > 0) return { ok: false, reason: 'sessions-running', sessions }
    const plan = planHarden(await io.readState())
    if (!plan.ok) return plan
    if (plan.dropNeverEscrowed) await io.dropNeverEscrowed()
    if (plan.discardPending) await io.discardPendingRotation()
    const automationKey = await io.rotateAutomationKey()
    await io.setStrict()
    return {
      ok: true,
      markedStrict: plan.markedStrict,
      reset: { neverEscrowed: plan.dropNeverEscrowed, pending: plan.discardPending, automationKey: automationKey === 'rotated' },
    }
  } finally {
    await release()
  }
}

const SESSION_PROCESS_TYPES = new Set(['daemon-spawned-session', 'dev-daemon-spawned', 'user-session', 'dev-session'])

/** The session processes among `findAllHappyProcesses()`: never the daemon, a doctor run or this process. */
export function hardenBlockingSessions(
  processes: ReadonlyArray<{ pid: number; command: string; type: string }>,
): Array<{ pid: number; command: string }> {
  return processes.filter((process) => SESSION_PROCESS_TYPES.has(process.type)).map(({ pid, command }) => ({ pid, command }))
}
