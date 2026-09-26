/**
 * RFB (RFC 6143) for the Runtime viewer proxy (D2): an incremental framer
 * driven by generator parsers, the parsers for both directions, VNC
 * authentication, and the few messages the proxy writes itself.
 *
 * Both directions are parsed completely. A header is forwarded only after the
 * parser accepted it; opaque payload (pixels, cut text) is streamed through
 * with its length fixed by an accepted header. Reads are bounded, so
 * fragmentation and coalescing of WebSocket/TCP chunks cannot change the result.
 *
 * Server→viewer framing is limited to encodings whose length and structure
 * follow from their headers (Raw, CopyRect, Hextile, DesktopSize, Cursor); the
 * proxy never forwards any other encoding in the viewer's SetEncodings, so the
 * server has no reason to use one and a server that does is cut off. ZRLE and
 * Tight are excluded on purpose: their zlib payload could only be bounded by
 * inflating it here (a 1x1 rectangle can expand to hundreds of KiB).
 */
import { createCipheriv } from 'node:crypto'
import { VIEWER_LIMITS } from './contracts'

export class RfbProtocolError extends Error {}

export const RFB_VERSION = 'RFB 003.008\n'
const SECURITY_NONE = 1
const SECURITY_VNC_AUTH = 2
const MAX_DIMENSION = 8192
const MAX_DESKTOP_NAME_BYTES = 4096
const MAX_CURSOR_DIMENSION = 512
const MAX_SERVER_CUT_TEXT_BYTES = 1024 * 1024

export const ENCODING = { raw: 0, copyRect: 1, hextile: 5, desktopSize: -223, cursor: -239 } as const
/** Encodings the server→viewer framer can bound; everything else is removed from SetEncodings. */
export const ALLOWED_ENCODINGS: ReadonlySet<number> = new Set(Object.values(ENCODING))

/** State shared by both directions of one viewer connection. */
export interface RfbSession {
    width: number
    height: number
    bytesPerPixel: number
    /** Every encoding forwarded upstream on this connection: updates already in flight may use an older list. */
    encodings: Set<number>
}

export type Step = { read: number; forward: boolean } | { skip: number }
export type RfbParser = Generator<Step, void, Buffer | undefined>

function* read(length: number, forward = false): Generator<Step, Buffer, Buffer | undefined> {
    return (yield { read: length, forward }) as Buffer
}

/**
 * Feeds arbitrary chunks to a parser. `read` steps hand the parser exactly the
 * requested bytes (forwarded afterwards if asked and the parser did not throw);
 * `skip` steps stream that many bytes to `forward` unparsed.
 */
export class StreamFramer {
    private readonly chunks: Buffer[] = []
    private buffered = 0
    private skipLeft = 0
    private state: IteratorResult<Step, void>

    constructor(private readonly parser: RfbParser, private readonly forward: (bytes: Buffer) => void, private readonly maxBuffered: number) {
        this.state = parser.next(undefined)
        this.enterStep()
    }

    push(chunk: Buffer): void {
        if (this.state.done) throw new RfbProtocolError('data after the end of the stream')
        if (chunk.length) {
            this.chunks.push(chunk)
            this.buffered += chunk.length
        }
        this.run()
        if (this.buffered > this.maxBuffered) throw new RfbProtocolError('peer sent too far ahead')
    }

    private run(): void {
        while (!this.state.done) {
            const step = this.state.value
            if ('skip' in step) {
                while (this.skipLeft > 0 && this.buffered > 0) {
                    const head = this.chunks[0]
                    const length = Math.min(head.length, this.skipLeft)
                    const bytes = head.subarray(0, length)
                    this.drop(length)
                    this.skipLeft -= length
                    this.forward(bytes)
                }
                if (this.skipLeft > 0) return
                this.advance(undefined)
            } else {
                if (this.buffered < step.read) return
                const bytes = this.take(step.read)
                this.advance(bytes)
                if (step.forward) this.forward(bytes)
            }
        }
    }

    private advance(value: Buffer | undefined): void {
        this.state = this.parser.next(value)
        this.enterStep()
    }

    private enterStep(): void {
        if (!this.state.done && 'skip' in this.state.value) this.skipLeft = this.state.value.skip
    }

