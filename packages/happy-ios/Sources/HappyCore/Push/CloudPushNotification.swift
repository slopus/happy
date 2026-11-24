import Foundation

/// What a Happy Cloud server's push names (`happy.cloud.push.v1`, the
/// `data` it hands the relay): the installation it came from, the member
/// it was sent to, the agent whose chat a tap opens, and the notification's
/// own id. The title and body are the notification's and never read here.
public struct CloudPushNotification: Equatable, Sendable {
    public var instanceId: String
    public var userId: String
    public var agentId: String
    public var notificationId: String

    public init(instanceId: String, userId: String, agentId: String, notificationId: String) {
        self.instanceId = instanceId; self.userId = userId; self.agentId = agentId; self.notificationId = notificationId
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
