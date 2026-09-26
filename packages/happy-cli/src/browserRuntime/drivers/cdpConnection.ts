/**
 * Minimal raw CDP client over one browser-level WebSocket with flattened
 * sessions. Every command names its session explicitly; there is no notion of
 * a "current" or "active" target here.
 */
import WebSocket from 'ws'
import { BrowserRuntimeError } from '../contracts'

export type CdpListener = (params: any, sessionId: string | undefined) => void

/** A protocol-level error returned by the browser for one command. */
export class CdpProtocolError extends Error {
    constructor(readonly method: string, readonly cdpCode: number, message: string) {
        super(`${method}: ${message}`)
        this.name = 'CdpProtocolError'
    }
}

interface Pending {
    method: string
    resolve: (value: any) => void
    reject: (error: Error) => void
}

export function connectionClosedError(): BrowserRuntimeError {
    return new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection closed', true, false)
}

export class CdpConnection {
    private nextId = 1
    private readonly pending = new Map<number, Pending>()
    private readonly listeners = new Map<string, Set<CdpListener>>()
    private readonly closeListeners = new Set<() => void>()
    private closedFlag = false
    /** Resolves when the socket is gone; never rejects. */
    readonly closedPromise: Promise<void>
    private resolveClosed!: () => void

    private constructor(private readonly ws: WebSocket) {
        this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })
        ws.on('message', (data) => this.onMessage(data.toString()))
        ws.on('close', () => this.onClosed())
        ws.on('error', () => this.onClosed())
    }

    static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
            const timer = setTimeout(() => {
                ws.terminate()
                reject(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection timed out', true, false))
            }, timeoutMs)
            ws.once('open', () => {
                clearTimeout(timer)
                resolve(new CdpConnection(ws))
            })
            ws.once('error', () => {
                clearTimeout(timer)
                reject(new BrowserRuntimeError('RUNTIME_UNAVAILABLE', 'browser connection failed', true, false))
            })
        })
    }

    get closed(): boolean {
        return this.closedFlag
    }

    send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
        if (this.closedFlag) return Promise.reject(connectionClosedError())
        const id = this.nextId++
        const message: Record<string, unknown> = { id, method, params }
        if (sessionId) message.sessionId = sessionId
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { method, resolve, reject })
            this.ws.send(JSON.stringify(message), (error) => {
                if (error && this.pending.delete(id)) reject(connectionClosedError())
            })
        })
    }

    /** Subscribe to an event on any session. Returns an unsubscribe function. */
    on(method: string, listener: CdpListener): () => void {
        let set = this.listeners.get(method)
        if (!set) {
            set = new Set()
            this.listeners.set(method, set)
        }
        set.add(listener)
        return () => { set!.delete(listener) }
    }

    onClose(listener: () => void): () => void {
        this.closeListeners.add(listener)
        return () => { this.closeListeners.delete(listener) }
    }

    close(): void {
        this.ws.close()
        this.onClosed()
    }

    private onMessage(raw: string): void {
        let message: any
        try {
            message = JSON.parse(raw)
        } catch {
            return
        }
        if (typeof message.id === 'number') {
            const pending = this.pending.get(message.id)
            if (!pending) return
            this.pending.delete(message.id)
            if (message.error) {
                pending.reject(new CdpProtocolError(pending.method, message.error.code, message.error.message))
            } else {
                pending.resolve(message.result ?? {})
            }
            return
        }
        if (typeof message.method === 'string') {
            const set = this.listeners.get(message.method)
            if (!set) return
            for (const listener of [...set]) {
                try {
                    listener(message.params ?? {}, message.sessionId)
                } catch {
                    // A listener bug must not break the dispatch loop.
                }
            }
        }
    }

    private onClosed(): void {
        if (this.closedFlag) return
        this.closedFlag = true
        const error = connectionClosedError()
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.resolveClosed()
        for (const listener of [...this.closeListeners]) {
            try {
                listener()
            } catch {
                // ignore
            }
        }
    }
}
