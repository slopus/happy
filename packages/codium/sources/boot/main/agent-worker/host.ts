/* ─────────────────────────────────────────────────────────────────────────
 * Agent host — main-process side of the Claude Agent SDK worker.
 *
 * Owns one node:worker_threads Worker that runs the SDK. Tracks each
 * active session's originating renderer so events route back to the right
 * window via webContents.send.
 *
 * On a worker crash we emit a synthetic per-session error event for every
 * tracked session and respawn lazily on the next start.
 * ──────────────────────────────────────────────────────────────────────── */
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type {
    AgentEvent,
    FromWorker,
    ToWorker,
} from '../../../shared/agent-protocol'

const __dirname = dirname(fileURLToPath(import.meta.url))

let worker: Worker | null = null
const sessionOwners = new Map<string, number>() // sessionId → webContents.id

function workerEntryPath(): string {
    // electron-vite emits the worker bundle next to index.js.
    const p = join(__dirname, 'agent-worker.js')
    if (!existsSync(p)) {
        // Fall back gracefully — surface a clear error if the bundle is
        // missing so it's not silently hidden behind a Worker spawn failure.
        // eslint-disable-next-line no-console
        console.error('[agent-host] worker bundle missing at', p)
    }
    return p
}

function ensureWorker(): Worker {
    if (worker) return worker
    const w = new Worker(workerEntryPath())
    w.on('message', (msg: FromWorker) => {
        if (msg.kind === 'event') {
            forward(msg.sessionId, msg.event)
        } else if (msg.kind === 'closed') {
            forward(msg.sessionId, null) // sentinel handled below
            sessionOwners.delete(msg.sessionId)
        } else if (msg.kind === 'fatal') {
            // eslint-disable-next-line no-console
            console.error('[agent-worker] fatal:', msg.error)
        }
    })
    w.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[agent-worker] error:', err)
        crashAllSessions(err.message || 'Worker crashed')
        worker = null
    })
    w.on('exit', (code) => {
        if (code !== 0) {
            // eslint-disable-next-line no-console
            console.error(`[agent-worker] exited with code ${code}`)
            crashAllSessions(`Worker exited with code ${code}`)
        }
        worker = null
    })
    worker = w
    return w
}

function crashAllSessions(reason: string): void {
    for (const [sessionId] of sessionOwners) {
        forward(sessionId, { type: 'error', message: reason })
        forward(sessionId, null)
    }
    sessionOwners.clear()
}

/** Send an `event` for `sessionId` to its owning renderer.
 *  `event === null` is a sentinel meaning "session closed" — the renderer
 *  side waits for the dedicated channel to close. */
function forward(sessionId: string, event: AgentEvent | null): void {
    const senderId = sessionOwners.get(sessionId)
    if (senderId === undefined) return
    const wc = findWebContents(senderId)
    if (!wc) return
    if (event === null) {
        wc.send(`agent:closed:${sessionId}`)
    } else {
        wc.send(`agent:event:${sessionId}`, event)
    }
}

function findWebContents(id: number): WebContents | null {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.id === id) return win.webContents
    }
    return null
}

/** Wire IPC handlers. Call once during app startup. */
export function registerAgentIpc(): void {
    ipcMain.on('agent:start', (e, args: Extract<ToWorker, { kind: 'start' }>) => {
        if (!args || !args.sessionId) return
        const w = ensureWorker()
        sessionOwners.set(args.sessionId, e.sender.id)
        w.postMessage(args satisfies ToWorker)
    })
    ipcMain.on('agent:send', (_e, args: Extract<ToWorker, { kind: 'send' }>) => {
        if (!worker || !args?.sessionId) return
        worker.postMessage(args satisfies ToWorker)
    })
    ipcMain.on('agent:interrupt', (_e, args: Extract<ToWorker, { kind: 'interrupt' }>) => {
        if (!worker || !args?.sessionId) return
        worker.postMessage(args satisfies ToWorker)
    })
    ipcMain.on('agent:stop', (_e, args: Extract<ToWorker, { kind: 'stop' }>) => {
        if (!worker || !args?.sessionId) return
        worker.postMessage(args satisfies ToWorker)
    })
    app.on('before-quit', () => {
        try {
            worker?.terminate()
        } catch {
            /* ignored */
        }
        worker = null
    })
}
