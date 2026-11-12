import Foundation

/// An invite to a Happy Cloud server, from its private link:
/// `https://<invite>/#<token>`, or the older `https://<web>/join#<token>`.
/// The token is a bearer secret: it lives in memory only, and the invite
/// never prints it.
public struct CloudInvite: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let token: String

    /// The invite in `url`; nil for any other link.
    public init?(url: URL) {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil, url.query == nil,
              let host = url.host?.lowercased(), let token = url.fragment else { return nil }
        let path = url.path
        guard (host == HappyCloud.invite && (path.isEmpty || path == "/")) || (host == HappyCloud.web && (path == "/join" || path == "/join/")),
              token.utf8.count == 43,
              token.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 })
        else { return nil }
        self.token = token
    }

    public var description: String { "CloudInvite(…)" }
    public var debugDescription: String { description }
}

/// What an invite offers (`POST /v1/invites/preview`): the server and
/// the role it gives, by the role's name.
public struct CloudInvitePreview: Decodable, Equatable, Sendable {
    public struct Server: Decodable, Equatable, Sendable {
        public var name: String
        public var displayName: String?
        /// A `data:` URL, or nil.
        public var image: String?

        public init(name: String, displayName: String? = nil, image: String? = nil) {
            self.name = name; self.displayName = displayName; self.image = image
        }

        public var title: String { displayName.flatMap { $0.isEmpty ? nil : $0 } ?? name }

        public var imageData: Data? { CloudInvitePreview.bytes(image) }
    }
    /// Who sent it.
    public struct Inviter: Decodable, Equatable, Sendable {
        public var name: String
        /// A `data:` URL, or nil.
        public var image: String?

        public init(name: String, image: String? = nil) { self.name = name; self.image = image }

        public var imageData: Data? { CloudInvitePreview.bytes(image) }
    }
    public var server: Server
    public var roleName: String?
    public var inviter: Inviter?

    public init(server: Server, roleName: String?, inviter: Inviter? = nil) {
        self.server = server; self.roleName = roleName; self.inviter = inviter
    }

    /// A picture's bytes, from its base64 `data:` URL.
    static func bytes(_ image: String?) -> Data? {
        guard let image, image.hasPrefix("data:"), let comma = image.firstIndex(of: ","),
              image[..<comma].hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(image[image.index(after: comma)...]))
    }
}

/// Why an invite can't be taken, from the accounts service's answer.
public enum CloudInviteError: Error, Equatable, Sendable {
    /// Unknown or malformed.
    case invalid
    case expired
    case revoked
    /// Every use of it is taken.
    case exhausted
    /// An invite for one email address, already taken; perhaps by this
    /// account.
    case accepted
    /// It is for another email address; `hint` is that address, partly
    /// hidden (`s…@…`).
    case emailMismatch(hint: String?)
}
