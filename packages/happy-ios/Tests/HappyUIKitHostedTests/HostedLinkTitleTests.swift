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

/// A socket that is always on its way and never there: the account's own
/// status stays "connecting" and the test says the rest.
private struct ForeverConnecting: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        try await Task.sleep(for: .seconds(3_600))
        throw URLError(.timedOut)
    }
}

private struct NoComputer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw URLError(.cannotConnectToHost) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// A computer that never answers, telling which tunnels were let go of.
private final class MovingComputer: AgentTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [RequestCategory] = []
    var resets: [RequestCategory] { lock.withLock { heard } }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw URLError(.cannotConnectToHost) }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func reset(_ category: RequestCategory) async { lock.withLock { heard.append(category) } }
    func close() async {}
}

/// Home's title through a link that goes and comes back, on both homes:
/// connecting, updating, live, never offline. At each step the title says what
/// it should, the picture, the bar and its other items stay where they
/// are, and mid-change both the name and the status are partly there.
/// Stills (light and dark) and mid-change frames go to the repository's
/// `.context/evidence/link-title` when its `.context` exists.
@MainActor
final class HostedLinkTitleTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    override func tearDown() {
        NetworkPath.shared.force(nil)
        super.tearDown()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/link-title")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    /// The iPad's stills apart from the phone's.
    private static var device: String { UIDevice.current.userInterfaceIdiom == .pad ? "ipad-" : "" }

