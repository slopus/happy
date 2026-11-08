#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private actor MonitoringTransport: AgentTransport {
    private var granted: [String]
    private var forbidden = false
    init(granted: [String]) { self.granted = granted }
    func deny() { forbidden = true }
    func setPermissions(_ granted: [String]) { self.granted = granted }
    private let pool = #"{"id":"default","name":"Default","kind":"shared","default":true,"nodeCounts":{"total":2,"online":1,"offline":0,"draining":0,"enrolling":0,"revoked":1},"sandboxCapacity":{"used":3,"total":null}}"#
    private func node(_ id: String, status: String) -> String {
        #"{"id":"\#(id)","pool":"default","name":null,"hostname":"\#(id)","status":"\#(status)","version":"linux.9","lastSeenAt":null,"sandboxCapacity":{"used":3,"total":null},"host":null,"activeSandboxes":[{"sandboxId":"sandbox-1","agentId":"agent-1","agentTitle":null}]}"#
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path == "/v0/permissions" {
            return HTTP1Response(status: 200, body: try JSONEncoder().encode(["granted": granted]))
        }
        guard path.hasPrefix("/v0/compute/") else { return HTTP1Response(status: 404) }
        guard method == "GET" else { return HTTP1Response(status: 405) }
        if forbidden {
            return HTTP1Response(status: 403, headers: ["content-type": "application/json"],
                body: Data(#"{"code":"forbidden","error":"This needs the pools.manage permission."}"#.utf8))
        }
        let json: String
        switch path {
        case "/v0/compute/pools": json = "{\"pools\":[\(pool)]}"
        case "/v0/compute/pools/default": json = "{\"pool\":\(pool),\"nodes\":[\(node("worker", status: "online")),\(node("old-worker", status: "revoked"))]}"
        case "/v0/compute/nodes/worker": json = "{\"node\":\(node("worker", status: "online"))}"
        default: return HTTP1Response(status: 404)
        }
        return HTTP1Response(status: 200, body: Data(json.utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class HostedComputeMonitoringTests: XCTestCase {
    private func rig(granted: [String] = ["pools.manage"], variant: AppVariant = .preview) async throws -> (AppContext, Session, MonitoringTransport) {
        let transport = MonitoringTransport(granted: granted)
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "compute-test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport })
        await account.agentConnections.setForeground(false)
        let server = HappyCloud.server(named: "compute-test")
        let connection = try await account.agentConnections.addServer(AgentOrigin(server),
            signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: "me"),
            access: OAuthAccess(token: "test", expiresAt: nil), name: "Compute test")
        let context = AppContext(account: account, variant: variant, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        addTeardownBlock { @MainActor [context] in
            _ = context // Session intentionally holds its app context weakly.
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        try await until { session.permissions != nil }
        return (context, session, transport)
    }

    private func host(_ controller: UIViewController) async throws -> UINavigationController {
        let navigation = UINavigationController(rootViewController: controller)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        window.layoutIfNeeded()
        return navigation
    }

    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    private func screenshot(_ controller: UIViewController, name: String) throws {
        let window = try XCTUnwrap(controller.view.window)
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testEntryRequiresMonitoringPermissionAndDeepLinkStaysNative() async throws {
        let (context, session, _) = try await rig()
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNotNil(settings.shownRow("computes"))
        SettingsLinks.open(.computes, session: session, from: settings)
        try await until { navigation.topViewController is ComputeViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? ComputeViewController)
        try await until { page.shownRow("compute-pool-default") != nil }
    }

    func testComputeUseDoesNotShowMonitoring() async throws {
        let (context, session, _) = try await rig(granted: ["compute.use"])
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNil(settings.shownRow("computes"))
        SettingsLinks.open(.computes, session: session, from: settings)
        XCTAssertTrue(navigation.topViewController === settings)
    }

    func testProductionKeepsCloudMonitoringOff() async throws {
        let (context, session, _) = try await rig(variant: .production)
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNil(settings.shownRow("computes"))
        SettingsLinks.open(.computes, session: session, from: settings)
        XCTAssertTrue(navigation.topViewController === settings)
    }

    func testRevokedNodesStartCollapsedAndUnknownFactsStayUnknown() async throws {
        let (_, session, _) = try await rig()
        let page = ComputeViewController(session: session, page: .pool("default"))
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-worker") != nil }
        XCTAssertEqual(page.shownRow("compute-capacity")?.value, "3 sandboxes")
        XCTAssertNil(page.shownRow("compute-node-old-worker"))
        XCTAssertEqual(page.shownRow("compute-revoked-toggle")?.title, "1 revoked")
        try screenshot(page, name: "Compute pool — revoked collapsed")
        page.tapRow("compute-revoked-toggle")
        XCTAssertNotNil(page.shownRow("compute-node-old-worker"))
        page.tapRow("compute-revoked-toggle")
        XCTAssertNil(page.shownRow("compute-node-old-worker"))
        page.tapRow("compute-node-worker")
        try await until { navigation.topViewController !== page && navigation.transitionCoordinator == nil }
        let node = try XCTUnwrap(navigation.topViewController as? ComputeViewController)
        try await until { node.shownRow("compute-host-cpu") != nil }
        XCTAssertEqual(node.shownRow("compute-host-cpu")?.value, "Unknown")
        XCTAssertEqual(node.shownRow("compute-host-memory")?.value, "Unknown")
        XCTAssertEqual(node.shownRow("compute-host-disk")?.value, "Unknown")
        XCTAssertEqual(node.shownRow("compute-os")?.value, "Unknown")
        XCTAssertEqual(node.shownRow("compute-placement-sandbox-1")?.title, "agent-1")
        XCTAssertFalse(node.shownRowIDs.joined().contains { $0.contains("drain") || $0.contains("attach") || $0.contains("join") })
        try screenshot(node, name: "Compute machine — unknown host facts")
    }

    func testForbiddenResponseRemovesProtectedRows() async throws {
        let (_, session, transport) = try await rig()
        let page = ComputeViewController(session: session)
        _ = try await host(page)
        try await until { page.shownRow("compute-pool-default") != nil }
        await transport.deny()
        page.monitor.refresh()
        await page.monitor.reading?.value
        XCTAssertNil(page.shownRow("compute-pool-default"))
        XCTAssertEqual(page.monitor.failure, .forbidden)
    }

    func testPermissionRefreshRemovesTheSettingsAndSearchEntries() async throws {
        let (context, session, transport) = try await rig()
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNotNil(settings.shownRow("computes"))
        let home = HomeViewController(context: context, computer: session.accountID)
        navigation.setViewControllers([home], animated: false)
        home.loadViewIfNeeded()
        home.beginSearch()
        home.search("Compute pools")
        let results = try XCTUnwrap(home.view.subviews.compactMap { $0 as? HomeSearchResultsView }.first)
        XCTAssertTrue(results.list.shownRows.contains { $0.id == "search:settings:computes" })
        await transport.setPermissions(["compute.use"])
        session.refreshPermissions()
        try await until { !session.gate.allows(.poolsManage) }
        XCTAssertFalse(results.list.shownRows.contains { $0.id == "search:settings:computes" })
        XCTAssertNil(settings.shownRow("computes"))
    }

    func testRepeatedAppearanceOwnsExactlyOneEventSubscription() async throws {
        let (_, session, _) = try await rig()
        let page = ComputeViewController(session: session)
        _ = try await host(page)
        try await until { page.shownRow("compute-pool-default") != nil }
        var tasks: [Task<Void, Never>] = []
        defer { tasks.forEach { $0.cancel() } }
        for _ in 0..<3 {
            let previous = try XCTUnwrap(page.events)
            tasks.append(previous)
            // A cancelled interactive back swipe can announce another
            // appearance without a preceding viewDidDisappear.
            page.viewWillAppear(false)
            XCTAssertTrue(previous.isCancelled)
            if previous.isCancelled { await previous.value }
            let deadline = ContinuousClock.now + .seconds(3)
            while await session.store.eventListenerCount(matching: ComputeMonitor.refreshEvents) != 1, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            let active = await session.store.eventListenerCount(matching: ComputeMonitor.refreshEvents)
            XCTAssertEqual(active, 1)
        }
        let last = try XCTUnwrap(page.events)
        tasks.append(last)
        page.viewDidDisappear(false)
        await last.value
        let deadline = ContinuousClock.now + .seconds(3)
        while await session.store.eventListenerCount(matching: ComputeMonitor.refreshEvents) != 0, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        let hidden = await session.store.eventListenerCount(matching: ComputeMonitor.refreshEvents)
        XCTAssertEqual(hidden, 0)
    }
}
#endif