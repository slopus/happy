/**
 * Spawns a PTY-backed interactive shell on behalf of the web-ui remote
 * terminal panel. Mirrors startServer.ts's pure-utility shape — no logger,
 * no globals — so callers (apiMachine.ts terminal-* RPC, future
 * controlServer endpoints) can wire it into their own envelope shapes.
 *
 * Unlike startServer.ts the child stays alive under daemon supervision —
 * we hold the IPty handle so write/resize/kill can hit it. node-pty creates
 * the child as the leader of a fresh process group via setsid, so
 * `process.kill(-pid, signal)` reaches grandchildren too (e.g. the browser
 * launcher that `gh auth login` spawns). See specs/remote-terminal/.
 */

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export interface TerminateOpts {
    /** ms to wait for a graceful SIGHUP exit before escalating to SIGKILL. */
    graceMs?: number
    /** ms to wait for the process to disappear after SIGKILL. */
    killGraceMs?: number
}

/**
 * What `terminate()` actually had to do. Reported rather than swallowed: a
 * teardown API that claims a guarantee must let the caller see when the
 * guarantee did not hold — silence is what let the original leak run for
 * months (specs/remote-terminal-close-leak/).
 */
export type TerminateOutcome =
    /** Process was already gone before we signalled anything. */
    | 'already-gone'
    /** Exited on SIGHUP within the graceful window. The normal case. */
    | 'exited'
    /** Ignored/trapped SIGHUP; reaped by the SIGKILL escalation. */
    | 'killed'
    /** Still alive after SIGKILL — must never happen, must never be silent. */
    | 'escaped'

/** Default graceful window. Long enough for a shell to run its EXIT traps. */
const DEFAULT_GRACE_MS = 2000
const DEFAULT_KILL_GRACE_MS = 1000
const LIVENESS_POLL_MS = 25

export interface PtySessionOpts {
    userId: string
    shell?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
}

export interface PtySession {
    readonly id: string
    readonly userId: string
    readonly pid: number
    readonly cols: number
    readonly rows: number
    write(data: string): void
    resize(cols: number, rows: number): void
    /**
     * Raw signal delivery to the child's process group. Prefer `terminate()`
     * for close paths — a bare signal is never a termination guarantee.
     */
    kill(signal?: NodeJS.Signals): void
    /** True while the child process still exists (has not been reaped). */
    isAlive(): boolean
    /**
     * Guaranteed teardown: SIGHUP, then SIGKILL if the process is still there
     * after `graceMs`. Never rejects, and is safe to call twice.
     *
     * Why this exists and why callers must not hand-roll it: closing a remote
     * terminal used to send a bare SIGTERM, which an interactive shell ignores
     * outright (bash(1): "When Bash is interactive, in the absence of any
     * traps, it ignores SIGTERM"), so every closed terminal leaked a live
     * `/bin/bash -l` plus its pty descriptors. See
     * specs/remote-terminal-close-leak/.
     *
     * The escalation timer closes over `pid`/`child` rather than reading any
     * registry, so dropping the session from a bookkeeping map cannot cancel
     * the guarantee — which is exactly how the original leak became permanent.
     */
    terminate(opts?: TerminateOpts): Promise<TerminateOutcome>
    onData(cb: (chunk: string) => void): () => void
    onExit(cb: (code: number, signal: number | null) => void): () => void
}

const DEFAULT_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'

/**
 * The Windows standalone runtime's verified session launcher, used as the root of every
 * terminal (Desktop specs/windows-build-support W0-5h). node-pty cannot put the shell in a
 * Job, so the launcher runs inside the pseudoconsole and creates the shell atomically in a
 * kill-on-close Job; a terminal is closed only once its durable receipt shows that Job empty.
 */
export interface WindowsTerminalHost {
    launcher: string
    /** Protected directory for the per-terminal receipts. */
    receiptDirectory: string
    /** False once the runtime is draining: no new terminal may start behind the teardown. */
    acceptingTerminals(): boolean
}
let windowsTerminalHost: WindowsTerminalHost | null = null
export function configureWindowsTerminalHost(host: WindowsTerminalHost | null): void {
    windowsTerminalHost = host
}

/** The launcher takes an absolute .exe; resolve a bare shell name against PATH. */
function resolveWindowsShell(shell: string | undefined): string {
    const requested = shell || process.env.SHELL || ''
    if (!requested) return win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (win32.isAbsolute(requested) && /\.exe$/i.test(requested)) return requested
    const name = /\.exe$/i.test(requested) ? requested : `${requested}.exe`
    for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(';').filter(Boolean)) {
        const candidate = win32.join(directory, name)
        if (win32.isAbsolute(candidate) && existsSync(candidate)) return candidate
    }
    throw new Error(`Terminal shell not found: ${requested}`)
}

