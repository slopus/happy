import Foundation

public enum CryptoError: Error, Equatable, Sendable {
    case invalidKeyLength(expected: Int, actual: Int)
    case invalidNonceLength(expected: Int, actual: Int)
    case invalidInput(String)
    case backend(String)
}

/// Where random bytes come from. Production code uses `SystemRandom`;
/// tests inject a fixed source so sealed output can be compared to vectors.
public protocol RandomSource: Sendable {
    func bytes(_ count: Int) -> Data
}

/// `SystemRandomNumberGenerator` is a CSPRNG on every platform Swift runs
/// on (arc4random on Apple, getrandom on Linux).
public struct SystemRandom: RandomSource {
    public init() {}

    public func bytes(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        var out = Data(count: count)
        out.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) in
            var index = 0
            while index < count {
                var word = generator.next()
                let take = min(8, count - index)
                withUnsafeBytes(of: &word) { wordBytes in
                    for offset in 0..<take {
                        buffer[index + offset] = wordBytes[offset]
                    }
                }
                index += take
            }
        }
        return out
    }
}

/// Hands out a fixed byte sequence, then fails loudly. Tests only.
public final class FixedRandom: RandomSource, @unchecked Sendable {
    private var remaining: Data
    private let lock = NSLock()

    public init(_ data: Data) {
        remaining = data
    }

    public func bytes(_ count: Int) -> Data {
        lock.lock()
        defer { lock.unlock() }
        precondition(remaining.count >= count, "FixedRandom ran out of bytes")
        let out = Data(remaining.prefix(count))
        remaining = Data(remaining.dropFirst(count))
        return out
    }
}

public enum Bytes {
    /// Compares without an early exit, so timing does not leak where two
    /// MACs first differ.
    public static func constantTimeEquals<A: Collection<UInt8>, B: Collection<UInt8>>(_ a: A, _ b: B) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for (x, y) in zip(a, b) {
            difference |= x ^ y
        }
        return difference == 0
    }
}

extension Data {
    /// Lowercase hex, two characters per byte.
    public var hexString: String {
        let digits = Array("0123456789abcdef".utf8)
        var chars = [UInt8]()
        chars.reserveCapacity(count * 2)
        for byte in self {
            chars.append(digits[Int(byte >> 4)])
            chars.append(digits[Int(byte & 0x0f)])
        }
        return String(decoding: chars, as: UTF8.self)
    }

    public init?(hexString: String) {
        let chars = Array(hexString.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = Data(capacity: chars.count / 2)
        var index = 0
        while index < chars.count {
            guard let high = Self.hexValue(chars[index]), let low = Self.hexValue(chars[index + 1]) else {
                return nil
            }
            out.append(high << 4 | low)
            index += 2
        }
        self = out
    }

    private static func hexValue(_ char: UInt8) -> UInt8? {
        switch char {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return char - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return char - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return char - UInt8(ascii: "A") + 10
        default: return nil
        }
    }
}
