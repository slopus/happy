import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// A turn's own rows as desktop's transcript projects them
/// (`happyAgentConnectGroupProject`): tool calls while it runs, folded
/// once it ends, "Completed in …", and its questions.
final class AgentTurnsTests: XCTestCase {
    private func user(_ id: String, turn: String) -> ChatItem { ChatItem(id: id, role: .user, pieces: [.text("go")], delivery: .sent, turn: turn) }
    private func agent(_ id: String, _ text: String, turn: String) -> ChatItem { ChatItem(id: id, role: .agent, pieces: [.text(text)], delivery: .sent, turn: turn) }
    private func tool(_ id: String, _ name: String, status: String = "completed", type: String? = nil, turn: String) -> ChatItem {
        ChatItem(id: id, role: .tool(.init(name: name, status: status, presentation: type.map { AgentWire.Presentation(type: $0) })), pieces: [], delivery: .sent, turn: turn)
    }
    private func ended(_ turn: String, tools: Int, copy: String? = "Done.") -> ChatItem {
        ChatItem(id: "\(turn):status", role: .turnEnd(.init(reason: "completed", durationMs: 12_400, tools: tools, copyText: copy)), pieces: [], delivery: .sent, turn: turn)
    }

    // MARK: Words

    func testDurationsAreWrittenAsDesktopWritesThem() {
        XCTAssertEqual(ChatItem.TurnEnd.duration(0), "0s")
        XCTAssertEqual(ChatItem.TurnEnd.duration(59_999), "59s")
        XCTAssertEqual(ChatItem.TurnEnd.duration(187_000), "3m\u{00a0}7s")
        XCTAssertEqual(ChatItem.TurnEnd.duration(7_500_000), "2h\u{00a0}5m")
        let end = ChatItem.TurnEnd(reason: "completed", durationMs: 12_400, tools: 2, copyText: nil)
        XCTAssertEqual(end.label { _ in ("Completed", "in") }, "Completed in\u{00a0}12s")
        var unknown = end
        unknown.durationMs = nil
        XCTAssertEqual(unknown.label { _ in ("Completed", "in") }, "Completed")
        XCTAssertTrue(end.complete)
        XCTAssertFalse(ChatItem.TurnEnd(reason: "abort", durationMs: 1, tools: 0, copyText: "x").complete)
    }

    // MARK: Folding

    /// Closed, a finished turn keeps the person's words, a file edit, its
    /// answer with the control over it, and how it ended.
    func testAFinishedTurnFoldsItsStepsBehindItsAnswer() {
        let items = [
            user("u", turn: "r"), tool("t1", "exec_command", type: "exec_command", turn: "r"), agent("a1", "Looking.", turn: "r"),
            tool("t2", "Edit", type: "file_diff", turn: "r"), tool("t3", "Read", type: "exploration", turn: "r"), agent("a2", "Done.", turn: "r"),
            ended("r", tools: 3),
        ]
        let folded = TurnFold.fold(items, expanded: [])
        XCTAssertEqual(folded.map(\.id), ["u", "t2", "r:trace", "a2", "r:status"])
        XCTAssertEqual(folded[2].role, .trace(.init(turn: "r", open: false, tools: 3)))
        guard case .turnEnd(let end) = folded[4].role else { return XCTFail("no status") }
        XCTAssertFalse(end.afterStep, "after the answer the status is 32 tall")
    }

    /// Open, every step shows and the control rides the turn's first one.
    func testAnOpenTurnShowsEveryStepWithItsControlFirst() {
        let items = [user("u", turn: "r"), tool("t1", "Bash", turn: "r"), agent("a", "Done.", turn: "r"), tool("t2", "Bash", turn: "r"), ended("r", tools: 2)]
        let opened = TurnFold.fold(items, expanded: ["r"])
        XCTAssertEqual(opened.map(\.id), ["u", "r:trace", "t1", "a", "t2", "r:status"])
        XCTAssertEqual(opened[1].role, .trace(.init(turn: "r", open: true, tools: 2)))
        guard case .turnEnd(let end) = opened[5].role else { return XCTFail("no status") }
        XCTAssertTrue(end.afterStep, "after a step it keeps 4 more")
    }

    /// A running turn shows its work; one with nothing to hide has no control.
    func testARunningTurnAndAPlainAnswerAreLeftAlone() {
        let running = [user("u", turn: "r"), tool("t", "Bash", status: "running", turn: "r")]
        XCTAssertEqual(TurnFold.fold(running, expanded: []), running)
        let plain = [user("u", turn: "p"), agent("a", "Hi", turn: "p"), ended("p", tools: 0)]
        XCTAssertEqual(TurnFold.fold(plain, expanded: []).map(\.id), ["u", "a", "p:status"])
    }