    private take(length: number): Buffer {
        const head = this.chunks[0]
        if (head && head.length >= length) {
            const bytes = head.subarray(0, length)
            this.drop(length)
            return bytes
        }
        const bytes = Buffer.allocUnsafe(length)
        for (let offset = 0; offset < length;) {
            const chunk = this.chunks[0]
            const count = Math.min(chunk.length, length - offset)
            chunk.copy(bytes, offset, 0, count)
            this.drop(count)
            offset += count
        }
        return bytes
    }

    private drop(length: number): void {
        const head = this.chunks[0]
        if (length === head.length) this.chunks.shift()
        else this.chunks[0] = head.subarray(length)
        this.buffered -= length
    }
}

/** Bytes per pixel of a 16-byte PIXEL_FORMAT, or a protocol error. The flags are booleans where any non-zero is true (x11vnc sends 0xff). */
function bytesPerPixel(format: Buffer): number {
    const [bits, depth] = format
    if (![8, 16, 32].includes(bits) || depth === 0 || depth > bits) throw new RfbProtocolError('unsupported pixel format')
    return bits / 8
}

/** VNC authentication: DES-ECB of the challenge keyed by the bit-reversed password (single DES as 3DES with K1=K2=K3). */
export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
    const key = Buffer.alloc(8)
    Buffer.from(password, 'latin1').copy(key, 0, 0, 8)
    for (let i = 0; i < 8; i++) {
        let reversed = 0
        for (let bit = 0; bit < 8; bit++) if (key[i] & (1 << bit)) reversed |= 0x80 >> bit
        key[i] = reversed
    }
    const cipher = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null)
    cipher.setAutoPadding(false)
    return Buffer.concat([cipher.update(challenge), cipher.final()])
}

export interface ServerInit { width: number; height: number; pixelFormat: Buffer }

export function serverInitMessage(init: ServerInit, name: string): Buffer {
    const nameBytes = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(24)
    header.writeUInt16BE(init.width, 0)
    header.writeUInt16BE(init.height, 2)
    init.pixelFormat.copy(header, 4)
    header.writeUInt32BE(nameBytes.length, 20)
    return Buffer.concat([header, nameBytes])
}

export function keyEvent(down: boolean, keysym: number): Buffer {
    const message = Buffer.alloc(8)
    message[0] = 4
    message[1] = down ? 1 : 0
    message.writeUInt32BE(keysym >>> 0, 4)
    return message
}

export function pointerEvent(buttonMask: number, x: number, y: number): Buffer {
    const message = Buffer.alloc(6)
    message[0] = 5
    message[1] = buttonMask
    message.writeUInt16BE(x, 2)
    message.writeUInt16BE(y, 4)
    return message
}

export function setEncodingsMessage(encodings: readonly number[]): Buffer {
    const message = Buffer.alloc(4 + encodings.length * 4)
    message[0] = 2
    message.writeUInt16BE(encodings.length, 2)
    encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4))
    return message
}

// ---------------------------------------------------------------------------
// Upstream: the proxy is an RFB client of x11vnc.
// ---------------------------------------------------------------------------

export interface UpstreamHooks {
    password: string
    send(bytes: Buffer): void
    onServerInit(init: ServerInit): void
}

export function* upstreamParser(session: RfbSession, hooks: UpstreamHooks): RfbParser {
    if ((yield* read(12)).toString('latin1') !== RFB_VERSION) throw new RfbProtocolError('upstream is not an RFB 3.8 server')
    hooks.send(Buffer.from(RFB_VERSION, 'latin1'))
    const [count] = yield* read(1)
    if (count === 0) throw new RfbProtocolError('upstream refused the connection')
    if (!(yield* read(count)).includes(SECURITY_VNC_AUTH)) throw new RfbProtocolError('upstream does not offer VNC authentication')
    hooks.send(Buffer.from([SECURITY_VNC_AUTH]))
    hooks.send(vncAuthResponse(hooks.password, yield* read(16)))
    if ((yield* read(4)).readUInt32BE(0) !== 0) throw new RfbProtocolError('upstream refused VNC authentication')
    // ClientInit: always shared, so the proxy never disconnects another viewer.
    hooks.send(Buffer.from([1]))
    const init = yield* read(24)
    const width = init.readUInt16BE(0)
    const height = init.readUInt16BE(2)
    const pixelFormat = Buffer.from(init.subarray(4, 20))
    const nameLength = init.readUInt32BE(20)
    if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || nameLength > MAX_DESKTOP_NAME_BYTES) throw new RfbProtocolError('invalid ServerInit')
    session.bytesPerPixel = bytesPerPixel(pixelFormat)
    yield* read(nameLength)
    session.width = width
    session.height = height
    hooks.onServerInit({ width, height, pixelFormat })
    yield* serverMessages(session)
}

