import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { withUvToolBinOnPath, type AiCredentialRotationStatus } from './aiCredentialRuntime'

export type ClaudeSwapChild = {
  pid?: number
  stdout?: { on(event: 'data', listener: (data: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (data: Buffer) => void): unknown } | null
  kill(signal: NodeJS.Signals): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

type SupervisorDependencies = {
  readEnabled(): Promise<boolean>
  writeEnabled(enabled: boolean): Promise<void>
  spawn(command: string, args: string[]): ClaudeSwapChild
  schedule(callback: () => void, delay: number): unknown
  clearSchedule(handle: unknown): void
}

export class ClaudeSwapSupervisor {
  private enabled = false
  private child: ClaudeSwapChild | null = null
  private restartHandle: unknown = null
  private restartAttempts = 0
  private stdoutBuffer = ''
  private quarantinedAccounts = new Set<string>()
  private activeBelowThreshold = false
  private currentStatus: AiCredentialRotationStatus = {
    state: 'stopped',
    lastErrorKind: null,
  }

  constructor(private readonly deps: SupervisorDependencies) {}

  async restore(): Promise<void> {
    this.enabled = await this.deps.readEnabled()
    if (this.enabled) this.start()
  }

  async enable(): Promise<void> {
    const wasEnabled = this.enabled
    this.enabled = true
    try {
      await this.deps.writeEnabled(true)
    } catch (error) {
      this.enabled = wasEnabled
      throw error
    }
    this.start()
  }

  async stop(): Promise<void> {
    const wasEnabled = this.enabled
    this.enabled = false
    try {
      await this.deps.writeEnabled(false)
    } catch (error) {
      this.enabled = wasEnabled
      throw error
    }
    await this.terminateChild()
  }

  shutdown(): void {
    const running = this.detachChild()
    if (running) running.kill('SIGTERM')
  }

  private detachChild(): ClaudeSwapChild | null {
    if (this.restartHandle !== null) {
      this.deps.clearSchedule(this.restartHandle)
      this.restartHandle = null
    }
    const running = this.child
    this.child = null
    this.restartAttempts = 0
    this.stdoutBuffer = ''
    this.activeBelowThreshold = false
    this.currentStatus = { state: 'stopped', lastErrorKind: null }
    return running
  }

  private async terminateChild(): Promise<void> {
    const running = this.detachChild()
    if (!running) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timeout: unknown = null
      const finish = (error?: Error, retainForRetry = false) => {
        if (settled) return
        settled = true
        if (timeout !== null) this.deps.clearSchedule(timeout)
        if (error) {
          if (retainForRetry && this.child === null) this.child = running
          this.currentStatus = { state: 'blocked', lastErrorKind: 'ROTATION_ERROR' }
          reject(error)
        } else {
          resolve()
        }
      }
      running.on('exit', () => finish())
      running.on('error', () => finish(
        new Error('claude-swap child failed while stopping'),
        true,
      ))
      timeout = this.deps.schedule(() => {
        try {
          running.kill('SIGKILL')
        } catch {
          // The failed hard kill is represented by the same fail-closed timeout error.
        }
        finish(new Error('claude-swap child did not exit after SIGTERM'), true)
      }, 5_000)
      try {
        running.kill('SIGTERM')
      } catch {
        finish(new Error('claude-swap child failed while stopping'), true)
      }
    })
  }

  status(): AiCredentialRotationStatus {
    const { warningKinds, ...status } = this.currentStatus
    return { ...status, ...(warningKinds?.length ? { warningKinds: [...warningKinds] } : {}) }
  }

  private start(): void {
    if (!this.enabled || this.child) return
    this.currentStatus = { ...this.currentStatus, state: 'starting', lastErrorKind: null }
    const child = this.deps.spawn('cswap', ['auto', '--strategy', 'consume-first', '--json'])
    this.child = child
    this.currentStatus = { ...this.currentStatus, ...this.healthyStatus() }

    // Drain both streams without logging their contents. Future claude-swap
    // versions may add account or credential fields to JSON events.
    this.stdoutBuffer = ''
    this.activeBelowThreshold = false
    child.stdout?.on('data', (data) => {
      if (this.child === child) this.consumeStdout(data)
    })
    child.stderr?.on('data', () => undefined)
    const scheduleRestart = (lastErrorKind: string) => {
      if (this.child !== child) return
      this.child = null
      this.activeBelowThreshold = false
      if (!this.enabled) {
        this.currentStatus = { state: 'stopped', lastErrorKind: null }
        return
      }
      this.currentStatus = {
        ...this.currentStatus,
        state: 'blocked',
        lastErrorKind,
      }
      const delay = Math.min(1_000 * (2 ** this.restartAttempts), 60_000)
      this.restartAttempts += 1
      this.restartHandle = this.deps.schedule(() => {
        this.restartHandle = null
        this.start()
      }, delay)
    }
    child.on('error', () => {
      if (child.pid === undefined) {
        scheduleRestart('PROCESS_START_FAILED')
        return
      }
      if (this.child !== child) return
      this.activeBelowThreshold = false
      this.currentStatus = {
        ...this.currentStatus,
        state: 'blocked',
        lastErrorKind: 'ROTATION_ERROR',
      }
    })
    child.on('exit', (code) => scheduleRestart(code === 0 ? 'PROCESS_STOPPED' : 'PROCESS_EXITED'))
  }

  private consumeStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString('utf8')
    if (this.stdoutBuffer.length > 64 * 1024) {
      this.stdoutBuffer = ''
      return
    }
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as unknown
        if (!isObject(event) || event.schemaVersion !== 1) continue
        const activeBelowThreshold = this.activeBelowThreshold
        // A decision may only use evidence from the immediately preceding poll.
        this.activeBelowThreshold = false
        if (event.event === 'all-exhausted') {
          this.currentStatus = {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'ALL_ACCOUNTS_EXHAUSTED',
          }
        } else if (event.event === 'error') {
          this.currentStatus = {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'ROTATION_ERROR',
          }
        } else if (event.event === 'account-quarantined'
          && typeof event.number === 'string'
          && event.number.length > 0) {
          this.quarantinedAccounts.add(event.number)
          this.currentStatus = {
            ...this.currentStatus,
            warningKinds: ['ACCOUNT_NEEDS_REAUTH'],
          }
        } else if (event.event === 'account-unquarantined'
          && typeof event.number === 'string') {
          this.quarantinedAccounts.delete(event.number)
          this.currentStatus = { ...this.currentStatus, warningKinds: this.healthyStatus().warningKinds }
        } else if (event.event === 'poll') {
          if (isObject(event.active)) this.restartAttempts = 0
          const headroom = isObject(event.active) && Number.isSafeInteger(event.active.number)
            && Number(event.active.number) > 0 && isObject(event.headroomPct)
            ? event.headroomPct[String(event.active.number)] : null
          this.activeBelowThreshold = typeof headroom === 'number' && Number.isFinite(headroom)
            && headroom > 0 && headroom <= 100
            && typeof event.threshold === 'number' && Number.isFinite(event.threshold)
            && event.threshold > 0 && event.threshold <= 100
            && 100 - headroom < event.threshold
        } else if (event.event === 'no-switch'
          && typeof event.reason === 'string'
          && HEALTHY_NO_SWITCH_REASONS.has(event.reason)) {
          this.currentStatus = { ...this.currentStatus, ...this.healthyStatus() }
        } else if (event.event === 'no-switch'
          && typeof event.reason === 'string'
          && BLOCKED_NO_SWITCH_REASONS.has(event.reason)) {
          this.currentStatus = event.reason === 'no-comparison' && activeBelowThreshold
            ? {
              ...this.currentStatus,
              ...this.healthyStatus(),
              warningKinds: [...(this.healthyStatus().warningKinds ?? []), 'NO_COMPARISON'],
            } : {
            ...this.currentStatus,
            state: 'blocked',
            lastErrorKind: 'NO_VIABLE_ACCOUNT',
          }
        } else if (event.event === 'switch'
          && event.dryRun !== true
          && typeof event.ts === 'string'
          && Number.isFinite(Date.parse(event.ts))
          && isObject(event.to)
          && typeof event.to.email === 'string') {
          this.restartAttempts = 0
          this.currentStatus = {
            ...this.currentStatus,
            ...this.healthyStatus(),
            lastSwitchAt: event.ts,
            activeAccount: maskEmail(event.to.email),
          }
        }
      } catch {
        // Ignore non-JSON diagnostic lines without retaining or logging them.
      }
    }
  }

  private healthyStatus(): Pick<AiCredentialRotationStatus, 'state' | 'lastErrorKind' | 'warningKinds'> {
    return {
      state: 'running', lastErrorKind: null,
      warningKinds: this.quarantinedAccounts.size > 0 ? ['ACCOUNT_NEEDS_REAUTH'] : undefined,
    }
  }
}

const HEALTHY_NO_SWITCH_REASONS = new Set([
  'active-api-key',
  'already-consuming-soonest',
  'below-threshold',
  'cooldown',
  'reset-unknown',
])

const BLOCKED_NO_SWITCH_REASONS = new Set([
  'no-candidates',
  'no-comparison',
  'no-qualifying-candidate',
  'no-viable-target',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at < 1) return '***'
  return `${email[0]}***${email.slice(at)}`
}

export function createClaudeSwapSupervisor(stateFile: string): ClaudeSwapSupervisor {
  return new ClaudeSwapSupervisor({
    readEnabled: async () => {
      try {
        const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as { enabled?: unknown }
        return parsed.enabled === true
      } catch {
        return false
      }
    },
    writeEnabled: async (enabled) => {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
      const temp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 })
      await rename(temp, stateFile)
    },
    spawn: (command, args) => nodeSpawn(command, args, {
      env: withUvToolBinOnPath(process.env, homedir()),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
    schedule: (callback, delay) => setTimeout(callback, delay),
    clearSchedule: (handle) => clearTimeout(handle as NodeJS.Timeout),
  })
}
