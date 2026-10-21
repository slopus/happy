import Foundation

/// What a scanned or pasted QR payload asks for. Mirrors the prefixes
/// happy-app accepts in useConnectTerminal.ts and useConnectAccount.ts.
///
/// The key after `?` is the requester's X25519 public key, base64url. The
/// formats are fixed by the CLI and the other apps, including the odd
/// triple slash of the account link.
public enum PairingLink: Equatable, Sendable {
    /// A terminal (CLI / desktop) asking to be connected to this account.
    case terminal(publicKey: Data)
    /// Another phone or browser asking for this account (device linking).
    case account(publicKey: Data)

    public static let terminalPrefix = "happy://terminal?"
    public static let accountPrefix = "happy:///account?"

    public init?(_ string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix(Self.terminalPrefix) {
            guard let key = Self.decodeKey(String(trimmed.dropFirst(Self.terminalPrefix.count))) else { return nil }
            self = .terminal(publicKey: key)
        } else if trimmed.hasPrefix(Self.accountPrefix) {
            guard let key = Self.decodeKey(String(trimmed.dropFirst(Self.accountPrefix.count))) else { return nil }
            self = .account(publicKey: key)
        } else {
            return nil
        }
    }

    public var publicKey: Data {
        switch self {
        case .terminal(let key), .account(let key): return key
        }
    }

    public var urlString: String {
        switch self {
        case .terminal(let key): return Self.terminalPrefix + Self.encodeKey(key)
        case .account(let key): return Self.accountPrefix + Self.encodeKey(key)
        }
    }

    /// Base64url without padding, decoded leniently. Kept local so HappyWire
    /// has no dependency on HappyCrypto.
    private static func decodeKey(_ string: String) -> Data? {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = base64.utf8.count % 4
        if remainder != 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: base64), data.count == 32 else { return nil }
        return data
    }

    private static func encodeKey(_ key: Data) -> String {
        key.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
