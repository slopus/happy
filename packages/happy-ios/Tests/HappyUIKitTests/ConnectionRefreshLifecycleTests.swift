#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private actor DelayedConnectionPath {
    private(set) var count = 0
    private var waiting: [Int: CheckedContinuation<TunnelPath?, Never>] = [:]
    private var closed = false

    func read() async -> TunnelPath? {
        guard !closed else { return nil }
        let id = count
        count += 1
        return await withCheckedContinuation { waiting[id] = $0 }
    }

    func release(_ id: Int, path: TunnelPath = .relayed) {
        waiting.removeValue(forKey: id)?.resume(returning: path)
    }

    func releaseAll() {
        closed = true
        let held = waiting.values
        waiting = [:]
        held.forEach { $0.resume(returning: nil) }
    }
}

private struct RefreshOffline: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { HTTP1Response(status: 404) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class ConnectionRefreshLifecycleTests: XCTestCase {
    private func rig() async throws -> (ConnectionViewController, DelayedConnectionPath) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "refresh-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in RefreshOffline() })
        await account.agentConnections.setForeground(false)
        let credentials = try JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"refresh-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"test"}"#.utf8))
        let connection = try await account.agentConnections.add(credentials, name: "Refresh test")
        let metrics = try XCTUnwrap(account.agentConnections.metrics(for: connection.id))
        let delayed = DelayedConnectionPath()
        let tunnel = UUID()
        metrics.tunnelUp(tunnel, info: TunnelInfo(regionID: 1, regionCode: "test", regionName: "Test", relayHost: "relay.example", nodeKey: "test", port: 1)) {
            await delayed.read()
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let page = ConnectionViewController(context: context, source: .agent(id: connection.id))
        page.loadViewIfNeeded()
        addTeardownBlock { @MainActor in
            page.viewDidDisappear(false)
            await delayed.releaseAll()
            metrics.tunnelDown(tunnel)
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        return (page, delayed)
    }

    private func waitForRead(_ count: Int, _ delayed: DelayedConnectionPath) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while await delayed.count < count, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        let actual = await delayed.count
        XCTAssertEqual(actual, count)
    }

    func testASnapshotThatFinishesAfterHideNeverRebuilds() async throws {
        let (page, delayed) = try await rig()
        page.viewWillAppear(false)
        try await waitForRead(1, delayed)
        let reading = try XCTUnwrap(page.refreshTask)
        let before = page.page
        page.viewDidDisappear(false)
        XCTAssertFalse(page.isTicking)
        XCTAssertTrue(reading.isCancelled, "hiding cancels the in-flight refresh")
        await delayed.release(0)
        await reading.value
        XCTAssertEqual(page.refreshes, 0, "a late snapshot counted while hidden")
        XCTAssertEqual(page.page, before, "a late snapshot rebuilt the hidden page")
    }

    func testAnOldSnapshotCannotReplaceANewAppearancesRead() async throws {
        let (page, delayed) = try await rig()
        page.viewWillAppear(false)
        try await waitForRead(1, delayed)
        let old = try XCTUnwrap(page.refreshTask)
        page.viewDidDisappear(false)
        page.viewWillAppear(false)
        try await waitForRead(2, delayed)
        let current = try XCTUnwrap(page.refreshTask)
        await delayed.release(0)
        await old.value
        XCTAssertEqual(page.refreshes, 0, "the old appearance supplied the new page")
        XCTAssertFalse(current.isCancelled)
        await delayed.release(1, path: .direct(endpoint: "192.0.2.1:1"))
        await current.value
        XCTAssertEqual(page.refreshes, 1)
    }
}
#endif