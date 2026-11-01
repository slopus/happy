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

/// The bar's glass while a chat is pushed from home and popped back to
/// it, read on every frame of both: no glass of our own in a bar item.
///
/// iOS 26 morphs a bar item's glass into the next screen's (home's
/// switcher into Back) and blurs and fades what the item holds as it
/// goes. That works on the bar's own glass, the item's shared background.
/// The switcher once hid that and drew a glass capsule of its own
/// (7aee3a9b8), and through the morph the bar drew it as a hard-edged
/// rectangle the item's size, for the whole of the push and the swipe
/// back. A title view's own glass, the chat's capsule, isn't in an item
/// and goes through the bar's crossfade whole.
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

    func testThePushAndTheWayBackKeepTheBarsGlassItsOwn() async throws {
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
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let sidebar = try XCTUnwrap(Self.subview(SidebarList.self, in: home.view))
        sidebar.apply(Self.rows)
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(300))
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem)
        XCTAssertEqual(switcher.customView?.accessibilityIdentifier, "account-switcher")
        XCTAssertFalse(switcher.hidesSharedBackground, "the switcher hides the bar's glass")
        XCTAssertEqual(Self.ownGlass(in: navigation.navigationBar, items: [home.navigationItem]), [], "at rest on home")

        // The push, as a tap on the row makes it.
        let row = try XCTUnwrap(sidebar.view(for: "space:1"))
        let push = try await frames(of: navigation) { sidebar.tap(row, at: CGPoint(x: row.box.midX, y: row.box.midY)) }
        XCTAssertTrue(navigation.topViewController is ChatViewController, "the row opened no chat")
        XCTAssertGreaterThan(push.inFlight, 10, "the push wasn't read frame by frame: \(push.inFlight) frames")
        XCTAssertEqual(push.found, [], "glass of its own in a bar item mid-push")
        // The chat's capsule is its title view's own, as it should be: the
        // scan sees glass and lets it be.
        XCTAssertTrue(push.titleGlass, "the chat's capsule wasn't seen")
        try await Task.sleep(for: .milliseconds(300))

        let back = try await frames(of: navigation) { _ = navigation.popViewController(animated: true) }
        XCTAssertTrue(navigation.topViewController === home)
        XCTAssertGreaterThan(back.inFlight, 10, "the pop wasn't read frame by frame: \(back.inFlight) frames")
        XCTAssertEqual(back.found, [], "glass of its own in a bar item on the way back")
    }

    private struct Frames {
        /// Frames read with the transition under way.
        var inFlight = 0
        /// "item: glass view" for each own glass seen, once each.
        var found: [String] = []
        /// A title view's glass was there.
        var titleGlass = false
    }

    /// Starts a transition with `start` and reads the bar on every frame
    /// until it is over.
    private func frames(of navigation: UINavigationController, _ start: () -> Void) async throws -> Frames {
        var frames = Frames()
        let bar = navigation.navigationBar
        let read = { @MainActor in
            guard navigation.transitionCoordinator != nil else { return }
            frames.inFlight += 1
            // Both screens' items are in the bar while it changes over.
            let items = navigation.viewControllers.map(\.navigationItem)
            for glass in Self.ownGlass(in: bar, items: items) where !frames.found.contains(glass) {
                frames.found.append(glass)
            }
            if items.contains(where: { $0.titleView.map(Self.holdsGlass) == true }) { frames.titleGlass = true }
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

    /// Glass views in `bar` that belong to a bar button item of `items`:
    /// what the bar can't morph.
    private static func ownGlass(in bar: UINavigationBar, items: [UINavigationItem]) -> [String] {
        let custom = items.flatMap { ($0.leftBarButtonItems ?? []) + ($0.rightBarButtonItems ?? []) }.compactMap(\.customView)
        return custom.filter { $0.isDescendant(of: bar) }.flatMap { view in
            glassViews(in: view).map { "\(view.accessibilityIdentifier ?? "\(type(of: view))"): \(type(of: $0))" }
        }
    }

    private static func holdsGlass(_ view: UIView) -> Bool { !glassViews(in: view).isEmpty }

    private static func glassViews(in view: UIView) -> [UIVisualEffectView] {
        let own = (view as? UIVisualEffectView).flatMap { $0.effect is UIGlassEffect || $0.effect is UIGlassContainerEffect ? [$0] : nil } ?? []
        return own + view.subviews.flatMap(glassViews)
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { subview(type, in: $0) }.first
    }
}
#endif
