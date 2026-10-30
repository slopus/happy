#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private struct HeaderNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct HeaderNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

private struct HeaderUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Home, chat and settings under a running window: the bar is UIKit's,
/// clear, its items in `HeaderBar.Trailing`'s order with the switcher alone
/// at the left; and search opens, finds and closes over home without home's
/// list moving at all. With `HAPPY_PREVIEW_DIR` set, it writes what it saw.
@MainActor
final class HostedHeaderBarTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let rows: [Row] = [
        Row(id: "space:happy", nodeId: "happy", kind: .space, label: "Happy", mark: .happy, isHappy: true, agentId: "agent-happy", spaceId: "happy"),
        Row(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
    ] + (0..<40).map { index in
        Row(id: "space:\(index)", nodeId: "n\(index)", kind: .space, label: "Work item \(index)", mark: .glyph(index.isMultiple(of: 2) ? "tasks" : "agents"), agentId: "agent-\(index)", spaceId: "s\(index)")
    }

    private func agentHome(style: UIUserInterfaceStyle) async throws -> (UIWindow, UINavigationController, AgentHomeViewController, SidebarView) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            agentTransport: { _ in HeaderUnreachable() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: HeaderNoNetwork(),
            connector: HeaderNoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"header-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Steve’s Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = style
        window.layoutIfNeeded()
        let sidebar = try XCTUnwrap(Self.subview(SidebarView.self, in: home.view) { $0.accessibilityIdentifier != "search-results-list" })
        sidebar.apply(Self.rows)
        home.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        return (window, navigation, home, sidebar)
    }

    private struct ListState: Equatable {
        var ids: [String]
        var offset: CGPoint
        var inset: UIEdgeInsets
        var frame: CGRect
    }

    private func state(_ sidebar: SidebarView) -> ListState {
        ListState(ids: sidebar.rows.map(\.id), offset: sidebar.contentOffset, inset: sidebar.contentInset, frame: sidebar.frame)
    }

    func testAgentHomeBarIsClearWithTheSwitcherAloneAtTheLeft() async throws {
        let (window, _, home, _) = try await agentHome(style: .light)
        defer { window.isHidden = true }
        let item = home.navigationItem
        XCTAssertNil(item.searchController, "search is the bar's own field, not a search controller")
        XCTAssertEqual(item.leftBarButtonItems?.count, 1)
        XCTAssertEqual(item.leftBarButtonItem?.customView?.accessibilityIdentifier, "account-switcher")
        let switcher = try XCTUnwrap(item.leftBarButtonItem?.customView)
        // The bar gives a custom item 36: the picture must sit inside it.
        for child in switcher.subviews where !child.isHidden {
            XCTAssertTrue(switcher.bounds.contains(child.frame), "\(child) is cut by the bar")
        }
        // rightBarButtonItems run from the outermost in: settings, (compose), search.
        let right = item.rightBarButtonItems?.map(\.accessibilityIdentifier) ?? []
        XCTAssertEqual(right.first, "settings")
        XCTAssertEqual(right.last, "search")
        XCTAssertEqual(right.filter { $0 != "compose" }, ["settings", "search"])
        let bar = try XCTUnwrap(home.navigationController?.navigationBar)
        Self.assertClear(bar)
    }

    func testSearchOpensFindsAndClosesWithoutMovingHome() async throws {
        for (style, name) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            let (window, navigation, home, sidebar) = try await agentHome(style: style)
            defer { window.isHidden = true }
            keep(window, "home-top-\(name)")
            // Mid-scroll: the case that moved before.
            sidebar.contentOffset.y = 400
            home.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            keep(window, "home-scrolled-\(name)")
            let before = state(sidebar)

            home.search.begin()
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertTrue(home.search.isActive)
            XCTAssertTrue(home.navigationItem.titleView === home.search.bar)
            XCTAssertNil(home.navigationItem.rightBarButtonItems)
            XCTAssertEqual(state(sidebar), before, "opening search moved home")
            let results = try XCTUnwrap(Self.subview(HomeSearchResultsView.self, in: home.view))
            XCTAssertFalse(results.showsResults, "nothing typed, nothing over home")
            keep(window, "search-open-\(name)")

            type("settings", into: home.search.bar)
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertTrue(results.showsResults)
            XCTAssertTrue(results.list.rows.contains { $0.kind == .result }, "the settings quick action answers")
            XCTAssertEqual(state(sidebar), before, "results replaced or moved home")
            keep(window, "search-results-\(name)")

            type("zzzz-nothing", into: home.search.bar)
            try await Task.sleep(for: .milliseconds(300))
            XCTAssertFalse(results.showsResults)
            XCTAssertEqual(state(sidebar), before)
            keep(window, "search-nothing-\(name)")

            type("", into: home.search.bar)
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertFalse(results.showsResults)
            XCTAssertEqual(state(sidebar), before)

            // A result opens its screen; back, the search is still there.
            type("settings", into: home.search.bar)
            try await Task.sleep(for: .milliseconds(200))
            let open = try XCTUnwrap(results.list.rows.first { $0.id == "search:actions:settings" })
            let row = try XCTUnwrap(results.list.subviews.compactMap { $0 as? RowView }.first { $0.row?.id == open.id })
            results.list.tap(row, at: CGPoint(x: row.frame.midX, y: row.frame.midY))
            try await settle(navigation)
            XCTAssertTrue(navigation.topViewController is SettingsViewController)
            navigation.popViewController(animated: true)
            try await settle(navigation)
            XCTAssertTrue(navigation.topViewController === home)
            XCTAssertTrue(home.search.isActive)
            XCTAssertEqual(state(sidebar), before)

            home.search.end()
            try await Task.sleep(for: .milliseconds(600))
            XCTAssertFalse(home.search.isActive)
            XCTAssertFalse(results.showsResults)
            XCTAssertEqual(home.navigationItem.leftBarButtonItem?.customView?.accessibilityIdentifier, "account-switcher")
            XCTAssertEqual(home.navigationItem.rightBarButtonItems?.first?.accessibilityIdentifier, "settings")
            XCTAssertEqual(state(sidebar), before, "closing search moved home")
            keep(window, "search-closed-\(name)")
        }
    }

    func testChatAndSettingsHaveTheClearBar() async throws {
        let (window, navigation, home, sidebar) = try await agentHome(style: .light)
        defer { window.isHidden = true }
        let row = try XCTUnwrap(sidebar.subviews.compactMap { $0 as? RowView }.first { $0.row?.id == "space:1" })
        sidebar.tap(row, at: CGPoint(x: row.frame.midX, y: row.frame.midY))
        try await settle(navigation)
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        XCTAssertNil(chat.navigationItem.standardAppearance, "the bar's own, shared look")
        Self.assertClear(navigation.navigationBar)
        keep(window, "chat-light")
        navigation.popViewController(animated: false)
        SettingsViewController.open(context: try XCTUnwrap(Mirror(reflecting: home).descendant("context") as? AppContext), computer: nil, from: home)
        try await settle(navigation)
        try await Task.sleep(for: .milliseconds(400))
        let settings = try XCTUnwrap(navigation.topViewController as? SettingsViewController)
        XCTAssertNil(settings.navigationItem.standardAppearance)
        Self.assertClear(navigation.navigationBar)
        keep(window, "settings-light")
    }

    func testLegacyHomeHasTheSwitcherAndTheClearBar() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: HeaderNoNetwork(), connector: HeaderNoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(home.navigationItem.leftBarButtonItem?.customView?.accessibilityIdentifier, "account-switcher")
        XCTAssertNil(home.navigationItem.standardAppearance)
        Self.assertClear(navigation.navigationBar)
        keep(window, "legacy-home-light")
    }

    /// No ground, no blur, no line, the same scrolled as at the edge: the
    /// bar is whatever background the screen has.
    private static func assertClear(_ bar: UINavigationBar, file: StaticString = #filePath, line: UInt = #line) {
        for appearance in [bar.standardAppearance, bar.scrollEdgeAppearance, bar.compactAppearance, bar.compactScrollEdgeAppearance].compactMap({ $0 }) {
            XCTAssertTrue(appearance.backgroundColor == nil || appearance.backgroundColor == .clear, file: file, line: line)
            XCTAssertNil(appearance.backgroundEffect, file: file, line: line)
            XCTAssertTrue(appearance.shadowColor == nil || appearance.shadowColor == .clear, file: file, line: line)
            XCTAssertNil(appearance.backgroundImage, file: file, line: line)
        }
        XCTAssertEqual(bar.standardAppearance, bar.scrollEdgeAppearance, "no change between the edge and scrolled", file: file, line: line)
    }

    private func type(_ text: String, into bar: UISearchBar) {
        bar.text = text
        bar.delegate?.searchBar?(bar, textDidChange: text)
    }

    private func settle(_ navigation: UINavigationController) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while navigation.transitionCoordinator != nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertNil(navigation.transitionCoordinator, "the transition never ended")
        try await Task.sleep(for: .milliseconds(100))
    }

    private func keep(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView, where test: (T) -> Bool = { _ in true }) -> T? {
        if let match = view as? T, test(match) { return match }
        for child in view.subviews {
            if let match = subview(type, in: child, where: test) { return match }
        }
        return nil
    }
}
#endif
