import { app, BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type {
    HappyStateSnapshot,
    HappyWorkerMessage,
    HappyWorkerRequest,
    HappyWorkerRequestWithId,
} from '../../../shared/happy-protocol'
import { storageFilePath } from '../app-storage'

const __dirname = dirname(fileURLToPath(import.meta.url))

type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
}

const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com'
const DEFAULT_WEBAPP_URL = 'https://app.happy.engineering'

let worker: Worker | null = null
let latestState: HappyStateSnapshot = {
    status: 'starting',
    serverUrl: process.env.HAPPY_SERVER_URL || DEFAULT_SERVER_URL,
    webappUrl: process.env.HAPPY_WEBAPP_URL || DEFAULT_WEBAPP_URL,
    clientReady: false,
    updatedAt: Date.now(),
}
const pending = new Map<string, PendingRequest>()

function workerEntryPath(): string {
    const p = join(__dirname, 'happy-worker.js')
    if (!existsSync(p)) {
        // eslint-disable-next-line no-console
        console.error('[happy-host] worker bundle missing at', p)
    }
    return p
}

function ensureWorker(): Worker {
    if (worker) return worker
    const w = new Worker(workerEntryPath(), {
        workerData: {
            storagePath: storageFilePath('happy-auth.json'),
            serverUrl: process.env.HAPPY_SERVER_URL || DEFAULT_SERVER_URL,
            webappUrl: process.env.HAPPY_WEBAPP_URL || DEFAULT_WEBAPP_URL,
            clientId: `codium/${app.getVersion() || '0.0.0'}`,
        },
    })
    w.on('message', (msg: HappyWorkerMessage) => {
        if (msg.kind === 'state') {
            latestState = msg.state
            broadcastState()
            return
        }
        if (msg.kind === 'response') {
            latestState = msg.state
            broadcastState()
            const entry = pending.get(msg.requestId)
            if (!entry) return
            pending.delete(msg.requestId)
            if (msg.ok) {
                entry.resolve({ state: msg.state, value: msg.value })
            } else {
                entry.reject(new Error(msg.error))
            }
            return
        }
        if (msg.kind === 'fatal') {
            // eslint-disable-next-line no-console
            console.error('[happy-worker] fatal:', msg.error)
        }
    })
    w.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[happy-worker] error:', err)
        failPending(err.message || 'Happy worker crashed')
        latestState = {
            ...latestState,
            status: 'error',
            clientReady: false,
            error: err.message || 'Happy worker crashed',
            updatedAt: Date.now(),
        }
        broadcastState()
        worker = null
    })
    w.on('exit', (code) => {
        if (code !== 0) {
            const message = `Happy worker exited with code ${code}`
            // eslint-disable-next-line no-console
            console.error('[happy-worker]', message)
            failPending(message)
            latestState = {
                ...latestState,
                status: 'error',
                clientReady: false,
                error: message,
                updatedAt: Date.now(),
            }
            broadcastState()
        }
        worker = null
    })
    worker = w
    return w
}

function failPending(reason: string): void {
    for (const entry of pending.values()) {
        entry.reject(new Error(reason))
    }
    pending.clear()
}

function broadcastState(): void {
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('happy:state', latestState)
    }
}

function sendRequest(request: HappyWorkerRequest): Promise<unknown> {
    const requestId = randomUUID()
    const msg: HappyWorkerRequestWithId = { ...request, requestId }
    const w = ensureWorker()
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        w.postMessage(msg)
    })
}

export function registerHappyIpc(): void {
    ipcMain.handle('happy:state:get', async () => {
        const result = await sendRequest({ kind: 'getState' }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:create-account', async () => {
        const result = await sendRequest({ kind: 'createAccount' }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:start-link-device', async () => {
        const result = await sendRequest({ kind: 'startLinkDevice' }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:restore-secret', async (_e, secretKey: string) => {
        const result = await sendRequest({ kind: 'restoreSecret', secretKey }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:cancel-auth', async () => {
        const result = await sendRequest({ kind: 'cancelAuth' }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:logout', async () => {
        const result = await sendRequest({ kind: 'logout' }) as { state: HappyStateSnapshot }
        return result.state
    })
    ipcMain.handle('happy:client-status', async () => {
        const result = await sendRequest({ kind: 'clientStatus' }) as {
            state: HappyStateSnapshot
            value?: unknown
        }
        return result.value
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
