#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
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

/// Switching accounts in the app's own window. With home on screen, the
/// other account's home dissolves in where the old one was: the stack is
/// still one screen deep, nothing is pushed or popped, and the window's
/// navigation view carries a fade. With Settings on top, home changes
/// underneath it with no animation at all.
@MainActor
final class HostedAccountSwitchTests: XCTestCase {
    /// What the window looked like the moment the new root went in.
    private struct Installed {
        var stack: [UIViewController]
        var transitioning: Bool
        var fades: [CATransition]
    }

    /// Reads the stack each time the coordinator says it has a new root.
    @MainActor
    private final class Roots {
        var installed: [Installed] = []
        nonisolated(unsafe) private var token: NSObjectProtocol?

        init(window: UIWindow, navigation: UINavigationController) {
            token = NotificationCenter.default.addObserver(forName: AppCoordinator.rootDidChange, object: window, queue: nil) { [weak self, weak navigation] _ in
                MainActor.assumeIsolated {
                    guard let self, let navigation else { return }
                    let layer = navigation.view.layer
                    let fades = (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) as? CATransition }.filter { $0.type == .fade }
                    self.installed.append(Installed(stack: navigation.viewControllers, transitioning: navigation.transitionCoordinator != nil, fades: fades))
                }
            }
        }

        deinit {
            if let token { NotificationCenter.default.removeObserver(token) }
        }
    }

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

    /// Two Happy accounts, the second active, and optionally an agent
    /// connection, in a window the coordinator owns.
    private func app(connection: Bool = false) async throws -> (AccountController, UINavigationController, UIWindow, first: AccountSummary.ID, AppCoordinator) {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.signIn(Credentials(token: "first", secret: Data(repeating: 3, count: 32)))
        let first = try XCTUnwrap(account.session?.keys.anonID)
        try await account.signIn(Credentials(token: "second", secret: Data(repeating: 4, count: 32)))
        if connection {
            try await account.addAgentConnection(JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"switch-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)), name: "Mac Studio")
            let id = try XCTUnwrap(account.agentConnections.activeID)
            addTeardownBlock { @MainActor in Session.forget(id) }
            try await account.switchAccount(to: first)
        }
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
        let home = try await until { navigation.viewControllers.first is LegacyHomeViewController }
        XCTAssertTrue(home, "the window never showed home: \(navigation.viewControllers)")
        // Restore, which start() runs again, holds the account controller.
        try await Task.sleep(for: .milliseconds(600))

        roots = Roots(window: window, navigation: navigation)
        return (account, navigation, window, first, coordinator)
    }

    private var roots: Roots?
    private var installed: [Installed] {
        get { roots?.installed ?? [] }
        set { roots?.installed = newValue }
    }

    func testHomeDissolvesIntoTheOtherAccountsHome() async throws {
        let (account, navigation, _, first, coordinator) = try await app()
        let old = try XCTUnwrap(navigation.viewControllers.first as? LegacyHomeViewController)
        XCTAssertEqual(navigation.viewControllers.count, 1)

        try await account.switchAccount(to: first)
        let replaced = try await until { navigation.viewControllers.first !== old && navigation.viewControllers.first is LegacyHomeViewController }
        XCTAssertTrue(replaced, "home was never replaced: \(navigation.viewControllers)")

        let shown = try XCTUnwrap(installed.last, "the root never went in")
        XCTAssertEqual(shown.stack.count, 1, "the stack isn't one screen deep: \(shown.stack)")
        XCTAssertFalse(shown.stack.first === old)
        XCTAssertFalse(shown.transitioning, "the new home was pushed or popped")
        let fade = try XCTUnwrap(shown.fades.first, "the switch didn't dissolve")
        XCTAssertEqual(fade.duration, AppCoordinator.rootCrossfade, accuracy: 0.001)
        XCTAssertNil(navigation.transitionCoordinator)
        XCTAssertFalse(navigation.viewControllers.contains(old))
        withExtendedLifetime(coordinator) {}
    }

    /// Settings stays on top while home changes under it, unseen: no
    /// dissolve, no push or pop. Back then goes to the new home.
    func testUnderSettingsHomeSwapsWithoutAnimation() async throws {
        let (account, navigation, _, first, coordinator) = try await app()
        let old = try XCTUnwrap(navigation.viewControllers.first)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let settings = SettingsViewController(context: context, computer: nil)
        navigation.pushViewController(settings, animated: false)
        settings.view.layoutIfNeeded()

        try await account.switchAccount(to: first)
        let replaced = try await until { navigation.viewControllers.first !== old }
        XCTAssertTrue(replaced, "home was never replaced: \(navigation.viewControllers)")

        let shown = try XCTUnwrap(installed.last)
        XCTAssertEqual(shown.stack.count, 2, "\(shown.stack)")
        XCTAssertTrue(shown.stack.last === settings, "settings went away")
        XCTAssertTrue(shown.stack.first is LegacyHomeViewController)
        XCTAssertFalse(shown.transitioning)
        XCTAssertTrue(shown.fades.isEmpty, "home dissolved behind settings")
        withExtendedLifetime(coordinator) {}
    }

    /// Back and forth between a Happy account and an agent connection,
    /// slowly enough to see. Two different homes, so the dissolve shows;
    /// recorded for the evidence by running this under `simctl io
    /// recordVideo`.
    func testSwitchingBetweenDifferentHomesDissolves() async throws {
        let (account, navigation, _, _, coordinator) = try await app(connection: true)
        let connection = try XCTUnwrap(account.agentConnections.accounts.first?.id)
        let happy = try XCTUnwrap(account.session?.keys.anonID)
        try await Task.sleep(for: .milliseconds(1200))
        for (target, kind) in [(connection, AgentHomeViewController.self as UIViewController.Type), (happy, LegacyHomeViewController.self)] {
            installed = []
            try await account.switchAccount(to: target)
            let arrived = try await until { navigation.viewControllers.count == 1 && type(of: navigation.viewControllers[0]) == kind }
            XCTAssertTrue(arrived, "never reached \(kind): \(navigation.viewControllers)")
            let shown = try XCTUnwrap(installed.last)
            XCTAssertEqual(shown.stack.count, 1)
            XCTAssertFalse(shown.transitioning, "\(kind) was pushed or popped")
            XCTAssertFalse(shown.fades.isEmpty, "\(kind) didn't dissolve in")
            try await Task.sleep(for: .milliseconds(1500))
        }
        withExtendedLifetime(coordinator) {}
    }
}
#endif
