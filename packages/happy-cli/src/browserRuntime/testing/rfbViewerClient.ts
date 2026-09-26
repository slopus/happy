/**
 * A viewer that speaks raw RFB 3.8 over the Runtime's viewer WebSocket, as
 * noVNC does. Shared by the viewer proxy unit tests and the real-stack suite.
 */
import WebSocket from 'ws'
import { RFB_VERSION } from '../rfb'

export class RawRfbViewer {
    private buffered = Buffer.alloc(0)
    private wake: (() => void) | undefined
    readonly closed: Promise<{ code: number; reason: string }>

    private constructor(readonly ws: WebSocket) {
        ws.on('message', (data: Buffer) => { this.buffered = Buffer.concat([this.buffered, data]); this.wake?.() })
        this.closed = new Promise((resolve) => ws.on('close', (code, reason) => { this.wake?.(); resolve({ code, reason: reason.toString() }) }))
    }

    /** Rejects with `HTTP <status>` when the upgrade is refused. */
    static open(url: string, origin?: string, headers: Record<string, string> = {}): Promise<RawRfbViewer> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url, ['binary'], { headers: { ...headers, ...(origin ? { origin } : {}) } })
            ws.once('open', () => resolve(new RawRfbViewer(ws)))
            ws.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)))
            ws.once('error', reject)
        })
    }

    async read(length: number, timeoutMs = 3_000): Promise<Buffer> {
        const deadline = Date.now() + timeoutMs
        while (this.buffered.length < length) {
            if (this.ws.readyState !== WebSocket.OPEN || Date.now() > deadline) throw new Error(`viewer read of ${length} bytes failed`)
            await new Promise<void>((resolve) => { this.wake = resolve; setTimeout(resolve, 50) })
        }
        const bytes = this.buffered.subarray(0, length)
        this.buffered = this.buffered.subarray(length)
        return bytes
    }

    /** Bytes received and not yet read. */
    received(): Buffer { return this.buffered }

    send(bytes: Buffer, options: { fin?: boolean } = {}): void { this.ws.send(bytes, { binary: true, fin: options.fin ?? true }) }

    /** RFB 3.8 with security type None, non-shared ClientInit; returns the ServerInit summary. */
    async handshake(): Promise<{ width: number; height: number; name: string }> {
        const expect = (ok: boolean, what: string) => { if (!ok) throw new Error(`viewer handshake: ${what}`) }
        expect((await this.read(12)).toString('latin1') === RFB_VERSION, 'version')
        this.send(Buffer.from(RFB_VERSION, 'latin1'))
        expect((await this.read(2)).equals(Buffer.from([1, 1])), 'security types')
        this.send(Buffer.from([1]))
        expect((await this.read(4)).readUInt32BE(0) === 0, 'security result')
        this.send(Buffer.from([0]))
        const init = await this.read(24)
        const name = (await this.read(init.readUInt32BE(20))).toString('utf8')
        return { width: init.readUInt16BE(0), height: init.readUInt16BE(2), name }
    }
}
