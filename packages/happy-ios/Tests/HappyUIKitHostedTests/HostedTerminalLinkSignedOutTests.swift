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

/// A computer's `happy://terminal?` link opened from outside on the first
/// screen, with no account: taken as if pasted into Enter link manually.
/// It asks first, then makes an account that approves the terminal, the
/// same `HappyScan.open` the pasted link goes through; with no server that
/// fails, says so, and keeps no account. (The matrix found Android
/// dropping it without a word; iOS already took it, and this keeps it so.)
@MainActor
final class HostedTerminalLinkSignedOutTests: XCTestCase {
    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func topmost(_ window: UIWindow) -> UIViewController? {
        var top = window.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }

    func testATerminalLinkOnTheFirstScreenAsksThenConnects() async throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.restore()
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
        let started = try await until { window.rootViewController.map(Self.contains(StartViewController.self)) == true }
        XCTAssertTrue(started, "\(String(describing: window.rootViewController))")
        try await Task.sleep(for: .milliseconds(500))

        let link = LegacyPairingLink.terminal(publicKey: Data(repeating: 5, count: 32)).urlString
        XCTAssertTrue(coordinator.open(try XCTUnwrap(URL(string: link))))
        let asked = try await until { (self.topmost(window) as? UIAlertController)?.title == Strings.Modals.authenticateTerminal }
        XCTAssertTrue(asked, "\(String(describing: topmost(window)))")
        let alert = try XCTUnwrap(topmost(window) as? UIAlertController)
        let proceed = try XCTUnwrap(alert.actions.first { $0.title == Strings.Common.continueAction })
        // `UIAlertAction` keeps its handler private; a test reaches it by key.
        typealias Handler = @convention(block) (UIAlertAction) -> Void
        let handler = unsafeBitCast(try XCTUnwrap(proceed.value(forKey: "handler") as AnyObject?), to: Handler.self)
        // Pressed: UIKit puts the alert away, then runs the handler.
        try await Task.sleep(for: .milliseconds(400))
        await withCheckedContinuation { done in alert.dismiss(animated: false) { done.resume() } }
        handler(proceed)

        let failed = try await until(10) { (self.topmost(window) as? UIAlertController)?.message == Strings.Modals.failedToConnectTerminal }
        XCTAssertTrue(failed, "\(String(describing: topmost(window)))")
        XCTAssertNil(account.session, "no account is kept")
    }

    private static func contains(_ type: UIViewController.Type) -> (UIViewController) -> Bool {
        { root in
            var queue = [root]
            while !queue.isEmpty {
                let next = queue.removeFirst()
                if Swift.type(of: next) == type { return true }
                queue += next.children
                if let presented = next.presentedViewController { queue.append(presented) }
            }
            return false
        }
    }
}
#endif
