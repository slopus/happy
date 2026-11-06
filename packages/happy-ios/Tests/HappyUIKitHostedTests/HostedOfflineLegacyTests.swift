#if canImport(UIKit)
import Foundation
import HappyCore
import HappyCrypto
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A Happy account's server that airplane mode can take away: it acks
/// each message posted and each archive, in the order they come, and has
/// nothing else to say.
private final class AirplaneServer: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _online = false
    private var _posted: [String] = []
    private var _archived: [String] = []
    private var seq = 0

    var online: Bool {
        get { lock.withLock { _online } }
        set { lock.withLock { _online = newValue } }
    }
    /// The localIds posted, in order, every time.
    var posted: [String] { lock.withLock { _posted } }
    var archived: [String] { lock.withLock { _archived } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard online else { throw URLError(.notConnectedToInternet) }
        let path = request.url.path
        if request.method == "POST", path.hasSuffix("/messages"), let body = request.body {
            let messages = try JSONDecoder().decode(SendMessagesRequest.self, from: body).messages
            let acknowledged = lock.withLock { () -> [JSONValue] in
                messages.map { message in
                    _posted.append(message.localId)
                    seq += 1
                    return .object([
                        "id": .string("posted-\(seq)"), "seq": .number(Double(100 + seq)), "localId": .string(message.localId),
                        "createdAt": .number(Double(1_792_141_900_000 + seq)), "updatedAt": .number(Double(1_792_141_900_000 + seq)),
                    ])
                }
            }
            return HTTPResponse(status: 200, body: try JSONEncoder().encode(JSONValue.object(["messages": .array(acknowledged)])))
        }
        if request.method == "POST", path.hasPrefix("/v1/sessions/"), path.hasSuffix("/archive") {
            lock.withLock { _archived.append(path.split(separator: "/")[2].description) }
            return HTTPResponse(status: 200, body: Data(#"{"success":true}"#.utf8))
        }
        return HTTPResponse(status: 404, body: Data())
    }
}

/// The socket: none while the server is away; once it is back, Engine.IO's
/// open and Socket.IO's connect, then quiet until it is closed.
private struct AirplaneSockets: WebSocketConnector {
    let server: AirplaneServer

    func connect(to url: URL) async throws -> WebSocketConnection {
        guard server.online else { throw URLError(.notConnectedToInternet) }
        return QuietSocket()
    }
}

private final class QuietSocket: WebSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var frames = [#"0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":60000}"#, "40{}"]
    private var closed = false
    private var parked: CheckedContinuation<String, Error>?

    func send(_ text: String) async throws {}

    func receive() async throws -> String {
        if let next = lock.withLock({ frames.isEmpty ? nil : frames.removeFirst() }) { return next }
        return try await withCheckedThrowingContinuation { continuation in
            let closed = lock.withLock {
                if !self.closed { parked = continuation }
                return self.closed
            }
            if closed { continuation.resume(throwing: URLError(.networkConnectionLost)) }
        }
    }

    func close() async {
        let parked = lock.withLock {
            closed = true
            defer { self.parked = nil }
            return self.parked
        }
        parked?.resume(throwing: URLError(.networkConnectionLost))
    }
}

/// Airplane mode on a Happy account (docs/offline-first.md): home and a
/// chat open on what was kept, "waiting for network…" in the header; an
/// archive and two messages sent offline stand through a kill and
/// relaunch, then go once each, in order, when the network is back.
@MainActor
final class HostedOfflineLegacyTests: XCTestCase {
    private nonisolated static let chatId = "legacy-airplane"
    private let secret = Data(repeating: 7, count: 32)

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("shots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func capture(_ window: UIWindow, _ name: String) {
        guard let folder = Self.evidence else { return }
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try? image.pngData()?.write(to: folder.appendingPathComponent("\(name).png"))
    }

    private func until(_ what: String, _ seconds: Double = 10, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private func views(_ view: UIView) -> [UIView] { [view] + view.subviews.flatMap(views) }

    /// Whether a row the chat shows says `text`.
    private func shows(_ text: String, in chat: UIViewController) -> Bool {
        views(chat.view).contains { ($0 as? ChatPlanView)?.plan?.accessibilityLabel?.contains(text) == true }
    }

    private func launch(_ credentials: InMemoryCredentialStore, _ directory: URL, _ server: AirplaneServer) -> AccountController {
        AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: credentials, storeDirectory: directory,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: server, connector: AirplaneSockets(server: server)
        )
    }

    /// The chat messages go to: keyed by this account, so its sends seal,
    /// with a question and its answer already read.
    private func seed(_ store: LocalStore) async throws {
        let wrapped = Base64.encode(try AccountKeys(secret: secret).wrapDataKey(Data(repeating: 9, count: 32)))
        let base = SeededAccount.base + 600_000
        let record = SessionRecord(
            id: Self.chatId, seq: 2, createdAt: base, updatedAt: base, active: true, activeAt: Int64(Date().timeIntervalSince1970 * 1000), projectId: nil,
            metadataVersion: 1, metadataCipher: "harness",
            metadata: .object([
                "path": .string(SeededAccount.project), "host": .string("harness-mac"), "homeDir": .string(SeededAccount.home),
                "machineId": .string(SeededAccount.machineId), "flavor": .string("claude"),
                "summary": .object(["text": .string("Cache decision"), "updatedAt": .number(Double(base))]),
            ]),
            agentStateVersion: 1, agentStateCipher: nil, agentState: .object(["controlledByUser": .bool(false)]),
            dataKeyCipher: wrapped, decryptable: true
        )
        let messages = [
            MessageRecord(id: "a1", sessionId: Self.chatId, seq: 1, localId: nil, createdAt: base + 1000, updatedAt: base + 1000, contentCipher: "harness", content: .object([
                "role": .string("user"), "content": .object(["type": .string("text"), "text": .string("What did we decide for the cache?")]),
                "meta": .object(["sentFrom": .string("ios")]),
            ])),
            MessageRecord(id: "a2", sessionId: Self.chatId, seq: 2, localId: nil, createdAt: base + 2000, updatedAt: base + 2000, contentCipher: "harness", content: .object([
                "role": .string("session"),
                "content": .object([
                    "id": .string("a2-e"), "time": .number(Double(base + 2000)), "role": .string("agent"), "turn": .string("a-turn"),
                    "ev": .object(["t": .string("text"), "text": .string("SQLite, one local file.")]),
                ]),
            ])),
        ]
        try await Task.detached {
            try SeededAccount.seed(store)
            try store.upsertSessions([record])
            try store.applyMessagePage(sessionId: HostedOfflineLegacyTests.chatId, messages: messages, syncedThrough: 2)
        }.value
    }

    private func outbox(_ account: AccountSession) async throws -> [OutboxRecord] {
        let store = account.store
        return try await Task.detached { try store.pendingOutbox(limit: Int.max) }.value
    }

    private func session(_ account: AccountSession, _ id: String) async throws -> SessionRecord? {
        let store = account.store
        return try await Task.detached { try store.session(id: id) }.value
    }

    private func composer(_ chat: UIViewController) -> AgentInputCardView? {
        views(chat.view).compactMap { $0 as? AgentInputCardView }.first { $0.window != nil }
    }

    func testAirplaneModeKeepsHomeAChatAnArchiveAndTwoSendsThroughARelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-airplane-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        defer { NetworkPath.shared.force(nil) }
        NetworkPath.shared.force(false)
        let credentials = InMemoryCredentialStore()
        let server = AirplaneServer()

        // In airplane mode from the start: what was kept, and what is done.
        let first = launch(credentials, directory, server)
        try await first.signIn(Credentials(token: "t", secret: secret))
        let account = try XCTUnwrap(first.session)
        try await seed(account.store)
        try await account.actions.archive(sessionId: "seeded-tab-1")
        let archived = try await session(account, "seeded-tab-1")
        XCTAssertEqual(archived?.isArchived, true, "out of the list at once")
        do {
            let context = AppContext(account: first, variant: .development, version: "test")
            let chat = LegacyChatViewController(context: context, session: account, sessionId: Self.chatId)
            let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: chat))
            try await until("the chat, drawn") { chat.contentInstalled && self.composer(chat) != nil }
            try await until("its answer") { self.shows("SQLite, one local file.", in: chat) }
            let card = try XCTUnwrap(composer(chat))
            for text in ["First, offline", "Second, offline"] {
                card.setText(text, selection: NSRange(location: (text as NSString).length, length: 0))
                card.delegate?.agentInputCardDidPressPrimary(card)
                try await until("\(text), shown") { self.shows(text, in: chat) }
            }
            try await until("both kept") { (try? await self.outbox(account).count) == 2 }
            window.isHidden = true
        }
        let queued = try await outbox(account)
        XCTAssertEqual(queued.map { $0.payload["content"]?["text"]?.stringValue }, ["First, offline", "Second, offline"])
        XCTAssertTrue(server.posted.isEmpty)

        // Killed.
        await first.session?.stop()
        try account.store.close()

        // Opened again, still in airplane mode.
        let second = launch(credentials, directory, server)
        await second.restore()
        let relaunched = try XCTUnwrap(second.session)
        let context = AppContext(account: second, variant: .development, version: "test")
        let home = LegacyHomeViewController(context: context, session: relaunched)
        let navigation = UINavigationController(rootViewController: home)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        try await until("waiting for network…") { home.headerState == .waitingForNetwork }
        let stillArchived = try await session(relaunched, "seeded-tab-1")
        XCTAssertEqual(stillArchived?.archiving, true, "the launch reset brought the archived row back")
        let pending = await relaunched.sync.intents.pending()
        XCTAssertEqual(pending.map(\.kind), [.archive])
        try await Task.sleep(for: .milliseconds(800))
        capture(window, "offline-legacy-home")
        let waiting = try await outbox(relaunched)
        XCTAssertEqual(waiting.map(\.localId), queued.map(\.localId))

        let chat = LegacyChatViewController(context: context, session: relaunched, sessionId: Self.chatId)
        navigation.pushViewController(chat, animated: false)
        try await until("the chat from disk") { chat.contentInstalled && self.shows("SQLite, one local file.", in: chat) }
        try await until("the two waiting") { self.shows("First, offline", in: chat) && self.shows("Second, offline", in: chat) }
        func deliveryMarks() -> [ChatDeliveryMark] {
            ["First, offline", "Second, offline"].compactMap { text in
                guard let row = self.views(chat.view).compactMap({ $0 as? ChatPlanView }).first(where: {
                    !$0.isHidden && $0.window != nil && $0.plan?.accessibilityLabel?.contains(text) == true
                }) else { return nil }
                return self.views(row).compactMap { $0 as? ChatDeliveryView }.first {
                    $0.window != nil && !$0.isHidden && $0.mark?.message == row.plan?.id
                }?.mark
            }
        }
        try await until("each has a waiting clock", 6) {
            let marks = deliveryMarks()
            return marks.count == 2 && marks.allSatisfy { $0.state == .sending }
        }
        XCTAssertEqual(chat.headerStatusText, "waiting for network…")
        try await Task.sleep(for: .milliseconds(500))
        capture(window, "offline-legacy-chat")

        // The network is back: each goes once, in order.
        server.online = true
        NetworkPath.shared.force(true)
        try await until("both posted", 20) { server.posted.count >= 2 }
        try await until("the archive sent", 20) { server.archived.count >= 1 }
        try await until("nothing waits", 20) { (try? await self.outbox(relaunched).isEmpty) == true }
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(server.posted, queued.map(\.localId), "sent twice, or out of order")
        XCTAssertEqual(server.archived, ["seeded-tab-1"])
        let left = await relaunched.sync.intents.pending()
        XCTAssertEqual(left, [])
        XCTAssertNotEqual(chat.headerStatusText, "waiting for network…")
        try await until("sent, quiet") {
            let marks = deliveryMarks()
            return marks.count == 2 && marks.allSatisfy { $0.state == .received || $0.state == .accepted }
        }
        func top(_ text: String) -> CGFloat? {
            views(chat.view).first { ($0 as? ChatPlanView)?.plan?.accessibilityLabel?.contains(text) == true }.map { $0.convert($0.bounds, to: nil).minY }
        }
        XCTAssertLessThan(try XCTUnwrap(top("First, offline")), try XCTUnwrap(top("Second, offline")), "shown out of order once sent")
        capture(window, "online-legacy-chat")
        await second.signOut()
    }
}
#endif
