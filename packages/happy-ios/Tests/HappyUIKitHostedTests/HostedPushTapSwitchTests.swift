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
}
#endif
