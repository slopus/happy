import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// An existing agent's chat shows the agent's own mode, as the computer
/// says it runs, and follows it; a draft's mode, which every device writes
/// picked or not, never pins an old one.
final class AgentModeTests: XCTestCase {
    static func mode(_ effort: String) -> AgentWire.Mode {
        AgentWire.Mode(providerId: "openai", modelId: "openai/gpt-6.1-terra", effort: effort, serviceTier: nil, permissionMode: "auto")
    }

    func testTheAgentsOwnModeStandsOverAStaleDraftsMode() async throws {
        let server = ModeServer(agent: Self.mode("medium"), draft: (text: "hi", mode: Self.mode("low")))
        let (conversation, updates) = try await open(server)
        let opened = await updates.next { $0.loaded && $0.mode != nil && $0.draft == "hi" }
        XCTAssertEqual(opened?.mode?.effort, "medium", "the draft's mode stood over the agent's")
        await conversation.stop()
    }

    func testARunStartedElsewhereShowsTheModeItRunsWith() async throws {
        let server = ModeServer(agent: Self.mode("low"))
        let (conversation, updates) = try await open(server)
        _ = await updates.next { $0.loaded && $0.mode?.effort == "low" }
        await server.set(Self.mode("high"))
        await conversation.engine.spaces.externalEvent(Self.runStarted("r1"))
        let followed = await updates.next { $0.mode?.effort == "high" }
        XCTAssertNotNil(followed, "the composer kept the old mode")
        await conversation.stop()
    }

    func testAPickHereStandsOverTheAgentsMode() async throws {
        let server = ModeServer(agent: Self.mode("medium"))
        let (conversation, updates) = try await open(server)
        _ = await updates.next { $0.loaded && $0.mode?.effort == "medium" }
        await conversation.chat.setMode(Self.mode("xhigh"))
        _ = await updates.next { $0.mode?.effort == "xhigh" }
        await server.set(Self.mode("low"))
        await conversation.engine.spaces.externalEvent(Self.runStarted("r2"))
        _ = await updates.next { $0.working }
        try await Task.sleep(for: .milliseconds(300))
        // Anything drawn after the read shows what the composer holds.
        await conversation.engine.spaces.externalEvent(.object(["type": .string("agent.updated"), "payload": .object([
            "agentId": .string("a"), "changes": .object(["status": .string("idle")]),
        ])]))
        let after = await updates.next { !$0.working }
        XCTAssertEqual(after?.mode?.effort, "xhigh", "the agent's mode replaced the person's pick")
        await conversation.stop()
    }

    // MARK: Helpers

    static func runStarted(_ id: String) -> JSONValue {
        .object(["type": .string("run.started"), "payload": .object([
            "agentId": .string("a"), "run": .object(["id": .string(id), "status": .string("running"), "startedAt": .number(1)]),
        ])])
    }

    struct Opened {
        let chat: Conversation
        let engine: SyncEngine
        func stop() async { await chat.stop() }
    }

    private func open(_ server: ModeServer) async throws -> (Opened, Updates) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = Updates(conversation.updates)
        await conversation.start()
        return (Opened(chat: conversation, engine: engine), updates)
    }
}

/// A computer with one idle agent, `a`, running with `agent`'s mode, and a
/// draft written with another.
actor ModeServer: AgentTransport {
    private var agent: AgentWire.Mode
    private let draft: (text: String, mode: AgentWire.Mode)?

    init(agent: AgentWire.Mode, draft: (text: String, mode: AgentWire.Mode)? = nil) {
        self.agent = agent
        self.draft = draft
    }

    func set(_ mode: AgentWire.Mode) { agent = mode }

    private static func json<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([])])
        } else if path.hasSuffix("/bootstrap") {
            var start: [String: JSONValue] = [
                "agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]),
                "pending": .array([]),
                "mode": try Self.json(agent),
            ]
            if let draft {
                start["draft"] = .object(["updatedAt": .number(5), "value": try Self.json(AgentWire.DraftValue(text: draft.text, mode: draft.mode))])
            }
            value = .object(start)
        } else if path.hasSuffix("/mode") {
            value = .object(["mode": try Self.json(agent)])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