    /// With no answer, the last step stands for the turn; failures stay.
    func testAToolOnlyTurnKeepsItsLastStepAndItsFailure() throws {
        let failure = try XCTUnwrap(Failure.of(AgentWire.Message(id: "f", role: "service", createdAt: 0, content: [.text("boom")], failure: .object(["message": .string("boom")]))))
        var items = [user("u", turn: "r"), tool("t1", "Bash", turn: "r"), tool("t2", "Read", turn: "r")]
        items.append(ChatItem(id: "f", role: .failure(failure), pieces: [.text("boom")], delivery: .sent, turn: "r"))
        items.append(ended("r", tools: 2, copy: nil))
        let folded = TurnFold.fold(items, expanded: [])
        XCTAssertEqual(folded.map(\.id), ["u", "r:trace", "t2", "f", "r:status"])
    }

    // MARK: Questions

    func testAQuestionIsReadFromItsCallAndItsResult() throws {
        let arguments: JSONValue = .object(["context": .string("c"), "questions": .array([
            .object(["header": .string("DB"), "question": .string("Which database?"), "multiSelect": .bool(false), "options": .array([
                .object(["label": .string("Postgres"), "description": .string("Relational")]), .object(["label": .string("SQLite"), "description": .string("Local")]),
            ])]),
            .object(["id": .string("extras"), "question": .string("Extras?"), "options": .object(["multiSelect": .bool(true), "choices": .array([
                .object(["label": .string("Cache, fast"), "description": .string("")]), .object(["label": .string("Search"), "description": .string("")]),
            ])])]),
        ])])
        let pending = try XCTUnwrap(AgentWire.Question.asked(id: "q", arguments: arguments, output: nil))
        XCTAssertEqual(pending.status, "pending")
        XCTAssertEqual(pending.questions.map(\.id), ["question_1", "extras"])
        XCTAssertEqual(pending.questions[1].multiSelect, true)
        XCTAssertEqual(pending.questions[0].options?.map(\.label), ["Postgres", "SQLite"])
        let output = "Request q:\n[DB] Which database?\nOptions:\n- Postgres: Relational\nStatus: Answered\nAnswer:\nquestion_1: Selected: Postgres\nextras: Selected: Cache, fast, Search\nand a note"
        let answered = try XCTUnwrap(AgentWire.Question.asked(id: "q", arguments: arguments, output: output))
        XCTAssertEqual(answered.status, "answered")
        XCTAssertEqual(answered.answers?["question_1"], ["Postgres"])
        XCTAssertEqual(answered.answers?["extras"], ["Cache, fast", "Search", "and a note"])
        let typed = try XCTUnwrap(AgentWire.Question.asked(id: "q", arguments: .object(["questions": .array([.object(["question": .string("Name?")])])]),
                                                             output: "Request q:\nName?\nStatus: Answered\nAnswer:\nquestion_1: Ada"))
        XCTAssertEqual(typed.answers?["question_1"], ["Ada"])
        let skipped = try XCTUnwrap(AgentWire.Question.asked(id: "q", arguments: arguments, output: "Request q:\nStatus: Cancelled\nReason: aborted"))
        XCTAssertEqual(skipped.status, "canceled")
    }

    func testPicksAndTypedAnswersFollowDesktop() {
        let question = AgentWire.Question(id: "q", questions: [
            .init(id: "one", question: "One?", multiSelect: false, options: [.init(label: "A"), .init(label: "B")]),
            .init(id: "many", question: "Many?", multiSelect: true, options: [.init(label: "X"), .init(label: "Y")]),
        ])
        var ask = ChatItem.Ask(question: question, phase: .pending)
        ask.picked = ask.picking("A", in: "one")
        ask.picked = ask.picking("B", in: "one")
        XCTAssertEqual(ask.picked["one"], ["B"], "one alone")
        ask.picked = ask.picking("X", in: "many")
        ask.picked = ask.picking("Y", in: "many")
        ask.picked = ask.picking("X", in: "many")
        XCTAssertEqual(ask.picked["many"], ["Y"], "picked again, taken back")
        XCTAssertTrue(ask.complete)
        let all = ask.answers(typed: "hello")
        XCTAssertFalse(all.textUsed)
        ask.picked["many"] = []
        XCTAssertFalse(ask.complete)
        let typed = ask.answers(typed: "hello")
        XCTAssertTrue(typed.textUsed)
        XCTAssertEqual(typed.answers, ["one": ["B"], "many": ["hello"]])
    }

    // MARK: The conversation

