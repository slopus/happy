// Exit tests run where a child process can: not in the iOS simulator.
#if os(macOS) || os(Linux) || os(Windows)
import Foundation
import Testing
import HappyWire
@testable import HappyCore

/// The computer's stream says how far a word goes (`blockIndex`, `offset`)
/// and how many subagents run as JSON numbers. One no `Int` holds is
/// dropped like any other malformed field: the app never traps on it.
/// Exit tests, so a trap fails the test instead of the run.
struct ConversationStreamNumbersTests {
    @Test func aDeltaWhoseBlockIndexNoIntHoldsIsDropped() async {
        await #expect(processExitsWith: .success) {
            try await StreamNumbersRig.survives(.object(["type": .string("message.delta"), "payload": .object([
                "agentId": .string("s"), "messageId": .string("m"), "runId": .string("r0"),
                "blockIndex": .number(1e300), "offset": .number(3), "append": .string("!")])]))
        }
    }

    @Test func aDeltaWhoseOffsetNoIntHoldsIsDropped() async {
        await #expect(processExitsWith: .success) {
            try await StreamNumbersRig.survives(.object(["type": .string("message.delta"), "payload": .object([
                "agentId": .string("s"), "messageId": .string("m"), "runId": .string("r0"),
                "blockIndex": .number(0), "offset": .number(-1e300), "append": .string("!")])]))
        }
    }

    @Test func aSubagentCountNoIntHoldsIsDropped() async {
        await #expect(processExitsWith: .success) {
            try await StreamNumbersRig.survives(.object(["type": .string("agent.updated"), "payload": .object([
                "agentId": .string("s"), "changes": .object(["subagents": .object(["running": .number(1e300)])])])]))
        }
    }
}

private enum StreamNumbersRig {
    /// `event` reaches an open conversation, then a good word does: the
    /// word showing proves the event before it was handled, and lived.
    static func survives(_ event: JSONValue) async throws {
        let server = StreamNumbersServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s")
        let latest = StreamNumbersLatest()
        let updates = conversation.updates
        let watching = Task {
            for await snapshot in updates where snapshot.loaded {
                await latest.set(snapshot.items.first { $0.role == .agent }?.text ?? "")
            }
        }
        defer { watching.cancel() }
        await conversation.start()
        await conversation.setVisible(true)
        guard try await latest.waits(for: "Hel") else { exit(2) }
        await engine.spaces.externalEvent(event)
        await engine.spaces.externalEvent(.object(["type": .string("message.delta"), "payload": .object([
            "agentId": .string("s"), "messageId": .string("m"), "runId": .string("r0"),
            "blockIndex": .number(0), "offset": .number(3), "append": .string("lo")])]))
        guard try await latest.waits(for: "Hello") else { exit(3) }
        await conversation.stop()
    }
}

private actor StreamNumbersLatest {
    private var text = ""
    func set(_ value: String) { text = value }
    func waits(for expected: String) async throws -> Bool {
        for _ in 0..<200 where text != expected { try await Task.sleep(for: .milliseconds(20)) }
        return text == expected
    }
}

/// One agent writing "Hel" in its one run.
private actor StreamNumbersServer: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            let user: JSONValue = .object(["id": .string("u"), "role": .string("user"), "createdAt": .number(0), "metadata": .object([:]),
                                           "content": .array([.object(["type": .string("text"), "text": .string("go")])])])
            let agent: JSONValue = .object(["id": .string("m"), "role": .string("agent"), "createdAt": .number(1), "status": .string("streaming"),
                                            "metadata": .object([:]), "content": .array([.object(["type": .string("text"), "text": .string("Hel")])])])
            value = .object(["hasMore": .bool(false), "runs": .array([.object([
                "id": .string("r0"), "status": .string("running"), "startedAt": .number(0), "messages": .array([user, agent]),
            ])])])
        } else if path.hasSuffix("/bootstrap") {
            value = .object(["agent": .object(["id": .string("s"), "workspaceId": .string("w"), "status": .string("working")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
#endif
