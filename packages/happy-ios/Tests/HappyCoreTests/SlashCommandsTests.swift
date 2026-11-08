import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// The agent composer's slash commands: the catalog as the computer sends
/// it, how a draft reads against it, and what running one asks of the
/// computer (happy-agent API.md, "Slash commands"; desktop d04fbfef,
/// 4078fd44, fd553cc3, aa8a2529).
final class SlashCommandsTests: XCTestCase {
    private static let compact = AgentWire.SlashCommand(name: "compact", hasArguments: false, description: "Summarize older messages to free context space.", kind: "compaction")
    private static let review = AgentWire.SlashCommand(name: "code-review", hasArguments: true, description: "Review the current changes.", kind: "skill",
                                                       image: .init(thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
    private static let deploy = AgentWire.SlashCommand(name: "deploy", hasArguments: true, description: "Ship it.", kind: "release")
    private static let catalog = [compact, review, deploy]

    // MARK: Parsing

    func testTheCatalogDecodesAsSentAndDropsWhatItCannotRead() throws {
        let json = #"""
        {"agent":{"id":"a","workspaceId":"w","status":"idle"},"pending":[],"slashCommands":[
          {"name":"compact","hasArguments":false,"description":"Summarize older messages to free context space.","kind":"compaction"},
          {"name":"broken"},
          {"name":"code-review","hasArguments":true,"description":"Review the current changes.","kind":"skill","image":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},
          {"name":"deploy","hasArguments":true,"description":"Ship it.","kind":"release","later":"ignored"}
        ]}
        """#
        let bootstrap = try JSONDecoder().decode(AgentWire.Bootstrap.self, from: Data(json.utf8))
        XCTAssertEqual(bootstrap.slashCommands, Self.catalog)
        XCTAssertEqual(bootstrap.agent.id, "a")
    }

    func testAnOlderComputerSendsNoCatalog() throws {
        let json = #"{"agent":{"id":"a","workspaceId":"w","status":"idle"},"pending":[]}"#
        XCTAssertNil(try JSONDecoder().decode(AgentWire.Bootstrap.self, from: Data(json.utf8)).slashCommands)
    }

    func testACommandsPictureIsItsFocusedImageRoute() {
        XCTAssertEqual(Self.review.imagePath(agentId: "agent 1"), "/v0/agents/agent%201/slash-commands/code-review/image")
    }

    func testACompactionBlockSurvivesBeingKept() throws {
        let json = #"{"type":"compaction","trigger":"manual","status":"completed","tokensBefore":201000,"tokensAfter":43000,"failureReason":null,"startedAt":1,"completedAt":2}"#
        let block = try JSONDecoder().decode(AgentWire.Block.self, from: Data(json.utf8))
        let expected = AgentWire.Block.compaction(.init(status: "completed", trigger: "manual", tokensBefore: 201_000, tokensAfter: 43_000))
        XCTAssertEqual(block, expected)
        XCTAssertEqual(try JSONDecoder().decode(AgentWire.Block.self, from: JSONEncoder().encode(block)), expected)
    }

    // MARK: Reading a draft

    func testThePaletteOpensOnlyWhileTheWholeDraftIsOneCommandWord() {
        XCTAssertEqual(SlashCommands.query("/", in: Self.catalog), "")
        XCTAssertEqual(SlashCommands.query("/co", in: Self.catalog), "co")
        XCTAssertEqual(SlashCommands.query("/CODE-r", in: Self.catalog), "CODE-r")
        XCTAssertNil(SlashCommands.query("/Users/steve/project", in: Self.catalog), "a pasted path is text")
        XCTAssertNil(SlashCommands.query("/ two words", in: Self.catalog))
        XCTAssertNil(SlashCommands.query("/compact now", in: Self.catalog), "arguments close it")
        XCTAssertNil(SlashCommands.query("/nonsense", in: Self.catalog), "nothing starts with it")
        XCTAssertNil(SlashCommands.query("hello /co", in: Self.catalog))
        XCTAssertNil(SlashCommands.query("/", in: []), "no commands, no palette")
    }

    func testThePaletteFiltersByTheNamesStartInTheAgentsOrder() {
        XCTAssertEqual(SlashCommands.matches("", in: Self.catalog).map(\.name), ["compact", "code-review", "deploy"])
        XCTAssertEqual(SlashCommands.matches("c", in: Self.catalog).map(\.name), ["compact", "code-review"])
        XCTAssertEqual(SlashCommands.matches("CO", in: Self.catalog).map(\.name), ["compact", "code-review"])
        XCTAssertEqual(SlashCommands.matches("cod", in: Self.catalog).map(\.name), ["code-review"])
        XCTAssertEqual(SlashCommands.matches("review", in: Self.catalog).map(\.name), [], "the start of the name, not anywhere in it")
    }

    func testEachRowIsTheCommandWithItsPicturesRoute() {
        XCTAssertEqual(SlashCommands.suggestions("cod", in: Self.catalog, agentId: "a"), [
            ComposerSuggestion(key: "slash-code-review", text: "/code-review",
                               kind: .agentCommand(Self.review, imagePath: "/v0/agents/a/slash-commands/code-review/image")),
        ])
    }

    func testASentDraftIsACommandWithItsArgumentsAsTyped() {
        XCTAssertEqual(SlashCommands.invocation("/compact", in: Self.catalog).map { [$0.command.name, $0.arguments ?? "-"] }, ["compact", "-"])
        XCTAssertEqual(SlashCommands.invocation("/code-review focus on auth", in: Self.catalog).map { [$0.command.name, $0.arguments ?? "-"] },
                       ["code-review", "focus on auth"])
        XCTAssertEqual(SlashCommands.invocation("/code-review\n  two lines\nkept", in: Self.catalog)?.arguments, "  two lines\nkept")
        XCTAssertEqual(SlashCommands.invocation("/code-review   ", in: Self.catalog).map { [$0.command.name, $0.arguments ?? "-"] }, ["code-review", "-"])
        XCTAssertNil(SlashCommands.invocation("/compact now", in: Self.catalog), "words after a command that takes none make it a message")
        XCTAssertNil(SlashCommands.invocation("/comp", in: Self.catalog), "only a whole name")
        XCTAssertNil(SlashCommands.invocation("/unknown thing", in: Self.catalog))
        XCTAssertNil(SlashCommands.invocation("please /compact", in: Self.catalog))
    }

    func testAPickWaitsForArgumentsOrRuns() {
        XCTAssertEqual(SlashCommands.pick(Self.review), .fill("/code-review "))
        XCTAssertEqual(SlashCommands.pick(Self.deploy), .fill("/deploy "))
        XCTAssertEqual(SlashCommands.pick(Self.compact), .run)
    }

    func testASkillIsItsTextWithAReadSkillRequest() {
        let bare = SlashCommands.skillMessage(Self.review, arguments: nil)
        XCTAssertEqual(bare.text, "/code-review")
        XCTAssertEqual(bare.toolRequest, AgentWire.ToolCallRequest(name: "read_skill", arguments: ["name": "code-review"]))
        XCTAssertEqual(SlashCommands.skillMessage(Self.review, arguments: "focus on auth").text, "/code-review focus on auth")
    }

    // MARK: Running one

    private static let mode = AgentWire.Mode(providerId: "codex", modelId: "openai/gpt-5.6-sol", effort: "medium", serviceTier: nil, permissionMode: "auto")

    func testInvokingSendsTheModeAndMutationAndTakesTheNewCatalog() async throws {
        let server = SlashServer(catalog: [Self.compact, Self.deploy], invoke: .accept(catalog: [Self.compact]))
        let client = AgentClient(transport: server, token: "t")
        let catalog = try await client.invokeSlashCommand("a", name: "deploy", arguments: "to staging", mode: Self.mode, mutationId: "m1")
        XCTAssertEqual(catalog, [Self.compact])
        let invoked = await server.invocations
        let request = try XCTUnwrap(invoked.first)
        XCTAssertEqual(request.path, "/v0/agents/a/slash-commands/deploy")
        XCTAssertEqual(request.body, .object([
            "arguments": .string("to staging"),
            "mutationId": .string("m1"),
            "mode": .object(["providerId": .string("codex"), "modelId": .string("openai/gpt-5.6-sol"), "effort": .string("medium"),
                             "serviceTier": .null, "permissionMode": .string("auto")]),
        ]))
        _ = try await client.invokeSlashCommand("a", name: "compact", arguments: nil, mode: Self.mode, mutationId: "m2")
        let again = await server.invocations
        XCTAssertNil(again.last?.body["arguments"], "no arguments, no field")
    }

    func testAConversationRunsACommandUnderItsMode() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .accept(catalog: Self.catalog))
        let (conversation, updates) = try await open(server)
        let outcome = await conversation.run(Self.compact, arguments: "ignored")
        XCTAssertEqual(outcome, .accepted)
        let invoked = await server.invocations
        let request = try XCTUnwrap(invoked.first)
        XCTAssertEqual(request.path, "/v0/agents/a/slash-commands/compact")
        XCTAssertNil(request.body["arguments"], "a command that takes none is sent none")
        XCTAssertEqual(request.body["mode"]?["modelId"]?.stringValue, "openai/gpt-5.6-sol")
        XCTAssertNotNil(request.body["mutationId"]?.stringValue)
        let sends = await server.sends
        XCTAssertEqual(sends.count, 0, "the command is never sent as a message")
        _ = updates
        await conversation.stop()
    }

    func testAnUnknownCommandLeavesThePalette() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .status(404))
        let (conversation, updates) = try await open(server)
        let outcome = await conversation.run(Self.deploy, arguments: nil)
        XCTAssertEqual(outcome, .unavailable)
        let after = await updates.next { $0.slashCommands.count == 2 }
        XCTAssertEqual(after?.slashCommands.map(\.name), ["compact", "code-review"])
        await conversation.stop()
    }

    func testABusyAgentRefusesAndTheCatalogStays() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .status(409))
        let (conversation, _) = try await open(server)
        let outcome = await conversation.run(Self.compact, arguments: nil)
        XCTAssertEqual(outcome, .busy)
        await conversation.stop()
    }

    func testOtherFailuresSayWhetherTheComputerAnswered() async throws {
        for (status, expected) in [(400, SlashCommandOutcome.refused), (500, .unreachable), (503, .unreachable), (429, .unreachable)] {
            let server = SlashServer(catalog: Self.catalog, invoke: .status(status))
            let (conversation, _) = try await open(server)
            let outcome = await conversation.run(Self.compact, arguments: nil)
            XCTAssertEqual(outcome, expected, "\(status)")
            await conversation.stop()
        }
    }

    func testASkillGoesAsAMessageCarryingItsReadSkillRequest() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .status(500))
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a", persistence: engine)
        let updates = Updates(conversation.updates)
        await conversation.start()
        _ = await updates.next { $0.loaded && $0.mode != nil }
        let outcome = await conversation.run(Self.review, arguments: "focus on auth")
        XCTAssertEqual(outcome, .accepted)
        let drawn = await updates.next { $0.items.contains { $0.role == .user && $0.text == "/code-review focus on auth" } }
        XCTAssertNotNil(drawn, "the person's command shows in the transcript at once")
        // Kept in the account's outbox like any message, its request with it.
        let queued = try await engine.queuedMessages(for: "a")
        XCTAssertEqual(queued.map(\.text), ["/code-review focus on auth"])
        XCTAssertEqual(queued.first?.toolRequest, .readSkill("code-review"))
        let invoked = await server.invocations
        XCTAssertEqual(invoked.count, 0, "a skill is not asked of the command route")
        await conversation.stop()

        // What the outbox's delivery sends.
        try await client.deliverMessage(try XCTUnwrap(queued.first)) { _ in }
        let sends = await server.sends
        let body = try XCTUnwrap(sends.first)
        XCTAssertEqual(body["text"]?.stringValue, "/code-review focus on auth")
        XCTAssertEqual(body["content"], .array([
            .object(["type": .string("tool_call_request"), "name": .string("read_skill"), "arguments": .object(["name": .string("code-review")])]),
        ]))
        XCTAssertEqual(body["mode"]?["providerId"]?.stringValue, "codex")
        await engine.stop()
    }

    func testAQueuedSkillKeepsItsRequestThroughTheOutbox() throws {
        let queued = QueuedMessage(id: "m", agentID: "a", text: "/code-review", pictures: [], mode: Self.mode, toolRequest: .readSkill("code-review"))
        let kept = try JSONDecoder().decode(QueuedMessage.self, from: JSONEncoder().encode(queued))
        XCTAssertEqual(kept.toolRequest, .readSkill("code-review"))
        let older = #"{"id":"m","agentID":"a","text":"hi","pictures":[]}"#
        XCTAssertNil(try JSONDecoder().decode(QueuedMessage.self, from: Data(older.utf8)).toolRequest, "a row kept before it decodes")
    }

    // MARK: New work's skills

    private static func skill(_ name: String, description: String = "Does it.", enabled: Bool = true, status: String = "ready") -> JSONValue {
        .object(["id": .string("s-\(name)"), "path": .string(name), "name": .string(name), "description": .string(description),
                 "enabled": .bool(enabled), "status": .string(status), "error": .null])
    }

    private static func skillPage(_ skills: [JSONValue], next: String?) -> (Int, JSONValue) {
        (200, .object(["skills": .array(skills), "nextPageCursor": next.map(JSONValue.string) ?? .null, "cursor": .string("e")]))
    }

    func testNewWorkOffersOnlyEnabledReadySkillsOnceEach() {
        let offered = SlashCommands.globalSkills([
            Self.skill("code-review", description: "Review the current changes."),
            Self.skill("off", enabled: false),
            Self.skill("broken", description: "", status: "invalid"),
            Self.skill("gone", status: "unreadable"),
            Self.skill("code-review", description: "A second install of the same name."),
            .object(["name": .string("half")]),
        ])
        XCTAssertEqual(offered, [AgentWire.SlashCommand(name: "code-review", hasArguments: true, description: "Review the current changes.", kind: "skill")])
    }

    func testTheSkillCatalogIsReadPageByPageAndAgainWhenAPageGoesStale() async throws {
        let server = SlashServer(catalog: [], invoke: .status(500), skills: [
            Self.skillPage([Self.skill("a")], next: "p 2"),
            (409, .object(["error": .string("stale"), "code": .string("conflict")])),
            Self.skillPage([Self.skill("a"), Self.skill("b", enabled: false)], next: "p2"),
            Self.skillPage([Self.skill("c")], next: nil),
        ])
        let skills = try await AgentClient(transport: server, token: "t").globalSkills()
        XCTAssertEqual(skills?.map(\.name), ["a", "c"])
        let reads = await server.skillReads
        XCTAssertEqual(reads, ["/v0/skills?limit=100", "/v0/skills?limit=100&pageCursor=p%202", "/v0/skills?limit=100", "/v0/skills?limit=100&pageCursor=p2"])
    }

    func testAComputerWithoutSkillsOffersNoneAndSaysNothing() async throws {
        for status in [404, 501] {
            let server = SlashServer(catalog: [], invoke: .status(500), skills: [(status, .object(["error": .string("no")]))])
            let skills = try await AgentClient(transport: server, token: "t").globalSkills()
            XCTAssertNil(skills, "\(status)")
        }
    }

    func testNewWorksFirstSkillGoesAsASkillMessageOnceTheTaskIsMade() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .status(500))
        let (conversation, updates) = await openNewWork(server)
        let accepted = await conversation.sendFirstSkill(Self.review, arguments: "focus on auth")
        XCTAssertTrue(accepted)
        let drawn = await updates.next { $0.items.contains { $0.role == .user && $0.text == "/code-review focus on auth" } }
        XCTAssertNotNil(drawn, "drawn at once, as any first message")
        let sends = try await sent(server)
        XCTAssertEqual(sends.map { $0["text"]?.stringValue }, ["/code-review focus on auth"])
        XCTAssertEqual(sends.first?["content"], .array([
            .object(["type": .string("tool_call_request"), "name": .string("read_skill"), "arguments": .object(["name": .string("code-review")])]),
        ]), "as a skill goes in any chat")
        XCTAssertEqual(sends.first?["mode"]?["permissionMode"]?.stringValue, "auto", "under the composer's mode")
        let made = await server.created
        XCTAssertEqual(made.count, 1, "the task is made as a first message makes it")
        let invoked = await server.invocations
        XCTAssertEqual(invoked.count, 0, "not asked of the command route")
        await conversation.stop()
    }

    func testNewWorksSkillGoesAsTheDraftWhenTheNewAgentLacksIt() async throws {
        let server = SlashServer(catalog: [Self.compact, Self.deploy], invoke: .status(500))
        let (conversation, _) = await openNewWork(server)
        let accepted = await conversation.sendFirstSkill(Self.review, arguments: "focus\non auth")
        XCTAssertTrue(accepted)
        let sends = try await sent(server)
        XCTAssertEqual(sends.map { $0["text"]?.stringValue }, ["/code-review focus\non auth"], "the draft as typed")
        XCTAssertNil(sends.first?["content"], "an ordinary message, with no read_skill request")
        await conversation.stop()
    }

    private func openNewWork(_ server: SlashServer) async -> (Conversation, Updates) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let task = NewTask(client: client)
        let conversation = Conversation(client: client, store: engine.spaces, agentId: task.agentId, newTask: task, mode: Self.mode)
        let updates = Updates(conversation.updates)
        await conversation.start()
        return (conversation, updates)
    }

    /// What reached `/send`, once something has.
    private func sent(_ server: SlashServer) async throws -> [JSONValue] {
        for _ in 0..<300 {
            let sends = await server.sends
            if !sends.isEmpty { return sends }
            try await Task.sleep(for: .milliseconds(10))
        }
        return []
    }

    // MARK: The catalog over time

    func testTheCatalogIsReplacedWholeByItsEventAndOnlyThisAgents() async throws {
        let server = SlashServer(catalog: Self.catalog, invoke: .status(500))
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = Updates(conversation.updates)
        await conversation.start()
        let opened = await updates.next { $0.loaded && !$0.slashCommands.isEmpty }
        XCTAssertEqual(opened?.slashCommands, Self.catalog)
        func replaced(_ agentId: String, _ commands: [AgentWire.SlashCommand]) throws -> JSONValue {
            .object(["type": .string("agent.slash_commands.updated"), "payload": .object([
                "agentId": .string(agentId), "slashCommands": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(commands)),
            ])])
        }
        await engine.spaces.externalEvent(try replaced("other", []))
        await engine.spaces.externalEvent(try replaced("a", [Self.deploy]))
        let after = await updates.next { $0.slashCommands != Self.catalog }
        XCTAssertEqual(after?.slashCommands, [Self.deploy], "another agent's catalog is not this one's")
        await conversation.stop()
    }

    func testTheCatalogIsKeptForWhenTheComputerIsAway() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let server = SlashServer(catalog: Self.catalog, invoke: .status(500))
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: directory)
        let first = Conversation(client: client, store: engine.spaces, agentId: "a", persistence: engine)
        let firstUpdates = Updates(first.updates)
        await first.start()
        _ = await firstUpdates.next { $0.loaded && !$0.slashCommands.isEmpty }
        await first.stop()
        await engine.stop()

        let away = AgentClient(transport: SlashServer(catalog: [], invoke: .status(500), offline: true), token: "t")
        let reopened = SyncEngine(client: away, directory: directory)
        let second = Conversation(client: away, store: reopened.spaces, agentId: "a", persistence: reopened)
        let secondUpdates = Updates(second.updates)
        await second.start()
        let kept = await secondUpdates.next { $0.loaded }
        XCTAssertEqual(kept?.slashCommands, Self.catalog)
        await second.stop()
        await reopened.stop()
    }

    // MARK: What a command shows

    /// `/compact`'s maintenance run: its compaction is a step of the run, as
    /// desktop's projection makes it a `compact` call, and the run is not
    /// folded away behind a trace of itself.
    func testACompactionShowsAsAStepOfItsRun() async throws {
        let compaction: JSONValue = .object([
            "type": .string("compaction"), "trigger": .string("manual"), "status": .string("completed"),
            "tokensBefore": .number(201_000), "tokensAfter": .number(43_000), "failureReason": .null, "startedAt": .number(1_000), "completedAt": .number(2_200),
        ])
        let run: JSONValue = .object([
            "id": .string("c"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_200), "reason": .string("compaction"),
            "messages": .array([.object(["id": .string("c"), "role": .string("service"), "createdAt": .number(1_000), "metadata": .object([:]), "content": .array([compaction])])]),
        ])
        let server = SlashServer(catalog: Self.catalog, invoke: .status(500), runs: [run])
        let (conversation, shown) = try await openSnapshot(server)
        XCTAssertEqual(shown?.items.map(\.id), ["c", "c:status"])
        XCTAssertEqual(shown?.items.first?.role, .tool(.init(name: "compact", status: "completed",
                                                              presentation: AgentWire.Presentation(type: "compaction", tokensBefore: 201_000, tokensAfter: 43_000))))
        XCTAssertEqual(TurnFold.fold(shown?.items ?? [], expanded: []).map(\.id), ["c", "c:status"])
        await conversation.stop()
    }

    // MARK: Helpers

    private func openSnapshot(_ server: SlashServer) async throws -> (Conversation, ChatSnapshot?) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = Updates(conversation.updates)
        await conversation.start()
        return (conversation, await updates.next { $0.loaded && $0.mode != nil })
    }

    private func open(_ server: SlashServer) async throws -> (Conversation, Updates) {
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        let updates = Updates(conversation.updates)
        await conversation.start()
        let opened = await updates.next { $0.loaded && $0.mode != nil }
        XCTAssertNotNil(opened)
        return (conversation, updates)
    }
}

/// A conversation's snapshots, read until one passes.
final class Updates: @unchecked Sendable {
    private var iterator: AsyncStream<ChatSnapshot>.Iterator

    init(_ stream: AsyncStream<ChatSnapshot>) { iterator = stream.makeAsyncIterator() }

    func next(_ check: (ChatSnapshot) -> Bool) async -> ChatSnapshot? {
        while let snapshot = await iterator.next() {
            if check(snapshot) { return snapshot }
        }
        return nil
    }
}

/// A computer with one idle agent, `a`, offering `catalog`; its command
/// route answers as `invoke` says, and every send and invocation is kept.
actor SlashServer: AgentTransport {
    enum Invoke { case accept(catalog: [AgentWire.SlashCommand]), status(Int) }

    private let catalog: [AgentWire.SlashCommand]
    private let invoke: Invoke
    private let offline: Bool
    private let runs: [JSONValue]
    /// `GET /v0/skills`'s answers, in order.
    private var skills: [(Int, JSONValue)]
    private(set) var invocations: [(path: String, body: JSONValue)] = []
    private(set) var sends: [JSONValue] = []
    private(set) var skillReads: [String] = []
    private(set) var created: [JSONValue] = []

    init(catalog: [AgentWire.SlashCommand], invoke: Invoke, offline: Bool = false, runs: [JSONValue] = [], skills: [(Int, JSONValue)] = []) {
        self.catalog = catalog
        self.invoke = invoke
        self.offline = offline
        self.runs = runs
        self.skills = skills
    }

    private static func json<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        if offline { throw URLError(.notConnectedToInternet) }
        let sent = body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) } ?? .null
        let value: JSONValue
        if path.hasPrefix("/v0/skills") {
            skillReads.append(path)
            let (status, answer) = skills.isEmpty ? (404, JSONValue.object([:])) : skills.removeFirst()
            return .init(status: status, body: try JSONEncoder().encode(answer))
        } else if path == "/v0/tasks", method == "POST" {
            created.append(sent)
            return .init(status: 201, body: try JSONEncoder().encode(JSONValue.object([
                "task": .object(["id": sent["id"] ?? .null, "agent": .object(["id": sent["agentId"] ?? .null])]), "membership": .object([:]),
            ])))
        } else if path.contains("/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(runs)])
        } else if path.hasSuffix("/bootstrap") {
            value = .object([
                "agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]),
                "pending": .array([]),
                "mode": .object(["providerId": .string("codex"), "modelId": .string("openai/gpt-5.6-sol"), "effort": .string("medium"),
                                 "serviceTier": .null, "permissionMode": .string("auto")]),
                "slashCommands": try Self.json(catalog),
            ])
        } else if path.contains("/slash-commands/"), method == "POST" {
            invocations.append((path, sent))
            switch invoke {
            case .accept(let catalog):
                return .init(status: 202, body: try JSONEncoder().encode(JSONValue.object([
                    "agent": .object(["id": .string("a")]), "profiles": .array([]), "slashCommands": try Self.json(catalog), "cursor": .string("c"),
                ])))
            case .status(let status):
                return .init(status: status, body: Data(#"{"error":"no","code":"no"}"#.utf8))
            }
        } else if path.hasSuffix("/send"), method == "POST" {
            sends.append(sent)
            value = .object([:])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}