    private func open(_ server: TurnServer) async -> (Conversation, SyncEngine, AsyncStream<ChatSnapshot>.AsyncIterator) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        return (conversation, engine, updates)
    }

    private func next(_ updates: inout AsyncStream<ChatSnapshot>.AsyncIterator, until: (ChatSnapshot) -> Bool) async throws -> ChatSnapshot {
        while let snapshot = await updates.next() {
            if snapshot.loaded, until(snapshot) { return snapshot }
        }
        return try XCTUnwrap(nil as ChatSnapshot?, "the conversation ended first")
    }

    /// History's tool calls are rows in the order they were made, between
    /// the words around them; the run's end says how long it took.
    func testHistoryShowsToolCallsAndHowLongTheTurnTook() async throws {
        let server = TurnServer(runs: [TurnServer.run("r", ended: true, content: [
            "Looking.", TurnServer.call("t1", "exec_command", presentation: ["type": .string("exec_command"), "command": .string("ls")]),
            "Done.",
        ])])
        var (conversation, _, updates) = await open(server)
        let snapshot = try await next(&updates) { $0.items.count >= 4 }
        XCTAssertEqual(snapshot.items.map(\.id), ["u-r", "m-r", "t1", "m-r/2", "r:status"])
        XCTAssertEqual(snapshot.items[2].role, .tool(.init(name: "exec_command", status: "completed", presentation: AgentWire.Presentation(type: "exec_command", command: "ls"), callId: "t1")))
        XCTAssertEqual(snapshot.items[4].role, .turnEnd(.init(reason: "completed", durationMs: 12_000, tools: 1, copyText: "Done.", endedAt: 13_000)))
        XCTAssertEqual(Set(snapshot.items.map(\.turn)), ["r"])
        await conversation.stop()
    }

    /// Live, a tool call shows as it runs; the run's end adds its status.
    func testALiveTurnShowsItsToolThenEnds() async throws {
        let server = TurnServer(runs: [])
        var (conversation, engine, updates) = await open(server)
        _ = try await next(&updates) { _ in true }
        await engine.spaces.externalEvent(TurnServer.event("run.started", ["run": .object(["id": .string("live"), "status": .string("running"), "startedAt": .number(1_000)]), "acceptedMessageIds": .array([])]))
        await engine.spaces.externalEvent(TurnServer.event("message.updated", ["runId": .string("live"), "message": TurnServer.message("m", role: "agent", content: [
            TurnServer.call("t", "Read", status: "running", presentation: ["type": .string("exploration"), "operations": .array([.object(["kind": .string("read"), "name": .string("a.swift")])])]),
        ])]))
        let running = try await next(&updates) { $0.items.contains { $0.id == "t" } }
        guard case .tool(let tool) = running.items.first(where: { $0.id == "t" })?.role else { return XCTFail("no tool row") }
        XCTAssertTrue(tool.running)
        XCTAssertEqual(tool.presentation?.operations?.first?.name, "a.swift")
        await engine.spaces.externalEvent(TurnServer.event("run.finished", ["run": .object(["id": .string("live"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(64_000)])]))
        let ended = try await next(&updates) { $0.items.contains { $0.id == "live:status" } }
        XCTAssertEqual(ended.items.last?.role, .turnEnd(.init(reason: "completed", durationMs: 63_000, tools: 1, copyText: nil, endedAt: 64_000)))
        await conversation.stop()
    }

    /// A question the agent waits on is read, pinned to the end, answered
    /// once, and after a reload stands answered where it was asked.
    func testAQuestionIsAnsweredOnceAndStaysAnsweredAfterAReload() async throws {
        let server = TurnServer(runs: [TurnServer.run("r", ended: false, content: [
            TurnServer.call("q", AgentWire.Question.toolName, status: "running", arguments: TurnServer.questionArguments),
        ])], pendingQuestion: "q")
        var (conversation, _, updates) = await open(server)
        let pending = try await next(&updates) { $0.items.last?.id == "q" }
        guard case .question(let ask) = pending.items.last?.role else { return XCTFail("no question") }
        XCTAssertEqual(ask.phase, .pending)
        XCTAssertNil(pending.items.last?.turn, "pinned to the end, never folded")
        XCTAssertFalse(pending.items.contains { if case .tool = $0.role { true } else { false } }, "its call is not also a tool row")
        await conversation.answer(["question_1": ["Postgres"]])
        await conversation.answer(["question_1": ["SQLite"]])
        let answers = await server.answers
        XCTAssertEqual(answers.count, 1, "answered once")
        XCTAssertEqual(answers.first?["answers"], .object(["question_1": .array([.string("Postgres")])]))
        await conversation.stop()

        // Read again: the call carries its result, and the question is history.
        await server.finish()
        var (again, _, later) = await open(server)
        let reloaded = try await next(&later) { $0.items.contains { $0.id == "q" } }
        guard case .question(let settled) = reloaded.items.first(where: { $0.id == "q" })?.role else { return XCTFail("no answered question") }
        XCTAssertEqual(settled.phase, .answered)
        XCTAssertEqual(settled.question.answers?["question_1"], ["Postgres"])
        XCTAssertEqual(reloaded.items.first { $0.id == "q" }?.turn, "r")
        await again.stop()
    }
}

