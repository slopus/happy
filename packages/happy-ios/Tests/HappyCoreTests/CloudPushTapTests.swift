import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A tapped Happy Cloud push (`happy.cloud.push.v1`): what it names, and
/// the connection it opens on.
final class CloudPushTapTests: XCTestCase {
    private let notice = CloudPushNotification(instanceId: "ipkr89pp9j4f4edhsw7rpz98", userId: "member-one", agentId: "agent-one", notificationId: "notification-one")

    /// The `data` a server hands the relay, which the relay sends as the
    /// APNs payload's `body`.
    private var data: [String: Any] {
        ["kind": "happy.cloud.push.v1", "instanceId": "ipkr89pp9j4f4edhsw7rpz98", "userId": "member-one", "agentId": "agent-one", "notificationId": "notification-one"]
    }

    private func data(_ change: (inout [String: Any]) -> Void) -> [String: Any] {
        var data = data
        change(&data)
        return data
    }

    func testATappedCloudPushOpensItsAgent() {
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "Found why cloud replies show twice"], "sound": "default"], "body": data]
        let tap = NotificationRouting.tap(fromData: NotificationRouting.data(userInfo: userInfo, isRemote: true))
        XCTAssertEqual(tap, .agent(notice))
    }

    func testTheLongestIdsAreRead() {
        let long = data {
            $0["userId"] = String(repeating: "u", count: 256)
            $0["agentId"] = String(repeating: "A", count: 126) + "_-"
            $0["notificationId"] = "01JD · notification"
        }
        XCTAssertEqual(NotificationRouting.tap(fromData: long), .agent(CloudPushNotification(
            instanceId: "ipkr89pp9j4f4edhsw7rpz98", userId: String(repeating: "u", count: 256),
            agentId: String(repeating: "A", count: 126) + "_-", notificationId: "01JD · notification")))
    }

    /// A cloud payload this app can't read opens nothing, and the session
    /// it also names is never opened in its place.
    func testAMalformedCloudPushOpensNothingAndNeverASession() {
        let malformed: [(String, [String: Any])] = [
            ("another version", data { $0["kind"] = "happy.cloud.push.v2" }),
            ("the clear message", data { $0["kind"] = "happy.cloud.push.clear.v1"; $0["notificationId"] = nil }),
            ("another kind", data { $0["kind"] = "done" }),
            ("no kind", data { $0["kind"] = nil }),
            ("no notification id", data { $0["notificationId"] = nil }),
            ("no agent", data { $0["agentId"] = nil }),
            ("an extra field", data { $0["category"] = "turnComplete" }),
            ("a member that isn't a string", data { $0["userId"] = 123 }),
            ("an instance that is an address", data { $0["instanceId"] = "https://evil.example" }),
            ("an instance in capitals", data { $0["instanceId"] = "IPKR89PP9J4F4EDHSW7RPZ98" }),
            ("an instance one short", data { $0["instanceId"] = "ipkr89pp9j4f4edhsw7rpz9" }),
            ("an agent that is a path", data { $0["agentId"] = "../other" }),
            ("an empty agent", data { $0["agentId"] = "" }),
            ("an agent of 129", data { $0["agentId"] = String(repeating: "a", count: 129) }),
            ("an empty notification id", data { $0["notificationId"] = "" }),
            ("a blank member", data { $0["userId"] = "  \n" }),
            ("a member of 257", data { $0["userId"] = String(repeating: "u", count: 257) }),
            ("a notification id of 257", data { $0["notificationId"] = String(repeating: "n", count: 257) }),
            ("a control character", data { $0["notificationId"] = "a\u{7}b" }),
            ("a C1 control character", data { $0["userId"] = "a\u{85}b" }),
        ]
        for (name, payload) in malformed {
            XCTAssertEqual(NotificationRouting.tap(fromData: payload), .nothing, name)
            var legacy = payload
            legacy["sessionId"] = "legacy"
            legacy["url"] = "/session/legacy"
            XCTAssertEqual(NotificationRouting.tap(fromData: legacy), .nothing, "\(name), naming a session")
            let userInfo: [AnyHashable: Any] = ["aps": ["alert": "Done"], "body": legacy]
            XCTAssertEqual(NotificationRouting.tap(fromData: NotificationRouting.data(userInfo: userInfo, isRemote: true)), .nothing, "\(name), as APNs delivers it")
        }
    }

    func testAValidCloudPushThatAlsoNamesASessionOpensNothing() {
        XCTAssertEqual(NotificationRouting.tap(fromData: data { $0["sessionId"] = "legacy" }), .nothing)
        XCTAssertEqual(NotificationRouting.tap(fromData: #"{"kind":"happy.cloud.push.v3","sessionId":"legacy"}"#), .nothing)
    }

    /// A Happy account's push may carry a `kind` of its own.
    func testASessionPushIsNotACloudPush() {
        XCTAssertEqual(NotificationRouting.tap(fromData: ["kind": "done", "sessionId": "s1"]), .session("s1"))
        XCTAssertEqual(NotificationRouting.tap(fromData: ["sessionId": "s1", "userId": "member-one", "agentId": "agent-one"]), .session("s1"))
        XCTAssertEqual(NotificationRouting.tap(fromData: ["kind": 7, "url": "/session/s2"]), .session("s2"))
    }

    // MARK: The connection

    private func connection(_ id: String, instance: String? = "ipkr89pp9j4f4edhsw7rpz98", revoked: Bool = false) -> AgentConnection {
        var connection = AgentConnection(id: id, name: id, addedAt: Date(timeIntervalSince1970: 1))
        connection.instanceId = instance
        connection.revoked = revoked
        return connection
    }

    func testTheConnectionIsTheMembersOwnNeverTheOpenOne() {
        let connections = [connection("other-login"), connection("connection-one"), connection("paired")]
        let members = ["other-login": "member-two", "connection-one": "member-one"]
        XCTAssertEqual(notice.connection(in: connections, userId: { members[$0] }, open: "other-login"), "connection-one")
        XCTAssertEqual(notice.connection(in: connections, userId: { members[$0] }, open: nil), "connection-one")
        var unknown = notice
        unknown.userId = "unknown"
        XCTAssertNil(unknown.connection(in: connections, userId: { members[$0] }, open: "other-login"))
        var elsewhere = notice
        elsewhere.instanceId = "iother89pp9j4f4edhsw7rpz"
        XCTAssertNil(elsewhere.connection(in: connections, userId: { members[$0] }, open: "connection-one"))
        XCTAssertNil(notice.connection(in: [], userId: { members[$0] }, open: nil))
    }

    func testTheOpenConnectionWinsAmongTheMembersOwn() {
        let connections = [connection("first"), connection("second")]
        let member: (String) -> String? = { _ in "member-one" }
        XCTAssertEqual(notice.connection(in: connections, userId: member, open: "second"), "second")
        XCTAssertEqual(notice.connection(in: connections, userId: member, open: "first"), "first")
        XCTAssertEqual(notice.connection(in: connections, userId: member, open: "gone"), "first")
    }

    func testASignedOutConnectionIsNeverChosen() {
        let member: (String) -> String? = { _ in "member-one" }
        XCTAssertNil(notice.connection(in: [connection("ended", revoked: true)], userId: member, open: "ended"))
        XCTAssertEqual(notice.connection(in: [connection("ended", revoked: true), connection("live")], userId: member, open: "ended"), "live")
        // A sign-in still waiting for its profile has no member yet; a daemon that reported no installation names none.
        XCTAssertNil(notice.connection(in: [connection("waiting")], userId: { _ in nil }, open: "waiting"))
        XCTAssertNil(notice.connection(in: [connection("old-daemon", instance: nil)], userId: member, open: "old-daemon"))
    }

    /// Against the real registry: two members signed in to one server on
    /// this phone, then one's session ending.
    @MainActor
    func testTwoMembersOfOneServerEachGetTheirOwnPush() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let manager = AgentConnections(credentials: InMemoryAgentConnectionCredentialStore(), directory: directory, makeTransport: { _ in IdentityTransport() })
        await manager.setForeground(false)
        let method = OAuthMethod(id: "jwt", name: "Happy Cloud", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        func signIn(_ userId: String) async throws -> AgentConnection {
            try await manager.addServer(try AgentOrigin("https://team.example"), signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r-\(userId)", clientId: "happy"), userId: userId),
                                        access: OAuthAccess(token: "a", expiresAt: nil), name: "Team", instanceId: notice.instanceId)
        }
        let one = try await signIn("member-one")
        let two = try await signIn("member-two")
        XCTAssertNotEqual(one.id, two.id)
        XCTAssertEqual(manager.activeID, two.id)
        func chosen(_ push: CloudPushNotification) -> String? {
            push.connection(in: manager.accounts, userId: { manager.userId(for: $0) }, open: manager.activeID)
        }
        var forTwo = notice
        forTwo.userId = "member-two"
        XCTAssertEqual(chosen(notice), one.id)
        XCTAssertEqual(chosen(forTwo), two.id)

        let authorization = try XCTUnwrap(manager.credential(for: one.id).map { manager.authorization($0, for: one.id) })
        await authorization.signInRequired()
        for _ in 0..<200 where !manager.signedOut(one.id) { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(manager.signedOut(one.id))
        XCTAssertNil(chosen(notice), "a push for a member signed out here opened another login")
        XCTAssertEqual(chosen(forTwo), two.id)
    }
}
