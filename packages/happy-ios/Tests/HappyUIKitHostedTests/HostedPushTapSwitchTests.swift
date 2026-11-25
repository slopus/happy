#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

private struct Unreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A server out of reach but for an agent and its own conversation: the
/// agent, its bootstrap and its messages, answered as `says` has it once `answer()`
/// is called, and held until then. An agent `says` leaves out is not
/// found (404, in the daemon's words).
private actor AgentsOnly: AgentTransport {
    private let says: [String: String]
    private var held = true
    /// Each agent's conversation read, as it arrived.
    private(set) var asked: [String] = []
    /// `says`: the agents it has, by id, and what it calls each.
    init(_ says: [String: String]) { self.says = says }
    func answer() { held = false }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let parts = path.split(separator: "?")[0].split(separator: "/").map(String.init)
        // The agent itself too (`GET /v0/agents/:id`), as slow as the rest.
        let what = parts.count == 3 ? "agent" : parts.last ?? ""
        guard method == "GET", parts.count == 3 || parts.count == 4, parts[0] == "v0", parts[1] == "agents", ["agent", "bootstrap", "messages"].contains(what) else { throw URLError(.cannotConnectToHost) }
        asked.append("\(parts[2])/\(what)")
        while held { try await Task.sleep(for: .milliseconds(10)) }
        guard let title = says[parts[2]] else { return HTTP1Response(status: 404, body: Data(#"{"code":"not_found","error":"The agent was not found."}"#.utf8)) }
        let body = what == "messages" ? #"{"hasMore":false,"runs":[]}"#
            : #"{"agent":{"id":"\#(parts[2])","workspaceId":"w","status":"idle","title":"\#(title)"},"pending":[]}"#
        return HTTP1Response(status: 200, body: Data(body.utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A tapped Happy Cloud push for an agent of another server while a chat is
/// open on this one: the app switches to that server and opens the agent's
/// chat. The switch from a chat swaps the stack with an animation, and for
/// as long as it runs the stack still starts with the chat that is leaving;
/// opened then, the agent's chat was never shown (the switch ended on the
/// other server's home).
@MainActor
final class HostedPushTapSwitchTests: XCTestCase {
    private func stack(in window: UIWindow) -> UINavigationController? {
        var queue = [window.rootViewController].compactMap { $0 }
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let navigation = next as? UINavigationController { return navigation }
            queue += next.children
        }
        return nil
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func push(_ instance: String, agent: String) throws -> CloudPushNotification {
        try XCTUnwrap(CloudPushNotification([
            "kind": "happy.cloud.push.v1", "instanceId": instance, "userId": "steve", "agentId": agent, "notificationId": "n-\(agent)",
        ]))
    }

    func testAPushForAnotherServersAgentOpensItsChatFromAChat() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        let method = OAuthMethod(id: "jwt", name: "Happy Cloud", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        func server(_ host: String, instance: String) async throws -> AgentConnection {
            try await account.agentConnections.addServer(
                try AgentOrigin("https://\(host)"),
                signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r-\(host)", clientId: "happy"), userId: "steve"),
                access: OAuthAccess(token: "a", expiresAt: nil), name: host, instanceId: instance)
        }
        let first = try await server("one.example", instance: "k3x9q2m7p0a4b8c1d5e6f7g2")
        let second = try await server("two.example", instance: "m4y8r2t6w0e3u7i1o5p9a2s6")
        XCTAssertEqual(account.agentConnections.activeID, second.id)
        let context = AppContext(account: account, variant: .preview, version: "test")

        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let navigation = try XCTUnwrap(stack(in: window))
        let home = try await until { navigation.viewControllers.first is AgentHomeViewController && navigation.viewControllers.count == 1 }
        XCTAssertTrue(home, "\(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(500))

        // The open server's own agent, from its home: no switch.
        coordinator.openAgent(fromNotification: try push("m4y8r2t6w0e3u7i1o5p9a2s6", agent: "research-agent"))
        let own = try await until { (navigation.topViewController as? ChatViewController)?.shownAgentId == "research-agent" }
        XCTAssertTrue(own, "\(navigation.viewControllers)")
        _ = try await until { navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(300))

        // The other server's agent, from that chat.
        coordinator.openAgent(fromNotification: try push("k3x9q2m7p0a4b8c1d5e6f7g2", agent: "t1-agent"))
        let switched = try await until { account.agentConnections.activeID == first.id }
        XCTAssertTrue(switched, "the other server never became the open one")
        let opened = try await until(8) {
            navigation.transitionCoordinator == nil && (navigation.topViewController as? ChatViewController)?.shownAgentId == "t1-agent"
        }
        XCTAssertTrue(opened, "the switch ended on \(navigation.viewControllers.map { type(of: $0) }), not on the agent's chat")
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(navigation.viewControllers.first is AgentHomeViewController)
    }
    /// A server with one project's session on its home, and the push for it.
    private func projectsSession(transport: any AgentTransport = Unreachable()) async throws -> (coordinator: AppCoordinator, navigation: UINavigationController, session: Session, home: HomeSnapshot, push: CloudPushNotification) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        let method = OAuthMethod(id: "jwt", name: "Happy Cloud", authorizationUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "happy")
        let server = try await account.agentConnections.addServer(
            try AgentOrigin("https://one.example"),
            signIn: ServerSignInRecord(method: method, grant: OAuthGrant(refreshToken: "r", clientId: "happy"), userId: "steve"),
            access: OAuthAccess(token: "a", expiresAt: nil), name: "one.example", instanceId: "k3x9q2m7p0a4b8c1d5e6f7g2")
        let context = AppContext(account: account, variant: .preview, version: "test")

        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let navigation = try XCTUnwrap(stack(in: window))
        let home = try await until { navigation.viewControllers.first is AgentHomeViewController && navigation.viewControllers.count == 1 }
        XCTAssertTrue(home, "\(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(500))
        let rows = [
            Row(id: "project:p1", nodeId: "project:p1", kind: .space, label: "Releases", targetKind: "project"),
            Row(id: "session:build-agent", nodeId: "session:build-agent", kind: .session, depth: 1, label: "Preview 24", agentId: "build-agent"),
        ]
        var snapshot = HomeSnapshot()
        snapshot.loaded = true; snapshot.rows = rows; snapshot.allRows = rows
        let session = try XCTUnwrap(Session.session(for: server.id, context: context))
        return (coordinator, navigation, session, snapshot, try push("k3x9q2m7p0a4b8c1d5e6f7g2", agent: "build-agent"))
    }

    /// A computer's sidebar is its own home, not a spaces document, and a
    /// project's session is a row inside its project there: the chat a
    /// tapped push opens is named as that row is, not left without a name.
    func testAPushForAProjectsSessionOpensItsChatNamed() async throws {
        let (coordinator, navigation, session, home, push) = try await projectsSession()
        session.receive(home: home)
        coordinator.openAgent(fromNotification: push)
        let opened = try await until { (navigation.topViewController as? ChatViewController)?.shownAgentId == "build-agent" }
        XCTAssertTrue(opened, "\(navigation.viewControllers)")
        _ = try await until(2) { navigation.topViewController?.title == "Preview 24" }
        XCTAssertEqual(navigation.topViewController?.title, "Preview 24")
    }

    /// From a closed app the chat opens before home has been read: it is
    /// named once its row is there.
    func testAChatOpenedBeforeHomeIsReadIsNamedOnceItsRowIsThere() async throws {
        let (coordinator, navigation, session, home, push) = try await projectsSession()
        coordinator.openAgent(fromNotification: push)
        let opened = try await until { (navigation.topViewController as? ChatViewController)?.shownAgentId == "build-agent" }
        XCTAssertTrue(opened, "\(navigation.viewControllers)")
        session.receive(home: home)
        _ = try await until(2) { navigation.topViewController?.title == "Preview 24" }
        XCTAssertEqual(navigation.topViewController?.title, "Preview 24")
    }

    /// What the chat on top says in place of a conversation it could not load.
    private func notFound(_ navigation: UINavigationController) -> ChatPlaceholderView? {
        var queue = [navigation.topViewController?.viewIfLoaded].compactMap { $0 }
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let placeholder = next as? ChatPlaceholderView, !placeholder.isHidden { return placeholder }
            queue += next.subviews
        }
        return nil
    }

    /// A push is taken from whoever holds the relay token, and one shown a
    /// while ago may name an agent since gone. Its chat opens at once, as
    /// any does, and once its server says it has no such agent the chat
    /// says so, in the server's words: not an empty screen with no name
    /// that looks as if it were still loading.
    func testAPushForAnAgentItsServerDoesNotHaveOpensItsChatSayingSo() async throws {
        let server = AgentsOnly([:])
        let (coordinator, navigation, session, home, _) = try await projectsSession(transport: server)
        session.receive(home: home)
        coordinator.openAgent(fromNotification: try push("k3x9q2m7p0a4b8c1d5e6f7g2", agent: "ghost-agent"))
        let opened = try await until(1.5) { (navigation.topViewController as? ChatViewController)?.shownAgentId == "ghost-agent" }
        XCTAssertTrue(opened, "its chat waited for its server: \(navigation.viewControllers)")
        XCTAssertNil(notFound(navigation), "said before its server did")
        await server.answer()
        let said = try await until { self.notFound(navigation)?.content == .notFound("The agent was not found.") }
        XCTAssertTrue(said, "\(String(describing: notFound(navigation)?.content))")
        XCTAssertEqual(notFound(navigation)?.accessibilityIdentifier, "chat-not-found")
        XCTAssertEqual(notFound(navigation)?.accessibilityLabel, "Couldn’t load this conversation. The agent was not found.")
    }

    /// An agent newer than the home this phone last read is on no row: its
    /// chat opens at once all the same, before its server has answered,
    /// and takes the name the server gives it when it does.
    func testAnAgentHomeDoesNotListOpensAtOnceAndIsNamedOnceItsServerAnswers() async throws {
        let server = AgentsOnly(["new-agent": "Fresh one"])
        let (coordinator, navigation, session, home, _) = try await projectsSession(transport: server)
        session.receive(home: home)
        coordinator.openAgent(fromNotification: try push("k3x9q2m7p0a4b8c1d5e6f7g2", agent: "new-agent"))
        let opened = try await until(1.5) { (navigation.topViewController as? ChatViewController)?.shownAgentId == "new-agent" }
        XCTAssertTrue(opened, "its chat waited for its server: \(navigation.viewControllers)")
        await server.answer()
        _ = try await until { navigation.topViewController?.title == "Fresh one" }
        XCTAssertEqual(navigation.topViewController?.title, "Fresh one")
        XCTAssertNil(notFound(navigation))
    }

    /// A conversation its server has is never said to be missing, and one
    /// on home keeps the name home gives it.
    func testAnAgentOnHomeOpensNamedAndSaysNothing() async throws {
        let server = AgentsOnly(["build-agent": "Preview 24"])
        let (coordinator, navigation, session, home, push) = try await projectsSession(transport: server)
        session.receive(home: home)
        await server.answer()
        coordinator.openAgent(fromNotification: push)
        let opened = try await until { (navigation.topViewController as? ChatViewController)?.shownAgentId == "build-agent" }
        XCTAssertTrue(opened, "\(navigation.viewControllers)")
        var read = false
        for _ in 0..<150 where !read { read = await server.asked.contains("build-agent/bootstrap"); if !read { try await Task.sleep(for: .milliseconds(20)) } }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(navigation.topViewController?.title, "Preview 24")
        XCTAssertNil(notFound(navigation))
    }

    /// A server out of reach is not a server that said no: the chat stays
    /// as it was, to be read when the server is back.
    func testAServerOutOfReachIsNotSaidToLackTheAgent() async throws {
        let (coordinator, navigation, session, home, _) = try await projectsSession()
        session.receive(home: home)
        coordinator.openAgent(fromNotification: try push("k3x9q2m7p0a4b8c1d5e6f7g2", agent: "ghost-agent"))
        let opened = try await until { (navigation.topViewController as? ChatViewController)?.shownAgentId == "ghost-agent" }
        XCTAssertTrue(opened, "\(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertNil(notFound(navigation))
    }
}
#endif
