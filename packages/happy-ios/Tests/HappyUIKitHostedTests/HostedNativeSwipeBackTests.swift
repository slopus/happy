#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct SwipeNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct SwipeNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// The stack goes back by UIKit's own swipe, on every pushed screen: one
/// with its back button hidden or replaced included, which UIKit alone
/// would refuse.
@MainActor
final class HostedNativeSwipeBackTests: XCTestCase {
    private func shell() async throws -> (UIWindow, UINavigationController) {
        let scene = try await hostedActiveScene()
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SwipeNoNetwork(),
            connector: SwipeNoSockets()
        )
        let context = AppContext(account: account, variant: .development, version: "test")
        let navigation = UINavigationController(rootViewController: UIViewController())
        let shell = ShellViewController(context: context, phone: navigation)
        let window = hostedKeyWindow(in: scene, root: shell)
        shell.view.layoutIfNeeded()
        return (window, navigation)
    }

    /// As the app starts: AppCoordinator's window and shell, around the
    /// navigation it made without a root and before its view was loaded.
    /// Both of UIKit's swipes answer to the shell's delegate, on the
    /// phone's stack and the iPad's main panel.
    func testTheAppsOwnStacksHaveTheShellsSwipe() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SwipeNoNetwork(), connector: SwipeNoSockets()
        )
        let context = AppContext(account: account, variant: .development, version: "test")
        let window = UIWindow(windowScene: scene)
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        defer { window.isHidden = true; hostWindow?.makeKey() }
        let shell = try XCTUnwrap(window.rootViewController as? ShellViewController)
        shell.view.layoutIfNeeded()
        for navigation in [shell.phone, shell.main] {
            let edge = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
            XCTAssertTrue(edge.delegate is PopGestureDelegate, "the edge swipe is UIKit's own: \(String(describing: edge.delegate))")
            if #available(iOS 26.0, *) {
                let content = try XCTUnwrap(navigation.interactiveContentPopGestureRecognizer)
                XCTAssertTrue(content.delegate is PopGestureDelegate, "the content swipe is UIKit's own: \(String(describing: content.delegate))")
            }
        }
        withExtendedLifetime(coordinator) {}
    }

    func testTheSystemSwipeIsOnAndMayBeginOnlyWithSomethingToGoBackTo() async throws {
        let (window, navigation) = try await shell()
        defer { window.isHidden = true }
        let gesture = try XCTUnwrap(navigation.interactivePopGestureRecognizer)
        XCTAssertTrue(gesture.isEnabled)
        XCTAssertEqual(gesture.delegate?.gestureRecognizerShouldBegin?(gesture), false, "nothing to go back to at the root")
        let pushed = UIViewController()
        pushed.navigationItem.hidesBackButton = true
        pushed.navigationItem.leftBarButtonItem = UIBarButtonItem(title: "A", primaryAction: UIAction { _ in })
        navigation.pushViewController(pushed, animated: false)
        XCTAssertEqual(gesture.delegate?.gestureRecognizerShouldBegin?(gesture), true, "a hidden back button stopped the swipe")
        if #available(iOS 26.0, *) {
            XCTAssertEqual(navigation.interactiveContentPopGestureRecognizer?.isEnabled, true)
        }
    }
}
#endif
