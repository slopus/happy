#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
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

/// The iPad's split view in the app's own window (docs/IPAD.md): home in
/// the sidebar, what it opens as the main panel's root, pushes in the main
/// panel; the sidebar hidden and shown; and the one stack rewritten, screen
/// for screen, as the window narrows to a phone's and widens again.
///
/// Runs on an iPad, where AppCoordinator's shell holds the split view.
/// With `HAPPY_PREVIEW_DIR` set, it writes what each state looked like.
@MainActor
final class HostedSplitShellTests: XCTestCase {
    private final class Fades: @unchecked Sendable {
        var seen: [CATransition] = []
    }

    private struct Never: Error, CustomStringConvertible {
        var what: String
        var description: String { "never: \(what)" }
    }

    private struct App {
        var account: AccountController
        var context: AppContext
        var window: UIWindow
        var shell: ShellViewController
        var coordinator: AppCoordinator
        var second: AccountSummary.ID?
    }

    override func setUp() async throws {
        try await super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func until(_ what: String, _ seconds: Double = 5, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        guard condition() else { throw Never(what: what) }
    }

    /// A seeded Happy CLI account (and optionally a second one) in a
    /// window AppCoordinator owns, the scene's whole size.
    private func app(twoAccounts: Bool = false, style: UIUserInterfaceStyle = .light) async throws -> App {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        await account.restore()
        var second: AccountSummary.ID?
        if twoAccounts {
            try await account.signIn(Credentials(token: "other", secret: Data(repeating: 5, count: 32)))
            second = account.session?.keys.anonID
            let store = try XCTUnwrap(account.session?.store)
            try await Task.detached { try SeededAccount.seed(store) }.value
        }
        try await account.signIn(Credentials(token: "split", secret: Data(repeating: 9, count: 32)))
        let store = try XCTUnwrap(account.session?.store)
        try await Task.detached { try SeededAccount.seed(store) }.value
        let context = AppContext(account: account, variant: .preview, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = style
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let shell = try XCTUnwrap(window.rootViewController as? ShellViewController)
        try await until("home in the sidebar") { shell.isExpanded && shell.sidebar.viewControllers.first is LegacyHomeViewController }
        // Restore, which start() runs again, holds the account controller.
        try await Task.sleep(for: .milliseconds(600))
        try await until("the list") { self.home(shell)?.children.contains { $0 is SessionListViewController } == true }
        return App(account: account, context: context, window: window, shell: shell, coordinator: coordinator, second: second)
    }

    private func home(_ shell: ShellViewController) -> LegacyHomeViewController? {
        shell.stack.first as? LegacyHomeViewController
    }

    private func list(_ shell: ShellViewController) -> SessionListViewController? {
        home(shell)?.children.first { $0 is SessionListViewController } as? SessionListViewController
    }

    /// The window `width` wide, as Split View, Slide Over or Stage Manager
    /// leaves it, and laid out.
    private func resize(_ app: App, width: CGFloat) async throws {
        let scene = app.window.bounds.height
        app.window.frame = CGRect(x: 0, y: 0, width: width, height: scene)
        app.window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        app.window.layoutIfNeeded()
    }

    private func settle(_ shell: ShellViewController) async throws {
        try await until("still") { shell.stackTransition == nil }
        try await Task.sleep(for: .milliseconds(50))
    }

    private func capture(_ app: App, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        try await Task.sleep(for: .milliseconds(400))
        let window = app.window
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let device = max(UIScreen.main.bounds.width, UIScreen.main.bounds.height) > 1300 ? "13in" : "11in"
        let style = window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"
        try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("ipad-\(device)-\(name)-\(style).png"))
    }

    // MARK: Selection and the main panel

    func testARowOpensInTheMainPanelAndPushesStayThere() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        XCTAssertEqual(shell.main.viewControllers, [shell.placeholder], "nothing open: the placeholder")
        XCTAssertEqual(shell.stack, [home])
        XCTAssertTrue(shell.showsSidebar)

        // What the list's row does.
        home.push(.session(id: "seeded-main"), context: app.context)
        let chat = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)
        XCTAssertEqual(chat.sessionId, "seeded-main")
        XCTAssertEqual(shell.main.viewControllers, [chat], "the chat is the main panel's root")
        XCTAssertEqual(shell.sidebar.viewControllers, [home], "the sidebar never pushes")
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-main", "its row is selected")
        try await settle(shell)

