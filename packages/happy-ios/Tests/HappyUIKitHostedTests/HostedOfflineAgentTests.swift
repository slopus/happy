#if canImport(UIKit)
import Foundation
import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineRelay: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct OfflineSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A paired computer that airplane mode can take away: two tasks, "Ship
/// the cache" with something unread and "Old notes", and the one chat,
/// Old notes', a phone may have read before it went.
private actor AirplaneComputer: AgentTransport {
    static let home = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],"bots":[],
     "tasks":[{"id":"ship","name":"Ship the cache","agent":{"id":"ship-agent","workspaceId":"one","status":"idle","unread":{"reason":"finished"}}},
       {"id":"old","name":"Old notes","agent":{"id":"old-agent","workspaceId":"two","status":"idle"}}],
     "taskMemberships":[{"taskId":"ship"},{"taskId":"old"}],"surfaces":[]}
    """#
    static let run: JSONValue = .object([
        "id": .string("r1"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000), "reason": .string("completed"),
        "messages": .array([
            .object(["id": .string("u1"), "role": .string("user"), "createdAt": .number(1), "metadata": .object([:]),
                     "content": .array([.object(["type": .string("text"), "text": .string("What did we decide?")])])]),
            .object(["id": .string("m1"), "role": .string("agent"), "createdAt": .number(2), "metadata": .object([:]),
                     "content": .array([.object(["type": .string("text"), "text": .string("SQLite, one local file.")])])]),
        ]),
    ])

    private var value = try! JSONDecoder().decode(JSONValue.self, from: Data(home.utf8))
    var online = true
    enum Act: Equatable, Sendable {
        case read(String)
        case archive(String)
    }
    /// What the computer heard the phone do.
    private(set) var acts: [Act] = []
    private var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func set(online: Bool) {
        self.online = online
        if !online { streams.forEach { $0.finish(throwing: URLError(.notConnectedToInternet)) }; streams.removeAll() }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        let value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            return .init(status: 200, body: try JSONEncoder().encode(self.value))
        } else if method == "POST", path.hasSuffix("/read") {
            let agentId = String(path.split(separator: "/")[2])
            acts.append(.read(agentId))
            edit { $0["agent"]?["id"]?.stringValue == agentId ? Self.read($0) : $0 }
            value = .object([:])
        } else if method == "POST", path.hasSuffix("/archive") {
            let taskId = String(path.split(separator: "/")[2])
            acts.append(.archive(taskId))
            edit { $0["id"]?.stringValue == taskId ? nil : $0 }
            value = .object([:])
        } else if path.contains("/agents/old-agent/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([Self.run])])
        } else if path.hasSuffix("/agents/old-agent/bootstrap") {
            value = .object(["agent": .object(["id": .string("old-agent"), "workspaceId": .string("two"), "status": .string("idle")]), "pending": .array([])])
        } else if path.hasPrefix("/v0/tasks/") {
            value = .object(["task": .object(["version": .string("v1")])])
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    /// Each task as the computer holds it next; nil drops it.
    private func edit(_ change: (JSONValue) -> JSONValue?) {
        guard var object = value.objectValue else { return }
        object["tasks"] = .array(object["tasks"]?.arrayValue?.compactMap(change) ?? [])
        value = .object(object)
    }

    private static func read(_ task: JSONValue) -> JSONValue {
        guard var whole = task.objectValue, var agent = whole["agent"]?.objectValue else { return task }
        agent["unread"] = nil
        whole["agent"] = .object(agent)
        return .object(whole)
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() {}
}

/// Airplane mode on a paired computer (docs/offline-first.md): the app
/// opens on what it kept, "waiting for network…" in the header; what the
/// person did offline stands through a kill and relaunch, and reaches the
/// computer once the network is back.
@MainActor
final class HostedOfflineAgentTests: XCTestCase {
    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("shots")
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

    private func until(_ what: String, _ seconds: Double = 6, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private static func subviews<T: UIView>(_ type: T.Type, in view: UIView) -> [T] {
        view.subviews.flatMap { ($0 as? T).map { [$0] } ?? [] + subviews(type, in: $0) }
    }

    /// One launch of the app: its own controller over the same keychain,
    /// so the same pairing and the same files on disk.
    private func launch(_ credentials: InMemoryAgentConnectionCredentialStore, _ directory: URL, _ computer: AirplaneComputer) async -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: directory,
            agentConnectionCredentialStore: credentials,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: OfflineRelay(), connector: OfflineSockets()
        )
        await controller.agentConnections.setForeground(false)
        return controller
    }

    func testTheHomeAndAReadChatOpenWithNoNetworkAndWhatWasDoneOfflineLandsLater() async throws {
        let credentials = InMemoryAgentConnectionCredentialStore()
        let computer = AirplaneComputer()
        defer { NetworkPath.shared.force(nil) }
        NetworkPath.shared.force(true)

        // Online: home is read, and Old notes' chat with it.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("airplane-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = await launch(credentials, directory, computer)
        let pairing = try await first.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"airplane-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in Session.forget(pairing.id) }
        let firstContext = AppContext(account: first, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: firstContext))
        let engine = session.engine
        await engine.start()
        try await until("the home, live") { session.home.live && session.home.rows.contains { $0.label == "Ship the cache" } }
        XCTAssertEqual(session.home.rows.first { $0.label == "Ship the cache" }?.unread, true)
        do {
            let chat = ChatViewController(session: session, agentId: "old-agent", title: "Old notes", spaceId: nil, intro: nil)
            let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: chat))
            try await until("Old notes' answer") { chat.plans.contains { $0.accessibilityLabel?.contains("SQLite, one local file.") == true } }
            try await until("Old notes' chat, kept") { (try? await engine.cachedResource("conversation:old-agent")) != nil }
            window.isHidden = true
        }
        let heardOnline = await computer.acts

        // Airplane mode. Ship the cache is read and Old notes archived, here
        // at once; the computer hears neither.
        NetworkPath.shared.force(false)
        await computer.set(online: false)
        await engine.markRead("ship-agent")
        _ = await engine.archive(kind: "task", id: "old")
        try await until("the read and the archive, on this phone") {
            session.home.rows.first { $0.label == "Ship the cache" }?.unread == false && !session.home.rows.contains { $0.label == "Old notes" }
        }
        // Killed.
        session.stop()
        await engine.stop()

        // Opened again, still in airplane mode.
        let second = await launch(credentials, directory, computer)
        try await second.agentConnections.restore()
        let context = AppContext(account: second, variant: .preview, version: "test")
        let opened = Date()
        let home = AgentHomeViewController(context: context, id: pairing.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: navigation)
        defer { window.isHidden = true }
        let relaunched = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        XCTAssertFalse(relaunched.engine === engine)
        await relaunched.engine.start()
        let sidebar = try XCTUnwrap(Self.subviews(SidebarList.self, in: home.view).first)
        try await until("the kept home") { sidebar.rows.contains { $0.label == "Ship the cache" } }
        XCTAssertLessThan(Date().timeIntervalSince(opened), 2, "home waited on the network")
        XCTAssertEqual(sidebar.rows.first { $0.label == "Ship the cache" }?.unread, false, "the dot came back")
        XCTAssertFalse(sidebar.rows.contains { $0.label == "Old notes" }, "the archived task came back")
        try await until("waiting for network…") { home.headerState == .waitingForNetwork }
        XCTAssertEqual(Strings.HeaderStatus.text(home.headerState), "waiting for network…")
        XCTAssertNil(sidebar.notice, "the list says what the header already does")
        await sidebar.settle()
        try await Task.sleep(for: .milliseconds(600))
        capture(window, "offline-agent-home")
        let pending = await relaunched.engine.intents.pending()
        XCTAssertEqual(pending.map(\.kind), [.read, .archive])
        let heardOffline = await computer.acts
        XCTAssertEqual(heardOffline, heardOnline)

        // The chat read before opens from disk.
        let chat = ChatViewController(session: relaunched, agentId: "old-agent", title: "Old notes", spaceId: nil, intro: nil)
        navigation.pushViewController(chat, animated: false)
        try await until("Old notes' answer, from disk") { chat.plans.contains { $0.accessibilityLabel?.contains("SQLite, one local file.") == true } }
        window.layoutIfNeeded()
        capture(window, "offline-agent-chat")
        navigation.popViewController(animated: false)

        // The network is back: the header says so and what waited goes, once.
        await computer.set(online: true)
        NetworkPath.shared.force(true)
        try await until("the read and the archive, sent", 10) {
            let heard = Array(await computer.acts.dropFirst(heardOnline.count))
            return heard.contains(.read("ship-agent")) && heard.contains(.archive("old"))
        }
        try await until("nothing waits") { await relaunched.engine.intents.pending().isEmpty }
        let heard = Array(await computer.acts.dropFirst(heardOnline.count))
        XCTAssertEqual(heard.filter { $0 == .read("ship-agent") }.count, 1)
        XCTAssertEqual(heard.filter { $0 == .archive("old") }.count, 1)
        // A refused intent also leaves the queue; only success enters delivered.
        let delivered = await relaunched.engine.intents.delivered
        for intent in pending {
            XCTAssertTrue(delivered.contains { $0.id == intent.id }, "\(intent.kind) was removed without successful delivery")
        }
        try await until("live again") { relaunched.home.live }
        XCTAssertEqual(sidebar.rows.first { $0.label == "Ship the cache" }?.unread, false, "the computer's stale unread came back")
        capture(window, "online-agent-home")
        await relaunched.engine.stop()
    }
}
#endif
