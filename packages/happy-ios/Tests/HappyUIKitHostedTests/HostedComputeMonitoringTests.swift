#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Cloud server's compute routes over fixture computers: one in each
/// mode, the reader's own private one, and a member's agent asking to join it.
private actor ComputeServer: AgentTransport {
    private var granted: [String]
    private var forbidden = false
    private(set) var requests: [(method: String, path: String, body: JSONValue?)] = []
    private let descriptions: [String: String] = [
        "gpu-01": "GPU box, CUDA 12.4, use for training. Repo checkouts under /data.",
        "team-box": "Shared build box with Docker and Node 22.",
        "build-01": "Mac mini for iOS builds; Xcode 26 is installed.",
        "kirills-mbp": "My laptop. Repos under ~/src.",
    ]
    private var held = true
    private var approvals = [#"{"computerId":"kirills-mbp","computerName":"kirills-mbp","agentId":"agent-9","agentTitle":"Refactor the sync engine","createdAt":\#(Date().timeIntervalSince1970 * 1000 - 120_000)}"#]

    init(granted: [String]) { self.granted = granted }
    func deny() { forbidden = true }
    func setPermissions(_ granted: [String]) { self.granted = granted }

    private var manager: Bool { granted.contains("pools.manage") }

    private func node(_ id: String, name: String? = nil, status: String = "online", os: String, arch: String, mode: String, owner: String? = nil, holder: String? = nil) -> String {
        let quoted = { (value: String?) in value.map { "\"\($0)\"" } ?? "null" }
        let description = descriptions[id].map { "\"\($0)\"" } ?? "null"
        var json = #"{"id":"\#(id)","name":\#(quoted(name)),"hostname":"\#(id)","status":"\#(status)","os":"\#(os)","arch":"\#(arch)","version":"0.1.0-\#(os).4","lastSeenAt":1762900000000,"since":1762800000000,"mode":"\#(mode)","description":\#(description),"owner":\#(quoted(owner)),"exclusiveAgent":\#(holder.map { #"{"id":"agent-7","title":"\#($0)"}"# } ?? "null")"#
        if manager { json += #","sandboxCapacity":{"used":1,"total":4},"host":{"cpuCores":16,"totalMemoryBytes":68719476736,"totalDiskBytes":null},"activeSandboxes":[]"# }
        return json + "}"
    }

    private var computers: [String] {
        var computers = [
            node("gpu-01", os: "linux", arch: "x86_64", mode: "sandbox"),
            node("team-box", os: "linux", arch: "aarch64", mode: "shared"),
            node("build-01", os: "macos", arch: "arm64", mode: "exclusive", holder: held ? "Fix flaky login test" : nil),
            node("kirills-mbp", os: "macos", arch: "arm64", mode: "private", owner: "me"),
        ]
        // Another member's private computer shows only to a manager.
        if manager { computers.append(node("alex-pc", status: "offline", os: "windows", arch: "x86_64", mode: "private", owner: "user-alex")) }
        return computers
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let sent = body.flatMap { try? JSONValue.decode($0) }
        requests.append((method, path, sent))
        if path == "/v0/permissions" { return ok(try JSONEncoder().encode(["granted": granted])) }
        if path.hasPrefix("/v0/users") { return ok(#"{"users":[{"id":"user-alex","name":"Alex"}]}"#) }
        // Only `/v0/computers`: the old node, pool and approval routes are 404 here.
        guard path == "/v0/computers" || path.hasPrefix("/v0/computers/") else { return HTTP1Response(status: 404) }
        if forbidden {
            return HTTP1Response(status: 403, headers: ["content-type": "application/json"],
                body: Data(#"{"code":"forbidden","error":"This needs the compute.use permission."}"#.utf8))
        }
        let parts = path.split(separator: "/").map(String.init).dropFirst(2)
        func computer(_ id: String) -> String? { computers.first { $0.contains(#""id":"\#(id)""#) } }
        switch (method, Array(parts)) {
        case ("GET", []): return ok("{\"computers\":[\(computers.joined(separator: ","))]}")
        case ("GET", ["approvals"]): return ok("{\"approvals\":[\(approvals.joined(separator: ","))]}")
        case ("GET", let id) where id.count == 1: return computer(id[0]).map { ok("{\"computer\":\($0)}") } ?? HTTP1Response(status: 404)
        case ("POST", let answer) where answer.count == 3 && answer[0] == "approvals":
            approvals.removeAll { $0.contains(#""agentId":"\#(answer[2])""#) }
            return ok(#"{"approval":{"computerId":"\#(answer[1])","agentId":"\#(answer[2])","requestedBy":"me","state":"approved","createdAt":1,"decidedAt":2}}"#)
        case ("POST", ["join-tokens"]):
            let mode = sent?["mode"]?.stringValue ?? ""
            let sudo = mode == "private" ? "" : "sudo "
            return ok(#"{"mode":"\#(mode)","token":"hjt_7Kq2xV","expiresAt":\#(Date().timeIntervalSince1970 * 1000 + 3_600_000),"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get.happy-clusters.com/install.sh | \#(sudo)HAPPY_CLUSTER_URL='https://acme.happy-clusters.com' HAPPY_JOIN_TOKEN='hjt_7Kq2xV' HAPPY_COMPUTE_MODE='\#(mode)' sh","windows":"$env:HAPPY_CLUSTER_URL='https://acme.happy-clusters.com'; $env:HAPPY_JOIN_TOKEN='hjt_7Kq2xV'; $env:HAPPY_COMPUTE_MODE='\#(mode)'; irm https://get.happy-clusters.com/install.ps1 | iex"}}"#)
        case ("POST", let id) where id.count == 2 && id[1] == "release-lock":
            held = false
            return ok(#"{"previousHolder":"agent-7"}"#)
        default: return HTTP1Response(status: 404)
        }
    }

    private func ok(_ json: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(json.utf8)) }
    private func ok(_ data: Data) -> HTTP1Response { HTTP1Response(status: 200, body: data) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.notConnectedToInternet) }
    func reset() async {}
    func close() async {}
}

@MainActor
final class HostedComputeMonitoringTests: XCTestCase {
    private static let member = ["compute.use"]
    private static let manager = ["compute.use", "pools.manage"]

    private func rig(granted: [String] = manager, variant: AppVariant = .preview) async throws -> (AppContext, Session, ComputeServer) {
        let transport = ComputeServer(granted: granted)
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

    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    /// Settled: no push, pop or sheet still moving.
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

    func testEntryNeedsComputeUseAndDeepLinkStaysNative() async throws {
        let (context, session, _) = try await rig(granted: Self.member)
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNotNil(settings.shownRow("computes"))
        XCTAssertEqual(settings.shownRowIDs.first { $0.contains("computes") }, ["agents", "providers", "computes", "usage"], "Compute follows Inference in Agents, Usage closes it: \(settings.shownRowIDs)")
        SettingsLinks.open(.computes, session: session, from: settings)
        try await until { navigation.topViewController is ComputeViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? ComputeViewController)
        try await until { page.shownRow("compute-node-gpu-01") != nil }
    }

    func testWithoutComputeUseThereIsNoEntry() async throws {
        let (context, session, _) = try await rig(granted: ["pools.manage"])
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNil(settings.shownRow("computes"))
        SettingsLinks.open(.computes, session: session, from: settings)
        XCTAssertTrue(navigation.topViewController === settings)
    }

    func testProductionKeepsCloudComputeOff() async throws {
        let (context, session, _) = try await rig(variant: .production)
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNil(settings.shownRow("computes"))
        SettingsLinks.open(.computes, session: session, from: settings)
        XCTAssertTrue(navigation.topViewController === settings)
    }

    /// One flat list, online first: each computer's mode, who holds or owns
    /// it, where it runs and what agents read about it.
    func testTheListShowsEveryModeWithItsHolderOwnerAndDescription() async throws {
        let (_, session, server) = try await rig()
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-alex-pc")?.subtitle?.contains("Alex’s") == true }
        try await settled(navigation)
        let computers = try XCTUnwrap(page.shownRowIDs.last)
        XCTAssertEqual(computers, ["compute-node-build-01", "compute-node-gpu-01", "compute-node-kirills-mbp", "compute-node-team-box", "compute-node-alex-pc", "compute-add"])
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.subtitle, "Sandbox · Linux x86_64\nGPU box, CUDA 12.4, use for training. Repo checkouts under /data.")
        XCTAssertEqual(page.shownRow("compute-node-team-box")?.subtitle, "Shared · Linux aarch64\nShared build box with Docker and Node 22.")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.subtitle, "Exclusive · Held by Fix flaky login test · macOS arm64\nMac mini for iOS builds; Xcode 26 is installed.")
        XCTAssertEqual(page.shownRow("compute-node-kirills-mbp")?.subtitle, "Private · Yours · macOS arm64\nMy laptop. Repos under ~/src.")
        XCTAssertEqual(page.shownRow("compute-node-alex-pc")?.subtitle, "Private · Alex’s · Windows x86_64")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "In use")
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.value, "Online")
        XCTAssertEqual(page.shownRow("compute-node-alex-pc")?.value, "Offline")
        // A manager may only free the held one; nothing is edited here.
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.menu.map(\.title), ["Release"])
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.menu.map(\.title), [])
        XCTAssertEqual(page.shownHeaders, ["JOIN REQUESTS", "COMPUTERS"])
        let paths = await server.requests.map(\.path)
        XCTAssertEqual(Set(paths.filter { $0.hasPrefix("/v0/comput") }), ["/v0/computers", "/v0/computers/approvals"], "nothing under /v0/compute/")
        try screenshot(page, name: "compute-list-manager")
    }

    /// A member sees the team's computers without their monitoring facts,
    /// and edits or frees none of them, their own included.
    func testAMemberSeesComputersWithoutActions() async throws {
        let (_, session, _) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-kirills-mbp") != nil }
        try await settled(navigation)
        XCTAssertNil(page.shownRow("compute-node-alex-pc"))
        XCTAssertEqual(page.shownRow("compute-node-kirills-mbp")?.menu.map(\.title), [])
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.menu.map(\.title), [])
        XCTAssertEqual(page.shownFooters.last, "Agents choose a computer and join it. You can add a private computer of your own.")
        try screenshot(page, name: "compute-list-member")
    }

    func testJoinRequestsAreApprovedOrDeniedInPlace() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-request-kirills-mbp/agent-9") != nil }
        try await settled(navigation)
        XCTAssertEqual(page.shownRowIDs.first, ["compute-request-kirills-mbp/agent-9", "compute-approve-kirills-mbp/agent-9", "compute-deny-kirills-mbp/agent-9"])
        XCTAssertEqual(page.shownRow("compute-request-kirills-mbp/agent-9")?.title, "Refactor the sync engine")
        XCTAssertEqual(page.shownRow("compute-request-kirills-mbp/agent-9")?.subtitle, "Wants to join kirills-mbp · 2 min ago")
        try screenshot(page, name: "compute-join-requests")
        page.tapRow("compute-approve-kirills-mbp/agent-9")
        XCTAssertNil(page.shownRow("compute-deny-kirills-mbp/agent-9")?.action, "one answer at a time")
        try await until { page.shownRow("compute-request-kirills-mbp/agent-9") == nil }
        let answer = await server.requests.first { $0.method == "POST" && $0.path.hasPrefix("/v0/computers/approvals/") }
        XCTAssertEqual(answer?.path, "/v0/computers/approvals/kirills-mbp/agent-9")
        XCTAssertEqual(answer?.body, .object(["approve": .bool(true)]))
    }

    /// A member adds only a private computer: the other modes are there,
    /// greyed out; the install has a command for every system and no sudo.
    func testAMembersAddFlowMakesAPrivateComputer() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-add") != nil }
        page.tapRow("compute-add")
        let flow = try XCTUnwrap(page.adding)
        try await settled(navigation)
        let modes = try XCTUnwrap(flow.navigation.topViewController as? ComputeModesViewController)
        XCTAssertEqual(modes.shownRowIDs, [["compute-mode-sandbox"], ["compute-mode-shared"], ["compute-mode-exclusive"], ["compute-mode-private"]])
        XCTAssertEqual(modes.shownRow("compute-mode-sandbox")?.value, "Admin only")
        XCTAssertNil(modes.shownRow("compute-mode-sandbox")?.action)
        XCTAssertNotNil(modes.shownRow("compute-mode-private")?.valueView, "private is chosen")
        try screenshot(modes, name: "compute-add-member-modes")
        modes.tapRow("compute-mode-sandbox")
        XCTAssertEqual(flow.state, .choosing(ComputerDraft(mode: .private)))
        XCTAssertEqual(modes.navigationItem.rightBarButtonItem?.accessibilityIdentifier, "compute-create", "the mode is the only step before the install")

        flow.create()
        try await until { flow.navigation.topViewController is ComputeInstallViewController }
        try await settled(flow.navigation)
        let install = try XCTUnwrap(flow.navigation.topViewController as? ComputeInstallViewController)
        XCTAssertEqual(install.shownRowIDs, [["compute-command-unix", "compute-copy-unix"], ["compute-command-windows", "compute-copy-windows"]])
        XCTAssertEqual(install.shownHeaders, ["MACOS AND LINUX", "WINDOWS (POWERSHELL)"])
        XCTAssertFalse(install.shownRow("compute-command-unix")?.title.contains("sudo") ?? true)
        XCTAssertTrue(install.shownFooters.last?.hasPrefix("Run this on your own computer, signed in as yourself. It needs no sudo") == true)
        XCTAssertTrue(install.shownFooters.last?.hasSuffix("The command works once. It expires in 1 hour.") == true)
        install.tapRow("compute-copy-unix")
        XCTAssertEqual(UIPasteboard.general.string, install.install.commands?.unix)
        XCTAssertEqual(install.shownRow("compute-copy-unix")?.value, "Copied")
        let minted = await server.requests.first { $0.path == "/v0/computers/join-tokens" }
        XCTAssertEqual(minted?.body, .object(["mode": .string("private")]), "no name or description: it joins under its hostname")
        try screenshot(install, name: "compute-install-private")
        flow.close()
        try await until { page.adding == nil && navigation.presentedViewController == nil }
    }

    func testASandboxInstallIsLinuxOnly() async throws {
        let (_, session, _) = try await rig()
        let page = ComputeViewController(session: session)
        _ = try await host(page)
        try await until { page.shownRow("compute-add") != nil }
        page.tapRow("compute-add")
        let flow = try XCTUnwrap(page.adding)
        XCTAssertEqual(flow.state, .choosing(ComputerDraft(mode: .sandbox)))
        flow.create()
        try await until { flow.navigation.topViewController is ComputeInstallViewController }
        try await settled(flow.navigation)
        let install = try XCTUnwrap(flow.navigation.topViewController as? ComputeInstallViewController)
        install.view.layoutIfNeeded()
        XCTAssertEqual(install.shownHeaders, ["LINUX"])
        XCTAssertTrue(install.shownRow("compute-command-unix")?.title.contains("| sudo HAPPY_CLUSTER_URL") == true)
        flow.close()
    }

    /// A member's own computer offers no actions: it is renamed through
    /// the cluster's admin bot, and only a manager releases.
    func testAMembersComputerHasNoActions() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session, page: .computer("kirills-mbp"))
        _ = try await host(page)
        try await until { page.shownRow("compute-os") != nil }
        XCTAssertNil(page.shownRow("compute-release"))
        XCTAssertNil(page.shownRow("compute-host-cpu"), "a member reads no host facts")
        try screenshot(page, name: "compute-member-computer")
        let patch = await server.requests.first { $0.method == "PATCH" }
        XCTAssertNil(patch)
    }

    func testAManagerReleasesAHeldComputer() async throws {
        let (_, session, server) = try await rig()
        let page = ComputeViewController(session: session, page: .computer("build-01"))
        _ = try await host(page)
        try await until { page.shownRow("compute-release") != nil }
        XCTAssertEqual(page.shownRow("compute-host-cpu")?.value, "16")
        guard case .computer(let node)? = page.monitor.snapshot else { return XCTFail("no computer") }
        page.release(node)
        try await until { page.shownRow("compute-release") == nil }
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "Online")
        let release = await server.requests.first { $0.path.hasSuffix("/release-lock") }
        XCTAssertEqual(release?.path, "/v0/computers/build-01/release-lock")
    }

    func testForbiddenResponseRemovesProtectedRows() async throws {
        let (_, session, transport) = try await rig()
        let page = ComputeViewController(session: session)
        _ = try await host(page)
        try await until { page.shownRow("compute-node-gpu-01") != nil }
        await transport.deny()
        page.monitor.refresh()
        await page.monitor.reading?.value
        XCTAssertNil(page.shownRow("compute-node-gpu-01"))
        XCTAssertEqual(page.monitor.failure, .forbidden)
    }

    func testPermissionRefreshRemovesTheSettingsAndSearchEntries() async throws {
        let (context, session, transport) = try await rig(granted: Self.member)
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let navigation = try await host(settings)
        XCTAssertNotNil(settings.shownRow("computes"))
        let home = HomeViewController(context: context, computer: session.accountID)
        navigation.setViewControllers([home], animated: false)
        home.loadViewIfNeeded()
        home.beginSearch()
        home.search("Compute")
        let results = try XCTUnwrap(home.view.subviews.compactMap { $0 as? HomeSearchResultsView }.first)
        XCTAssertTrue(results.list.shownRows.contains { $0.id == "search:settings:computes" })
        await transport.setPermissions([])
        session.refreshPermissions()
        try await until { !session.gate.allows(.computeUse) }
        XCTAssertFalse(results.list.shownRows.contains { $0.id == "search:settings:computes" })
        XCTAssertNil(settings.shownRow("computes"))
    }

    func testRepeatedAppearanceOwnsExactlyOneEventSubscription() async throws {
        let (_, session, _) = try await rig()
        let page = ComputeViewController(session: session)
        _ = try await host(page)
        try await until { page.shownRow("compute-node-gpu-01") != nil }
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
