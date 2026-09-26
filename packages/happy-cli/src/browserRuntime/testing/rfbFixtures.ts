/**
 * RFB byte-stream fixtures shared by the codec and viewer proxy tests:
 * a seeded splitter for fragmentation fuzzing and a server stream that uses
 * every message kind the proxy frames.
 */
import { ENCODING } from '../rfb'

/** Deterministic PRNG so a failing split is reproducible from its seed. */
export function prng(seed: number): () => number {
    let state = seed >>> 0
    return () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}
/** Splits bytes at random points, including empty and single-byte pieces. */
export function randomSplit(bytes: Buffer, random: () => number): Buffer[] {
    const pieces: Buffer[] = []
    for (let offset = 0; offset < bytes.length;) {
        const size = random() < 0.1 ? 0 : 1 + Math.floor(random() * Math.min(97, bytes.length - offset))
        pieces.push(bytes.subarray(offset, offset + size))
        offset += size
    }
    return pieces
}
export const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b }
export const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
export const s32 = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b }
export const rect = (x: number, y: number, w: number, h: number, encoding: number) => Buffer.concat([u16(x), u16(y), u16(w), u16(h), s32(encoding)])
export const PIXEL_FORMAT_32 = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0])

/** A server stream using every framed message kind. */
export function serverStream(): Buffer {
    const hextileTiles = Buffer.concat([
        Buffer.from([1]), Buffer.alloc(16 * 16 * 4, 7), // raw tile
        Buffer.from([2 | 8]), Buffer.alloc(4, 1), Buffer.from([2]), Buffer.alloc(2 * 2, 3), // background + 2 plain subrects
        Buffer.from([4 | 8 | 16]), Buffer.alloc(4, 2), Buffer.from([1]), Buffer.alloc(4 + 2, 5), // foreground + 1 coloured subrect
        Buffer.from([0]), // same background
    ])
    return Buffer.concat([
        Buffer.from([0, 0]), u16(5),
        rect(0, 0, 4, 2, ENCODING.raw), Buffer.alloc(4 * 2 * 4, 9),
        rect(8, 8, 10, 10, ENCODING.copyRect), u16(0), u16(0),
        rect(0, 0, 32, 32, ENCODING.hextile), hextileTiles,
        rect(1, 1, 3, 2, ENCODING.cursor), Buffer.alloc(3 * 2 * 4 + 1 * 2, 4),
        rect(0, 0, 80, 60, ENCODING.desktopSize),
        Buffer.from([2]), // Bell
        Buffer.from([3, 0, 0, 0]), u32(5), Buffer.from('clip!'),
        Buffer.from([1, 0]), u16(0), u16(2), Buffer.alloc(12, 1), // SetColourMapEntries
        Buffer.from([0, 0]), u16(1), rect(70, 50, 10, 10, ENCODING.raw), Buffer.alloc(10 * 10 * 4), // inside the resized desktop
    ])
}
