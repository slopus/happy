import { describe, expect, it } from 'vitest'
import { ALLOWED_ENCODINGS, ENCODING, RFB_VERSION, RfbProtocolError, StreamFramer, clientParser, keyEvent, pointerEvent, serverMessages, setEncodingsMessage,
    upstreamParser, vncAuthResponse, type ClientMessage, type RfbSession } from './rfb'
import { PIXEL_FORMAT_32, prng, randomSplit, rect, s32, serverStream, u16, u32 } from './testing/rfbFixtures'

function session(overrides: Partial<RfbSession> = {}): RfbSession {
    return { width: 64, height: 48, bytesPerPixel: 4, encodings: new Set([ENCODING.copyRect, ENCODING.hextile, ENCODING.desktopSize, ENCODING.cursor]), ...overrides }
}

const ZRLE = 16

describe('StreamFramer + server message framing', () => {
    it('forwards a valid server stream byte-exact under 200 random fragmentations', () => {
        const stream = serverStream()
        for (let seed = 1; seed <= 200; seed++) {
            const out: Buffer[] = []
            const framer = new StreamFramer(serverMessages(session()), (bytes) => out.push(Buffer.from(bytes)), 1 << 20)
            for (const piece of randomSplit(stream, prng(seed))) framer.push(piece)
            expect(Buffer.concat(out).equals(stream), `seed ${seed}`).toBe(true)
        }
    })

    it('refuses rectangles outside the framebuffer, unrequested encodings and unknown messages without forwarding them', () => {
        const refuse = (bytes: Buffer, s = session()) => {
            const out: Buffer[] = []
            const framer = new StreamFramer(serverMessages(s), (b) => out.push(Buffer.from(b)), 1 << 20)
            expect(() => framer.push(bytes)).toThrowError(RfbProtocolError)
            return Buffer.concat(out)
        }
        const header = Buffer.concat([Buffer.from([0, 0]), u16(1)])
        expect(refuse(Buffer.concat([header, rect(60, 0, 8, 1, ENCODING.raw)]))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 1, 1, 7 /* tight */)]))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 1, 1, ENCODING.hextile)]), session({ encodings: new Set() }))).toEqual(header)
        // ZRLE is never offered (its compressed payload cannot be bounded without inflating it), so it is
        // refused even if it somehow reached the requested set: a 1x1 rectangle could otherwise carry a zlib bomb.
        expect(ALLOWED_ENCODINGS.has(ZRLE)).toBe(false)
        expect(refuse(Buffer.concat([header, rect(0, 0, 1, 1, ZRLE), u32(531)]), session({ encodings: new Set([ZRLE]) }))).toEqual(header)
        expect(refuse(Buffer.concat([header, rect(0, 0, 32, 32, ENCODING.hextile), Buffer.from([64])]))).toHaveLength(16)
        expect(refuse(Buffer.from([3, 0, 0, 0, 0x7f, 0, 0, 0]))).toEqual(Buffer.from([3]))
        expect(refuse(Buffer.from([150]))).toHaveLength(0)
    })
})

describe('parser hook for the viewer proxy', () => {
    it('announces every viewer message at its type byte, before the rest of it arrives', () => {
        const events: string[] = []
        const framer = new StreamFramer(clientParser({ send: () => undefined, serverInit: Buffer.alloc(0), onReady: () => undefined,
            onMessageStart: (type) => events.push(`start:${type}`), onMessage: (m) => events.push(m.kind) }), () => undefined, 1 << 20)
        framer.push(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 0])]))
        const key = keyEvent(true, 0x61)
        framer.push(key.subarray(0, 1))
        expect(events).toEqual(['start:4'])
        framer.push(Buffer.concat([key.subarray(1), pointerEvent(0, 1, 1)]))
        expect(events).toEqual(['start:4', 'key', 'start:5', 'pointer'])
    })
})

