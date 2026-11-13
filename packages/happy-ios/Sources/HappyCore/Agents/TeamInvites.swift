import Foundation
import HappyWire

/// An invite to a Happy Cloud server (`POST /v0/invites`), as made: its
/// link is shown once, to whoever made it. `deliveryStatus` says whether
/// an email invite's email went out ("failed" when it didn't); nil for a
/// link.
public struct TeamInvite: Decodable, Equatable, Sendable {
    public var id: String
    public var link: String?
    public var role: String?
    public var deliveryStatus: String?

    public init(id: String, link: String?, role: String? = nil, deliveryStatus: String? = nil) {
        self.id = id
        self.link = link
        self.role = role
        self.deliveryStatus = deliveryStatus
    }

    public var emailFailed: Bool { deliveryStatus == "failed" }
}

/// Why an invite wasn't made.
public enum TeamInviteRefusal: Error, Equatable, Sendable {
    /// The server can't send email (`503 email_not_configured`): a link
    /// invite, shared by hand, still works.
    case emailNotConfigured
    /// The server has no invite route.
    case unsupported
    /// Refused as it was asked: an address it won't take, a role.
    case refused(String?)
}

public extension AgentClient {
    /// Invites `email` as a member, or makes a link anyone may join by
    /// when nil.
    func invite(email: String?, mutationId: String = ClientID.make()) async throws -> TeamInvite {
        struct Response: Decodable { var invite: TeamInvite }
        var body: [String: JSONValue] = ["mutationId": .string(mutationId)]
        if let email { body["email"] = .string(email) }
        do {
            return try await decode(Response.self, "POST", "/v0/invites", json: .object(body)).invite
        } catch AgentClientError.status(503, "email_not_configured", _) {
            throw TeamInviteRefusal.emailNotConfigured
        } catch AgentClientError.status(404, _, _), AgentClientError.status(405, _, _) {
            throw TeamInviteRefusal.unsupported
        } catch AgentClientError.status(let status, _, let message) where (400..<500).contains(status) && status != 401 {
            throw TeamInviteRefusal.refused(message)
        }
    }
}

/// An email address as far as it can be told while typing: something,
/// an @, and a domain with a dot in it.
public enum EmailAddress {
    public static func looksValid(_ text: String) -> Bool {
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !text.contains(where: \.isWhitespace) else { return false }
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty }
    }
}
