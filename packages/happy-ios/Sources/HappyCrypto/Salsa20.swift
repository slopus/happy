import Foundation

/// Salsa20/20, HSalsa20 and XSalsa20 as specified in "Extending the Salsa20
/// nonce" (Bernstein, 2008) and used by NaCl's crypto_secretbox.
///
/// CryptoKit has no XSalsa20, and every other Happy client seals with
/// tweetnacl/libsodium, so this is a direct implementation checked
/// byte-for-byte against tweetnacl in HappyCryptoTests.
enum Salsa20 {
    private static let sigma: (UInt32, UInt32, UInt32, UInt32) = (0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574)

    @inline(__always)
    private static func rotl(_ value: UInt32, _ count: UInt32) -> UInt32 {
        (value << count) | (value >> (32 - count))
    }

    @inline(__always)
    private static func loadLE(_ bytes: UnsafeRawBufferPointer, _ offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | UInt32(bytes[offset + 1]) << 8
            | UInt32(bytes[offset + 2]) << 16
            | UInt32(bytes[offset + 3]) << 24
    }

    /// The 16-word input block: constants, key and the 16 "input" bytes
    /// (nonce + counter for Salsa20, the nonce prefix for HSalsa20).
    private static func state(key: UnsafeRawBufferPointer, input: UnsafeRawBufferPointer) -> [UInt32] {
        [
            sigma.0, loadLE(key, 0), loadLE(key, 4), loadLE(key, 8),
            loadLE(key, 12), sigma.1, loadLE(input, 0), loadLE(input, 4),
            loadLE(input, 8), loadLE(input, 12), sigma.2, loadLE(key, 16),
            loadLE(key, 20), loadLE(key, 24), loadLE(key, 28), sigma.3,
        ]
    }

    /// Runs the 20 rounds. With `feedForward` the input is added back
    /// (Salsa20); without it the raw permutation is returned (HSalsa20).
    private static func permute(_ j: [UInt32], feedForward: Bool) -> [UInt32] {
        var x0 = j[0], x1 = j[1], x2 = j[2], x3 = j[3]
        var x4 = j[4], x5 = j[5], x6 = j[6], x7 = j[7]
        var x8 = j[8], x9 = j[9], x10 = j[10], x11 = j[11]
        var x12 = j[12], x13 = j[13], x14 = j[14], x15 = j[15]

        for _ in 0..<10 {
            // Column round.
            x4 ^= rotl(x0 &+ x12, 7); x8 ^= rotl(x4 &+ x0, 9); x12 ^= rotl(x8 &+ x4, 13); x0 ^= rotl(x12 &+ x8, 18)
            x9 ^= rotl(x5 &+ x1, 7); x13 ^= rotl(x9 &+ x5, 9); x1 ^= rotl(x13 &+ x9, 13); x5 ^= rotl(x1 &+ x13, 18)
            x14 ^= rotl(x10 &+ x6, 7); x2 ^= rotl(x14 &+ x10, 9); x6 ^= rotl(x2 &+ x14, 13); x10 ^= rotl(x6 &+ x2, 18)
            x3 ^= rotl(x15 &+ x11, 7); x7 ^= rotl(x3 &+ x15, 9); x11 ^= rotl(x7 &+ x3, 13); x15 ^= rotl(x11 &+ x7, 18)
            // Row round.
            x1 ^= rotl(x0 &+ x3, 7); x2 ^= rotl(x1 &+ x0, 9); x3 ^= rotl(x2 &+ x1, 13); x0 ^= rotl(x3 &+ x2, 18)
            x6 ^= rotl(x5 &+ x4, 7); x7 ^= rotl(x6 &+ x5, 9); x4 ^= rotl(x7 &+ x6, 13); x5 ^= rotl(x4 &+ x7, 18)
            x11 ^= rotl(x10 &+ x9, 7); x8 ^= rotl(x11 &+ x10, 9); x9 ^= rotl(x8 &+ x11, 13); x10 ^= rotl(x9 &+ x8, 18)
            x12 ^= rotl(x15 &+ x14, 7); x13 ^= rotl(x12 &+ x15, 9); x14 ^= rotl(x13 &+ x12, 13); x15 ^= rotl(x14 &+ x13, 18)
        }

        var out = [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15]
        if feedForward {
            for index in 0..<16 {
                out[index] = out[index] &+ j[index]
            }
        }
        return out
    }

    /// HSalsa20(key, input16) -> 32-byte subkey.
    static func hsalsa20(key: Data, input: Data) -> Data {
        precondition(key.count == 32 && input.count == 16)
        let words = key.withUnsafeBytes { keyBytes in
            input.withUnsafeBytes { inputBytes in
                permute(state(key: keyBytes, input: inputBytes), feedForward: false)
            }
        }
        var out = Data(capacity: 32)
        for index in [0, 5, 10, 15, 6, 7, 8, 9] {
            appendLE(words[index], to: &out)
        }
        return out
    }

    /// XORs `data` with the XSalsa20 keystream for (`key`, `nonce`),
    /// starting `skip` bytes into the keystream. secretbox skips 32 bytes:
    /// the first half of block 0 is the Poly1305 key.
    static func xsalsa20XOR(_ data: inout [UInt8], key: Data, nonce: Data, skip: Int) {
        precondition(key.count == 32 && nonce.count == 24)
        let subkey = hsalsa20(key: key, input: nonce.prefix(16))
        let streamNonce = Data(nonce.suffix(8))
        var keystream = [UInt8](repeating: 0, count: 64)
        var block: UInt64 = UInt64(skip / 64)
        var keystreamOffset = skip % 64
        var index = 0
        while index < data.count {
            salsa20Block(key: subkey, nonce: streamNonce, counter: block, into: &keystream)
            while keystreamOffset < 64 && index < data.count {
                data[index] ^= keystream[keystreamOffset]
                keystreamOffset += 1
                index += 1
            }
            keystreamOffset = 0
            block += 1
        }
    }

    /// The first 32 bytes of the XSalsa20 keystream.
    static func xsalsa20FirstBytes(key: Data, nonce: Data, count: Int) -> [UInt8] {
        var zeros = [UInt8](repeating: 0, count: count)
        xsalsa20XOR(&zeros, key: key, nonce: nonce, skip: 0)
        return zeros
    }

    private static func salsa20Block(key: Data, nonce: Data, counter: UInt64, into out: inout [UInt8]) {
        var input = Data(nonce)
        withUnsafeBytes(of: counter.littleEndian) { input.append(contentsOf: $0) }
        let words = key.withUnsafeBytes { keyBytes in
            input.withUnsafeBytes { inputBytes in
                permute(state(key: keyBytes, input: inputBytes), feedForward: true)
            }
        }
        for (index, word) in words.enumerated() {
            out[index * 4] = UInt8(truncatingIfNeeded: word)
            out[index * 4 + 1] = UInt8(truncatingIfNeeded: word >> 8)
            out[index * 4 + 2] = UInt8(truncatingIfNeeded: word >> 16)
            out[index * 4 + 3] = UInt8(truncatingIfNeeded: word >> 24)
        }
    }

    private static func appendLE(_ word: UInt32, to data: inout Data) {
        data.append(UInt8(truncatingIfNeeded: word))
        data.append(UInt8(truncatingIfNeeded: word >> 8))
        data.append(UInt8(truncatingIfNeeded: word >> 16))
        data.append(UInt8(truncatingIfNeeded: word >> 24))
    }
}
