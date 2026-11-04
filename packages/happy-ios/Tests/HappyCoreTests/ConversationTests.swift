import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// `message.delta` applied exactly as happy-agent's API asks.
final class ConversationTests: XCTestCase {
    private func message(_ text: String) -> AgentWire.Message {
        AgentWire.Message(id: "m", role: "agent", createdAt: 0, content: [.reasoning("…"), .text(text)])
    }

    private func text(_ message: AgentWire.Message?) -> String? {
        guard let message, case .text(let text) = message.content[1] else { return nil }
        return text
    }

    func testAnAppendAtTheEndGrowsTheBlock() {
        XCTAssertEqual(text(Conversation.grow(message("Hel"), block: 1, offset: 3, append: "lo")), "Hello")
    }

    func testAReplayChangesNothing() {
        XCTAssertEqual(text(Conversation.grow(message("Hello"), block: 1, offset: 3, append: "lo")), "Hello")
    }

    func testAPartlyAppliedAppendAddsOnlyWhatIsMissing() {
        XCTAssertEqual(text(Conversation.grow(message("Hell"), block: 1, offset: 3, append: "lo!")), "Hello!")
    }

    func testOffsetsCountUTF16() {
        // "👋" is two UTF-16 units.
        XCTAssertEqual(text(Conversation.grow(message("👋"), block: 1, offset: 2, append: " hi")), "👋 hi")
    }

    func testAGapOrAConflictAsksForHistory() {
        XCTAssertNil(Conversation.grow(message("He"), block: 1, offset: 3, append: "lo"))
        XCTAssertNil(Conversation.grow(message("Help"), block: 1, offset: 3, append: "lo"))
        XCTAssertNil(Conversation.grow(message("Hel"), block: 2, offset: 0, append: "x"))
    }

    func testAnotherAgentsMessageIsACollaboratorsButNeverItsOwnOrItsParents() throws {
        let json = #"{"id":"m","role":"agent","createdAt":1,"content":[{"type":"text","text":"Collaborator c1 finished working."}],"metadata":{"senderAgentId":"c1","senderAgentExplanation":"Finished: final answer"}}"#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.metadata, AgentWire.MessageMetadata(senderAgentId: "c1", senderAgentExplanation: "Finished: final answer"))
        let sender = Conversation.collaborator(message, agentId: "me", parentAgentId: "boss")
        XCTAssertEqual(sender?.agentId, "c1")
        XCTAssertEqual(sender?.explanation, "Finished: final answer")
        // Driving itself, or the agent that manages it: dialogue, not a row.
        XCTAssertNil(Conversation.collaborator(message, agentId: "c1", parentAgentId: nil))
        XCTAssertNil(Conversation.collaborator(message, agentId: "me", parentAgentId: "c1"))
        // Typed by the person: no sender at all.
        XCTAssertNil(Conversation.collaborator(self.message("hi"), agentId: "me", parentAgentId: nil))
    }

    func testTheDaemonsAddressingLineIsTrimmed() {
        XCTAssertEqual(Conversation.inboundText("Message from agent c1:\n\nDone.", agentId: "c1"), "Done.")
        XCTAssertEqual(Conversation.inboundText("Message from agent c2: Done.", agentId: "c1"), "Message from agent c2: Done.")
    }

    /// The phone keeps a conversation's newest page of runs, as desktop keeps
    /// one nobody reads; what is pending stays whatever run it is in.
    func testThePhoneKeepsTheNewestRuns() {
        let runs = (0..<150).map { (id: "r\($0)", messageIds: ["u\($0)", "a\($0)"]) }
        var messages = Dictionary(uniqueKeysWithValues: runs.flatMap(\.messageIds).map { ($0, AgentWire.Message(id: $0, role: "user", createdAt: 0, content: [.text($0)])) })
        messages["p"] = AgentWire.Message(id: "p", role: "user", createdAt: 0, content: [.text("p")])
        let kept = Conversation.kept(runs: runs, messages: messages, pending: ["p", "u3"])
        XCTAssertTrue(kept.trimmed)
        XCTAssertEqual(kept.runs.map(\.id), (50..<150).map { "r\($0)" })
        XCTAssertEqual(Set(kept.messages.keys), Set((50..<150).flatMap { ["u\($0)", "a\($0)"] } + ["p", "u3"]))
        // A short one is kept whole.
        let short = Conversation.kept(runs: Array(runs.prefix(100)), messages: messages, pending: [])
        XCTAssertFalse(short.trimmed)
        XCTAssertEqual(short.runs.count, 100)
        XCTAssertEqual(short.messages.count, messages.count)
    }

