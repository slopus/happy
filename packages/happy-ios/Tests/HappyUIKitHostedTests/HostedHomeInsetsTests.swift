#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import UIKit.UIGestureRecognizerSubclass
import UltraView
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

/// A long home, a screen pushed over it and every way back: the Back
/// button, the edge swipe let go of past halfway, and the edge swipe let go
/// of early (the screen stays, then Back). Each from home at its top and
/// scrolled to its end, on a computer's home and on a Happy account's
/// UltraView home. Coming back, the list has exactly the room it had: the
/// first row under the bar where it first showed, the last above the
/// toolbar's search field, and the room never changes while home comes
/// back. Before, UIKit laid home out mid-pop with its toolbar on its way
/// (the safe area's foot at the home indicator, the field out of the
/// window), never laid it out again once the toolbar was back, and the
/// list's end stayed under the search field. Pictures, light and dark, go
/// to the repository's `.context/evidence/home-insets`.
@MainActor
final class HostedHomeInsetsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/home-insets")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    static let rows: [Row] = (0..<60).map { index in
        Row(id: "space:\(index)", nodeId: "n\(index)", kind: .space, label: "Conversation \(index)", mark: .glyph("agents"), agentId: "agent-\(index)", spaceId: "s\(index)")
    }

    enum Way: String, CaseIterable {
        case back
        case swipe
        /// The swipe let go of early: the screen stays, and Back follows.
        case cancelledSwipe
    }

    // MARK: A computer's home

    func testAComputersHomeKeepsItsRoomThroughEveryWayBack() async throws {
        let app = try await HomeApp.computer(self)
        defer { withExtendedLifetime(app.coordinator) {} }
        let sidebar = try XCTUnwrap(app.sidebar)
        let loaded = sidebar.contentInsets
        XCTAssertEqual(loaded.top, app.navigation.navigationBar.frame.maxY + 12, "rows start 12 under the bar")
        let first = try XCTUnwrap(app.frame(of: "space:0"))
        let field = try XCTUnwrap(app.field)
        XCTAssertGreaterThanOrEqual(loaded.bottom, app.window.bounds.height - field.minY, "the list ends above the search field")
        capture(app.window, "computer-1-loaded")

        for scrolled in [false, true] {
            for way in Way.allCases {
                let leg = "\(scrolled ? "end" : "top") \(way.rawValue)"
                if scrolled { try await scrollToEnd(sidebar) } else { sidebar.setContentOffsetY(-loaded.top); try await Task.sleep(for: .milliseconds(100)) }
                let last = app.frame(of: Self.rows.last!.id) ?? .null
                if scrolled {
                    XCTAssertLessThanOrEqual(last.maxY, field.minY, "\(leg): the last row is under the search field before leaving")
                } else {
                    XCTAssertEqual(app.frame(of: "space:0"), first, leg)
                }
                try await pushChat(app, sidebar)
                var seen: [UIEdgeInsets] = []
                let watch = TickRecorder { _ in seen.append(sidebar.contentInsets) }
                try await goBack(app, way, leg)
                try await Task.sleep(for: .milliseconds(300))
                watch.stop()
                XCTAssertTrue(app.navigation.topViewController === app.root, leg)
                XCTAssertEqual(Set(seen.map { "\($0)" }), ["\(loaded)"], "\(leg): the list's room changed coming back")
                XCTAssertEqual(sidebar.contentInsets, loaded, leg)
                if scrolled {
                    let after = try XCTUnwrap(app.frame(of: Self.rows.last!.id), leg)
                    XCTAssertEqual(after.minY, last.minY, accuracy: 0.5, "\(leg): the list moved")
                    let field = try XCTUnwrap(app.field, leg)
                    XCTAssertLessThanOrEqual(after.maxY, field.minY, "\(leg): the last row went under the search field")
                    if way == .back { capture(app.window, "computer-2-end-after-back") }
                } else {
                    XCTAssertEqual(app.frame(of: "space:0"), first, "\(leg): the first row isn't where it first showed")
                    if way == .back { capture(app.window, "computer-3-top-after-back") }
                }
            }
        }
    }

    /// The same home in dark: the pictures after Back, at the end and the top.
    func testAComputersHomeKeepsItsRoomInDark() async throws {
        let app = try await HomeApp.computer(self, style: .dark)
        defer { withExtendedLifetime(app.coordinator) {} }
        let sidebar = try XCTUnwrap(app.sidebar)
        let loaded = sidebar.contentInsets
        try await scrollToEnd(sidebar)
        try await pushChat(app, sidebar)
        try await goBack(app, .back, "dark")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(sidebar.contentInsets, loaded)
        let last = try XCTUnwrap(app.frame(of: Self.rows.last!.id))
        XCTAssertLessThanOrEqual(last.maxY, try XCTUnwrap(app.field).minY)
        capture(app.window, "computer-2-end-after-back")
        sidebar.setContentOffsetY(-loaded.top)
        try await Task.sleep(for: .milliseconds(200))
        capture(app.window, "computer-3-top-after-back")
    }

    // MARK: A Happy account's home

    func testALegacyHomeKeepsItsRoomThroughEveryWayBack() async throws {
        let app = try await HomeApp.legacy(self)
        defer { withExtendedLifetime(app.coordinator) {} }
        let list = try XCTUnwrap(app.legacyList)
        let loaded = list.viewportInsets
        XCTAssertFalse(app.navigation.isToolbarHidden, "the legacy home shows compose in its toolbar")
        XCTAssertGreaterThan(loaded.bottom, app.window.safeAreaInsets.bottom, "the list ends above the toolbar")
        let first = try XCTUnwrap(list.settledFrame(at: 0))
        capture(app.window, "legacy-1-loaded")

        for scrolled in [false, true] {
            for way in Way.allCases {
                let leg = "legacy \(scrolled ? "end" : "top") \(way.rawValue)"
                let lastIndex = list.items.count - 1
                list.scrollTo(ListScrollTarget(index: scrolled ? lastIndex : 0, pointOffset: 0), transition: .immediate)
                try await Task.sleep(for: .milliseconds(200))
                let reference = try XCTUnwrap(list.settledFrame(at: scrolled ? lastIndex : 0), leg)
                if !scrolled { XCTAssertEqual(reference, first, leg) }
                let pushed = UIViewController()
                pushed.view.backgroundColor = .systemBackground
                pushed.title = "Pushed"
                app.navigation.pushViewController(pushed, animated: true)
                try await settle(app.navigation)
                var seen: [ListInsets] = []
                let watch = TickRecorder { _ in seen.append(list.viewportInsets) }
                try await goBack(app, way, leg)
                try await Task.sleep(for: .milliseconds(300))
                watch.stop()
                XCTAssertTrue(app.navigation.topViewController === app.root, leg)
                XCTAssertTrue(seen.allSatisfy { $0 == loaded }, "\(leg): the list's room changed coming back: \(Set(seen.map { "\($0.top)/\($0.bottom)" }))")
                XCTAssertEqual(list.viewportInsets, loaded, leg)
                let after = try XCTUnwrap(list.settledFrame(at: scrolled ? lastIndex : 0), leg)
                XCTAssertEqual(after.minY, reference.minY, accuracy: 0.5, "\(leg): the list moved")
                if scrolled {
                    XCTAssertLessThanOrEqual(list.convert(after, to: app.window).maxY, app.window.bounds.height - loaded.bottom + 0.5, "\(leg): the last row went under the toolbar")
                    if way == .back { capture(app.window, "legacy-2-end-after-back") }
                }
            }
        }
    }

    /// The same home in dark: the picture after Back, at the end.
    func testALegacyHomeKeepsItsRoomInDark() async throws {
        let app = try await HomeApp.legacy(self, style: .dark)
        defer { withExtendedLifetime(app.coordinator) {} }
        let list = try XCTUnwrap(app.legacyList)
        let loaded = list.viewportInsets
        let lastIndex = list.items.count - 1
        list.scrollTo(ListScrollTarget(index: lastIndex, pointOffset: 0), transition: .immediate)
        try await Task.sleep(for: .milliseconds(200))
        let pushed = UIViewController()
        pushed.view.backgroundColor = .systemBackground
        app.navigation.pushViewController(pushed, animated: true)
        try await settle(app.navigation)
        try await goBack(app, .back, "legacy dark")
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(list.viewportInsets, loaded)
        let last = try XCTUnwrap(list.settledFrame(at: lastIndex))
        XCTAssertLessThanOrEqual(list.convert(last, to: app.window).maxY, app.window.bounds.height - loaded.bottom + 0.5, "the last row went under the toolbar")
        capture(app.window, "legacy-2-end-after-back")
    }

    // MARK: Driving

    private func pushChat(_ app: HomeApp, _ sidebar: SidebarList) async throws {
        let visible = try XCTUnwrap(sidebar.visibleRows.dropFirst(1).first)
        let row = try XCTUnwrap(sidebar.view(for: visible.id))
        sidebar.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
        XCTAssertTrue(app.navigation.topViewController is ChatViewController)
        try await settle(app.navigation)
    }

    private func goBack(_ app: HomeApp, _ way: Way, _ leg: String) async throws {
        switch way {
        case .back:
            app.navigation.popViewController(animated: true)
            try await settle(app.navigation)
        case .swipe:
            try await swipe(app, to: 0.75, letGo: .ended, leg)
        case .cancelledSwipe:
            let covering = app.navigation.topViewController
            try await swipe(app, to: 0.3, letGo: .cancelled, leg)
            XCTAssertTrue(app.navigation.topViewController === covering, "\(leg): the cancelled swipe left the screen")
            app.navigation.popViewController(animated: true)
            try await settle(app.navigation)
        }
    }

    /// The edge swipe by hand: begun, carried to `progress`, let go of.
    private func swipe(_ app: HomeApp, to progress: CGFloat, letGo: UIGestureRecognizer.State, _ leg: String) async throws {
        let gesture = try XCTUnwrap(app.navigation.interactivePopGestureRecognizer)
        let finger = EdgeFinger(gesture, in: app.navigation.view)
        defer { finger.lift() }
        gesture.state = .began
        let began = try await until(1) { app.navigation.transitionCoordinator != nil }
        XCTAssertTrue(began, "\(leg): the swipe didn't begin")
        for step in [0.05, 0.15, progress / 2, progress] as [CGFloat] {
            finger.progress = step
            gesture.state = .changed
            try await Task.sleep(for: .milliseconds(34))
        }
        XCTAssertEqual(app.navigation.transitionCoordinator?.percentComplete ?? 0, progress, accuracy: 0.01, "\(leg): the swipe didn't follow the finger")
        if letGo == .ended {
            // A recognizer driven by hand is never let go of moving on: UIKit
            // cancels it whatever it reports. The swipe's own interactive
            // transition is told to finish, as a finger's release would.
            let transition = (gesture.value(forKey: "targets") as? [NSObject])?.lazy
                .compactMap { $0.value(forKey: "target") as? UIPercentDrivenInteractiveTransition }.first
            XCTAssertNotNil(transition, "\(leg): no interactive transition behind the swipe")
            transition?.finish()
            try await settle(app.navigation)
            // The recognizer comes to rest, with nothing left to cancel.
            gesture.isEnabled = false
            gesture.isEnabled = true
        } else {
            gesture.state = letGo
        }
        try await settle(app.navigation)
        XCTAssertEqual(app.navigation.viewControllers.count, letGo == .ended ? 1 : 2, "\(leg): the swipe \(letGo == .ended ? "didn't finish" : "finished")")
    }

    private func settle(_ navigation: UINavigationController) async throws {
        let settled = try await until { navigation.transitionCoordinator == nil }
        XCTAssertTrue(settled, "the transition never ended")
        try await Task.sleep(for: .milliseconds(150))
    }

    private func scrollToEnd(_ sidebar: SidebarList) async throws {
        sidebar.setContentOffsetY(sidebar.edge.contentSize.height + sidebar.contentInsets.bottom - sidebar.bounds.height)
        try await Task.sleep(for: .milliseconds(200))
    }

    @discardableResult
    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func capture(_ window: UIWindow, _ name: String, folder: URL? = HostedHomeInsetsTests.evidence) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.overrideUserInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }
}

