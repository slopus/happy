import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Opaque guest capability. Owner credentials never participate in this flow.
public struct GuestInvitation: Equatable, Sendable {
    public static let previewHost = "securities-feels-twin-texture.trycloudflare.com"
    public static var previewEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "HappyGuestPreviewInvites") as? Bool == true }
    public let token: String
    public let origin: URL
    public var url: URL { origin.appendingPathComponent("bot/invite/" + token) }
    public var identifier: String { SHA256.hash(data: Data((origin.absoluteString + "/" + token).utf8)).map { String(format: "%02x", $0) }.joined() }

    public init?(url: URL, previewEnabled: Bool = GuestInvitation.previewEnabled) {
        guard url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil, let host = url.host,
              (host == "app.happy.engineering" || (previewEnabled && host == Self.previewHost)),
              url.query == nil, url.fragment == nil else { return nil }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0].isEmpty, parts[1] == "bot", parts[2] == "invite" else { return nil }
        let token = String(parts[3])
        guard (16...512).contains(token.utf8.count), token.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }), let origin = URL(string: "https://\(host)") else { return nil }
        self.token = token
        self.origin = origin
    }
}

public struct GuestSession: Codable, Sendable {
    public let sessionId: String
    public let sessionToken: String
    public let botName: String
    public let displayName: String?
    /// Unix milliseconds, matching the Happy API.
    public let expiresAt: Double
    public let readOnly: Bool
}

public struct GuestMessage: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public let id: String
    public let role: Role
    public let text: String
    public let createdAt: Double
    public let senderName: String?
    public let isMine: Bool?

    public init(id: String, role: Role, text: String, createdAt: Double, senderName: String? = nil, isMine: Bool? = nil) {
        self.id = id; self.role = role; self.text = text; self.createdAt = createdAt
        self.senderName = senderName; self.isMine = isMine
    }
}

public struct GuestMessages: Decodable, Sendable {
    public enum Status: String, Decodable, Sendable { case online, offline }
    public let messages: [GuestMessage]
    public let cursor: String?
    public let status: Status
}

public enum GuestError: Error, Equatable, Sendable {
    case expired, revoked, alreadyRedeemed, inviteFull, invalidName, readOnly, unavailable, invalidResponse
    case retryAfter(Double)
}

public enum GuestDisplayName {
    public static func normalized(_ value: String) -> String? {
        let normalized = value.precomposedStringWithCanonicalMapping
        for scalar in normalized.unicodeScalars {
            switch scalar.properties.generalCategory {
            case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator: return nil
            default: break
            }
        }
        let name = normalized.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        guard (1...40).contains(name.count) else { return nil }
        for character in name {
            var marks = 0
            for (index, scalar) in character.unicodeScalars.enumerated() {
                switch scalar.properties.generalCategory {
                case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
                     .decimalNumber, .letterNumber, .otherNumber: break
                case .nonspacingMark, .spacingMark, .enclosingMark:
                    marks += 1
                    if index == 0 || marks > 4 { return nil }
                default:
                    guard " .'-_’".unicodeScalars.contains(scalar) else { return nil }
                }
            }
        }
        return name
    }
}