    /// desktop's `trimHistory`: left, a long conversation keeps its newest
    /// runs in memory too, and can page the rest in again.
    func testALeftConversationKeepsTheNewestRuns() async throws {
        let client = AgentClient(transport: LongHistoryServer(runs: 150), token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let engine = SyncEngine(client: client, directory: root)
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "long")
        var updates = conversation.updates.makeAsyncIterator()
        func asked(_ users: Int) async -> ChatSnapshot? {
            while let snapshot = await updates.next() {
                if snapshot.loaded, snapshot.items.filter({ $0.role == .user }).count == users { return snapshot }
            }
            return nil
        }
        await conversation.start()
        await conversation.setVisible(true)
        let open = await asked(150)
        XCTAssertEqual(open?.hasMore, false)
        await conversation.setVisible(false)
        let left = await asked(100)
        XCTAssertEqual(left?.hasMore, true)
        XCTAssertEqual(left?.items.first { $0.role == .user }?.text, "asked 50")
        await conversation.stop()
    }

    /// desktop's `trimHistory` on a watched session: past twice the window,
    /// a run's end trims an open conversation to its newest runs, but only
    /// while its reader follows the newest message.
    func testAnOpenConversationPastTwiceTheWindowKeepsTheNewestRunsWhileFollowed() async throws {
        let client = AgentClient(transport: LongHistoryServer(runs: 250), token: "t")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let engine = SyncEngine(client: client, directory: root)
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "long")
        var updates = conversation.updates.makeAsyncIterator()
        func asked(_ users: Int) async -> ChatSnapshot? {
            while let snapshot = await updates.next() {
                if snapshot.loaded, snapshot.items.filter({ $0.role == .user }).count == users { return snapshot }
            }
            return nil
        }
        let finished: JSONValue = .object(["type": .string("run.finished"), "payload": .object(["agentId": .string("long"), "runId": .string("r249")])])
        await conversation.start()
        await conversation.setVisible(true)
        let open = await asked(250)
        XCTAssertEqual(open?.hasMore, false)
        // Read up in history: nothing goes.
        await conversation.setReadsNewest(false)
        await engine.spaces.externalEvent(finished)
        await engine.spaces.externalEvent(.object(["type": .string("message.created"), "payload": .object(["agentId": .string("long"), "runId": .string("r249"),
            "message": .object(["id": .string("again"), "role": .string("user"), "createdAt": .number(250), "metadata": .object([:]),
                                "content": .array([.object(["type": .string("text"), "text": .string("asked again")])])])])]))
        // Seen after the run's end: every run is still there.
        let unfollowed = await asked(251)
        XCTAssertEqual(unfollowed?.hasMore, false)
        // At the newest message: the next run's end trims it.
        await conversation.setReadsNewest(true)
        await engine.spaces.externalEvent(finished)
        let followed = await asked(101)
        XCTAssertEqual(followed?.hasMore, true)
        XCTAssertEqual(followed?.items.first { $0.role == .user }?.text, "asked 150")
        await conversation.stop()
    }

    /// The meter's measurement: the bootstrap's, then each
    /// `agent.context.updated` as a turn streams, replacing it whole; null
    /// clears it, and another agent's is not this one's.
    func testTheContextMeasurementFollowsItsEvents() async throws {
        func measured(_ tokens: Double) -> JSONValue {
            .object(["approximate": .bool(false), "contextTokens": .number(tokens), "contextWindow": .number(200_000),
                     "modelId": .string("anthropic/sonnet-5"), "providerId": .string("claude")])
        }
        let client = AgentClient(transport: LongHistoryServer(runs: 1, context: measured(84_000)), token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "long")
        var updates = conversation.updates.makeAsyncIterator()
        func context(_ check: (AgentWire.ContextUsage?) -> Bool) async -> AgentWire.ContextUsage?? {
            while let snapshot = await updates.next() {
                if snapshot.loaded, check(snapshot.context) { return .some(snapshot.context) }
            }
            return nil
        }
        await conversation.start()
        let opened = await context { $0 != nil }
        XCTAssertEqual(opened??.contextTokens, 84_000)
        func updated(_ agentId: String, _ value: JSONValue) -> JSONValue {
            .object(["type": .string("agent.context.updated"), "payload": .object(["agentId": .string(agentId), "context": value])])
        }
        await engine.spaces.externalEvent(updated("other", measured(1)))
        await engine.spaces.externalEvent(updated("long", measured(120_000)))
        let streamed = await context { $0?.contextTokens != 84_000 }
        XCTAssertEqual(streamed??.contextTokens, 120_000, "another agent's measurement is not this one's")
        await engine.spaces.externalEvent(updated("long", .null))
        let cleared = await context { $0 == nil }
        XCTAssertNotNil(cleared)
        await conversation.stop()
    }

    func testAMessageWithoutAPictureBytesStillDecodes() throws {
        let json = #"{"id":"m","role":"user","createdAt":1,"content":[{"type":"text","text":"hi"},{"type":"image","mimeType":"image/png"}],"metadata":{}}"#
        let decoded = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.content, [.text("hi"), .unknown("image")])
    }
}

