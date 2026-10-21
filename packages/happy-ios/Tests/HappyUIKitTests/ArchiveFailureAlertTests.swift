#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
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

/// An archive the machine refuses says so after the screen that asked has
/// gone: archiving the open tab swaps the chat for its neighbour before
/// the answer comes. A session that isn't on the store fails at once.
@MainActor
final class ArchiveFailureAlertTests: XCTestCase {
    private func signedIn() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        return controller
    }

    /// A list with a chat pushed on it, in a shown window.
    private func screens() -> (UIWindow, UINavigationController, UIViewController) {
        let chat = UIViewController()
        let navigation = UINavigationController(rootViewController: UIViewController())
        navigation.pushViewController(chat, animated: false)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = navigation
        window.isHidden = false
        navigation.view.layoutIfNeeded()
        return (window, navigation, chat)
    }

    private func until(_ condition: () -> Bool) async throws -> Bool {
        for _ in 0..<500 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    func testTheFailureIsShownOnTheWindowAfterTheChatWasSwappedForItsNeighbour() async throws {
        let controller = try await signedIn()
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, chat) = screens()
        defer { window.isHidden = true }
        XCTAssertNotNil(chat.view.window)

        // As the strip does: the press archives, and the chat is replaced
        // before the machine has answered; nothing keeps the actions.
        var actions: HomeSessionActions? = HomeSessionActions(context: context, session: account, host: chat)
        actions?.archive("gone")
        navigation.setViewControllers([navigation.viewControllers[0], UIViewController()], animated: false)
        actions = nil

        let shown = try await until { navigation.presentedViewController is UIAlertController }
        XCTAssertTrue(shown, "the failure was lost with the screen")
        let alert = navigation.presentedViewController as? UIAlertController
        XCTAssertEqual(alert?.title, Strings.Common.error)
        XCTAssertEqual(alert?.message, Strings.SessionInfo.failedToArchiveSession)
        await controller.signOut()
    }

    func testAnAccountThatIsNoLongerOpenShowsNothing() async throws {
        let controller = try await signedIn()
        let context = AppContext(account: controller, variant: .development, version: "test")
        let (window, navigation, chat) = screens()
        defer { window.isHidden = true }
        let other = try AccountSession(
            credentials: Credentials(token: "o", secret: Data(repeating: 2, count: 32)),
            store: LocalStore.inMemory(),
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: NoNetwork())
        )

        let elsewhere = HomeSessionActions(context: context, session: other, host: chat)
        elsewhere.archive("gone")
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertNil(navigation.presentedViewController)

        // The open account's own failure, in the same window and the same
        // time, is shown.
        let open = HomeSessionActions(context: context, session: try XCTUnwrap(controller.session), host: chat)
        open.archive("gone")
        let shown = try await until { navigation.presentedViewController is UIAlertController }
        XCTAssertTrue(shown)
        withExtendedLifetime((elsewhere, open)) {}
        await controller.signOut()
    }
}
#endif