describe('client message parsing', () => {
    const handshake = () => Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1]), Buffer.from([0])])
    function run(bytes: Buffer, split?: () => number) {
        const sent: Buffer[] = []
        const messages: ClientMessage[] = []
        const framer = new StreamFramer(clientParser({ send: (b) => sent.push(Buffer.from(b)), serverInit: Buffer.from('INIT'), onReady: () => undefined, onMessage: (m) => messages.push(m) }),
            () => undefined, 128 * 1024)
        for (const piece of split ? randomSplit(bytes, split) : [bytes]) framer.push(piece)
        return { sent: Buffer.concat(sent), messages }
    }

    it('answers the RFB 3.8 handshake with security type None and sends the ServerInit it is given', () => {
        const { sent } = run(handshake())
        expect(sent).toEqual(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1]), u32(0), Buffer.from('INIT')]))
        expect(() => run(Buffer.from('RFB 003.003\n'))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2])]))).toThrowError(RfbProtocolError)
    })

    it('parses every allowed message identically under random fragmentation and coalescing', () => {
        const stream = Buffer.concat([
            handshake(),
            Buffer.from([0, 0, 0, 0]), PIXEL_FORMAT_32,
            Buffer.from([2, 0]), u16(3), s32(7), s32(ENCODING.hextile), s32(ENCODING.raw),
            Buffer.from([3, 1]), u16(0), u16(0), u16(64), u16(48),
            keyEvent(true, 0x61), pointerEvent(1, 10, 20),
            Buffer.from([6, 0, 0, 0]), u32(3), Buffer.from('abc'),
        ])
        const expected = run(stream).messages
        expect(expected.map((m) => m.kind)).toEqual(['setPixelFormat', 'setEncodings', 'framebufferUpdateRequest', 'key', 'pointer', 'cutText'])
        expect(expected[1]).toMatchObject({ encodings: [7, ENCODING.hextile, ENCODING.raw] })
        expect(expected[3]).toMatchObject({ down: true, keysym: 0x61 })
        expect(expected[4]).toMatchObject({ buttonMask: 1, x: 10, y: 20 })
        for (let seed = 1; seed <= 100; seed++) expect(run(stream, prng(seed)).messages, `seed ${seed}`).toEqual(expected)
    })

    it('closes on more than 64 encodings, oversized cut text, a bad pixel format and unknown message types', () => {
        expect(() => run(Buffer.concat([handshake(), Buffer.from([2, 0]), u16(65)]))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([handshake(), Buffer.from([6, 0, 0, 0]), u32(64 * 1024 + 1)]))).toThrowError(RfbProtocolError)
        expect(() => run(Buffer.concat([handshake(), Buffer.from([0, 0, 0, 0]), Buffer.from([24]), Buffer.alloc(15)]))).toThrowError(RfbProtocolError)
        for (const type of [1, 7, 150, 248, 250, 251, 255]) expect(() => run(Buffer.concat([handshake(), Buffer.from([type])])), `type ${type}`).toThrowError(RfbProtocolError)
    })

    it('refuses a peer that runs too far ahead of a bounded read', () => {
        const sent: Buffer[] = []
        const framer = new StreamFramer(clientParser({ send: (b) => sent.push(b), serverInit: Buffer.alloc(0), onReady: () => undefined, onMessage: () => undefined }), () => undefined, 1024)
        framer.push(handshake())
        expect(() => framer.push(Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(2000), Buffer.alloc(1500)]))).toThrowError(RfbProtocolError)
    })
})

describe('upstream (x11vnc) handshake', () => {
    it('authenticates with VNC authentication, asks for a shared session and then frames server messages', () => {
        const sent: Buffer[] = []
        const inits: unknown[] = []
        const s = session({ width: 0, height: 0, bytesPerPixel: 0 })
        const forwarded: Buffer[] = []
        const framer = new StreamFramer(upstreamParser(s, { password: 'synthpw1', send: (b) => sent.push(Buffer.from(b)), onServerInit: (init) => inits.push(init) }),
            (b) => forwarded.push(Buffer.from(b)), 1 << 20)
        const challenge = Buffer.alloc(16, 0x5a)
        const name = Buffer.from('browser-a:99')
        framer.push(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2, 1, 2]), challenge, u32(0),
            u16(1280), u16(900), PIXEL_FORMAT_32, u32(name.length), name, Buffer.from([2])]))
        expect(sent).toEqual([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2]), vncAuthResponse('synthpw1', challenge), Buffer.from([1])])
        expect(inits).toEqual([{ width: 1280, height: 900, pixelFormat: PIXEL_FORMAT_32 }])
        expect([s.width, s.height, s.bytesPerPixel]).toEqual([1280, 900, 4])
        // The handshake never reaches the viewer; the Bell after it does.
        expect(Buffer.concat(forwarded)).toEqual(Buffer.from([2]))
    })

    it('accepts any non-zero big-endian and true-colour flag, as x11vnc sends 0xff (RFC 6143 7.4)', () => {
        const inits: Array<{ width: number }> = []
        const x11vncPixelFormat = Buffer.from('201800ff00ff00ff00ff100800000000', 'hex')
        new StreamFramer(upstreamParser(session(), { password: 'x', send: () => undefined, onServerInit: (init) => inits.push(init) }), () => undefined, 1 << 20)
            .push(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 2]), Buffer.alloc(16), u32(0), u16(1280), u16(900), x11vncPixelFormat, u32(0)]))
        expect(inits).toMatchObject([{ width: 1280 }])
    })

    it('refuses an upstream without VNC authentication or that rejects the password', () => {
        const start = (bytes: Buffer) => new StreamFramer(upstreamParser(session(), { password: 'x', send: () => undefined, onServerInit: () => undefined }), () => undefined, 1 << 20).push(bytes)
        expect(() => start(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1])]))).toThrowError(RfbProtocolError)
        expect(() => start(Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 2]), Buffer.alloc(16), u32(1)]))).toThrowError(RfbProtocolError)
        expect(() => start(Buffer.from('RFB 003.003\n'))).toThrowError(RfbProtocolError)
    })

    it('derives the VNC DES key from the bit-reversed password', () => {
        expect(vncAuthResponse('password', Buffer.alloc(16)).toString('hex')).toBe(REFERENCE_PASSWORD_ZERO_CHALLENGE)
    })

    it('encodes SetEncodings for the upstream', () => {
        expect(setEncodingsMessage([ENCODING.hextile, ENCODING.desktopSize])).toEqual(Buffer.concat([Buffer.from([2, 0]), u16(2), s32(5), s32(-223)]))
    })
})

// Computed independently: single DES (LibreSSL des-ecb) with key 0e86ceceeef64e26 = bit-reversed "password".
const REFERENCE_PASSWORD_ZERO_CHALLENGE = 'ff97502e9422f089ff97502e9422f089'
