import Foundation

/// Classify direct codes before legacy parsing, including malformed direct
/// links: a bad direct code must never authorize a relay terminal.
public struct PairingLink: Equatable, Sendable {
    public static let prefix = "happy://direct?"
    public let address: String
    public let port: UInt16
    public let token: Data
    public let name: String
    public let expiresAt: Date

    public static func isAgentConnection(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return URLComponents(string: text).map { $0.scheme?.lowercased() == "happy" && $0.host?.lowercased() == "direct" } ?? text.lowercased().hasPrefix("happy://direct")
    }

    public init(_ text: String, now: Date = Date()) throws {
        struct Bundle: Decodable { let v: Double; let a: String; let p: Int; let t: String; let n: String; let e: Double }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(Self.prefix), text.utf8.count <= 16384,
              let data = CanonicalBase64URL.decode(String(text.dropFirst(Self.prefix.count))),
              let bundle = try? JSONDecoder().decode(Bundle.self, from: data) else { throw PairingError.invalidCode }
        guard bundle.v == 1 else { throw PairingError.updateRequired }
        guard !bundle.a.isEmpty, bundle.a.utf8.count <= 8192,
              !bundle.a.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let port = UInt16(exactly: bundle.p), port > 0,
              let token = CanonicalBase64URL.decode(bundle.t), token.count == 32,
              !bundle.n.isEmpty, bundle.n.count <= 128,
              !bundle.n.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              bundle.e.isFinite, bundle.e > 0 else { throw PairingError.invalidCode }
        let expiry = Date(timeIntervalSince1970: bundle.e / 1000)
        guard expiry > now else { throw PairingError.expired }
        address = bundle.a; self.port = port; self.token = token; name = bundle.n; expiresAt = expiry
    }
}

public enum PairingError: Error, Equatable, Sendable, LocalizedError {
    case invalidCode, updateRequired, expired, rejected, invalidProof, invalidResponse, unavailable, revoked

    public var errorDescription: String? {
        switch self {
        case .invalidCode: "This pairing code is invalid. Show a new code in Happy Agent and scan it."
        case .updateRequired: "Update Happy to use this pairing code."
        case .expired: "This pairing has expired. Show a new code in Happy Agent."
        case .rejected: "Pairing was rejected. Generate a new code and compare the emoji again."
        case .invalidProof: "The agent could not be verified. Show a new pairing code."
        case .invalidResponse: "The agent returned an invalid response."
        case .unavailable: "Could not reach the agent. Check its connection and try again."
        case .revoked: "This device is no longer authorized. Connect the agent again."
        }
    }
}

public enum CanonicalBase64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        guard !text.isEmpty, text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
        let padded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - text.utf8.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), encode(bytes) == text else { return nil }
        return bytes
    }
}