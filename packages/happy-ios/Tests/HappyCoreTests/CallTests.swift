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

    func testTheFirstSnapshotHoldsTheFocusWithItsLastTwoTurnsAndThePendingMessage() async throws {
        let context = CallContext(targets: backend(), now: { 1_700_000_000 })
        let snapshot = try object(await context.initial())
        XCTAssertEqual(snapshot["schema"] as? Int, 1)
        XCTAssertEqual(snapshot["focusRevision"] as? Int, 0)
        XCTAssertEqual(snapshot["tools"] as? [String], ["listSessions", "getSessionContext", "openSession", "sendMessage"])
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        XCTAssertEqual(focus["targetRef"] as? String, "s1")
        XCTAssertEqual(focus["title"] as? String, "Backend")
        XCTAssertNil(focus["hasDraft"])
        XCTAssertNil(focus["messages"])
        // The last two turns that answered: the steering one in between is skipped.
        let turns = try XCTUnwrap(focus["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.map { $0["user"] as? String }, ["second ask", "third ask"])
        XCTAssertEqual(turns.map { $0["assistant"] as? String }, ["second answer", "third answer"])
        XCTAssertEqual(focus["olderTurns"] as? Bool, true)
        let pending = try XCTUnwrap(focus["pendingUserMessage"] as? [String: Any])
        XCTAssertEqual(pending["text"] as? String, "still waiting")
        XCTAssertEqual(pending["delivery"] as? String, "accepted")
        let directory = try XCTUnwrap(snapshot["directory"] as? [[String: Any]])
        XCTAssertEqual(directory.map { $0["targetRef"] as? String }, ["s1", "s2"])
        XCTAssertEqual(directory[1]["status"] as? String, "running")
        let followed = await context.followed
        XCTAssertEqual(followed, ["a"])
    }

    func testTheSnapshotKeepsItsBudgets() async throws {
        let long = String(repeating: "é", count: 5000)
        let turns = (0..<10).map { CallTurn(id: "r\($0)", user: long, reply: long) }
        let many = (0..<300).map { CallTarget(agentId: "x\($0)", title: String(repeating: "n", count: 200), kind: .conversation, status: .idle) }
        let targets = FakeCallTargets(directory: [backendTarget] + many,
                                      states: ["a": CallTargetState(target: backendTarget, turns: turns, unanswered: CallMessage(id: "p", role: .user, text: long))], focus: "a")
        let text = await CallContext(targets: targets).initial()
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        let snapshot = try object(text)
        XCTAssertEqual(snapshot["directoryTruncated"] as? Bool, true)
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

    func testReadingAConversationGivesItsLastTwoTurnsAndChangesNothingHeard() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let read = try object(await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.map { $0["assistant"] as? String }, ["second answer", "third answer"])
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
        XCTAssertEqual(try events(next).map { $0["delta"] as? String }, ["new"])
    }

    func testSettingsOrHomeInFrontKeepTheVisited() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.handle(CallToolCall(id: "o", name: "openSession", parameters: Data(#"{"targetRef":"s2","focusRevision":0}"#.utf8)))
        _ = await context.focusChanged(to: "b")
        let settings = try events(await context.focusChanged(to: nil))
        XCTAssertEqual(settings.first?["event"] as? String, "focus")
        XCTAssertTrue(settings.first?["targetRef"] is NSNull)
        XCTAssertEqual(settings.first?["focusRevision"] as? Int, 2)
        let followed = await context.followed
        XCTAssertEqual(followed, ["b", "a"])
        // Still heard from while Settings is in front.
        let b = CallTargetState(target: docsTarget, working: true)
        _ = await context.targetChanged(b)
        var more = b
        more.messages = [CallMessage(id: "w", role: .assistant, text: "Working on it", final: false)]
        let words = try events(await context.targetChanged(more))
        XCTAssertEqual(words.map { $0["event"] as? String }, ["assistant_text"])
    }

    func testAFocusSaysWhichButNotItsHistory() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let focus = try events(await context.focusChanged(to: "a"))
        XCTAssertEqual(focus.count, 1)
        XCTAssertEqual(focus[0]["targetRef"] as? String, "s1")
        XCTAssertEqual(focus[0]["title"] as? String, "Backend")
        XCTAssertNil(focus[0]["turns"])
        XCTAssertFalse(focus.description.contains("answer"))
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

    // MARK: New words only

    func testOnlyNewWordsGoAsDeltasAtMostEveryHalfSecond() async throws {
        let time = LockedClock()
        time.value = 100
        let context = CallContext(targets: backend(focus: nil), now: { time.value })
        _ = await context.initial()
        _ = await context.focusChanged(to: "a")
        let old = [CallMessage(id: "x4", role: .assistant, text: "third answer")]
        func state(_ text: String, working: Bool = true) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: old + [CallMessage(id: "r", role: .assistant, text: text, final: !working)], working: working)
        }
        // The first sight is what was there: nothing goes.
        let first = await context.targetChanged(CallTargetState(target: backendTarget, messages: old))
        XCTAssertTrue(first.isEmpty)
        let look = try events(await context.targetChanged(state("Look")))
        XCTAssertEqual(look.map { $0["delta"] as? String }, ["Look"])
        XCTAssertEqual(look.first?["final"] as? Bool, false)
        time.value += 0.1
        let soon = await context.targetChanged(state("Looking"))
        XCTAssertTrue(soon.isEmpty)
        time.value += 0.5
        let later = try events(await context.targetChanged(state("Looking at it")))
        XCTAssertEqual(later.map { $0["delta"] as? String }, ["ing at it"])
        time.value += 0.1
        // The run over, the rest goes at once, whatever the clock.
        let done = try events(await context.targetChanged(state("Looking at it. Done.", working: false)))
        XCTAssertEqual(done.map { $0["delta"] as? String }, [". Done."])
        XCTAssertEqual(done.first?["final"] as? Bool, true)
        XCTAssertFalse(done.description.contains("third answer"))
        let again = await context.targetChanged(state("Looking at it. Done.", working: false))
        XCTAssertTrue(again.isEmpty)
    }

    func testARewrittenMessageIsSentWholeOnce() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        func state(_ text: String) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: text)])
        }
        _ = await context.targetChanged(state("Hello there"))
        let reset = try events(await context.targetChanged(state("Goodbye")))
        XCTAssertEqual(reset.map { $0["event"] as? String }, ["assistant_text_reset"])
        XCTAssertEqual(reset.first?["text"] as? String, "Goodbye")
        let grown = try events(await context.targetChanged(state("Goodbye now")))
        XCTAssertEqual(grown.map { $0["delta"] as? String }, [" now"])
    }

    func testAReplyStopsAtFourKilobytes() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        func state(_ count: Int) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: String(repeating: "é", count: count))])
        }
        let first = try events(await context.targetChanged(state(1000)))
        XCTAssertEqual((first.first?["delta"] as? String)?.utf8.count, 2000)
        let over = try events(await context.targetChanged(state(3000)))
        XCTAssertEqual((over.first?["delta"] as? String)?.utf8.count, 2096)
        XCTAssertEqual(over.first?["truncated"] as? Bool, true)
        let after = await context.targetChanged(state(4000))
        XCTAssertTrue(after.isEmpty)
    }

    func testDeltasKeepEachMessagesIdentityAndOrder() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        func state(_ first: String, _ second: String, working: Bool = true) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: [
                CallMessage(id: "p1", role: .assistant, text: first),
                CallMessage(id: "u", role: .user, text: "and?"),
                CallMessage(id: "p2", role: .assistant, text: second, final: !working),
            ], working: working)
        }
        let both = try events(await context.targetChanged(state("One.", "Two")))
        XCTAssertEqual(both.map { $0["messageId"] as? String }, ["p1", "p2"])
        XCTAssertEqual(both.map { $0["delta"] as? String }, ["One.", "Two"])
        XCTAssertEqual(both.map { $0["final"] as? Bool }, [true, false])
        let rest = try events(await context.targetChanged(state("One.", "Two, three.", working: false)))
        XCTAssertEqual(rest.map { $0["messageId"] as? String }, ["p2"])
        XCTAssertEqual(rest.map { $0["delta"] as? String }, [", three."])
    }

    func testTheSameWordsFinishedSayTheirEndOnce() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        func state(working: Bool) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: "All done.", final: !working)], working: working)
        }
        let words = try events(await context.targetChanged(state(working: true)))
        XCTAssertEqual(words.map { $0["final"] as? Bool }, [false])
        let end = try events(await context.targetChanged(state(working: false)))
        XCTAssertEqual(end.count, 1)
        XCTAssertEqual(end.first?["delta"] as? String, "")
        XCTAssertEqual(end.first?["final"] as? Bool, true)
        let again = await context.targetChanged(state(working: false))
        XCTAssertTrue(again.isEmpty)
    }

    func testWhatTheWaitLostIsPutRightInOneGo() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.focusChanged(to: "b")
        _ = await context.focusChanged(to: "a")
        func state(_ text: String) -> CallTargetState {
            CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: text, final: false)], working: true)
        }
        _ = await context.targetChanged(state("Half"))
        try? await Task.sleep(for: .milliseconds(600))
        _ = await context.targetChanged(state("Half way"))
        _ = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: "Half way")],
                                                        turns: [CallTurn(id: "x", ended: "error", error: "Boom")], working: true))
        // Say every one of those was lost: the agent gets the focus as it is, and each message whole.
        let fixed = try events(await context.resync())
        XCTAssertEqual(fixed.first?["event"] as? String, "focus")
        XCTAssertEqual(fixed.first?["resync"] as? Bool, true)
        XCTAssertEqual(fixed.first?["focusRevision"] as? Int, 2)
        XCTAssertEqual(fixed.first?["targetRef"] as? String, "s1")
        XCTAssertEqual(fixed.dropFirst().map { $0["event"] as? String }, ["session_error", "assistant_text_reset"])
        XCTAssertEqual(fixed.last?["text"] as? String, "Half way")
        XCTAssertEqual(fixed.last?["messageId"] as? String, "r")
        // Baseline history isn't streamed, so none of it comes back.
        XCTAssertFalse(fixed.description.contains("third answer"))
        // And words after it go on from there.
        let next = try events(await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: "Half way there")])))
        XCTAssertEqual(next.map { $0["delta"] as? String }, [" there"])
    }

    func testAReplyBeingWrittenWhenFirstSeenGoesFromItsStart() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        _ = await context.focusChanged(to: "b")
        _ = await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Halfway", final: false)], working: true))
        let next = try events(await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Halfway there")])))
        XCTAssertEqual(next.map { $0["delta"] as? String }, ["Halfway there"])
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
        XCTAssertEqual(stopped.first?["target"] as? String, "s1")
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
        let many = (0..<120).map { CallTarget(agentId: "x\($0)", title: $0 % 2 == 0 ? "Even \($0)" : "Odd \($0)", kind: .conversation, status: .idle) }
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

    func testTheDirectorySaysWhatCameWentOrWasRenamedButNoStatus() async throws {
        let context = CallContext(targets: backend())
        // Its watch answering at once, ahead of the snapshot that holds it all: nothing to say.
        let early = await context.directoryChanged([backendTarget, docsTarget])
        XCTAssertTrue(early.isEmpty)
        _ = await context.initial()
        var docs = docsTarget
        docs.status = .idle
        let status = await context.directoryChanged([backendTarget, docs])
        XCTAssertTrue(status.isEmpty)
        docs.title = "Docs site"
        let renamed = try events(await context.directoryChanged([backendTarget, docs]))
        XCTAssertEqual((renamed.first?["changed"] as? [[String: Any]])?.map { $0["title"] as? String }, ["Docs site"])
        // Gone, its reference can't be used, and it isn't heard from.
        let gone = await context.directoryChanged([docs])
        XCTAssertTrue(gone.context[0].contains(#""removed":["s1"]"#))
        let read = await tool(context, "getSessionContext", #"{"targetRef":"s1"}"#)
        XCTAssertTrue(read.isError)
        let followed = await context.followed
        XCTAssertTrue(followed.isEmpty)
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
    func update(_ context: String) async throws { updates.append(context) }
}
