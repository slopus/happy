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
/// Runs wherever the window is roomy enough to split: an iPad, or an
/// iPhone Duo open in landscape (951 × 669). The rule is the window's,
/// never the device's, so the same tests hold on both. With `HAPPY_PREVIEW_DIR` set,
/// it writes what each state looked like.
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

    /// Skips unless the scene is roomy enough for the split: an iPhone, or
    /// a Duo folded or open in portrait, is the phone.
    private func requireSplit() async throws {
        let scene = try await hostedActiveScene()
        let traits = scene.traitCollection
        try XCTSkipUnless(SplitRule.showsSplit(width: scene.coordinateSpace.bounds.width,
                                               isRegularWidth: traits.horizontalSizeClass == .regular,
                                               isRegularHeight: traits.verticalSizeClass != .compact, showsHome: true),
                          "a window roomy enough for the split")
    }

    /// The scene's width: the window's when nothing has narrowed it.
    private func sceneWidth(_ app: App) -> CGFloat {
        app.window.windowScene?.coordinateSpace.bounds.width ?? app.window.bounds.width
    }

    /// The window less its safe area's sides, where the readable column is
    /// centred. An iPad's are 0; an iPhone Duo's right is its status bar's
    /// column.
    private func panelArea(_ window: UIWindow) -> CGRect {
        window.bounds.inset(by: UIEdgeInsets(top: 0, left: window.safeAreaInsets.left, bottom: 0, right: window.safeAreaInsets.right))
    }

    /// A seeded Happy CLI account (and optionally a second one) in a
    /// window AppCoordinator owns, the scene's whole size.
    private func app(twoAccounts: Bool = false, style: UIUserInterfaceStyle = .light) async throws -> App {
        try await requireSplit()
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
        narrow(app.window, app.shell, to: width)
        try await Task.sleep(for: .milliseconds(100))
        app.window.layoutIfNeeded()
    }

    /// The window `width` wide. On a display that folds, a window too
    /// narrow for the sidebar beside is the folded one, compact, as the
    /// phone's one stack is there; regular and open, the sidebar would
    /// slide over instead (`testOpenInPortraitTheSidebarSlidesOverTheMainPanel`).
    private func narrow(_ window: UIWindow, _ shell: ShellViewController, to width: CGFloat) {
        if shell.folds, width < SplitRule.minWidth {
            window.traitOverrides.horizontalSizeClass = .compact
        } else {
            window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        }
        window.frame = CGRect(x: 0, y: 0, width: width, height: window.bounds.height)
        window.layoutIfNeeded()
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
        let scene = window.windowScene?.coordinateSpace.bounds.size ?? window.bounds.size
        let device = UIDevice.current.userInterfaceIdiom == .pad ? (max(scene.width, scene.height) > 1300 ? "ipad-13in" : "ipad-11in") : "phone-\(Int(scene.width))"
        let style = window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light"
        try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(device)-\(name)-\(style).png"))
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

    // MARK: The empty main panel

    private func labels(in view: UIView) -> [UILabel] {
        view.subviews.flatMap { subview -> [UILabel] in
            if let label = subview as? UILabel { return [label] }
            return labels(in: subview)
        }
    }

    /// Nothing open: desktop's owl alone, centred in the panel's safe area,
    /// playing once and holding its last frame; and once more each time the
    /// panel empties again.
    func testTheEmptyMainPanelIsTheOwlAlone() async throws {
        try await theEmptyMainPanelIsTheOwlAlone(style: .light)
    }

    func testTheEmptyMainPanelIsTheOwlAloneInTheDark() async throws {
        try await theEmptyMainPanelIsTheOwlAlone(style: .dark)
    }

    private func theEmptyMainPanelIsTheOwlAlone(style: UIUserInterfaceStyle) async throws {
        let app = try await app(style: style)
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        let placeholder = shell.placeholder
        XCTAssertEqual(shell.main.viewControllers, [placeholder])
        placeholder.view.layoutIfNeeded()

        let scene = placeholder.scene
        XCTAssertEqual(placeholder.view.subviews, [scene], "the owl and nothing else")
        XCTAssertEqual(scene.scene, .owl)
        XCTAssertTrue(labels(in: placeholder.view).isEmpty, "no words")
        XCTAssertEqual(scene.accessibilityIdentifier, "main-panel-placeholder")
        XCTAssertEqual(scene.accessibilityLabel, Strings.Tablet.replayIllustration)
        let safe = placeholder.view.bounds.inset(by: placeholder.view.safeAreaInsets)
        XCTAssertEqual(scene.frame.size, CGSize(width: 128, height: 128))
        XCTAssertEqual(scene.frame.midX, safe.midX, accuracy: 0.5, "centred across the safe area")
        XCTAssertEqual(scene.frame.midY, safe.midY, accuracy: 0.5, "centred down the safe area")
        XCTAssertGreaterThan(safe.minY, 0, "under the main panel's bar")

        try await until("the owl read") { scene.isLoaded }
        guard !UIAccessibility.isReduceMotionEnabled else { return }
        try await until("the owl's one play", 10) { !scene.isAnimating && scene.progress == 1 }
        // The coordinator applies the account's theme on restore: pin the look.
        app.window.overrideUserInterfaceStyle = style
        app.window.layoutIfNeeded()
        try await until("the style applied") { placeholder.traitCollection.userInterfaceStyle == style }
        try await capture(app, "nothing-open")

        // A chat, then closed again: the empty panel plays the owl once more.
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        XCTAssertNil(scene.window, "the chat in its place")
        shell.setStack([home], animated: false)
        try await settle(shell)
        XCTAssertEqual(shell.main.viewControllers, [placeholder])
        try await until("the owl again") { scene.isAnimating }
        try await until("the owl's second play", 10) { !scene.isAnimating && scene.progress == 1 }

        // A tap plays it again.
        scene.replay()
        XCTAssertTrue(scene.isAnimating, "a tap plays it again")
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: Readable widths

    private func shown<View: UIView>(_ type: View.Type, in view: UIView) -> [View] {
        view.subviews.flatMap { sub -> [View] in
            guard !sub.isHidden, sub.alpha > 0 else { return [] }
            return (sub as? View).map { [$0] } ?? shown(type, in: sub)
        }
    }

    /// With the sidebar hidden the main panel is the whole window, and its
    /// pages keep to the readable column (`ContentWidth`): Settings' cards
    /// 800 less their 16 sides, in the middle; the chat's list docked under
    /// its bar and strip, so nothing scrolls under them.
    func testWithTheSidebarHiddenPagesKeepToTheReadableColumn() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        shell.setSidebarHidden(true)
        try await until("hidden") { !shell.showsSidebar }
        try await Task.sleep(for: .milliseconds(500))
        let middle = panelArea(app.window).midX

        home.push(.settings, context: app.context)
        try await settle(shell)
        let settings = try XCTUnwrap(shell.main.viewControllers.first as? SettingsViewController)
        settings.view.layoutIfNeeded()
        let cards = shown(SettingsCardView.self, in: settings.view)
        XCTAssertFalse(cards.isEmpty, "Settings showed no cards")
        for card in cards {
            let frame = card.convert(card.bounds, to: app.window)
            XCTAssertEqual(frame.width, ContentWidthLimit.readable - 2 * SettingsLayout.Metrics.side, "\(frame)")
            XCTAssertEqual(frame.midX, middle, accuracy: 0.5, "\(frame)")
        }
        try await capture(app, "settings-hidden")

        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let chat = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)
        try await until("the chat") { chat.contentInstalled && !self.shown(ChatWorktreeTabStrip.self, in: chat.view).isEmpty }
        chat.view.layoutIfNeeded()
        let strip = try XCTUnwrap(shown(ChatWorktreeTabStrip.self, in: chat.view).first)
        let list = try XCTUnwrap(shown(ChatListView.self, in: chat.view).first)
        XCTAssertEqual(list.convert(list.bounds, to: app.window).minY, strip.convert(strip.bounds, to: app.window).maxY, "the list starts under the strip")
        try await capture(app, "chat-hidden")
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
        // The panel starts where the floating sidebar ends: iOS 26 insets
        // the floating sidebar from the window's edge, iOS 27 doesn't.
        let sidebarEnd = shell.sidebar.view.convert(shell.sidebar.view.bounds, to: app.window).maxX
        XCTAssertEqual(shell.main.view.convert(shell.main.view.bounds, to: app.window), CGRect(x: sidebarEnd, y: 0, width: app.window.bounds.width - sidebarEnd, height: app.window.bounds.height))
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
        try await resize(app, width: sceneWidth(app))
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

    /// Moved from stack to stack as the window narrows and widens, a screen
    /// hears it left the old one before it appears on the new one, so the
    /// last it heard is that it appeared. Before, the old stack said so at
    /// its own next layout, after the new one's: a chat that had moved
    /// thought it was gone and stopped following the keyboard.
    func testAScreenMovedBetweenStacksEndsAppeared() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        let wide = app.window.bounds.width
        let probe = AppearanceProbe()
        shell.setStack([home, probe], animated: false)
        try await settle(shell)
        for width in [700, wide, 700, wide] {
            try await resize(app, width: width)
            try await until("\(width) wide") { (width >= 768) == shell.isExpanded }
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(probe.heard.last, "appeared", "\(width): \(probe.heard)")
            XCTAssertNotNil(probe.view.window, "\(width)")
        }
        withExtendedLifetime(app.coordinator) {}
    }


    func testTheWindowSplitsFrom768() async throws {
        let app = try await app()
        let shell = app.shell
        try await resize(app, width: 768)
        try await until("split at 768") { shell.isExpanded }
        try await resize(app, width: 767)
        try await until("a phone at 767") { !shell.isExpanded }
        try await resize(app, width: sceneWidth(app))
        try await until("split again") { shell.isExpanded }
        withExtendedLifetime(app.coordinator) {}
    }

    // MARK: Folding

    /// An iPhone Duo folded and opened again mid-session, as the window
    /// sees it: the cover display's 466 and compact, then the open
    /// display's width and regular again. A fold is the same width and
    /// size-class rule as a resize, so the same screens move: home, a chat
    /// and its info, with a sheet up over them and the call's bar showing,
    /// all as they were.
    func testFoldingAndOpeningAgainKeepsTheStackTheSheetAndTheCall() async throws {
        let app = try await app()
        let shell = app.shell
        let home = try XCTUnwrap(home(shell))
        let open = app.window.bounds.size
        addTeardownBlock { @MainActor in
            CallController.shared.close()
            app.window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        }
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let chat = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)
        chat.push(.sessionInfo(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let info = try XCTUnwrap(shell.main.topViewController as? SessionInfoViewController)
        CallController.shared.showFixture("listening", from: home)
        try await until("the call's bar") { shell.callBarShown }
        let sheet = UIViewController()
        shell.present(sheet, animated: false)
        try await until("the sheet") { shell.presentedViewController === sheet }

        // Folded: the cover display, compact.
        app.window.traitOverrides.horizontalSizeClass = .compact
        app.window.frame = CGRect(x: 0, y: 0, width: 466, height: 678)
        app.window.layoutIfNeeded()
        try await until("folded") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [home, chat, info], "home, then the chat and its info: the same screens")
        XCTAssertTrue(shell.sidebar.viewControllers.isEmpty)
        XCTAssertTrue(shell.presentedViewController === sheet, "the sheet stays up")
        XCTAssertTrue(shell.callBarShown, "the call's bar stays")
        try await capture(app, "folded")

        // Open again: regular and wide.
        app.window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        app.window.frame = CGRect(origin: .zero, size: open)
        app.window.layoutIfNeeded()
        try await until("open") { shell.isExpanded }
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        XCTAssertEqual(shell.main.viewControllers, [chat, info])
        XCTAssertTrue(shell.phone.viewControllers.isEmpty)
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-main", "the selection came back")
        XCTAssertTrue(shell.presentedViewController === sheet, "the sheet stays up")
        XCTAssertTrue(shell.callBarShown, "the call's bar stays")
        sheet.dismiss(animated: false)
        withExtendedLifetime(app.coordinator) {}
    }

    /// An iPhone Duo open in portrait (669 wide, regular): too thin for the
    /// sidebar beside, so it slides over the main panel from the leading
    /// edge with the system's own overlay, and a row opened there puts the
    /// sidebar away. A window that doesn't fold (an iPad's) is the phone's
    /// one stack at that width, as it always was.
    func testOpenInPortraitTheSidebarSlidesOverTheMainPanel() async throws {
        let app = try await app()
        let shell = app.shell
        let split = try XCTUnwrap(shell.split)
        let home = try XCTUnwrap(home(shell))
        let open = app.window.bounds.size
        addTeardownBlock { @MainActor in app.window.traitOverrides.remove(UITraitHorizontalSizeClass.self) }
        home.push(.session(id: "seeded-main"), context: app.context)
        try await settle(shell)
        let chat = try XCTUnwrap(shell.main.viewControllers.first as? LegacyChatViewController)

        app.window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
        app.window.frame = CGRect(x: 0, y: 0, width: 669, height: open.height)
        app.window.layoutIfNeeded()
        guard shell.folds else {
            try await until("a phone at 669") { !shell.isExpanded }
            XCTAssertEqual(shell.phone.viewControllers, [home, chat])
            app.window.frame = CGRect(origin: .zero, size: open)
            app.window.layoutIfNeeded()
            try await until("split again") { shell.isExpanded }
            withExtendedLifetime(app.coordinator) {}
            return
        }
        try await until("over") { shell.isExpanded && shell.overlays && split.displayMode == .secondaryOnly }
        XCTAssertEqual(split.preferredSplitBehavior, .overlay)
        XCTAssertEqual(shell.sidebar.viewControllers, [home])
        XCTAssertEqual(shell.main.viewControllers, [chat], "the chat has the whole window")
        XCTAssertEqual(shell.main.view.convert(shell.main.view.bounds, to: app.window).minX, 0)
        XCTAssertTrue(shell.wearsToggle(chat), "the sidebar's button")
        try await capture(app, "over-closed")

        // The sidebar's button slides home over the chat.
        shell.setSidebarHidden(false)
        try await until("home over the chat") { split.displayMode == .oneOverSecondary }
        XCTAssertEqual(shell.main.viewControllers, [chat])
        try await capture(app, "over-open")

        // A row opened there is the main panel's root, and home goes away.
        home.push(.session(id: "seeded-tab-3"), context: app.context)
        try await settle(shell)
        try await until("put away") { split.displayMode == .secondaryOnly }
        XCTAssertEqual(list(shell)?.selectedSessionId, "seeded-tab-3")
        let other = try XCTUnwrap(shell.main.viewControllers.first)
        XCTAssertFalse(other === chat)
        XCTAssertEqual(shell.main.viewControllers.count, 1)

        // Turned to landscape: beside again, as it was left.
        app.window.frame = CGRect(origin: .zero, size: open)
        app.window.layoutIfNeeded()
        try await until("beside") { !shell.overlays && split.displayMode == .oneBesideSecondary }
        XCTAssertEqual(split.preferredSplitBehavior, .tile)
        XCTAssertEqual(shell.main.viewControllers, [other])
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
        try await requireSplit()
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
        narrow(window, shell, to: 700)
        try await until("collapsed") { !shell.isExpanded }
        XCTAssertEqual(shell.phone.viewControllers, [agentHome, chat])
        XCTAssertNil(home.homeList.selectedRowId)

        // Widened: the row is selected again.
        narrow(window, shell, to: wide)
        try await until("expanded") { shell.isExpanded }
        XCTAssertEqual(shell.main.viewControllers, [chat])
        XCTAssertEqual(home.homeList.selectedRowId, "space:ios")

        // Over the chat (a display that folds, open in portrait), the row
        // stays selected each time home slides away and back.
        if shell.folds, let split = shell.split {
            window.frame = CGRect(x: 0, y: 0, width: 669, height: window.bounds.height)
            window.layoutIfNeeded()
            try await until("over") { shell.overlays && split.displayMode == .secondaryOnly }
            for _ in 0..<2 {
                shell.setSidebarHidden(false)
                try await until("home over the chat") { split.displayMode == .oneOverSecondary }
                XCTAssertEqual(home.homeList.selectedRowId, "space:ios")
                shell.setSidebarHidden(true)
                try await until("put away") { split.displayMode == .secondaryOnly }
                // Home hears it went once the slide has finished.
                try await until("home gone") { home.viewIfLoaded?.window == nil }
                try await Task.sleep(for: .milliseconds(300))
            }
            narrow(window, shell, to: wide)
            try await until("beside") { !shell.overlays && split.displayMode == .oneBesideSecondary }
            XCTAssertEqual(home.homeList.selectedRowId, "space:ios")
        }

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

/// What a screen is told of its appearance, in order.
private final class AppearanceProbe: UIViewController {
    private(set) var heard: [String] = []

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        heard.append("appeared")
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        heard.append("disappeared")
    }
}
#endif
