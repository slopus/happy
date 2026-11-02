import Foundation

/// The QR code Happy Desktop shows for a phone to add its team server
/// (edge SSO contract v5 §8):
/// `happy://<instanceId>/server?url=<percent-encoded base URL>`. It carries
/// no secret: the phone signs in itself, then checks that the server's
/// health `instanceId` is the one the code named. It is not a Happy link
/// (`HappyLink` refuses it), and only the app's own scanner acts on it.
public struct ServerLink: Equatable, Sendable {
    public let instanceId: String
    /// The decoded base URL, normalized and ending in `/`.
    public let base: String
    public let origin: AgentOrigin
    /// The base URL's path: `/`, or a prefix such as `/happy/`.
    public let path: String

    public static let maxLength = 4096
    private static let prefix = "happy://"
    private static let marker = "/server?url="

    /// The link `text` is exactly, or nil. Anything the grammar doesn't
    /// allow makes it malformed; nothing is repaired.
    public init?(_ text: String) {
        guard text.utf16.count <= Self.maxLength, text.hasPrefix(Self.prefix) else { return nil }
        let rest = text.dropFirst(Self.prefix.count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let instanceId = String(rest[..<slash])
        let tail = rest[slash...]
        guard HappyLink.isInstanceID(instanceId), tail.hasPrefix(Self.marker) else { return nil }
        // One `url` parameter and nothing after it: no `&`, no fragment.
        let encoded = tail.dropFirst(Self.marker.count)
        guard encoded.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 && $0 != "&" && $0 != "#" }),
              let base = Self.percentDecoded(encoded), let (origin, path) = Self.normalizedBase(base) else { return nil }
        self.instanceId = instanceId; self.base = base; self.origin = origin; self.path = path
    }

    /// Whether `text` is meant as a server code at all, well-formed or not.
    public static func isServerLink(_ text: String) -> Bool {
        guard text.hasPrefix(prefix) else { return false }
        let rest = text.dropFirst(prefix.count)
        guard let slash = rest.firstIndex(of: "/"), HappyLink.isInstanceID(String(rest[..<slash])) else { return false }
        let tail = rest[slash...]
        guard tail.hasPrefix("/server") else { return false }
        return tail.dropFirst("/server".count).first.map { "?/#".contains($0) } ?? true
    }

    /// The code's text, as Happy Desktop writes it (`encodeURIComponent`).
    public var url: String {
        "happy://\(instanceId)/server?url=" + (base.addingPercentEncoding(withAllowedCharacters: Self.componentSafe) ?? base)
    }

    private static let componentSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    /// `%XX` with either case of hex, then UTF-8; nil for a broken escape
    /// or bytes that aren't UTF-8.
    private static func percentDecoded(_ text: Substring) -> String? {
        var bytes: [UInt8] = []
        var index = text.utf8.startIndex
        let utf8 = text.utf8
        while index < utf8.endIndex {
            let byte = utf8[index]
            if byte == UInt8(ascii: "%") {
                let high = utf8.index(after: index)
                guard high < utf8.endIndex else { return nil }
                let low = utf8.index(after: high)
                guard low < utf8.endIndex, let h = hex(utf8[high]), let l = hex(utf8[low]) else { return nil }
                bytes.append(h << 4 | l)
                index = utf8.index(after: low)
            } else {
                bytes.append(byte)
                index = utf8.index(after: index)
            }
        }
        // Decoding repairs bad bytes; a repaired one doesn't round-trip.
        let text = String(decoding: bytes, as: UTF8.self)
        return Array(text.utf8) == bytes ? text : nil
    }

    private static func hex(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: byte - 48
        case 65...70: byte - 55
        case 97...102: byte - 87
        default: nil
        }
    }

    /// The origin and path of a base URL already in the form the URL
    /// standard writes it (`new URL(u).href === u`): https, no userinfo,
    /// query or fragment, a lowercase host, no default port, and a path
    /// ending in `/` with nothing the standard would rewrite.
    private static func normalizedBase(_ text: String) -> (AgentOrigin, String)? {
        let scheme = "https://"
        guard text.hasPrefix(scheme) else { return nil }
        let rest = text.dropFirst(scheme.count)
        guard let slash = rest.firstIndex(of: "/") else { return nil }
        let path = String(rest[slash...])
        guard let origin = try? AgentOrigin(scheme + rest[..<slash]), path.hasSuffix("/"),
              path.unicodeScalars.allSatisfy({ pathSafe.contains($0) }) else { return nil }
        // Dot segments, written or escaped, would be resolved away.
        for segment in path.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            if [".", "..", "%2e", ".%2e", "%2e.", "%2e%2e"].contains(segment.lowercased()) { return nil }
        }
        return (origin, path)
    }

    /// The printable ASCII the URL standard leaves alone in a path: not
    /// space, `"`, `#`, `<`, `>`, `?`, `` ` ``, `{`, `}`, nor `\`, which
    /// becomes `/`.
    private static let pathSafe = CharacterSet(charactersIn: Unicode.Scalar(33)...Unicode.Scalar(126)).subtracting(CharacterSet(charactersIn: "\"#<>?`{}\\"))
}