/// A computer with one agent, `a`: its runs, the question it waits on, and
/// the answers it took.
actor TurnServer: AgentTransport {
    private var runs: [JSONValue]
    private var pendingQuestion: String?
    private(set) var answers: [JSONValue] = []

    init(runs: [JSONValue], pendingQuestion: String? = nil) {
        self.runs = runs
        self.pendingQuestion = pendingQuestion
    }

    static let questionArguments: JSONValue = .object(["context": .string("c"), "questions": .array([
        .object(["header": .string("Database"), "question": .string("Which database?"), "options": .array([
            .object(["label": .string("Postgres"), "description": .string("Relational")]), .object(["label": .string("SQLite"), "description": .string("Local file")]),
        ])]),
    ])])

    static func call(_ id: String, _ name: String, status: String = "completed", presentation: [String: JSONValue]? = nil, arguments: JSONValue? = nil, output: String? = nil) -> JSONValue {
        var block: [String: JSONValue] = ["type": .string("tool_call"), "id": .string(id), "name": .string(name), "status": .string(status)]
        if let presentation { block["presentation"] = .object(presentation) }
        if let arguments { block["arguments"] = arguments }
        if let output { block["result"] = .object(["output": .string(output)]) }
        return .object(block)
    }

    static func message(_ id: String, role: String, content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    static func run(_ id: String, ended: Bool, content: [Any]) -> JSONValue {
        let blocks: [JSONValue] = content.map { part in
            if let text = part as? String { return .object(["type": .string("text"), "text": .string(text)]) }
            return part as? JSONValue ?? .null
        }
        var run: [String: JSONValue] = ["id": .string(id), "status": .string(ended ? "completed" : "running"), "startedAt": .number(1_000), "messages": .array([
            message("u-\(id)", role: "user", content: [.object(["type": .string("text"), "text": .string("go")])]),
            message("m-\(id)", role: "agent", content: blocks),
        ])]
        if ended { run["endedAt"] = .number(13_000); run["reason"] = .string("completed") }
        return .object(run)
    }

    static func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        var payload = payload
        payload["agentId"] = .string("a")
        return .object(["type": .string(type), "payload": .object(payload)])
    }

    /// The question was answered and the run went on to its end.
    func finish() {
        pendingQuestion = nil
        let output = "Request q:\n[Database] Which database?\nStatus: Answered\nAnswer:\nPostgres"
        runs = [Self.run("r", ended: true, content: [Self.call("q", AgentWire.Question.toolName, arguments: Self.questionArguments, output: output), "Postgres it is."])]
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(runs)])
        } else if path.hasSuffix("/bootstrap") {
            var agent: [String: JSONValue] = ["id": .string("a"), "workspaceId": .string("w"), "status": .string(pendingQuestion == nil ? "idle" : "working")]
            if let pendingQuestion { agent["pendingQuestionId"] = .string(pendingQuestion) }
            value = .object(["agent": .object(agent), "pending": .array([])])
        } else if path.hasSuffix("/question"), method == "GET" {
            value = .object(["question": pendingQuestion.map { id in
                .object(["id": .string(id), "agentId": .string("a"), "runId": .string("r"), "status": .string("pending"), "questions": .array([
                    .object(["id": .string("question_1"), "header": .string("Database"), "question": .string("Which database?"), "multiSelect": .bool(false), "options": .array([
                        .object(["label": .string("Postgres"), "description": .string("Relational")]), .object(["label": .string("SQLite"), "description": .string("Local file")]),
                    ])]),
                ])])
            } ?? .null])
        } else if path.contains("/question/"), method == "POST" {
            guard pendingQuestion != nil, let body, let sent = try? JSONDecoder().decode(JSONValue.self, from: body) else {
                return .init(status: 409, body: Data(#"{"error":"conflict","code":"conflict"}"#.utf8))
            }
            answers.append(sent)
            pendingQuestion = nil
            value = .object(["question": .object(["id": .string("q"), "agentId": .string("a"), "status": .string("answered"), "questions": .array([]),
                                                  "answers": sent["answers"] ?? .null])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