        // Opened from the chat: pushed in the main panel.
        chat.push(.sessionInfo(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let info = try XCTUnwrap(shell.main.topViewController as? SessionInfoViewController)
        XCTAssertEqual(shell.main.viewControllers, [chat, info])
        XCTAssertEqual(shell.stack, [home, chat, info])
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-main", "the chat's row stays selected under its info")

        // The same row again: back to that chat, not a second copy.
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        XCTAssertEqual(shell.main.viewControllers, [chat])

        // Another row replaces it, and the selection follows.
        home.push(.session(id: "seeded-tab-2"), context: app.context)
        try await settle(shell)
        let other = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)
        XCTAssertEqual(other.sessionId, "seeded-tab-2")
        XCTAssertEqual(shell.main.viewControllers.count, 1)
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-tab-2")
        try await capture(app, "sidebar-chat")

        // Settings from home's bar: the main panel's root, and no row is selected.
        home.push(.settings, context: app.context)
        try await settle(shell)
        XCTAssertTrue(shell.main.viewControllers.first is SettingsViewController)
        XCTAssertEqual(shell.main.viewControllers.count, 1)
        XCTAssertNil(list(shell)?.selectedSessionId)
        try await capture(app, "settings")
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: Hiding the sidebar

    func testTheSidebarHidesAndComesBackAndTheWindowRemembers() async throws {
        let app = try await app()
        let shell = app.shell
        let split = try XCTUnwrap(shell.split)
        let home = try XCTUnwrap(home(shell))
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let chat = try XCTUnwrap(shell.main.viewControllers.first)
        let sidebarWidth = shell.sidebar.view.bounds.width
        XCTAssertGreaterThan(sidebarWidth, 250)
        // The panel starts where the floating sidebar ends.
        XCTAssertEqual(shell.main.view.convert(shell.main.view.bounds, to: app.window), CGRect(x: sidebarWidth, y: 0, width: app.window.bounds.width - sidebarWidth, height: app.window.bounds.height))
        // iOS's own button, at the leading edge of the main panel's bar.
        XCTAssertTrue(shell.wearsToggle(chat), "the main panel has the sidebar's button")
        XCTAssertFalse(shell.wearsToggle(home))

        // The system's own action, as its button and ⌃⌘S send it.
        XCTAssertTrue(split.canPerformAction(#selector(UIResponder.toggleSidebar(_:)), withSender: nil), "the split view takes ⌃⌘S")
        split.toggleSidebar(nil)
        try await until("hidden") { split.displayMode == .secondaryOnly }
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertFalse(shell.showsSidebar)
        XCTAssertEqual(shell.main.view.convert(shell.main.view.bounds, to: app.window), app.window.bounds, "the main panel takes the window")
        XCTAssertTrue(shell.wearsToggle(chat), "the button stays to bring it back")
        XCTAssertEqual(shell.main.viewControllers, [chat], "hiding moved nothing")
        XCTAssertEqual(shell.stack.first, home)
        XCTAssertEqual(app.window.windowScene?.session.userInfo?["happy.sidebarHidden"] as? Bool, true, "the window keeps the choice")
        XCTAssertEqual(split.preferredDisplayMode, .secondaryOnly)
        try await capture(app, "sidebar-hidden")

        // Narrowed and widened again, it stays hidden.
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        try await resize(app, width: UIScreen.main.bounds.width)
        try await until("expanded") { shell.isExpanded }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(split.displayMode, .secondaryOnly, "the window's choice came back")

        split.toggleSidebar(nil)
        try await until("shown") { split.displayMode == .oneBesideSecondary }
        XCTAssertTrue(shell.showsSidebar)
        XCTAssertEqual(app.window.windowScene?.session.userInfo?["happy.sidebarHidden"] as? Bool, false)
        app.window.windowScene?.session.userInfo?["happy.sidebarHidden"] = nil
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: Resizing

    /// Each starting state, narrowed: home at the root, then exactly what
    /// the main panel showed, the same screens; widened: home back in the
    /// sidebar and the rest in the main panel, nothing made again or lost.
    func testNarrowingRewritesOneStackAndWideningSplitsItAgain() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        let wide = app.window.bounds.width

        // Nothing open.
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [home])
        XCTAssertTrue(shell.sidebar.viewControllers.isEmpty)
        XCTAssertEqual(shell.stack, [home])
        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        XCTAssertEqual(shell.main.viewControllers, [shell.placeholder])
        XCTAssertTrue(shell.phone.viewControllers.isEmpty)

        // A chat, with a draft.
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let chat = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [home, chat], "home, then the chat")
        XCTAssertTrue(shell.phone.topViewController === chat)
        XCTAssertEqual(shell.main.viewControllers, [shell.placeholder])
        XCTAssertNil(list(shell)?.selectedSessionId, "on a phone nothing stays selected")
        try await capture(app, "narrow-chat")

        // Pushed while narrow: a profile (session info) over the chat.
        chat.push(.sessionInfo(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let info = try XCTUnwrap(shell.phone.topViewController as? SessionInfoViewController)
        XCTAssertEqual(shell.phone.viewControllers, [home, chat, info])
        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(shell.sidebar.viewControllers, [home], "home back in the sidebar")
        XCTAssertEqual(shell.main.viewControllers, [chat, info], "the chat and its info in the main panel")
        XCTAssertTrue(shell.phone.viewControllers.isEmpty, "nothing left behind on the phone's stack")
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-main", "the selection came back")
        XCTAssertEqual(shell.stack, [home, chat, info])

        // Narrowed again from three deep.
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [home, chat, info])
        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }

        // Settings and a page of it.
        home.push(.settings, context: app.context)
        try await settle(shell)
        let settings = try XCTUnwrap(shell.main.viewControllers.first as? SettingsViewController)
        settings.push(.settingsAppearance, context: app.context)
        try await settle(shell)
        let appearance = try XCTUnwrap(shell.main.topViewController)
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [home, settings, appearance])
        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(shell.main.viewControllers, [settings, appearance])
        XCTAssertNil(list(shell)?.selectedSessionId)
        withExtendedLifetime(app.coordinator) {}
    }

