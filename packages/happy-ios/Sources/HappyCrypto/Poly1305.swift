import Foundation

/// One-shot Poly1305 (RFC 8439 §2.5) with 26-bit limbs, following
/// poly1305-donna-32. Used only inside `SecretBox`.
enum Poly1305 {
    static func authenticate(message: [UInt8], key: [UInt8]) -> [UInt8] {
        precondition(key.count == 32)

        @inline(__always)
        func load32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
            UInt32(bytes[offset])
                | UInt32(bytes[offset + 1]) << 8
                | UInt32(bytes[offset + 2]) << 16
                | UInt32(bytes[offset + 3]) << 24
        }

        // r is clamped as part of the masks.
        let r0 = load32(key, 0) & 0x3ff_ffff
        let r1 = (load32(key, 3) >> 2) & 0x3ff_ff03
        let r2 = (load32(key, 6) >> 4) & 0x3ff_c0ff
        let r3 = (load32(key, 9) >> 6) & 0x3f0_3fff
        let r4 = (load32(key, 12) >> 8) & 0x00f_ffff
        let s1 = r1 &* 5, s2 = r2 &* 5, s3 = r3 &* 5, s4 = r4 &* 5

        var h0: UInt32 = 0, h1: UInt32 = 0, h2: UInt32 = 0, h3: UInt32 = 0, h4: UInt32 = 0

        func absorb(_ block: [UInt8], hibit: UInt32) {
            h0 &+= load32(block, 0) & 0x3ff_ffff
            h1 &+= (load32(block, 3) >> 2) & 0x3ff_ffff
            h2 &+= (load32(block, 6) >> 4) & 0x3ff_ffff
            h3 &+= (load32(block, 9) >> 6) & 0x3ff_ffff
            h4 &+= (load32(block, 12) >> 8) | hibit

            let d0 = UInt64(h0) * UInt64(r0) + UInt64(h1) * UInt64(s4) + UInt64(h2) * UInt64(s3) + UInt64(h3) * UInt64(s2) + UInt64(h4) * UInt64(s1)
            var d1 = UInt64(h0) * UInt64(r1) + UInt64(h1) * UInt64(r0) + UInt64(h2) * UInt64(s4) + UInt64(h3) * UInt64(s3) + UInt64(h4) * UInt64(s2)
            var d2 = UInt64(h0) * UInt64(r2) + UInt64(h1) * UInt64(r1) + UInt64(h2) * UInt64(r0) + UInt64(h3) * UInt64(s4) + UInt64(h4) * UInt64(s3)
            var d3 = UInt64(h0) * UInt64(r3) + UInt64(h1) * UInt64(r2) + UInt64(h2) * UInt64(r1) + UInt64(h3) * UInt64(r0) + UInt64(h4) * UInt64(s4)
            var d4 = UInt64(h0) * UInt64(r4) + UInt64(h1) * UInt64(r3) + UInt64(h2) * UInt64(r2) + UInt64(h3) * UInt64(r1) + UInt64(h4) * UInt64(r0)

            var carry = d0 >> 26
            h0 = UInt32(truncatingIfNeeded: d0) & 0x3ff_ffff
            d1 += carry; carry = d1 >> 26; h1 = UInt32(truncatingIfNeeded: d1) & 0x3ff_ffff
            d2 += carry; carry = d2 >> 26; h2 = UInt32(truncatingIfNeeded: d2) & 0x3ff_ffff
            d3 += carry; carry = d3 >> 26; h3 = UInt32(truncatingIfNeeded: d3) & 0x3ff_ffff
            d4 += carry; carry = d4 >> 26; h4 = UInt32(truncatingIfNeeded: d4) & 0x3ff_ffff
            h0 &+= UInt32(truncatingIfNeeded: carry) &* 5
            let c = h0 >> 26
            h0 &= 0x3ff_ffff
            h1 &+= c
        }

        var offset = 0
        while offset + 16 <= message.count {
            absorb(Array(message[offset..<(offset + 16)]), hibit: 1 << 24)
            offset += 16
        }
        if offset < message.count {
            // Final partial block: append 0x01, zero-pad, no high bit.
            var block = [UInt8](repeating: 0, count: 16)
            let tail = message.count - offset
            for index in 0..<tail {
                block[index] = message[offset + index]
            }
            block[tail] = 1
            absorb(block, hibit: 0)
        }

        // Fully carry h.
        var c = h1 >> 26; h1 &= 0x3ff_ffff
        h2 &+= c; c = h2 >> 26; h2 &= 0x3ff_ffff
        h3 &+= c; c = h3 >> 26; h3 &= 0x3ff_ffff
        h4 &+= c; c = h4 >> 26; h4 &= 0x3ff_ffff
        h0 &+= c &* 5; c = h0 >> 26; h0 &= 0x3ff_ffff
        h1 &+= c

        // g = h + -p
        var g0 = h0 &+ 5; c = g0 >> 26; g0 &= 0x3ff_ffff
        var g1 = h1 &+ c; c = g1 >> 26; g1 &= 0x3ff_ffff
        var g2 = h2 &+ c; c = g2 >> 26; g2 &= 0x3ff_ffff
        var g3 = h3 &+ c; c = g3 >> 26; g3 &= 0x3ff_ffff
        var g4 = h4 &+ c &- (1 << 26)

        // Select h if h < p, else g, without branching.
        var mask = (g4 >> 31) &- 1
        g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask
        mask = ~mask
        h0 = (h0 & mask) | g0
        h1 = (h1 & mask) | g1
        h2 = (h2 & mask) | g2
        h3 = (h3 & mask) | g3
        h4 = (h4 & mask) | g4

        // h %= 2^128
        let w0 = h0 | (h1 << 26)
        let w1 = (h1 >> 6) | (h2 << 20)
        let w2 = (h2 >> 12) | (h3 << 14)
        let w3 = (h3 >> 18) | (h4 << 8)

        // mac = (h + s) % 2^128
        var f = UInt64(w0) + UInt64(load32(key, 16))
        let t0 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w1) + UInt64(load32(key, 20)) + (f >> 32)
        let t1 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w2) + UInt64(load32(key, 24)) + (f >> 32)
        let t2 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w3) + UInt64(load32(key, 28)) + (f >> 32)
        let t3 = UInt32(truncatingIfNeeded: f)

        var tag = [UInt8]()
        tag.reserveCapacity(16)
        for word in [t0, t1, t2, t3] {
            tag.append(UInt8(truncatingIfNeeded: word))
            tag.append(UInt8(truncatingIfNeeded: word >> 8))
            tag.append(UInt8(truncatingIfNeeded: word >> 16))
            tag.append(UInt8(truncatingIfNeeded: word >> 24))
        }
        return tag
    }
}
