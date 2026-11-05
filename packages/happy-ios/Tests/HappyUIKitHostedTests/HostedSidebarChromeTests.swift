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

/// The iPad sidebar's chrome (docs/IPAD.md, The sidebar): its ground,
/// search in the list, and settings and compose in the bar at its foot,
/// for both kinds of home; narrowed to one stack, the phone's chrome.
///
/// With `HAPPY_PREVIEW_DIR` set, it writes what each state looked like.
@MainActor
final class HostedSidebarChromeTests: XCTestCase {
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
        /// The window's style. The coordinator applies the account's theme
        /// at start and again on restore, so it is pinned before each look.
        var style: UIUserInterfaceStyle
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

    private func controller() async -> AccountController {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        return account
    }

    private func start(_ account: AccountController, style: UIUserInterfaceStyle) async throws -> App {
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
        let shell = try XCTUnwrap(window.rootViewController as? ShellViewController)
        return App(account: account, context: context, window: window, shell: shell, coordinator: coordinator, style: style)
    }

    /// A seeded Happy CLI account, its home in the sidebar.
    private func legacyApp(style: UIUserInterfaceStyle = .light) async throws -> App {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        let account = await controller()
        await account.restore()
        try await account.signIn(Credentials(token: "chrome", secret: Data(repeating: 11, count: 32)))
        let store = try XCTUnwrap(account.session?.store)
        try await Task.detached { try SeededAccount.seed(store) }.value
        let app = try await start(account, style: style)
        try await until("home in the sidebar") { app.shell.isExpanded && app.shell.sidebar.viewControllers.first is LegacyHomeViewController }
        // Restore, which start() runs again, holds the account controller.
        try await Task.sleep(for: .milliseconds(600))
        try await until("the list") { self.legacyHome(app.shell)?.children.contains { $0 is SessionListViewController } == true }
        return app
    }

    private static let rows = [
        Row(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", mark: .happy, isHappy: true, agentId: "agent-happy", spaceId: "happy"),
        Row(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
        Row(id: "space:ios", nodeId: "ios", kind: .space, label: "iPad split view", mark: .glyph("tasks"), agentId: "agent-ios", spaceId: "ios"),
        Row(id: "space:notes", nodeId: "notes", kind: .space, label: "Notes", mark: .glyph("agents"), agentId: "agent-notes", spaceId: "notes"),
        Row(id: "space:docs", nodeId: "docs", kind: .space, label: "Release notes", mark: .glyph("tasks"), agentId: "agent-docs", spaceId: "docs"),
    ]

    /// A Happy Agent account, its home in the sidebar with `rows`.
    private func agentApp(style: UIUserInterfaceStyle = .light, rows: [Row] = HostedSidebarChromeTests.rows) async throws -> App {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        let account = await controller()
        let computer = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"chrome-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await account.agentConnections.remove(computer.id)
        }
        let app = try await start(account, style: style)
        try await until("the agent's home in the sidebar") { app.shell.isExpanded && app.shell.sidebar.viewControllers.first is AgentHomeViewController }
        let home = try XCTUnwrap(agentHome(app.shell)?.children.first as? HomeViewController)
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.rows = rows
        snapshot.allRows = rows
        try await until("the rows mounted") {
            if home.homeList.rows.isEmpty { home.applyConnection(snapshot) }
            home.view.layoutIfNeeded()
            return home.homeList.view(for: "space:ios") != nil
        }
        return app
    }

    private func legacyHome(_ shell: ShellViewController) -> LegacyHomeViewController? {
        shell.stack.first as? LegacyHomeViewController
    }

    private func agentHome(_ shell: ShellViewController) -> AgentHomeViewController? {
        shell.stack.first as? AgentHomeViewController
    }

    private func settle(_ shell: ShellViewController) async throws {
        try await until("still") { shell.stackTransition == nil }
        try await Task.sleep(for: .milliseconds(50))
    }

    private func resize(_ app: App, width: CGFloat) async throws {
        app.window.frame = CGRect(x: 0, y: 0, width: width, height: app.window.bounds.height)
        app.window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        app.window.layoutIfNeeded()
    }

    private func capture(_ app: App, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        try await Task.sleep(for: .milliseconds(500))
        let window = app.window
        window.overrideUserInterfaceStyle = app.style
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        let device = max(UIScreen.main.bounds.width, UIScreen.main.bounds.height) > 1300 ? "13in" : "11in"
        let style = app.style == .dark ? "dark" : "light"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        // The screen as composited, glass included: a script outside takes
        // it with `simctl io screenshot` and removes the marker.
        if ProcessInfo.processInfo.environment["HAPPY_SCREEN_SHOTS"] != nil {
            window.makeKeyAndVisible()
            let marker = URL(fileURLWithPath: directory).appendingPathComponent("ipad-\(device)-\(name)-\(style).shoot")
            try Data().write(to: marker)
            let deadline = ContinuousClock.now + .seconds(15)
            while FileManager.default.fileExists(atPath: marker.path), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            return
        }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("ipad-\(device)-\(name)-\(style).png"))
    }