function createHostedPtySession(opts: PtySessionOpts, host: WindowsTerminalHost): PtySession {
    if (!host.acceptingTerminals()) throw new Error('Terminal launch gate closed')
    const id = randomUUID()
    const receipt = join(host.receiptDirectory, `${id}.json`)
    const initialCols = opts.cols ?? 80
    const initialRows = opts.rows ?? 24
    const child = pty.spawn(host.launcher, ['--pty-host', '--terminal-id', id, '--receipt', receipt, '--',
        resolveWindowsShell(opts.shell), ...(opts.args ?? [])], {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd: opts.cwd || homedir(),
        env: { ...process.env, ...(opts.env ?? {}) } as { [key: string]: string },
    })
    let cols = initialCols
    let rows = initialRows
    // The launcher exits only after its Job is empty or the receipt could not be written.
    let reaped = false
    child.onExit(() => { reaped = true })

    /** 'empty' only for this terminal's own receipt with an empty Job and no native error. */
    const readReceipt = (): 'empty' | 'not-empty' | null => {
        let text: string
        try { text = readFileSync(receipt, 'utf8') } catch { return null }
        try {
            const parsed = JSON.parse(text) as Record<string, unknown>
            return parsed.type === 'terminal-final' && parsed.terminalId === id && parsed.jobEmpty === true && parsed.nativeError === 0
                ? 'empty' : 'not-empty'
        } catch { return 'not-empty' }
    }
    const waitReceipt = async (ms: number) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
            const seen = readReceipt()
            if (seen) return seen
            await sleep(LIVENESS_POLL_MS)
        }
        return readReceipt()
    }

    return {
        id,
        userId: opts.userId,
        pid: child.pid,
        get cols() { return cols },
        get rows() { return rows },
        write(data: string) { child.write(data) },
        resize(c: number, r: number) {
            cols = c
            rows = r
            child.resize(c, r)
        },
        // Windows has no terminal signals: closing the pseudoconsole is the hang-up.
        kill() { try { child.kill() } catch {/* already dead */} },
        isAlive: () => !reaped,
        async terminate(terminateOpts?: TerminateOpts): Promise<TerminateOutcome> {
            const window = (terminateOpts?.graceMs ?? DEFAULT_GRACE_MS) + (terminateOpts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
            if (reaped) return (await waitReceipt(window)) === 'empty' ? 'already-gone' : 'escaped'
            try { child.kill() } catch {/* already dead */}
            return (await waitReceipt(window)) === 'empty' ? 'killed' : 'escaped'
        },
        onData(cb) {
            const sub = child.onData(cb)
            return () => sub.dispose()
        },
        onExit(cb) {
            const sub = child.onExit(({ exitCode, signal }) => { cb(exitCode, signal ?? null) })
            return () => sub.dispose()
        },
    }
}

export function createPtySession(opts: PtySessionOpts): PtySession {
    const host = process.platform === 'win32' ? windowsTerminalHost : null
    if (host) return createHostedPtySession(opts, host)
    const id = randomUUID()
    const shell = opts.shell || process.env.SHELL || DEFAULT_SHELL
    // Windows shells do not accept the POSIX login-shell flag.
    const args = opts.args ?? (process.platform === 'win32' ? [] : ['-l'])
    const cwd = opts.cwd || homedir()
    const env: { [key: string]: string } = { ...process.env, ...(opts.env ?? {}) } as { [key: string]: string }
    const initialCols = opts.cols ?? 80
    const initialRows = opts.rows ?? 24

    const child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd,
        env,
    })

    const pid = child.pid
    let cols = initialCols
    let rows = initialRows
    // node-pty only reports an exit once it has reaped the child, so this flag
    // being true means the process is definitively gone.
    let reaped = false
    child.onExit(() => { reaped = true })

    const signalGroup = (signal: NodeJS.Signals) => {
        // Process-group kill so backgrounded jobs (browser launcher
        // from `gh auth login`, npm subshells, etc.) are reaped along
        // with the shell. Falls back to single-process kill if the PG
        // is already gone (e.g. natural exit followed by explicit kill).
        //
        // The pid guard matters because `-0 === 0`, and process.kill(0, sig)
        // signals *our own* process group. node-pty throws rather than handing
        // back a zero pid, but now that this path can send SIGKILL, a bad pid
        // would take the whole daemon down instead of being a no-op.
        if (Number.isInteger(pid) && pid > 0) {
            try {
                process.kill(-pid, signal)
                return
            } catch {/* PG gone — fall through to the single-process kill */ }
        }
        try { child.kill(signal) } catch {/* already dead */ }
    }

    const isAlive = () => {
        if (reaped) return false
        try {
            process.kill(pid, 0)
            return true
        } catch {
            return false
        }
    }

    /** Poll until the process is gone or the window expires. */
    const waitGone = async (ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) {
            if (!isAlive()) return true
            await sleep(LIVENESS_POLL_MS)
        }
        return !isAlive()
    }

    return {
        id,
        userId: opts.userId,
        pid,
        get cols() { return cols },
        get rows() { return rows },
        write(data: string) {
            child.write(data)
        },
        resize(c: number, r: number) {
            cols = c
            rows = r
            child.resize(c, r)
        },
        // SIGHUP, not SIGTERM: this session is a *terminal*, and interactive
        // shells ignore SIGTERM by design. A SIGTERM default here silently
        // did nothing for years — see terminate()'s note.
        kill(signal: NodeJS.Signals = 'SIGHUP') {
            signalGroup(signal)
        },
        isAlive,
        async terminate(terminateOpts?: TerminateOpts): Promise<TerminateOutcome> {
            if (!isAlive()) return 'already-gone'
            signalGroup('SIGHUP')
            if (await waitGone(terminateOpts?.graceMs ?? DEFAULT_GRACE_MS)) return 'exited'
            // Still there: something trapped or ignored SIGHUP. SIGKILL cannot
            // be trapped, so this is the point where termination stops being a
            // request and becomes a guarantee.
            signalGroup('SIGKILL')
            return await waitGone(terminateOpts?.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
                ? 'killed'
                : 'escaped'
        },
        onData(cb) {
            const sub = child.onData(cb)
            return () => sub.dispose()
        },
        onExit(cb) {
            const sub = child.onExit(({ exitCode, signal }) => {
                cb(exitCode, signal ?? null)
            })
            return () => sub.dispose()
        },
    }
}
