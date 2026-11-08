#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private struct SteadyNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct SteadyNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

private struct SteadyAgentTransport: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw URLError(.cannotConnectToHost) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// A connection that comes and goes moves nothing in the header or under
/// it: the switcher's picture stays where it is while "Connecting…" takes
/// the name's place and goes, and a chat's name stays put while "Thinking"
/// does. Stills
/// of each state go to the repository's `.context/evidence/header-steady`
/// when that folder's parent exists.
@MainActor
final class HostedHeaderSteadyTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/header-steady")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        guard let folder = Self.evidence else { return }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
    }

    private func metrics(_ name: String, _ frames: [CGRect]) {
        guard let folder = Self.evidence else { return }
        try? frames.map { String(describing: $0) }.joined(separator: "\n").write(to: folder.appendingPathComponent("\(name).txt"), atomically: true, encoding: .utf8)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<300 where !condition() { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    private static func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + subviews(type, in: $0) }
    }

    /// Where everything a flip could move is, in the window.
    private struct Where: Equatable {
        var bar: CGRect
        var switcher: CGRect
        var name: CGRect
        var list: CGRect
        var offset: CGPoint
        var inset: UIEdgeInsets
        var firstRow: CGRect
    }

    func testTheAccountsNameHoldsStillAsTheConnectionComesAndGoes() async throws {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SteadyNoNetwork(), connector: SteadyNoSockets()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 5, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { try SeededAccount.seed(store) }.value
        let feed = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { feed.cancel() }
        try await until { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await until { home.children.contains { $0 is SessionListViewController } }
        try await Task.sleep(for: .milliseconds(400))
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        let list = try XCTUnwrap(home.children.compactMap { $0 as? SessionListViewController }.first)
        let scroll = try XCTUnwrap((list.view as? UIScrollView) ?? Self.subviews(UIScrollView.self, in: list.view).first { $0.bounds.height > 200 })

        func now() throws -> Where {
            window.layoutIfNeeded()
            let name = switcher.nameLabel
            let rows = scroll.subviews.filter { !$0.isHidden && $0.frame.height > 20 && $0.frame.maxY > scroll.contentOffset.y + scroll.adjustedContentInset.top }
            let first = try XCTUnwrap(rows.min { $0.frame.minY < $1.frame.minY })
            return Where(
                bar: navigation.navigationBar.convert(navigation.navigationBar.bounds, to: window),
                switcher: switcher.convert(switcher.bounds, to: window).integral,
                // In its lane: the lane lifts it away as the status comes.
                // Rounded past float noise from a fractional width.
                name: name.frame.rounded(),
                list: scroll.convert(scroll.bounds, to: window),
                offset: scroll.contentOffset, inset: scroll.contentInset,
                firstRow: first.convert(first.bounds, to: window)
            )
        }

        home.headerState = .online
        try await Task.sleep(for: .milliseconds(300))
        let live = try now()
        capture(window, "1-legacy-home-connected")
        let flips: [LinkState] = [.connecting, .online, .connecting, .waitingForNetwork, .syncing, .online, .connecting]
        for (index, state) in flips.enumerated() {
            home.headerState = state
            try await Task.sleep(for: .milliseconds(120))
            let seen = try now()
            if index < 2 { capture(window, "\(index + 2)-legacy-home-\(state)") }
            XCTAssertEqual(seen.bar, live.bar, "the bar moved at \(state)")
            XCTAssertEqual(seen.switcher.origin, live.switcher.origin, "the switcher moved at \(state)")
            XCTAssertEqual(seen.switcher.height, live.switcher.height)
            XCTAssertEqual(seen.name.origin, live.name.origin, "the account's name moved at \(state)")
            XCTAssertEqual(seen.list, live.list, "the list moved at \(state)")
            XCTAssertEqual(seen.offset, live.offset, "the list scrolled at \(state)")
            XCTAssertEqual(seen.inset, live.inset, "the list's inset changed at \(state)")
            XCTAssertEqual(seen.firstRow, live.firstRow, "the first row moved at \(state)")
        }
        await controller.signOut()
    }

    /// The agent's work comes and goes under a chat's name many times a
    /// minute: the name stays on its line throughout.
    func testAChatsNameHoldsStillAsTheAgentStartsAndStops() async throws {
        let screen = UIViewController()
        screen.view.backgroundColor = .systemBackground
        let transcript = UIScrollView(frame: screen.view.bounds)
        transcript.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        transcript.contentInsetAdjustmentBehavior = .always
        transcript.contentSize = CGSize(width: 300, height: 1_000)
        let firstRow = UILabel(frame: CGRect(x: 20, y: 24, width: 280, height: 44))
        firstRow.text = "Write a poem about a pineapple"
        transcript.addSubview(firstRow)
        screen.view.addSubview(transcript)
        let header = ChatHeaderView()
        header.status = Strings.HeaderStatus.text(.online)
        header.titleView.text = "Pineapple poem"
        header.maxWidth = 274
        screen.navigationItem.titleView = header
        let navigation = UINavigationController(rootViewController: screen)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(200))
        func name() -> CGRect {
            window.layoutIfNeeded()
            return header.titleView.convert(header.titleView.bounds, to: window)
        }
        let idle = name()
        let headerFrame = header.convert(header.bounds, to: window)
        let rowFrame = firstRow.convert(firstRow.bounds, to: window)
        let transcriptFrame = transcript.convert(transcript.bounds, to: window)
        let inset = transcript.adjustedContentInset
        let bar = navigation.navigationBar.convert(navigation.navigationBar.bounds, to: window)
        metrics("chat-frames-bar-header-title-firstRow-transcript", [bar, headerFrame, idle, rowFrame, transcriptFrame])
        capture(window, "5-chat-idle")
        let statuses = Strings.HeaderStatus.all + Strings.HeaderStatus.all.reversed()
        for (index, status) in statuses.enumerated() {
            header.status = status
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertFalse(header.status.isEmpty)
            let label = try XCTUnwrap(Self.subviews(UILabel.self, in: header).first { $0.accessibilityIdentifier == "chat-status" })
            XCTAssertEqual(label.text, status)
            XCTAssertFalse(label.isHidden)
            XCTAssertEqual(name(), idle, "the chat's name moved at \(status)")
            XCTAssertEqual(header.convert(header.bounds, to: window), headerFrame)
            XCTAssertEqual(firstRow.convert(firstRow.bounds, to: window), rowFrame)
            XCTAssertEqual(transcript.convert(transcript.bounds, to: window), transcriptFrame)
            XCTAssertEqual(transcript.adjustedContentInset, inset)
            XCTAssertEqual(navigation.navigationBar.convert(navigation.navigationBar.bounds, to: window), bar)
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertEqual(name(), idle, "the name moved after the fade")
            if index < Strings.HeaderStatus.all.count { capture(window, "chat-status-\(index)") }
            if status == Strings.HeaderStatus.all[4] { capture(window, "6-chat-thinking") }
        }
    }

    func testAgentHomeKeepsItsHeaderThroughEveryStatusItsRowsUnderTheNotice() async throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in SteadyAgentTransport() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: SteadyNoNetwork(), connector: SteadyNoSockets()
        )
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"steady-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        defer { Session.forget(connection.id) }
        let home = AgentHomeViewController(context: AppContext(account: account, variant: .preview, version: "test"), id: connection.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let sidebar = try XCTUnwrap(Self.subviews(SidebarList.self, in: home.view).first)
        let rows = (0..<30).map { Row(id: "s:\($0)", nodeId: "n\($0)", kind: .space, label: "Work \($0)", mark: .happy, agentId: "a\($0)", spaceId: "s\($0)") }
        let content = try XCTUnwrap(home.children.compactMap { $0 as? HomeViewController }.first)
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.rows = rows
        snapshot.allRows = rows
        try await Task.sleep(for: .milliseconds(300))
        content.applyConnection(snapshot)
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(200))
        window.layoutIfNeeded()
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        let name = switcher.nameLabel
        /// The switcher's width follows its title; its place doesn't.
        func frames() -> [CGRect] {
            window.layoutIfNeeded()
            // The bar's glass round it is placed in fractions of a point.
            let switcherFrame = switcher.convert(switcher.bounds, to: window).rounded()
            // The name in its lane: the lane lifts it away as the status comes.
            return [navigation.navigationBar, sidebar].map { $0.convert($0.bounds, to: window) } + [name.frame.rounded()]
                + [CGRect(origin: switcherFrame.origin, size: CGSize(width: 0, height: switcherFrame.height))]
        }
        /// The first row, as it rests. The offline notice is the list's
        /// first row (`SidebarList.notice`), so the row stands under it.
        func firstRow() throws -> CGRect {
            let row = try XCTUnwrap(sidebar.view(for: "s:0"))
            return row.convert(row.bounds, to: window)
        }
        home.headerState = .online
        try await Task.sleep(for: .milliseconds(250))
        let original = frames()
        let originalRow = try firstRow()
        metrics("home-frames-bar-switcher-title-sidebar-firstRow", original + [originalRow])
        let inset = sidebar.contentInsets
        let offset = sidebar.contentOffsetY
        capture(window, "7-agent-home-online")
        for state in Strings.HeaderStatus.State.allCases + Strings.HeaderStatus.State.allCases.reversed() {
            home.headerState = state
            snapshot.live = state == .online
            snapshot.error = state == .offline ? "The computer is offline" : nil
            content.applyConnection(snapshot)
            try await Task.sleep(for: .milliseconds(80))
            XCTAssertEqual(frames(), original, "mid-fade at \(state)")
            XCTAssertEqual(sidebar.contentInsets, inset)
            XCTAssertEqual(sidebar.contentOffsetY, offset)
            XCTAssertEqual(sidebar.rows.map(\.id), rows.map(\.id))
            try await Task.sleep(for: .milliseconds(250))
            XCTAssertEqual(frames(), original, "settled at \(state)")
            XCTAssertEqual(switcher.status, Strings.HeaderStatus.title(state), "the title at \(state)")
            let notice = snapshot.error == nil ? 0 : try XCTUnwrap(sidebar.list.settledFrame(at: 0)).height
            XCTAssertEqual(try firstRow(), originalRow.offsetBy(dx: 0, dy: notice), "the first row isn't under the notice at \(state)")
            capture(window, "agent-home-\(state)")
            if state == .connecting { capture(window, "8-agent-home-connecting") }
        }
        try await account.agentConnections.remove(connection.id)
    }

    func testConnectionAndActivityPriorityAndEveryShippedLanguage() async throws {
        let thinking = Activity(phase: .thinking, startedAt: nil)
        for state in Strings.HeaderStatus.State.allCases where state != .online {
            XCTAssertEqual(Strings.HeaderStatus.text(state, activity: thinking, loaded: true), Strings.HeaderStatus.text(state))
        }
        XCTAssertEqual(Strings.HeaderStatus.text(.online, activity: thinking, loaded: false), "updating…")
        XCTAssertEqual(Strings.HeaderStatus.text(.online, activity: thinking, loaded: true), "Thinking")
        XCTAssertEqual(Strings.HeaderStatus.text(.online, activity: nil, loaded: true), "online")
        XCTAssertEqual(Strings.HeaderStatus.text(.online, activity: Activity(phase: .awaitingAnswer, startedAt: nil), loaded: true), "Waiting for your answer")
        XCTAssertEqual(Set(Strings.HeaderStatus.translations.keys), Set(AppLanguage.supported.map(\.code)))
        for text in Strings.HeaderStatus.translations.values { XCTAssertEqual(text.count, 8); XCTAssertTrue(text.allSatisfy { !$0.isEmpty }) }
        var snapshot = HomeSnapshot()
        XCTAssertEqual(Session.headerState(status: .connecting, snapshot: snapshot), .connecting)
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .syncing)
        snapshot.loaded = true; snapshot.live = true
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .syncing, "an open stream is still catching up")
        snapshot.syncing = false
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .online)
        snapshot.live = false; snapshot.error = "offline"
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .offline)
        // Retrying after the computer did not answer: home's notice says
        // so, the header says offline rather than connecting for it too.
        XCTAssertEqual(Session.headerState(status: .retrying, snapshot: snapshot), .offline)
        snapshot.error = nil
        XCTAssertEqual(Session.headerState(status: .retrying, snapshot: snapshot), .connecting)
        XCTAssertEqual(Session.headerState(status: .paused, snapshot: snapshot), .offline)
        XCTAssertEqual(Session.headerState(status: .revoked, snapshot: snapshot), .offline)
        // The stream is open: live, whatever the pairing's check last said.
        snapshot.live = true
        XCTAssertEqual(Session.headerState(status: .retrying, snapshot: snapshot), .online)
        XCTAssertEqual(Session.headerState(status: .revoked, snapshot: snapshot), .offline)
        XCTAssertEqual(Session.headerState(status: .connecting, snapshot: snapshot, network: false), .waitingForNetwork)
        // A signed-in server's stream on its way back: connecting, whatever
        // the server's own check says, until the stream is live again.
        snapshot.live = false; snapshot.error = nil; snapshot.reconnecting = true
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .connecting)
        XCTAssertEqual(Session.headerState(status: .retrying, snapshot: snapshot), .connecting)
        XCTAssertEqual(Session.headerState(status: .paused, snapshot: snapshot), .offline)
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot, network: false), .waitingForNetwork)
        snapshot.live = true; snapshot.syncing = true
        XCTAssertEqual(Session.headerState(status: .connected, snapshot: snapshot), .syncing, "live again, it catches up")
    }
}

private extension CGRect {
    /// To a thousandth of a point.
    func rounded() -> CGRect {
        func r(_ value: CGFloat) -> CGFloat { (value * 1_000).rounded() / 1_000 }
        return CGRect(x: r(minX), y: r(minY), width: r(width), height: r(height))
    }
}
#endif
