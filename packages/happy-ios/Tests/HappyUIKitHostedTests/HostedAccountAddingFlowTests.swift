#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A flow that added an account ends over the new account's home, with no
/// glimpse of the old one and no push forward (Steve, preview 103: "it
/// shows old account after authenticating and getting back to the home.
/// also it navigates forward"). Presented full screen, as Happy Cloud is,
/// the new home goes in under it first and the flow is then dismissed,
/// animated, over it. Pushed on the stack, it dissolves into the new home.
@MainActor
final class HostedAccountAddingFlowTests: XCTestCase {
    /// The window at the moment the new root went in.
    private struct Installed {
        var stack: [UIViewController]
        var presented: UIViewController?
        var presentedLeaving: Bool
        var transitioning: Bool
        /// The only transition under way is the flow leaving, if any.
        var onlyFlowLeaving: Bool
        var fades: Int
    }

    @MainActor
    private final class Roots {
        var installed: [Installed] = []
        nonisolated(unsafe) private var token: NSObjectProtocol?

        init(window: UIWindow, navigation: UINavigationController) {
            token = NotificationCenter.default.addObserver(forName: AppCoordinator.rootDidChange, object: window, queue: nil) { [weak self, weak navigation, weak window] _ in
                MainActor.assumeIsolated {
                    guard let self, let navigation else { return }
                    let layer = navigation.view.layer
                    let fades = (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) as? CATransition }.filter { $0.type == .fade }.count
                    let presented = window?.rootViewController?.presentedViewController
                    let coordinator = navigation.transitionCoordinator
                    let leaving = coordinator.map { $0.viewController(forKey: .from) === presented && presented != nil } ?? true
                    self.installed.append(Installed(stack: navigation.viewControllers, presented: presented, presentedLeaving: presented?.isBeingDismissed ?? false,
                                                    transitioning: coordinator != nil, onlyFlowLeaving: leaving, fades: fades))
                }
            }
        }

        deinit { if let token { NotificationCenter.default.removeObserver(token) } }
    }

    private var roots: Roots?

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

    /// Two Happy accounts, the second open, in a window the coordinator owns.
    private func app() async throws -> (AccountController, UINavigationController, UIWindow, first: AccountSummary.ID, AppContext, AppCoordinator) {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.signIn(Credentials(token: "first", secret: Data(repeating: 3, count: 32)))
        let first = try XCTUnwrap(account.session?.keys.anonID)
        try await account.signIn(Credentials(token: "second", secret: Data(repeating: 4, count: 32)))
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
        try await Task.sleep(for: .milliseconds(600))
        roots = Roots(window: window, navigation: navigation)
        return (account, navigation, window, first, context, coordinator)
    }

    func testAPresentedFlowLeavesOverTheNewHome() async throws {
        let (account, navigation, window, first, context, coordinator) = try await app()
        let old = try XCTUnwrap(navigation.viewControllers.first)
        let flow = CloudNavigationController(rootViewController: CloudWelcomeViewController(context: context))
        flow.modalPresentationStyle = .fullScreen
        old.present(flow, animated: false)
        XCTAssertTrue(window.rootViewController?.presentedViewController === flow)

        try await account.switchAccount(to: first)
        let replaced = try await until { navigation.viewControllers.first !== old }
        XCTAssertTrue(replaced, "home was never replaced: \(navigation.viewControllers)")
        XCTAssertEqual(account.session?.keys.anonID, first, "the account the flow added is the one open")

        let shown = try XCTUnwrap(roots?.installed.last, "the root never went in")
        XCTAssertEqual(shown.stack.count, 1, "\(shown.stack)")
        XCTAssertTrue(shown.stack.first is LegacyHomeViewController)
        XCTAssertFalse(shown.stack.first === old, "the old home was still under the flow")
        XCTAssertTrue(shown.presented === flow, "the flow went before the new home was in")
        XCTAssertTrue(shown.presentedLeaving, "the flow wasn't dismissed over the new home")
        XCTAssertTrue(shown.onlyFlowLeaving, "something besides the flow leaving was animating: the new home was pushed")
        XCTAssertEqual(shown.fades, 0, "the old home dissolved into the new one in view")
        let gone = try await until { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(gone, "the flow stayed")
        XCTAssertEqual(navigation.viewControllers.count, 1)
        withExtendedLifetime(coordinator) {}
    }

    func testAPushedFlowDissolvesIntoTheNewHome() async throws {
        let (account, navigation, _, first, context, coordinator) = try await app()
        let old = try XCTUnwrap(navigation.viewControllers.first)
        navigation.pushViewController(CloudWelcomeViewController(context: context), animated: false)
        XCTAssertEqual(navigation.viewControllers.count, 2)

        try await account.switchAccount(to: first)
        let replaced = try await until { navigation.viewControllers.first !== old && navigation.viewControllers.count == 1 }
        XCTAssertTrue(replaced, "the stack never became the new home: \(navigation.viewControllers)")
        XCTAssertEqual(account.session?.keys.anonID, first)
        let shown = try XCTUnwrap(roots?.installed.last)
        XCTAssertEqual(shown.stack.count, 1, "\(shown.stack)")
        XCTAssertTrue(shown.stack.first is LegacyHomeViewController)
        XCTAssertFalse(shown.transitioning, "the new home was pushed forward")
        XCTAssertGreaterThan(shown.fades, 0, "the flow didn't dissolve into the new home")
        withExtendedLifetime(coordinator) {}
    }
}
#endif
