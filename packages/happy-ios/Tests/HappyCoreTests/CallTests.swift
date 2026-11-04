import Foundation
import XCTest
@testable import HappyCore

/// The agent connection's voice call: its context, its four tools and its
/// life, with the provider faked. Nothing here opens a microphone.
final class CallContextTests: XCTestCase {
    private func waitFor(_ condition: () async -> Bool) async {
        for _ in 0..<500 { if await condition() { return }; try? await Task.sleep(for: .milliseconds(2)) }
    }

    private let backendTarget = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)
    private let docsTarget = CallTarget(agentId: "b", title: "Docs", kind: .task, status: .running)

    /// Backend: three finished turns, one that failed, and a message no turn has answered yet.
    private func backend(focus: String? = "a") -> FakeCallTargets {
        let turns = [
            CallTurn(id: "r1", user: "first ask", reply: "first answer"),
            CallTurn(id: "r2", user: "second ask", reply: "second answer"),
            CallTurn(id: "r3", user: "steer", ended: "steering"),
            CallTurn(id: "r4", user: "third ask", reply: "third answer"),
        ]
        let messages = [
            CallMessage(id: "u1", role: .user, text: "first ask"), CallMessage(id: "x1", role: .assistant, text: "first answer"),
            CallMessage(id: "u2", role: .user, text: "second ask"), CallMessage(id: "x2", role: .assistant, text: "second answer"),
            CallMessage(id: "u4", role: .user, text: "third ask"), CallMessage(id: "x4", role: .assistant, text: "third answer"),
            CallMessage(id: "u5", role: .user, text: "still waiting", delivery: .accepted),
        ]
        return FakeCallTargets(directory: [backendTarget, docsTarget], states: [
            "a": CallTargetState(target: backendTarget, messages: messages, turns: turns, unanswered: messages.last, hasDraft: true),
            "b": CallTargetState(target: docsTarget, working: true),
        ], focus: focus)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    private func events(_ update: CallUpdate) throws -> [[String: Any]] {
        try update.context.map(object)
    }

    private func tool(_ context: CallContext, _ name: String, _ json: String, id: String = UUID().uuidString) async -> CallToolResult {
        await context.handle(CallToolCall(id: id, name: name, parameters: Data(json.utf8)))
    }

    // MARK: History

    func testTheFirstSnapshotHoldsTheFocusWithItsLastFiveTurnsThePendingMessageOneOfThem() async throws {
        let context = CallContext(targets: backend(), now: { 1_700_000_000 })
        let snapshot = try object(await context.initial())
        XCTAssertEqual(snapshot["schema"] as? Int, 2)
        XCTAssertEqual(snapshot["focusRevision"] as? Int, 0)
        XCTAssertEqual(snapshot["tools"] as? [String], ["listSessions", "getSessionContext", "openSession", "sendMessage"])
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        // Named as the directory names it, which alone gives its reference.
        XCTAssertEqual(focus["title"] as? String, "Backend")
        XCTAssertEqual(focus["parents"] as? [String], [])
        XCTAssertNil(focus["ref"])
        XCTAssertNil(focus["targetRef"])
        XCTAssertNil(focus["kind"])
        XCTAssertNil(focus["status"])
        XCTAssertNil(focus["hasDraft"])
        XCTAssertNil(focus["messages"])
        // Four finished turns and the message waiting: five. The steered one has the person's half only.
        let turns = try XCTUnwrap(focus["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.map { $0["user"] as? String }, ["first ask", "second ask", "steer", "third ask"])
        XCTAssertEqual(turns.map { $0["assistant"] as? String }, ["first answer", "second answer", nil, "third answer"])
        XCTAssertEqual(turns.map { $0["ended"] as? String }, ["completed", "completed", "steering", "completed"])
        XCTAssertEqual(focus["olderTurns"] as? Bool, false)
        let pending = try XCTUnwrap(focus["pendingUserMessage"] as? [String: Any])
        XCTAssertEqual(pending["text"] as? String, "still waiting")
        XCTAssertEqual(pending["delivery"] as? String, "accepted")
        XCTAssertEqual(snapshot["directory"] as? String, "Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]")
        let followed = await context.followed
        XCTAssertEqual(followed, ["a"])
    }

    func testTheSnapshotKeepsItsBudgets() async throws {
        let long = String(repeating: "é", count: 5000)
        let turns = (0..<10).map { CallTurn(id: "r\($0)", user: long, reply: long) }
        let many = (0..<300).map { CallTarget(agentId: "x\($0)", title: String(repeating: "n", count: 200), kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: [backendTarget] + many,
                                      states: ["a": CallTargetState(target: backendTarget, turns: turns, unanswered: CallMessage(id: "p", role: .user, text: long))], focus: "a")
        let text = await CallContext(targets: targets).initial()
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        let snapshot = try object(text)
        let directory = try XCTUnwrap(snapshot["directory"] as? String)
        XCTAssertTrue(directory.hasSuffix("more; listSessions finds them by title."), directory)
        XCTAssertLessThanOrEqual(directory.utf8.count, CallContext.Limits.directoryBytes)
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        let shown = try XCTUnwrap(focus["turns"] as? [[String: Any]])
        XCTAssertLessThanOrEqual(shown.count, CallContext.Limits.turns)
        for turn in shown {
            XCTAssertLessThanOrEqual((turn["assistant"] as? String)?.utf8.count ?? 0, CallContext.Limits.messageBytes)
            XCTAssertEqual(turn["truncated"] as? Bool, true)
        }
        XCTAssertEqual((focus["pendingUserMessage"] as? [String: Any])?["truncated"] as? Bool, true)
    }

    func testTruncationKeepsWholeCharacters() {
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 4), "aé")
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 7), "aé😀")
    }

    func testReadingAConversationGivesItsLastFiveTurnsAndChangesNothingHeard() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.map { $0["assistant"] as? String }, ["first answer", "second answer", nil, "third answer"])
        XCTAssertEqual((read["pendingUserMessage"] as? [String: Any])?["text"] as? String, "still waiting")
        XCTAssertEqual(read["working"] as? Bool, false)
        XCTAssertEqual(read["needsInput"] as? Bool, false)
        _ = await tool(context, "listSessions", "{}")
        let followed = await context.followed
        XCTAssertTrue(followed.isEmpty)
        // Not visited, so its new words say nothing.
        let quiet = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "n", role: .assistant, text: "new")]))
        XCTAssertTrue(quiet.isEmpty)
    }

    /// Five in all: five finished turns with nothing waiting, four with a
    /// message waiting; an answer with no message of the person's is half
    /// a pair; a read within 32 KB, oldest first to go.
    func testFiveTurnsInAllAndTheBudgetHolds() async throws {
        var turns = (1...7).map { CallTurn(id: "r\($0)", user: "ask \($0)", reply: "answer \($0)") }
        turns.append(CallTurn(id: "r8", reply: "done on its own"))
        let targets = FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        var read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.map { $0["assistant"] as? String }, ["answer 4", "answer 5", "answer 6", "answer 7", "done on its own"])
        XCTAssertNil((read["turns"] as? [[String: Any]])?.last?["user"])
        XCTAssertEqual(read["olderTurns"] as? Bool, true)
        let waiting = CallMessage(id: "p", role: .user, text: "and now?")
        await targets.set("a", CallTargetState(target: backendTarget, turns: turns, unanswered: waiting))
        read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.count, 4)
        XCTAssertEqual((read["pendingUserMessage"] as? [String: Any])?["text"] as? String, "and now?")
        let long = String(repeating: "é", count: 5000)
        await targets.set("a", CallTargetState(target: backendTarget, turns: (0..<6).map { CallTurn(id: "l\($0)", user: long, reply: long) }))
        let big = await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#)
        XCTAssertLessThanOrEqual(big.text.utf8.count, CallContext.Limits.totalBytes)
        let shown = try XCTUnwrap(try object(big.text)["turns"] as? [[String: Any]])
        XCTAssertLessThan(shown.count, 5)
        XCTAssertFalse(shown.isEmpty)
    }

    func testAFailedTurnIsReadWithItsReason() async throws {
        let turns = [CallTurn(id: "r1", user: "ask", reply: "fine"), CallTurn(id: "r2", user: "again", ended: "error", error: "Rate limited")]
        let context = CallContext(targets: FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: nil))
        _ = await context.initial()
        let read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        let shown = try XCTUnwrap(read["turns"] as? [[String: Any]])
        XCTAssertEqual(shown.last?["ended"] as? String, "error")
        XCTAssertEqual(shown.last?["error"] as? String, "Rate limited")
        XCTAssertNil(shown.last?["assistant"])
        XCTAssertNil(read["pendingUserMessage"])
    }

    // MARK: The last four visited

    func testTheLastFourVisitedAreHeardAndTheFifthIsLetGo() async throws {
        let ids = ["v1", "v2", "v3", "v4", "v5"]
        let targets = FakeCallTargets(directory: ids.map { CallTarget(agentId: $0, title: $0.uppercased(), kind: .task, status: .idle) }, states: [:], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for id in ids { _ = await context.focusChanged(to: id) }
        var followed = await context.followed
        XCTAssertEqual(followed, ["v5", "v4", "v3", "v2"])
        // The fifth one back is no longer heard from.
        let first = CallTarget(agentId: "v1", title: "V1", kind: .task, status: .idle)
        let gone = await context.targetChanged(CallTargetState(target: first, messages: [CallMessage(id: "m", role: .assistant, text: "hi")]))
        XCTAssertTrue(gone.isEmpty)
        // Visiting one again makes it the latest.
        _ = await context.focusChanged(to: "v2")
        followed = await context.followed
        XCTAssertEqual(followed, ["v2", "v5", "v4", "v3"])
        // Back after it was let go, what it says then is what was there: nothing is replayed.
        _ = await context.focusChanged(to: "v1")
        followed = await context.followed
        XCTAssertEqual(followed, ["v1", "v2", "v5", "v4"])
        let seen = await context.targetChanged(CallTargetState(target: first, messages: [CallMessage(id: "m", role: .assistant, text: "hi")]))
        XCTAssertTrue(seen.isEmpty)
        let next = await context.targetChanged(CallTargetState(target: first, messages: [CallMessage(id: "m", role: .assistant, text: "hi"), CallMessage(id: "m2", role: .assistant, text: "new")]))
        XCTAssertEqual(try events(next).map { $0["text"] as? String }, ["new"])
    }

    func testSettingsOrHomeInFrontKeepTheVisited() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.handle(CallToolCall(id: "o", name: "openSession", parameters: Data(#"{"targetRef":"s2","focusRevision":0}"#.utf8)))
        _ = await context.focusChanged(to: "b")
        let settings = try events(await context.focusChanged(to: nil))
        XCTAssertEqual(settings.first?["event"] as? String, "focus")
        XCTAssertTrue(settings.first?["title"] is NSNull)
        XCTAssertEqual(settings.first?["focusRevision"] as? Int, 2)
        let followed = await context.followed
        XCTAssertEqual(followed, ["b", "a"])
        // Still heard from while Settings is in front.
        let b = CallTargetState(target: docsTarget, working: true)
        _ = await context.targetChanged(b)
        var more = b
        more.messages = [CallMessage(id: "w", role: .assistant, text: "Working on it")]
        let words = try events(await context.targetChanged(more))
        XCTAssertEqual(words.map { $0["event"] as? String }, ["assistant_text"])
    }

    func testAFocusSaysWhichButNotItsHistory() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let focus = try events(await context.focusChanged(to: "a"))
        XCTAssertEqual(focus.count, 1)
        XCTAssertEqual(focus[0]["title"] as? String, "Backend")
        XCTAssertEqual(focus[0]["parents"] as? [String], [])
        XCTAssertNil(focus[0]["ref"])
        XCTAssertNil(focus[0]["targetRef"])
        XCTAssertNil(focus[0]["turns"])
        XCTAssertFalse(focus.description.contains("answer"))
    }

    /// "queued" is no receipt: a send that fails afterwards is said by
    /// nothing on its own, and read where the agent looks for it.
    func testASendThatFailsLaterIsReadNotAnnounced() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let sent = try object(await tool(context, "sendMessage", #"{"targetRef":"s1","text":"run it","focusRevision":0}"#).text)
        XCTAssertEqual(sent["status"] as? String, "queued")
        let before = await targets.state(of: "a")
        var state = try XCTUnwrap(before)
        let failed = CallMessage(id: "run", role: .user, text: "run it", delivery: .failed)
        state.messages.append(failed)
        state.unanswered = failed
        await targets.set("a", state)
        let quiet = await context.targetChanged(state)
        XCTAssertTrue(quiet.isEmpty)
        let read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        let pending = try XCTUnwrap(read["pendingUserMessage"] as? [String: Any])
        XCTAssertEqual(pending["text"] as? String, "run it")
        XCTAssertEqual(pending["delivery"] as? String, "failed")
    }

    /// A conversation the call opens takes the place of one on top and goes over anything else.
    func testOpeningReplacesAConversationAndGoesOverAnythingElse() {
        func open(_ id: String, over stack: [String]) -> [String] {
            CallNavigation.opening(id, over: stack) { $0.hasPrefix("chat") }
        }
        XCTAssertEqual(open("chat:a", over: ["home"]), ["home", "chat:a"])
        XCTAssertEqual(open("chat:b", over: ["home", "chat:a"]), ["home", "chat:b"])
        // Again and again: never more than the one conversation over home.
        var stack = ["home"]
        for id in ["chat:a", "chat:b", "chat:c", "chat:a"] { stack = open(id, over: stack) }
        XCTAssertEqual(stack, ["home", "chat:a"])
        // From Settings, or a conversation's profile: those stay under it, and the next replaces only it.
        XCTAssertEqual(open("chat:a", over: ["home", "settings"]), ["home", "settings", "chat:a"])
        XCTAssertEqual(open("chat:b", over: ["home", "settings", "chat:a"]), ["home", "settings", "chat:b"])
        XCTAssertEqual(open("chat:b", over: ["home", "chat:a", "profile"]), ["home", "chat:a", "profile", "chat:b"])
    }

    func testOpeningGivesTheRevisionTheNextStepTakes() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let opened = try object(await tool(context, "openSession", #"{"targetRef":"s2","focusRevision":0}"#).text)
        XCTAssertEqual(opened["focusRevision"] as? Int, 1)
        // The screen saying the same afterwards tells the agent nothing new.
        let screen = await context.focusChanged(to: "b")
        XCTAssertTrue(screen.isEmpty)
        // Chained on what the open gave, the next open goes.
        let next = await tool(context, "openSession", #"{"targetRef":"s1","focusRevision":1}"#)
        XCTAssertFalse(next.isError)
        XCTAssertEqual(try object(next.text)["focusRevision"] as? Int, 2)
        let followed = await context.followed
        XCTAssertEqual(followed, ["a", "b"])
        let send = try object(await tool(context, "sendMessage", #"{"targetRef":"s2","text":"go","focusRevision":2}"#).text)
        XCTAssertEqual(send["status"] as? String, "queued")
        XCTAssertEqual(send["delivery"] as? String, "on the person's device, not confirmed delivered or read")
    }

    // MARK: Complete words only

    /// While the agent writes, nothing goes, however long it pauses; once
    /// it is complete the whole of it goes, once.
    func testAMessageGoesWholeOnceWhenCompleteAndNeverWhileItGrows() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        _ = await context.focusChanged(to: "a")
        let old = [CallMessage(id: "x4", role: .assistant, text: "third answer")]
        func state(_ text: String, working: Bool = true) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: old + [CallMessage(id: "r", role: .assistant, text: text, final: !working)], working: working)
        }
        // The first sight is what was there: nothing goes.
        let first = await context.targetChanged(CallTargetState(target: backendTarget, messages: old))
        XCTAssertTrue(first.isEmpty)
        for text in ["Look", "Looking", "Looking at it"] {
            let growing = await context.targetChanged(state(text))
            XCTAssertTrue(growing.isEmpty, text)
        }
        // A pause is no end: the same words, still being written, a while later.
        try? await Task.sleep(for: .milliseconds(600))
        let paused = await context.targetChanged(state("Looking at it"))
        XCTAssertTrue(paused.isEmpty)
        let done = try events(await context.targetChanged(state("Looking at it. Done.", working: false)))
        XCTAssertEqual(done.map { $0["event"] as? String }, ["assistant_text"])
        XCTAssertEqual(done.first?["text"] as? String, "Looking at it. Done.")
        // By its title, never an ID or a reference.
        XCTAssertEqual(done.first?["title"] as? String, "Backend")
        XCTAssertEqual(done.first?["parents"] as? [String], [])
        XCTAssertNil(done.first?["messageId"])
        XCTAssertNil(done.first?["target"])
        XCTAssertNil(done.first?["ref"])
        XCTAssertNil(done.first?["delta"])
        XCTAssertNil(done.first?["final"])
        XCTAssertFalse(done.description.contains("third answer"))
        // A status, a refresh, the same state again: nothing more.
        var refreshed = state("Looking at it. Done.", working: false)
        refreshed.target.status = .waiting
        refreshed.hasMore = true
        let again = await context.targetChanged(refreshed)
        XCTAssertTrue(again.isEmpty)
    }

    /// Words before a tool call are complete once the call comes, mid-run:
    /// they go then, without waiting for the turn to end.
    func testWordsTheAgentWentOnFromGoMidRunEachOnce() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        func state(_ messages: [CallMessage], working: Bool = true) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: messages, working: working)
        }
        _ = await context.targetChanged(state([]))
        let writing = await context.targetChanged(state([CallMessage(id: "p1", role: .assistant, text: "Let me check the logs", final: false)]))
        XCTAssertTrue(writing.isEmpty)
        let checked = try events(await context.targetChanged(state([
            CallMessage(id: "p1", role: .assistant, text: "Let me check the logs."),
            CallMessage(id: "p2", role: .assistant, text: "They show", final: false),
        ])))
        XCTAssertEqual(checked.map { $0["text"] as? String }, ["Let me check the logs."])
        let rest = try events(await context.targetChanged(state([
            CallMessage(id: "p1", role: .assistant, text: "Let me check the logs."),
            CallMessage(id: "u", role: .user, text: "and?"),
            CallMessage(id: "p2", role: .assistant, text: "They show a timeout."),
        ], working: false)))
        XCTAssertEqual(rest.map { $0["text"] as? String }, ["They show a timeout."])
    }

    func testALongMessageGoesCutAtFourKilobytesOnce() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.targetChanged(CallTargetState(target: backendTarget))
        let long = CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: String(repeating: "é", count: 3000))])
        let cut = try events(await context.targetChanged(long))
        XCTAssertEqual((cut.first?["text"] as? String)?.utf8.count, 4096)
        XCTAssertEqual(cut.first?["truncated"] as? Bool, true)
        let after = await context.targetChanged(long)
        XCTAssertTrue(after.isEmpty)
    }

    func testWhatTheWaitLostIsPutRightInOneGo() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.focusChanged(to: "b")
        _ = await context.focusChanged(to: "a")
        _ = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: "Half", final: false)], working: true))
        _ = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: "Half way")],
                                                        turns: [CallTurn(id: "x", ended: "error", error: "Boom")]))
        // Say every one of those was lost: the agent gets the focus as it is, and each message as told.
        let fixed = try events(await context.resync())
        // The directory as it is, the focus, then what was told.
        XCTAssertEqual(fixed.first?["event"] as? String, "directory")
        XCTAssertEqual(fixed.first?["text"] as? String, "Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]")
        XCTAssertEqual(fixed[1]["event"] as? String, "focus")
        XCTAssertEqual(fixed[1]["resync"] as? Bool, true)
        XCTAssertEqual(fixed[1]["focusRevision"] as? Int, 2)
        XCTAssertEqual(fixed[1]["title"] as? String, "Backend")
        XCTAssertEqual(fixed.dropFirst(2).map { $0["event"] as? String }, ["session_error", "assistant_text"])
        XCTAssertEqual(fixed.last?["text"] as? String, "Half way")
        XCTAssertLessThanOrEqual(fixed.reduce(0) { $0 + (try! JSONSerialization.data(withJSONObject: $1)).count }, 32 * 1024)
        // What was there at first sight was never told, so none of it comes back.
        XCTAssertFalse(fixed.description.contains("third answer"))
    }

    func testAReplyBeingWrittenWhenFirstSeenGoesWholeOnceComplete() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        _ = await context.focusChanged(to: "b")
        _ = await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Halfway", final: false)], working: true))
        let next = try events(await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Halfway there")])))
        XCTAssertEqual(next.map { $0["text"] as? String }, ["Halfway there"])
    }

    /// When the agent's words are complete, as a conversation's snapshot
    /// says: once it went on past them, or its run is over. The person's
    /// own message coming in after says nothing of that.
    func testASnapshotsWordsAreCompleteOnceTheAgentWentOnPastThem() {
        let target = CallTarget(agentId: "a", title: "A", kind: .task, status: .idle)
        func agent(_ id: String, _ text: String) -> ChatItem { ChatItem(id: id, role: .agent, pieces: [.text(text)], delivery: .sent, turn: "r1") }
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.working = true
        snapshot.items = [agent("m1", "Checking")]
        XCTAssertEqual(CallTargetState.from(snapshot, target: target).messages.map(\.final), [false])
        // The person's message after them: still being written.
        snapshot.items.append(ChatItem(id: "u", role: .user, pieces: [.text("hurry")], delivery: .sending))
        XCTAssertEqual(CallTargetState.from(snapshot, target: target).messages.filter { $0.role == .assistant }.map(\.final), [false])
        // A tool call after them: complete.
        snapshot.items.insert(ChatItem(id: "t", role: .tool(ChatItem.Tool(name: "exec_command", status: "running")), pieces: [], delivery: .sent, turn: "r1"), at: 1)
        XCTAssertEqual(CallTargetState.from(snapshot, target: target).messages.filter { $0.role == .assistant }.map(\.final), [true])
        // More words after the call: those are the ones still growing.
        snapshot.items.insert(agent("m1/2", "Found it"), at: 2)
        XCTAssertEqual(CallTargetState.from(snapshot, target: target).messages.filter { $0.role == .assistant }.map(\.final), [true, false])
        snapshot.working = false
        XCTAssertEqual(CallTargetState.from(snapshot, target: target).messages.filter { $0.role == .assistant }.map(\.final), [true, true])
    }

    func testAnErrorThatStoppedATurnIsSaidOnceAndNothingElseIs() async throws {
        let targets = backend()
        let earlier = CallTurn(id: "old", ended: "error", error: "Old failure")
        var state = CallTargetState(target: backendTarget, turns: [earlier])
        await targets.set("a", state)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        // The error that was there when the call began isn't news.
        let same = await context.targetChanged(state)
        XCTAssertTrue(same.isEmpty)
        // Working, needing the person, the person's messages and their delivery: none of it goes.
        state.working = true
        state.target.status = .running
        state.messages = [CallMessage(id: "u", role: .user, text: "do it", delivery: .queued)]
        let working = await context.targetChanged(state)
        XCTAssertTrue(working.isEmpty)
        state.needsInput = true
        state.target.status = .needsInput
        state.messages[0].delivery = .failed
        let needs = await context.targetChanged(state)
        XCTAssertTrue(needs.isEmpty)
        state.working = false
        state.needsInput = false
        state.turns.append(CallTurn(id: "new", user: "do it", ended: "error", error: "The model refused"))
        let stopped = try events(await context.targetChanged(state))
        XCTAssertEqual(stopped.map { $0["event"] as? String }, ["session_error"])
        XCTAssertEqual(stopped.first?["reason"] as? String, "The model refused")
        XCTAssertEqual(stopped.first?["title"] as? String, "Backend")
        XCTAssertNil(stopped.first?["target"])
        let again = await context.targetChanged(state)
        XCTAssertTrue(again.isEmpty)
        // Stopped by the person is no error.
        state.turns.append(CallTurn(id: "stop", user: "x", ended: "abort"))
        let aborted = await context.targetChanged(state)
        XCTAssertTrue(aborted.isEmpty)
    }

    // MARK: Tools

    func testSendMessageQueuesTheExactTextOnceAndHearsNothingMore() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let call = CallToolCall(id: "t1", name: "sendMessage", parameters: Data(#"{"targetRef":"s2","text":"  run the checks ","focusRevision":0}"#.utf8))
        let first = await context.handle(call)
        XCTAssertFalse(first.isError)
        XCTAssertEqual(try object(first.text)["status"] as? String, "queued")
        // The provider asking again under the same ID gets the same answer.
        let again = await context.handle(call)
        XCTAssertEqual(again, first)
        let sends = await targets.sends
        XCTAssertEqual(sends.map(\.text), ["  run the checks "])
        XCTAssertEqual(sends.map(\.agentId), ["b"])
        XCTAssertEqual(sends[0].id.count, 24)
        // Sending neither opens it nor adds it to what the call hears.
        let followed = await context.followed
        XCTAssertEqual(followed, ["a"])
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let reply = await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "r", role: .assistant, text: "Done")]))
        XCTAssertTrue(reply.isEmpty)
    }

    func testSendMessageRefusesWhatItMustNotSend() async throws {
        let targets = backend()
        await targets.set("a", CallTargetState(target: CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .needsInput), needsInput: true))
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let refusals = [
            #"{"targetRef":"s1","text":"yes","focusRevision":0}"#,
            #"{"targetRef":"s2","text":"go","focusRevision":3}"#,
            #"{"targetRef":"s9","text":"go","focusRevision":0}"#,
            #"{"targetRef":"s2","text":"  ","focusRevision":0}"#,
            #"{"targetRef":"s2","text":7,"focusRevision":0}"#,
            "{\"targetRef\":\"s2\",\"text\":\"\(String(repeating: "é", count: 4097))\",\"focusRevision\":0}",
        ]
        for json in refusals {
            let result = await tool(context, "sendMessage", json)
            XCTAssertTrue(result.isError, json)
        }
        let unknown = await tool(context, "processPermissionRequest", "{}")
        XCTAssertTrue(unknown.isError)
        let watch = await tool(context, "setSessionWatch", #"{"targetRef":"s2","enabled":true}"#)
        XCTAssertEqual(try object(watch.text)["reason"] as? String, "Unknown tool.")
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        // 8 KiB exactly is fine.
        let most = await tool(context, "sendMessage", "{\"targetRef\":\"s2\",\"text\":\"\(String(repeating: "é", count: 4096))\",\"focusRevision\":0}")
        XCTAssertFalse(most.isError)
    }

    func testASendWithNoAnswerInTimeIsUncertainAndNeverGoesUnderANewID() async throws {
        let targets = backend()
        await targets.setSendDelay(.seconds(30))
        let context = CallContext(targets: targets, toolDeadline: .milliseconds(50))
        _ = await context.initial()
        func send(_ call: String, _ text: String) async -> CallToolResult {
            await tool(context, "sendMessage", "{\"targetRef\":\"s2\",\"text\":\"\(text)\",\"focusRevision\":0}", id: call)
        }
        let started = ContinuousClock.now
        let first = await send("t1", "go")
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5))
        XCTAssertTrue(first.isError)
        XCTAssertEqual(try object(first.text)["status"] as? String, "uncertain")
        // The agent asking again, under a new tool call: the same message ID.
        await targets.setSendDelay(nil)
        let again = await send("t2", "go")
        XCTAssertEqual(try object(again.text)["status"] as? String, "queued")
        // Settled, the same words later are a new message.
        _ = await send("t3", "go")
        await waitFor { await targets.sends.count == 3 }
        let ids = await targets.sends.map(\.id)
        XCTAssertEqual(Set(ids.prefix(2)).count, 1)
        XCTAssertNotEqual(ids[2], ids[0])
    }

    func testMovingTheScreenRefusesWhatWasAskedUnderTheOldFocus() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let moved = await context.focusChanged(to: "b")
        XCTAssertTrue(moved.context[0].contains(#""focusRevision":1"#))
        for name in ["openSession", "sendMessage"] {
            let stale = await tool(context, name, #"{"targetRef":"s1","text":"go","focusRevision":0}"#)
            XCTAssertTrue(stale.isError, name)
            XCTAssertTrue(stale.text.contains("screen changed"), name)
        }
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        let fresh = await tool(context, "sendMessage", #"{"targetRef":"s1","text":"go","focusRevision":1}"#)
        XCTAssertFalse(fresh.isError)
    }

    func testAnEndedCallRunsNoTools() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await context.close()
        let late = await tool(context, "sendMessage", #"{"targetRef":"s2","text":"go","focusRevision":0}"#)
        XCTAssertTrue(late.isError)
        let update = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "n", role: .assistant, text: "new")]))
        XCTAssertTrue(update.isEmpty)
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
    }

    func testArgumentsAreCheckedAgainstTheSchema() async throws {
        let x = CallTarget(agentId: "x", title: "X", kind: .task, status: .idle)
        let targets = FakeCallTargets(directory: [x], states: ["x": CallTargetState(target: x)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for bad in [#""0""#, "true", "0.5", "null"] {
            let result = await tool(context, "openSession", "{\"targetRef\":\"s1\",\"focusRevision\":\(bad)}")
            XCTAssertTrue(result.isError, bad)
        }
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let fine = await tool(context, "openSession", #"{"targetRef":"s1","focusRevision":0}"#)
        XCTAssertFalse(fine.isError)
        for bad in [#"{"query":3}"#, #"{"cursor":5}"#, #"{"cursor":"-1"}"#, #"{"cursor":"x"}"#, "[]"] {
            let result = await tool(context, "listSessions", bad)
            XCTAssertTrue(result.isError, bad)
        }
        let unref = await tool(context, "getSessionContext", #"{"targetRef":1}"#)
        XCTAssertTrue(unref.isError)
    }

    func testTheFourToolsAreDescribedForTheDashboard() {
        XCTAssertEqual(CallTool.allCases.map(\.rawValue), ["listSessions", "getSessionContext", "openSession", "sendMessage"])
        XCTAssertEqual(CallTool.openSession.parameters["properties"]?["focusRevision"]?["type"], .string("integer"))
        XCTAssertEqual(CallTool.sendMessage.parameters["required"], .array([.string("targetRef"), .string("text"), .string("focusRevision")]))
        XCTAssertEqual(CallTool.getSessionContext.parameters["required"], .array([.string("targetRef")]))
        XCTAssertEqual(CallTool.listSessions.parameters["required"], .array([]))
        XCTAssertTrue(CallTool.listSessions.summary.contains("case-insensitive substring"))
        XCTAssertTrue(CallTool.sendMessage.summary.contains("queued on the person's device, not confirmed delivered or read"))
        XCTAssertTrue(CallTool.sendMessage.summary.contains("8 KiB"))
    }

    func testListSessionsPagesAndFiltersBySubstring() async throws {
        let many = (0..<120).map { CallTarget(agentId: "x\($0)", title: $0 % 2 == 0 ? "Even \($0)" : "Odd \($0)", kind: .task, status: .idle) }
        let context = CallContext(targets: FakeCallTargets(directory: many, states: [:], focus: nil))
        _ = await context.initial()
        let first = try object(await tool(context, "listSessions", "{}").text)
        XCTAssertEqual((first["sessions"] as? [Any])?.count, 50)
        XCTAssertEqual(first["nextCursor"] as? String, "50")
        let odd = try object(await tool(context, "listSessions", #"{"query":"DD 1","cursor":null}"#).text)
        XCTAssertEqual((odd["sessions"] as? [[String: Any]])?.count, 16)
        let paged = try object(await tool(context, "listSessions", #"{"query":"odd","cursor":"50"}"#).text)
        XCTAssertEqual((paged["sessions"] as? [Any])?.count, 10)
        XCTAssertNil(paged["nextCursor"])
    }

    // MARK: The directory: what the person sees

    /// Bots, tasks, subtasks at any depth and a project's conversations,
    /// in the sidebar's order: the sidebar's own rows, nothing it hides.
    static let sidebar = #"""
    {"cursor":"c","profile":{"userId":null},"userSettings":[],
     "projects":[{"id":"p1","name":"App","status":"active","orderKey":"a","agents":[{"id":"root","workspaceId":"p1","title":"Root chat","status":"idle"}]}],
     "workspaces":[{"id":"w1","projectId":"p1","parentId":"p1","name":"Feature","kind":"worktree","status":"active","orderKey":"a","agents":[{"id":"wchat","workspaceId":"w1","title":"Feature chat","status":"idle"}]}],
     "bots":[
       {"id":"arch","name":"Architect","status":"active","agent":{"id":"arch-agent","workspaceId":"aw","status":"idle"}},
       {"id":"quiet","name":"Hidden bot","status":"active","agent":{"id":"quiet-agent","workspaceId":"qw","status":"idle"}}],
     "tasks":[
       {"id":"t1","name":"Release notes","agent":{"id":"t1-agent","workspaceId":"t1w","status":"idle","subtasks":[
         {"id":"sub1","workspaceId":"t1w","parentAgentId":"t1-agent","title":"Fix cache race","status":"idle","subtasks":[
           {"id":"subsub","workspaceId":"t1w","parentAgentId":"sub1","title":"Check the lock","status":"idle"}]},
         {"id":"gone","workspaceId":"t1w","parentAgentId":"t1-agent","title":"Archived one","status":"idle","archivedAt":1}]}},
       {"id":"t2","name":"New Task","agent":{"id":"t2-agent","workspaceId":"t2w","status":"idle"}},
       {"id":"t3","name":"Old","status":"archived","agent":{"id":"t3-agent","workspaceId":"t3w","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"},{"taskId":"t2"},{"taskId":"t3"}],
     "surfaces":[{"id":"chat","name":"Team chat","type":"chat","chatAgentId":"surface-agent","members":[{"userId":null,"orderKey":"a"}]}]}
    """#

    private func sidebarRows() throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.sidebar.utf8))
        return SidebarRows.make(desktop, settings: ["happy-desktop.bot.quiet": .object(["hidden": .bool(true)])])
    }

    func testTheDirectoryIsTheSidebarsConversationsNestedAsItShowsThem() async throws {
        let rows = try sidebarRows()
        let list = CallTarget.list(rows)
        // Exactly the rows that open a conversation, in their order: no
        // filter of the call's own.
        let opening = rows.filter { ($0.kind == .space || $0.kind == .session) && $0.agentId != nil && $0.targetKind != "surface" }.compactMap(\.agentId)
        XCTAssertEqual(list.map(\.agentId), opening)
        XCTAssertEqual(list.map(\.agentId), ["arch-agent", "t1-agent", "sub1", "subsub", "t2-agent", "root", "wchat"])
        XCTAssertEqual(list.map(\.kind), [.bot, .task, .subtask, .subtask, .task, .conversation, .conversation])
        XCTAssertEqual(list[3].parents.map(\.title), ["Release notes", "Fix cache race"])
        XCTAssertEqual(list[6].parents.map(\.title), ["App", "Feature"])
        // The sidebar's own label, a placeholder too.
        XCTAssertEqual(list[4].title, "New Task")

        let context = CallContext(targets: FakeCallTargets(directory: list, states: [:], focus: nil))
        let initial = try object(await context.initial())
        XCTAssertEqual(initial["directory"] as? String, """
        Conversation directory:
        Architect [bot; ref=s1]
        Release notes [task; ref=s2]
          Fix cache race [subtask; ref=s3]
            Check the lock [subtask; ref=s4]
        New Task [task; ref=s5]
        App [project]
          Root chat [conversation; ref=s6]
          Feature [workspace]
            Feature chat [conversation; ref=s7]
        """)
        // No IDs of the computer's in what the agent reads.
        for id in ["arch-agent", "t1-agent", "sub1", "subsub", "root", "wchat"] { XCTAssertFalse((initial["directory"] as? String ?? "").contains(id), id) }
        let listed = try object(await tool(context, "listSessions", #"{"query":"lock"}"#).text)
        let found = try XCTUnwrap((listed["sessions"] as? [[String: Any]])?.first)
        XCTAssertEqual(found["targetRef"] as? String, "s4")
        XCTAssertEqual(found["kind"] as? String, "subtask")
        XCTAssertEqual(found["parents"] as? [String], ["Release notes", "Fix cache race"])
    }

    private let releaseTarget = CallTarget(agentId: "t", title: "Release notes", kind: .task, status: .idle)
    private var fixTarget: CallTarget {
        CallTarget(agentId: "c", title: "Fix cache race", kind: .subtask, status: .running, parents: [CallTarget.Parent(id: "task:t", title: "Release notes", kind: "task", agentId: "t")])
    }

    /// A subtask is reached like anything else listed, by its reference,
    /// whether or not the person ever opened it.
    func testEveryListedConversationIsReachedSubtasksToo() async throws {
        let targets = FakeCallTargets(directory: [releaseTarget, fixTarget], states: [
            "t": CallTargetState(target: releaseTarget),
            "c": CallTargetState(target: fixTarget, turns: [CallTurn(id: "r", user: "sub ask", reply: "sub answer")]),
        ], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s2"}"#).text)
        XCTAssertEqual(read["title"] as? String, "Fix cache race")
        XCTAssertEqual(read["parents"] as? [String], ["Release notes"])
        XCTAssertNil(read["targetRef"])
        XCTAssertNil(read["ref"])
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.first?["assistant"] as? String, "sub answer")
        let opened = try object(await tool(context, "openSession", #"{"targetRef":"s2","focusRevision":0}"#).text)
        XCTAssertEqual(opened["opened"] as? Bool, true)
        let sent = try object(await tool(context, "sendMessage", #"{"targetRef":"s2","text":"go on","focusRevision":1}"#).text)
        XCTAssertEqual(sent["status"] as? String, "queued")
        let sends = await targets.sends
        XCTAssertEqual(sends.map(\.agentId), ["c"])
        // A reference no one gave reaches nothing.
        let forged = await tool(context, "getSessionContext", #"{"targetRef":"s9"}"#)
        XCTAssertTrue(forged.isError)
    }

    /// New work settles for a second, then goes as the whole directory,
    /// by the sidebar's label whatever it is then; a status alone is no change.
    func testANewEntryGoesOnceSettledAsTheWholeDirectory() async throws {
        let targets = FakeCallTargets(directory: [releaseTarget], states: [:], focus: nil)
        let context = CallContext(targets: targets)
        // Its watch answering ahead of the first snapshot: nothing due.
        let early = await context.directoryChanged([releaseTarget])
        XCTAssertFalse(early)
        _ = await context.initial()
        var running = releaseTarget
        running.status = .running
        let status = await context.directoryChanged([running])
        XCTAssertFalse(status)
        // New, and nobody named it yet: due, and goes as the label is at the flush.
        let fresh = CallTarget(agentId: "n", title: "New Task", kind: .task, status: .idle)
        let due = await context.directoryChanged([releaseTarget, fresh])
        XCTAssertTrue(due)
        await targets.setDirectory([releaseTarget, fresh])
        let flushed = try events(await context.flushDirectory())
        XCTAssertEqual(flushed.map { $0["event"] as? String }, ["directory"])
        XCTAssertEqual(flushed.first?["text"] as? String, "Conversation directory:\nRelease notes [task; ref=s1]\nNew Task [task; ref=s2]")
        // Told: the same again is nothing.
        let same = await context.directoryChanged([releaseTarget, fresh])
        XCTAssertFalse(same)
        let none = await context.flushDirectory()
        XCTAssertTrue(none.isEmpty)
        // Named later: the same reference, the new title.
        var named = fresh
        named.title = "Ship 2.0"
        let renamed = await context.directoryChanged([releaseTarget, named])
        XCTAssertTrue(renamed)
        await targets.setDirectory([releaseTarget, named])
        let again = try events(await context.flushDirectory())
        XCTAssertEqual(again.first?["text"] as? String, "Conversation directory:\nRelease notes [task; ref=s1]\nShip 2.0 [task; ref=s2]")
    }

    /// The flush reads the sidebar as it is then: a name that came in the
    /// second goes, work that went away in it never does.
    func testTheFlushTellsTheSidebarAsItIsThen() async throws {
        let targets = FakeCallTargets(directory: [releaseTarget], states: [:], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let fresh = CallTarget(agentId: "n", title: "New Task", kind: .task, status: .idle)
        _ = await context.directoryChanged([releaseTarget, fresh])
        var named = fresh
        named.title = "Fix the login redirect"
        await targets.setDirectory([releaseTarget, named])
        let titled = try events(await context.flushDirectory())
        XCTAssertEqual(titled.first?["text"] as? String, "Conversation directory:\nRelease notes [task; ref=s1]\nFix the login redirect [task; ref=s2]")
        XCTAssertFalse(titled.description.contains("New Task"))
        // Came and went within the second: nothing at all.
        let brief = CallTarget(agentId: "b", title: "Brief", kind: .task, status: .idle)
        let due = await context.directoryChanged([releaseTarget, named, brief])
        XCTAssertTrue(due)
        await targets.setDirectory([releaseTarget, named])
        let gone = await context.flushDirectory()
        XCTAssertTrue(gone.isEmpty)
    }

    /// One flush, due a fixed time after the first change: later changes
    /// never put it off, and a cancelled one never goes.
    @MainActor
    func testTheSettleIsNeverPutOff() async throws {
        let delay = Duration.milliseconds(400)
        var flushes: [ContinuousClock.Instant] = []
        let settle = DirectorySettle(delay: delay) { flushes.append(.now) }
        // Changes without a pause for two seconds: a flush put off by each
        // would never come; one due from the first comes in the first.
        let start = ContinuousClock.now
        while ContinuousClock.now - start < .seconds(2) {
            settle.changed()
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTAssertGreaterThanOrEqual(flushes.count, 1)
        let first = try XCTUnwrap(flushes.first)
        XCTAssertGreaterThanOrEqual(first - start, delay)
        XCTAssertLessThan(first - start, .seconds(2))
        // One at a time: never two within `delay` of each other.
        for (earlier, later) in zip(flushes, flushes.dropFirst()) { XCTAssertGreaterThanOrEqual(later - earlier, delay) }
        // A cancelled one never goes.
        try await Task.sleep(for: delay * 2)
        let count = flushes.count
        settle.changed()
        settle.cancel()
        try await Task.sleep(for: delay * 2)
        XCTAssertEqual(flushes.count, count)
    }

    /// A snapshot within its size shows what it can and counts the rest;
    /// whatever is new or changed among the rest still goes, in as many
    /// `directory_entries` as it takes, each with what it sits under.
    func testWhatTheSnapshotCantShowThatIsNewStillGoes() async throws {
        let many = (0..<150).map { CallTarget(agentId: "x\($0)", title: "Task \($0)", kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: many, states: [:], focus: nil)
        let context = CallContext(targets: targets)
        let initial = try object(await context.initial())
        XCTAssertTrue((initial["directory"] as? String ?? "").hasSuffix("… and 50 more; listSessions finds them by title."))
        let newOnes = (0..<40).map { CallTarget(agentId: "n\($0)", title: "Late \($0) " + String(repeating: "z", count: 150), kind: .subtask, status: .idle,
                                                parents: [CallTarget.Parent(id: "task:x149", title: "Task 149", kind: "task", agentId: "x149")]) }
        await targets.setDirectory(many + newOnes)
        _ = await context.directoryChanged(many + newOnes)
        let flushed = try events(await context.flushDirectory())
        XCTAssertEqual(flushed.first?["event"] as? String, "directory")
        let pages = flushed.dropFirst()
        XCTAssertGreaterThan(pages.count, 1)
        var told = ""
        for page in pages {
            XCTAssertEqual(page["event"] as? String, "directory_entries")
            let text = try XCTUnwrap(page["text"] as? String)
            XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.entriesBytes)
            // Each page says what its entries sit under.
            XCTAssertTrue(text.contains("\nTask 149 [task; ref="), text)
            told += text
        }
        for index in 0..<40 { XCTAssertTrue(told.contains("  Late \(index) "), "Late \(index)") }
        // What was cut and hasn't changed isn't paged out.
        XCTAssertFalse(told.contains("Task 120 ["))
        XCTAssertLessThanOrEqual(flushed.reduce(0) { $0 + (try! JSONSerialization.data(withJSONObject: $1)).count }, 32 * 1024)
    }

    /// A reference reaches a conversation while the sidebar lists it; gone,
    /// it reaches nothing and isn't heard from; back, it reaches it again.
    func testAReferenceReachesWhatIsListedNow() async throws {
        let docs = docsTarget
        let targets = FakeCallTargets(directory: [backendTarget, docs], states: [
            "a": CallTargetState(target: backendTarget), "b": CallTargetState(target: docs),
        ], focus: "b")
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await targets.setDirectory([backendTarget])
        _ = await context.directoryChanged([backendTarget])
        let flushed = try events(await context.flushDirectory())
        XCTAssertEqual(flushed.first?["text"] as? String, "Conversation directory:\nBackend [bot; ref=s1]")
        let followed = await context.followed
        XCTAssertTrue(followed.isEmpty)
        for name in ["getSessionContext", "openSession", "sendMessage"] {
            let refused = await tool(context, name, #"{"targetRef":"s2","text":"hi","focusRevision":0}"#)
            XCTAssertTrue(refused.isError, name)
        }
        await targets.setDirectory([backendTarget, docs])
        _ = await context.directoryChanged([backendTarget, docs])
        let back = try events(await context.flushDirectory())
        XCTAssertEqual(back.first?["text"] as? String, "Conversation directory:\nBackend [bot; ref=s1]\nDocs [task; ref=s2]")
        let read = await tool(context, "getSessionContext", #"{"targetRef":"s2"}"#)
        XCTAssertFalse(read.isError)
    }

    /// The agent has a conversation's line before any update about it: new
    /// work the person opens before the directory settles, a rename before
    /// its words.
    func testAConversationIsToldBeforeItsFocusOrItsWords() async throws {
        let targets = FakeCallTargets(directory: [releaseTarget], states: ["t": CallTargetState(target: releaseTarget)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let fresh = fixTarget
        await targets.setDirectory([releaseTarget, fresh])
        let due = await context.directoryChanged([releaseTarget, fresh])
        XCTAssertTrue(due)
        // Opened before the second is out.
        let focus = try events(await context.focusChanged(to: "c"))
        XCTAssertEqual(focus.map { $0["event"] as? String }, ["directory_entries", "focus"])
        XCTAssertEqual(focus[0]["text"] as? String, "More of the conversation directory:\nRelease notes [task; ref=s1]\n  Fix cache race [subtask; ref=s2]")
        XCTAssertEqual(focus[1]["title"] as? String, "Fix cache race")
        XCTAssertEqual(focus[1]["parents"] as? [String], ["Release notes"])
        // The flush still goes, whole.
        let flushed = try events(await context.flushDirectory())
        XCTAssertEqual(flushed.map { $0["event"] as? String }, ["directory"])
        // Renamed, then its words: the new name first.
        _ = await context.targetChanged(CallTargetState(target: fresh, working: true))
        var renamed = fresh
        renamed.title = "Fix the cache race"
        let words = try events(await context.targetChanged(CallTargetState(target: renamed, messages: [CallMessage(id: "m", role: .assistant, text: "Fixed.")])))
        XCTAssertEqual(words.map { $0["event"] as? String }, ["directory_entries", "assistant_text"])
        XCTAssertTrue((words[0]["text"] as? String ?? "").hasSuffix("  Fix the cache race [subtask; ref=s2]"))
        XCTAssertEqual(words[1]["title"] as? String, "Fix the cache race")
        // Told once: its next words come alone.
        let next = try events(await context.targetChanged(CallTargetState(target: renamed, messages: [
            CallMessage(id: "m", role: .assistant, text: "Fixed."), CallMessage(id: "m2", role: .assistant, text: "And tested."),
        ])))
        XCTAssertEqual(next.map { $0["event"] as? String }, ["assistant_text"])
    }

    /// Work deleted while the directory settles: a reply that comes late
    /// from it says nothing, under its old name or any, and no line of it goes.
    func testALateReplyFromWorkThatWentAwaySaysNothing() async throws {
        let targets = backend(focus: "b")
        let context = CallContext(targets: targets)
        _ = await context.initial()
        _ = await context.targetChanged(CallTargetState(target: docsTarget, working: true))
        await targets.setDirectory([backendTarget])
        let due = await context.directoryChanged([backendTarget])
        XCTAssertTrue(due)
        let late = await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Done.")],
                                                               turns: [CallTurn(id: "x", ended: "error", error: "Boom")]))
        XCTAssertTrue(late.isEmpty)
        let flushed = try events(await context.flushDirectory())
        XCTAssertEqual(flushed.map { $0["event"] as? String }, ["directory"])
        XCTAssertFalse(flushed.description.contains("Docs"))
        let followed = await context.followed
        XCTAssertTrue(followed.isEmpty)
    }

    /// A conversation under more than a page can show: still told, with
    /// what it sits under on one line cut to fit, and the ones after it too.
    func testAnEntryTooDeepForAPageStillGoes() async throws {
        let chain = (0..<80).map { CallTarget.Parent(id: "session:p\($0)", title: "Parent \($0) " + String(repeating: "y", count: 180), kind: "subtask", agentId: "p\($0)") }
        let deep = CallTarget(agentId: "deep", title: "Deep one", kind: .subtask, status: .idle, parents: chain)
        let after = CallTarget(agentId: "after", title: "After it", kind: .task, status: .idle)
        let targets = FakeCallTargets(directory: [releaseTarget], states: [:], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await targets.setDirectory([releaseTarget, deep, after])
        _ = await context.directoryChanged([releaseTarget, deep, after])
        let flushed = try events(await context.flushDirectory())
        let told = flushed.compactMap { $0["text"] as? String }.joined(separator: "\n")
        XCTAssertTrue(told.contains("Deep one [subtask; ref="), told)
        XCTAssertTrue(told.contains("(under Parent 0 "), told)
        XCTAssertTrue(told.contains("After it [task; ref="), told)
        for event in flushed where event["event"] as? String == "directory_entries" {
            XCTAssertLessThanOrEqual((event["text"] as? String ?? "").utf8.count, CallContext.Limits.entriesBytes)
        }
        let owes = await context.owesDirectory
        XCTAssertFalse(owes)
    }

    /// Title and what it sits under name it; a reference only when that
    /// leaves it unclear, or it has no name of its own yet.
    func testAnUpdateHasAReferenceOnlyWhenItsNameIsUnclear() async throws {
        let parent = CallTarget.Parent(id: "task:t", title: "Release notes", kind: "task", agentId: "t")
        let one = CallTarget(agentId: "c1", title: "Fix", kind: .subtask, status: .idle, parents: [parent])
        let two = CallTarget(agentId: "c2", title: "Fix", kind: .subtask, status: .idle, parents: [parent])
        let elsewhere = CallTarget(agentId: "c3", title: "Fix", kind: .task, status: .idle)
        let unnamed = CallTarget(agentId: "u", title: "New Task", kind: .task, status: .idle)
        let all = [releaseTarget, one, two, elsewhere, unnamed]
        let context = CallContext(targets: FakeCallTargets(directory: all, states: [:], focus: nil))
        _ = await context.initial()
        func focus(_ id: String) async throws -> [String: Any] {
            let update = await context.focusChanged(to: id)
            return try XCTUnwrap(try events(update).last)
        }
        let first = try await focus("c1")
        XCTAssertEqual(first["ref"] as? String, "s2")
        XCTAssertEqual(first["parents"] as? [String], ["Release notes"])
        let other = try await focus("c3")
        XCTAssertNil(other["ref"])
        XCTAssertEqual(other["parents"] as? [String], [])
        let fresh = try await focus("u")
        XCTAssertEqual(fresh["ref"] as? String, "s5")
        let plain = try await focus("t")
        XCTAssertNil(plain["ref"])
    }

    // MARK: Complete words, by their own run

    private func chat(_ items: [ChatItem], working: Bool = true) -> ChatSnapshot {
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.working = working
        snapshot.items = items
        return snapshot
    }

    private func said(_ id: String, _ text: String, run: String?, role: ChatItem.Role = .agent) -> ChatItem {
        ChatItem(id: id, role: role, pieces: [.text(text)], delivery: .sent, turn: run)
    }

    private func finals(_ snapshot: ChatSnapshot) -> [String: Bool] {
        let state = CallTargetState.from(snapshot, target: CallTarget(agentId: "a", title: "A", kind: .task, status: .idle))
        return Dictionary(uniqueKeysWithValues: state.messages.filter { $0.role == .assistant }.map { ($0.id, $0.final) })
    }

    /// The person's new message while the agent writes completes nothing.
    func testThePersonsMessageMidStreamCompletesNothing() {
        let streaming = [said("u1", "fix it", run: "r1", role: .user), said("a1", "Looking", run: "r1")]
        XCTAssertEqual(finals(chat(streaming)), ["a1": false])
        // Queued on the phone, then taken by the computer, before a run picks it up.
        XCTAssertEqual(finals(chat(streaming + [ChatItem(id: "u2", role: .user, pieces: [.text("and the tests")], delivery: .sending)])), ["a1": false])
        XCTAssertEqual(finals(chat(streaming + [ChatItem(id: "u2", role: .user, pieces: [.text("and the tests")], delivery: .pending)])), ["a1": false])
    }

    /// A boundary that starts the next run at once, still working: the
    /// last run's words are complete, the new run's still grow.
    func testARunThatStartsTheNextCompletesTheLastOnesWords() {
        let end = ChatItem(id: "r1:status", role: .turnEnd(ChatItem.TurnEnd(reason: "completed", durationMs: 5, tools: 0, copyText: "Done.")), pieces: [], delivery: .sent, turn: "r1")
        let first = [said("u1", "fix it", run: "r1", role: .user), said("a1", "Done.", run: "r1")]
        XCTAssertEqual(finals(chat(first + [end, said("u2", "next", run: "r2", role: .user)])), ["a1": true])
        // No end item yet, but a newer run has begun: still complete.
        XCTAssertEqual(finals(chat(first + [said("u2", "next", run: "r2", role: .user)])), ["a1": true])
        XCTAssertEqual(finals(chat(first + [said("a2", "On it", run: "r2")])), ["a1": true, "a2": false])
        let state = CallTargetState.from(chat(first + [end, said("a2", "On it", run: "r2")]), target: CallTarget(agentId: "a", title: "A", kind: .task, status: .idle))
        XCTAssertEqual(state.messages.first { $0.id == "a1" }?.turn, "r1")
    }

    /// Anything that isn't the agent's own next step in that run (another
    /// agent reporting in) completes nothing.
    func testUnrelatedChangesCompleteNothing() {
        let streaming = [said("u1", "fix it", run: "r1", role: .user), said("a1", "Looking", run: "r1")]
        let other = ChatItem(id: "co", role: .collaborator(agentId: "other", explanation: "helping"), pieces: [.text("hi")], delivery: .sent)
        XCTAssertEqual(finals(chat(streaming + [other])), ["a1": false])
    }

    /// Words that ended their run say so (`finishedTurn`); words the agent
    /// went on from mid-run don't.
    func testWordsThatEndedTheirTurnSaySo() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.targetChanged(CallTargetState(target: backendTarget))
        let midRun = try events(await context.targetChanged(CallTargetState(target: backendTarget, messages: [
            CallMessage(id: "p1", role: .assistant, text: "Checking.", turn: "r9"),
            CallMessage(id: "p2", role: .assistant, text: "Still", final: false, turn: "r9"),
        ], working: true)))
        XCTAssertEqual(midRun.map { $0["text"] as? String }, ["Checking."])
        XCTAssertNil(midRun.first?["finishedTurn"])
        let ended = try events(await context.targetChanged(CallTargetState(target: backendTarget, messages: [
            CallMessage(id: "p1", role: .assistant, text: "Checking.", turn: "r9"),
            CallMessage(id: "p2", role: .assistant, text: "Still fine.", turn: "r9"),
        ], turns: [CallTurn(id: "r9", reply: "Still fine.")])))
        XCTAssertEqual(ended.map { $0["text"] as? String }, ["Still fine."])
        XCTAssertEqual(ended.first?["finishedTurn"] as? Bool, true)
    }

    func testAChatSnapshotReadsAsTurnsOfPublicWordsOnly() {
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.working = true
        snapshot.draft = "half typed"
        let tool = ChatItem.Tool(name: "Bash", status: "completed")
        snapshot.items = [
            ChatItem(id: "u1", role: .user, pieces: [.text("fix it")], delivery: .sent, turn: "r1"),
            ChatItem(id: "a1", role: .agent, pieces: [.text("Looking")], delivery: .sent, turn: "r1"),
            ChatItem(id: "t1", role: .tool(tool), pieces: [], delivery: .sent, turn: "r1"),
            ChatItem(id: "a2", role: .agent, pieces: [.text("Fixed.")], delivery: .sent, turn: "r1"),
            ChatItem(id: "r1:status", role: .turnEnd(ChatItem.TurnEnd(reason: "completed", durationMs: 10, tools: 1, copyText: "Fixed.")), pieces: [], delivery: .sent, turn: "r1"),
            ChatItem(id: "u2", role: .user, pieces: [.text("again")], delivery: .sent, turn: "r2"),
            ChatItem(id: "f", role: .failure(Failure(messageId: "f", reason: "Rate limited")), pieces: [], delivery: .sent, turn: "r2"),
            ChatItem(id: "r2:status", role: .turnEnd(ChatItem.TurnEnd(reason: "error", durationMs: 10, tools: 0, copyText: nil)), pieces: [], delivery: .sent, turn: "r2"),
            ChatItem(id: "u3", role: .user, pieces: [.text("hello")], delivery: .sending),
            ChatItem(id: "x", role: .agent, pieces: [.text("thinking out loud")], delivery: .sent, turn: "r3"),
        ]
        let state = CallTargetState.from(snapshot, target: CallTarget(agentId: "a", title: "A", kind: .bot, status: .idle))
        XCTAssertEqual(state.turns, [
            CallTurn(id: "r1", user: "fix it", reply: "Fixed."),
            CallTurn(id: "r2", user: "again", ended: "error", error: "Rate limited"),
        ])
        XCTAssertEqual(state.unanswered?.text, "hello")
        XCTAssertEqual(state.unanswered?.delivery, .queued)
        XCTAssertEqual(state.messages.filter { $0.role == .assistant }.map(\.text), ["Looking", "Fixed.", "thinking out loud"])
        XCTAssertFalse(state.messages.last!.final)
        XCTAssertTrue(state.hasDraft)
        XCTAssertEqual(state.target.status, .running)
        XCTAssertTrue(state.writable)
    }
}

@MainActor
final class CallSessionTests: XCTestCase {
    func testAConnectionWithoutAGrantEndsAtOnceWithoutTheMicrophone() async {
        var asked = false
        let session = CallSession(grants: UnconfiguredCallGrants(), permission: { asked = true; return true }) { _, _, _ in
            XCTFail("never connects")
            return FakeCallConnection()
        }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        XCTAssertEqual(session.state, .ended(.notSetUp))
        await Task.yield()
        XCTAssertFalse(asked)
        session.stop()
        XCTAssertEqual(session.state, .idle)
    }

    func testNoMicrophoneEndsTheCall() async {
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { false }) { _, _, _ in FakeCallConnection() }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        XCTAssertEqual(session.state, .connecting)
        await waitUntil { session.state != .connecting }
        XCTAssertEqual(session.state, .ended(.microphonePermission))
    }

    func testARefusedGrantSaysWhy() async {
        let session = CallSession(grants: FakeGrants(.refused(.subscriptionRequired)), permission: { true }) { _, _, _ in FakeCallConnection() }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { session.state != .connecting }
        XCTAssertEqual(session.state, .ended(.subscriptionRequired))
    }

    func testALiveCallGetsItsContextOnceItConnectsAndNeverAPrompt() async {
        let connection = FakeCallConnection()
        var started: (CallGrant, CallStart)?
        var events: CallEvents?
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { true }, now: { 42 }) { grant, start, callEvents in
            started = (grant, start)
            events = callEvents
            return connection
        }
        session.start(language: "pl", context: { "{\"schema\":1}" }, tool: { _ in CallToolResult(text: "") })
        // Before it connects, nothing is sent and nothing is lost.
        session.deliver(CallUpdate(context: ["early"]))
        await waitUntil { if case .active = session.state { true } else { false } }
        XCTAssertEqual(session.state, .active(.listening, muted: false, since: 42))
        XCTAssertEqual(started?.0.conversationToken, "t")
        XCTAssertEqual(started?.1, CallStart(context: "{\"schema\":1}", language: "pl"))
        await waitUntil { connection.updates.count == 1 }
        XCTAssertEqual(connection.updates, ["early"])
        events?.activity(.agentSpeaking, 0)
        session.deliver(CallUpdate(context: ["c1"]))
        await waitUntil { connection.updates.count == 2 }
        events?.activity(.listening, 0)
        XCTAssertEqual(connection.updates, ["early", "c1"])
        await session.toggleMute()
        XCTAssertEqual(session.state, .active(.listening, muted: true, since: 42))
        XCTAssertEqual(connection.muted, true)
        events?.disconnected()
        XCTAssertEqual(session.state, .ended(.connection))
        await waitUntil { connection.ended }
    }

    /// An update that takes long doesn't let the next one overtake it.
    func testContextUpdatesLandInTheOrderGiven() async {
        let connection = FakeCallConnection()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { true }, now: { 42 }) { _, _, _ in connection }
        session.start(language: nil, context: { "{}" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        connection.slowFirst = .milliseconds(200)
        session.deliver(CallUpdate(context: ["first"]))
        session.deliver(CallUpdate(context: ["second"]))
        session.deliver(CallUpdate(context: ["third"]))
        await waitUntil { connection.updates.count == 3 }
        XCTAssertEqual(connection.updates, ["first", "second", "third"])
        session.stop()
    }

    func testContextTooMuchForTheWaitIsLetGoWholeAndAskedFor() async {
        let connection = FakeCallConnection()
        let gate = AsyncStream<Void>.makeStream()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true }) { _, _, _ in
            for await _ in gate.stream { break }
            return connection
        }
        var overflows = 0
        session.onOverflow = { overflows += 1 }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        let line = String(repeating: "x", count: 1023)
        for _ in 0..<40 { session.deliver(CallUpdate(context: [line])) }
        XCTAssertEqual(overflows, 1)
        session.deliver(CallUpdate(context: ["resync"]))
        gate.continuation.yield()
        await waitUntil { connection.updates.count == 1 }
        // What was over the limit went whole; what came after it waits on.
        let lines = connection.updates.first?.split(separator: "\n") ?? []
        XCTAssertEqual(lines.count, 8)
        XCTAssertEqual(lines.last, "resync")
        session.stop()
    }

    /// Directory news too big for one update goes in bounded updates once
    /// connected, each after the one before; news an overflow lost before
    /// the call connected is owed again by the resync, so none of it is lost.
    func testDirectoryNewsLostToTheWaitIsOwedAgainAndAllOfItGoes() async throws {
        let many = (0..<150).map { CallTarget(agentId: "x\($0)", title: "Task \($0)", kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: many, states: [:], focus: nil)
        let context = CallContext(targets: targets)
        let connection = FakeCallConnection()
        let gate = AsyncStream<Void>.makeStream()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true }) { _, _, _ in
            for await _ in gate.stream { break }
            return connection
        }
        var overflows = 0
        session.onOverflow = { overflows += 1 }
        _ = await context.initial()
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        // Waiting to connect, other context already waits.
        let filler = String(repeating: "f", count: 1023)
        for _ in 0..<24 { session.deliver(CallUpdate(context: [filler])) }
        // 300 new conversations, far more than one update holds.
        let parent = CallTarget.Parent(id: "task:x149", title: "Task 149", kind: "task", agentId: "x149")
        let late = (0..<300).map { CallTarget(agentId: "n\($0)", title: "Late \($0) " + String(repeating: "z", count: 150), kind: .subtask, status: .idle, parents: [parent]) }
        await targets.setDirectory(many + late)
        _ = await context.directoryChanged(many + late)
        let flush = await context.flushDirectory()
        XCTAssertLessThan(flush.context.reduce(0) { $0 + $1.utf8.count + 1 }, CallSession.pendingBytes / 2 + CallContext.Limits.directoryBytes)
        session.deliver(flush)
        // Too much with what waited: let go whole, and put right.
        XCTAssertEqual(overflows, 1)
        session.deliver(await context.resync())
        await CallContext.drain(context, into: session)
        var owes = await context.owesDirectory
        XCTAssertTrue(owes, "nothing more goes before the call is connected")
        gate.continuation.yield()
        await waitUntil { if case .active = session.state { true } else { false } }
        await CallContext.drain(context, into: session)
        await session.delivered()
        owes = await context.owesDirectory
        XCTAssertFalse(owes)
        XCTAssertEqual(overflows, 1)
        let all = connection.updates.joined(separator: "\n")
        for index in 0..<300 { XCTAssertTrue(all.contains("Late \(index) "), "Late \(index)") }
        for update in connection.updates { XCTAssertLessThanOrEqual(update.utf8.count, CallSession.pendingBytes) }
        XCTAssertGreaterThan(connection.updates.count, 2)
        session.stop()
    }

    /// However often it is asked, a call's drain queues one update of the
    /// directory's news while the connection is still writing the last.
    func testOneDrainQueuesOneUpdateAtATime() async throws {
        let many = (0..<150).map { CallTarget(agentId: "x\($0)", title: "Task \($0)", kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: many, states: [:], focus: nil)
        let context = CallContext(targets: targets)
        let connection = FakeCallConnection()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true }) { _, _, _ in connection }
        _ = await context.initial()
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        let parent = CallTarget.Parent(id: "task:x149", title: "Task 149", kind: "task", agentId: "x149")
        let late = (0..<300).map { CallTarget(agentId: "n\($0)", title: "Late \($0) " + String(repeating: "z", count: 150), kind: .subtask, status: .idle, parents: [parent]) }
        await targets.setDirectory(many + late)
        _ = await context.directoryChanged(many + late)
        connection.paused = true
        session.deliver(await context.flushDirectory())
        await waitUntil { connection.begun.count == 1 }
        let owed = await context.owed.count
        let drain = DirectoryDrain(context: context, session: session)
        // Asked by every state change, a flush and a resync at once, while
        // the connection still writes: nothing more is taken.
        for _ in 0..<6 { drain.start() }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(connection.begun.count, 1)
        var left = await context.owed.count
        XCTAssertEqual(left, owed)
        // Written: one update more, and while that one is written, asked
        // again and again, still that one alone.
        connection.resume()
        connection.paused = true
        await waitUntil { connection.begun.count == 2 }
        for _ in 0..<6 { drain.start() }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(connection.begun.count, 2)
        left = await context.owed.count
        let batch = connection.begun[1].components(separatedBy: "Late ").count - 1
        XCTAssertGreaterThan(batch, 0)
        XCTAssertEqual(owed - left, batch)
        connection.resume()
        // Then the rest, one after another, all of it.
        for _ in 0..<200 where await context.owesDirectory { try await Task.sleep(for: .milliseconds(10)) }
        await session.delivered()
        let all = connection.updates.joined(separator: "\n")
        for index in 0..<300 { XCTAssertTrue(all.contains("Late \(index) "), "Late \(index)") }
        drain.cancel()
        session.stop()
    }

    /// Sizes are counted as the JSON that carries them: names full of
    /// quotes, backslashes, slashes and control characters keep every
    /// update within its budget, and a resync never overflows the wait.
    func testBudgetsHoldInEncodedJSON() async throws {
        let nasty = "\"q\" \\b\\ /s/ \u{1}\u{2}\u{7}\u{1B}"
        let many = (0..<400).map { CallTarget(agentId: "x\($0)", title: "\($0) " + String(repeating: nasty, count: 8), kind: .task, status: .idle) }
        let visits = Array(many.prefix(4))
        var states: [String: CallTargetState] = [:]
        for target in visits { states[target.agentId] = CallTargetState(target: target) }
        let targets = FakeCallTargets(directory: Array(many.prefix(200)), states: states, focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for target in visits {
            _ = await context.focusChanged(to: target.agentId)
            _ = await context.targetChanged(CallTargetState(target: target))
            let words = (0..<6).map { CallMessage(id: "\(target.agentId)m\($0)", role: .assistant, text: String(repeating: nasty, count: 200)) }
            _ = await context.targetChanged(CallTargetState(target: target, messages: words))
        }
        await targets.setDirectory(many)
        _ = await context.directoryChanged(many)
        func size(_ update: CallUpdate) -> Int { update.context.reduce(0) { $0 + $1.utf8.count + 1 } }
        let flush = await context.flushDirectory()
        XCTAssertLessThanOrEqual(size(flush), CallSession.pendingBytes)
        for line in flush.context {
            let event = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            let limit = event["event"] as? String == "directory" ? CallContext.Limits.directoryBytes : CallContext.Limits.entriesBytes
            XCTAssertLessThanOrEqual(line.utf8.count, limit + 64)
        }
        let resync = await context.resync()
        XCTAssertLessThanOrEqual(size(resync), CallSession.pendingBytes)
        while await context.owesDirectory {
            let more = await context.moreDirectory()
            XCTAssertLessThanOrEqual(size(more), CallSession.pendingBytes / 2)
        }
        // Through a call that isn't connected yet: the resync waits, whole.
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), permission: { true }) { _, _, _ in
            try await Task.sleep(for: .seconds(30))
            return FakeCallConnection()
        }
        var overflows = 0
        session.onOverflow = { overflows += 1 }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        session.deliver(resync)
        XCTAssertEqual(overflows, 0)
        // Titles from the sidebar carry no control characters at all.
        XCTAssertEqual(CallTarget.clean("a\u{1}b\nc\u{200D}d"), "a b c\u{200D}d")
        session.stop()
    }

    func testWhatAnEndedCallStillSaysGoesNowhere() async {
        let connection = FakeCallConnection()
        var events: CallEvents?
        var levels: [Double] = []
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { true }) { _, _, callEvents in
            events = callEvents
            return connection
        }
        session.onLevel = { levels.append($0) }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        session.stop()
        XCTAssertEqual(session.state, .idle)
        await waitUntil { connection.ended }
        XCTAssertTrue(connection.ended)
        let heard = levels.count
        events?.activity(.agentSpeaking, 1)
        events?.disconnected()
        session.deliver(CallUpdate(context: ["late"]))
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(levels.count, heard)
        XCTAssertTrue(connection.updates.isEmpty)
    }

    func testAConnectionThatOpensAfterTheHangUpIsClosed() async {
        let connection = FakeCallConnection()
        let gate = AsyncStream<Void>.makeStream()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { true }) { _, _, _ in
            for await _ in gate.stream { break }
            return connection
        }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        try? await Task.sleep(for: .milliseconds(20))
        session.stop()
        gate.continuation.yield()
        await waitUntil { connection.ended }
        XCTAssertTrue(connection.ended)
        XCTAssertEqual(session.state, .idle)
    }

    func testAPublicAgentIsCalledByItsIDAlone() async throws {
        let grants = PublicAgentCallGrants(agentId: "agent_public")
        XCTAssertTrue(grants.isConfigured)
        let result = try await grants.grant()
        XCTAssertEqual(result, .granted(CallGrant(agentId: "agent_public")))
        let connection = FakeCallConnection()
        var started: CallGrant?
        let session = CallSession(grants: grants, permission: { true }) { grant, _, _ in
            started = grant
            return connection
        }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        XCTAssertEqual(started?.agentId, "agent_public")
        XCTAssertNil(started?.conversationToken)
        session.stop()
    }

    func testOnlyAnAgentIDFromTheBuildIsTaken() {
        XCTAssertEqual(CallAgent.id(" agent_01abc \n"), "agent_01abc")
        XCTAssertNil(CallAgent.id("$(HAPPY_CALL_AGENT_ID)"))
        XCTAssertNil(CallAgent.id(""))
        XCTAssertNil(CallAgent.id("agent_"))
        XCTAssertNil(CallAgent.id("sk_live"))
        XCTAssertNil(CallAgent.id(nil))
        // The test bundle has no such key: no build, no agent.
        XCTAssertNil(CallAgent.hostedAgentId)
    }

    func testNoFreeTimeLeftEndsAtTheTapWithoutTheMicrophone() async {
        let store = MemoryUsageStore()
        let allowance = CallAllowance(store: store, free: 60, window: 1_000)
        allowance.record(call: "old", from: 0, to: 60)
        var asked = false
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), allowance: allowance,
                                  permission: { asked = true; return true }, now: { 100 }) { _, _, _ in
            XCTFail("never connects")
            return FakeCallConnection()
        }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        XCTAssertEqual(session.state, .ended(.limitReached))
        await Task.yield()
        XCTAssertFalse(asked)
    }

    func testALiveCallIsCountedAndEndsWhenTheFreeTimeIsGone() async {
        let store = MemoryUsageStore()
        let clock = LockedClock()
        clock.value = 1_000
        let allowance = CallAllowance(store: store, free: 0.3, window: 1_000)
        let connection = FakeCallConnection()
        let started = Date()
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), allowance: allowance,
                                  permission: { true }, now: { clock.value + Date().timeIntervalSince(started) }) { _, _, _ in connection }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { session.state == .ended(.limitReached) }
        XCTAssertEqual(session.state, .ended(.limitReached))
        await waitUntil { connection.ended }
        XCTAssertTrue(connection.ended)
        XCTAssertEqual(store.saved.spans.count, 1)
        XCTAssertEqual(store.saved.used(at: 1_001, window: 1_000), 0.3, accuracy: 0.1)
    }

    func testAStoppedCallCountsUpToItsEnd() async {
        let store = MemoryUsageStore()
        let clock = LockedClock()
        clock.value = 500
        let allowance = CallAllowance(store: store, free: 1_200, window: 1_000)
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), allowance: allowance,
                                  permission: { true }, now: { clock.value }) { _, _, _ in FakeCallConnection() }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        clock.value = 545
        session.stop()
        XCTAssertEqual(allowance.remaining(at: 545), 1_155)
        // Kept by the store, for the next launch.
        XCTAssertEqual(CallAllowance(store: store, free: 1_200, window: 1_000).remaining(at: 545), 1_155)
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<500 where !condition() { try? await Task.sleep(for: .milliseconds(2)) }
    }
}

final class CallUsageTests: XCTestCase {
    func testUseIsCountedOverTheLastThirtyDaysRolling() {
        let day = 86_400.0
        var usage = CallUsage()
        usage.record(call: "a", from: 0, to: 600)
        usage.record(call: "b", from: 10 * day, to: 10 * day + 300)
        XCTAssertEqual(usage.used(at: 20 * day, window: 30 * day), 900)
        // Thirty days after the first call, only its last part is inside.
        XCTAssertEqual(usage.used(at: 30 * day + 400, window: 30 * day), 200 + 300)
        XCTAssertEqual(usage.used(at: 41 * day, window: 30 * day), 0)
    }

    func testFreeTimeComesBackAsTheOldestCallPassesOut() {
        let day = 86_400.0
        var usage = CallUsage()
        usage.record(call: "a", from: 0, to: 600)
        usage.record(call: "b", from: 10 * day, to: 10 * day + 600)
        // 20 minutes used: free again once a second of the first call is past 30 days.
        XCTAssertEqual(usage.freeAgain(after: 11 * day, free: 1200, window: 30 * day), 30 * day + 1)
        // Not used up: free now.
        XCTAssertEqual(usage.freeAgain(after: 11 * day, free: 1800, window: 30 * day), 11 * day)
        // A call after now (the clock put back) never passes out.
        var later = CallUsage()
        later.record(call: "c", from: 100 * day, to: 100 * day + 1200)
        XCTAssertNil(later.freeAgain(after: 1, free: 1200, window: 30 * day))
    }

    func testPuttingTheClockBackGivesNoTimeBack() {
        var usage = CallUsage()
        usage.record(call: "a", from: 1_000, to: 1_600)
        XCTAssertEqual(usage.used(at: 1_600, window: 10_000), 600)
        XCTAssertEqual(usage.used(at: 100, window: 10_000), 600)
        // A call that went on while the clock went back still only grows.
        usage.record(call: "a", from: 1_000, to: 50)
        XCTAssertEqual(usage.spans, [CallUsage.Span(id: "a", start: 1_000, end: 1_600)])
    }

    func testTheSameCallOnlyGrows() {
        var usage = CallUsage()
        usage.record(call: "a", from: 0, to: 10)
        usage.record(call: "a", from: 0, to: 30)
        usage.record(call: "a", from: 0, to: 20)
        XCTAssertEqual(usage.spans, [CallUsage.Span(id: "a", start: 0, end: 30)])
    }

    func testTheDefaultIsTwentyMinutesInThirtyDaysAndNoCountOfCalls() async {
        await MainActor.run {
            let allowance = CallAllowance(store: MemoryUsageStore())
            XCTAssertEqual(allowance.remaining(at: 0), 1_200)
            for index in 0..<150 { allowance.record(call: "\(index)", from: Double(index * 10), to: Double(index * 10 + 1)) }
            XCTAssertEqual(allowance.remaining(at: 2_000), 1_050)
        }
    }

    func testACallTheAppNeverSawEndCountsToItsLastCheckpointOnce() async {
        await MainActor.run {
            let store = MemoryUsageStore()
            let first = CallAllowance(store: store, free: 1_200, window: 10_000)
            first.record(call: "a", from: 100, to: 110)
            first.record(call: "a", from: 100, to: 120)
            // Killed here; the next launch reads what was written down.
            let next = CallAllowance(store: store, free: 1_200, window: 10_000)
            XCTAssertEqual(next.remaining(at: 500), 1_180)
            next.record(call: "b", from: 600, to: 630)
            XCTAssertEqual(next.remaining(at: 700), 1_150)
        }
    }

    /// The welcome shows once, and only while something is on sale; seen,
    /// however it was closed, the button calls. Kept in the device's
    /// defaults, never an account's.
    func testTheWelcomeShowsOnceAndOnlyWhileSomethingIsOnSale() throws {
        let suite = "call-intro-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Nothing on sale: the button just calls, and the welcome stays due for when something is.
        XCTAssertFalse(CallIntro(defaults: defaults).welcomes(.unavailable))
        XCTAssertTrue(CallIntro(defaults: defaults).due)
        XCTAssertTrue(CallIntro(defaults: defaults).welcomes(.preview(price: "$20")))
        XCTAssertFalse(CallIntro(defaults: defaults).due)
        XCTAssertFalse(CallIntro(defaults: defaults).welcomes(.preview(price: "$20")))
        XCTAssertEqual(defaults.bool(forKey: CallIntro.key), true)
    }

    func testOldSpansAreForgotten() async {
        await MainActor.run {
            let store = MemoryUsageStore()
            let allowance = CallAllowance(store: store, free: 100, window: 1_000)
            allowance.record(call: "a", from: 0, to: 10)
            allowance.record(call: "b", from: 2_000, to: 2_010)
            XCTAssertEqual(store.saved.spans.map(\.id), ["b"])
        }
    }
}

// MARK: Fakes

final class MemoryUsageStore: CallUsageStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored = CallUsage()
    var saved: CallUsage { lock.lock(); defer { lock.unlock() }; return stored }
    func load() -> CallUsage { saved }
    func save(_ usage: CallUsage) { lock.lock(); stored = usage; lock.unlock() }
}

final class LockedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0.0
    var value: Double {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); stored = newValue; lock.unlock() }
    }
}

actor FakeCallTargets: CallTargets {
    private var entries: [CallTarget]
    private var states: [String: CallTargetState]
    private let focus: String?
    private var delay: Duration?
    private(set) var sends: [(agentId: String, text: String, id: String)] = []
    private(set) var follows: [(String, Bool)] = []
    private(set) var opens: [String] = []

    init(directory: [CallTarget], states: [String: CallTargetState], focus: String?) {
        entries = directory
        self.states = states
        self.focus = focus
    }

    func set(_ id: String, _ state: CallTargetState) { states[id] = state }
    func setDirectory(_ directory: [CallTarget]) { entries = directory }
    func setSendDelay(_ delay: Duration?) { self.delay = delay }

    func directory() async -> [CallTarget] { entries }
    func state(of agentId: String) async -> CallTargetState? { states[agentId] }
    func focused() async -> String? { focus }
    func open(_ agentId: String) async -> Bool { opens.append(agentId); return states[agentId] != nil }
    func send(_ agentId: String, text: String, id: String) async -> CallSendOutcome {
        if let delay { try? await Task.sleep(for: delay) }
        sends.append((agentId, text, id))
        return .queued
    }
    func follow(_ agentId: String, _ following: Bool) async { follows.append((agentId, following)) }
}

struct FakeGrants: CallGrantSource {
    let result: CallGrantResult
    init(_ result: CallGrantResult) { self.result = result }
    var isConfigured: Bool { true }
    func grant() async throws -> CallGrantResult { result }
}

@MainActor
final class FakeCallConnection: CallConnection {
    var updates: [String] = []
    var muted = false
    var ended = false
    func end() async { ended = true }
    func setMuted(_ muted: Bool) async throws { self.muted = muted }
    /// Each update waits this long before it lands, the first one longest when set.
    var slowFirst: Duration?
    /// Updates as they begin to be written; while `paused`, none finishes.
    var begun: [String] = []
    var paused = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func resume() {
        paused = false
        waiting.forEach { $0.resume() }
        waiting.removeAll()
    }
    func update(_ context: String) async throws {
        begun.append(context)
        if paused { await withCheckedContinuation { waiting.append($0) } }
        if let slow = slowFirst {
            slowFirst = nil
            try? await Task.sleep(for: slow)
        }
        updates.append(context)
    }
}
