#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private struct GlassNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct GlassNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

private struct GlassUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// The header while a chat is pushed from home and popped back to it, and
/// while its detail is pushed over it and popped, read on every frame:
///
/// - no glass of our own in a bar item. iOS 26 morphs a bar item's glass
///   into the next screen's (home's switcher into Back) and blurs and
///   fades what the item holds as it goes. That works on the bar's own
///   glass, the item's shared background. The switcher once hid that and
///   drew a glass capsule of its own (7aee3a9b8), and through the morph
///   the bar drew it as a hard-edged rectangle the item's size;
/// - no item hiding the bar's glass, and nothing opaque in the bar: an
///   item with its shared background hidden goes through the morph as a
///   dark rectangle (the switcher above, a clear spacer in a native
///   reference, `-screen glassReference`);
/// - no glass of ours over the bar's. A title view isn't a bar item: the
///   bar carries it across with its screen's content, so the chat's
///   capsule went over as a second glass shape, on the switcher shrinking
///   into Back and on the right button, and was cut by the next screen's
///   ground. Its glass now leaves for the transition and comes back once
///   the screen stands (`ChatHeaderView.ride`);
/// - nothing in a bar item or the title gone empty: the bar blurs and
///   fades them itself; what they show stays put under that.
@MainActor
final class HostedHeaderGlassTransitionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let rows: [Row] = [
        Row(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
    ] + (0..<6).map { index in
        Row(id: "space:\(index)", nodeId: "n\(index)", kind: .space, label: "Work item \(index)", mark: .glyph("tasks"), agentId: "agent-\(index)", spaceId: "s\(index)")
    }

    /// An agent home over an offline computer, in a window, its list
    /// showing `rows`.
    private func agentHome() async throws -> (UINavigationController, AgentHomeViewController, SidebarList, UIWindow) {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in GlassUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: GlassNoNetwork(), connector: GlassNoSockets()
        )
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"glass-transition","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await account.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        let sidebar = try XCTUnwrap(Self.subview(SidebarList.self, in: home.view))
        sidebar.apply(Self.rows)
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(300))
        return (navigation, home, sidebar, window)
    }

    func testThePushAndTheWayBackKeepTheBarsGlassItsOwn() async throws {
        let (navigation, home, sidebar, _) = try await agentHome()
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem)
        XCTAssertEqual(switcher.customView?.accessibilityIdentifier, "account-switcher")
        XCTAssertFalse(switcher.hidesSharedBackground, "the switcher hides the bar's glass")
        XCTAssertEqual(Self.ownGlass(in: navigation.navigationBar, items: [home.navigationItem]), [], "at rest on home")

        // The push, as a tap on the row makes it.
        let row = try XCTUnwrap(sidebar.view(for: "space:1"))
        let push = try await frames(of: navigation) { sidebar.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY)) }
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController, "the row opened no chat")
        XCTAssertGreaterThan(push.inFlight, 10, "the push wasn't read frame by frame: \(push.inFlight) frames")
        push.assertClean("mid-push")
        XCTAssertTrue(push.titleSeen, "the chat's title wasn't seen in the bar")
        try await assertCapsuleStands(chat, "once pushed")

        let back = try await frames(of: navigation) { _ = navigation.popViewController(animated: true) }
        XCTAssertTrue(navigation.topViewController === home)
        XCTAssertGreaterThan(back.inFlight, 10, "the pop wasn't read frame by frame: \(back.inFlight) frames")
        back.assertClean("on the way back")
    }

    /// The chat's detail, opened from its title, slides its own ground in
    /// over the chat's; the capsule never goes under it as glass.
    func testTheDetailAndBackKeepTheCapsuleOffTheNextScreen() async throws {
        let (navigation, _, sidebar, _) = try await agentHome()
        let row = try XCTUnwrap(sidebar.view(for: "space:2"))
        sidebar.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY))
        try await until("the chat is pushed") { navigation.topViewController is ChatViewController && navigation.transitionCoordinator == nil }
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        try await assertCapsuleStands(chat, "once pushed")
        let header = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView)

        let detail = try await frames(of: navigation) { header.onOpen?() }
        XCTAssertTrue(navigation.topViewController is SessionDetailViewController, "the title opened no detail")
        XCTAssertGreaterThan(detail.inFlight, 10, "the push wasn't read frame by frame: \(detail.inFlight) frames")
        detail.assertClean("as the detail comes")

        let back = try await frames(of: navigation) { _ = navigation.popViewController(animated: true) }
        XCTAssertTrue(navigation.topViewController === chat)
        XCTAssertGreaterThan(back.inFlight, 10, "the pop wasn't read frame by frame: \(back.inFlight) frames")
        back.assertClean("back from the detail")
        try await assertCapsuleStands(chat, "back from the detail")
    }

    /// The chat at rest: its capsule wears its glass again.
    private func assertCapsuleStands(_ chat: UIViewController, _ when: String) async throws {
        let header = try XCTUnwrap(chat.navigationItem.titleView as? ChatHeaderView)
        try await until("the capsule's glass is back \(when)") { header.capsule.effect is UIGlassEffect }
    }

    private func until(_ what: String, _ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), what)
    }

    private struct Frames {
        /// Frames read with the transition under way.
        var inFlight = 0
        /// Each finding once, in the order first seen.
        var ownGlass: [String] = []
        var overlaps: [String] = []
        var hiddenBackgrounds: [String] = []
        var opaque: [String] = []
        var emptied: [String] = []
        /// A title view was in the bar.
        var titleSeen = false

        static func note(_ finding: String, in list: inout [String]) {
            if !list.contains(finding) { list.append(finding) }
        }

        func assertClean(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertEqual(ownGlass, [], "glass of its own in a bar item \(when)", file: file, line: line)
            XCTAssertEqual(overlaps, [], "glass of ours over the bar's \(when)", file: file, line: line)
            XCTAssertEqual(hiddenBackgrounds, [], "a bar item hides the bar's glass \(when)", file: file, line: line)
            XCTAssertEqual(opaque, [], "something opaque in the bar \(when)", file: file, line: line)
            XCTAssertEqual(emptied, [], "a bar item or title gone empty \(when)", file: file, line: line)
        }
    }

    /// Starts a transition with `start` and reads the bar on every frame
    /// until it is over.
    private func frames(of navigation: UINavigationController, _ start: () -> Void) async throws -> Frames {
        var frames = Frames()
        let bar = navigation.navigationBar
        let read = { @MainActor in
            guard navigation.transitionCoordinator != nil, let window = bar.window else { return }
            frames.inFlight += 1
            // Both screens' items are in the bar while it changes over.
            let items = navigation.viewControllers.map(\.navigationItem)
            for glass in Self.ownGlass(in: bar, items: items) { Frames.note(glass, in: &frames.ownGlass) }
            for overlap in Self.overlaps(in: bar, window: window) { Frames.note(overlap, in: &frames.overlaps) }
            for item in Self.barItems(items) where item.hidesSharedBackground {
                Frames.note(item.accessibilityIdentifier ?? item.customView.map { "\(type(of: $0))" } ?? "item", in: &frames.hiddenBackgrounds)
            }
            for view in Self.opaque(in: bar, window: window) { Frames.note(view, in: &frames.opaque) }
            for view in Self.emptied(in: bar, items: items) { Frames.note(view, in: &frames.emptied) }
            if items.contains(where: { $0.titleView?.isDescendant(of: bar) == true }) { frames.titleSeen = true }
        }
        let ticks = TickRecorder { _ in read() }
        defer { ticks.stop() }
        start()
        let deadline = ContinuousClock.now + .seconds(5)
        repeat {
            try await Task.sleep(for: .milliseconds(8))
        } while (navigation.transitionCoordinator != nil || frames.inFlight == 0) && ContinuousClock.now < deadline
        XCTAssertNil(navigation.transitionCoordinator, "the transition never ended")
        return frames
    }

    private static func barItems(_ items: [UINavigationItem]) -> [UIBarButtonItem] {
        items.flatMap { ($0.leftBarButtonItems ?? []) + ($0.rightBarButtonItems ?? []) + ($0.backBarButtonItem.map { [$0] } ?? []) }
    }

    /// Glass views in `bar` that belong to a bar button item of `items`:
    /// what the bar can't morph.
    private static func ownGlass(in bar: UINavigationBar, items: [UINavigationItem]) -> [String] {
        let custom = barItems(items).compactMap(\.customView)
        return custom.filter { $0.isDescendant(of: bar) }.flatMap { view in
            glassViews(in: view).map { "\(view.accessibilityIdentifier ?? "\(type(of: view))"): \(type(of: $0))" }
        }
    }

    /// Glass of ours (a title view's, anything not the bar's own) lying
    /// over the bar's own glass on screen, where each is this frame.
    private static func overlaps(in bar: UINavigationBar, window: UIWindow) -> [String] {
        let platters = views(in: bar).filter(isBarGlass).compactMap { onScreen($0, in: window) }
        // The bar's glass is found by its private name: if iOS renames it,
        // say so rather than find nothing to overlap.
        guard !platters.isEmpty else { return ["no bar glass found to hold ours against"] }
        let ours = glassViews(in: bar).filter { glass in
            !views(above: glass, upTo: bar).contains(where: isBarGlass)
        }
        return ours.compactMap { glass in
            guard let frame = onScreen(glass, in: window) else { return nil }
            let hit = platters.contains { platter in
                let common = platter.intersection(frame)
                return !common.isNull && common.width > 2 && common.height > 2
            }
            return hit ? "\(glass.accessibilityIdentifier ?? "\(type(of: glass))")" : nil
        }
    }

    /// The glass the bar draws round its items.
    private static func isBarGlass(_ view: UIView) -> Bool {
        String(describing: type(of: view)) == "PlatterGlassView"
    }

    /// Views in the bar with a ground that hides what is under them: the
    /// bar is clear, its glass is glass and its words have none.
    private static func opaque(in bar: UINavigationBar, window: UIWindow) -> [String] {
        views(in: bar).compactMap { view in
            let layer = view.layer.presentation() ?? view.layer
            guard let ground = layer.backgroundColor, ground.alpha >= 0.5,
                  let frame = onScreen(view, in: window), frame.width * frame.height >= 64 else { return nil }
            return "\(view.accessibilityIdentifier ?? "\(type(of: view))") \(frame.integral)"
        }
    }

    /// Bar items' custom views, and title views, in the bar with nothing
    /// left to show: hidden, faded by us, or their words and pictures gone.
    /// The bar's own blur and fade are on its views round them.
    private static func emptied(in bar: UINavigationBar, items: [UINavigationItem]) -> [String] {
        let shown = (barItems(items).compactMap(\.customView) + items.compactMap(\.titleView)).filter { $0.isDescendant(of: bar) }
        return shown.compactMap { view in
            let name = view.accessibilityIdentifier ?? "\(type(of: view))"
            if view.isHidden || (view.layer.presentation() ?? view.layer).opacity < 0.5 { return "\(name) hidden" }
            let content = views(in: view).filter { inner in
                guard (inner as? UILabel)?.text?.isEmpty == false || (inner as? UIImageView)?.image != nil else { return false }
                return ([inner] + views(above: inner, upTo: view)).allSatisfy { !$0.isHidden && ($0.layer.presentation() ?? $0.layer).opacity >= 0.5 }
            }
            return content.isEmpty ? "\(name) empty" : nil
        }
    }

    private static func glassViews(in view: UIView) -> [UIVisualEffectView] {
        let own = (view as? UIVisualEffectView).flatMap { $0.effect is UIGlassEffect || $0.effect is UIGlassContainerEffect ? [$0] : nil } ?? []
        return own + view.subviews.flatMap(glassViews)
    }

    private static func views(in view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap(views)
    }

    /// `view`'s ancestors below `top`.
    private static func views(above view: UIView, upTo top: UIView) -> [UIView] {
        var found: [UIView] = []
        var ancestor = view.superview
        while let current = ancestor, current !== top {
            found.append(current)
            ancestor = current.superview
        }
        return found
    }

    /// Where `view` is on screen this frame, nil when it doesn't show.
    private static func onScreen(_ view: UIView, in window: UIWindow) -> CGRect? {
        var opacity: Float = 1
        var current: UIView? = view
        while let shown = current, shown !== window {
            if shown.isHidden { return nil }
            opacity *= (shown.layer.presentation() ?? shown.layer).opacity
            current = shown.superview
        }
        guard current === window, opacity > 0.01 else { return nil }
        let layer = view.layer.presentation() ?? view.layer
        return layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer)
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { subview(type, in: $0) }.first
    }
}
#endif
