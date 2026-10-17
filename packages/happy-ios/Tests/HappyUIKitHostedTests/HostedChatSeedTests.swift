#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
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

/// A chat projects the newest home snapshot off main during navigation.
/// Its observations start from that seed and an equal answer changes nothing.
@MainActor
final class HostedChatSeedTests: XCTestCase {
    private func signedIn() async throws -> (AccountController, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 3, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { try SeededAccount.seed(store) }.value
        // Home, under every chat, keeps the account's home feed read.
        let home = Task { for await _ in account.homeFeed.snapshots() {} }
        addTeardownBlock { home.cancel() }
        let read = try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        XCTAssertTrue(read, "home never read the store")
        return (controller, account)
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    func testAChatPushesItsShellThenBuildsTheHeaderAndTabs() async throws {
        let (controller, _) = try await signedIn()
        let context = AppContext(account: controller, variant: .development, version: "test")
        let chat = ChatViewController(context: context, session: try XCTUnwrap(controller.session), sessionId: "seeded-tab-4")
        chat.loadViewIfNeeded()
        XCTAssertEqual(chat.navigationItem.title, "Scroll indicator")
        XCTAssertNil(Self.subview(AgentInputCardView.self, in: chat.view))
        let scene = try await hostedActiveScene()
        let original = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        defer { window.isHidden = true; original?.makeKey() }
        let installed = try await until { chat.contentInstalled && chat.navigationItem.title == "chat-nav" }
        XCTAssertTrue(installed)
        XCTAssertEqual(chat.navigationItem.title, "chat-nav", "the header names the checkout")
        let avatar = chat.navigationItem.rightBarButtonItems?.compactMap { $0.customView as? ChatHeaderAvatarControl }.first
        XCTAssertEqual(avatar?.isHidden, false, "the avatar")
        XCTAssertNotNil(avatar?.content)
        let strip = try XCTUnwrap(Self.subview(ChatWorktreeTabStrip.self, in: chat.view))
        XCTAssertFalse(strip.isHidden, "the strip")

        // The store's own answer agrees with the background seed.
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(chat.sessionUpdates, 0, "the store's record changed the screen")
        XCTAssertEqual(chat.navigationItem.title, "chat-nav")
        await controller.signOut()
    }

    /// The seed is worked out on the main thread as the chat is made: how
    /// long it takes over a home of 1,000 sessions in 50 projects, 20 of
    /// them tabs of the chat's checkout. Printed for the timing log.
    func testHowLongTheSeedTakesOverALargeHome() async throws {
        let (controller, account) = try await signedIn()
        var snapshot = try XCTUnwrap(account.homeFeed.latest)
        let model = try XCTUnwrap(snapshot.sessions.first { $0.id == "seeded-tab-1" })
        let worktree = model.metadata?["path"]?.stringValue ?? ""
        for index in 0..<1000 {
            var record = model
            record.id = "bulk-\(index)"
            if case .object(var fields)? = record.metadata {
                fields["path"] = .string(index < 20 ? worktree : "/Users/harness/project-\(index % 50)")
                record.metadata = .object(fields)
            }
            record.createdAt = model.createdAt - Int64(index) - 1
            snapshot.sessions.append(record)
        }
        var times: [Double] = []
        var tabs = 0
        for _ in 0..<20 {
            let start = CACurrentMediaTime()
            let seed = ChatServices.seed(snapshot, sessionId: "seeded-tab-1")
            times.append((CACurrentMediaTime() - start) * 1000)
            XCTAssertNotNil(seed.session.record)
            tabs = seed.checkout?.tabs.count ?? 0
        }
        XCTAssertEqual(tabs, 24, "the bulk tabs joined the checkout")
        let sorted = times.sorted()
        print(String(
            format: "SEED over %d sessions, %d tabs: median %.2f ms, slowest %.2f ms",
            snapshot.sessions.count, tabs, sorted[sorted.count / 2], sorted.last ?? 0
        ))
        await controller.signOut()
    }

    static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }
}
#endif
