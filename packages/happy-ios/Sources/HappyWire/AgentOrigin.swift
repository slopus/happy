import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// The exact HTTPS origin carried by a v2 code and bound into its proof.
public struct AgentOrigin: Equatable, Sendable {
    public let value: String
    public let host: String
    public let port: UInt16
    public var authority: String { String(value.dropFirst("https://".count)) }

    public init(_ value: String) throws {
        guard value.utf8.count <= 8192, value.utf8.allSatisfy({ $0 > 32 && $0 < 127 }),
              let parts = URLComponents(string: value), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, host == host.lowercased(),
              parts.user == nil, parts.password == nil, parts.path.isEmpty,
              parts.query == nil, parts.fragment == nil,
              let port = UInt16(exactly: parts.port ?? 443), port > 0,
              parts.port != 443, !host.contains("%"), !host.contains("\\"),
              Self.canonicalHost(host),
              value == "https://" + host + (parts.port.map { ":\($0)" } ?? "")
        else { throw PairingError.invalidCode }
        self.value = value
        self.host = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
        self.port = port
    }

    private static func canonicalHost(_ host: String) -> Bool {
        if host.hasPrefix("[") {
            guard host.hasSuffix("]") else { return false }
            let text = String(host.dropFirst().dropLast())
            var address = in6_addr()
            guard inet_pton(AF_INET6, text, &address) == 1 else { return false }
            let bytes = withUnsafeBytes(of: address) { Array($0) }
            let words = stride(from: 0, to: 16, by: 2).map { UInt16(bytes[$0]) << 8 | UInt16(bytes[$0 + 1]) }
            var best = 0..<0; var index = 0
            while index < 8 {
                if words[index] != 0 { index += 1; continue }
                let start = index
                while index < 8 && words[index] == 0 { index += 1 }
                if index - start > best.count { best = start..<index }
            }
            let hex = words.map { String($0, radix: 16) }
            let canonical = best.count >= 2
                ? hex[..<best.lowerBound].joined(separator: ":") + "::" + hex[best.upperBound...].joined(separator: ":")
                : hex.joined(separator: ":")
            return text == canonical
        }
        guard host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 || $0 == 95 }) else { return false }
        // URL-standard IPv4 spellings such as 127.1, octal and hex are not
        // canonical origins. Refuse them rather than deriving another proof.
        let fields = host.split(separator: ".", omittingEmptySubsequences: false)
        let last = fields.last == "" ? fields.dropLast().last : fields.last
        if let last, (!last.isEmpty && last.utf8.allSatisfy({ (48...57).contains($0) })) || last.hasPrefix("0x") {
            return fields.count == 4 && fields.allSatisfy { field in
                guard let byte = UInt8(field) else { return false }
                return field == String(byte)
            }
        }
        return true
    }
}