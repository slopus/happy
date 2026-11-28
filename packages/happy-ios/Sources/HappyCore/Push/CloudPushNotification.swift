import Foundation
import HappyWire

/// What a Happy Cloud server's push names (`happy.cloud.push.v1`, the
/// `data` it hands the relay): the installation it came from, the member
/// it was sent to, the agent whose chat a tap opens, and the notification's
/// own id. The title and body are the notification's and never read here.
/// The rules are Android's `CloudPushNotification`.
public struct CloudPushNotification: Equatable, Sendable {
    public static let kind = "happy.cloud.push.v1"

    public var instanceId: String
    public var userId: String
    public var agentId: String
    public var notificationId: String

    public init(instanceId: String, userId: String, agentId: String, notificationId: String) {
        self.instanceId = instanceId; self.userId = userId; self.agentId = agentId; self.notificationId = notificationId
    }

    /// Whether `data` is a cloud push at all, readable or not: any
    /// `happy.cloud.push.*` version, or anything naming an installation, a
    /// member and an agent. Such a payload never opens a session, so a
    /// newer server's push can't land in a Happy account's chat.
    public static func owns(_ data: [AnyHashable: Any]) -> Bool {
        (data["kind"] as? String)?.hasPrefix("happy.cloud.push.") == true
            || ["instanceId", "userId", "agentId"].allSatisfy { data[$0] != nil }
    }

    /// Strict: exactly the five fields, all strings, this version, and ids
    /// of the shapes the server makes. Anything else names nothing.
    public init?(_ data: [AnyHashable: Any]) {
        guard data.count == 5, data["kind"] as? String == Self.kind,
              let instanceId = data["instanceId"] as? String, HappyLink.isInstanceID(instanceId),
              let userId = data["userId"] as? String, Self.isOpaque(userId),
              let agentId = data["agentId"] as? String, Self.isAgentID(agentId),
              let notificationId = data["notificationId"] as? String, Self.isOpaque(notificationId) else { return nil }
        self.init(instanceId: instanceId, userId: userId, agentId: agentId, notificationId: notificationId)
    }

    /// An id this app only compares: something visible, at most 256 UTF-16
    /// units, no control characters.
    private static func isOpaque(_ value: String) -> Bool {
        value.contains { !$0.isWhitespace } && value.utf16.count <= 256
            && value.unicodeScalars.allSatisfy { $0.value > 0x1F && !(0x7F...0x9F).contains($0.value) }
    }

    /// `[A-Za-z0-9_-]{1,128}`: it goes into a path.
    private static func isAgentID(_ value: String) -> Bool {
        (1...128).contains(value.utf8.count) && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte == 95 || byte == 45
        }
    }

    /// The connection a tap opens on: one signed in to that installation
    /// as that member, and still signed in; `open` when it is one of them.
    /// Never another login because it shares the server or is the one
    /// open, and nil when there is none. `userId` is who a connection is
    /// signed in as (`AgentConnections.userId(for:)`): nil for a pairing,
    /// and for a sign-in still waiting for its profile.
    public func connection(in connections: [AgentConnection], userId: (String) -> String?, open: String?) -> String? {
        let matches = connections.filter { !$0.revoked && $0.instanceId == instanceId && userId($0.id) == self.userId }
        return (matches.first { $0.id == open } ?? matches.first)?.id
    }
}

/// What a tapped notification opens.
public enum NotificationTap: Equatable, Sendable {
    /// A Happy account's session.
    case session(String)
    /// An agent's chat, on the server and member its push names.
    case agent(CloudPushNotification)
    case nothing
}
