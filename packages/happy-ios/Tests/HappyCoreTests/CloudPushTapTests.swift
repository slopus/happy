import Foundation
import XCTest
@testable import HappyCore

/// A tapped Happy Cloud push (`happy.cloud.push.v1`): what it names, and
/// the connection it opens on.
final class CloudPushTapTests: XCTestCase {
    private let notice = CloudPushNotification(instanceId: "ipkr89pp9j4f4edhsw7rpz98", userId: "member-one", agentId: "agent-one", notificationId: "notification-one")

    /// The `data` a server hands the relay, which the relay sends as the
    /// APNs payload's `body`.
    private var data: [String: Any] {
        ["kind": "happy.cloud.push.v1", "instanceId": "ipkr89pp9j4f4edhsw7rpz98", "userId": "member-one", "agentId": "agent-one", "notificationId": "notification-one"]
    }

    func testATappedCloudPushOpensItsAgent() {
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Found why cloud replies show twice"], "sound": "default"], "body": data]
        let tap = NotificationRouting.tap(fromData: NotificationRouting.data(userInfo: userInfo, isRemote: true))
        XCTAssertEqual(tap, .agent(notice))
    }
}
