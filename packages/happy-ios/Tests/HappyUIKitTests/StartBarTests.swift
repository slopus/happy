#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// Start hides the navigation bar; whatever takes its place gets it back.
/// A `happy://terminal?` link opened over Start, signed out, made an
/// account whose home replaced Start as the stack's only screen, and that
/// home had no bar (no account switcher, no Settings) until a relaunch.
@MainActor
final class StartBarTests: XCTestCase {
    private func start() -> (UIWindow, UINavigationController) {
        let account = AccountController(serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
                                        credentialStore: InMemoryCredentialStore(), storeDirectory: nil)
        let context = AppContext(account: account, variant: .development, version: "test")
        let navigation = UINavigationController(rootViewController: StartViewController(context: context))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = navigation
        window.isHidden = false
        navigation.view.layoutIfNeeded()
        return (window, navigation)
    }

    /// The stack's root swapped with nothing pushed over Start, as an
    /// account's home replaces it (`AppCoordinator.install`).
    func testTheScreenThatReplacesStartHasTheBar() async throws {
        let (window, navigation) = start()
        defer { window.isHidden = true }
        XCTAssertTrue(navigation.isNavigationBarHidden, "Start shows its own screen, no bar")
        UIView.performWithoutAnimation {
            navigation.setViewControllers([UIViewController()], animated: false)
            navigation.view.layoutIfNeeded()
        }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(navigation.isNavigationBarHidden, "the new home came without its bar")
    }

    /// A screen pushed over Start has the bar, as before.
    func testAScreenPushedOverStartHasTheBar() async throws {
        let (window, navigation) = start()
        defer { window.isHidden = true }
        navigation.pushViewController(UIViewController(), animated: false)
        navigation.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(navigation.isNavigationBarHidden)
    }
}
#endif
