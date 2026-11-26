import Foundation
import Testing
import HappyWire
@testable import HappyCore

/// Messages are checked one by one against happy-agent-client's protocol
/// schema (`MessageSchema`). One that fails is a placeholder where it
/// stands; the page, the event stream and the messages beside it go on.
struct MessageSchemaTests {
    struct Fixture {
        var name: String
        var message: JSONValue
        var problem: String?
    }

    static let fixtures: (valid: [Fixture], invalid: [Fixture]) = {
        let url = Bundle.module.url(forResource: "messages", withExtension: "json", subdirectory: "Fixtures/AgentMessages")!
        let root = try! JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        func read(_ key: String) -> [Fixture] {
            (root[key]?.arrayValue ?? []).map { Fixture(name: $0["name"]?.stringValue ?? "", message: $0["message"] ?? .null, problem: $0["problem"]?.stringValue) }
        }
        return (read("valid"), read("invalid"))
    }()

    /// The fixtures every client checks (desktop's `fixtures/protocol-messages`):
    /// `{ description, invalidAt?, message }`, `invalidAt` JSON pointers.
    static let shared: (valid: [Fixture], invalid: [(fixture: Fixture, at: [String])]) = {
        func read(_ folder: String) -> [(fixture: Fixture, at: [String])] {
            let urls = Bundle.module.urls(forResourcesWithExtension: "json", subdirectory: "Fixtures/ProtocolMessages/\(folder)") ?? []
            return urls.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { url in
                let file = try! JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
                let at = file["invalidAt"]?.arrayValue?.compactMap(\.stringValue) ?? []
                return (Fixture(name: url.lastPathComponent, message: file["message"] ?? .null, problem: nil), at)
            }
        }
        return (read("valid").map(\.fixture), read("invalid"))
    }()

    static func decode(_ value: JSONValue) throws -> AgentWire.Message {
        try JSONDecoder().decode(AgentWire.Message.self, from: JSONEncoder().encode(value))
    }

    /// The cluster's `request_user_input` cancelled by a chat reply.
    static var cancelledCard: JSONValue { fixtures.invalid.first { $0.message["id"]?.stringValue == "bad1" }!.message }

    @Test func fixturesAreThere() {
        #expect(Self.fixtures.valid.count >= 8)
        #expect(Self.fixtures.invalid.count >= 19)
        #expect(Self.shared.valid.count >= 25)
        #expect(Self.shared.invalid.count >= 8)
    }

    @Test func validMessagesDecode() throws {
        for fixture in Self.fixtures.valid {
            let message = try Self.decode(fixture.message)
            #expect(message.unreadable == nil, "\(fixture.name): \(message.unreadable ?? "")")
            #expect(message.id == fixture.message["id"]?.stringValue, "\(fixture.name)")
        }
    }

    @Test func validMessagesKeepWhatTheySay() throws {
        let call = try Self.decode(Self.fixtures.valid[2].message)
        #expect(call.content.count == 3)
        guard case .toolCall(let id, _, let status, let presentation, _, _, _, let review) = call.content[2] else { Issue.record("no call"); return }
        #expect(id == "c1")
        #expect(status == "completed")
        #expect(presentation?.command == "pnpm test")
        #expect(review?.elevated == true)
        let answered = try Self.decode(Self.fixtures.valid[3].message)
        guard case .toolCall(_, let name, _, let shown, _, let output, _, _) = answered.content[0] else { Issue.record("no question"); return }
        #expect(name == "request_user_input")
        #expect(shown?.type == "user_input")
        #expect(output == nil)
        let newer = try Self.decode(Self.fixtures.valid[6].message)
        guard case .toolCall(_, "plan", "completed", nil, _, _, _, _) = newer.content[0] else { Issue.record("not a plain call: \(newer.content)"); return }
        #expect(newer.content[1] == .unknown("ui"))
    }

