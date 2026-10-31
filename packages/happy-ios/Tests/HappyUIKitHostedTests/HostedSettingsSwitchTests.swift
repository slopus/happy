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

/// Tapping another account in Settings' accounts card switches to it in
/// place: Settings stays on top, its contents dissolve into the other
/// profile's where the page was scrolled to, and the new
/// account's home replaces the old one underneath, so back lands there.
/// The picture at the top shows at once, a Happy account's without the
/// pencil. Pictures of before, mid-dissolve and after, light and dark, go
/// to the repository's `.context/evidence/settings-switch`.
@MainActor
final class HostedSettingsSwitchTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/settings-switch")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    /// What is on screen now, animations as far as they have got.
    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let style = window.rootViewController?.traitCollection.userInterfaceStyle ?? window.traitCollection.userInterfaceStyle
        let file = "\(name)-\(style == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
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

    @discardableResult
    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private struct App {
        var account: AccountController
        var coordinator: AppCoordinator
        var navigation: UINavigationController
        var window: UIWindow
        /// The Happy accounts, in the order added.
        var first: AccountSummary.ID
        var second: AccountSummary.ID
        var connection: String?
    }

    /// Two Happy accounts and optionally an agent connection, in a window
    /// the coordinator owns: the second account active, or the first
    /// with a connection.
    private func app(connection: Bool = false) async throws -> App {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        try await account.signIn(Credentials(token: "first", secret: Data(repeating: 5, count: 32)))
        let first = try XCTUnwrap(account.session?.keys.anonID)
        try await account.signIn(Credentials(token: "second", secret: Data(repeating: 6, count: 32)))
        let second = try XCTUnwrap(account.session?.keys.anonID)
        var connectionID: String?
        if connection {
            try await account.addAgentConnection(JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"settings-switch-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)), name: "Mac Studio")
            let id = try XCTUnwrap(account.agentConnections.activeID)
            connectionID = id
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
        return App(account: account, coordinator: coordinator, navigation: navigation, window: window, first: first, second: second, connection: connectionID)
    }

    /// Settings opened from home as the header opens it, with every
    /// account's picture in.
    private func openSettings(_ app: App) async throws -> SettingsViewController {
        let home = try XCTUnwrap(app.navigation.viewControllers.first)
        SettingsViewController.open(context: app.coordinator.context, computer: nil, from: home)
        let settings = try XCTUnwrap(app.navigation.topViewController as? SettingsViewController)
        try await until { app.navigation.transitionCoordinator == nil }
        let ids = app.account.accounts.map { "account:\($0.id)" }
        let pictures = try await until { ids.allSatisfy { settings.shownRow($0)?.image != nil } && settings.agentButton.picture != nil }
        XCTAssertTrue(pictures, "the accounts' pictures never came")
        try await Task.sleep(for: .milliseconds(300))
        return settings
    }

    private func scroll(of settings: SettingsViewController) throws -> UIScrollView {
        try XCTUnwrap(settings.view.subviews.first { $0 is UIScrollView } as? UIScrollView)
    }

    /// The dissolve on Settings' scrolling part, if one is under way.
    private func fade(on view: UIView) -> CATransition? {
        let layer = view.layer
        return (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) as? CATransition }.first { $0.type == .fade }
    }

    /// The account the root's home is for.
    private func homeAccount(_ navigation: UINavigationController) -> String? {
        guard let root = navigation.viewControllers.first else { return nil }
        let fields = Mirror(reflecting: root).children
        if root is LegacyHomeViewController {
            return (fields.first { $0.label == "session" }?.value as? AccountSession)?.keys.anonID
        }
        if root is AgentHomeViewController {
            return fields.first { $0.label == "id" }?.value as? String
        }
        return nil
    }

    /// The picture at the top: there, filled at once, with the pencil only
    /// on a computer's page.
    private func assertPicture(_ settings: SettingsViewController, editable: Bool, _ message: String, line: UInt = #line) {
        let button = settings.agentButton
        XCTAssertFalse(button.isHidden, "\(message): no picture at the top", line: line)
        XCTAssertNotNil(button.picture, "\(message): the picture is blank", line: line)
        XCTAssertGreaterThan(button.frame.width, 0, "\(message): the picture has no room", line: line)
        XCTAssertEqual(button.editable, editable, message, line: line)
        XCTAssertEqual(button.badgeView.isHidden, !editable, "\(message): the pencil", line: line)
        XCTAssertEqual(button.menu != nil, editable, "\(message): the menu", line: line)
    }

    /// Settings is still on top, over the home of `id`, and nothing else.
    private func assertStack(_ app: App, settings: SettingsViewController, home kind: UIViewController.Type, of id: String, line: UInt = #line) {
        let stack = app.navigation.viewControllers
        XCTAssertEqual(stack.count, 2, "\(stack)", line: line)
        XCTAssertTrue(stack.last === settings, "settings isn't on top: \(stack)", line: line)
        XCTAssertTrue(stack.first.map { type(of: $0) == kind } ?? false, "the root isn't \(kind): \(stack)", line: line)
        XCTAssertEqual(homeAccount(app.navigation), id, "the root is another account's home", line: line)
        XCTAssertNil(app.navigation.transitionCoordinator, "something was pushed or popped", line: line)
        XCTAssertNil(app.navigation.presentedViewController, line: line)
        // The edge swipe still goes back.
        let pop = app.navigation.interactivePopGestureRecognizer
        XCTAssertEqual(pop?.isEnabled, true, line: line)
        if let pop { XCTAssertNotEqual(pop.delegate?.gestureRecognizerShouldBegin?(pop), false, "the edge swipe wouldn't begin", line: line) }
    }

    /// Between the two Happy accounts, one way in light and back in dark:
    /// the same kind, so the rows stay, the name, picture and tick dissolve
    /// and the page keeps its place.
    func testSwitchingToAnotherHappyAccountStaysInSettings() async throws {
        let app = try await app()
        let settings = try await openSettings(app)
        let scroll = try scroll(of: settings)
        let bar = app.navigation.navigationBar.frame
        let rows = settings.shownRowIDs.dropFirst()
        XCTAssertEqual(settings.shownProfileID, app.second)
        assertPicture(settings, editable: false, "a Happy account's page")

        for (style, from, to) in [(UIUserInterfaceStyle.light, app.second, app.first), (.dark, app.first, app.second)] {
            // On the shell: each switch sets the window's own from the account's theme.
            app.window.rootViewController?.overrideUserInterfaceStyle = style
            let oldHome = try XCTUnwrap(app.navigation.viewControllers.first)
            let top = -scroll.adjustedContentInset.top
            scroll.setContentOffset(CGPoint(x: 0, y: top + 60), animated: false)
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertEqual(settings.tickedRowIDs, ["account:\(from)"])
            capture(app.window, "happy-to-happy-before")

            settings.tapRow("account:\(to)")
            // At once: the page is the other account's, dissolving in place.
            XCTAssertEqual(settings.shownProfileID, to)
            XCTAssertEqual(settings.tickedRowIDs, ["account:\(to)"], "the tick didn't move")
            let fade = try XCTUnwrap(fade(on: scroll), "the page didn't dissolve")
            XCTAssertEqual(fade.duration, AppCoordinator.rootCrossfade, accuracy: 0.001)
            XCTAssertEqual(scroll.contentOffset.y, top + 60, "the page moved for the same kind")
            XCTAssertEqual(Array(settings.shownRowIDs.dropFirst()), Array(rows), "the rows changed for the same kind")
            assertPicture(settings, editable: false, "mid-switch")
            try await Task.sleep(for: .milliseconds(Int(AppCoordinator.rootCrossfade * 500)))
            capture(app.window, "happy-to-happy-mid")

            let replaced = try await until { app.navigation.viewControllers.first !== oldHome && self.homeAccount(app.navigation) == to }
            XCTAssertTrue(replaced, "home was never replaced: \(app.navigation.viewControllers)")
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertEqual(app.account.session?.keys.anonID, to)
            assertStack(app, settings: settings, home: LegacyHomeViewController.self, of: to)
            XCTAssertEqual(app.navigation.navigationBar.frame, bar, "the bar moved")
            XCTAssertNil(settings.navigationItem.title, "Settings has a title")
            XCTAssertEqual(settings.tickedRowIDs, ["account:\(to)"])
            assertPicture(settings, editable: false, "after the switch")
            capture(app.window, "happy-to-happy-after")
        }

        // Back lands on the new account's home.
        let home = try XCTUnwrap(app.navigation.viewControllers.first)
        app.navigation.popViewController(animated: false)
        XCTAssertTrue(app.navigation.topViewController === home)
        XCTAssertEqual(app.navigation.viewControllers.count, 1)
        XCTAssertEqual(homeAccount(app.navigation), app.second)
        withExtendedLifetime(app.coordinator) {}
    }

    /// A Happy account to a computer in light, and back in dark: the other
    /// kind's rows dissolve in where the page was, the agent's
    /// picture with its pencil, then the account's without.
    func testSwitchingToTheOtherKindStaysInSettings() async throws {
        let app = try await app(connection: true)
        let connection = try XCTUnwrap(app.connection)
        let settings = try await openSettings(app)
        let scroll = try scroll(of: settings)
        let bar = app.navigation.navigationBar.frame
        XCTAssertEqual(settings.shownProfileID, app.first)

        let legs: [(UIUserInterfaceStyle, String, String, Bool, UIViewController.Type, [String])] = [
            (.light, app.first, connection, true, AgentHomeViewController.self, ["profile"]),
            (.dark, connection, app.first, false, LegacyHomeViewController.self, ["account", "backup-restore"]),
        ]
        for (style, from, to, computer, kind, second) in legs {
            // On the shell: each switch sets the window's own from the account's theme.
            app.window.rootViewController?.overrideUserInterfaceStyle = style
            let oldHome = try XCTUnwrap(app.navigation.viewControllers.first)
            let top = -scroll.adjustedContentInset.top
            scroll.setContentOffset(CGPoint(x: 0, y: top + 240), animated: false)
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertEqual(settings.tickedRowIDs, ["account:\(from)"])
            capture(app.window, "kind-switch-\(computer ? "to-computer" : "to-happy")-before")

            settings.tapRow("account:\(to)")
            XCTAssertEqual(settings.shownProfileID, to)
            XCTAssertEqual(settings.shownRowIDs.dropFirst().first, second, "the other kind's rows didn't come")
            let fade = try XCTUnwrap(fade(on: scroll), "the page didn't dissolve")
            XCTAssertEqual(fade.duration, AppCoordinator.rootCrossfade, accuracy: 0.001)
            // Where it was, or the new page's end if that comes sooner.
            let end = max(top, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
            XCTAssertGreaterThan(end, top, "the page is too short to show its place is kept")
            XCTAssertEqual(scroll.contentOffset.y, min(top + 240, end), "the page lost its place")
            assertPicture(settings, editable: computer, "mid-switch")
            try await Task.sleep(for: .milliseconds(Int(AppCoordinator.rootCrossfade * 500)))
            capture(app.window, "kind-switch-\(computer ? "to-computer" : "to-happy")-mid")

            let replaced = try await until { app.navigation.viewControllers.first !== oldHome && self.homeAccount(app.navigation) == to }
            XCTAssertTrue(replaced, "home was never replaced: \(app.navigation.viewControllers)")
            try await Task.sleep(for: .milliseconds(400))
            assertStack(app, settings: settings, home: kind, of: to)
            XCTAssertEqual(app.navigation.navigationBar.frame, bar, "the bar moved")
            XCTAssertEqual(settings.shownRowIDs.dropFirst().first, second)
            XCTAssertEqual(settings.tickedRowIDs, ["account:\(to)"])
            assertPicture(settings, editable: computer, "after the switch")
            capture(app.window, "kind-switch-\(computer ? "to-computer" : "to-happy")-after")
        }

        let home = try XCTUnwrap(app.navigation.viewControllers.first)
        app.navigation.popViewController(animated: false)
        XCTAssertTrue(app.navigation.topViewController === home)
        XCTAssertTrue(home is LegacyHomeViewController)
        XCTAssertEqual(homeAccount(app.navigation), app.first)
        withExtendedLifetime(app.coordinator) {}
    }

    /// Picking an account search found closes search first; the page and
    /// the stack are as a tap in the card leaves them.
    func testSwitchingFromSearchClosesIt() async throws {
        let app = try await app(connection: true)
        let connection = try XCTUnwrap(app.connection)
        let settings = try await openSettings(app)
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        search.isActive = true
        try await until { search.isActive && app.navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(500))
        search.searchBar.text = "Mac"
        settings.updateSearchResults(for: search)
        XCTAssertTrue(settings.shownRowIDs.joined().contains("profile:\(connection)"), "search didn't find the computer: \(settings.shownRowIDs)")
        XCTAssertTrue(settings.navigationItem.hidesBackButton)

        settings.tapRow("profile:\(connection)")
        XCTAssertFalse(search.isActive, "search is still open")
        XCTAssertFalse(settings.navigationItem.hidesBackButton, "back is still aside")
        XCTAssertEqual(settings.shownRowIDs.first?.last, SettingsIndex.connectAgent.id, "the page is still search's")
        XCTAssertEqual(settings.shownRowIDs.dropFirst().first, ["profile"])

        let replaced = try await until { self.homeAccount(app.navigation) == connection }
        XCTAssertTrue(replaced, "home was never replaced: \(app.navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(600))
        assertStack(app, settings: settings, home: AgentHomeViewController.self, of: connection)
        XCTAssertTrue(search.searchBar.text?.isEmpty ?? true)
        assertPicture(settings, editable: true, "after the switch")
        capture(app.window, "search-switch-after")
        withExtendedLifetime(app.coordinator) {}
    }
}
#endif