/// The app's own window and stack (`AppCoordinator`) with a long home.
@MainActor
struct HomeApp {
    var coordinator: AppCoordinator
    var navigation: UINavigationController
    var window: UIWindow
    var root: UIViewController

    var sidebar: SidebarList? { subview(SidebarList.self, in: root.view) }
    var legacyList: UltraListView? { subview(HomeUltraListView.self, in: root.view)?.list }

    /// A computer's home row's box in the window, as it rests.
    func frame(of id: String) -> CGRect? {
        guard let view = sidebar?.view(for: id) else { return nil }
        return view.convert(view.box, to: window)
    }

    /// The toolbar's search field, in the window, while it shows.
    var field: CGRect? {
        guard let home = root as? AgentHomeViewController else { return nil }
        let field = home.search.bar.searchTextField
        guard field.window != nil, field.bounds.height > 0 else { return nil }
        return field.convert(field.bounds, to: window)
    }

    /// A computer's home, its list `HostedHomeInsetsTests.rows`.
    static func computer(_ test: XCTestCase, style: UIUserInterfaceStyle = .light, rows: [Row] = HostedHomeInsetsTests.rows) async throws -> HomeApp {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in Unreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"insets-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        test.addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await account.agentConnections.remove(computer.id)
        }
        let app = try await start(test, account: account, style: style) { $0 is AgentHomeViewController }
        let sidebar = try XCTUnwrap(app.sidebar)
        let home = try XCTUnwrap(app.root.children.compactMap { $0 as? HomeViewController }.first)
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.rows = rows
        snapshot.allRows = rows
        home.applyConnection(snapshot)
        await sidebar.settle()
        app.window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        return app
    }

    /// A Happy account's home on UltraView, with a computer and enough
    /// sessions to scroll.
    static func legacy(_ test: XCTestCase, style: UIUserInterfaceStyle = .light) async throws -> HomeApp {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: NoSockets())
        try await account.signIn(Credentials(token: "t", secret: Data(repeating: 9, count: 32)))
        let session = try XCTUnwrap(account.session)
        let previous = account.localSettings.homeListRenderer
        account.localSettings.homeListRenderer = .ultraList
        test.addTeardownBlock { @MainActor in account.localSettings.homeListRenderer = previous }
        let store = session.store
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.addPendingSettings(["sessionListGrouping": .string("flat")])
            try store.upsertSessions((0..<40).map(Self.session))
        }.value
        let app = try await start(test, account: account, style: style) { $0 is LegacyHomeViewController }
        let shown = try await until { (app.legacyList?.items.count ?? 0) > 30 }
        XCTAssertTrue(shown, "the legacy home never listed its sessions: \(app.legacyList?.items.map(\.identity) ?? [])")
        try await Task.sleep(for: .milliseconds(400))
        return app
    }

    private static func start(_ test: XCTestCase, account: AccountController, style: UIUserInterfaceStyle, root: (UIViewController) -> Bool) async throws -> HomeApp {
        let context = AppContext(account: account, variant: .preview, version: "test")
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        let coordinator = AppCoordinator(window: window, context: context)
        coordinator.start()
        test.addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        let navigation = try XCTUnwrap(Self.stack(in: window))
        let shown = try await until { navigation.viewControllers.first.map(root) ?? false }
        XCTAssertTrue(shown, "no home: \(navigation.viewControllers)")
        try await Task.sleep(for: .milliseconds(400))
        // The account's theme goes on the window as it starts: the style
        // asked for goes over it.
        window.overrideUserInterfaceStyle = style
        window.layoutIfNeeded()
        XCTAssertEqual(navigation.traitCollection.userInterfaceStyle, style)
        return HomeApp(coordinator: coordinator, navigation: navigation, window: window, root: try XCTUnwrap(navigation.viewControllers.first))
    }

    nonisolated private static func session(_ index: Int) -> SessionRecord {
        let at = SeededAccount.base - Int64(index + 1) * 600_000
        return SessionRecord(
            id: "long-\(index)", seq: 0, createdAt: at, updatedAt: at,
            active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000) - Int64(index) * 1000, projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string("claude"),
                "summary": .object(["text": .string("Older conversation \(index)"), "updatedAt": .number(Double(at))]),
                "lastMeaningfulMessageAt": .number(Double(at)),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: nil, decryptable: true
        )
    }

    private static func stack(in window: UIWindow) -> UINavigationController? {
        var queue = [window.rootViewController].compactMap { $0 }
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let navigation = next as? UINavigationController { return navigation }
            queue += next.children
        }
        return nil
    }

    private static func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        for child in view.subviews {
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }
}

/// A finger on the edge swipe: the recognizer reports where it is.
@MainActor
private final class EdgeFinger {
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
#endif
