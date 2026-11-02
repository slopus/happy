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

/// What is over the screen, telling how it went.
private final class Cover: UIViewController {
    var leftAnimated: Bool?
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        leftAnimated = animated
    }
}

/// A computer's `happy://direct?` link opened from outside while something
/// is shown over Open Happy on your computer (its ⋯ menu, in the crash the
/// matrix found): what is over the screen goes away, animated, and only
/// then does the pairing screen come in. Pushed under a menu still
/// dismissing, UIKit stopped the app.
@MainActor
final class HostedLinkOverMenuTests: XCTestCase {
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

    private func directLink() throws -> String {
        let bundle: [String: Any] = ["v": 1, "a": "link-over-menu-test", "p": 24781, "t": CanonicalBase64URL.encode(Data(repeating: 3, count: 32)), "n": "Mac", "e": 2_000_000_000_000.0]
        return PairingLink.prefix + CanonicalBase64URL.encode(try JSONSerialization.data(withJSONObject: bundle))
    }

    func testALinkWaitsForWhatIsOverTheScreenToGo() async throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.signIn(Credentials(token: "existing", secret: Data(repeating: 7, count: 32)))
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
        XCTAssertTrue(home, "\(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(500))

        let install = InstallDesktopViewController(context: context)
        navigation.pushViewController(install, animated: false)
        let cover = Cover()
        install.present(cover, animated: false)
        XCTAssertTrue(cover.presentingViewController != nil)

        XCTAssertTrue(coordinator.open(try XCTUnwrap(URL(string: try directLink()))))
        // Nothing is pushed while it is still over the screen.
        XCTAssertTrue(navigation.topViewController === install)
        var pushedUnderIt = false
        let paired = try await until {
            let pushed = navigation.topViewController is AgentPairingViewController
            if pushed, cover.presentingViewController != nil { pushedUnderIt = true }
            return pushed
        }
        XCTAssertTrue(paired, "\(navigation.viewControllers)")
        XCTAssertFalse(pushedUnderIt, "the pairing screen came in under what was over the screen")
        XCTAssertNil(cover.presentingViewController)
        XCTAssertEqual(cover.leftAnimated, true, "put away without its animation")
        XCTAssertNil(window.rootViewController?.presentedViewController)
        await account.signOut()
    }
}
#endif
