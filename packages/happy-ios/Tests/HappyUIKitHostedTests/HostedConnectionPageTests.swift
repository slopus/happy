#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A byte stream whose far side is one canned answer.
private final class Pipe: BrowserStream, @unchecked Sendable {
    private let lock = NSLock()
    private var answer: Data?
    init(_ answer: Data) { self.answer = answer }
    func read(maximumBytes: Int) async throws -> Data { lock.withLock { defer { answer = nil }; return answer ?? Data() } }
    func write(_ data: Data) async throws {}
    func close() async {}
}

/// A paired computer behind a stand-in for Tailcat: it says its tunnel is up
/// (relayed via Frankfurt, or direct) once metered, and each request goes
/// through a counted flow as `TailcatHTTPTransport`'s do. Home has one
/// task; the event stream says hello and stays open.
private final class TunnelComputer: SelfMeteringTransport, @unchecked Sendable {
    static let home = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],"bots":[],
     "tasks":[{"id":"ship","name":"Ship the cache","agent":{"id":"ship-agent","workspaceId":"one","status":"idle"}}],
     "taskMemberships":[{"taskId":"ship"}],"surfaces":[]}
    """#
    let path: TunnelPath
    private let lock = NSLock()
    private var metrics: ConnectionMetrics?
    private let tunnel = UUID()
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    init(path: TunnelPath) { self.path = path }

    func attach(_ metrics: ConnectionMetrics) {
        lock.withLock { self.metrics = metrics }
        let path = path
        metrics.tunnelUp(tunnel, info: TunnelInfo(regionID: 4, regionCode: "fra", regionName: "Frankfurt", relayHost: "derp4.example.test", nodeKey: "nodekey:6a1f02c9…", port: 4821)) { path }
    }

    private func flow(_ head: String, answer: Data) async throws {
        guard let metrics = lock.withLock({ metrics }) else { return }
        let flow = MeteredStream(Pipe(answer), metrics: metrics, channel: MetricsScope.channel ?? .tailcat)
        try await flow.write(Data(head.utf8))
        _ = try await flow.read(maximumBytes: 65536)
        await flow.close()
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let (status, body): (Int, Data) = switch path {
        case "/v0/bootstrap/desktop": (200, Data(Self.home.utf8))
        case "/v0/health": (200, Data(#"{"ready":true}"#.utf8))
        default: (404, Data("{}".utf8))
        }
        try await flow("\(method) \(path) HTTP/1.1\r\nHost: server.tailcat\r\n\r\n", answer: Data("HTTP/1.1 \(status) X\r\nContent-Length: \(body.count)\r\n\r\n".utf8) + body)
        return HTTP1Response(status: status, body: body)
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        lock.withLock { streams.append(continuation) }
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func close() async {
        let (metrics, streams) = lock.withLock { (self.metrics, self.streams) }
        streams.forEach { $0.finish() }
        metrics?.tunnelDown(tunnel)
    }
}

/// The Happy server: every route answers an empty object, and the socket
/// opens Engine.IO and accepts the namespace.
private struct EmptyServer: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { HTTPResponse(status: 200, body: Data("{}".utf8)) }
}

private final class AcceptingSocket: WebSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox = [#"0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":60000,"maxPayload":1000000}"#]
    private var waiting: CheckedContinuation<String, Error>?
    private var closed = false

    func send(_ text: String) async throws {
        // The namespace connect: the server accepts it.
        if text.hasPrefix("40") { deliver(#"40{"sid":"n"}"#) }
    }

    private func deliver(_ text: String) {
        let waiter: CheckedContinuation<String, Error>? = lock.withLock {
            if let waiting { self.waiting = nil; return waiting }
            inbox.append(text)
            return nil
        }
        waiter?.resume(returning: text)
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let ready: Result<String, Error>? = lock.withLock {
                if closed { return .failure(WebSocketError.closed) }
                if !inbox.isEmpty { return .success(inbox.removeFirst()) }
                waiting = continuation
                return nil
            }
            if let ready { continuation.resume(with: ready) }
        }
    }

    func close() async {
        let waiter: CheckedContinuation<String, Error>? = lock.withLock { closed = true; defer { waiting = nil }; return waiting }
        waiter?.resume(throwing: WebSocketError.closed)
    }
}

private struct AcceptingSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { AcceptingSocket() }
}

/// Settings › Data and Storage › Connection for each kind of account: it
/// says how the account connects and how that stands, a row a fact, and
/// its numbers move as traffic goes. Pictures, light and
/// dark, go to `.context/evidence/connection`.
@MainActor
final class HostedConnectionPageTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
        NetworkPath.shared.force(true)
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
        let folder = context.appendingPathComponent("evidence/connection")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String, page: ConnectionViewController) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(300))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let file = "\(name)-\(style == .dark ? "dark" : "light")"
            let attachment = XCTAttachment(image: image)
            attachment.name = file
            attachment.lifetime = .keepAlways
            add(attachment)
            if let folder = Self.evidence, let data = image.pngData() {
                try? data.write(to: folder.appendingPathComponent("\(file).png"))
            }
        }
        window.overrideUserInterfaceStyle = .light
        // Then the rest of the page: the chart, by channel, Tailcat, Copy.
        guard !name.hasSuffix("-bottom"), let scroll = page.view.subviews.compactMap({ $0 as? UIScrollView }).first else { return }
        scroll.setContentOffset(CGPoint(x: 0, y: max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
        try await capture(window, name + "-bottom", page: page)
        scroll.setContentOffset(CGPoint(x: 0, y: -scroll.adjustedContentInset.top), animated: false)
    }

    /// Every text row a single line, no taller than the one-line minimum.
    private func assertEveryRowIsOneLine(_ page: ConnectionViewController, file: StaticString = #filePath, line: UInt = #line) {
        page.view.layoutIfNeeded()
        for (card, layout) in zip(page.page?.cards ?? [], page.connectionLayout.cards) {
            for (row, frame) in zip(card.rows, layout.rows) where row.chart == nil {
                XCTAssertEqual(frame.box.height, ConnectionLayout.Metrics.rowMinimum, "\(row.id): \(row.value ?? "")", file: file, line: line)
            }
        }
    }

    /// Data and Storage with Connection on top, light and dark.
    private func captureStorage(_ window: UIWindow, _ name: String) async throws {
        guard let folder = Self.evidence else { return }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try? image.pngData()?.write(to: folder.appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png"))
        }
        window.overrideUserInterfaceStyle = .light
    }

    private func host(_ controller: UIViewController) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: controller)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    private func until(_ what: String, _ seconds: Double = 6, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return XCTFail("never: \(what)", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// Settings for `computer` (the active Happy account's when nil), Data
    /// and Storage, then its Connection row, as a finger would.
    private func openConnection(_ context: AppContext, computer: String?) async throws -> (ConnectionViewController, UINavigationController, UIWindow) {
        let settings = SettingsViewController(context: context, computer: computer)
        let (navigation, window) = try await host(settings)
        try await until("Data and Storage's row") { settings.shownRow("data-storage") != nil }
        XCTAssertNil(settings.shownRow("connection"), "Connection is Data and Storage's, not the account's")
        settings.tapRow("data-storage")
        try await until("Data and Storage") { navigation.topViewController is DataStorageViewController && navigation.transitionCoordinator == nil }
        let storage = try XCTUnwrap(navigation.topViewController as? DataStorageViewController)
        XCTAssertEqual(storage.shownRowIDs.first, ["connection"], "Connection is its own card at the top")
        XCTAssertEqual(storage.shownRow("connection")?.title, "Connection")
        try await captureStorage(window, computer == nil ? "data-storage-happy-cli" : "data-storage-agent")
        storage.tapRow("connection")
        try await until("the Connection page") { navigation.topViewController is ConnectionViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? ConnectionViewController)
        return (page, navigation, window)
    }

    private func agent(path: TunnelPath) async throws -> (AccountController, AppContext, Session) {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentConnectionCredentialStore: InMemoryAgentConnectionCredentialStore(),
            agentTransport: { _ in TunnelComputer(path: path) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: EmptyServer(), connector: AcceptingSockets()
        )
        await account.agentConnections.setForeground(false)
        let computer = try await account.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"connection-test","port":4821,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await account.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: account, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        await session.engine.start()
        try await until("the computer, live") { session.home.live }
        return (account, context, session)
    }

    func testAComputerRelayedThroughTailcat() async throws {
        let (_, context, session) = try await agent(path: .relayed)
        let (page, navigation, window) = try await openConnection(context, computer: session.accountID)
        try await until("its state") { page.page?.row("state")?.value == "Online" && page.refreshes > 0 }
        let shown = try XCTUnwrap(page.page)
        XCTAssertEqual(shown.cards.map(\.id), ["status", "window", "channel-\(ConnectionChannel.tailcat.rawValue)", "tailcat", "copy"])
        XCTAssertEqual(shown.cards[2].header, "Tailcat traffic")
        XCTAssertEqual(shown.row("type")?.value, "Tailcat")
        XCTAssertEqual(shown.row("path")?.value, "Relayed (DERP)")
        XCTAssertNil(shown.row("endpoint"), "a relayed tunnel has no peer address")
        XCTAssertEqual(shown.row("computer")?.value, "Studio Mac")
        XCTAssertEqual(shown.row("node")?.value, "nodekey:6a1f02c9…")
        XCTAssertEqual(shown.row("port")?.value, "4821")
        XCTAssertEqual(shown.row("relay")?.value, "Frankfurt")
        XCTAssertEqual(shown.row("relay-host")?.value, "derp4.example.test")
        XCTAssertEqual(shown.row("network")?.value?.isEmpty, false)
        XCTAssertNotEqual(shown.row("connected")?.value, Strings.Connection.notConnected)
        XCTAssertEqual(shown.row("streams-opened")?.title, "Event streams opened")
        XCTAssertEqual(shown.row("streams-opened")?.value, "1")
        XCTAssertEqual(shown.row("streams-closed")?.value, "0")
        XCTAssertEqual(shown.row("reconnects")?.value, "0")
        XCTAssertEqual(shown.row("failed")?.value, "0")
        XCTAssertEqual(shown.row("connections-opened")?.value, shown.row("connections-closed")?.value, "every flow so far was closed")
        XCTAssertEqual(shown.row("flows")?.value, "0 of 1,024", "every flow so far was closed")
        assertEveryRowIsOneLine(page)
        XCTAssertTrue(page.isTicking)

        // Traffic: five health checks. The page moves within a tick or two.
        let before = shown.row("requests")?.value
        for _ in 0..<5 { _ = try? await session.client.health() }
        let refreshes = page.refreshes
        try await until("the numbers move", 4) { page.page?.row("requests")?.value != before && page.refreshes > refreshes }
        XCTAssertEqual(page.connectionLayout.cards.count, 5)
        let requests = try XCTUnwrap(page.page?.row("requests")?.value)
        let counted = Int(requests.replacingOccurrences(of: ",", with: "")) ?? 0
        let earlier = Int(before?.replacingOccurrences(of: ",", with: "") ?? "") ?? 0
        XCTAssertGreaterThanOrEqual(counted, earlier + 5, "\(before ?? "") → \(requests)")
        XCTAssertNotEqual(page.page?.row("latency-p50")?.value, Strings.Connection.dash)
        XCTAssertNotEqual(page.page?.row("latency-p95")?.value, Strings.Connection.dash)
        XCTAssertEqual(page.page?.row("channel-\(ConnectionChannel.tailcat.rawValue)-requests")?.value, requests)
        XCTAssertEqual(page.page?.row("chart")?.chart?.count, 10)
        XCTAssertGreaterThan(page.page?.row("chart")?.chart?.last ?? 0, 0)

        try await capture(window, "connection-agent-relayed", page: page)

        // Copy Diagnostics: plain text, the computer's public key and never its token.
        UIPasteboard.general.string = ""
        page.tapRow("copy")
        let text = try XCTUnwrap(UIPasteboard.general.string)
        XCTAssertTrue(text.hasPrefix("Happy connection diagnostics"), text)
        XCTAssertTrue(text.contains("Path: Relayed (DERP)"), text)
        XCTAssertTrue(text.contains("Counters"))
        XCTAssertFalse(text.contains("token"), "the device token is in the diagnostics")
        XCTAssertFalse(text.contains("connection-test"), "the Tailcat address is in the diagnostics")
        XCTAssertEqual(page.page?.row("copy")?.value, Strings.Connection.copied)

        // Off screen, it reads nothing.
        navigation.popViewController(animated: false)
        try await until("stopped") { !page.isTicking }
        let stopped = page.refreshes
        try await Task.sleep(for: .milliseconds(1_500))
        XCTAssertEqual(page.refreshes, stopped, "the page kept reading while hidden")
        withExtendedLifetime(window) {}
    }

    func testAComputerReachedDirectly() async throws {
        let (_, context, session) = try await agent(path: .direct(endpoint: "192.0.2.10:41641"))
        let (page, _, window) = try await openConnection(context, computer: session.accountID)
        try await until("its path") { page.page?.row("path")?.value == "Direct (peer to peer)" }
        XCTAssertEqual(page.page?.row("type")?.value, "Tailcat")
        XCTAssertEqual(page.page?.row("endpoint")?.value, "192.0.2.10:41641")
        XCTAssertEqual(page.page?.row("state")?.value, "Online")
        assertEveryRowIsOneLine(page)
        try await capture(window, "connection-agent-direct", page: page)
        withExtendedLifetime(window) {}
    }

    func testAHappyCLIAccount() async throws {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in TunnelComputer(path: .relayed) },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: EmptyServer(), connector: AcceptingSockets()
        )
        try await account.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32)))
        await account.agentConnections.setForeground(false)
        let session = try XCTUnwrap(account.session)
        let context = AppContext(account: account, variant: .preview, version: "test")
        let (page, _, window) = try await openConnection(context, computer: nil)
        try await until("the socket, connected") { page.page?.row("streams-opened")?.value == "1" }
        let shown = try XCTUnwrap(page.page)
        XCTAssertFalse(shown.cards.map(\.id).contains("tailcat"), "a Happy CLI account has no Tailcat card")
        XCTAssertEqual(shown.cards.first?.id, "status")
        XCTAssertEqual(shown.cards.last?.id, "copy")
        XCTAssertEqual(shown.row("type")?.value, "Happy CLI server")
        XCTAssertEqual(shown.row("protocol")?.value, "HTTPS + Socket.IO")
        XCTAssertEqual(shown.row("server")?.value, ServerConfig.defaultServerURL.host)
        XCTAssertEqual(shown.row("realtime")?.value, "/v1/updates")
        XCTAssertEqual(shown.row("engine")?.value, "4")
        XCTAssertEqual(shown.row("streams-opened")?.title, "WebSockets opened")
        XCTAssertEqual(shown.row("streams-closed")?.value, "0")
        XCTAssertNil(shown.row("connections-closed"), "URLSession's closes are never seen")
        try await until("its state") { [Strings.HeaderStatus.text(.online), Strings.HeaderStatus.text(.syncing)].map { $0.prefix(1).uppercased() + $0.dropFirst() }.contains(page.page?.row("state")?.value ?? "") }
        XCTAssertNotEqual(page.page?.row("connected")?.value, Strings.Connection.notConnected)
        XCTAssertNil(shown.row("node"))

        // Traffic over the server's API moves the counts.
        let before = page.page?.row("requests")?.value
        for index in 0..<3 { try? await session.api.registerPushToken("test-token-\(index)") }
        let refreshes = page.refreshes
        try await until("the numbers move", 4) { page.page?.row("requests")?.value != before && page.refreshes > refreshes }
        XCTAssertNotNil(page.page?.row("channel-\(ConnectionChannel.http.rawValue)-requests"))
        XCTAssertNotNil(page.page?.row("channel-\(ConnectionChannel.socket.rawValue)-sent"))
        XCTAssertNil(page.page?.row("channel-\(ConnectionChannel.socket.rawValue)-requests"), "Socket.IO's frames are not requests")
        assertEveryRowIsOneLine(page)
        try await capture(window, "connection-happy-cli", page: page)
        withExtendedLifetime((window, account)) {}
    }

    /// Search finds Connection, and opens Data and Storage with it shown.
    func testSearchFindsConnectionUnderDataAndStorage() async throws {
        XCTAssertTrue(SettingsIndex.computer.contains(SettingsIndex.connection))
        XCTAssertTrue(SettingsIndex.happyAccount.contains(SettingsIndex.connection))
        let (_, context, session) = try await agent(path: .relayed)
        let settings = SettingsViewController(context: context, computer: session.accountID)
        let (navigation, _) = try await host(settings)
        try await until("the page") { settings.shownRow("data-storage") != nil }
        XCTAssertNil(settings.shownRow("connection"), "Connection is Data and Storage's, not the account's")
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        settings.willPresentSearchController(search)
        search.searchBar.text = "connec"
        settings.updateSearchResults(for: search)
        XCTAssertTrue(settings.shownRowIDs.joined().contains("connection"), "\(settings.shownRowIDs)")
        settings.tapRow("connection")
        try await until("Data and Storage") { navigation.topViewController is DataStorageViewController && navigation.transitionCoordinator == nil }
        let storage = try XCTUnwrap(navigation.topViewController as? DataStorageViewController)
        XCTAssertEqual(storage.shownRowIDs.first, ["connection"])
        storage.tapRow("connection")
        try await until("the Connection page") { navigation.topViewController is ConnectionViewController }
    }
}
#endif
