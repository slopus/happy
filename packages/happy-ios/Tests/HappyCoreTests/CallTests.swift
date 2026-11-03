import Foundation
import XCTest
@testable import HappyCore

/// The agent connection's voice call: its context, its five tools and its
/// life, with the provider faked. Nothing here opens a microphone.
final class CallContextTests: XCTestCase {
    private func waitFor(_ condition: () async -> Bool) async {
        for _ in 0..<500 { if await condition() { return }; try? await Task.sleep(for: .milliseconds(2)) }
    }

    private func backend(focus: String? = "a", messages: Int = 3) -> FakeCallTargets {
        let a = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)
        let b = CallTarget(agentId: "b", title: "Docs", kind: .task, status: .running)
        let history = (0..<messages).map { index in
            CallMessage(id: "m\(index)", role: index % 2 == 0 ? .user : .assistant, text: "line \(index)", time: 1_700_000_000_000, delivery: index % 2 == 0 ? .accepted : nil)
        }
        return FakeCallTargets(directory: [a, b], states: [
            "a": CallTargetState(target: a, messages: history, hasDraft: true),
            "b": CallTargetState(target: b, working: true),
        ], focus: focus)
    }

    private func object(_ text: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    func testTheFirstSnapshotHoldsTheFocusAndTheDirectoryButNoDraft() async throws {
        let context = CallContext(targets: backend(), now: { 1_700_000_000 })
        let snapshot = try object(await context.initial())
        XCTAssertEqual(snapshot["schema"] as? Int, 1)
        XCTAssertEqual(snapshot["focusRevision"] as? Int, 0)
        XCTAssertEqual(snapshot["tools"] as? [String], ["listSessions", "getSessionContext", "openSession", "setSessionWatch", "sendMessage"])
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        XCTAssertEqual(focus["targetRef"] as? String, "s1")
        XCTAssertEqual(focus["title"] as? String, "Backend")
        XCTAssertEqual(focus["hasDraft"] as? Bool, true)
        XCTAssertEqual((focus["messages"] as? [[String: Any]])?.map { $0["text"] as? String }, ["line 0", "line 1", "line 2"])
        let directory = try XCTUnwrap(snapshot["directory"] as? [[String: Any]])
        XCTAssertEqual(directory.map { $0["targetRef"] as? String }, ["s1", "s2"])
        XCTAssertEqual(directory[1]["status"] as? String, "running")
        XCTAssertEqual(snapshot["historyTruncated"] as? Bool, false)
    }

    func testTheSnapshotKeepsItsBudgets() async throws {
        let long = String(repeating: "é", count: 5000)
        let a = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)
        let messages = (0..<40).map { CallMessage(id: "m\($0)", role: .assistant, text: long) }
        let many = (0..<300).map { CallTarget(agentId: "x\($0)", title: String(repeating: "n", count: 200), kind: .conversation, status: .idle) }
        let targets = FakeCallTargets(directory: [a] + many, states: ["a": CallTargetState(target: a, messages: messages)], focus: "a")
        let text = await CallContext(targets: targets).initial()
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        let snapshot = try object(text)
        XCTAssertEqual(snapshot["historyTruncated"] as? Bool, true)
        XCTAssertEqual(snapshot["directoryTruncated"] as? Bool, true)
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        let shown = try XCTUnwrap(focus["messages"] as? [[String: Any]])
        XCTAssertLessThanOrEqual(shown.count, CallContext.Limits.messages)
        for message in shown {
            XCTAssertLessThanOrEqual((message["text"] as? String)?.utf8.count ?? 0, CallContext.Limits.messageBytes)
            XCTAssertEqual(message["truncated"] as? Bool, true)
        }
        XCTAssertEqual(shown.last?["id"] as? String, "m39")
    }

    func testTruncationKeepsWholeCharacters() {
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 4), "aé")
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 7), "aé😀")
    }

    func testSendMessageQueuesTheExactTextOnceAndFollowsTheTarget() async throws {
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
        let followed = await context.followed
        XCTAssertEqual(followed, ["a", "b"])
    }

    func testSendMessageRefusesWhatItMustNotSend() async throws {
        let targets = backend()
        let a = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .needsInput)
        await targets.set("a", CallTargetState(target: a, needsInput: true))
        let context = CallContext(targets: targets)
        _ = await context.initial()
        func send(_ id: String, _ json: String) async -> CallToolResult {
            await context.handle(CallToolCall(id: id, name: "sendMessage", parameters: Data(json.utf8)))
        }
        let waiting = await send("1", #"{"targetRef":"s1","text":"yes","focusRevision":0}"#)
        XCTAssertTrue(waiting.isError)
        let stale = await send("2", #"{"targetRef":"s2","text":"go","focusRevision":3}"#)
        XCTAssertTrue(stale.isError)
        let nobody = await send("3", #"{"targetRef":"s9","text":"go","focusRevision":0}"#)
        XCTAssertTrue(nobody.isError)
        let empty = await send("4", #"{"targetRef":"s2","text":"  ","focusRevision":0}"#)
        XCTAssertTrue(empty.isError)
        let unknown = await context.handle(CallToolCall(id: "5", name: "processPermissionRequest", parameters: Data("{}".utf8)))
        XCTAssertTrue(unknown.isError)
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
    }

    func testASendWithNoAnswerInTimeIsUncertainAndNeverGoesUnderANewID() async throws {
        let targets = backend()
        await targets.setSendDelay(.seconds(30))
        let context = CallContext(targets: targets, toolDeadline: .milliseconds(50))
        _ = await context.initial()
        func send(_ call: String, _ text: String) async -> CallToolResult {
            await context.handle(CallToolCall(id: call, name: "sendMessage", parameters: Data("{\"targetRef\":\"s2\",\"text\":\"\(text)\",\"focusRevision\":0}".utf8)))
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
            let stale = await context.handle(CallToolCall(id: name, name: name, parameters: Data(#"{"targetRef":"s1","text":"go","focusRevision":0}"#.utf8)))
            XCTAssertTrue(stale.isError, name)
            XCTAssertTrue(stale.text.contains("screen changed"), name)
        }
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        let fresh = await context.handle(CallToolCall(id: "f", name: "sendMessage", parameters: Data(#"{"targetRef":"s1","text":"go","focusRevision":1}"#.utf8)))
        XCTAssertFalse(fresh.isError)
    }

    func testAnEndedCallRunsNoTools() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await context.close()
        let late = await context.handle(CallToolCall(id: "late", name: "sendMessage", parameters: Data(#"{"targetRef":"s2","text":"go","focusRevision":0}"#.utf8)))
        XCTAssertTrue(late.isError)
        let update = await context.targetChanged(CallTargetState(target: CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle), messages: [CallMessage(id: "n", role: .assistant, text: "new")]))
        XCTAssertTrue(update.isEmpty)
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
    }

    func testWatchesFollowAndLetGoUnderTheirCap() async throws {
        let many = (0..<10).map { CallTarget(agentId: "x\($0)", title: "T\($0)", kind: .conversation, status: .idle) }
        let targets = FakeCallTargets(directory: many, states: [:], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        func watch(_ ref: String, _ on: Bool) async -> CallToolResult {
            await context.handle(CallToolCall(id: "\(ref)\(on)", name: "setSessionWatch", parameters: Data("{\"targetRef\":\"\(ref)\",\"enabled\":\(on)}".utf8)))
        }
        for index in 1...7 { let result = await watch("s\(index)", true); XCTAssertFalse(result.isError) }
        let eighth = await watch("s8", true)
        XCTAssertTrue(eighth.isError)
        let off = await watch("s1", false)
        XCTAssertFalse(off.isError)
        let follows = await targets.follows
        XCTAssertEqual(follows.count, 8)
        XCTAssertEqual(follows.last?.0, "x0")
        XCTAssertEqual(follows.last?.1, false)
        let followed = await context.followed
        XCTAssertEqual(followed.count, 6)
    }

    func testAWatchNeedsARealBooleanAndAnythingElseChangesNothing() async throws {
        let targets = FakeCallTargets(directory: [CallTarget(agentId: "x", title: "X", kind: .task, status: .idle)], states: [:], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        _ = await context.handle(CallToolCall(id: "on", name: "setSessionWatch", parameters: Data(#"{"targetRef":"s1","enabled":true}"#.utf8)))
        for (index, bad) in [#"{"targetRef":"s1"}"#, #"{"targetRef":"s1","enabled":null}"#, #"{"targetRef":"s1","enabled":"false"}"#, #"{"targetRef":"s1","enabled":0}"#].enumerated() {
            let result = await context.handle(CallToolCall(id: "bad\(index)", name: "setSessionWatch", parameters: Data(bad.utf8)))
            XCTAssertTrue(result.isError, bad)
        }
        let followed = await context.followed
        XCTAssertEqual(followed, ["x"])
        let follows = await targets.follows
        XCTAssertEqual(follows.count, 1)
    }

    func testAFocusRevisionIsAnIntegerNotAString() async throws {
        let x = CallTarget(agentId: "x", title: "X", kind: .task, status: .idle)
        let targets = FakeCallTargets(directory: [x], states: ["x": CallTargetState(target: x)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for (index, bad) in [#""0""#, "true", "0.5", "null"].enumerated() {
            let result = await context.handle(CallToolCall(id: "o\(index)", name: "openSession", parameters: Data("{\"targetRef\":\"s1\",\"focusRevision\":\(bad)}".utf8)))
            XCTAssertTrue(result.isError, bad)
        }
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let fine = await context.handle(CallToolCall(id: "ok", name: "openSession", parameters: Data(#"{"targetRef":"s1","focusRevision":0}"#.utf8)))
        XCTAssertFalse(fine.isError)
        let schema = CallTool.openSession.parameters
        XCTAssertEqual(schema["properties"]?["focusRevision"]?["type"], .string("integer"))
        XCTAssertEqual(CallTool.setSessionWatch.parameters["properties"]?["enabled"]?["type"], .string("boolean"))
    }

    func testListSessionsPagesAndFilters() async throws {
        let many = (0..<120).map { CallTarget(agentId: "x\($0)", title: $0 % 2 == 0 ? "Even \($0)" : "Odd \($0)", kind: .conversation, status: .idle) }
        let context = CallContext(targets: FakeCallTargets(directory: many, states: [:], focus: nil))
        _ = await context.initial()
        let first = try object(await context.handle(CallToolCall(id: "1", name: "listSessions", parameters: Data("{}".utf8))).text)
        XCTAssertEqual((first["sessions"] as? [Any])?.count, 50)
        XCTAssertEqual(first["nextCursor"] as? String, "50")
        let odd = try object(await context.handle(CallToolCall(id: "2", name: "listSessions", parameters: Data(#"{"query":"odd","cursor":"50"}"#.utf8))).text)
        XCTAssertEqual((odd["sessions"] as? [Any])?.count, 10)
        XCTAssertNil(odd["nextCursor"])
    }

    func testADispatchedRunFinishingIsAnnouncedAfterItsWords() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        _ = await context.handle(CallToolCall(id: "t1", name: "sendMessage", parameters: Data(#"{"targetRef":"s2","text":"go","focusRevision":0}"#.utf8)))
        let sends = await targets.sends
        let sent = try XCTUnwrap(sends.first?.id)
        let b = CallTarget(agentId: "b", title: "Docs", kind: .task, status: .idle)
        let asked = CallMessage(id: sent, role: .user, text: "go", delivery: .accepted)
        // Idle for a moment before the message is taken: not finished.
        let flicker = await context.targetChanged(CallTargetState(target: b, messages: [asked], working: false))
        XCTAssertTrue(flicker.prompts.isEmpty)
        XCTAssertTrue(flicker.context.contains { $0.contains("run_finished") })
        let thinking = await context.targetChanged(CallTargetState(target: b, messages: [asked], working: true))
        XCTAssertTrue(thinking.prompts.isEmpty)
        let done = CallTargetState(target: b, messages: [asked, CallMessage(id: "r1", role: .assistant, text: "All green.")], working: false)
        let update = await context.targetChanged(done)
        XCTAssertEqual(update.context.count, 2)
        XCTAssertTrue(update.context[0].contains("All green."))
        XCTAssertTrue(update.context[1].contains("run_finished"))
        XCTAssertEqual(update.prompts, ["Docs finished. Tell the person its latest reply in a sentence or two."])
        // The same state again says nothing.
        let again = await context.targetChanged(done)
        XCTAssertTrue(again.isEmpty)
    }

    func testAConversationNobodyFollowsSaysNothingButItsRow() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        let b = CallTarget(agentId: "b", title: "Docs", kind: .task, status: .idle)
        let quiet = await context.targetChanged(CallTargetState(target: b, messages: [CallMessage(id: "r", role: .assistant, text: "secret")]))
        XCTAssertTrue(quiet.isEmpty)
        let row = await context.directoryChanged([CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle), b])
        XCTAssertEqual(row.context.count, 1)
        XCTAssertTrue(row.prompts.isEmpty)
        XCTAssertFalse(row.context[0].contains("secret"))
        // Gone, its reference can't be used.
        let gone = await context.directoryChanged([CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)])
        XCTAssertTrue(gone.context[0].contains(#""removed":["s2"]"#))
        let read = await context.handle(CallToolCall(id: "r", name: "getSessionContext", parameters: Data(#"{"targetRef":"s2"}"#.utf8)))
        XCTAssertTrue(read.isError)
    }

    func testPartialWordsAreCoalescedAndNeedsInputAsksForTheApp() async throws {
        var clock = 100.0
        let time = LockedClock()
        let context = CallContext(targets: backend(messages: 0), now: { time.value })
        _ = await context.initial()
        let a = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .running)
        func state(_ text: String, working: Bool = true, needsInput: Bool = false) -> CallTargetState {
            CallTargetState(target: a, messages: [CallMessage(id: "r", role: .assistant, text: text, final: !working)], working: working, needsInput: needsInput)
        }
        time.value = clock
        let first = await context.targetChanged(state("Look"))
        XCTAssertTrue(first.context.contains { $0.contains("Look") })
        clock += 0.1; time.value = clock
        let soon = await context.targetChanged(state("Looking"))
        XCTAssertFalse(soon.context.contains { $0.contains("Looking") })
        clock += 0.5; time.value = clock
        let later = await context.targetChanged(state("Looking at it"))
        XCTAssertTrue(later.context.contains { $0.contains("Looking at it") })
        let blocked = await context.targetChanged(state("Looking at it", needsInput: true))
        XCTAssertEqual(blocked.prompts, ["Backend needs the person in the app. Say so briefly; don't try to answer it."])
    }

    func testAnOpenQuestionIsAFlagWithoutItsWords() async throws {
        let targets = backend()
        let a = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .needsInput)
        await targets.set("a", CallTargetState(target: a, needsInput: true))
        let context = CallContext(targets: targets)
        let snapshot = try object(await context.initial())
        let focus = try XCTUnwrap(snapshot["focus"] as? [String: Any])
        XCTAssertEqual(focus["needsInput"] as? Bool, true)
        XCTAssertEqual(focus["status"] as? String, "needs_input")
    }

    func testAChatSnapshotReadsAsPublicWordsOnly() {
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.working = true
        snapshot.draft = "half typed"
        snapshot.items = [
            ChatItem(id: "u", role: .user, pieces: [.text("hello")], delivery: .sending),
            ChatItem(id: "x", role: .agent, pieces: [.text("thinking out loud")], delivery: .sent),
        ]
        let target = CallTarget(agentId: "a", title: "A", kind: .bot, status: .idle)
        let state = CallTargetState.from(snapshot, target: target)
        XCTAssertEqual(state.messages.map(\.text), ["hello", "thinking out loud"])
        XCTAssertEqual(state.messages[0].delivery, .queued)
        XCTAssertFalse(state.messages[1].final)
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

    func testALiveCallGetsItsContextOnceItConnectsAndPromptsWhenQuiet() async {
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
        session.deliver(CallUpdate(context: ["c1"], prompts: ["p1"]))
        await waitUntil { connection.updates.count == 2 }
        XCTAssertEqual(connection.updates, ["early", "c1"])
        XCTAssertTrue(connection.prompts.isEmpty)
        events?.activity(.listening, 0)
        await waitUntil { connection.prompts.count == 1 }
        XCTAssertEqual(connection.prompts, ["p1"])
        await session.toggleMute()
        XCTAssertEqual(session.state, .active(.listening, muted: true, since: 42))
        XCTAssertEqual(connection.muted, true)
        events?.disconnected()
        XCTAssertEqual(session.state, .ended(.connection))
        await waitUntil { connection.ended }
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
        session.deliver(CallUpdate(context: ["late"], prompts: ["late"]))
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(levels.count, heard)
        XCTAssertTrue(connection.updates.isEmpty)
        XCTAssertTrue(connection.prompts.isEmpty)
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
    var prompts: [String] = []
    var muted = false
    var ended = false
    func end() async { ended = true }
    func setMuted(_ muted: Bool) async throws { self.muted = muted }
    func update(_ context: String) async throws { updates.append(context) }
    func say(_ prompt: String) async throws { prompts.append(prompt) }
}
