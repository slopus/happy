import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Web pages always use the remote network, never the phone's network.
public enum BrowserPolicy {
    public enum Route: Equatable, Sendable { case web, system }

    public static func route(_ url: URL) -> Route {
        guard ["http", "https", "ws", "wss"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return .system }
        return .web
    }

    public static func normalize(_ host: String) -> String {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        // Browsers canonicalize legacy IPv4 spellings before CONNECT. Match the
        // same authority for 127.1, octal/hex and integer loopback addresses.
        var address = in_addr()
        if host.withCString({ inet_aton($0, &address) }) == 1 {
            var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            if inet_ntop(AF_INET, &address, &buffer, socklen_t(buffer.count)) != nil { return String(cString: buffer) }
        }
        var ipv6 = in6_addr()
        if host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            if inet_ntop(AF_INET6, &ipv6, &buffer, socklen_t(buffer.count)) != nil { return String(cString: buffer) }
        }
        return host
    }

    public struct Authority: Equatable, Sendable {
        public let host: String
        public let port: UInt16
        public init?(url: URL) {
            guard let host = url.host, url.user == nil, url.password == nil,
                  ["http", "https", "ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
                  let port = UInt16(exactly: url.port ?? (["https", "wss"].contains(url.scheme ?? "") ? 443 : 80)), port > 0 else { return nil }
            let normalized = BrowserPolicy.normalize(host)
            guard !normalized.isEmpty, normalized.utf8.count <= 253,
                  normalized.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || "-._:".utf8.contains($0) }) else { return nil }
            self.host = normalized; self.port = port
        }
        public var text: String { "\(host.contains(":") ? "[\(host)]" : host):\(port)" }
    }

    /// Paths are checked before Foundation can normalize traversal away.
    public static func artifactPath(target: String, artifactID: String, version: Int) throws -> String {
        guard validID(artifactID), version > 0, target.hasPrefix("/"), !target.hasPrefix("//"),
              !target.utf8.contains(where: { $0 < 33 || $0 == 127 }), !target.contains("#") else { throw BrowserError.forbidden }
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0]
        for part in path.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
            guard let decoded = String(part).removingPercentEncoding, decoded != ".", decoded != "..",
                  !decoded.contains("/"), !decoded.contains("\\"), !decoded.contains("%"),
                  !decoded.utf8.contains(where: { $0 < 32 || $0 == 127 }) else { throw BrowserError.forbidden }
        }
        let prefix = "/v0/artifacts/\(artifactID)"
        if path.hasPrefix("/api/") { return prefix + target }
        guard path != "/api", path != "/" else { throw BrowserError.forbidden }
        return "\(prefix)/versions/\(version)/files\(target)"
    }

    public static func validID(_ value: String) -> Bool {
        guard let first = value.utf8.first, (97...122).contains(first) else { return false }
        return value.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) }
    }

    public static func checkArtifactOrigin(_ head: BrowserHTTPHead, authority: Authority) throws {
        if let site = head.value("Sec-Fetch-Site"), !["same-origin", "none"].contains(site.lowercased()) { throw BrowserError.forbidden }
        if let origin = head.value("Origin") {
            guard let url = URL(string: origin), url.scheme == "http", Authority(url: url) == authority else { throw BrowserError.forbidden }
        }
    }
}

public enum BrowserError: Error, Equatable, Sendable {
    case forbidden, malformed, tooLarge, unavailable, upstream(Int)
}

/// A bounded HTTP head, preserving duplicate response fields (notably Set-Cookie).
public struct BrowserHTTPHead: Sendable {
    public var line: String
    public var fields: [(String, String)]
    public func value(_ name: String) -> String? { fields.first { $0.0.lowercased() == name.lowercased() }?.1 }
    public var data: Data { Data(([line] + fields.map { "\($0.0): \($0.1)" } + ["", ""]).joined(separator: "\r\n").utf8) }

    public static func parse(_ data: Data) throws -> (BrowserHTTPHead, Data)? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= 32768 else { throw BrowserError.tooLarge }; return nil
        }
        guard end.lowerBound - data.startIndex <= 32768,
              let text = String(data: data[..<end.lowerBound], encoding: .utf8) else { throw BrowserError.malformed }
        let lines = text.components(separatedBy: "\r\n")
        guard let line = lines.first, !line.isEmpty else { throw BrowserError.malformed }
        var fields: [(String, String)] = []
        for field in lines.dropFirst() {
            guard let colon = field.firstIndex(of: ":") else { throw BrowserError.malformed }
            let name = String(field[..<colon])
            let value = field[field.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name.utf8.allSatisfy({ (33...126).contains($0) && !"()<>@,;:\\\"/[]?={} ".utf8.contains($0) }),
                  !value.utf8.contains(where: { $0 < 32 && $0 != 9 || $0 == 127 }) else { throw BrowserError.malformed }
            fields.append((name, value))
        }
        return (BrowserHTTPHead(line: line, fields: fields), Data(data[end.upperBound...]))
    }

    public func artifactRequest(artifactID: String, version: Int, credential: String) throws -> BrowserHTTPHead {
        let parts = line.split(separator: " ")
        guard parts.count == 3, parts[2] == "HTTP/1.1", parts[0] != "CONNECT",
              parts[0].utf8.allSatisfy({ (65...90).contains($0) }),
              !credential.contains("\r"), !credential.contains("\n") else { throw BrowserError.malformed }
        let target = try BrowserPolicy.artifactPath(target: String(parts[1]), artifactID: artifactID, version: version)
        let stripped: Set<String> = ["host", "authorization", "proxy-authorization", "proxy-connection", "connection", "x-happy-proxy-route", "expect"]
        var fields = self.fields.filter { !stripped.contains($0.0.lowercased()) }
        fields += [("Host", "server.tailcat"), ("Authorization", "Bearer \(credential)"), ("Connection", value("upgrade") == nil ? "close" : "Upgrade")]
        return BrowserHTTPHead(line: "\(parts[0]) \(target) HTTP/1.1", fields: fields)
    }

    public func artifactResponse() -> BrowserHTTPHead {
        var result = self
        // The daemon uses an opaque sandbox on its privileged origin. This
        // isolated origin needs same-origin for fetch, SSE and browser storage.
        result.fields.removeAll { $0.0.lowercased() == "connection" }
        var sandboxed = false
        result.fields = result.fields.map { name, value in
            guard name.lowercased() == "content-security-policy" else { return (name, value) }
            let directives = value.components(separatedBy: ";").map { directive in
                let words = directive.split(whereSeparator: { $0.isWhitespace })
                guard words.first?.lowercased() == "sandbox" else { return directive }
                sandboxed = true
                return words.contains("allow-same-origin") ? directive : directive + " allow-same-origin"
            }
            return (name, directives.joined(separator: ";"))
        }
        if !sandboxed { result.fields.append(("Content-Security-Policy", "sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads")) }
        result.fields.append(("Connection", value("upgrade") == nil ? "close" : "Upgrade"))
        return result
    }
}