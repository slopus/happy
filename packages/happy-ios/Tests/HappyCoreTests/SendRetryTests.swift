import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer with one conversation, "s", that refuses messages while its
/// provider isn't ready (as a daemon does when the model's provider still
/// needs signing in), and takes them once it is.
private actor ProviderComputer: AgentTransport {
    var ready = false
    /// A refused message the daemon keeps anyway, so the same ID again is
    /// a duplicate.
    var keepsRefused = false
    var held: Set<String> = []
    var accepted: [String] = []
    var refused: [String] = []
    var streams: [AsyncThrowingStream<Data, Error>.Continuation] = []

    /// Models whose provider stays switched off: refused, ready or not.
    var offModels: Set<String> = []
    func setReady(_ ready: Bool) { self.ready = ready }
    func switchOff(_ model: String) { offModels.insert(model) }
    func keepRefused() { keepsRefused = true }
    func sends() -> (accepted: [String], refused: [String]) { (accepted, refused) }
    var targets: [String] = []
    func sendTargets() -> [String] { targets }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            value = .object(["cursor": .string("c1"), "profile": .object(["userId": .string("me")]), "userSettings": .array([]),
                             "projects": .array([.object(["id": .string("p"), "name": .string("App"), "status": .string("active"), "orderKey": .string("a"),
                                                          "agents": .array([.object(["id": .string("s"), "workspaceId": .string("p"), "title": .string("Chat"), "status": .string("idle"), "version": .string("v0001")])])])]),
                             "workspaces": .array([])])
        } else if method == "POST", path == "/v0/tasks" {
            let made = try? JSONDecoder().decode(JSONValue.self, from: body ?? Data())
            value = .object([
                "task": .object(["id": made?["id"] ?? .null, "name": .string("New Task"), "agent": .object(["id": made?["agentId"] ?? .null, "workspaceId": made?["workspaceId"] ?? .null])]),
                "membership": .object(["taskId": made?["id"] ?? .null]),
            ])
        } else if path.hasPrefix("/v0/agents/"), path.contains("/messages") {
            value = .object(["cursor": .string("c1"), "hasMore": .bool(false), "runs": .array([])])
        } else if path.hasPrefix("/v0/agents/"), path.hasSuffix("/bootstrap") {
            let id = path.split(separator: "/")[2]
            value = .object(["agent": .object(["id": .string(String(id)), "workspaceId": .string("p"), "status": .string("idle")]), "pending": .array([]), "cursor": .string("c1")])
        } else if method == "POST", path.hasSuffix("/send") {
            let sent = try? JSONDecoder().decode(JSONValue.self, from: body ?? Data())
            let id = sent?["id"]?.stringValue ?? ""
            targets.append(String(path.split(separator: "/")[2]))
            if let model = sent?["mode"]?["modelId"]?.stringValue, offModels.contains(model) {
                refused.append(id)
                return .init(status: 409, body: Data(#"{"code":"provider_off","error":"The Current CLI account is switched off."}"#.utf8))
            }
            if held.contains(id) {
                return .init(status: 409, body: Data(#"{"code":"duplicate","error":"This message was already sent."}"#.utf8))
            }
            guard ready else {
                refused.append(id)
                if keepsRefused { held.insert(id) }
                return .init(status: 409, body: Data(#"{"code":"provider_not_ready","error":"Sign in to Codex on the computer first."}"#.utf8))
            }
            accepted.append(id)
            return .init(status: 200, body: Data("{}".utf8))
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":false,\"gap\":false,\"daemonId\":\"d1\"}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() { streams.forEach { $0.finish() }; streams.removeAll() }
}

/// "Not sent. Tap to retry." on a direct connection: a message the computer
/// refused shows failed and holds the ones after it; its retry sends it
/// again through the outbox, shows it sending meanwhile, and lets the
/// held ones go after it.
final class SendRetryTests: XCTestCase {
    private let mode = AgentWire.Mode(providerId: "codex", modelId: "gpt-6.1-sol", effort: "medium", serviceTier: nil, permissionMode: "default")

    private final class Shown: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ChatSnapshot()
        private var history: [String: [ChatItem.Delivery?]] = [:]
        func set(_ snapshot: ChatSnapshot) {
            lock.withLock {
                value = snapshot
                for item in snapshot.items where item.id.hasPrefix("m") {
                    if history[item.id]?.last != item.delivery { history[item.id, default: []].append(item.delivery) }
                }
            }
        }
        func delivery(_ id: String) -> ChatItem.Delivery? { lock.withLock { value.items.first { $0.id == id }?.delivery } }
        func failed(_ id: String) -> Bool { if case .failed = delivery(id) { true } else { false } }
        func states(_ id: String) -> [ChatItem.Delivery?] { lock.withLock { history[id] ?? [] } }
    }

    private func eventually(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<250 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("not in time: \(what)", file: file, line: line)
    }

    private func open(_ server: ProviderComputer, newTask: Bool = false, agentId: String = "s", in folder: URL? = nil) async throws -> (Conversation, Shown, SyncEngine) {
        let directory = folder ?? FileManager.default.temporaryDirectory.appendingPathComponent("send-retry-\(UUID().uuidString)")
        if folder == nil { addTeardownBlock { try? FileManager.default.removeItem(at: directory) } }
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: directory)
        await engine.start()
        try await eventually("delivery allowed") { await engine.deliveryAllowed }
        let task = newTask ? await engine.spaces.newTask() : nil
        let conversation = Conversation(client: client, store: engine.spaces, agentId: task?.agentId ?? agentId, newTask: task, mode: mode, persistence: engine)
        let shown = Shown()
        let updates = conversation.updates
        Task { for await snapshot in updates { shown.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        return (conversation, shown, engine)
    }

    func testARetryResendsTheRefusedMessageAndThenTheOnesItHeld() async throws {
        let server = ProviderComputer()
        let (conversation, shown, engine) = try await open(server)

        _ = await conversation.send(id: "m1", text: "reply with OK")
        try await eventually("m1 refused") { shown.failed("m1") }
        _ = await conversation.send(id: "m2", text: "reply with OK again")
        try await eventually("m2 drawn") { shown.delivery("m2") != nil }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(shown.delivery("m2"), .sending, "held behind the refused one, still to go")
        var sends = await server.sends()
        XCTAssertEqual(sends.accepted, [])

        // The provider is signed in on the computer; the person taps retry.
        await server.setReady(true)
        await conversation.retry("m1")
        try await eventually("m1 and m2 sent") { await server.sends().accepted == ["m1", "m2"] }
        try await eventually("m1 shown sent") { shown.delivery("m1") == .pending }
        try await eventually("m2 shown sent") { shown.delivery("m2") == .pending }
        // Failed, then sending again, then sent: never failed again.
        XCTAssertEqual(Array(shown.states("m1").suffix(2)), [.sending, .pending])
        sends = await server.sends()
        XCTAssertEqual(sends.refused, ["m1"])
        let queued = try await engine.queuedMessages(for: "s")
        XCTAssertEqual(queued.map(\.id), [])
        await conversation.stop()
        await engine.stop()
    }

    /// The first message of a new task: the task is made, the message
    /// refused; the next waits behind it, and the retry sends both.
    func testInANewTaskARetryResendsTheRefusedFirstMessage() async throws {
        let server = ProviderComputer()
        let (conversation, shown, engine) = try await open(server, newTask: true)

        _ = await conversation.send(id: "m1", text: "reply with OK")
        try await eventually("m1 refused") { shown.failed("m1") }
        _ = await conversation.send(id: "m2", text: "reply with OK again")
        try await eventually("m2 drawn") { shown.delivery("m2") != nil }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(shown.delivery("m2"), .sending)

        await server.setReady(true)
        await conversation.retry("m1")
        try await eventually("m1 and m2 sent") { await server.sends().accepted == ["m1", "m2"] }
        try await eventually("m1 shown sent") { shown.delivery("m1") == .pending }
        try await eventually("m2 shown sent") { shown.delivery("m2") == .pending }
        await conversation.stop()
        await engine.stop()
    }

    /// Refused in a new task, the app quit and opened again: the retry
    /// still sends it, and the one held behind it.
    func testARetryAfterARelaunchSendsTheRefusedMessage() async throws {
        let server = ProviderComputer()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("send-retry-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let (first, firstShown, firstEngine) = try await open(server, newTask: true, in: folder)
        _ = await first.send(id: "m1", text: "reply with OK")
        try await eventually("m1 refused") { firstShown.failed("m1") }
        _ = await first.send(id: "m2", text: "reply with OK again")
        try await eventually("m2 drawn") { firstShown.delivery("m2") != nil }
        let targets = await server.sendTargets()
        let agentId = try XCTUnwrap(targets.first)
        await first.stop()
        await firstEngine.stop()

        await server.setReady(true)
        let (conversation, shown, engine) = try await open(server, agentId: agentId, in: folder)
        try await eventually("m1 still failed") { shown.failed("m1") }
        XCTAssertEqual(shown.delivery("m2"), .sending)
        await conversation.retry("m1")
        try await eventually("m1 and m2 sent") { await server.sends().accepted == ["m1", "m2"] }
        try await eventually("m1 shown sent") { shown.delivery("m1") == .pending }
        try await eventually("m2 shown sent") { shown.delivery("m2") == .pending }
        await conversation.stop()
        await engine.stop()
    }

    /// Sent on a model whose provider is switched off, then the person
    /// picks another: the retry goes with the model the composer shows
    /// now, not the refused one, and the message held behind it follows.
    /// Retried as it was, it was refused again at once, so the tap seemed
    /// to do nothing, and the next message waited behind it for good.
    func testARetryGoesWithTheModelPickedSince() async throws {
        let server = ProviderComputer()
        await server.setReady(true)
        await server.switchOff(mode.modelId)
        let (conversation, shown, engine) = try await open(server)

        _ = await conversation.send(id: "m1", text: "reply with OK")
        try await eventually("m1 refused") { shown.failed("m1") }
        let terra = AgentWire.Mode(providerId: "codex", modelId: "gpt-6.1-terra", effort: "max", serviceTier: nil, permissionMode: "default")
        await conversation.setMode(terra)
        _ = await conversation.send(id: "m2", text: "reply with OK again")
        try await eventually("m2 drawn") { shown.delivery("m2") != nil }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(shown.delivery("m2"), .sending)

        await conversation.retry("m1")
        try await eventually("m1 and m2 sent") { await server.sends().accepted == ["m1", "m2"] }
        try await eventually("m1 shown sent") { shown.delivery("m1") == .pending }
        try await eventually("m2 shown sent") { shown.delivery("m2") == .pending }
        let sends = await server.sends()
        XCTAssertEqual(sends.refused, ["m1"], "the retry went with the refused model")
        await conversation.stop()
        await engine.stop()
    }

    /// Retried while the computer still refuses it: the tap shows it going,
    /// then failed again, and the next tap tries once more.
    func testARetryStillRefusedFailsAgainAndCanBeRetried() async throws {
        let server = ProviderComputer()
        let (conversation, shown, engine) = try await open(server)

        _ = await conversation.send(id: "m1", text: "reply with OK")
        try await eventually("m1 refused") { shown.failed("m1") }
        await conversation.retry("m1")
        try await eventually("refused twice") { await server.sends().refused == ["m1", "m1"] }
        try await eventually("failed again") { shown.failed("m1") }
        XCTAssertTrue(shown.states("m1").contains(.sending), "the tap showed nothing")

        await server.setReady(true)
        await conversation.retry("m1")
        try await eventually("sent") { await server.sends().accepted == ["m1"] }
        try await eventually("shown sent") { shown.delivery("m1") == .pending }
        await conversation.stop()
        await engine.stop()
    }
}
