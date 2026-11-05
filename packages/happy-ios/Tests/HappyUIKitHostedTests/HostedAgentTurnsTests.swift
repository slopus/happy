#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct TurnsOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct TurnsNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, on a paired computer: its runs, the question it waits
/// on, and the answers it took.
private actor TurnsComputer: AgentTransport {
    var runs: [JSONValue]
    var pendingQuestion: String?
    private(set) var answers: [JSONValue] = []

    init(runs: [JSONValue], pendingQuestion: String? = nil) {
        self.runs = runs
        self.pendingQuestion = pendingQuestion
    }

    func set(runs: [JSONValue], pendingQuestion: String?) {
        self.runs = runs
        self.pendingQuestion = pendingQuestion
    }

    static let options: JSONValue = .array([
        .object(["label": .string("Postgres"), "description": .string("Relational, on the server")]),
        .object(["label": .string("SQLite"), "description": .string("One local file")]),
    ])
    static let questionArguments: JSONValue = .object(["context": .string("c"), "questions": .array([
        .object(["header": .string("Database"), "question": .string("Which database should the cache use?"), "options": options]),
    ])])

    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func call(_ id: String, _ name: String, status: String = "completed", _ presentation: [String: JSONValue]? = nil, arguments: JSONValue? = nil, output: String? = nil) -> JSONValue {
        var block: [String: JSONValue] = ["type": .string("tool_call"), "id": .string(id), "name": .string(name), "status": .string(status)]
        if let presentation { block["presentation"] = .object(presentation) }
        if let arguments { block["arguments"] = arguments }
        if let output { block["result"] = .object(["output": .string(output)]) }
        return .object(block)
    }

    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    /// A run: the person's words, then the agent's blocks; ended `took`
    /// milliseconds after it began.
    static func run(_ id: String, asked: String, took: Double?, _ blocks: [JSONValue]) -> JSONValue {
        var run: [String: JSONValue] = ["id": .string(id), "status": .string(took == nil ? "running" : "completed"), "startedAt": .number(1_000), "messages": .array([
            message("u-\(id)", role: "user", [text(asked)]), message("m-\(id)", role: "agent", blocks),
        ])]
        if let took { run["endedAt"] = .number(1_000 + took); run["reason"] = .string("completed") }
        return .object(run)
    }

    /// The work a turn does on desktop's fixtures: a command, a read, an
    /// edit, and its answer.
    static func work(_ id: String, took: Double?, answer: String?) -> JSONValue {
        let running = took == nil
        var blocks: [JSONValue] = [
            text("I'll run the tests first."),
            call("\(id)-1", "exec_command", ["type": .string("exec_command"), "command": .string("pnpm test --filter happy-ios")]),
            call("\(id)-2", "Read", ["type": .string("exploration"), "operations": .array([.object(["kind": .string("read"), "name": .string("sources/cache/Cache.swift")])])]),
            call("\(id)-3", "Edit", status: running ? "running" : "completed", running ? nil : ["type": .string("file_diff"), "files": .array([
                .object(["path": .string("sources/cache/Cache.swift"), "kind": .string("update"), "added": .number(3), "deleted": .number(1)]),
            ])]),
        ]
        if let answer { blocks.append(text(answer)) }
        return run(id, asked: "Fix the failing cache test", took: took, blocks)
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(runs)])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            let running = runs.last?["status"]?.stringValue == "running"
            var agent: [String: JSONValue] = ["id": .string("a"), "workspaceId": .string("w"), "status": .string(running ? "working" : "idle")]
            if let pendingQuestion { agent["pendingQuestionId"] = .string(pendingQuestion) }
            value = .object(["agent": .object(agent), "pending": .array([])])
        } else if path.hasSuffix("/agents/a/question"), method == "GET" {
            value = .object(["question": pendingQuestion.map { id in
                .object(["id": .string(id), "agentId": .string("a"), "runId": .string("q-run"), "status": .string("pending"), "questions": .array([
                    .object(["id": .string("question_1"), "header": .string("Database"), "question": .string("Which database should the cache use?"),
                             "multiSelect": .bool(false), "options": Self.options]),
                ])])
            } ?? .null])
        } else if path.contains("/agents/a/question/"), method == "POST" {
            guard pendingQuestion != nil, let body, let sent = try? JSONDecoder().decode(JSONValue.self, from: body) else {
                return .init(status: 409, body: Data(#"{"error":"conflict","code":"conflict"}"#.utf8))
            }
            answers.append(sent)
            pendingQuestion = nil
            value = .object(["question": .object(["id": .string("q"), "agentId": .string("a"), "status": .string("answered"), "questions": .array([]), "answers": sent["answers"] ?? .null])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}

/// The new chat's transcript as desktop's: a turn's tool calls while it
/// runs, folded behind its answer once it ends, "Completed in …", and its
/// questions, answered once and still answered when read again.
@MainActor
final class HostedAgentTurnsTests: XCTestCase {
    private func session(_ computer: TurnsComputer) async throws -> Session {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: TurnsOffline(), connector: TurnsNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"turns-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        return try XCTUnwrap(Session.session(for: pairing.id, context: context))
    }

    private func open(_ session: Session, style: UIUserInterfaceStyle = .light) async throws -> (ChatViewController, UIWindow) {
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        window.overrideUserInterfaceStyle = style
        window.layoutIfNeeded()
        addTeardownBlock { @MainActor in window.isHidden = true }
        return (chat, window)
    }

    private func until(_ what: String, _ seconds: Double = 5, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private func plan(_ chat: ChatViewController, _ id: String) -> ChatRowPlan? { chat.plans.first { $0.id == id } }

    private func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let found = view as? View { return found }
        for subview in view.subviews { if let found = find(type, in: subview) { return found } }
        return nil
    }

    /// Where row `id` is on screen, in the chat's coordinates.
    private func onScreen(_ id: String, in chat: ChatViewController) -> CGRect? {
        guard let transcript = find(AgentChatUltraList.self, in: chat.view),
              let index = transcript.list.items.firstIndex(where: { $0.identity == "chat:row:\(id)" }),
              let row = transcript.list.loadedItemView(at: index) else { return nil }
        return row.convert(row.bounds, to: chat.view)
    }

    /// The rows whole under the navigation bar, in order, and where each is.
    private func rowsUnderTheBar(in chat: ChatViewController) -> [(String, CGRect)] {
        guard let transcript = find(AgentChatUltraList.self, in: chat.view) else { return [] }
        let top = transcript.list.convert(CGPoint(x: 0, y: transcript.list.viewportInsets.top), to: chat.view).y
        return transcript.list.loadedIndexRange.compactMap { index in
            guard let row = transcript.list.loadedItemView(at: index), transcript.list.items[index].identity.hasPrefix("chat:row:") else { return nil }
            let frame = row.convert(row.bounds, to: chat.view)
            return frame.minY >= top - 0.5 ? (String(transcript.list.items[index].identity.dropFirst("chat:row:".count)), frame) : nil
        }
    }

    /// The row the list keeps in place across a change: the first under the
    /// bar before it that is still there after, passing over a turn's
    /// control, which goes over or under its rows. Where it was, and is.
    private func keptRow(_ before: [(String, CGRect)], in chat: ChatViewController) -> (String, CGRect, CGRect)? {
        for (id, frame) in before where !id.hasSuffix(":trace") && !id.hasSuffix(":status") {
            if let now = onScreen(id, in: chat) { return (id, frame, now) }
        }
        return nil
    }

    // MARK: Turns

    /// Running, each tool call is its own line; ended, they fold behind the
    /// answer, "View traces" over it and "Completed in 12s" under it.
    func testALiveTurnShowsItsToolCallsThenFoldsThemWhenItEnds() async throws {
        let computer = TurnsComputer(runs: [TurnsComputer.work("live", took: nil, answer: nil)])
        let session = try await session(computer)
        let (chat, _) = try await open(session)
        try await until("the running turn's tool rows") { plan(chat, "live-1") != nil && plan(chat, "live-3") != nil }
        XCTAssertEqual(plan(chat, "live-1")?.accessibilityLabel, "Shell pnpm test --filter happy-ios")
        XCTAssertEqual(plan(chat, "live-2")?.accessibilityLabel, "Explored sources/cache/Cache.swift")
        XCTAssertTrue(plan(chat, "live-3")?.items.contains { if case .spinner = $0 { true } else { false } } == true, "a running call spins")
        XCTAssertNil(plan(chat, "live:trace"), "a running turn shows its work")

        let ended = TurnsComputer.work("live", took: 12_400, answer: "The cache test passes now.")
        await computer.set(runs: [ended], pendingQuestion: nil)
        let store = session.store
        await store.externalEvent(.object(["type": .string("message.updated"), "payload": .object([
            "agentId": .string("a"), "runId": .string("live"), "message": ended["messages"]?.arrayValue?[1] ?? .null,
        ])]))
        await store.externalEvent(.object(["type": .string("run.finished"), "payload": .object([
            "agentId": .string("a"), "run": .object(["id": .string("live"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(13_400)]),
        ])]))
        try await until("the turn folds") { plan(chat, "live:status") != nil }
        XCTAssertEqual(chat.plans.map(\.id), ["u-live", "live-3", "live:trace", "m-live/4", "live:status"])
        XCTAssertEqual(plan(chat, "live:status")?.accessibilityLabel, "Completed in\u{00a0}12s")
        XCTAssertEqual(plan(chat, "live:trace")?.accessibilityLabel, "View traces, 3 tools")
        XCTAssertEqual(plan(chat, "live-3")?.accessibilityLabel, "Edit Cache.swift", "a file edit stays when the turn folds")
        // The status copies the answer.
        let copy = try XCTUnwrap(plan(chat, "live:status")?.hits.first)
        XCTAssertEqual(copy.action, .copyMessage(id: "live:status", text: "The cache test passes now."))
    }

    /// "View traces" opens the turn in place: the rows the reader looks
    /// at stay where they are, the keyboard up or down; "Hide traces"
    /// folds it again.
    func testOpeningAndFoldingATurnKeepsTheReadersPlace() async throws {
        let runs = (0..<4).map { TurnsComputer.work("r\($0)", took: Double(60_000 + $0 * 1_000), answer: "Turn \($0) is done.") }
        let computer = TurnsComputer(runs: runs)
        let session = try await session(computer)
        let (chat, window) = try await open(session)
        try await until("every turn folded") { plan(chat, "r3:status") != nil }
        XCTAssertNil(plan(chat, "r0-1"), "older turns open folded")
        XCTAssertEqual(plan(chat, "r3:status")?.accessibilityLabel, "Completed in\u{00a0}1m\u{00a0}3s")

        for keyboard in [false, true] {
            if keyboard {
                let bounds = window.screen.bounds
                let shown = CGRect(x: 0, y: bounds.maxY - 336, width: bounds.width, height: 336)
                NotificationCenter.default.post(name: UIResponder.keyboardWillChangeFrameNotification, object: nil, userInfo: [
                    UIResponder.keyboardFrameBeginUserInfoKey: NSValue(cgRect: shown.offsetBy(dx: 0, dy: 336)),
                    UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: shown),
                    UIResponder.keyboardAnimationDurationUserInfoKey: 0.0,
                    UIResponder.keyboardAnimationCurveUserInfoKey: 7,
                ])
                window.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(300))
            }
            // The newest turn's answer is what the reader is looking at;
            // the turn opens and folds around the first row on screen,
            // which holds still, as the row the finger is on does.
            try await until("the newest answer on screen") { onScreen("m-r3/4", in: chat) != nil }
            let closed = rowsUnderTheBar(in: chat)
            chat.act(.toggleTurn("r2"))
            try await until("the turn opens") { plan(chat, "r2-1") != nil }
            try await Task.sleep(for: .milliseconds(400))
            XCTAssertEqual(plan(chat, "r2:trace")?.accessibilityLabel, "Hide traces, 3 tools")
            XCTAssertEqual(chat.plans.firstIndex { $0.id == "r2:trace" }.map { chat.plans[$0 + 1].id }, "m-r2", "open, the control rides the turn's first row")
            let opened = try XCTUnwrap(keptRow(closed, in: chat))
            XCTAssertEqual(opened.2.minY, opened.1.minY, accuracy: 1, "opening a turn moved \(opened.0), what the reader was reading (keyboard \(keyboard))")
            let open = rowsUnderTheBar(in: chat)
            chat.act(.toggleTurn("r2"))
            try await until("the turn folds again") { plan(chat, "r2-1") == nil }
            try await Task.sleep(for: .milliseconds(400))
            let folded = try XCTUnwrap(keptRow(open, in: chat))
            XCTAssertEqual(folded.2.minY, folded.1.minY, accuracy: 1, "folding a turn moved \(folded.0), what the reader was reading (keyboard \(keyboard))")
        }

        // Read up in history: a turn opened above stays out of the way.
        let transcript = try XCTUnwrap(find(AgentChatUltraList.self, in: chat.view))
        let index = try XCTUnwrap(transcript.list.items.firstIndex { $0.identity == "chat:row:m-r1/4" })
        transcript.list.scrollTo(.init(index: index), transition: .none)
        try await until("an older answer on screen") { onScreen("m-r1/4", in: chat) != nil }
        try await Task.sleep(for: .milliseconds(200))
        let read = try XCTUnwrap(onScreen("m-r1/4", in: chat))
        chat.act(.toggleTurn("r0"))
        try await until("the older turn opens") { plan(chat, "r0-1") != nil }
        try await Task.sleep(for: .milliseconds(400))
        let after = try XCTUnwrap(onScreen("m-r1/4", in: chat))
        XCTAssertEqual(after.minY, read.minY, accuracy: 1, "opening a turn above moved what the reader was reading")
    }

    // MARK: Questions

    /// A question waiting is pinned to the end, ticked, sent once with
    /// Submit, and read again later stands answered in its turn.
    func testAQuestionIsAnsweredOnceAndStandsAnsweredWhenReadAgain() async throws {
        let asking = TurnsComputer.run("q-run", asked: "Add a cache", took: nil, [
            TurnsComputer.text("Before I start:"),
            TurnsComputer.call("q", AgentWire.Question.toolName, status: "running", arguments: TurnsComputer.questionArguments),
        ])
        let computer = TurnsComputer(runs: [asking], pendingQuestion: "q")
        let session = try await session(computer)
        let (chat, _) = try await open(session)
        try await until("the question") { chat.plans.last?.id == "q" }
        var question = try XCTUnwrap(plan(chat, "q"))
        XCTAssertTrue(question.accessibilityLabel?.contains("Which database should the cache use?") == true)
        XCTAssertFalse(question.hits.contains { if case .questionSubmit = $0.action { true } else { false } }, "nothing ticked, Submit waits")
        chat.act(.questionOption(toolId: "q", questionId: "question_1", option: 0))
        try await until("the tick") { plan(chat, "q")?.hits.contains { if case .questionSubmit = $0.action { true } else { false } } == true }
        question = try XCTUnwrap(plan(chat, "q"))
        chat.act(.questionSubmit(toolId: "q"))
        chat.act(.questionSubmit(toolId: "q"))
        try await until("the answer settles") {
            guard let row = plan(chat, "q") else { return false }
            return row.accessibilityLabel?.contains("Answered") == true
        }
        let answers = await computer.answers
        XCTAssertEqual(answers.count, 1, "answered once")
        XCTAssertEqual(answers.first?["answers"], .object(["question_1": .array([.string("Postgres")])]))
        XCTAssertFalse(plan(chat, "q")?.hits.contains { if case .questionOption = $0.action { true } else { false } } ?? true, "answered, it takes no more ticks")
        chat.act(.questionSubmit(toolId: "q"))
        try await Task.sleep(for: .milliseconds(200))
        let resent = await computer.answers
        XCTAssertEqual(resent.count, 1, "answered, it doesn't go again")

        // The turn goes on: the question settles in it, folded with it.
        let output = "Request q:\n[Database] Which database should the cache use?\nStatus: Answered\nAnswer:\nquestion_1: Selected: Postgres"
        let ended = TurnsComputer.run("q-run", asked: "Add a cache", took: 30_000, [
            TurnsComputer.text("Before I start:"),
            TurnsComputer.call("q", AgentWire.Question.toolName, arguments: TurnsComputer.questionArguments, output: output),
            TurnsComputer.text("Postgres it is."),
        ])
        await computer.set(runs: [ended], pendingQuestion: nil)
        await session.store.externalEvent(.object(["type": .string("message.updated"), "payload": .object([
            "agentId": .string("a"), "runId": .string("q-run"), "message": ended["messages"]?.arrayValue?[1] ?? .null,
        ])]))
        await session.store.externalEvent(.object(["type": .string("run.finished"), "payload": .object([
            "agentId": .string("a"), "run": .object(["id": .string("q-run"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(31_000)]),
        ])]))
        try await until("the turn folds over its question") { plan(chat, "q-run:trace") != nil }
        XCTAssertNil(plan(chat, "q"), "answered, it folds with its turn")

        // Read again on another launch: folded with its turn, and answered
        // when the turn is opened, from what the call returned.
        let (again, _) = try await open(try await self.session(TurnsComputer(runs: [ended])))
        try await until("the folded turn") { plan(again, "q-run:trace") != nil }
        XCTAssertNil(plan(again, "q"))
        again.act(.toggleTurn("q-run"))
        try await until("the answered question") { plan(again, "q") != nil }
        let settled = try XCTUnwrap(plan(again, "q")?.accessibilityLabel)
        XCTAssertTrue(settled.contains("Answered") && settled.contains("Postgres"), settled)
        XCTAssertFalse(plan(again, "q")?.hits.contains { if case .questionOption = $0.action { true } else { false } } ?? true, "an answered question takes no ticks")
    }

    /// Typed in the composer, words answer the waiting question, as on
    /// desktop: the prompt with nothing ticked takes them.
    func testTheComposerAnswersTheWaitingQuestion() async throws {
        let asking = TurnsComputer.run("q-run", asked: "Add a cache", took: nil, [
            TurnsComputer.call("q", AgentWire.Question.toolName, status: "running", arguments: TurnsComputer.questionArguments),
        ])
        let computer = TurnsComputer(runs: [asking], pendingQuestion: "q")
        let session = try await session(computer)
        let (chat, _) = try await open(session)
        try await until("the question") { chat.plans.last?.id == "q" }
        chat.card.setText("Redis, please", selection: NSRange(location: 0, length: 0))
        chat.agentInputCardDidPressSend(chat.card)
        try await until("the typed answer") { await computer.answers.count == 1 }
        let answers = await computer.answers
        XCTAssertEqual(answers.first?["answers"], .object(["question_1": .array([.string("Redis, please")])]))
        XCTAssertEqual(chat.card.text, "", "the words went as the answer, not also as a message")
    }

    // MARK: Screenshots

    /// The rows beside desktop's, light and dark, written to
    /// `TURN_SCREENS` when it is set.
    func testScreenshotsOfTheTurnRows() async throws {
        guard let directory = ProcessInfo.processInfo.environment["TURN_SCREENS"] else { throw XCTSkip("TURN_SCREENS not set") }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let asking = TurnsComputer.run("q-run", asked: "Now add a cache in front of it", took: nil, [
            TurnsComputer.text("Before I start:"),
            TurnsComputer.call("q", AgentWire.Question.toolName, status: "running", arguments: .object(["context": .string("c"), "questions": .array([
                .object(["header": .string("Database"), "question": .string("Which database should the cache use?"), "options": TurnsComputer.options]),
            ])])),
        ])
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let computer = TurnsComputer(runs: [TurnsComputer.work("r1", took: 64_000, answer: "The cache test passes now: the key included the build number."), asking], pendingQuestion: "q")
            let session = try await session(computer)
            let (chat, window) = try await open(session, style: style)
            let name = style == .dark ? "dark" : "light"
            try await until("the transcript") { chat.plans.last?.id == "q" && plan(chat, "r1:status") != nil }
            try await Task.sleep(for: .milliseconds(600))
            try shoot(window, to: "\(directory)/ios-turn-folded-question-\(name).png")
            chat.act(.toggleTurn("r1"))
            try await until("opened") { plan(chat, "r1-1") != nil }
            chat.act(.questionOption(toolId: "q", questionId: "question_1", option: 0))
            try await Task.sleep(for: .milliseconds(700))
            if let row = onScreen("r1-1", in: chat), let transcript = find(AgentChatUltraList.self, in: chat.view),
               let index = transcript.list.items.firstIndex(where: { $0.identity == "chat:row:u-r1" }) {
                _ = row
                transcript.list.scrollTo(.init(index: index), transition: .none)
                try await Task.sleep(for: .milliseconds(500))
            }
            try shoot(window, to: "\(directory)/ios-turn-open-\(name).png")
            window.isHidden = true
        }
    }

    private func shoot(_ window: UIWindow, to path: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: path))
    }
}
#endif
