import Foundation

/// An invite to a Happy Cloud server: the token its private link carries.
/// The token is a bearer secret: it lives in memory only, goes nowhere but
/// the API's two invite calls, and the invite never prints it.
public struct CloudInvite: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let token: String

    /// A token as the cluster makes them: 43 of `A-Z a-z 0-9 _ -`.
    public init?(token: String) {
        guard token.utf8.count == 43,
              token.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 })
        else { return nil }
        self.token = token
    }

    /// The invite in `url`; nil for any other link, and for an invite link
    /// whose token isn't one (`CloudInviteLink.invalid`).
    public init?(url: URL) {
        guard case .invite(let invite) = CloudInviteLink(url: url) else { return nil }
        self = invite
    }

    public var description: String { "CloudInvite(…)" }
    public var debugDescription: String { description }
}

/// A link to an invite, in either of its two forms:
///
/// - `https://<web>/join#<token>`, the link people are sent (a universal
///   link; `<web>` is `HappyCloud.web`);
/// - `happy://cloud/join#<token>`, what the web page's Open in Happy opens.
///
/// Only `/join` there is an invite: the web host's other pages (its server
/// picker at `/`) and other hosts (`<name>.<web>`, a server's web app) are
/// not. The token is the fragment and only ever the fragment: one in a
/// query is never read.
public enum CloudInviteLink: Equatable, Sendable {
    case invite(CloudInvite)
    /// A link to the invite page without a token that could be one: none,
    /// a misshapen one, or a query beside it. It opens as an invite that
    /// doesn't work, and nothing is asked of the network.
    case invalid

    /// The invite link `url` is; nil for any other link.
    public init?(url: URL) {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, parts.port == nil,
              let host = parts.host?.lowercased(), parts.path == "/join" || parts.path == "/join/" else { return nil }
        switch parts.scheme?.lowercased() {
        case "https": guard host == HappyCloud.web.lowercased() else { return nil }
        case "happy": guard host == "cloud" else { return nil }
        default: return nil
        }
        guard parts.query == nil, let invite = CloudInvite(token: parts.percentEncodedFragment ?? "") else {
            self = .invalid
            return
        }
        self = .invite(invite)
    }
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
    /// Who sent it: their display name, which they may never have set, and
    /// their picture. nil once they deleted their account.
    public struct Inviter: Decodable, Equatable, Sendable {
        public var name: String?
        /// A `data:` URL, or nil.
        public var image: String?

        public init(name: String?, image: String? = nil) { self.name = name; self.image = image }

        public var imageData: Data? { CloudInvitePreview.bytes(image) }
    }
    public var server: Server
    public var roleName: String?
    public var inviter: Inviter?
    /// When the invite stops working (`expiresAt`, RFC 3339); nil when the
    /// answer has none that reads as a date.
    public var expiresAt: Date?

    public init(server: Server, roleName: String?, inviter: Inviter? = nil, expiresAt: Date? = nil) {
        self.server = server; self.roleName = roleName; self.inviter = inviter; self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey { case server, roleName, inviter, expiresAt }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        server = try values.decode(Server.self, forKey: .server)
        roleName = try values.decodeIfPresent(String.self, forKey: .roleName)
        inviter = try values.decodeIfPresent(Inviter.self, forKey: .inviter)
        expiresAt = (try? values.decodeIfPresent(String.self, forKey: .expiresAt)).flatMap { $0 }.flatMap(Self.date)
    }

    /// An RFC 3339 time, with or without a fraction of a second (the
    /// cluster's has six digits).
    public static func date(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: .iso8601) { return date }
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        // A fraction the parser won't take (too long): the second it is in.
        guard let dot = text.firstIndex(of: "."), let end = text[dot...].dropFirst().firstIndex(where: { !("0"..."9").contains($0) }) else { return nil }
        return try? Date(String(text[..<dot] + text[end...]), strategy: .iso8601)
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
