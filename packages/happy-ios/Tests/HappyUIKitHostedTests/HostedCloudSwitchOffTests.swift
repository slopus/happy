#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
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

/// Settings' Happy Cloud switch only hides Happy Cloud's ways in (Kirill):
/// in the App Store app, with it off, a Cloud flow reached anyway opens,
/// and signing out of Happy Cloud stays in the account menu.
@MainActor
final class HostedCloudSwitchOffTests: XCTestCase {
    override func setUp() async throws {
        let defaults = UserDefaults.standard
        let kept = defaults.object(forKey: "happy-cloud")
        addTeardownBlock { @MainActor in
            defaults.set(kept, forKey: "happy-cloud")
            CloudScreens.account = nil
            CloudScreens.pendingJoin = nil
            CloudScreens.inviteHTTP = NoRedirectURLSessionTransport()
        }
        // An invite's preview goes nowhere from a test.
        CloudScreens.inviteHTTP = NoNetwork()
        HappyCloud.setOffered(false)
        XCTAssertFalse(HappyCloud.isOffered(in: .production))
    }

    private func controller(agentTransport: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport = { _ in Unreachable() }) -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: agentTransport,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets()
        )
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    func testASignedOutCloudServerSignsInAgain() async throws {
        let controller = controller()
        await controller.agentConnections.setForeground(false)
        let origin = HappyCloud.server(named: "switch-off-test")
        let record = ServerSignInRecord(method: HappyCloud.method(server: origin), grant: OAuthGrant(refreshToken: "r1", clientId: "happy"), userId: "u1")
        let server = try await controller.agentConnections.addServer(try AgentOrigin(origin), signIn: record,
                                                                     access: OAuthAccess(token: "a1", expiresAt: nil), name: "switch-off-test")
        addTeardownBlock { @MainActor in
            controller.cancelAddingAccount()
            Session.forget(server.id)
            try? await controller.agentConnections.remove(server.id)
        }
        let context = AppContext(account: controller, variant: .production, version: "test")
        let home = AgentHomeViewController(context: context, id: server.id)
        let navigation = UINavigationController(rootViewController: home)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()

        let credential = try XCTUnwrap(controller.agentConnections.credential(for: server.id))
        await controller.agentConnections.authorization(credential, for: server.id).signInRequired()
        let signedOut = try await until { home.showsSignedOut }
        XCTAssertTrue(signedOut, "home still shows the server")
        let view = try XCTUnwrap(home.view.subviews.compactMap { $0 as? ServerSignedOutView }.first)

        view.button.sendActions(for: .primaryActionTriggered)
        let opened = try await until { home.presentedViewController is CloudNavigationController }
        XCTAssertTrue(opened, "Sign In did nothing: \(String(describing: home.presentedViewController))")
        let flow = try XCTUnwrap(home.presentedViewController as? CloudNavigationController)
        XCTAssertTrue(flow.viewControllers.first is CloudWelcomeViewController, "\(flow.viewControllers)")
    }

    func testAnInviteLinkThatReachesTheAppOpens() async throws {
        let account = controller()
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.signIn(Credentials(token: "t", secret: Data(repeating: 5, count: 32)))
        addTeardownBlock { @MainActor in account.cancelAddingAccount() }
        let context = AppContext(account: account, variant: .production, version: "test")
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
        let home = try await until { window.rootViewController != nil && Self.top(of: window) is LegacyHomeViewController }
        XCTAssertTrue(home, "the window never showed home")
        try await Task.sleep(for: .milliseconds(600))

        // Both forms of the link, with the switch off, in the App Store
        // app: each opens on the invite itself, shown before any sign-in,
        // and a newer one takes the place of the one on screen.
        func shown() -> CloudInviteViewController? {
            let flow = window.rootViewController?.presentedViewController as? CloudNavigationController
            return flow.flatMap { $0.isBeingDismissed ? nil : $0.viewControllers.first as? CloudInviteViewController }
        }
        let token = "q7Xk2_bN-9vLmR4tY8wE1zA6sD3fG5hJ0kP2oI9uYtR"
        let universal = try XCUnwrapURL("https://\(HappyCloud.web)/join#\(token)")
        XCTAssertTrue(coordinator.open(universal), "the invite was refused")
        let opened = try await until { shown()?.viewIfLoaded?.window != nil }
        XCTAssertTrue(opened, "the invite opened nothing")
        let first = try XCTUnwrap(shown())
        let asked = try await until { first.phase != .loading }
        XCTAssertTrue(asked, "the invite never asked what it offers")
        XCTAssertEqual(first.phase, .failed(Strings.HappyCloud.unreachable), "shown at once, signed out, from the API (out of reach here)")
        XCTAssertNil(CloudScreens.account)
        XCTAssertNil(CloudScreens.pendingJoin, "opening a link joins nothing and keeps nothing to join later")

        // The web page's Open in Happy; here without a token that could be
        // one, so it is refused with nothing asked.
        let scheme = try XCUnwrapURL("happy://cloud/join#short")
        XCTAssertTrue(coordinator.open(scheme), "happy://cloud/join isn't the app's")
        let replaced = try await until { shown().map { $0 !== first && $0.viewIfLoaded?.window != nil } ?? false }
        XCTAssertTrue(replaced, "the second link didn't take the first's place")
        XCTAssertEqual(shown()?.phase, .refused(.invalid))
        XCTAssertEqual(shown()?.primary.title, Strings.CloudConnect.inviteClose)

        // Another page of the web host, and its servers' web apps, aren't invites.
        for other in ["https://\(HappyCloud.web)/", "https://acme.\(HappyCloud.web)/join#\(token)"] {
            XCTAssertFalse(coordinator.open(try XCUnwrapURL(other)), other)
        }
        withExtendedLifetime(coordinator) {}
    }

    func testTheAccountMenuKeepsSigningOutOfHappyCloud() async throws {
        let account = controller()
        await account.agentConnections.setForeground(false)
        try await account.signIn(Credentials(token: "t", secret: Data(repeating: 6, count: 32)))
        let context = AppContext(account: account, variant: .production, version: "test")
        let switcher = AccountSwitcher(context: context, controller: UIViewController())
        func ways() -> [UIMenuElement] { (switcher.menuElements().last as? UIMenu)?.children ?? [] }
        let actions = { ways().compactMap { ($0 as? UIAction)?.accessibilityIdentifier } }

        // The way in is hidden; the way out is the deferred element, which
        // shows only while the account's session is held.
        XCTAssertEqual(actions(), ["account-add"])
        XCTAssertEqual(ways().count, 2, "no Sign Out of Happy Cloud with the switch off")
        XCTAssertTrue(ways().last is UIDeferredMenuElement)
        XCTAssertTrue(AccountSwitcher.cloudSignOut().isEmpty, "signed out, yet it offers signing out")
        CloudScreens.account = CloudAccount.preview(token: "account", http: NoNetwork())
        let signOut = try XCTUnwrap(AccountSwitcher.cloudSignOut().first as? UIAction)
        XCTAssertEqual(signOut.accessibilityIdentifier, "account-cloud-sign-out")
        XCTAssertEqual(signOut.title, Strings.HappyCloud.signOut)

        HappyCloud.setOffered(true)
        XCTAssertEqual(actions(), ["account-add", "account-cloud"])
        XCTAssertEqual(ways().count, 3)
    }

    private func XCUnwrapURL(_ text: String) throws -> URL { try XCTUnwrap(URL(string: text), text) }

    private static func top(of window: UIWindow) -> UIViewController? {
        var queue = [window.rootViewController].compactMap { $0 }
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let navigation = next as? UINavigationController { return navigation.viewControllers.first }
            queue += next.children
        }
        return nil
    }
}
#endif