/** Server→viewer messages after the handshake; `session` is updated by the viewer direction. */
export function* serverMessages(session: RfbSession): RfbParser {
    for (;;) {
        const [type] = yield* read(1, true)
        switch (type) {
            case 0:
                yield* framebufferUpdate(session)
                break
            case 1: { // SetColourMapEntries
                const header = yield* read(5, true)
                const count = header.readUInt16BE(3)
                if (header.readUInt16BE(1) + count > 65_536) throw new RfbProtocolError('colour map out of range')
                yield { skip: count * 6 }
                break
            }
            case 2: // Bell
                break
            case 3: { // ServerCutText
                const length = (yield* read(7, true)).readUInt32BE(3)
                if (length > MAX_SERVER_CUT_TEXT_BYTES) throw new RfbProtocolError('server cut text too long')
                yield { skip: length }
                break
            }
            default:
                throw new RfbProtocolError(`unknown server message type ${type}`)
        }
    }
}

function* framebufferUpdate(session: RfbSession): RfbParser {
    const rectangles = (yield* read(3, true)).readUInt16BE(1)
    for (let index = 0; index < rectangles; index++) {
        const header = yield* read(12, true)
        const x = header.readUInt16BE(0)
        const y = header.readUInt16BE(2)
        const w = header.readUInt16BE(4)
        const h = header.readUInt16BE(6)
        const encoding = header.readInt32BE(8)
        // Raw is always permitted (RFC 6143 7.7); anything else must have been requested.
        if (encoding !== ENCODING.raw && !session.encodings.has(encoding)) throw new RfbProtocolError(`unrequested encoding ${encoding}`)
        const pixel = session.bytesPerPixel
        const inside = () => { if (x + w > session.width || y + h > session.height) throw new RfbProtocolError('rectangle outside the framebuffer') }
        switch (encoding) {
            case ENCODING.raw:
                inside()
                yield { skip: w * h * pixel }
                break
            case ENCODING.copyRect: {
                inside()
                const source = yield* read(4, true)
                if (source.readUInt16BE(0) + w > session.width || source.readUInt16BE(2) + h > session.height) throw new RfbProtocolError('copy source outside the framebuffer')
                break
            }
            case ENCODING.hextile:
                inside()
                yield* hextile(w, h, pixel)
                break
            case ENCODING.desktopSize:
                if (w === 0 || h === 0 || w > MAX_DIMENSION || h > MAX_DIMENSION) throw new RfbProtocolError('invalid desktop size')
                session.width = w
                session.height = h
                break
            case ENCODING.cursor:
                if (w > MAX_CURSOR_DIMENSION || h > MAX_CURSOR_DIMENSION) throw new RfbProtocolError('cursor too large')
                yield { skip: w * h * pixel + Math.ceil(w / 8) * h }
                break
            default:
                throw new RfbProtocolError(`unsupported encoding ${encoding}`)
        }
    }
}