    /// The window as it is on screen, mid-animation included.
    private func capture(_ window: UIWindow, _ name: String, settled: Bool = true) {
        guard let folder = Self.evidence else { return }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: settled)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(Self.device)\(name).png"))
    }

    /// Light and dark stills of the same moment.
    private func captureBoth(_ window: UIWindow, _ name: String) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(120))
            capture(window, "\(name)-\(style == .light ? "light" : "dark")")
        }
        window.overrideUserInterfaceStyle = .light
        try await Task.sleep(for: .milliseconds(60))
    }

    private func note(_ name: String, _ lines: [String]) {
        guard let folder = Self.evidence else { return }
        try? lines.joined(separator: "\n").write(to: folder.appendingPathComponent("\(Self.device)\(name).txt"), atomically: true, encoding: .utf8)
    }

    private func until(_ what: String, _ seconds: Double = 6, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), what)
    }

    private static func views(_ view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap(views)
    }

    /// Everything in the header that must hold still, in the window.
    private struct Header: Equatable {
        var bar: CGRect
        var switcherOrigin: CGPoint
        var picture: CGRect
        var items: [CGRect]
    }

    private func header(_ navigation: UINavigationController, _ switcher: AccountSwitcherButton, items: [String]) throws -> Header {
        let window = try XCTUnwrap(navigation.view.window)
        window.layoutIfNeeded()
        let bar = navigation.navigationBar
        let picture = try XCTUnwrap(switcher.subviews.first { $0 is UIImageView && $0.layer.cornerRadius > 0 })
        let bySide = navigation.topViewController?.navigationItem.rightBarButtonItems ?? []
        let found = try items.map { id in
            // The item's own view, as the bar placed it.
            let item = try XCTUnwrap(bySide.first { $0.accessibilityIdentifier == id }, "no \(id) item")
            let view = try XCTUnwrap(item.value(forKey: "view") as? UIView, "no view for \(id) in the bar")
            XCTAssertNotNil(view.window, "\(id) isn't on screen")
            return view.convert(view.bounds, to: window)
        }
        // To a thousandth of a point, past float noise from fractional widths.
        func r(_ rect: CGRect) -> CGRect {
            func r(_ value: CGFloat) -> CGFloat { (value * 1_000).rounded() / 1_000 }
            return CGRect(x: r(rect.minX), y: r(rect.minY), width: r(rect.width), height: r(rect.height))
        }
        return Header(
            bar: r(bar.convert(bar.bounds, to: window)),
            switcherOrigin: r(switcher.convert(switcher.bounds, to: window)).origin,
            picture: r(picture.convert(picture.bounds, to: window)),
            items: found.map(r)
        )
    }

    /// What the title shows: the status's words, or nil for the name.
    private func shows(_ switcher: AccountSwitcherButton) -> String? {
        guard switcher.statusLaneView.alpha == 1, switcher.titleLaneView.alpha == 0 else { return nil }
        return switcher.statusLabel.string
    }

    /// No change on its way in the title: nothing animating, no words
    /// fading off a copy.
    private func idle(_ switcher: AccountSwitcherButton) -> Bool {
        let layers = [switcher.layer, switcher.titleLaneView.layer, switcher.statusLaneView.layer] + switcher.statusLaneView.subviews.map(\.layer)
        return layers.allSatisfy { ($0.animationKeys() ?? []).isEmpty } && switcher.statusLaneView.subviews.count == 2
    }

    /// The frame `ms` into a change: both lanes on their way, the status
    /// rising into its place, and nothing else in the header moved.
    private func midChange(
        _ name: String, _ window: UIWindow, _ navigation: UINavigationController, _ switcher: AccountSwitcherButton,
        items: [String], resting: Header, toStatus: Bool
    ) async throws -> [String] {
        var lines: [String] = []
        // From about when the change began (the caller saw it within a poll).
        let began = CACurrentMediaTime() - 0.01
        for target in [0.06, 0.13] {
            let wait = target - (CACurrentMediaTime() - began)
            // At least a frame, so the second reading is a new one.
            try await Task.sleep(for: .milliseconds(Int(max(wait, 0.017) * 1_000)))
            let elapsed = CACurrentMediaTime() - began
            let ms = Int((elapsed * 1_000).rounded())
            let title = switcher.titleLaneView.layer.presentation()
            let status = switcher.statusLaneView.layer.presentation()
            let titleOpacity = CGFloat(title?.opacity ?? -1)
            let statusOpacity = CGFloat(status?.opacity ?? -1)
            let rising = (status?.transform.m42 ?? 0) as CGFloat
            let lifting = (title?.transform.m42 ?? 0) as CGFloat
            // The bar's glass is round the switcher's container in the bar,
            // which the bar lays out in the same animation.
            let glass = try XCTUnwrap(switcher.superview, "the switcher isn't in the bar")
            let glassWidth = glass.layer.presentation()?.bounds.width ?? -1
            lines.append("\(name) +\(ms)ms: title opacity \(titleOpacity) dy \(lifting), status opacity \(statusOpacity) dy \(rising), glass width \(glassWidth) on its way to \(glass.bounds.width)")
            XCTAssertEqual(try header(navigation, switcher, items: items), resting, "\(name) +\(ms)ms: the header moved")
            // Only a frame well inside the 0.25 s says how far along it is.
            guard elapsed < 0.2 else { continue }
            XCTAssertGreaterThan(abs(glassWidth - glass.bounds.width), 1, "\(name) +\(ms)ms: the glass jumped to its new width")
            XCTAssertGreaterThan(titleOpacity, 0, "\(name) +\(ms)ms: the name is already gone")
            XCTAssertLessThan(titleOpacity, 1, "\(name) +\(ms)ms: the name hasn't started to fade")
            XCTAssertGreaterThan(statusOpacity, 0, "\(name) +\(ms)ms")
            XCTAssertLessThan(statusOpacity, 1, "\(name) +\(ms)ms")
            let coming = toStatus ? rising : lifting
            let going = toStatus ? lifting : rising
            XCTAssertGreaterThan(coming, 0, "\(name) +\(ms)ms: what comes rises from below")
            XCTAssertLessThan(coming, AccountSwitcherLayout.Metrics.slide)
            XCTAssertLessThan(going, 0, "\(name) +\(ms)ms: what goes lifts away")
            capture(window, "\(name)-mid-\(target == 0.06 ? 1 : 2)", settled: false)
        }
        return lines
    }

    // MARK: Agent home

    func testTheAgentHomeTitleThroughOfflineConnectingUpdatingAndLive() async throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in NoComputer() },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: ForeverConnecting()
        )
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"link-title","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        defer { Session.forget(connection.id) }
        NetworkPath.shared.force(true)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: connection.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        window.overrideUserInterfaceStyle = .light
        window.layoutIfNeeded()
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        let content = try XCTUnwrap(home.children.compactMap { $0 as? HomeViewController }.first)
        let sidebar = try XCTUnwrap(Self.views(home.view).compactMap { $0 as? SidebarList }.first)
        let rows = (0..<12).map { Row(id: "s:\($0)", nodeId: "n\($0)", kind: .space, label: "Work \($0)", mark: .happy, agentId: "a\($0)", spaceId: "s\($0)") }
        // What the paused engine says first has come and gone.
        try await Task.sleep(for: .milliseconds(300))
        var snapshot = HomeSnapshot()
        snapshot.loaded = true; snapshot.rows = rows; snapshot.allRows = rows
        snapshot.live = true; snapshot.syncing = false
        session.receive(status: .connected)
        session.receive(home: snapshot)
        content.applyConnection(snapshot)
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        try await until("live: the name") { home.headerState == .online && self.shows(switcher) == nil }
        try await Task.sleep(for: .milliseconds(700))
        let items = ["settings"]
        let resting = try header(navigation, switcher, items: items)
        let nameWidth = switcher.bounds.width
        try await captureBoth(window, "agent-1-live")
        var log = ["agent live: switcher \(switcher.frame), name \(switcher.nameLabel.frame)"]

        // Airplane mode: said at once.
        snapshot.live = false
        session.receive(status: .retrying)
        session.receive(home: snapshot)
        content.applyConnection(snapshot)
        NetworkPath.shared.force(false)
        try await until("waiting for network, at once", 0.2) { home.headerState == .waitingForNetwork }
        log += try await midChange("agent-2-waiting", window, navigation, switcher, items: items, resting: resting, toStatus: true)
        try await until("waiting for network, settled") { self.shows(switcher) == "Waiting for network…" && self.idle(switcher) }
        XCTAssertTrue(switcher.spinner.isTurning)
        XCTAssertGreaterThan(switcher.bounds.width, nameWidth, "the title grew for its words")
        XCTAssertNil(sidebar.notice, "the header says it; the list doesn't too")
        XCTAssertEqual(switcher.accessibilityValue, "Waiting for network…, Studio Mac")
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        log.append("agent waiting: switcher \(switcher.frame), spinner \(switcher.spinner.frame), words \(switcher.statusLabel.frame)")
        try await captureBoth(window, "agent-2-waiting")

        // The network is back: connecting, once the 0.6 s hold is over.
        NetworkPath.shared.force(true)
        try await until("still held", 0.2) { self.shows(switcher) == "Waiting for network…" }
        try await until("connecting", 2) { self.shows(switcher) == "Connecting…" && self.idle(switcher) }
        XCTAssertEqual(home.headerState, .connecting)
        XCTAssertTrue(switcher.spinner.isTurning)
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "agent-3-connecting")

        // The stream is open, catching up: updating.
        snapshot.live = true; snapshot.syncing = true
        session.receive(status: .connected)
        session.receive(home: snapshot)
        content.applyConnection(snapshot)
        try await until("updating", 2) { self.shows(switcher) == "Updating…" && self.idle(switcher) }
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "agent-4-updating")

        // Caught up: the name comes back.
        snapshot.syncing = false
        session.receive(home: snapshot)
        content.applyConnection(snapshot)
        try await until("held, then the name", 2) { home.headerState == .online }
        log += try await midChange("agent-5-live", window, navigation, switcher, items: items, resting: resting, toStatus: false)
        try await until("the name", 1) { self.shows(switcher) == nil && switcher.titleLaneView.alpha == 1 && self.idle(switcher) }
        XCTAssertEqual(switcher.bounds.width, nameWidth)
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await until("the spinner rests") { !switcher.spinner.isTurning }
        XCTAssertEqual(switcher.accessibilityValue, "Studio Mac")
        try await captureBoth(window, "agent-5-live")

        // A blip shorter than 0.8 s never shows.
        snapshot.live = false
        session.receive(status: .retrying)
        session.receive(home: snapshot)
        XCTAssertEqual(session.headerState, .connecting)
        let blip = ContinuousClock.now
        for _ in 0..<6 {
            try await Task.sleep(for: .milliseconds(100))
            // Only inside the 0.8 s: a slow machine's sleeps run long.
            guard ContinuousClock.now - blip < .milliseconds(700) else { break }
            XCTAssertEqual(home.headerState, .online, "a blip showed")
        }
        snapshot.live = true
        session.receive(status: .connected)
        session.receive(home: snapshot)
        for _ in 0..<8 {
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(home.headerState, .online, "a blip showed")
            XCTAssertNil(shows(switcher))
        }

        // The network is fine but the computer does not answer: never
        // offline. It is asked again, so the title says connecting, and the
        // list says nothing of it.
        snapshot.live = false
        snapshot.reconnecting = true
        session.receive(status: .retrying)
        session.receive(home: snapshot)
        content.applyConnection(snapshot)
        try await until("connecting", 2) { home.headerState == .connecting }
        try await until("the status", 2) { self.shows(switcher) == "Connecting…" }
        XCTAssertNil(sidebar.notice, "a notice said the computer is away")
        XCTAssertEqual(switcher.accessibilityValue, "Connecting…, Studio Mac")
        try await captureBoth(window, "agent-6-computer-did-not-answer-connecting")
        note("agent-frames", log)
        try await account.agentConnections.remove(connection.id)
    }

    /// Off Wi-Fi onto cellular: the session lets go of the stream's
    /// tunnel, which went out the old way, and opens it again at once
    /// (the engine's part: `SyncEngineTests.testAMoveOpensTheStreamAgainAtOnce`).
    func testAMoveOpensTheStreamAgain() async throws {
        let transport = MovingComputer()
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: ForeverConnecting()
        )
        await account.agentConnections.setForeground(false)
        let connection = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"link-move","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        defer { Session.forget(connection.id) }
        NetworkPath.shared.force(true)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: connection.id, context: context))
        await session.engine.start()
        try await Task.sleep(for: .milliseconds(100))

        NetworkPath.shared.forceMove()
        try await until("the stream's tunnel let go of") { transport.resets == [.realtime] }
        await session.engine.stop()
        try await account.agentConnections.remove(connection.id)
    }

    // MARK: Legacy home

    private func legacyAccount() async throws -> (AccountController, AccountSession) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(), connector: ForeverConnecting()
        )
        try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 7, count: 32)))
        let account = try XCTUnwrap(controller.session)
        let store = account.store
        try await Task.detached { try SeededAccount.seed(store) }.value
        return (controller, account)
    }

    func testTheLegacyHomeTitleThroughOfflineConnectingUpdatingAndLive() async throws {
        NetworkPath.shared.force(true)
        let (controller, account) = try await legacyAccount()
        let feed = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { feed.cancel() }
        try await until("seeded") { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        window.overrideUserInterfaceStyle = .light
        window.layoutIfNeeded()
        try await until("the list") { home.children.contains { $0 is SessionListViewController } }
        let link = LegacyLink.link(for: account)
        // The socket's own "connecting" has come.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(link.status, .connecting)
        link.receive(status: .connected)
        link.receive(catchingUp: false)
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        try await until("live: the name", 3) { home.headerState == .online && self.shows(switcher) == nil && switcher.titleLaneView.alpha == 1 }
        try await Task.sleep(for: .milliseconds(400))
        // Beside the sidebar (a tablet) home has no items at the right.
        let items = home.navigationItem.rightBarButtonItems?.isEmpty == false ? ["filter", "settings"] : []
        let resting = try header(navigation, switcher, items: items)
        let nameWidth = switcher.bounds.width
        try await captureBoth(window, "legacy-1-live")
        var log = ["legacy live: switcher \(switcher.frame)"]

        // Airplane mode: the path goes, and the socket with it.
        NetworkPath.shared.force(false)
        link.receive(status: .error)
        try await until("waiting for network, at once", 0.2) { home.headerState == .waitingForNetwork }
        log += try await midChange("legacy-2-waiting", window, navigation, switcher, items: items, resting: resting, toStatus: true)
        try await until("waiting for network, settled") { self.shows(switcher) == "Waiting for network…" && self.idle(switcher) }
        XCTAssertTrue(switcher.spinner.isTurning)
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "legacy-2-waiting")

        // Back: home reconnects the socket at once, which says connecting;
        // the title goes straight there, never by the name, and on to
        // updating the same way.
        NetworkPath.shared.force(true)
        for _ in 0..<10 {
            try await Task.sleep(for: .milliseconds(50))
            XCTAssertNotNil(shows(switcher), "the name showed between waiting and connecting")
        }
        try await until("connecting", 2) { self.shows(switcher) == "Connecting…" && self.idle(switcher) }
        XCTAssertEqual(link.status, .connecting, "the socket was asked again")
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "legacy-3-connecting")

        // The socket connects; its catch-up says it began a moment later.
        link.receive(status: .connected)
        try await Task.sleep(for: .milliseconds(60))
        link.receive(catchingUp: true)
        try await until("updating", 2) { self.shows(switcher) == "Updating…" && self.idle(switcher) }
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "legacy-4-updating")

        link.receive(catchingUp: false)
        try await until("held, then the name", 2) { home.headerState == .online }
        log += try await midChange("legacy-5-live", window, navigation, switcher, items: items, resting: resting, toStatus: false)
        try await until("the name", 1) { self.shows(switcher) == nil && switcher.titleLaneView.alpha == 1 && self.idle(switcher) }
        XCTAssertEqual(switcher.bounds.width, nameWidth)
        XCTAssertEqual(try header(navigation, switcher, items: items), resting)
        try await captureBoth(window, "legacy-5-live")
        note("legacy-frames", log)
        await controller.signOut()
    }

    /// A Happy account's chat says the same as its home, from the same
    /// link, with the spinner before it; live, its session's own status.
    func testALegacyChatSaysTheLinkWithTheSpinner() async throws {
        NetworkPath.shared.force(true)
        let (controller, account) = try await legacyAccount()
        let feed = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { feed.cancel() }
        try await until("seeded") { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let sessionId = try XCTUnwrap(account.homeFeed.latest?.sessions.first?.id)
        let chat = LegacyChatViewController(context: context, session: account, sessionId: sessionId)
        let navigation = UINavigationController(rootViewController: chat)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        window.overrideUserInterfaceStyle = .light
        let link = LegacyLink.link(for: account)
        try await Task.sleep(for: .milliseconds(300))
        link.receive(status: .connected)
        link.receive(catchingUp: false)
        try await until("its session's status", 3) { chat.headerStatusText != nil && !chat.headerStatusSpins }
        let live = chat.headerStatusText
        link.receive(status: .connecting)
        try await until("connecting…, with the spinner", 2) { chat.headerStatusText == "connecting…" && chat.headerStatusSpins }
        try await Task.sleep(for: .milliseconds(300))
        let spinner = try XCTUnwrap(Self.views(navigation.navigationBar).first { $0.accessibilityIdentifier == "chat-status-spinner" })
        XCTAssertEqual(spinner.alpha, 1)
        XCTAssertEqual(spinner.bounds.size, CGSize(width: ChatHeaderLayout.Metrics.spinner, height: ChatHeaderLayout.Metrics.spinner))
        try await captureBoth(window, "legacy-chat-connecting")
        link.receive(status: .connected)
        try await until("back to its session's status", 2) { chat.headerStatusText == live && !chat.headerStatusSpins }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(spinner.alpha, 0)
        try await captureBoth(window, "legacy-chat-live")
        await controller.signOut()
    }

    /// What VoiceOver hears as the title changes: the status as the title
    /// says it, "Online" once back.
    func testVoiceOverHearsTheTitlesWords() {
        XCTAssertEqual(AccountSwitcher.announcement(for: .waitingForNetwork), "Waiting for network…")
        XCTAssertEqual(AccountSwitcher.announcement(for: .connecting), "Connecting…")
        XCTAssertEqual(AccountSwitcher.announcement(for: .syncing), "Updating…")
        XCTAssertEqual(AccountSwitcher.announcement(for: .online), "Online")
        XCTAssertNil(Strings.HeaderStatus.title(.online))
    }

    /// An iPad's split view: home is the sidebar, and its switcher says the
    /// same, the sidebar and the bar holding still.
    func testTheTabletSidebarsTitleSaysTheLinkToo() async throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "an iPad's split view")
        NetworkPath.shared.force(true)
        let (controller, account) = try await legacyAccount()
        let feed = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { feed.cancel() }
        try await until("seeded") { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let shell = ShellViewController(context: context, phone: navigation, splits: true)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: shell)
        defer { window.isHidden = true }
        window.overrideUserInterfaceStyle = .light
        shell.view.layoutIfNeeded()
        try await until("in the sidebar") { shell.isExpanded && home.navigationController !== navigation && home.view.window != nil }
        let bar = try XCTUnwrap(home.navigationController)
        let link = LegacyLink.link(for: account)
        try await Task.sleep(for: .milliseconds(300))
        link.receive(status: .connected)
        link.receive(catchingUp: false)
        let switcher = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        try await until("live: the name", 3) { home.headerState == .online && self.idle(switcher) }
        try await Task.sleep(for: .milliseconds(500))
        let resting = try header(bar, switcher, items: [])
        let sidebar = try XCTUnwrap(home.view, "no sidebar")
        let sidebarFrame = sidebar.convert(sidebar.bounds, to: window)
        try await captureBoth(window, "tablet-1-live")
        let steps: [(String, () -> Void, String?)] = [
            ("tablet-2-waiting", { NetworkPath.shared.force(false); link.receive(status: .error) }, "Waiting for network…"),
            ("tablet-3-connecting", { NetworkPath.shared.force(true) }, "Connecting…"),
            ("tablet-4-updating", { link.receive(status: .connected); link.receive(catchingUp: true) }, "Updating…"),
            ("tablet-5-live", { link.receive(catchingUp: false) }, nil),
        ]
        for (name, change, words) in steps {
            change()
            try await until(name, 3) { self.shows(switcher) == words && (words != nil || switcher.titleLaneView.alpha == 1) && self.idle(switcher) }
            XCTAssertEqual(try header(bar, switcher, items: []), resting, "\(name): the bar moved")
            XCTAssertEqual(sidebar.convert(sidebar.bounds, to: window), sidebarFrame, "\(name): the sidebar moved")
            try await captureBoth(window, name)
        }
        await controller.signOut()
    }

    /// Not a check: a slow walk through the states for a screen recording
    /// (`xcrun simctl io … recordVideo`). Runs only with HAPPY_RECORD_LINK set.
    func testRecordingGoingOfflineAndBack() async throws {
        try XCTSkipIf(ProcessInfo.processInfo.environment["HAPPY_RECORD_LINK"] == nil, "only for the recording")
        NetworkPath.shared.force(true)
        let (controller, account) = try await legacyAccount()
        let feed = Task { for await _ in account.homeFeed.snapshots() {} }
        defer { feed.cancel() }
        try await until("seeded") { account.homeFeed.latest?.sessions.isEmpty == false }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = LegacyHomeViewController(context: context, session: account)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        let link = LegacyLink.link(for: account)
        try await Task.sleep(for: .milliseconds(300))
        link.receive(status: .connected)
        link.receive(catchingUp: false)
        try await Task.sleep(for: .seconds(2))
        NetworkPath.shared.force(false)
        link.receive(status: .error)
        try await Task.sleep(for: .seconds(2.5))
        NetworkPath.shared.force(true)
        try await Task.sleep(for: .seconds(2))
        link.receive(status: .connected)
        try await Task.sleep(for: .milliseconds(60))
        link.receive(catchingUp: true)
        try await Task.sleep(for: .seconds(1.8))
        link.receive(catchingUp: false)
        try await Task.sleep(for: .seconds(2.5))
        await controller.signOut()
    }
}
#endif