    // MARK: Evidence

    private func captureLegacy(_ style: UIUserInterfaceStyle) async throws {
        let app = try await legacyApp(style: style)
        try await capture(app, "cli-sidebar")
        legacyHome(app.shell)?.push(.session(id: "seeded-main"), context: app.context)
        try await settle(app.shell)
        try await capture(app, "cli-sidebar-chat")
        legacyHome(app.shell)?.push(.settings, context: app.context)
        try await settle(app.shell)
        try await capture(app, "cli-sidebar-settings")
        try await resize(app, width: 700)
        try await until("collapsed") { !app.shell.isExpanded }
        try await capture(app, "cli-narrow")
        withExtendedLifetime(app.coordinator) {}
    }

    private func captureAgent(_ style: UIUserInterfaceStyle) async throws {
        let app = try await agentApp(style: style)
        try await capture(app, "agent-sidebar")
        let home = try XCTUnwrap(agentHome(app.shell)?.children.first as? HomeViewController)
        let row = try XCTUnwrap(home.homeList.view(for: "space:ios"))
        home.homeList.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
        try await settle(app.shell)
        try await capture(app, "agent-sidebar-chat")
        try await resize(app, width: 700)
        try await until("collapsed") { !app.shell.isExpanded }
        try await capture(app, "agent-narrow")
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: The ground

    /// The floating sidebar sits over the chat's own ground, light and
    /// dark, and home leaves its own clear. Beside it the main panel's
    /// screens go without iOS's soft top edge, which stopped in a line at
    /// the panel's edge; with the sidebar hidden it comes back.
    func testTheSidebarFloatsOverTheChatsGround() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let app = try await agentApp(style: style)
            let shell = app.shell
            let agentHome = try XCTUnwrap(agentHome(shell))
            let home = try XCTUnwrap(agentHome.children.first as? HomeViewController)
            try openRow("space:ios", in: home)
            try await settle(shell)
            let chat = try XCTUnwrap(shell.main.viewControllers.first as? ChatViewController)
            let column = try XCTUnwrap(shell.main.view.superview)
            app.window.overrideUserInterfaceStyle = style
            let traits = app.window.traitCollection
            XCTAssertEqual(traits.userInterfaceStyle, style)
            XCTAssertEqual(column.backgroundColor?.resolvedColor(with: traits), chat.view.backgroundColor?.resolvedColor(with: traits), "the ground behind the sidebar is the chat's")
            XCTAssertEqual(agentHome.view.backgroundColor, .clear)
            XCTAssertEqual(home.view.backgroundColor, .clear)

            guard #available(iOS 26.0, *) else { continue }
            let edges = scrollViews(in: chat.view)
            XCTAssertFalse(edges.isEmpty)
            XCTAssertTrue(edges.allSatisfy(\.topEdgeEffect.isHidden), "no soft top edge beside the sidebar")
            shell.setSidebarHidden(true)
            try await until("the shade back with the sidebar hidden") { edges.allSatisfy { !$0.topEdgeEffect.isHidden } }
            shell.setSidebarHidden(false)
            try await until("gone again beside it") { edges.allSatisfy(\.topEdgeEffect.isHidden) }
            try await resize(app, width: 700)
            try await until("collapsed") { !shell.isExpanded }
            XCTAssertTrue(edges.allSatisfy { !$0.topEdgeEffect.isHidden }, "a phone's chat keeps it")
            app.window.windowScene?.session.userInfo?["happy.sidebarHidden"] = nil
            app.window.isHidden = true
            withExtendedLifetime(app.coordinator) {}
        }
    }

    // MARK: Search

    /// Search is a field at the top of the list, not in the header: it
    /// rides with the list, finds rows as the phone's does, stays put
    /// while open, and Cancel gives home back as it was.
    func testSearchIsAFieldAtTheTopOfTheListAndFinds() async throws {
        let app = try await agentApp(rows: Self.rows + Self.more)
        let agentHome = try XCTUnwrap(agentHome(app.shell))
        let home = try XCTUnwrap(agentHome.children.first as? HomeViewController)
        agentHome.view.layoutIfNeeded()
        XCTAssertNil(agentHome.navigationItem.searchController, "no search in the header")
        XCTAssertEqual(agentHome.navigationItem.rightBarButtonItems ?? [], [], "nothing but the switcher in the header")
        XCTAssertTrue(app.shell.sidebar.isToolbarHidden)

        let search = agentHome.sidebarSearch
        XCTAssertFalse(search.isHidden)
        let width = agentHome.view.bounds.width
        let rest = SidebarSearchLayout(width: width, chromeTop: home.contentInsets.chromeTop, scrolled: 0, pinned: false, cancelWidth: nil)
        XCTAssertEqual(frame(search.field, in: agentHome.view), rest.field)
        XCTAssertEqual(home.contentInsets.contentTop, rest.listTop, "the list starts under the field")
        let first = try XCTUnwrap(home.homeList.view(for: "space:happy"))
        XCTAssertGreaterThan(frame(first, in: agentHome.view).minY, rest.field.maxY)
        XCTAssertEqual(home.contentInsets.chromeTop, agentHome.view.safeAreaInsets.top, "under the bar's foot")

        // Read down, it goes with the rows, under the bar.
        home.homeList.setContentOffsetY(-home.homeList.contentInsets.top + 60)
        try await until("the field rode up") { self.frame(search.field, in: agentHome.view).minY < rest.field.minY - 30 }
        XCTAssertLessThan(search.alpha, 1)
        home.homeList.setContentOffsetY(-home.homeList.contentInsets.top)
        try await until("back at rest") { self.frame(search.field, in: agentHome.view) == rest.field }

        // Typing finds what the phone's search finds.
        app.window.makeKeyAndVisible()
        XCTAssertTrue(search.field.becomeFirstResponder())
        try await until("search open") { search.isActive && agentHome.isSearching }
        search.field.text = "notes"
        search.field.sendActions(for: .editingChanged)
        let results = try XCTUnwrap(subview(HomeSearchResultsView.self, in: home.view))
        try await until("Notes found") { results.list.rows.contains { $0.id == "found:space:notes" } }
        XCTAssertFalse(results.list.rows.contains { $0.id == "found:space:ios" })
        try await until("home's list under the results fades") { home.homeList.alpha == 0 }
        XCTAssertFalse(search.cancel.isHidden)
        agentHome.view.layoutIfNeeded()
        XCTAssertEqual(frame(search.field, in: agentHome.view).minY, rest.field.minY, "held at its rest while open")
        XCTAssertLessThan(frame(search.field, in: agentHome.view).width, rest.field.width, "Cancel beside it")
        try await capture(app, "agent-sidebar-search")

        search.cancel.sendActions(for: .primaryActionTriggered)
        try await until("closed") { !search.isActive && results.isHidden }
        XCTAssertEqual(home.homeList.alpha, 1)
        XCTAssertEqual(search.field.text, "")
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: The bar at the foot

    /// Settings at the bottom left and compose, prominent, at the bottom
    /// right, both clear of the sidebar's edges; the list keeps clear of
    /// them; each opens its screen in the main panel.
    func testAnAgentsSettingsAndComposeAreAtTheFoot() async throws {
        let app = try await agentApp()
        let shell = app.shell
        let agentHome = try XCTUnwrap(agentHome(shell))
        let home = try XCTUnwrap(agentHome.children.first as? HomeViewController)
        try checkBar(agentHome.bottomBar, in: agentHome, listBottom: home.contentInsets.listBottom, shell: shell)
        XCTAssertEqual(agentHome.bottomBar.compose.configuration?.title, Strings.newWork)

        agentHome.bottomBar.settings.sendActions(for: .primaryActionTriggered)
        try await until("settings in the main panel") { shell.main.viewControllers.first is SettingsViewController }
        try await settle(shell)
        agentHome.bottomBar.compose.sendActions(for: .primaryActionTriggered)
        try await until("new work in the main panel") { shell.main.viewControllers.first is ChatViewController }
        XCTAssertEqual(shell.sidebar.viewControllers, [agentHome], "the sidebar never pushes")
        withExtendedLifetime(app.coordinator) {}
    }

    func testAHappyCLIHomesSettingsAndComposeAreAtTheFoot() async throws {
        let app = try await legacyApp()
        let shell = app.shell
        let home = try XCTUnwrap(legacyHome(shell))
        let list = try XCTUnwrap(home.children.first { $0 is SessionListViewController } as? SessionListViewController)
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["filter"], "the filter alone beside the switcher")
        try checkBar(home.bottomBar, in: home, listBottom: try XCTUnwrap(list.contentInsets).listBottom, shell: shell)
        XCTAssertEqual(home.bottomBar.compose.configuration?.title, Strings.Tablet.newSession)

        home.bottomBar.settings.sendActions(for: .primaryActionTriggered)
        try await until("settings in the main panel") { shell.main.viewControllers.first is SettingsViewController }
        try await settle(shell)
        home.bottomBar.compose.sendActions(for: .primaryActionTriggered)
        try await until("a new chat in the main panel") { shell.main.viewControllers.first is LegacyChatViewController }
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        withExtendedLifetime(app.coordinator) {}
    }

    private func checkBar(_ bar: SidebarBottomBar, in home: UIViewController, listBottom: CGFloat, shell: ShellViewController, file: StaticString = #filePath, line: UInt = #line) throws {
        home.view.layoutIfNeeded()
        XCTAssertFalse(bar.isHidden, file: file, line: line)
        XCTAssertTrue(shell.sidebar.isToolbarHidden, "no toolbar under the bar", file: file, line: line)
        let size = home.view.bounds.size
        let layout = SidebarBottomBarLayout(size: size, safeArea: LayoutInsets(home.view.safeAreaInsets), composeWidth: bar.compose.sizeThatFits(CGSize(width: size.width, height: 48)).width)
        let settings = frame(bar.settings, in: home.view)
        let compose = frame(bar.compose, in: home.view)
        XCTAssertEqual(settings, layout.settings, file: file, line: line)
        XCTAssertEqual(compose, layout.compose, file: file, line: line)
        XCTAssertEqual(settings.minX, 16, "off the sidebar's leading edge", file: file, line: line)
        XCTAssertEqual(size.width - compose.maxX, 16, "off its trailing edge", file: file, line: line)
        XCTAssertGreaterThanOrEqual(size.height - compose.maxY, 16, "off its foot", file: file, line: line)
        XCTAssertGreaterThan(compose.width, 2 * compose.height, "a pill that says what it does", file: file, line: line)
        XCTAssertEqual(compose.height, 48, file: file, line: line)
        XCTAssertGreaterThanOrEqual(listBottom, size.height - settings.minY, "the list keeps clear of the bar", file: file, line: line)
    }

    // MARK: Narrow

    /// Narrowed to one stack, home is the phone's again: search and
    /// compose in the toolbar, settings in the header, no bar at the foot;
    /// widened, the sidebar's.
    func testNarrowedAnAgentsHomeIsThePhonesAgain() async throws {
        let app = try await agentApp()
        let shell = app.shell
        let agentHome = try XCTUnwrap(agentHome(shell))
        let wide = app.window.bounds.width
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertFalse(agentHome.traitCollection.isSidebarColumn)
        XCTAssertTrue(agentHome.navigationItem.searchController === agentHome.search.controller, "search back in the bar")
        XCTAssertEqual(agentHome.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["settings"])
        XCTAssertTrue(agentHome.toolbarItems?.contains { $0.accessibilityIdentifier == "compose" } == true)
        XCTAssertTrue(agentHome.bottomBar.isHidden)
        XCTAssertTrue(agentHome.sidebarSearch.isHidden)

        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertTrue(agentHome.traitCollection.isSidebarColumn)
        XCTAssertNil(agentHome.navigationItem.searchController)
        XCTAssertFalse(agentHome.bottomBar.isHidden)
        XCTAssertFalse(agentHome.sidebarSearch.isHidden)
        withExtendedLifetime(app.coordinator) {}
    }

    func testNarrowedAHappyCLIHomeIsThePhonesAgain() async throws {
        let app = try await legacyApp()
        let shell = app.shell
        let home = try XCTUnwrap(legacyHome(shell))
        let wide = app.window.bounds.width
        try await resize(app, width: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["settings", "filter"])
        XCTAssertTrue(home.toolbarItems?.contains { $0.accessibilityIdentifier == "compose" } == true)
        XCTAssertTrue(home.bottomBar.isHidden)

        try await resize(app, width: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["filter"])
        XCTAssertFalse(home.bottomBar.isHidden)
        withExtendedLifetime(app.coordinator) {}
    }

    func testCaptureLegacySidebarLight() async throws { try await captureLegacy(.light) }
    func testCaptureLegacySidebarDark() async throws { try await captureLegacy(.dark) }
    func testCaptureAgentSidebarLight() async throws { try await captureAgent(.light) }
    func testCaptureAgentSidebarDark() async throws { try await captureAgent(.dark) }

    // MARK: Helpers

    private func openRow(_ rowId: String, in home: HomeViewController) throws {
        let row = try XCTUnwrap(home.homeList.view(for: rowId))
        home.homeList.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
    }

    private func frame(_ view: UIView, in host: UIView) -> CGRect {
        view.convert(view.bounds, to: host)
    }

    private func scrollViews(in view: UIView) -> [UIScrollView] {
        if let scroll = view as? UIScrollView { return [scroll] }
        return view.subviews.flatMap(scrollViews(in:))
    }

    private func subview<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        for sub in view.subviews {
            if let match = sub as? View { return match }
            if let match = subview(type, in: sub) { return match }
        }
        return nil
    }

    private static let more = (1...30).map { index in
        Row(id: "space:more-\(index)", nodeId: "more-\(index)", kind: .space, label: "Task \(index)", mark: .glyph("tasks"), agentId: "agent-more-\(index)", spaceId: "more-\(index)")
    }
}
#endif