function* hextile(width: number, height: number, pixel: number): RfbParser {
    for (let tileY = 0; tileY < height; tileY += 16) {
        for (let tileX = 0; tileX < width; tileX += 16) {
            const tileWidth = Math.min(16, width - tileX)
            const tileHeight = Math.min(16, height - tileY)
            const [subencoding] = yield* read(1, true)
            if (subencoding > 31) throw new RfbProtocolError('invalid hextile subencoding')
            if (subencoding & 1) {
                yield { skip: tileWidth * tileHeight * pixel }
                continue
            }
            const colours = ((subencoding & 2) ? pixel : 0) + ((subencoding & 4) ? pixel : 0)
            if (colours) yield { skip: colours }
            if (subencoding & 8) {
                const [count] = yield* read(1, true)
                yield { skip: count * (((subencoding & 16) ? pixel : 0) + 2) }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Viewer: the proxy is an RFB 3.8 server (security type None; the ticket authenticated the connection).
// ---------------------------------------------------------------------------

export type ClientMessage =
    | { kind: 'setPixelFormat'; bytes: Buffer; bytesPerPixel: number }
    | { kind: 'setEncodings'; encodings: number[] }
    | { kind: 'framebufferUpdateRequest'; bytes: Buffer }
    | { kind: 'key'; down: boolean; keysym: number; bytes: Buffer }
    | { kind: 'pointer'; buttonMask: number; x: number; y: number; bytes: Buffer }
    | { kind: 'cutText'; bytes: Buffer }

export interface ClientHooks {
    send(bytes: Buffer): void
    /** ServerInit for the viewer, available because the upstream handshake finished first. */
    serverInit: Buffer
    /** Called right after ServerInit was sent: server messages may follow from here on. */
    onReady(): void
    /** At each message's type byte, before its remaining bytes are read (input is authorized from here). */
    onMessageStart?(type: number): void
    onMessage(message: ClientMessage): void
}

export function* clientParser(hooks: ClientHooks): RfbParser {
    hooks.send(Buffer.from(RFB_VERSION, 'latin1'))
    if ((yield* read(12)).toString('latin1') !== RFB_VERSION) throw new RfbProtocolError('viewer must speak RFB 3.8')
    hooks.send(Buffer.from([1, SECURITY_NONE]))
    if ((yield* read(1))[0] !== SECURITY_NONE) throw new RfbProtocolError('viewer chose an unoffered security type')
    hooks.send(Buffer.alloc(4))
    // ClientInit's shared flag is ignored: the upstream session is always shared.
    yield* read(1)
    hooks.send(hooks.serverInit)
    hooks.onReady()
    for (;;) {
        const type = (yield* read(1))[0]
        hooks.onMessageStart?.(type)
        switch (type) {
            case 0: {
                const rest = yield* read(19)
                hooks.onMessage({ kind: 'setPixelFormat', bytes: Buffer.concat([Buffer.from([type]), rest]), bytesPerPixel: bytesPerPixel(rest.subarray(3)) })
                break
            }
            case 2: {
                const count = (yield* read(3)).readUInt16BE(1)
                if (count > VIEWER_LIMITS.maxSetEncodings) throw new RfbProtocolError('too many encodings')
                const list = yield* read(count * 4)
                hooks.onMessage({ kind: 'setEncodings', encodings: Array.from({ length: count }, (_, index) => list.readInt32BE(index * 4)) })
                break
            }
            case 3: {
                const rest = yield* read(9)
                if (rest[0] > 1) throw new RfbProtocolError('invalid FramebufferUpdateRequest')
                hooks.onMessage({ kind: 'framebufferUpdateRequest', bytes: Buffer.concat([Buffer.from([type]), rest]) })
                break
            }
            case 4: {
                const rest = yield* read(7)
                if (rest[0] > 1) throw new RfbProtocolError('invalid KeyEvent')
                hooks.onMessage({ kind: 'key', down: rest[0] === 1, keysym: rest.readUInt32BE(3), bytes: Buffer.concat([Buffer.from([type]), rest]) })
                break
            }
            case 5: {
                const rest = yield* read(5)
                hooks.onMessage({ kind: 'pointer', buttonMask: rest[0], x: rest.readUInt16BE(1), y: rest.readUInt16BE(3), bytes: Buffer.concat([Buffer.from([type]), rest]) })
                break
            }
            case 6: {
                const header = yield* read(7)
                const length = header.readUInt32BE(3)
                if (length > VIEWER_LIMITS.maxClientCutTextBytes) throw new RfbProtocolError('client cut text too long')
                hooks.onMessage({ kind: 'cutText', bytes: Buffer.concat([Buffer.from([type]), header, yield* read(length)]) })
                break
            }
            default:
                throw new RfbProtocolError(`unknown viewer message type ${type}`)
        }
    }
}