    @Test func invalidMessagesArePlaceholders() throws {
        for fixture in Self.fixtures.invalid {
            let message = try Self.decode(fixture.message)
            #expect(message.unreadable == fixture.problem, "\(fixture.name)")
            #expect(message.content.isEmpty, "\(fixture.name)")
            #expect(message.metadata == nil && message.error == nil && message.failure == nil, "\(fixture.name)")
            if let id = fixture.message["id"]?.stringValue { #expect(message.id == id, "\(fixture.name)") }
        }
    }

    @Test func sharedValidMessagesDecode() throws {
        for fixture in Self.shared.valid {
            let message = try Self.decode(fixture.message)
            #expect(message.unreadable == nil, "\(fixture.name): \(message.unreadable ?? "")")
        }
    }

    /// Each fails at or under every pointer the fixture names.
    @Test func sharedInvalidMessagesArePlaceholders() throws {
        for (fixture, pointers) in Self.shared.invalid {
            let message = try Self.decode(fixture.message)
            let problem = try #require(message.unreadable, "\(fixture.name)")
            #expect(message.content.isEmpty, "\(fixture.name)")
            let data = try JSONEncoder().encode(fixture.message)
            let paths = try JSONDecoder().decode(SchemaProbe.self, from: data).paths
            for pointer in pointers {
                #expect(paths.contains { $0 == pointer || $0.hasPrefix(pointer + "/") }, "\(fixture.name): \(pointer) not in \(paths); \(problem)")
            }
        }
    }

    /// The shared cancelled card, with question ID "reviewer" and an empty
    /// header: it fails on `answers` alone.
    @Test func theSharedCancelledCardFailsOnItsAnswersAlone() throws {
        let card = try #require(Self.shared.invalid.first { $0.fixture.name == "cluster-cancelled-question.json" })
        let message = try Self.decode(card.fixture.message)
        #expect(message.unreadable == "/content/1/presentation/answers: is null")
        let question = card.fixture.message["content"]?.arrayValue?[1]["presentation"]?["questions"]?.arrayValue?.first
        #expect(question?["id"] == .string("reviewer"))
        #expect(question?["header"] == .string(""))
    }

    @Test func theCancelledCardKeepsItsPlaceAndRole() throws {
        let message = try Self.decode(Self.cancelledCard)
        #expect(message.id == "bad1")
        #expect(message.role == "agent")
        #expect(message.createdAt == 1764000000010)
        #expect(message.unreadable == "/content/0/presentation/answers: is null")
    }

    /// A history page with the bad card between two good messages: the
    /// page decodes whole, the card is a placeholder in its place.
    @Test func aPageKeepsTheMessagesAroundABadOne() throws {
        let valid = Self.fixtures.valid
        let page: JSONValue = .object(["hasMore": .bool(false), "cursor": .string("c"), "runs": .array([.object([
            "id": .string("r1"), "status": .string("completed"), "startedAt": .number(0),
            "messages": .array([valid[0].message, Self.cancelledCard, .string("not a message"), valid[2].message]),
        ])])])
        let response = try JSONDecoder().decode(AgentWire.MessagesResponse.self, from: JSONEncoder().encode(page))
        let messages = try #require(response.runs.first?.messages)
        #expect(messages.map(\.id) == ["u1", "bad1", "unreadable/runs/0/messages/2", "a1"])
        #expect(messages.map { $0.unreadable != nil } == [false, true, true, false])
        #expect(messages[0].content == [.text("Review the PR")])
        #expect(messages[3].content.count == 3)
    }

    @Test func aBadPendingMessageLeavesTheBootstrap() throws {
        let start: JSONValue = .object([
            "agent": .object(["id": .string("s"), "workspaceId": .string("w"), "status": .string("idle")]),
            "pending": .array([Self.cancelledCard, Self.fixtures.valid[1].message]),
        ])
        let bootstrap = try JSONDecoder().decode(AgentWire.Bootstrap.self, from: JSONEncoder().encode(start))
        #expect(bootstrap.pending?.map(\.id) == ["bad1", "u2"])
        #expect(bootstrap.pending?.last?.unreadable == nil)
    }

    @Test func aLiveEventsBadMessageIsAPlaceholder() {
        let message = Conversation.decodeMessage(Self.cancelledCard)
        #expect(message?.id == "bad1")
        #expect(message?.unreadable != nil)
    }

    /// The bad card in a conversation: a placeholder row where it stands,
    /// the person's message before it and the agent's words after it
    /// drawn as ever, and a bad live message too, beside a good one.
    @Test func aConversationShowsAPlaceholderInPlace() async throws {
        let valid = Self.fixtures.valid
        let server = SchemaServer(history: [valid[0].message, Self.cancelledCard, Self.agentWords("a9", "Done")])
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s")
        let latest = SchemaLatest()
        let updates = conversation.updates
        let watching = Task {
            for await snapshot in updates where snapshot.loaded { await latest.set(snapshot.items) }
        }
        defer { watching.cancel() }
        await conversation.start()
        await conversation.setVisible(true)
        let loaded = try await latest.waits { $0.contains { $0.text == "Done" } }
        let shown = loaded.filter { !Self.isTurnEnd($0) }
        #expect(shown.map(\.id) == ["u1", "bad1", "a9"])
        #expect(shown[0].text == "Review the PR")
        #expect(shown[1].role == .unreadable(.init(messageId: "bad1", problem: "/content/0/presentation/answers: is null")))
        #expect(shown[1].pieces.isEmpty)
        #expect(shown[2].text == "Done")

        var bad = Self.cancelledCard
        if case .object(var root) = bad { root["id"] = .string("bad-live"); bad = .object(root) }
        await engine.spaces.externalEvent(.object(["type": .string("message.created"), "payload": .object(["agentId": .string("s"), "runId": .string("r1"), "message": bad])]))
        await engine.spaces.externalEvent(.object(["type": .string("message.created"), "payload": .object(["agentId": .string("s"), "runId": .string("r1"), "message": Self.agentWords("a10", "After")])]))
        let live = try await latest.waits { $0.contains { $0.text == "After" } }
        let ids = live.filter { !Self.isTurnEnd($0) }.map(\.id)
        #expect(ids == ["u1", "bad1", "a9", "bad-live", "a10"])
        await conversation.stop()
    }

    static func isTurnEnd(_ item: ChatItem) -> Bool {
        if case .turnEnd = item.role { return true }
        if case .trace = item.role { return true }
        return false
    }

    static func agentWords(_ id: String, _ text: String) -> JSONValue {
        .object(["id": .string(id), "role": .string("agent"), "createdAt": .number(1764000000020), "metadata": .object([:]),
                 "content": .array([.object(["type": .string("text"), "text": .string(text)])])])
    }
}

/// Where `MessageSchema` finds one value's problems.
private struct SchemaProbe: Decodable {
    var paths: [String] = []
    init(from decoder: Decoder) throws {
        do { try MessageSchema.check(decoder) } catch let problems as MessageSchema.Problems { paths = problems.all.map(\.path) } catch let problem as MessageSchema.Problem { paths = [problem.path] }
    }
}

private actor SchemaLatest {
    private var items: [ChatItem] = []
    func set(_ value: [ChatItem]) { items = value }
    func waits(until done: ([ChatItem]) -> Bool) async throws -> [ChatItem] {
        for _ in 0..<200 where !done(items) { try await Task.sleep(for: .milliseconds(20)) }
        #expect(done(items), "timed out: \(items.map(\.id))")
        return items
    }
}

/// One agent whose one run holds `history`, still running.
private actor SchemaServer: AgentTransport {
    let history: [JSONValue]

    init(history: [JSONValue]) { self.history = history }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array([.object([
                "id": .string("r1"), "status": .string("running"), "startedAt": .number(0), "messages": .array(history),
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
