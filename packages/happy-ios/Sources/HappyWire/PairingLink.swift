import Foundation

/// Classify direct codes before legacy parsing, including malformed direct
/// links: a bad direct code must never authorize a relay terminal.
public struct PairingLink: Equatable, Sendable {
    public static let prefix = "happy://direct?"
    public let address: String
    public let publicUrl: String?
    public let port: UInt16
    public let token: Data
    public let name: String
    public let expiresAt: Date

    public static func isAgentConnection(_ text: String) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return URLComponents(string: text).map { $0.scheme?.lowercased() == "happy" && $0.host?.lowercased() == "direct" } ?? text.lowercased().hasPrefix("happy://direct")
    }

    public init(_ text: String, now: Date = Date()) throws {
        struct Bundle: Decodable {
            let v: Double; let a: String?; let p: Int?; let u: String?; let t: String; let n: String; let e: Double
            let hasA: Bool; let hasP: Bool; let hasU: Bool
            enum CodingKeys: String, CodingKey { case v, a, p, u, t, n, e }
            init(from decoder: any Decoder) throws {
                let values = try decoder.container(keyedBy: CodingKeys.self)
                v = try values.decode(Double.self, forKey: .v)
                a = try values.decodeIfPresent(String.self, forKey: .a)
                p = try values.decodeIfPresent(Int.self, forKey: .p)
                u = try values.decodeIfPresent(String.self, forKey: .u)
                t = try values.decode(String.self, forKey: .t)
                n = try values.decode(String.self, forKey: .n)
                e = try values.decode(Double.self, forKey: .e)
                hasA = values.contains(.a); hasP = values.contains(.p); hasU = values.contains(.u)
            }
        }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(Self.prefix), text.utf8.count <= 16384,
              let data = CanonicalBase64URL.decode(String(text.dropFirst(Self.prefix.count))),
              let bundle = try? JSONDecoder().decode(Bundle.self, from: data) else { throw PairingError.invalidCode }
        guard bundle.v == 1 || bundle.v == 2 else { throw PairingError.updateRequired }
        let address: String
        let port: UInt16
        if bundle.v == 2 {
            guard let value = bundle.u, !bundle.hasA, !bundle.hasP else { throw PairingError.invalidCode }
            let origin = try AgentOrigin(value)
            address = origin.value; port = origin.port; publicUrl = origin.value
        } else {
            guard let value = bundle.a, !value.isEmpty, value.utf8.count <= 8192,
                  !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
                  let number = bundle.p, let parsed = UInt16(exactly: number), parsed > 0,
                  !bundle.hasU else { throw PairingError.invalidCode }
            address = value; port = parsed; publicUrl = nil
        }
        guard let token = CanonicalBase64URL.decode(bundle.t), token.count == 32,
              !bundle.n.isEmpty, bundle.n.count <= 128,
              !bundle.n.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              bundle.e.isFinite, bundle.e > 0 else { throw PairingError.invalidCode }
        let expiry = Date(timeIntervalSince1970: bundle.e / 1000)
        guard expiry > now else { throw PairingError.expired }
        self.address = address; self.port = port; self.token = token; name = bundle.n; expiresAt = expiry
    }
}

public enum PairingError: Error, Equatable, Sendable, LocalizedError {
    case invalidCode, updateRequired, expired, rejected, invalidProof, invalidResponse, unavailable, revoked
    /// The server's `happy.toml` turned phone pairing off.
    case turnedOff

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
        case .turnedOff: "Phone pairing is turned off on this server."
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