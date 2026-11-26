#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy Cloud server that runs pipelines and keeps the account's
/// feature switches (API.md, "Account features"), as happy-cluster's
/// `worktree/feature-plugins` first laid them out: `GET
/// /v0/account/features`, `account.features.updated` on the stream, and
/// pipelines routes that answer `403 feature_not_installed` while off.
private final class FeaturesCloud: AgentTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var on = true
    /// Pipelines routes refuse without the list or an event having said so.
    private var refusing = false
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private var heard: [(method: String, path: String, body: JSONValue?)] = []

    static let refusal = #"{"error":"Pipelines are turned off for your account. Turn them on in your account settings to use them again.","code":"feature_not_installed","feature":"pipelines"}"#
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"me","name":"Robin"},"userSettings":[],"projects":[],"workspaces":[],"tasks":[],"taskMemberships":[],"surfaces":[],
     "bots":[{"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"bot-agent","workspaceId":"bot-work","status":"idle"}}],
     "health":{"ready":true,"capabilities":{"pipelines":true,"plugins":true}}}
    """#

    func refuse() { lock.withLock { refusing = true } }

    private func list(_ on: Bool) -> String {
        #"{"features":[{"id":"pipelines","name":"Pipelines","enabled":\#(on)}]}"#
    }

    /// The switch flipped on another device: every stream hears it.
    func flip(_ enabled: Bool) {
        let streams = lock.withLock { on = enabled; return self.streams }
        let event = #"{"cursor":"cursor-2","type":"account.features.updated","occurredAt":1795737600000,"payload":\#(list(enabled))}"#
        for stream in streams { stream.yield(Data("id: cursor-2\nevent: message\ndata: \(event)\n\n".utf8)) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let (on, refusing) = lock.withLock {
            heard.append((method, path, body.flatMap { try? JSONValue.decode($0) }))
            return (self.on, self.refusing)
        }
        func answer(_ text: String, _ status: Int = 200) -> HTTP1Response { HTTP1Response(status: status, body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"): return answer(Self.bootstrap)
        case ("GET", "/v0/account/features"): return answer(list(on))
        case ("GET", "/v0/pipelines"):
            guard on, !refusing else { return answer(Self.refusal, 403) }
            let now = Date().timeIntervalSince1970 * 1000
            return answer(#"""
            {"pipelines":[
              {"id":"release","name":"Nightly release","description":"Builds, tests and ships the apps","head":{"number":4},"enabled":true,"lastRun":{"id":"run-2","state":"running","createdAt":\#(now - 90_000)}},
              {"id":"triage","name":"Issue triage","description":"Labels new issues","head":{"number":2},"enabled":true,"lastRun":{"id":"run-1","state":"succeeded","createdAt":\#(now - 3_600_000),"endedAt":\#(now - 3_500_000)}}]}
            """#)
        case ("GET", _) where path.hasPrefix("/v0/pipeline-runs"):
            guard on, !refusing else { return answer(Self.refusal, 403) }
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

/// Pipelines turned off for the whole account: home stops listing them,
/// an open Pipelines screen leaves, and a refused route turns them off
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

    /// Turned off on another device while Pipelines and a run are open:
    /// the event takes the row away and both screens leave in one move,
    /// back to home; turned on again, the row comes back.
    func testTurnedOffElsewhereClosesThePipelinesScreensAndHidesTheRow() async throws {
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

        rig.cloud.flip(false)
        try await until("the row gone") { !Self.listsPipelines(rig.session.home) }
        try await until("the screens gone") { self.pipelineScreens(rig) == 0 }
        try await settled(rig.navigation)
        XCTAssertEqual(rig.navigation.viewControllers.count, 1, "back to home")
        XCTAssertNil(rig.session.home.error)
        shoot(rig.window, "3-home-pipelines-off")

        rig.cloud.flip(true)
        try await until("the row back") { Self.listsPipelines(rig.session.home) }
        try await settled(rig.navigation)
        shoot(rig.window, "4-home-pipelines-back")
    }

    /// Off without this phone having heard: the screen's read is refused
    /// `403 feature_not_installed`, which turns Pipelines off here and
    /// closes the screen, with no error said.
    func testARefusedReadClosesTheScreenWithoutAnError() async throws {
        let rig = try await rig()
        rig.cloud.refuse()
        rig.navigation.pushViewController(PipelinesViewController(session: rig.session), animated: true)
        try await until("Pipelines off here") { !rig.session.home.features.enabled(AccountFeatures.pipelines) }
        try await until("the screen gone") { self.pipelineScreens(rig) == 0 }
        try await settled(rig.navigation)
        XCTAssertFalse(Self.listsPipelines(rig.session.home))
        XCTAssertNil(rig.session.home.error)
        XCTAssertNil(rig.session.home.notice)
    }
}
#endif
