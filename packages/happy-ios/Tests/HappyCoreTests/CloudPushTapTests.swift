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
        XCTAssertEqual(notice.connection(in: connections, member: { members[$0] }, open: "other-login"), "connection-one")
        XCTAssertEqual(notice.connection(in: connections, member: { members[$0] }, open: nil), "connection-one")
        var unknown = notice
        unknown.userId = "unknown"
        XCTAssertNil(unknown.connection(in: connections, member: { members[$0] }, open: "other-login"))
        var elsewhere = notice
        elsewhere.instanceId = "iother89pp9j4f4edhsw7rpz"
        XCTAssertNil(elsewhere.connection(in: connections, member: { members[$0] }, open: "connection-one"))
        XCTAssertNil(notice.connection(in: [], member: { members[$0] }, open: nil))
    }

    func testTheOpenConnectionWinsAmongTheMembersOwn() {
        let connections = [connection("first"), connection("second")]
        let member: (String) -> String? = { _ in "member-one" }
        XCTAssertEqual(notice.connection(in: connections, member: member, open: "second"), "second")
        XCTAssertEqual(notice.connection(in: connections, member: member, open: "first"), "first")
        XCTAssertEqual(notice.connection(in: connections, member: member, open: "gone"), "first")
    }

    func testASignedOutConnectionIsNeverChosen() {
        let member: (String) -> String? = { _ in "member-one" }
        XCTAssertNil(notice.connection(in: [connection("ended", revoked: true)], member: member, open: "ended"))
        XCTAssertEqual(notice.connection(in: [connection("ended", revoked: true), connection("live")], member: member, open: "ended"), "live")
        // A sign-in still waiting for its profile has no member yet; a daemon that reported no installation names none.
        XCTAssertNil(notice.connection(in: [connection("waiting")], member: { _ in nil }, open: "waiting"))
        XCTAssertNil(notice.connection(in: [connection("old-daemon", instance: nil)], member: member, open: "old-daemon"))
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
            push.connection(in: manager.accounts, member: { manager.pushMember(for: $0) }, open: manager.activeID)
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

    // MARK: A paired computer

    private static let standalone = CloudPushNotification(instanceId: "ipkr89pp9j4f4edhsw7rpz98", userId: "standalone", agentId: "agent-one", notificationId: "notification-one")

    /// A registry on disk, whose pairings' daemon reports `instance` from
    /// its health.
    @MainActor
    private func registry(instance: String? = "ipkr89pp9j4f4edhsw7rpz98") async throws -> (manager: AgentConnections, store: InMemoryAgentConnectionCredentialStore, directory: URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let daemon = IdentityTransport()
        await daemon.report(instanceId: instance)
        let store = InMemoryAgentConnectionCredentialStore()
        let manager = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in daemon })
        await manager.setForeground(false)
        return (manager, store, directory)
    }

    private func pairing(_ device: String = "device") -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tcAddress", port: 24781, deviceID: device, deviceToken: CanonicalBase64URL.encode(Data(repeating: 7, count: 32)))
    }

    @MainActor
    private func signIn(_ manager: AgentConnections, as userId: String?, instance: String = "ipkr89pp9j4f4edhsw7rpz98") async throws -> AgentConnection {
        let method = OAuthMethod(id: "jwt", name: "Team", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        return try await manager.addServer(try AgentOrigin("https://team.example"), signIn: ServerSignInRecord(method: method, grant: OAuthGrant(clientId: "happy"), userId: userId),
                                           access: OAuthAccess(token: "a", expiresAt: nil), name: "Team", instanceId: instance)
    }

    @MainActor
    private func chosen(_ push: CloudPushNotification, in manager: AgentConnections) -> String? {
        push.connection(in: manager.accounts, member: { manager.pushMember(for: $0) }, open: manager.activeID)
    }

    /// A computer of the person's own has no member, and its daemon's
    /// pushes name `standalone` (happy-agent API.md, "What the phone
    /// receives"): they open on its pairing, and on nothing else.
    @MainActor
    func testAPairedComputersPushOpensOnItsPairing() async throws {
        let manager = try await registry().manager
        let paired = try await manager.add(pairing(), name: "Mac")
        XCTAssertEqual(paired.instanceId, notice.instanceId)
        XCTAssertEqual(chosen(Self.standalone, in: manager), paired.id)
        XCTAssertNil(chosen(notice, in: manager), "a member's push opened on a pairing")
        var elsewhere = Self.standalone
        elsewhere.instanceId = "iother89pp9j4f4edhsw7rpz"
        XCTAssertNil(chosen(elsewhere, in: manager), "another computer's push opened on this pairing")
    }

    @MainActor
    func testAPairingWhoseComputerNamedNoInstallationOpensNothing() async throws {
        let manager = try await registry(instance: nil).manager
        let paired = try await manager.add(pairing(), name: "Old Mac")
        XCTAssertNil(paired.instanceId)
        XCTAssertNil(chosen(Self.standalone, in: manager))
    }

    /// One installation reached both ways on this phone: each push opens
    /// on its own kind of connection, whichever is open.
    @MainActor
    func testAStandalonePushNeverOpensOnASignInNorAMembersOnAPairing() async throws {
        let manager = try await registry().manager
        let signedIn = try await signIn(manager, as: "member-one")
        XCTAssertNil(chosen(Self.standalone, in: manager), "a standalone push opened on a member's sign-in")
        let paired = try await manager.add(pairing(), name: "Mac")
        for open in [signedIn.id, paired.id] {
            manager.open(open)
            XCTAssertEqual(chosen(Self.standalone, in: manager), paired.id)
            XCTAssertEqual(chosen(notice, in: manager), signedIn.id)
        }
    }

    /// A sign-in still waiting for its profile is nobody yet, never the
    /// one person of a computer.
    @MainActor
    func testASignInWithNoMemberYetOpensNothing() async throws {
        let manager = try await registry().manager
        _ = try await signIn(manager, as: nil)
        XCTAssertNil(chosen(Self.standalone, in: manager))
        XCTAssertNil(chosen(notice, in: manager))
    }

    /// A pairing with a team's server belongs to the member who made it:
    /// the daemon's pushes name that member, as its bootstrap's
    /// `profile.userId` does. Kept on disk, so a tap that launches the
    /// app finds it.
    @MainActor
    func testAPairingWithATeamsServerOpensOnlyItsOwnMembersPush() async throws {
        let (manager, store, directory) = try await registry()
        let paired = try await manager.add(pairing(), name: "Team Mac")
        await manager.heard(.verified(SyncEngine.Computer(health: nil, node: nil, owner: .string("member-one"))), from: paired.id)
        XCTAssertEqual(chosen(notice, in: manager), paired.id)
        var forTwo = notice
        forTwo.userId = "member-two"
        XCTAssertNil(chosen(forTwo, in: manager), "member two's push opened on member one's pairing")
        XCTAssertNil(chosen(Self.standalone, in: manager), "a standalone push opened on a member's pairing")

        let restored = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        await restored.setForeground(false)
        try await restored.restore()
        XCTAssertEqual(chosen(notice, in: restored), paired.id, "the member was not kept for the next launch")

        // Outside a team again (the daemon's bootstrap says null): its one person.
        await manager.heard(.verified(SyncEngine.Computer(health: nil, node: nil, owner: .null)), from: paired.id)
        XCTAssertEqual(chosen(Self.standalone, in: manager), paired.id)
        XCTAssertNil(chosen(notice, in: manager))
        // A bootstrap that says nothing of it keeps what was known.
        await manager.heard(.verified(SyncEngine.Computer(health: nil, node: nil, owner: .string("member-one"))), from: paired.id)
        await manager.heard(.verified(SyncEngine.Computer(health: nil, node: nil)), from: paired.id)
        XCTAssertEqual(chosen(notice, in: manager), paired.id)
    }

    /// The installation's id read after the pairing was stored (a computer
    /// asleep when it was paired) is kept too.
    @MainActor
    func testAnInstallationReadLaterIsKeptForTheNextLaunch() async throws {
        let (manager, store, directory) = try await registry(instance: nil)
        let paired = try await manager.add(pairing(), name: "Mac")
        let health: JSONValue = .object(["version": .object(["protocol": .number(27)]), "instanceId": .string(notice.instanceId)])
        await manager.heard(.verified(SyncEngine.Computer(health: health, node: nil, owner: .null)), from: paired.id)
        let restored = AgentConnections(credentials: store, directory: directory, makeTransport: { _ in IdentityTransport() })
        await restored.setForeground(false)
        try await restored.restore()
        XCTAssertEqual(chosen(Self.standalone, in: restored), paired.id)
    }
}
