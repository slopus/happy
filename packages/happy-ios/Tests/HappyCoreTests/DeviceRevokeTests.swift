import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// An agent that answers `DELETE /v0/mobile-connector/device` with what the
/// test says, or can't be reached at all; everything else is a 404.
private final class RevokingAgent: AgentTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [Int] = []
    private var reachable = true
    private var deletes: [String] = []
    /// The tokens each DELETE carried, in order.
    var revoked: [String] { lock.withLock { deletes } }

    func answer(_ statuses: Int...) { lock.withLock { self.statuses = statuses } }
    func setReachable(_ value: Bool) { lock.withLock { reachable = value } }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let status: Int? = try lock.withLock {
            guard reachable else { throw URLError(.cannotConnectToHost) }
            guard method == "DELETE", path == DeviceRevokeQueue.path else { return nil }
            deletes.append(credential)
            return statuses.isEmpty ? 200 : statuses.removeFirst()
        }
        return HTTP1Response(status: status ?? 404, body: Data(status == 200 ? "{}".utf8 : #"{"error":"no","code":"x"}"#.utf8))
    }

    func close() async {}
}

final class DeviceRevokeQueueTests: XCTestCase {
    private func credentials(_ token: String) -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tc", port: 1, deviceID: "d-\(token)", deviceToken: token)
    }

    private func queue(_ agent: RevokingAgent, store: any DeviceRevokeStore = InMemoryDeviceRevokeStore(),
                       inUse: @escaping @Sendable (String) async -> Bool = { _ in false }) async -> DeviceRevokeQueue {
        let queue = DeviceRevokeQueue(store: store, makeTransport: { _ in agent }, inUse: inUse)
        await queue.setBackoff(Backoff(initial: .milliseconds(5), maximum: .milliseconds(20)))
        return queue
    }

    /// Gone (200), already gone (401), and a daemon from before the route
    /// (403) all end it; a 5xx or no answer is tried again.
    func testItIsSentUntilTheAgentAnswersForGood() async throws {
        let agent = RevokingAgent()
        agent.answer(503, 408, 200)
        let queue = await queue(agent)
        try await queue.enqueue(credentials("old"), id: "a")
        await queue.waitUntilEmpty()
        XCTAssertEqual(agent.revoked, ["old", "old", "old"])

        for status in [401, 403, 404] {
            agent.answer(status)
            try await queue.enqueue(credentials("t\(status)"), id: "s\(status)")
            await queue.waitUntilEmpty()
            let waiting = await queue.waiting
            XCTAssertTrue(waiting.isEmpty, "\(status) left it waiting")
        }
        XCTAssertTrue(DeviceRevokeQueue.final(401) && DeviceRevokeQueue.final(403) && DeviceRevokeQueue.final(204))
        XCTAssertFalse(DeviceRevokeQueue.final(500) || DeviceRevokeQueue.final(429) || DeviceRevokeQueue.final(408))
    }

    /// Out of reach, it waits, across a relaunch, and goes once the agent
    /// can be reached.
    func testAnUnreachableAgentIsTriedAgainAfterARelaunch() async throws {
        let agent = RevokingAgent()
        agent.setReachable(false)
        let store = InMemoryDeviceRevokeStore()
        let first = await queue(agent, store: store)
        try await first.enqueue(credentials("old"), id: "a")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(try store.all()["a"]?.credentials.deviceToken, "old")

        agent.setReachable(true)
        let relaunched = await queue(agent, store: store)
        await relaunched.resume()
        await relaunched.waitUntilEmpty()
        // The first launch's queue is still retrying here too: a second DELETE would be a 401.
        XCTAssertEqual(Set(agent.revoked), ["old"])
        XCTAssertTrue(try store.all().isEmpty)
        _ = first
    }

    /// A token a connection here holds now is never revoked, and a
    /// connection without a device token (a team server's) has none to revoke.
    func testATokenInUseOrASignInIsNeverSent() async throws {
        let agent = RevokingAgent()
        let queue = await queue(agent) { $0 == "mine" }
        try await queue.enqueue(credentials("mine"), id: "a")
        await queue.waitUntilEmpty()
        XCTAssertEqual(agent.revoked, [])

        try await queue.enqueue(AgentConnectionCredentials(address: "", port: 0, deviceID: "", deviceToken: ""), id: "server")
        let waiting = await queue.waiting
        XCTAssertTrue(waiting.isEmpty)
    }
}

@MainActor
final class DeviceRevokeDisconnectTests: XCTestCase {
    private func launch(_ agent: RevokingAgent, revokes: InMemoryDeviceRevokeStore) -> AccountController {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in agent },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FakeHTTP(), connector: FakeConnector(), deviceRevokeStore: revokes)
        return account
    }

    private func agent(_ token: String) -> AgentConnectionCredentials {
        AgentConnectionCredentials(address: "tc", port: 1, deviceID: "d-\(token)", deviceToken: token)
    }

    /// Disconnect removes the phone's device from the agent with that
    /// pairing's own token.
    func testDisconnectRevokesTheDevice() async throws {
        let computer = RevokingAgent()
        let account = launch(computer, revokes: InMemoryDeviceRevokeStore())
        await account.restore()
        try await account.addAgentConnection(agent("first"), name: "Mac")
        let id = try XCTUnwrap(account.agentConnections.activeID)
        try await account.beginSignOut(accountID: id).value
        await account.deviceRevokes.waitUntilEmpty()
        XCTAssertEqual(computer.revoked, ["first"])
    }

    /// Disconnected while the agent couldn't be reached, then paired with it
    /// again: the old device goes with the old token as the agent is reached,
    /// and the new pairing's token is never sent.
    func testPairingAgainRevokesTheOldDeviceOnly() async throws {
        let computer = RevokingAgent()
        let revokes = InMemoryDeviceRevokeStore()
        let account = launch(computer, revokes: revokes)
        await account.restore()
        try await account.addAgentConnection(agent("first"), name: "Mac")
        let id = try XCTUnwrap(account.agentConnections.activeID)
        computer.setReachable(false)
        try await account.beginSignOut(accountID: id).value
        XCTAssertEqual(try revokes.all()[id]?.credentials.deviceToken, "first")

        computer.setReachable(true)
        try await account.addAgentConnection(agent("second"), name: "Mac")
        await account.deviceRevokes.waitUntilEmpty()
        XCTAssertEqual(Set(computer.revoked), ["first"])
        XCTAssertEqual(account.agentConnections.accounts.count, 1)
    }
}
