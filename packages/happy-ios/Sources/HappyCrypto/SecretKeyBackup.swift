import Foundation

/// The human-readable form of the 32-byte account secret:
/// RFC 4648 base32 in dash-separated groups of five
/// (packages/happy-app/sources/auth/secretKeyBackup.ts).
public enum SecretKeyBackup {
    public enum ParseError: Error, Equatable, Sendable {
        case noValidCharacters
        case invalidLength(Int)
        case invalidFormat
    }

    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".utf8)

    public static func format(secret: Data) -> String {
        let encoded = base32(secret)
        var groups: [String] = []
        var index = encoded.startIndex
        while index < encoded.endIndex {
            let end = encoded.index(index, offsetBy: 5, limitedBy: encoded.endIndex) ?? encoded.endIndex
            groups.append(String(encoded[index..<end]))
            index = end
        }
        return groups.joined(separator: "-")
    }

    /// Parses a typed or pasted backup key. Like happy-app it forgives case,
    /// separators and the usual look-alikes (0→O, 1→I, 8→B, 9→G).
    public static func parse(_ formatted: String) throws -> Data {
        var cleaned: [UInt8] = []
        for scalar in formatted.uppercased().unicodeScalars {
            let mapped: Unicode.Scalar
            switch scalar {
            case "0": mapped = "O"
            case "1": mapped = "I"
            case "8": mapped = "B"
            case "9": mapped = "G"
            default: mapped = scalar
            }
            if (mapped >= "A" && mapped <= "Z") || (mapped >= "2" && mapped <= "7") {
                cleaned.append(UInt8(mapped.value))
            }
        }
        guard !cleaned.isEmpty else { throw ParseError.noValidCharacters }

        var bytes = Data()
        var buffer: UInt32 = 0
        var bits = 0
        for char in cleaned {
            guard let value = alphabet.firstIndex(of: char) else { throw ParseError.invalidFormat }
            buffer = (buffer << 5) | UInt32(value)
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8(truncatingIfNeeded: buffer >> UInt32(bits)))
            }
        }
        guard bytes.count == 32 else { throw ParseError.invalidLength(bytes.count) }
        return bytes
    }

    /// Accepts either the backup format or the raw base64url secret, the
    /// two forms people paste into "Restore with secret key".
    ///
    /// A raw secret is exactly 43 base64url characters; the backup form is at
    /// least 52 base32 characters. happy-app tells them apart by looking for
    /// "-", which rejects the raw secrets whose base64url contains a "-".
    public static func normalize(_ input: String) throws -> Data {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count == 43, let raw = Base64.decodeURL(trimmed), raw.count == 32 {
            return raw
        }
        return try parse(trimmed)
    }

    private static func base32(_ data: Data) -> String {
        var out: [UInt8] = []
        var buffer: UInt32 = 0
        var bits = 0
        for byte in data {
            buffer = (buffer << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[Int((buffer >> UInt32(bits)) & 0x1f)])
            }
        }
        if bits > 0 {
            out.append(alphabet[Int((buffer << UInt32(5 - bits)) & 0x1f)])
        }
        return String(decoding: out, as: UTF8.self)
    }
}
