#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Cloud server's compute routes over fixture computers: two
/// shared ones (one full, without a boundary), the reader's own private one,
/// and a member's agent asking to join it.
private actor ComputeServer: AgentTransport {
    private var granted: [String]
    private var forbidden = false
    private(set) var requests: [(method: String, path: String, body: JSONValue?)] = []
    private let descriptions: [String: String] = [
        "gpu-01": "GPU box, CUDA 12.4, use for training. Repo checkouts under /data.",
        "build-01": "Mac mini for iOS builds; Xcode 26 is installed.",
        "kirills-mbp": "My laptop. Repos under ~/src.",
    ]
    private var agents: [String: [(id: String, title: String?)]] = [
        "gpu-01": [("agent-1", "Train the ranking model"), ("agent-2", nil)],
        "build-01": [("agent-7", "Fix flaky login test")],
    ]
    private var concurrency = ["gpu-01": 8, "build-01": 1, "kirills-mbp": 1, "alex-pc": 1]
    private var approvals = [#"{"computerId":"kirills-mbp","computerName":"kirills-mbp","agentId":"agent-9","agentTitle":"Refactor the sync engine","createdAt":\#(Date().timeIntervalSince1970 * 1000 - 120_000)}"#]

    init(granted: [String]) { self.granted = granted }
    func deny() { forbidden = true }
    func setPermissions(_ granted: [String]) { self.granted = granted }

    private var manager: Bool { granted.contains("pools.manage") }

    private func node(_ id: String, name: String? = nil, status: String = "online", os: String, arch: String, access: String, owner: String? = nil,
                      max: Int? = nil, boundary: String? = nil) -> String {
        let quoted = { (value: String?) in value.map { "\"\($0)\"" } ?? "null" }
        let description = descriptions[id].map { "\"\($0)\"" } ?? "null"
        let placed = (agents[id] ?? []).map { #"{"id":"\#($0.id)","title":\#(quoted($0.title))}"# }.joined(separator: ",")
        var json = #"{"id":"\#(id)","name":\#(quoted(name)),"hostname":"\#(id)","status":"\#(status)","os":"\#(os)","arch":"\#(arch)","version":"0.1.0-\#(os).4","osVersion":null,"shell":"/bin/zsh","lastSeenAt":1762900000000,"since":1762800000000,"description":\#(description),"access":"\#(access)","owner":\#(quoted(owner)),"concurrency":\#(concurrency[id] ?? 1),"maxConcurrency":\#(max.map(String.init) ?? "null"),"agents":[\#(placed)],"boundary":{"available":\#(boundary == nil),"reason":\#(quoted(boundary))}"#
        if manager { json += #","backend":"bwrap","host":{"cpuCores":16,"totalMemoryBytes":68719476736,"totalDiskBytes":null},"features":{"webSocketTunnels":true,"mcpStdio":true,"releases":true}"# }
        return json + "}"
    }

    private var computers: [String] {
        var computers = [
            node("gpu-01", os: "linux", arch: "x86_64", access: "shared", max: 16),
            node("build-01", os: "macos", arch: "arm64", access: "shared", boundary: "sandbox-exec is unavailable on this macOS version"),
            node("kirills-mbp", os: "macos", arch: "arm64", access: "private", owner: "me"),
        ]
        // Another member's private computer shows only to a manager.
        if manager { computers.append(node("alex-pc", status: "offline", os: "windows", arch: "x86_64", access: "private", owner: "user-alex")) }
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
        case ("PATCH", let id) where id.count == 1:
            guard let value = sent?["concurrency"], case .number(let number) = value else { return HTTP1Response(status: 400) }
            concurrency[id[0]] = Int(number)
            return computer(id[0]).map { ok("{\"computer\":\($0)}") } ?? HTTP1Response(status: 404)
        case ("DELETE", let id) where id.count == 3 && id[1] == "agents":
            guard agents[id[0]]?.contains(where: { $0.id == id[2] }) == true else { return HTTP1Response(status: 404) }
            agents[id[0]]?.removeAll { $0.id == id[2] }
            return ok(#"{"released":"\#(id[2])"}"#)
        case ("POST", let answer) where answer.count == 3 && answer[0] == "approvals":
            approvals.removeAll { $0.contains(#""agentId":"\#(answer[2])""#) }
            return ok(#"{"approval":{"computerId":"\#(answer[1])","agentId":"\#(answer[2])","requestedBy":"me","state":"approved","createdAt":1,"decidedAt":2}}"#)
        case ("POST", ["join-tokens"]):
            let access = sent?["access"]?.stringValue ?? ""
            let given: Int? = if case .number(let number)? = sent?["concurrency"] { Int(number) } else { nil }
            let concurrency = given ?? (access == "private" ? 1 : 8)
            return ok(#"{"access":"\#(access)","concurrency":\#(concurrency),"token":"hjt_7Kq2xV","expiresAt":\#(Date().timeIntervalSince1970 * 1000 + 3_600_000),"clusterUrl":"https://acme.happy-clusters.com","commands":{"unix":"curl -fsSL https://get.happy-clusters.com/install.sh | HAPPY_CLUSTER_URL='https://acme.happy-clusters.com' HAPPY_JOIN_TOKEN='hjt_7Kq2xV' sh","windows":"$env:HAPPY_CLUSTER_URL='https://acme.happy-clusters.com'; $env:HAPPY_JOIN_TOKEN='hjt_7Kq2xV'; irm https://get.happy-clusters.com/install.ps1 | iex"},"platforms":["linux-x86_64","linux-aarch64"],"notice":"macOS and Windows computers are not available yet."}"#)
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

    /// One flat list, online first: each computer's access, whose it is,
    /// how full, where it runs and what agents read about it.
    func testTheListShowsAccessOwnerLoadAndDescription() async throws {
        let (_, session, server) = try await rig()
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-alex-pc")?.subtitle?.contains("Alex’s") == true }
        try await settled(navigation)
        let computers = try XCTUnwrap(page.shownRowIDs.last)
        XCTAssertEqual(computers, ["compute-node-build-01", "compute-node-gpu-01", "compute-node-kirills-mbp", "compute-node-alex-pc", "compute-add"])
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.subtitle, "Shared · 2 of 8 agents · Linux x86_64\nGPU box, CUDA 12.4, use for training. Repo checkouts under /data.")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.subtitle, "Shared · 1 of 1 agent · Full access only · macOS arm64\nMac mini for iOS builds; Xcode 26 is installed.")
        XCTAssertEqual(page.shownRow("compute-node-kirills-mbp")?.subtitle, "Private · Yours · 0 of 1 agent · macOS arm64\nMy laptop. Repos under ~/src.")
        XCTAssertEqual(page.shownRow("compute-node-alex-pc")?.subtitle, "Private · Alex’s · 0 of 1 agent · Windows x86_64")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "Full")
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.value, "Online")
        XCTAssertEqual(page.shownRow("compute-node-alex-pc")?.value, "Offline")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.menu.map(\.title), [], "agents are removed on a computer's own page")
        XCTAssertEqual(page.shownHeaders, ["JOIN REQUESTS", "COMPUTERS"])
        let paths = await server.requests.map(\.path)
        XCTAssertEqual(Set(paths.filter { $0.hasPrefix("/v0/comput") }), ["/v0/computers", "/v0/computers/approvals"], "nothing under /v0/compute/")
        try screenshot(page, name: "compute-list-manager")
    }

    /// A member sees the team's computers, not other members' private ones.
    func testAMemberSeesTheTeamsComputers() async throws {
        let (_, session, _) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-kirills-mbp") != nil }
        try await settled(navigation)
        XCTAssertNil(page.shownRow("compute-node-alex-pc"))
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

    /// A member adds only a private computer: shared is there, greyed out;
    /// the install shows the systems with a published build and the notice.
    func testAMembersAddFlowMakesAPrivateComputer() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-add") != nil }
        page.tapRow("compute-add")
        let flow = try XCTUnwrap(page.adding)
        try await settled(navigation)
        let choice = try XCTUnwrap(flow.navigation.topViewController as? ComputeAccessViewController)
        XCTAssertEqual(choice.shownRowIDs, [["compute-access-shared"], ["compute-access-private"], ["compute-concurrency"]])
        XCTAssertEqual(choice.shownRow("compute-access-shared")?.value, "Admin only")
        XCTAssertNil(choice.shownRow("compute-access-shared")?.action)
        XCTAssertNotNil(choice.shownRow("compute-access-private")?.valueView, "private is chosen")
        XCTAssertEqual(choice.shownRow("compute-concurrency")?.value, "1 (default)")
        try screenshot(choice, name: "compute-add-member")
        choice.tapRow("compute-access-shared")
        XCTAssertEqual(flow.state, .choosing(ComputerDraft(access: .private)))
        XCTAssertEqual(choice.navigationItem.rightBarButtonItem?.accessibilityIdentifier, "compute-create")

        flow.create()
        try await until { flow.navigation.topViewController is ComputeInstallViewController }
        try await settled(flow.navigation)
        let install = try XCTUnwrap(flow.navigation.topViewController as? ComputeInstallViewController)
        XCTAssertEqual(install.shownRowIDs, [["compute-command-unix", "compute-copy-unix"]])
        XCTAssertEqual(install.shownHeaders, ["LINUX"])
        XCTAssertTrue(install.shownFooters.last?.hasPrefix("Run this on your own computer, signed in as yourself.") == true)
        XCTAssertTrue(install.shownFooters.last?.contains("macOS and Windows computers are not available yet.") == true)
        XCTAssertTrue(install.shownFooters.last?.contains("The command works once and holds a secret, so keep it private. It expires at ") == true)
        install.tapRow("compute-copy-unix")
        XCTAssertEqual(UIPasteboard.general.string, install.install.commands?.unix)
        XCTAssertEqual(install.shownRow("compute-copy-unix")?.value, "Copied")
        let minted = await server.requests.first { $0.path == "/v0/computers/join-tokens" }
        XCTAssertEqual(minted?.body, .object(["access": .string("private")]), "the default concurrency isn't sent")
        try screenshot(install, name: "compute-install-private")
        flow.close()
        try await until { page.adding == nil && navigation.presentedViewController == nil }
    }

    func testAManagerAddsASharedComputerWithItsConcurrency() async throws {
        let (_, session, server) = try await rig()
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-add") != nil }
        page.tapRow("compute-add")
        let flow = try XCTUnwrap(page.adding)
        try await settled(navigation)
        let choice = try XCTUnwrap(flow.navigation.topViewController as? ComputeAccessViewController)
        XCTAssertEqual(flow.state, .choosing(ComputerDraft(access: .shared)))
        XCTAssertEqual(choice.shownRow("compute-concurrency")?.value, "8 (default)")
        XCTAssertNotNil(choice.shownRow("compute-access-shared")?.action)
        flow.setConcurrency(4)
        choice.reload()
        XCTAssertEqual(choice.shownRow("compute-concurrency")?.value, "4")
        try screenshot(choice, name: "compute-add-manager")
        flow.create()
        try await until { flow.navigation.topViewController is ComputeInstallViewController }
        let minted = await server.requests.first { $0.path == "/v0/computers/join-tokens" }
        XCTAssertEqual(minted?.body, .object(["access": .string("shared"), "concurrency": .number(4)]))
        flow.close()
    }

    /// The owner of a private computer sets its concurrency; no host facts
    /// come to a member.
    func testAnOwnerSetsTheirComputersConcurrency() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session, page: .computer("kirills-mbp"))
        _ = try await host(page)
        try await until { page.shownRow("compute-concurrency") != nil }
        XCTAssertNotNil(page.shownRow("compute-concurrency")?.action)
        XCTAssertEqual(page.shownRow("compute-agents-empty")?.title, "No agents are working here.")
        XCTAssertNil(page.shownRow("compute-host-cpu"), "a member reads no host facts")
        XCTAssertNil(page.shownRow("compute-boundary"))
        XCTAssertEqual(page.shownRow("compute-shell")?.value, "/bin/zsh")
        try screenshot(page, name: "compute-member-own-computer")
        guard case .computer(let node)? = page.monitor.snapshot else { return XCTFail("no computer") }
        page.setConcurrency(3, of: node)
        try await until { page.shownRow("compute-concurrency")?.value == "3" }
        let patch = await server.requests.first { $0.method == "PATCH" }
        XCTAssertEqual(patch?.path, "/v0/computers/kirills-mbp")
        XCTAssertEqual(patch?.body, .object(["concurrency": .number(3)]))
    }

    /// A member changes nothing on a shared computer.
    func testAMemberManagesNoSharedComputer() async throws {
        let (_, session, server) = try await rig(granted: Self.member)
        let page = ComputeViewController(session: session, page: .computer("gpu-01"))
        _ = try await host(page)
        try await until { page.shownRow("compute-agent-agent-1") != nil }
        XCTAssertNil(page.shownRow("compute-concurrency")?.action)
        XCTAssertEqual(page.shownRow("compute-agent-agent-1")?.menu.map(\.title), [])
        XCTAssertNil(page.shownRow("compute-agent-agent-1")?.action)
        XCTAssertTrue(page.shownHeaders.contains("2 OF 8 AGENTS"), "\(page.shownHeaders)")
        XCTAssertEqual(page.shownRow("compute-agent-agent-2")?.title, "An agent", "an agent the reader can't read is unnamed")
        guard case .computer(let node)? = page.monitor.snapshot else { return XCTFail("no computer") }
        page.setConcurrency(2, of: node)
        page.remove(node.agents[0], from: node)
        let writes = await server.requests.filter { $0.method == "PATCH" || $0.method == "DELETE" }
        XCTAssertTrue(writes.isEmpty)
    }

    /// A manager sees the boundary warning and takes an agent off a full
    /// computer.
    func testAManagerRemovesAnAgent() async throws {
        let (_, session, server) = try await rig()
        let page = ComputeViewController(session: session, page: .computer("build-01"))
        _ = try await host(page)
        try await until { page.shownRow("compute-agent-agent-7") != nil }
        XCTAssertEqual(page.shownRow("compute-boundary")?.title, "Restricted commands can’t run here")
        XCTAssertEqual(page.shownRow("compute-boundary")?.subtitle, "sandbox-exec is unavailable on this macOS version")
        XCTAssertEqual(page.shownRow("compute-boundary")?.footer, "Only full-access commands run on this computer.")
        XCTAssertEqual(page.shownRow("compute-agent-agent-7")?.menu.map(\.title), ["Remove"])
        XCTAssertNotNil(page.shownRow("compute-agent-agent-7")?.action, "a tap asks to remove it")
        XCTAssertEqual(page.shownRow("compute-concurrency")?.footer, "How many agents can work on this computer at the same time, from 1 to 64.")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "Full")
        XCTAssertEqual(page.shownRow("compute-host-cpu")?.value, "16")
        XCTAssertNotNil(page.shownRow("compute-concurrency")?.action)
        try screenshot(page, name: "compute-manager-full-computer")
        guard case .computer(let node)? = page.monitor.snapshot else { return XCTFail("no computer") }
        page.remove(node.agents[0], from: node)
        try await until { page.shownRow("compute-agent-agent-7") == nil }
        XCTAssertNotNil(page.shownRow("compute-agents-empty"))
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "Online")
        let remove = await server.requests.first { $0.method == "DELETE" }
        XCTAssertEqual(remove?.path, "/v0/computers/build-01/agents/agent-7")
        try screenshot(page, name: "compute-manager-agent-removed")
    }

    /// The screen speaks the screens' language: Russian here, with the
    /// agent count in the form the concurrency asks for.
    func testComputeSpeaksTheScreensLanguage() async throws {
        AppLocalization.use(await TranslationCatalog.load("ru"))
        addTeardownBlock { @MainActor in AppLocalization.use(nil) }
        let (_, session, _) = try await rig()
        let page = ComputeViewController(session: session)
        let navigation = try await host(page)
        try await until { page.shownRow("compute-node-alex-pc")?.subtitle?.contains("Alex") == true }
        try await settled(navigation)
        XCTAssertEqual(page.title, "Вычисления")
        XCTAssertEqual(page.shownRow("compute-node-gpu-01")?.subtitle?.components(separatedBy: "\n").first, "Общий · 2 из 8 агентов · Linux x86_64")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.subtitle?.components(separatedBy: "\n").first, "Общий · 1 из 1 агента · Только полный доступ · macOS arm64")
        XCTAssertEqual(page.shownRow("compute-node-alex-pc")?.subtitle, "Личный · Владелец: Alex · 0 из 1 агента · Windows x86_64")
        XCTAssertEqual(page.shownRow("compute-node-build-01")?.value, "Заполнен")
        XCTAssertEqual(page.shownRow("compute-add")?.title, "Добавить компьютер")
        try screenshot(page, name: "compute-list-ru")
        let computer = ComputeViewController(session: session, page: .computer("build-01"))
        navigation.pushViewController(computer, animated: false)
        try await until { computer.shownRow("compute-agent-agent-7") != nil }
        try await settled(navigation)
        XCTAssertEqual(computer.shownRow("compute-boundary")?.title, "Ограниченные команды недоступны")
        XCTAssertEqual(computer.shownRow("compute-concurrency")?.title, "Агентов одновременно")
        XCTAssertEqual(computer.shownRow("compute-agent-agent-7")?.menu.map(\.title), ["Убрать"])
        try screenshot(computer, name: "compute-computer-ru")
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