/// Soft breaks as remark reads them on desktop.
final class MarkdownTests: XCTestCase {
    private func join(_ text: String) -> String { Markdown.joiningSoftBreaks(text) }

    func testASoftBreakIsASpace() {
        XCTAssertEqual(join("Spiky-dreamed,\nit envies thorns,\nbut syrup drips."), "Spiky-dreamed, it envies thorns, but syrup drips.")
    }

    func testABlankLineStartsAParagraph() {
        XCTAssertEqual(join("One\ntwo\n\nThree"), "One two\n\nThree")
    }

    func testBlocksKeepTheirLines() {
        let text = "Intro\n- a\n- b\n1. c\n# Head\nAfter\n> quote\n| a | b |\n| - | - |\n---"
        XCTAssertEqual(join(text), text)
    }

    func testCodeIsLeftAlone() {
        let text = "Run\n```sh\nline one\nline two\n```\nthen\nthis"
        XCTAssertEqual(join(text), "Run\n```sh\nline one\nline two\n```\nthen this")
    }

    func testAHardBreakKeepsItsLine() {
        XCTAssertEqual(join("End  \nNext\\\nLast"), "End  \nNext\\\nLast")
    }

    func testAListItemRunsOnLazily() {
        XCTAssertEqual(join("- first\n  more\n- second"), "- first more\n- second")
    }
}

/// A daemon with one conversation of `runs` runs, all on its first page.
private actor LongHistoryServer: AgentTransport {
    let runs: Int
    /// The bootstrap's context measurement, when it has one.
    let context: JSONValue?
    init(runs: Int, context: JSONValue? = nil) { self.runs = runs; self.context = context }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array((0..<runs).map { index in
                .object(["id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(Double(index)), "messages": .array([
                    .object(["id": .string("u\(index)"), "role": .string("user"), "createdAt": .number(Double(index)), "metadata": .object([:]),
                             "content": .array([.object(["type": .string("text"), "text": .string("asked \(index)")])])]),
                ])])
            })])
        } else if path.hasSuffix("/bootstrap") {
            value = .object(["agent": .object(["id": .string("long"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([]), "context": context ?? .null])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
