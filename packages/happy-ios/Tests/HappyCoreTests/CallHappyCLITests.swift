import Foundation
@testable import HappyCore
import HappyStore
import HappyWire
import XCTest

/// A call over a Happy account's sessions (`CallAccount.happyCLI`): the
/// relay's records read as the call's directory and conversations, where
/// its new work starts, and what the call refuses there and why.
final class CallHappyCLITests: XCTestCase {
    private typealias Fixtures = LegacyHomeFixtures
    private static let now = Fixtures.now
    private static let minute = Fixtures.minute

    private static func session(_ id: String, at: Int64, path: String? = "/work/happy", title: String? = nil,
                                metadata: [String: JSONValue] = [:], active: Bool = true, thinking: Bool = false,
                                agentState: JSONValue? = nil) -> SessionRecord {
        Fixtures.session(id, machine: "m1", path: path, active: active, at: at, title: title, metadata: metadata,
                         agentState: agentState, thinking: thinking)
    }

    private static let rig: [String: JSONValue] = ["client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1)]

    // MARK: The directory

    /// Bots and tasks first, then each project under its heading, its own
    /// checkout before its worktrees; the newest created first, never by
    /// activity. Stopped Happy CLI sessions, side chats and retired tasks
    /// are left out; a stopped Happy Agent session stays.
    func testTheDirectoryIsStableAndGroupedByProject() {
        let bot: [String: JSONValue] = ["bot": .object(["id": .string("b"), "name": .string("Helper")])]
        let task: [String: JSONValue] = ["task": .object(["id": .string("t"), "name": .string("Release notes")])]
        let sessions = [
            // The oldest, though it spoke last.
            Self.session("old", at: Self.now - 30 * Self.minute, title: "Old", metadata: ["lastMeaningfulMessageAt": .number(Double(Self.now))]),
            Self.session("tree", at: Self.now - 20 * Self.minute, path: Fixtures.worktreePath, title: "Worktree"),
            Self.session("new", at: Self.now - 10 * Self.minute, title: "New"),
            Self.session("alpha", at: Self.now - 5 * Self.minute, path: "/work/alpha", title: "Alpha"),
            Self.session("bot", at: Self.now - 40 * Self.minute, metadata: bot),
            Self.session("task", at: Self.now - 50 * Self.minute, metadata: task),
            Self.session("stopped", at: Self.now - Self.minute, title: "Stopped", active: false),
            Self.session("agent", at: Self.now - 2 * Self.minute, title: "", metadata: Self.rig, active: false),
            Self.session("side", at: Self.now - 3 * Self.minute, metadata: ["isSideChat": .bool(true)]),
            Self.session("retired", at: Self.now - 4 * Self.minute, metadata: task.merging(["lifecycleState": .string("archived")]) { $1 }),
        ]
        let directory = CallTarget.legacyDirectory(sessions)
        XCTAssertEqual(directory.map(\.agentId), ["bot", "task", "agent", "new", "old", "tree", "alpha"])
        XCTAssertEqual(directory.map(\.kind), [.bot, .task, .conversation, .conversation, .conversation, .conversation, .conversation])
        XCTAssertEqual(directory[0].title, "Helper")
        XCTAssertEqual(directory[1].title, "Release notes")
        XCTAssertEqual(directory[2].title, CallTarget.unnamedSession)
        XCTAssertEqual(directory[3].parents.map(\.kind), ["project"])
        XCTAssertEqual(directory[5].parents.map(\.kind), ["project", "workspace"])
        XCTAssertEqual(directory[5].parents.first?.id, directory[3].parents.first?.id, "a worktree sits under its project")
        XCTAssertNotEqual(directory[6].parents.first?.id, directory[3].parents.first?.id)
    }

    func testStatusIsTheSessionsOwn() {
        let asking: JSONValue = .object(["requests": .object(["r1": .object(["tool": .string("Bash")])])])
        XCTAssertEqual(CallTarget.legacy(Self.session("a", at: Self.now, thinking: true)).status, .running)
        XCTAssertEqual(CallTarget.legacy(Self.session("a", at: Self.now, thinking: true, agentState: asking)).status, .needsInput)
        XCTAssertEqual(CallTarget.legacy(Self.session("a", at: Self.now)).status, .idle)
        XCTAssertEqual(CallTarget.legacy(Self.session("a", at: Self.now, active: false, thinking: true)).status, .idle)
    }

    // MARK: A conversation

    private func state(_ messages: [ChatMessage], session: SessionRecord? = nil, delivery: [String: OutboxDelivery] = [:],
                       modes: ComposerModes? = nil) -> CallTargetState {
        let session = session ?? Self.session("s", at: Self.now, title: "Fix")
        let chat = LegacyChatSnapshot(sessionId: session.id, messages: messages, delivery: delivery, isLoaded: true)
        return CallTargetState.legacy(chat, session: session, target: CallTarget.legacy(session), modes: modes)
    }

    /// Each of the person's messages opens an exchange; its answer is the
    /// agent's last words; thinking and tools aren't words.
    func testExchangesAnswerWithTheLastWords() {
        let read = state([
            .userText(.init(id: "u1", createdAt: 1, text: "Fix the build")),
            .agentText(.init(id: "t1", createdAt: 2, text: "planning", isThinking: true)),
            .agentText(.init(id: "a1", createdAt: 3, text: "Looking")),
            .toolCall(.init(id: "tool", createdAt: 4, tool: .init(name: "Bash", state: .completed, input: .object([:]), createdAt: 4))),
            .agentText(.init(id: "a2", createdAt: 5, text: "Fixed it")),
            .userText(.init(id: "u2", createdAt: 6, text: "Thanks", author: SessionAuthor(id: "p2", name: "Ada"))),
            .agentText(.init(id: "a3", createdAt: 7, text: "Any time")),
        ])
        XCTAssertEqual(read.turns.map(\.user), ["Fix the build", "Thanks"])
        XCTAssertEqual(read.turns.map(\.reply), ["Fixed it", "Any time"])
        XCTAssertEqual(read.turns.map(\.ended), ["completed", "completed"])
        XCTAssertEqual(read.turns[1].userBy, "Ada")
        XCTAssertEqual(read.messages.map(\.id), ["u1", "a1", "a2", "u2", "a3"])
        XCTAssertNil(read.unanswered)
        XCTAssertTrue(read.writable)
        XCTAssertFalse(read.working)
    }

    /// Happy Agent's failed run ends its exchange in an error: the relay's
    /// turn end never reaches the chat, its service words do.
    func testAFailedRunEndsInAnError() {
        let read = state([
            .userText(.init(id: "u1", createdAt: 1, text: "Deploy")),
            .agentText(.init(id: "e1:failure", createdAt: 2, text: "The run failed: provider unavailable")),
        ], session: Self.session("s", at: Self.now, metadata: Self.rig))
        XCTAssertEqual(read.turns.first?.ended, "error")
        XCTAssertEqual(read.turns.first?.error, "provider unavailable")
        XCTAssertNil(read.turns.first?.reply)
        XCTAssertFalse(read.messages.contains { $0.role == .assistant }, "the failure isn't the agent's words")
    }

    /// While it works the newest exchange is open and its last words may go on.
    func testWhileItWorksTheNewestIsUnanswered() {
        let read = state([
            .userText(.init(id: "u1", createdAt: 1, text: "Write the notes")),
            .agentText(.init(id: "a1", createdAt: 2, text: "Drafting")),
        ], session: Self.session("s", at: Self.now, thinking: true))
        XCTAssertTrue(read.working)
        XCTAssertEqual(read.unanswered?.id, "u1")
        XCTAssertTrue(read.turns.isEmpty)
        XCTAssertEqual(read.messages.last?.final, false)

        let waiting = state([.userText(.init(id: "u1", localId: "l1", createdAt: 1, text: "Hello"))], delivery: ["l1": .queued])
        XCTAssertEqual(waiting.unanswered?.id, "u1", "nothing of the agent's came after it")
        XCTAssertEqual(waiting.unanswered?.delivery, .queued)
    }

    /// A stopped session reads, and takes no message.
    func testAStoppedSessionReadsButTakesNothing() {
        let stopped = state([.userText(.init(id: "u1", createdAt: 1, text: "Hi"))], session: Self.session("s", at: Self.now, active: false))
        XCTAssertFalse(stopped.writable)
        let agent = state([], session: Self.session("s", at: Self.now, metadata: Self.rig, active: false))
        XCTAssertFalse(agent.writable, "a Happy Agent session offline takes nothing either")
    }

    /// The composer's chips are what a message may switch to; a computer
    /// that locks the model says so.
    func testModelsAreTheComposersAndALockSaysSo() throws {
        let metadata = Self.rig.merging(["capabilities": .object(["modelSelection": .bool(false)])]) { $1 }
        let session = Self.session("s", at: Self.now, metadata: metadata)
        let opus = ModeOption(key: "claude:opus", name: "Opus")
        let off = ModeOption(key: "claude:old", name: "Old", isDisabled: true)
        let modes = ComposerModes(availableModes: [], permissionMode: nil, availableModels: [opus, off], modelMode: opus,
                                  availableEffortLevels: [], effortLevel: ModeOption(key: "high", name: "High"))
        let read = state([], session: session, modes: modes)
        XCTAssertEqual(read.models.map(\.id), ["claude:opus"])
        XCTAssertEqual(read.mode, CallMode(modelId: "claude:opus", model: "Opus", effort: "high"))
        XCTAssertTrue(read.modelLocked)
        XCTAssertFalse(read.effortLocked)
    }

    // MARK: New work

    private static func machine(_ id: String, active: Bool = true, tasks: Bool = true, bots: Bool = true, created: Int64 = now) -> MachineRecord {
        var machine = Fixtures.machine(id, active: active, name: id)
        machine.createdAt = created
        machine.metadata = .object([
            "displayName": .string(id), "machineKind": .string("rig"), "rigOnly": .bool(true),
            "capabilities": .object(["newSession": .bool(true), "tasks": .bool(tasks), "bots": .bool(bots)]),
        ])
        return machine
    }

    func testNewWorkStartsOnTheOnlyComputerOrComposesPick() {
        XCTAssertEqual(LegacyNewWork.machine(for: .task, machines: [Self.machine("m1")], picked: nil), .success("m1"))
        let two = [Self.machine("m1"), Self.machine("m2", created: Self.now - 1)]
        XCTAssertEqual(LegacyNewWork.machine(for: .task, machines: two, picked: nil),
                       .failure(.init(reason: CallContext.HappyCLI.severalComputers)))
        XCTAssertEqual(LegacyNewWork.machine(for: .task, machines: two, picked: "m2"), .success("m2"))
        // One offline, one that makes no bots: what's left is the only one.
        XCTAssertEqual(LegacyNewWork.machine(for: .bot, machines: [Self.machine("m1", bots: false), Self.machine("m2", active: false)], picked: "m2"),
                       .failure(.init(reason: CallContext.HappyCLI.noNewWork)))
        XCTAssertEqual(LegacyNewWork.machine(for: .bot, machines: [Self.machine("m1", bots: false), Self.machine("m2")], picked: nil), .success("m2"))
        XCTAssertEqual(LegacyNewWork.machine(for: nil, machines: [], picked: nil), .failure(.init(reason: CallContext.HappyCLI.noNewWork)))
    }

    // MARK: The call

    private func tool(_ context: CallContext, _ name: String, _ json: String) async -> CallToolResult {
        await context.handle(CallToolCall(id: UUID().uuidString, name: name, parameters: Data(json.utf8)))
    }

    private static let fix = CallTarget(agentId: "s1", title: "Fix", kind: .conversation, status: .idle)

    private func targets(refusal: String? = nil, refusals: [CallTarget.Kind: String] = [:], state: CallTargetState? = nil) -> HappyCLITargets {
        let inner = FakeCallTargets(directory: [Self.fix], states: ["s1": state ?? CallTargetState(target: Self.fix)], focus: nil)
        return HappyCLITargets(inner, refusal: refusal, refusals: refusals)
    }

    func testTheFirstContextSaysWhetherNewWorkStarts() async {
        let able = await CallContext(targets: targets()).initial()
        XCTAssertTrue(able.contains("new-bot:<name> — a new bot, named"), able)
        let unable = await CallContext(targets: targets(refusal: CallContext.HappyCLI.noNewWork)).initial()
        XCTAssertTrue(unable.contains(CallContext.HappyCLI.noNewWorkText), unable)
        XCTAssertFalse(unable.contains("new-task —"), unable)
        // A computer that makes only tasks and another only bots: each kind still starts.
        let split = targets(refusals: [.task: CallContext.HappyCLI.noNewWork, .bot: CallContext.HappyCLI.noNewWork])
        let none = await CallContext(targets: split).initial()
        XCTAssertTrue(none.contains(CallContext.HappyCLI.noNewWorkText), none)
        let tasksOnly = await CallContext(targets: targets(refusals: [.bot: CallContext.HappyCLI.noNewWork])).initial()
        XCTAssertTrue(tasksOnly.contains("new-task —"), tasksOnly)
        let botsOnly = await CallContext(targets: targets(refusals: [.task: CallContext.HappyCLI.noNewWork])).initial()
        XCTAssertTrue(botsOnly.contains("new-task —"), botsOnly)
    }

    func testNewWorkIsRefusedWithTheReason() async {
        let unnamed = targets()
        let context = CallContext(targets: unnamed)
        _ = await context.initial()
        let bot = await tool(context, "message", #"{"to":"new-bot","text":"hello"}"#)
        XCTAssertTrue(bot.isError)
        XCTAssertTrue(bot.text.contains(CallContext.HappyCLI.botNeedsName), bot.text)
        let made = await unnamed.inner.made
        XCTAssertTrue(made.isEmpty, "nothing drafted for a refusal")

        let several = targets(refusal: CallContext.HappyCLI.severalComputers)
        let other = CallContext(targets: several)
        _ = await other.initial()
        let task = await tool(other, "message", #"{"to":"new-task","text":"go"}"#)
        XCTAssertTrue(task.text.contains(CallContext.HappyCLI.severalComputers), task.text)
        let sends = await several.inner.sends
        XCTAssertTrue(sends.isEmpty)

        let named = targets()
        let started = CallContext(targets: named)
        _ = await started.initial()
        let ok = await tool(started, "message", #"{"to":"new-bot:Scout","text":"hello"}"#)
        XCTAssertFalse(ok.isError, ok.text)
        let asked = await named.asked
        XCTAssertEqual(asked, [.task, .bot, .bot], "each kind for the first context, then the bot asked for")
    }

    func testALockedModelIsRefusedAndNothingGoes() async {
        var locked = CallTargetState(target: Self.fix, models: [CallModel(id: "claude:opus", name: "Opus", efforts: ["high"])])
        locked.modelLocked = true
        let targets = targets(state: locked)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let refused = await tool(context, "message", #"{"to":"s1","text":"go","model":"opus"}"#)
        XCTAssertTrue(refused.isError)
        let reason = (try? JSONSerialization.jsonObject(with: Data(refused.text.utf8)) as? [String: Any])?["reason"] as? String
        XCTAssertEqual(reason, CallContext.HappyCLI.locked + " Nothing was sent.")
        let plain = await tool(context, "message", #"{"to":"s1","text":"go"}"#)
        XCTAssertFalse(plain.isError, plain.text)
        let sends = await targets.inner.sends
        XCTAssertEqual(sends.map(\.text), ["go"])
    }

    // MARK: History

    func testAHappyAccountsHistoryIsAFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("call-history-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = FileCallHistoryStore(url: url)
        XCTAssertNil(store.read())
        store.write(Data("[1]".utf8))
        XCTAssertEqual(store.read(), Data("[1]".utf8), "read after the writes already asked for")
        XCTAssertEqual(FileCallHistoryStore(url: url).read(), Data("[1]".utf8))
    }
}

/// `FakeCallTargets` as a Happy account's: what new work it refuses.
private actor HappyCLITargets: CallTargets {
    let inner: FakeCallTargets
    private let refusal: String?
    private let refusals: [CallTarget.Kind: String]
    private(set) var asked: [CallTarget.Kind?] = []

    init(_ inner: FakeCallTargets, refusal: String?, refusals: [CallTarget.Kind: String] = [:]) {
        self.inner = inner
        self.refusal = refusal
        self.refusals = refusals
    }

    nonisolated var account: CallAccount { .happyCLI }
    func newWorkRefusal(_ kind: CallTarget.Kind?) async -> String? {
        if kind != nil { asked.append(kind) }
        return kind.flatMap { refusals[$0] } ?? refusal
    }
    func directory() async -> [CallTarget] { await inner.directory() }
    func state(of agentId: String) async -> CallTargetState? { await inner.state(of: agentId) }
    func refreshed(_ agentId: String, within limit: Duration) async -> CallTargetState? { await inner.refreshed(agentId, within: limit) }
    func focused() async -> String? { await inner.focused() }
    func open(_ agentId: String) async -> Bool { await inner.open(agentId) }
    func send(_ agentId: String, text: String, id: String, change: CallModeChange?) async -> CallSendOutcome {
        await inner.send(agentId, text: text, id: id, change: change)
    }
    func follow(_ agentId: String, _ following: Bool) async { await inner.follow(agentId, following) }
    func draft(_ kind: CallTarget.Kind, name: String) async -> CallTarget? { await inner.draft(kind, name: name) }
    func discard(_ agentId: String) async { await inner.discard(agentId) }
    func unlisted(_ agentId: String) async -> CallTarget? { await inner.unlisted(agentId) }
    func back() async -> CallScreenMove { await inner.back() }
    func home() async -> CallScreenMove { await inner.home() }
}
