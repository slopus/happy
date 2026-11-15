#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A running happy-cluster's compute routes, reached with a bearer token.
/// Only the test runs it, never the app.
private struct LiveCluster: AgentTransport {
    let base: URL
    let token: String

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        var request = URLRequest(url: URL(string: path, relativeTo: base)!)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 15
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as! HTTPURLResponse
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { $0[String(describing: $1.key).lowercased()] = String(describing: $1.value) }
        return HTTP1Response(status: http.statusCode, headers: fields, body: data)
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

/// Settings › Compute against a live cluster, as its owner and as a member.
/// Skipped unless the run names one: `TEST_RUNNER_HAPPY_COMPUTE_LIVE_URL`,
/// `…_OWNER` and `…_MEMBER` (bearer tokens) on the xcodebuild command line.
/// It changes the cluster only where it says, and puts concurrency back.
@MainActor
final class HostedComputeLiveTests: XCTestCase {
    private var environment: [String: String] { ProcessInfo.processInfo.environment }

    private func rig(_ role: String) async throws -> (Session, AgentClient, String) {
        guard let url = environment["HAPPY_COMPUTE_LIVE_URL"].flatMap(URL.init(string:)), let token = environment["HAPPY_COMPUTE_LIVE_\(role)"] else {
            throw XCTSkip("No live cluster named")
        }
        let transport = LiveCluster(base: url, token: token)
        // The sync engine would read who the reader is from the profile; it
        // doesn't run here, so the sign-in carries it.
        let profile = try JSONValue.decode(try await transport.request(method: "GET", path: "/v0/profile", credential: "", body: nil, headers: [:]).body)
        let me = try XCTUnwrap(profile["profile"]?["userId"]?.stringValue)
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "compute-live",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in transport })
        await account.agentConnections.setForeground(false)
        let server = HappyCloud.server(named: "compute-live-\(role.lowercased())")
        let connection = try await account.agentConnections.addServer(AgentOrigin(server),
            signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: me),
            access: OAuthAccess(token: "test", expiresAt: nil), name: "Compute live")
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        addTeardownBlock { @MainActor [context] in
            _ = context
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        try await until { session.permissions != nil }
        return (session, AgentClient(transport: transport, token: "test"), me)
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

    private func until(_ condition: () -> Bool, seconds: Int = 10, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func settled(_ navigation: UINavigationController) async throws {
        try await until { navigation.transitionCoordinator == nil && navigation.presentedViewController?.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(400))
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

    private func named(_ name: String, in computers: [Computer]) throws -> Computer {
        try XCTUnwrap(computers.first { $0.name == name }, "\(name) isn't listed: \(computers.map(\.displayName))")
    }

    /// Mints a token through Add Computer: the install, or the server's
    /// refusal said in an alert.
    private func mint(_ page: ComputeViewController, _ navigation: UINavigationController, concurrency: Int?, name: String) async throws {
        try await until { page.shownRow("compute-add") != nil }
        page.tapRow("compute-add")
        let flow = try XCTUnwrap(page.adding)
        try await settled(navigation)
        if let concurrency { flow.setConcurrency(concurrency) }
        flow.create()
        try await until({
            if case .creating = flow.state { return false }
            return true
        }, seconds: 15)
        try await settled(flow.navigation)
        switch flow.state {
        case .shown(let install):
            print("\(name): access \(install.access) concurrency \(install.concurrency) commands \(install.commands == nil ? "null" : "set") platforms \(install.platforms) notice \(install.notice ?? "nil")")
            XCTAssertEqual(install.concurrency, concurrency ?? install.access.defaultConcurrency)
            let shown = try XCTUnwrap(flow.navigation.topViewController as? ComputeInstallViewController)
            print("\(name) rows \(shown.shownRowIDs) footer \(shown.shownFooters.last ?? "-")")
            try screenshot(shown, name: name)
        case .failed(_, let message):
            let top = try XCTUnwrap(flow.navigation.topViewController)
            try await until { top.presentedViewController is UIAlertController }
            let alert = try XCTUnwrap(top.presentedViewController as? UIAlertController)
            print("\(name) refused: \(alert.title ?? "-") / \(alert.message ?? "-")")
            XCTAssertEqual(alert.title, "No install command")
            XCTAssertEqual(alert.message, message)
            XCTAssertFalse(message.isEmpty)
            try await settled(flow.navigation)
            try screenshot(top, name: "\(name)-refused")
            alert.dismiss(animated: false)
        default:
            XCTFail("\(name): \(flow.state)")
        }
        flow.close()
        try await until { page.adding == nil && navigation.presentedViewController == nil }
    }

    private func print(_ line: String) { Swift.print("LIVE: \(line)") }

    func testAsOwner() async throws {
        let (session, client, me) = try await rig("OWNER")
        let computers = try await client.computers()
        print("owner reads \(computers.map { "\($0.displayName) \($0.status) \($0.agents.count)/\($0.concurrency) max \($0.maxConcurrency.map(String.init) ?? "nil") boundary \($0.boundary.available)" })")
        let linux = try named("e2e-linux", in: computers), noBoundary = try named("e2e-no-boundary", in: computers), full = try named("e2e-full", in: computers)

        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-\(full.id)") != nil }
        try await settled(navigation)
        print("list rows \(page.shownRowIDs)")
        for node in [linux, noBoundary, full] {
            print("\(node.displayName): \(page.shownRow("compute-node-\(node.id)")?.subtitle ?? "-") | \(page.shownRow("compute-node-\(node.id)")?.value ?? "-")")
        }
        for node in [linux, noBoundary, full] {
            XCTAssertEqual(page.shownRow("compute-node-\(node.id)")?.value, node.full ? "Full" : "Online", node.displayName)
        }
        XCTAssertTrue(page.shownRow("compute-node-\(noBoundary.id)")?.subtitle?.contains("Full access only") == true)
        try screenshot(page, name: "live-owner-list")

        let unbounded = ComputeViewController(session: session, page: .computer(noBoundary.id))
        navigation.pushViewController(unbounded, animated: false)
        try await until { unbounded.shownRow("compute-boundary") != nil }
        try await settled(navigation)
        print("boundary: \(unbounded.shownRow("compute-boundary")?.subtitle ?? "-")")
        XCTAssertEqual(unbounded.shownRow("compute-boundary")?.subtitle, noBoundary.boundary.reason)
        XCTAssertNotNil(unbounded.shownRow("compute-agent-e2eagent2")?.action, "the owner may remove it")
        try screenshot(unbounded, name: "live-owner-no-boundary")

        // Concurrency: one above the computer's maximum is refused, one in
        // range is saved and shown, then put back.
        let linuxPage = ComputeViewController(session: session, page: .computer(linux.id))
        navigation.pushViewController(linuxPage, animated: false)
        try await until { linuxPage.shownRow("compute-concurrency") != nil }
        try await settled(navigation)
        XCTAssertNotNil(linuxPage.shownRow("compute-concurrency")?.action)
        XCTAssertNotNil(linuxPage.shownRow("compute-host-cpu"), "an owner reads host facts")
        let most = linux.concurrencyRange.upperBound
        print("e2e-linux concurrency range \(linux.concurrencyRange)")
        do {
            _ = try await client.setComputerConcurrency(linux.id, most + 1)
            XCTFail("\(most + 1) was taken")
        } catch AgentClientError.status(let status, _, let message) {
            print("concurrency \(most + 1): \(status) \(message ?? "-")")
            XCTAssertEqual(status, 400)
        }
        guard case .computer(let shown)? = linuxPage.monitor.snapshot else { return XCTFail("no computer") }
        linuxPage.setConcurrency(3, of: shown)
        try await until { linuxPage.shownRow("compute-concurrency")?.value == "3" }
        try screenshot(linuxPage, name: "live-owner-concurrency-3")
        // The cluster's fixture value, whatever was read.
        let back = try await client.setComputerConcurrency(linux.id, 2)
        XCTAssertEqual(back.concurrency, 2)

        // Private computers: the owner's own, with its concurrency theirs to set.
        let privateLinux = try named("private-linux", in: computers), privateNoBoundary = try named("private-no-boundary", in: computers),
            privateFull = try named("private-full", in: computers)
        navigation.popToRootViewController(animated: false)
        try await settled(navigation)
        for node in [privateLinux, privateNoBoundary, privateFull] {
            print("\(node.displayName) owner \(node.owner ?? "nil") (me \(me)): \(page.shownRow("compute-node-\(node.id)")?.subtitle ?? "-") | \(page.shownRow("compute-node-\(node.id)")?.value ?? "-")")
            XCTAssertTrue(page.shownRow("compute-node-\(node.id)")?.subtitle?.hasPrefix("Private · Yours · ") == true)
        }
        XCTAssertEqual(page.shownRow("compute-node-\(privateFull.id)")?.value, privateFull.full ? "Full" : "Online")
        XCTAssertTrue(page.shownRow("compute-node-\(privateNoBoundary.id)")?.subtitle?.contains("Full access only") == true)
        page.scroll.setContentOffset(CGPoint(x: 0, y: max(0, page.scroll.contentSize.height - page.scroll.bounds.height)), animated: false)
        try screenshot(page, name: "live-owner-list-private")
        page.scroll.setContentOffset(.zero, animated: false)
        let privatePage = ComputeViewController(session: session, page: .computer(privateLinux.id))
        navigation.pushViewController(privatePage, animated: false)
        try await until { privatePage.shownRow("compute-concurrency") != nil }
        try await settled(navigation)
        guard case .computer(let mine)? = privatePage.monitor.snapshot else { return XCTFail("no computer") }
        privatePage.setConcurrency(3, of: mine)
        try await until { privatePage.shownRow("compute-concurrency")?.value == "3" }
        try screenshot(privatePage, name: "live-owner-private-concurrency-3")
        _ = try await client.setComputerConcurrency(privateLinux.id, 2)
        let unboundedPrivate = ComputeViewController(session: session, page: .computer(privateNoBoundary.id))
        navigation.pushViewController(unboundedPrivate, animated: false)
        try await until { unboundedPrivate.shownRow("compute-boundary") != nil }
        try await settled(navigation)
        try screenshot(unboundedPrivate, name: "live-owner-private-no-boundary")
        let approvals = try await client.computerApprovals()
        print("approvals waiting: \(approvals.map(\.id))")

        // A shared token with a chosen concurrency.
        navigation.popToRootViewController(animated: false)
        try await settled(navigation)
        if environment["HAPPY_COMPUTE_LIVE_MINT"] == "1" { try await mint(page, navigation, concurrency: 4, name: "live-owner-install-shared") }

        // The owner of a private computer takes an agent off it: e2eagent6
        // from private-full, if it is still there.
        guard environment["HAPPY_COMPUTE_LIVE_REMOVE"] == "1", privateFull.agents.contains(where: { $0.id == "e2eagent6" }) else {
            return print("nothing removed")
        }
        let fullPage = ComputeViewController(session: session, page: .computer(privateFull.id))
        navigation.pushViewController(fullPage, animated: false)
        try await until { fullPage.shownRow("compute-agent-e2eagent6") != nil }
        try await settled(navigation)
        XCTAssertNotNil(fullPage.shownRow("compute-agent-e2eagent6")?.action)
        try screenshot(fullPage, name: "live-owner-private-full")
        guard case .computer(let fullNode)? = fullPage.monitor.snapshot else { return XCTFail("no computer") }
        fullPage.remove(fullNode.agents.first { $0.id == "e2eagent6" }!, from: fullNode)
        try await until({ fullPage.shownRow("compute-agent-e2eagent6") == nil }, seconds: 15)
        print("removed e2eagent6 from private-full; status now \(fullPage.shownRow("compute-node-\(privateFull.id)")?.value ?? "-")")
        XCTAssertEqual(fullPage.shownRow("compute-node-\(privateFull.id)")?.value, "Online")
        try screenshot(fullPage, name: "live-owner-agent-removed")
    }

    func testAsMember() async throws {
        let (session, client, _) = try await rig("MEMBER")
        let computers = try await client.computers()
        print("member reads \(computers.map { "\($0.displayName) \($0.agents.map { "\($0.id):\($0.title ?? "nil")" }) host \($0.host != nil)" })")
        let linux = try named("e2e-linux", in: computers)

        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-\(linux.id)") != nil }
        try await settled(navigation)
        print("member footer \(page.shownFooters.last ?? "-")")
        try screenshot(page, name: "live-member-list")

        let linuxPage = ComputeViewController(session: session, page: .computer(linux.id))
        navigation.pushViewController(linuxPage, animated: false)
        try await until { linuxPage.shownRow("compute-concurrency") != nil }
        try await settled(navigation)
        XCTAssertNil(linuxPage.shownRow("compute-concurrency")?.action, "a member changes no shared computer")
        XCTAssertNil(linuxPage.shownRow("compute-host-cpu"))
        for agent in linux.agents { XCTAssertNil(linuxPage.shownRow("compute-agent-\(agent.id)")?.action) }
        try screenshot(linuxPage, name: "live-member-computer")
        do {
            _ = try await client.setComputerConcurrency(linux.id, linux.concurrency)
            XCTFail("a member's PATCH was taken")
        } catch AgentClientError.status(let status, _, let message) {
            print("member PATCH: \(status) \(message ?? "-")")
            XCTAssertEqual(status, 403)
        }

        XCTAssertFalse(computers.contains { $0.access == .private }, "a member sees no one else's private computer")
        navigation.popToRootViewController(animated: false)
        try await settled(navigation)
        if environment["HAPPY_COMPUTE_LIVE_MINT"] == "1" { try await mint(page, navigation, concurrency: nil, name: "live-member-install-private") }
    }
}
#endif
