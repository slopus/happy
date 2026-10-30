#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct SwipeNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct SwipeNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

/// The app's stack goes back by the finger from anywhere, with the
/// thresholds in `SwipeBack`: UIKit's edge gesture is off, so nothing
/// competes, and a hidden bar can't switch it off again.
@MainActor
final class HostedSwipeBackTests: XCTestCase {
    private final class Refusing: UIViewController, SwipeBackRefusing {
        var allowsSwipeBack = false
    }

    private func shell() async throws -> (UIWindow, TabletShellViewController, UINavigationController) {
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
        let shell = TabletShellViewController(context: context, detail: navigation)
        let window = hostedKeyWindow(in: scene, root: shell)
        shell.view.layoutIfNeeded()
        return (window, shell, navigation)
    }

    private func settle(_ condition: () -> Bool) async throws -> Bool {
        for _ in 0..<300 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    func testUIKitsEdgeGestureIsOffAndOursIsOnTheStack() async throws {
        let (window, shell, navigation) = try await shell()
        defer { window.isHidden = true }
        let swipe = try XCTUnwrap(shell.swipeBack)
        XCTAssertEqual(navigation.interactivePopGestureRecognizer?.isEnabled, false)
        XCTAssertTrue(navigation.view.gestureRecognizers?.contains(swipe.gesture) == true)
        // Nothing to go back to at the root.
        XCTAssertFalse(swipe.gestureRecognizerShouldBegin(swipe.gesture))
    }

    func testLettingGoPastAThirdGoesBack() async throws {
        let (window, shell, navigation) = try await shell()
        defer { window.isHidden = true }
        navigation.pushViewController(UIViewController(), animated: false)
        let swipe = try XCTUnwrap(shell.swipeBack)
        swipe.begin()
        XCTAssertTrue(swipe.isInteractive)
        swipe.update(translation: window.bounds.width * 0.5)
        swipe.end(translation: window.bounds.width * 0.5, velocity: 0, lifted: true)
        let popped = try await settle { navigation.viewControllers.count == 1 && navigation.transitionCoordinator == nil }
        XCTAssertTrue(popped)
    }

    func testLettingGoShortOfAThirdStays() async throws {
        let (window, shell, navigation) = try await shell()
        defer { window.isHidden = true }
        let pushed = UIViewController()
        navigation.pushViewController(pushed, animated: false)
        let swipe = try XCTUnwrap(shell.swipeBack)
        swipe.begin()
        swipe.update(translation: window.bounds.width * 0.3)
        swipe.end(translation: window.bounds.width * 0.3, velocity: 1000, lifted: true)
        let settled = try await settle { navigation.transitionCoordinator == nil }
        XCTAssertTrue(settled)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        XCTAssertTrue(navigation.topViewController === pushed)
        XCTAssertEqual(pushed.view.transform, .identity)
    }

    func testAFlickGoesBackFromNearTheStart() async throws {
        let (window, shell, navigation) = try await shell()
        defer { window.isHidden = true }
        navigation.pushViewController(UIViewController(), animated: false)
        let swipe = try XCTUnwrap(shell.swipeBack)
        swipe.begin()
        swipe.update(translation: 30)
        swipe.end(translation: 30, velocity: 1400, lifted: true)
        let popped = try await settle { navigation.viewControllers.count == 1 && navigation.transitionCoordinator == nil }
        XCTAssertTrue(popped)
    }

    func testAScreenThatRefusesIsNotSwipedAway() async throws {
        let (window, shell, navigation) = try await shell()
        defer { window.isHidden = true }
        navigation.pushViewController(Refusing(), animated: false)
        let swipe = try XCTUnwrap(shell.swipeBack)
        XCTAssertFalse(swipe.gestureRecognizerShouldBegin(swipe.gesture))
    }
}
#endif
