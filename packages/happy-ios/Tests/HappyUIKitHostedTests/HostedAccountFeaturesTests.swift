#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Cloud server that runs pipelines with feature plugins (API.md,
/// "Feature plugins", happy-cluster bb18ee94): the Pipelines plugin in the
/// catalog, its installation `pipelines`, `GET /v0/features`,
/// `plugins.changed` and `features.updated` on the stream, and pipelines
/// routes that answer `403 feature_not_installed` while it is uninstalled.
private final class FeaturesCloud: AgentTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var installed = true
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var heard: [(method: String, path: String)] = []
    private var cursor = 1

    static let refusal = #"{"error":"Pipelines are not installed for your account. Install the Pipelines plugin to use them again.","code":"feature_not_installed","feature":"pipelines","plugin":"pipelines"}"#
    static let health = #"{"ready":true,"capabilities":{"pipelines":true,"plugins":true,"features":true}}"#
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"me","name":"Robin"},"userSettings":[],"projects":[],"workspaces":[],"tasks":[],"taskMemberships":[],"surfaces":[],
     "bots":[{"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"bot-agent","workspaceId":"bot-work","status":"idle"}}],
     "health":\#(health)}
    """#
    static let installation = #"{"id":"pipelines","plugin":"pipelines","pluginName":"Pipelines","kind":"feature","ordinal":1,"label":null,"status":"active","reason":null,"authMethod":null,"toolPrefix":"","image":null,"available":true}"#

    /// The plugin writes heard, as `METHOD path`.
    var writes: [String] {
        lock.withLock { heard.filter { $0.method != "GET" && $0.path.hasPrefix("/v0/plugins") }.map { "\($0.method) \($0.path)" } }
    }
    /// Uninstalled with no event reaching this phone.
    func uninstallUnheard() { lock.withLock { installed = false } }

    private static func features(_ installed: Bool) -> String { #"{"features":[{"id":"pipelines","available":\#(installed)}]}"# }

    /// Installed or uninstalled, here or on another device: both events
    /// the server journals, on every stream.
    func change(installed: Bool) {
        let (streams, cursor) = lock.withLock { () -> ([AsyncThrowingStream<Data, Error>.Continuation], Int) in
            self.installed = installed
            self.cursor += 2
            return (self.streams, self.cursor)
        }
        let changed = #"{"cursor":"cursor-\#(cursor - 1)","type":"plugins.changed","occurredAt":1795737600000,"payload":{"installationId":"pipelines"}}"#
        let updated = #"{"cursor":"cursor-\#(cursor)","type":"features.updated","occurredAt":1795737600000,"payload":\#(Self.features(installed))}"#
        for stream in streams {
            stream.yield(Data("id: cursor-\(cursor - 1)\nevent: message\ndata: \(changed)\n\n".utf8))
            stream.yield(Data("id: cursor-\(cursor)\nevent: message\ndata: \(updated)\n\n".utf8))
        }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let installed = lock.withLock {
            heard.append((method, path))
            return self.installed
        }
        // Happy's JSON: a 403 without it is the edge asking to sign in again.
        func answer(_ text: String, _ status: Int = 200) -> HTTP1Response {
            HTTP1Response(status: status, headers: ["content-type": "application/json"], body: Data(text.utf8))
        }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"): return answer(Self.bootstrap)
        case ("GET", "/v0/health"): return answer(Self.health)
        case ("GET", "/v0/features"): return answer(Self.features(installed))
        case ("GET", "/v0/plugins"):
            return answer(#"""
            {"plugins":[
              {"id":"github","name":"GitHub","kind":"integration","description":"Repositories, issues and pull requests.","version":"1.0.0","tools":[],"auth":{"required":true,"methods":[]}},
              {"id":"pipelines","name":"Pipelines","kind":"feature","installed":\#(installed),"description":"Fixed graphs of work that agents author and run to completion.","version":"1.0.0",
               "tools":[{"name":"run_pipeline","summary":"Starts a run of a pipeline."},{"name":"list_pipelines","summary":"Lists the team’s pipelines."}],"auth":{"required":false,"methods":[]}}]}
            """#)
        case ("GET", "/v0/plugins/installations"):
            return answer(#"{"installations":[\#(installed ? Self.installation : "")],"canManage":false}"#)
        case ("POST", "/v0/plugins/installations"):
            if installed { return answer(#"{"installation":\#(Self.installation)}"#) }
            change(installed: true)
            return answer(#"{"installation":\#(Self.installation)}"#, 201)
        case ("DELETE", "/v0/plugins/installations/pipelines"):
            guard installed else { return answer(#"{"error":"Not found"}"#, 404) }
            change(installed: false)
            return answer(#"{"deleted":true,"secretsDeleted":0,"storageEntriesDeleted":0,"cleanedUpOutside":false}"#)
        case ("GET", "/v0/pipelines"):
            guard installed else { return answer(Self.refusal, 403) }
            let now = Date().timeIntervalSince1970 * 1000
            return answer(#"""
            {"pipelines":[
              {"id":"release","name":"Nightly release","description":"Builds, tests and ships the apps","head":{"number":4},"enabled":true,"lastRun":{"id":"run-2","state":"running","createdAt":\#(now - 90_000)}},
              {"id":"triage","name":"Issue triage","description":"Labels new issues","head":{"number":2},"enabled":true,"lastRun":{"id":"run-1","state":"succeeded","createdAt":\#(now - 3_600_000),"endedAt":\#(now - 3_500_000)}}]}
            """#)
        case ("GET", _) where path.hasPrefix("/v0/pipeline-runs"):
            guard installed else { return answer(Self.refusal, 403) }
            let now = Date().timeIntervalSince1970 * 1000
            return answer(#"""
            {"runs":[
              {"id":"run-2","version":4,"state":"running","trigger":{"kind":"agent","agentId":"bot-agent"},"createdAt":\#(now - 90_000),"startedAt":\#(now - 88_000),"pipelineId":"release","pipelineName":"Nightly release"},
              {"id":"run-1","version":2,"state":"succeeded","trigger":{"kind":"agent","agentId":"bot-agent"},"createdAt":\#(now - 3_600_000),"startedAt":\#(now - 3_590_000),"endedAt":\#(now - 3_500_000),"pipelineId":"triage","pipelineName":"Issue triage"}],
             "nextCursor":null}
            """#)
        default:
            return answer("{}", 404)
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        lock.withLock { streams.append(continuation) }
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":false,\"gap\":false}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func reset() async {}
    func close() async {
        let streams = lock.withLock { defer { self.streams = [] }; return self.streams }
        streams.forEach { $0.finish() }
    }
}

/// The Pipelines plugin uninstalled for the whole account: home stops
/// listing Pipelines, an open Pipelines screen leaves, the Plugins screen
/// installs and uninstalls it, and a refused route makes them unavailable
/// without saying an error.
@MainActor
final class HostedAccountFeaturesTests: XCTestCase {
    private struct Rig {
        let context: AppContext
        let session: Session
        let cloud: FeaturesCloud
        let shell: ShellViewController
        let navigation: UINavigationController
        let window: UIWindow
    }

    private func rig() async throws -> Rig {
        let cloud = FeaturesCloud()
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "account-features",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(), agentTransport: { _ in cloud })
        await account.agentConnections.setForeground(false)
        let server = HappyCloud.server(named: "features-\(UUID().uuidString.prefix(8).lowercased())")
        let connection = try await account.agentConnections.addServer(AgentOrigin(server),
            signIn: ServerSignInRecord(method: HappyCloud.method(server: server), grant: OAuthGrant(clientId: "test"), userId: "me"),
            access: OAuthAccess(token: "test", expiresAt: nil), name: "Studio")
        NetworkPath.shared.force(true)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let home = AgentHomeViewController(context: context, id: connection.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let shell = ShellViewController(context: context, phone: navigation, splits: false)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: shell)
        window.overrideUserInterfaceStyle = .light
        shell.view.layoutIfNeeded()
        addTeardownBlock { @MainActor [context] in
            _ = context
            window.isHidden = true
            previous?.makeKey()
            await session.engine.stop()
            Session.forget(connection.id)
            try? await account.agentConnections.remove(connection.id)
        }
        await session.engine.start()
        try await until("home live, Pipelines listed") { session.home.live && Self.listsPipelines(session.home) && session.home.features.list != nil }
        return Rig(context: context, session: session, cloud: cloud, shell: shell, navigation: navigation, window: window)
    }

    private static func listsPipelines(_ home: HomeSnapshot) -> Bool { home.rows.contains { $0.targetKind == "pipelines" } }

    private func until(_ what: String, seconds: Int = 8, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(30)) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    private func settled(_ navigation: UINavigationController) async throws {
        try await until("settled") { navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(500))
    }

    private func shoot(_ window: UIWindow, _ name: String) {
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func pipelineScreens(_ rig: Rig) -> Int { rig.shell.stack.filter { $0 is PipelinesScreen }.count }

    /// Uninstalled on another device while Pipelines and a run are open:
    /// the event takes the row away and both screens leave in one move,
    /// back to home; installed again, the row comes back.
    func testUninstalledElsewhereClosesThePipelinesScreensAndHidesTheRow() async throws {
        let rig = try await rig()
        try await settled(rig.navigation)
        shoot(rig.window, "1-home-pipelines-on")

        rig.navigation.pushViewController(PipelinesViewController(session: rig.session), animated: true)
        try await settled(rig.navigation)
        try await Task.sleep(for: .milliseconds(700))
        shoot(rig.window, "2-pipelines-open")
        rig.navigation.pushViewController(PipelineRunViewController(session: rig.session, runId: "run-2", pipelineName: "Nightly release"), animated: true)
        try await settled(rig.navigation)
        XCTAssertEqual(pipelineScreens(rig), 2)

        rig.cloud.change(installed: false)
        try await until("the row gone") { !Self.listsPipelines(rig.session.home) }
        try await until("the screens gone") { self.pipelineScreens(rig) == 0 }
        try await settled(rig.navigation)
        XCTAssertEqual(rig.navigation.viewControllers.count, 1, "back to home")
        XCTAssertNil(rig.session.home.error)
        shoot(rig.window, "3-home-pipelines-off")

        rig.cloud.change(installed: true)
        try await until("the row back") { Self.listsPipelines(rig.session.home) }
        try await settled(rig.navigation)
        shoot(rig.window, "4-home-pipelines-back")
    }

    /// The Plugins screen lists Pipelines under Features for a member who
    /// can't manage plugins; its page uninstalls it (`DELETE`), saying
    /// that nothing is deleted, and installs it again (`POST`), with no
    /// setup, sign-in or label. Home's row follows.
    func testThePluginsScreenInstallsAndUninstallsPipelines() async throws {
        let rig = try await rig()
        let plugins = PluginsViewController(session: rig.session)
        rig.navigation.pushViewController(plugins, animated: true)
        try await settled(rig.navigation)
        try await until("Pipelines listed") { plugins.shownRow("plugin-pipelines") != nil }
        let listed = try XCTUnwrap(plugins.shownRow("plugin-pipelines"))
        XCTAssertEqual(listed.value, Strings.Plugins.installedValue)
        XCTAssertEqual(listed.header, Strings.Plugins.features)
        XCTAssertNil(plugins.shownRow("installation-pipelines"), "a feature isn't one of the team's installations")
        shoot(rig.window, "5-plugins-pipelines-installed")

        plugins.tapRow("plugin-pipelines")
        try await settled(rig.navigation)
        let page = try XCTUnwrap(rig.navigation.topViewController as? PluginViewController)
        try await until("Uninstall offered") { page.shownRow("plugin-uninstall") != nil }
        XCTAssertNil(page.shownRow("plugin-install"))
        XCTAssertEqual(page.shownRow("plugin-uninstall")?.footer, Strings.Plugins.uninstallKeeps("Pipelines"))
        XCTAssertFalse(page.shownRowIDs.joined().contains { $0.hasPrefix("installation-") }, "\(page.shownRowIDs)")
        shoot(rig.window, "6-plugin-page-installed")

        page.uninstallFeature(try XCTUnwrap(rig.session.plugins.state.catalog?.plugin("pipelines")), catalog: try XCTUnwrap(rig.session.plugins.state.catalog))
        try await until("Install offered") { page.shownRow("plugin-install") != nil }
        try await until("home without Pipelines") { !Self.listsPipelines(rig.session.home) }
        XCTAssertEqual(rig.cloud.writes, ["DELETE /v0/plugins/installations/pipelines"])
        try await Task.sleep(for: .milliseconds(400))
        shoot(rig.window, "7-plugin-page-uninstalled")

        rig.navigation.popViewController(animated: true)
        try await settled(rig.navigation)
        try await until("listed as not installed") { plugins.shownRow("plugin-pipelines")?.value == Strings.Plugins.notInstalledValue }
        shoot(rig.window, "8-plugins-pipelines-uninstalled")
        rig.navigation.popToRootViewController(animated: true)
        try await settled(rig.navigation)
        shoot(rig.window, "9-home-without-pipelines")

        let again = PluginViewController(session: rig.session, pluginId: "pipelines")
        rig.navigation.pushViewController(again, animated: true)
        try await settled(rig.navigation)
        try await until("Install offered") { again.shownRow("plugin-install") != nil }
        again.installFeature(try XCTUnwrap(rig.session.plugins.state.catalog?.plugin("pipelines")))
        try await until("home with Pipelines") { Self.listsPipelines(rig.session.home) }
        try await until("Uninstall offered again") { again.shownRow("plugin-uninstall") != nil }
        XCTAssertEqual(rig.cloud.writes, ["DELETE /v0/plugins/installations/pipelines", "POST /v0/plugins/installations"])
        rig.navigation.popToRootViewController(animated: true)
        try await settled(rig.navigation)
        shoot(rig.window, "10-home-with-pipelines")
    }

    /// Uninstalled without this phone having heard: the screen's read is
    /// refused `403 feature_not_installed`, which makes Pipelines
    /// unavailable here and closes the screen, with no error said.
    func testARefusedReadClosesTheScreenWithoutAnError() async throws {
        let rig = try await rig()
        rig.cloud.uninstallUnheard()
        rig.navigation.pushViewController(PipelinesViewController(session: rig.session), animated: true)
        try await until("Pipelines unavailable here") { !rig.session.home.features.available(AccountFeatures.pipelines) }
        try await until("the screen gone") { self.pipelineScreens(rig) == 0 }
        try await settled(rig.navigation)
        XCTAssertFalse(Self.listsPipelines(rig.session.home))
        XCTAssertNil(rig.session.home.error)
        XCTAssertNil(rig.session.home.notice)
    }
}
#endif