    /// The breakpoint: 768 still splits, 767 is a phone.
    func testTheWindowSplitsFrom768() async throws {
        let app = try await app()
        let shell = app.shell
        try await resize(app, width: 768)
        try await until("split at 768") { shell.isExpanded }
        try await resize(app, width: 767)
        try await until("a phone at 767") { !shell.isExpanded }
        try await resize(app, width: UIScreen.main.bounds.width)
        try await until("split again") { shell.isExpanded }
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: A Happy Agent's home

    private static let rows = [
        Row(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", mark: .happy, isHappy: true, agentId: "agent-happy", spaceId: "happy"),
        Row(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
        Row(id: "space:ios", nodeId: "ios", kind: .space, label: "iPad split view", mark: .glyph("tasks"), agentId: "agent-ios", spaceId: "ios"),
        Row(id: "space:notes", nodeId: "notes", kind: .space, label: "Notes", mark: .glyph("agents"), agentId: "agent-notes", spaceId: "notes"),
    ]

    /// A tapped row's conversation is the main panel's root and its row
    /// stays selected beside it; narrowed, nothing is selected over the
    /// chat; widened, the row is selected again.
    func testAnAgentRowOpensBesideTheSidebarAndStaysSelected() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"split-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await account.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .light
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let shell = try XCTUnwrap(window.rootViewController as? ShellViewController)
        try await until("the agent's home in the sidebar") { shell.isExpanded && shell.sidebar.viewControllers.first is AgentHomeViewController }
        let agentHome = try XCTUnwrap(shell.sidebar.viewControllers.first as? AgentHomeViewController)
        let home = try XCTUnwrap(agentHome.children.first as? HomeViewController)
        XCTAssertTrue(agentHome.traitCollection.isSidebarColumn)
        XCTAssertEqual(agentHome.view.backgroundColor, .clear, "the system's sidebar shows through")
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.rows = Self.rows
        snapshot.allRows = Self.rows
        // The computer's own first snapshot, empty here, may land after
        // ours; the rows are drawn off the main thread before they show.
        try await until("the rows mounted") {
            if home.homeList.rows.isEmpty { home.applyConnection(snapshot) }
            home.view.layoutIfNeeded()
            return home.homeList.view(for: "space:ios") != nil
        }
        let row = try XCTUnwrap(home.homeList.view(for: "space:ios"))
        home.homeList.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
        try await settle(shell)
        XCTAssertTrue(shell.main.viewControllers.first is ChatViewController, "\(shell.main.viewControllers)")
        XCTAssertEqual(shell.main.viewControllers.count, 1)
        XCTAssertEqual(shell.sidebar.viewControllers, [agentHome])
        XCTAssertEqual(home.homeList.selectedRowId, "space:ios")
        let chat = try XCTUnwrap(shell.main.viewControllers.first)

        // The same row again: still that one chat.
        home.homeList.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
        try await settle(shell)
        XCTAssertEqual(shell.main.viewControllers, [chat])

        // Narrowed: home, then the chat; nothing selected under it.
        let wide = window.bounds.width
        window.frame = CGRect(x: 0, y: 0, width: 700, height: window.bounds.height)
        window.layoutIfNeeded()
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [agentHome, chat])
        XCTAssertNil(home.homeList.selectedRowId)

        // Widened: the row is selected again.
        window.frame = CGRect(x: 0, y: 0, width: wide, height: window.bounds.height)
        window.layoutIfNeeded()
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(shell.main.viewControllers, [chat])
        XCTAssertEqual(home.homeList.selectedRowId, "space:ios")

        // Compose: new work is the main panel's root, and no row is selected.
        agentHome.compose()
        try await until("new work") { (shell.main.viewControllers.first as? ChatViewController).map { $0 !== chat } ?? false }
        XCTAssertNil(home.homeList.selectedRowId)
        withExtendedLifetime(coordinator) {}
    }

    // MARK: Accounts and links

    func testSwitchingAccountsDissolvesTheSplitIntoTheOtherHome() async throws {
        let app = try await app(twoAccounts: true)
        let shell = app.shell
        let split = try XCTUnwrap(shell.split)
        let old = try XCTUnwrap(home(shell))
        old.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let fades = Fades()
        let token = NotificationCenter.default.addObserver(forName: AppCoordinator.rootDidChange, object: app.window, queue: nil) { [weak split] _ in
            MainActor.assumeIsolated {
                guard let layer = split?.view.layer else { return }
                fades.seen = (layer.animationKeys() ?? []).compactMap { layer.animation(forKey: $0) as? CATransition }.filter { $0.type == .fade }
            }
        }
        defer { NotificationCenter.default.removeObserver(token) }
        try await app.account.switchAccount(to: try XCTUnwrap(app.second))
        try await until("the other home") { self.home(shell) != nil && self.home(shell) !== old }
        XCTAssertTrue(shell.isExpanded)
        XCTAssertEqual(shell.sidebar.viewControllers.count, 1)
        XCTAssertEqual(shell.main.viewControllers, [shell.placeholder], "nothing of the other account stays open")
        XCTAssertFalse(fades.seen.isEmpty, "the split didn't dissolve")
        XCTAssertNil(shell.stackTransition, "nothing was pushed or popped")
        withExtendedLifetime(app.coordinator) {}
    }

    func testANotificationOpensItsChatInTheMainPanel() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        app.coordinator.openSession(fromNotification: "seeded-tab-3")
        try await until("the chat") { (shell.main.viewControllers.first as? LegacyChatViewController)?.sessionId == "seeded-tab-3" }
        try await settle(shell)
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        XCTAssertEqual(shell.main.viewControllers.count, 1)
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-tab-3")
        withExtendedLifetime(app.coordinator) {}
    }

    func testSigningOutGivesTheWholeWindowToTheFirstScreen() async throws {
        let app = try await app()
        let shell = app.shell
        home(shell)?.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        await app.account.signOut()
        try await until("the first screen") { shell.stack.first is StartViewController }
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers.count, 1)
        XCTAssertTrue(shell.sidebar.viewControllers.isEmpty)
        XCTAssertEqual(shell.phone.view.convert(shell.phone.view.bounds, to: app.window), app.window.bounds, "onboarding owns the window")
        withExtendedLifetime(app.coordinator) {}
    }
}
#endif
