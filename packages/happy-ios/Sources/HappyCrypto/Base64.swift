import Foundation

/// Base64 the way the rest of Happy writes it: standard alphabet with
/// padding on the wire, unpadded base64url for secrets and QR payloads
/// (see packages/happy-app/sources/encryption/base64.ts).
public enum Base64 {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
    }

    /// Accepts padded or unpadded input, as every server/CLI encoder in the
    /// monorepo is lenient about padding.
    public static func decode(_ string: String) -> Data? {
        Data(base64Encoded: padded(string.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    public static func encodeURL(_ data: Data) -> String {
        var out = data.base64EncodedString()
        out = out.replacingOccurrences(of: "+", with: "-")
        out = out.replacingOccurrences(of: "/", with: "_")
        while out.hasSuffix("=") {
            out.removeLast()
        }
        return out
    }

    public static func decodeURL(_ string: String) -> Data? {
        let normalized = string
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: padded(normalized))
    }

    private static func padded(_ string: String) -> String {
        let remainder = string.utf8.count % 4
        guard remainder != 0 else { return string }
        return string + String(repeating: "=", count: 4 - remainder)
    }
}
