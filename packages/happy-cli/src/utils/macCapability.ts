import { existsSync } from 'fs'
import { resolve } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { projectPath } from '@/projectPath'
import { logger } from '@/ui/logger'

export const MAC_CAPABILITY_CPU = 0x01
export const MAC_CAPABILITY_GRAPHICS = 0x02
export const MAC_CAPABILITY_NETWORK = 0x08
export const MAC_FULL_WAKE_MASK = MAC_CAPABILITY_CPU | MAC_CAPABILITY_GRAPHICS | MAC_CAPABILITY_NETWORK

const HELPER_NAME = 'happy-capability'
const STARTUP_TIMEOUT_MS = 5000

export type MacCapabilityMonitorStatus = 'unsupported' | 'pending' | 'ready' | 'unavailable'

export interface MacCapabilityMonitorState {
    status: MacCapabilityMonitorStatus
    fullWake: boolean | null
}

interface CapabilityMessage {
    event?: unknown
    phase?: unknown
    to?: unknown
}

interface MonitorDependencies {
    platform?: NodeJS.Platform
    helperPath?: string
    exists?: typeof existsSync
    spawn?: typeof spawn
    createInterface?: typeof createInterface
}

/**
 * Keeps one small IOKit observer alive for all API clients in this process.
 *
 * The helper is intentionally a separate process rather than a Node native
 * addon: it has no Node ABI dependency and can be shipped as a prebuilt
 * Darwin binary. A monitor with no initial capability event is pending and
 * therefore fails closed until the startup timeout makes it unavailable.
 */
export class MacCapabilityMonitor {
    private readonly platform: NodeJS.Platform
    private readonly helperPath: string
    private readonly fileExists: typeof existsSync
    private readonly spawnProcess: typeof spawn
    private readonly makeInterface: typeof createInterface

    private child: ChildProcess | null = null
    private output: Interface | null = null
    private startupTimer: NodeJS.Timeout | null = null
    private references = 0
    private startAttempted = false
    private status: MacCapabilityMonitorStatus
    private fullWake: boolean | null = null

    constructor(dependencies: MonitorDependencies = {}) {
        this.platform = dependencies.platform ?? process.platform
        this.helperPath = dependencies.helperPath ?? resolve(projectPath(), 'tools', 'unpacked', HELPER_NAME)
        this.fileExists = dependencies.exists ?? existsSync
        this.spawnProcess = dependencies.spawn ?? spawn
        this.makeInterface = dependencies.createInterface ?? createInterface
        this.status = this.platform === 'darwin' ? 'unavailable' : 'unsupported'
    }

    /** Retain the process-wide monitor for one API client. */
    acquire(): void {
        if (this.platform !== 'darwin') return
        this.references += 1
        this.ensureStarted()
    }

    /** Release one API client's monitor reference. */
    release(): void {
        if (this.platform !== 'darwin' || this.references === 0) return
        this.references -= 1
        if (this.references === 0) this.stop()
    }

    /** Return the latest state for retained API-client owners. */
    getState(): MacCapabilityMonitorState {
        if (this.platform !== 'darwin') {
            return { status: 'unsupported', fullWake: null }
        }

        if (this.references > 0) this.ensureStarted()
        return { status: this.status, fullWake: this.fullWake }
    }

    /** Stop the helper and clear all state. Safe to call more than once. */
    stop(): void {
        this.clearStartupTimer()

        const output = this.output
        this.output = null
        output?.close()

        const child = this.child
        this.child = null
        if (child && !child.killed) {
            child.kill('SIGTERM')
        }

        this.startAttempted = false
        this.status = this.platform === 'darwin' ? 'unavailable' : 'unsupported'
        this.fullWake = null
    }

    private ensureStarted(): void {
        if (this.platform !== 'darwin' || this.child || this.startAttempted) return

        this.startAttempted = true
        if (!this.fileExists(this.helperPath)) {
            this.status = 'unavailable'
            logger.debug(`[mac capability] Helper not found at ${this.helperPath}`)
            return
        }

        let child: ChildProcess
        try {
            child = this.spawnProcess(this.helperPath, [], {
                stdio: ['ignore', 'pipe', 'ignore'],
            })
        } catch (error) {
            this.status = 'unavailable'
            logger.debug('[mac capability] Failed to start helper:', error)
            return
        }

        if (!child.stdout) {
            this.status = 'unavailable'
            child.once('error', () => {})
            child.kill('SIGTERM')
            logger.debug('[mac capability] Helper did not expose stdout')
            return
        }

        this.child = child
        this.status = 'pending'
        this.fullWake = null
        const output = this.makeInterface({ input: child.stdout })
        this.output = output
        output.on('line', (line) => this.handleLine(child, line))

        child.once('error', (error) => {
            if (this.child !== child) return
            this.markUnavailable(child, '[mac capability] Helper error:', error)
        })
        child.once('exit', (code, signal) => {
            if (this.child !== child) return
            this.markUnavailable(child, `[mac capability] Helper exited (${code ?? 'null'}/${signal ?? 'null'})`)
        })

        this.startupTimer = setTimeout(() => {
            if (this.child !== child || this.status !== 'pending') return
            this.markUnavailable(child, '[mac capability] Helper produced no initial state')
        }, STARTUP_TIMEOUT_MS)
    }

    private handleLine(child: ChildProcess, line: string): void {
        if (this.child !== child) return

        let parsed: unknown
        try {
            parsed = JSON.parse(line) as unknown
        } catch {
            return
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return
        }

        const message = parsed as CapabilityMessage
        if (message.event !== 'capability-change' || typeof message.to !== 'number' || !Number.isInteger(message.to)) {
            return
        }
        if (message.to < 0 || message.to > 0xffffffff) {
            return
        }

        // A will-change notification is useful for failing closed before the
        // machine loses graphics, but it is not proof that a full wake has
        // completed. Only the initial snapshot and did-change events may make
        // reconnect eligible.
        if (message.phase === 'will-change') {
            if ((message.to & MAC_FULL_WAKE_MASK) !== MAC_FULL_WAKE_MASK) {
                this.fullWake = false
            }
            return
        }

        if (message.phase !== 'initial' && message.phase !== 'did-change') {
            return
        }

        this.clearStartupTimer()
        this.status = 'ready'
        this.fullWake = (message.to & MAC_FULL_WAKE_MASK) === MAC_FULL_WAKE_MASK
    }

    private markUnavailable(child: ChildProcess, message: string, error?: unknown): void {
        if (this.child !== child) return

        this.clearStartupTimer()
        this.output?.close()
        this.output = null
        if (!child.killed) child.kill('SIGTERM')
        this.child = null
        this.status = 'unavailable'
        this.fullWake = null
        if (error === undefined) {
            logger.debug(message)
        } else {
            logger.debug(message, error)
        }
    }

    private clearStartupTimer(): void {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer)
            this.startupTimer = null
        }
    }
}

export const macCapabilityMonitor = new MacCapabilityMonitor()

export function retainMacCapabilityMonitor(): void {
    macCapabilityMonitor.acquire()
}

export function releaseMacCapabilityMonitor(): void {
    macCapabilityMonitor.release()
}

export function getMacCapabilityState(): MacCapabilityMonitorState {
    return macCapabilityMonitor.getState()
}