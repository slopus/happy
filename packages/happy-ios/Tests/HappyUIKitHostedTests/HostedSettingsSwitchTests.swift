#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
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
        var connection: String? { computers.first }
        var computers: [String]
    }

    /// Two Happy accounts and `connections` agent connections, in a window
    /// the coordinator owns: the second account active, or the first with
    /// connections.
    private func app(connections: Int = 0) async throws -> App {
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
        var computers: [String] = []
        for index in 0..<connections {
            try await account.addAgentConnection(JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"settings-switch-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)), name: index == 0 ? "Mac Studio" : "Mac mini")
            let id = try XCTUnwrap(account.agentConnections.activeID)
            computers.append(id)
            addTeardownBlock { @MainActor in Session.forget(id) }
            try await account.switchAccount(to: index == connections - 1 ? first : second)
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
        return App(account: account, coordinator: coordinator, navigation: navigation, window: window, first: first, second: second, computers: computers)
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
        let app = try await app(connections: 1)
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
        let app = try await app(connections: 1)
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

    /// The edge swipe over Settings, begun, held through its first frames
    /// and a third of the way, then let go: `home`'s list, settings and
    /// search are there throughout, and Settings stays. Not its switcher: a
    /// swipe driven by hand here never brings the incoming custom item into
    /// the bar, even over the home Settings was opened from with no switch
    /// at all (checked once, by hand). That the switcher is ready before
    /// any way back begins is checked by `assertMounted`, and Back samples
    /// it every frame.
    private func swipeAndLetGo(_ app: App, settings: SettingsViewController, home: UIViewController, _ leg: String) async throws {
        let swipe = try XCTUnwrap(app.navigation.interactivePopGestureRecognizer)
        let finger = Finger(swipe, in: app.navigation.view)
        defer { finger.lift() }
        swipe.state = .began
        let began = try await until(1) { app.navigation.transitionCoordinator != nil }
        XCTAssertTrue(began, "\(leg): the swipe didn't begin a transition")
        XCTAssertEqual(app.navigation.transitionCoordinator?.isInteractive, true, leg)
        // The first frames of the swipe, then a third of the way.
        var swiping: [Frame] = []
        for progress in [0.02, 0.05, 0.1, 0.35] as [CGFloat] {
            finger.progress = progress
            swipe.state = .changed
            try await Task.sleep(for: .milliseconds(34))
            swiping.append(frame(app, home: home, leaving: settings.view, at: Double(progress)))
            if progress == 0.35 { capture(app.window, "swipe-\(leg)-mid") }
        }
        let missing = swiping.filter { !($0.settings && $0.search && $0.content) }
        XCTAssertTrue(missing.isEmpty, "\(leg): mid-swipe (at progress):\n\(missing.map(\.description).joined(separator: "\n"))")
        // Let go: Settings stays.
        finger.progress = 0.05
        swipe.state = .cancelled
        let settled = try await until { app.navigation.transitionCoordinator == nil }
        finger.lift()
        XCTAssertTrue(settled, leg)
        XCTAssertTrue(app.navigation.topViewController === settings, "\(leg): the cancelled swipe left Settings")
        try await Task.sleep(for: .milliseconds(300))
    }

    /// The home put under Settings is built before any way back begins:
    /// its view loaded and laid out at the stack's size, its bar items
    /// set, the switcher naming the new account with its picture. Before,
    /// it loaded only when back began, too late for the bar's transition.
    private func assertMounted(_ app: App, home: UIViewController, expected: String?, _ leg: String, line: UInt = #line) {
        XCTAssertTrue(home.isViewLoaded, "\(leg): the new home isn't loaded behind Settings", line: line)
        XCTAssertEqual(home.view.bounds.size, app.navigation.view.bounds.size, "\(leg): the new home isn't laid out", line: line)
        let button = home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton
        XCTAssertEqual(button?.title, expected, "\(leg): the switcher isn't set", line: line)
        let pending = AvatarPlaceholderImages.pending(side: AccountSwitcher.menuPicture)
        let picture = button.flatMap { Mirror(reflecting: $0).children.first { $0.label == "pictureView" }?.value as? UIImageView }?.image
        XCTAssertTrue(picture != nil && picture !== pending, "\(leg): the switcher has no picture", line: line)
        XCTAssertTrue(home.navigationItem.rightBarButtonItems?.contains { $0.accessibilityIdentifier == "settings" } ?? false, "\(leg): no settings", line: line)
    }

    // MARK: Back to the new home

    /// What one frame of the way back shows of the home being returned to.
    private struct Frame: CustomStringConvertible {
        var time: CFTimeInterval
        /// The pop's motion is set up: Settings has left its place.
        var begun: Bool
        /// The home's own switcher, in the bar, naming `name`.
        var switcher: Bool
        var name: String?
        /// A picture that is the account's, not the empty circle.
        var picture: Bool
        var settings: Bool
        var search: Bool
        var content: Bool
        var description: String {
            String(format: "%.3fs", time) + " begun \(begun) switcher \(switcher) \(name ?? "-") picture \(picture) settings \(settings) search \(search) content \(content)"
        }
        var whole: Bool { switcher && picture && settings && search && content }
    }

    private static func descendants(of view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap(descendants)
    }

    private func frame(_ app: App, home: UIViewController, leaving: UIView, at time: CFTimeInterval) -> Frame {
        let bar = app.navigation.navigationBar
        let own = home.navigationItem.leftBarButtonItem?.customView
        let button = Self.descendants(of: bar).first { $0 === own && $0.window != nil && !$0.isHidden } as? AccountSwitcherButton
        let pending = AvatarPlaceholderImages.pending(side: AccountSwitcher.menuPicture)
        let picture = button.flatMap { Mirror(reflecting: $0).children.first { $0.label == "pictureView" }?.value as? UIImageView }?.image
        let settings = home.navigationItem.rightBarButtonItems?.contains { $0.accessibilityIdentifier == "settings" } ?? false
        // A computer's home searches from the toolbar; a Happy account's
        // has none to show.
        let search = home is AgentHomeViewController ? home.toolbarItems?.contains { $0 === home.navigationItem.searchBarPlacementBarButtonItem } == true && !app.navigation.isToolbarHidden : true
        var content = home.isViewLoaded && home.view.window != nil && home.view.bounds.size == app.navigation.view.bounds.size
        if home is LegacyHomeViewController {
            content = content && (Mirror(reflecting: home).children.first { $0.label == "content" }?.value as? UIViewController)?.view.window != nil
        }
        let begun = leaving.window == nil || leaving.convert(leaving.bounds, to: nil).minX != 0
        return Frame(time: time, begun: begun, switcher: button != nil, name: button?.title, picture: picture != nil && picture !== pending, settings: settings, search: search, content: content)
    }

    private func name(_ app: App, _ id: String) -> String? {
        if let computer = app.account.agentConnections.accounts.first(where: { $0.id == id }) { return computer.name }
        return app.account.accounts.first { $0.id == id }?.shownName
    }

    /// Every switch from Settings, Happy and computer either way, then back
    /// to the home it put under Settings, never shown yet: on two of them by
    /// the edge swipe begun and let go (Settings stays) and then Back, on
    /// the other two by Back alone. Before either, it is built (`assertMounted`);
    /// on every frame of the pop it is whole: its own switcher in the bar naming
    /// the new account with its picture, settings, search, and its list.
    func testTheNewHomeIsWholeFromTheFirstFrameBack() async throws {
        let app = try await app(connections: 2)
        let computers = app.computers
        let legs: [(String, String, UIUserInterfaceStyle, UIViewController.Type, Bool)] = [
            ("happy-to-happy", app.second, .light, LegacyHomeViewController.self, true),
            ("happy-to-computer", computers[0], .dark, AgentHomeViewController.self, false),
            ("computer-to-computer", computers[1], .light, AgentHomeViewController.self, true),
            ("computer-to-happy", app.first, .dark, LegacyHomeViewController.self, false),
        ]
        var pops: [String] = []
        for (leg, to, style, kind, swipes) in legs {
            app.window.rootViewController?.overrideUserInterfaceStyle = style
            let settings = try await openSettings(app)
            let oldHome = try XCTUnwrap(app.navigation.viewControllers.first)
            settings.tapRow("account:\(to)")
            let replaced = try await until { app.navigation.viewControllers.first !== oldHome && self.homeAccount(app.navigation) == to }
            XCTAssertTrue(replaced, "\(leg): home was never replaced")
            try await Task.sleep(for: .milliseconds(700))
            let home = try XCTUnwrap(app.navigation.viewControllers.first)
            XCTAssertTrue(type(of: home) == kind, "\(leg): \(home)")
            let expected = name(app, to)

            // The edge swipe, begun and let go.
            assertMounted(app, home: home, expected: expected, leg)
            if swipes { try await swipeAndLetGo(app, settings: settings, home: home, leg) }

            // Back, sampled every frame.
            var frames: [Frame] = []
            var captured = false
            let start = CACurrentMediaTime()
            let recorder = TickRecorder { [unowned self] _ in
                let time = CACurrentMediaTime() - start
                frames.append(frame(app, home: home, leaving: settings.view, at: time))
                if !captured, time > 0.15 {
                    captured = true
                    capture(app.window, "back-\(leg)-mid")
                }
            }
            app.navigation.popViewController(animated: true)
            let landed = try await until { app.navigation.transitionCoordinator == nil && app.navigation.topViewController === home }
            try await Task.sleep(for: .milliseconds(100))
            recorder.stop()
            XCTAssertTrue(landed, "\(leg): back didn't land on the new home")
            XCTAssertGreaterThan(frames.count, HostedTime.sampled(5), leg)
            // iOS 27 sets a pop's motion up a frame after it is asked
            // for; until then Settings fills the screen where it was.
            let broken = frames.filter { $0.begun && (!$0.whole || $0.name != expected) }
            XCTAssertTrue(broken.isEmpty, "\(leg): \(broken.count) of \(frames.count) frames lack part of home:\n\(broken.prefix(6).map(\.description).joined(separator: "\n"))")
            pops.append("\(leg): \(frames.count) frames, \(frames.filter { !$0.begun }.count) before the pop began")
        }
        print("pops: \(pops)")
        withExtendedLifetime(app.coordinator) {}
    }

    /// A finger on the system's edge swipe, which UIKit's pop follows by
    /// reading the recognizer's translation, location and velocity: those
    /// answer `progress` of the way across `view` for `recognizer` alone,
    /// until `lift`. Its state is set by hand (UIGestureRecognizerSubclass).
    @MainActor
    private final class Finger {
        private let recognizer: UIGestureRecognizer
        private weak var view: UIView?
        private var restore: [() -> Void] = []
        var progress: CGFloat = 0

        init(_ recognizer: UIGestureRecognizer, in view: UIView) {
            self.recognizer = recognizer
            self.view = view
            let cls: AnyClass = type(of: recognizer)
            typealias Original = @convention(c) (AnyObject, Selector, UIView?) -> CGPoint
            let answers: [(String, () -> CGPoint)] = [
                ("translationInView:", { [unowned self] in CGPoint(x: self.progress * (self.view?.bounds.width ?? 0), y: 0) }),
                ("locationInView:", { [unowned self] in CGPoint(x: self.progress * (self.view?.bounds.width ?? 0), y: (self.view?.bounds.height ?? 0) / 2) }),
                ("velocityInView:", { CGPoint.zero }),
            ]
            for (name, answer) in answers {
                let selector = NSSelectorFromString(name)
                guard let method = class_getInstanceMethod(cls, selector) else { continue }
                let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
                let block: @convention(block) (AnyObject, UIView?) -> CGPoint = { [weak recognizer] target, view in
                    target === recognizer ? MainActor.assumeIsolated { answer() } : original(target, selector, view)
                }
                let replaced = method_setImplementation(method, imp_implementationWithBlock(block))
                restore.append { method_setImplementation(method, replaced) }
            }
        }

        func lift() {
            restore.reversed().forEach { $0() }
            restore = []
        }
    }
}
#endif
