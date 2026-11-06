import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A conversation makes again only the rows something moved in: these hold
/// it to drawing exactly what a fresh read of the same conversation draws,
/// whatever came in between, and to leaving every other row as it was.
final class ConversationIncrementalTests: XCTestCase {
    /// Hundreds of events of every kind, words in three scripts among them;
    /// at each checkpoint the rows are the ones a conversation opened fresh
    /// on the same history draws.
    func testRowsMadeAsEventsComeAreTheRowsOfAFreshRead() async throws {
        for seed in [1, 7, 42] as [UInt64] {
            try await drive(seed: seed, steps: 300)
        }
    }

    /// A word lands in one row: every other row is still the same making,
    /// told in one step, and the word is in its row.
    func testAWordMakesAgainOnlyItsRow() async throws {
        let server = TruthServer()
        await server.seed(runs: 30)
        let (engine, conversation, latest) = try await open(server)
        let before = try await settled(latest) { !$0.items.isEmpty }
        let event = await server.word(" more")
        await engine.spaces.externalEvent(event)
        let after = try await settled(latest) { $0.items.last { $0.role == .agent }?.text.hasSuffix("more") == true }
        // The words after the newest message's call: the row the word lands in.
        let changed = after.items.last { $0.role == .agent }?.id
        XCTAssertEqual(before.items.count, after.items.count)
        XCTAssertGreaterThan(after.items.count, 60)
        for (old, new) in zip(before.items, after.items) where new.id != changed {
            XCTAssertNotEqual(new.revision, 0, "\(new.id) was not stamped")
            XCTAssertEqual(old.revision, new.revision, "\(new.id) was made again for a word in another row")
        }
        await conversation.stop()
    }

    // MARK: Driving

    private func drive(seed: UInt64, steps: Int) async throws {
        var random = Random(seed: seed)
        let server = TruthServer()
        await server.seed(runs: 6)
        let (engine, conversation, latest) = try await open(server)
        _ = try await settled(latest) { !$0.items.isEmpty }
        let words = [" word", " слово", " 👋", " and", " 日本", "\n\n- item", " `code`", "\n```swift\nlet x = 1\n```\n"]
        for step in 0..<steps {
            let running = await server.running
            var events: [JSONValue] = []
            if !running {
                events = await server.startRun()
            } else {
                switch random.next(100) {
                case 0..<60: events = [await server.word(words[random.next(words.count)])]
                case 60..<72: events = [await server.call()]
                case 72..<78: events = [await server.agentMessage()]
                case 78..<84: events = await server.finishRun()
                case 84..<88: events = await server.deleteOlder(random.next(1000)).map { [$0] } ?? []
                default: events = [await server.word(words[random.next(words.count)])]
                }
            }
            for event in events { await engine.spaces.externalEvent(event) }
            if step % 75 == 74 || step == steps - 1 {
                try await expectFresh(server, engine: engine, latest: latest, seed: seed, step: step)
            }
        }
        await conversation.stop()
    }

    private func expectFresh(_ server: TruthServer, engine: SyncEngine, latest: Latest, seed: UInt64, step: Int) async throws {
        let client = AgentClient(transport: server, token: "t")
        let fresh = Conversation(client: client, store: engine.spaces, agentId: "s")
        var updates = fresh.updates.makeAsyncIterator()
        await fresh.start()
        var read: ChatSnapshot?
        while let snapshot = await updates.next() { if snapshot.loaded { read = snapshot; break } }
        await fresh.stop()
        let expected = try XCTUnwrap(read).items
        XCTAssertGreaterThan(expected.count, 10)
        var tries = 0
        var shown = await latest.snapshot?.items ?? []
        while shown != expected, tries < 200 {
            tries += 1
            try await Task.sleep(for: .milliseconds(10))
            shown = await latest.snapshot?.items ?? []
        }
        XCTAssertEqual(shown.count, expected.count, "seed \(seed) step \(step): row count")
        for (index, (made, read)) in zip(shown, expected).enumerated() where made != read {
            XCTFail("seed \(seed) step \(step): row \(index) \(made.id) differs from a fresh read's \(read.id)")
            break
        }
    }

    private func open(_ server: TruthServer) async throws -> (SyncEngine, Conversation, Latest) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s")
        let latest = Latest()
        let updates = conversation.updates
        Task { for await snapshot in updates where snapshot.loaded { await latest.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        return (engine, conversation, latest)
    }

    private func settled(_ latest: Latest, until done: @escaping (ChatSnapshot) -> Bool) async throws -> ChatSnapshot {
        for _ in 0..<300 {
            if let snapshot = await latest.snapshot, done(snapshot) { return snapshot }
            try await Task.sleep(for: .milliseconds(10))
        }
        return try XCTUnwrap(nil as ChatSnapshot?, "never settled")
    }
}

private actor Latest {
    var snapshot: ChatSnapshot?
    func set(_ snapshot: ChatSnapshot) { self.snapshot = snapshot }
}

/// Deterministic, so a failure names the seed that makes it again.
private struct Random {
    var state: UInt64
    init(seed: UInt64) { state = seed &* 0x9E37_79B9_7F4A_7C15 | 1 }
    mutating func next(_ bound: Int) -> Int {
        state ^= state << 13; state ^= state >> 7; state ^= state << 17
        return Int(state % UInt64(bound))
    }
}

/// The computer's side: the conversation as it truly is, read whole, and
/// each change to it as the event it sends.
private actor TruthServer: AgentTransport {
    struct Run {
        var id: String
        var startedAt: Double
        var endedAt: Double?
        var messages: [AgentWire.Message]
    }

    var runs: [Run] = []
    var clock: Double = 0
    var counter = 0

    var running: Bool { runs.last.map { $0.endedAt == nil } ?? false }

    func seed(runs count: Int) {
        for index in 0..<count {
            var run = Run(id: "r\(index)", startedAt: tick(), messages: [user("asked \(index)")])
            run.messages.append(agent([.text("Answer \(index) with **bold**."), toolBlock(), .text("And after.")], status: nil))
            run.endedAt = index == count - 1 ? nil : tick()
            runs.append(run)
        }
    }

    // MARK: Changes, as events

    func startRun() -> [JSONValue] {
        let asked = user("next \(counter)")
        let run = Run(id: "run\(next())", startedAt: tick(), messages: [asked])
        runs.append(run)
        let reply = agent([.text("")], status: "streaming")
        runs[runs.count - 1].messages.append(reply)
        return [
            event("message.created", ["message": encode(asked)]),
            event("run.started", ["run": .object(["id": .string(run.id), "startedAt": .number(run.startedAt)]), "acceptedMessageIds": .array([.string(asked.id)])]),
            event("message.created", ["runId": .string(run.id), "message": encode(reply)]),
        ]
    }

    /// A word appended to the newest message's last block.
    func word(_ word: String) -> JSONValue {
        let run = runs.count - 1
        guard let index = runs[run].messages.lastIndex(where: { $0.role == "agent" }) else { return event("noop", [:]) }
        var message = runs[run].messages[index]
        guard case .text(let text) = message.content.last else { return event("noop", [:]) }
        message.content[message.content.count - 1] = .text(text + word)
        runs[run].messages[index] = message
        return event("message.delta", ["messageId": .string(message.id), "runId": .string(runs[run].id), "blockIndex": .number(Double(message.content.count - 1)),
                                       "offset": .number(Double(text.utf16.count)), "append": .string(word)])
    }

    /// The newest message calls a tool, and goes on writing after it.
    func call() -> JSONValue {
        let run = runs.count - 1
        guard let index = runs[run].messages.lastIndex(where: { $0.role == "agent" }) else { return event("noop", [:]) }
        var message = runs[run].messages[index]
        message.content.append(toolBlock())
        message.content.append(.text(""))
        runs[run].messages[index] = message
        return event("message.updated", ["runId": .string(runs[run].id), "message": encode(message)])
    }

    func agentMessage() -> JSONValue {
        let message = agent([.text("A new message")], status: "streaming")
        runs[runs.count - 1].messages.append(message)
        return event("message.created", ["runId": .string(runs[runs.count - 1].id), "message": encode(message)])
    }

    func finishRun() -> [JSONValue] {
        let run = runs.count - 1
        var events: [JSONValue] = []
        for (index, message) in runs[run].messages.enumerated() where message.status == "streaming" {
            var done = message
            done.status = nil
            runs[run].messages[index] = done
            events.append(event("message.updated", ["runId": .string(runs[run].id), "message": encode(done)]))
        }
        runs[run].endedAt = tick()
        events.append(event("run.finished", ["run": .object(["id": .string(runs[run].id), "startedAt": .number(runs[run].startedAt),
                                                               "endedAt": .number(runs[run].endedAt ?? 0), "reason": .string("completed")])]))
        return events
    }

    /// An older agent message taken back.
    func deleteOlder(_ pick: Int) -> JSONValue? {
        let older = runs.indices.dropLast().flatMap { run in runs[run].messages.indices.filter { runs[run].messages[$0].role == "agent" }.map { (run, $0) } }
        guard !older.isEmpty else { return nil }
        let (run, index) = older[pick % older.count]
        let id = runs[run].messages.remove(at: index).id
        return event("message.deleted", ["messageId": .string(id)])
    }

    // MARK: Reads

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(runs.map { run in
                var object: [String: JSONValue] = ["id": .string(run.id), "status": .string(run.endedAt == nil ? "running" : "completed"),
                                                   "startedAt": .number(run.startedAt), "messages": .array(run.messages.map(encode))]
                if let ended = run.endedAt { object["endedAt"] = .number(ended); object["reason"] = .string("completed") }
                return .object(object)
            })])
        } else if path.hasSuffix("/bootstrap") {
            value = .object(["agent": .object(["id": .string("s"), "workspaceId": .string("w"), "status": .string(running ? "working" : "idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}

    // MARK: Making

    private func next() -> Int { counter += 1; return counter }
    private func tick() -> Double { clock += 1000; return clock }

    private func user(_ text: String) -> AgentWire.Message {
        AgentWire.Message(id: "u\(next())", role: "user", createdAt: tick(), content: [.text(text)], metadata: .init())
    }

    private func agent(_ content: [AgentWire.Block], status: String?) -> AgentWire.Message {
        AgentWire.Message(id: "a\(next())", role: "agent", createdAt: tick(), content: content, status: status, metadata: .init())
    }

    private func toolBlock() -> AgentWire.Block {
        .toolCall(id: "c\(next())", name: "shell", status: "completed", presentation: nil, arguments: .object(["command": .string("ls \(counter)")]))
    }

    private func encode(_ message: AgentWire.Message) -> JSONValue {
        (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(message))) ?? .null
    }

    private func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        var payload = payload
        payload["agentId"] = .string("s")
        return .object(["type": .string(type), "payload": .object(payload)])
    }
}
