import Foundation
@testable import HappyCore
import XCTest

final class MemoryHistoryStore: CallHistoryStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Data?
    private(set) var writes = 0
    func read() -> Data? { lock.lock(); defer { lock.unlock() }; return stored }
    func write(_ data: Data) { lock.lock(); stored = data; writes += 1; lock.unlock() }
}

@MainActor
final class CallHistoryTests: XCTestCase {
    /// Thirty slots, the interruptions among them; the oldest go first.
    func testThirtySlotsRollWithTheInterruptionsCounted() {
        let history = CallHistory(store: nil)
        for index in 0..<20 { history.heard("ask \(index)", at: Double(index)) }
        for index in 0..<10 { history.ended(.dropped, at: Double(20 + index)) }
        history.said("answer", event: 1, at: 30)
        XCTAssertEqual(history.slots.count, CallHistory.slots)
        XCTAssertEqual(history.slots.first, .person("ask 1", at: 1))
        XCTAssertEqual(history.slots.filter { $0.kind == .ended }.count, 10)
        XCTAssertEqual(history.slots.last, .assistant("answer", at: 30))
    }

    /// Written after every slot, a correction too: the next launch reads it whole.
    func testItIsKeptAcrossLaunchesAfterEverySlot() {
        let store = MemoryHistoryStore()
        let history = CallHistory(store: store)
        history.began()
        history.heard("  what's new?  ", at: 1)
        history.said("Three things finished, and the release task needs you.", event: 7, at: 2)
        XCTAssertEqual(store.writes, 2)
        history.corrected("Three things finished", event: 7)
        history.ended(.callLimit, at: 3)
        XCTAssertEqual(store.writes, 4)
        let next = CallHistory(store: store)
        XCTAssertEqual(next.slots, [.person("what's new?", at: 1), .assistant("Three things finished", at: 2), .ended(.callLimit, at: 3)])
        // A correction for another call's event changes nothing.
        next.began()
        next.corrected("x", event: 7)
        XCTAssertEqual(next.slots[1].text, "Three things finished")
        XCTAssertEqual(store.writes, 4)
    }

    func testOnlyTheUnaskedEndsSound() {
        XCTAssertEqual(CallEnding.allCases.filter(\.isUnexpected), [.dropped, .callLimit, .timeUsed, .silence])
    }

    // MARK: A call's history

    private func session(_ history: CallHistory, timing: CallCues.Timing = CallCues.Timing(), connection: FakeCallConnection = FakeCallConnection(),
                         allowance: CallAllowance? = nil, events: @escaping (CallEvents) -> Void = { _ in },
                         starts: @escaping (CallStart) -> Void = { _ in }) -> CallSession {
        CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g"))), allowance: allowance, permission: { true }, history: history,
                    timing: timing, tick: .milliseconds(20)) { _, start, callEvents in
            events(callEvents)
            starts(start)
            return connection
        }
    }

    private func live(_ session: CallSession) async {
        await waitUntil { if case .active = session.state { true } else { false } }
    }

    /// The person's words and the agent's as spoken, never its greeting,
    /// context, tools or a cue; the end it came to.
    func testACallKeepsWhatWasSaidAloudAndHowItEnded() async throws {
        let history = CallHistory(store: nil)
        let connection = FakeCallConnection()
        var events: CallEvents?
        let call = session(history, connection: connection) { events = $0 }
        call.start(language: nil, context: { "context" }, tool: { _ in CallToolResult(text: "{}") })
        await live(call)
        let said = try XCTUnwrap(events)
        said.said("Hi, Happy here", 1)
        call.deliver(CallUpdate(context: [#"{"event":"assistant_text","text":"build passed"}"#]))
        _ = await said.tool(CallToolCall(id: "t", name: "readConversation", parameters: Data(#"{"ref":"s1"}"#.utf8)))
        said.heard("Read me the release task.")
        said.said("It shipped at noon and the notes are drafted.", 2)
        said.corrected("It shipped at noon", 2)
        try await connection.cue(CallCue.silence(endsIn: 25).text)
        call.stop()
        XCTAssertEqual(history.slots.map(\.kind), [.person, .assistant, .ended])
        XCTAssertEqual(history.slots.map(\.text), ["Read me the release task.", "It shipped at noon", nil])
        XCTAssertEqual(history.slots.last?.ending, .hungUp)
    }

    /// A drop is kept, plays as unasked; a call that said nothing and was
    /// hung up leaves no line.
    func testADropIsKeptAndAPlainEmptyCallIsNot() async throws {
        let history = CallHistory(store: nil)
        var events: CallEvents?
        var ended: [CallEnding] = []
        let call = session(history) { events = $0 }
        call.onEnded = { ended.append($0) }
        call.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(call)
        call.stop()
        await waitUntil { ended == [.hungUp] }
        XCTAssertTrue(history.slots.isEmpty)
        call.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(call)
        events?.disconnected()
        XCTAssertEqual(call.state, .ended(.connection))
        XCTAssertEqual(history.slots.map(\.ending), [.dropped])
        await waitUntil { ended == [.hungUp, .dropped] }
        XCTAssertTrue(ended.last!.isUnexpected)
    }

    /// Quiet: the agent is cued to say so, then the call ends itself, kept
    /// as ended for silence; nothing the cue made is the person's.
    func testSilenceCuesTheAgentThenEndsTheCall() async throws {
        var timing = CallCues.Timing()
        timing.silenceWarning = 0.2
        timing.silenceEnd = 0.5
        let history = CallHistory(store: nil)
        let connection = FakeCallConnection()
        var ended: CallEnding?
        let call = session(history, timing: timing, connection: connection)
        call.onEnded = { ended = $0 }
        call.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(call)
        await waitUntil { ended != nil }
        XCTAssertEqual(connection.cues, [#"{"event":"silence","endsIn":"0 seconds"}"#])
        XCTAssertEqual(call.state, .idle)
        XCTAssertEqual(ended, .silence)
        XCTAssertEqual(history.slots, [.ended(.silence, at: history.slots.first?.at ?? 0)])
    }

    /// The agent agreed to restart: once it has said so, the call ends and a
    /// new one starts with what was said in its context.
    func testARestartCarriesTheCallOver() async throws {
        let history = CallHistory(store: nil)
        var events: CallEvents?
        var contexts: [String] = []
        var ended: [CallEnding] = []
        let call = session(history) { events = $0 }
        call.onEnded = { ended.append($0) }
        call.start(language: nil, context: { CallContext.recap(history.slots, now: Date().timeIntervalSince1970, bytes: 4096) ?? "" },
                   tool: { _ in CallToolResult(text: "") }) 
        await live(call)
        events?.said("Hi, Happy here", 1)
        events?.heard("Yes, restart it.")
        let result = call.requestRestart()
        XCTAssertFalse(result.isError, result.text)
        events?.activity(.agentSpeaking, 0)
        events?.said("Restarting now.", 2)
        events?.activity(.listening, 0)
        await waitUntil { ended == [.restarted] }
        await live(call)
        contexts = [CallContext.recap(history.slots, now: Date().timeIntervalSince1970, bytes: 4096) ?? ""]
        XCTAssertEqual(history.slots.map(\.kind), [.person, .assistant, .ended])
        XCTAssertEqual(history.slots.last?.ending, .restarted)
        XCTAssertTrue(contexts[0].contains("the person: Yes, restart it."), contexts[0])
        XCTAssertTrue(contexts[0].contains("the call restarted, carried over"), contexts[0])
    }

    /// No restart with under a minute of voice time left.
    func testARestartNeedsTimeLeft() async {
        let store = MemoryUsageStore()
        let allowance = CallAllowance(store: store, free: 1_000, window: 10_000)
        let now = Date().timeIntervalSince1970
        allowance.record(call: "used", from: now - 960, to: now)
        let call = session(CallHistory(store: nil), allowance: allowance)
        call.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(call)
        let result = call.requestRestart()
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.contains("isn't enough voice time"), result.text)
        call.stop()
    }

    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<1_000 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    }
}

final class CallCuesTests: XCTestCase {
    func testTheCuesAreFactsAsJSON() {
        XCTAssertEqual(CallCue.silence(endsIn: 25).text, #"{"event":"silence","endsIn":"25 seconds"}"#)
        XCTAssertEqual(CallCue.callEnding(reason: .callLimit, in: 300, restart: true).text,
                       #"{"event":"call_ending","reason":"call_limit","in":"about 5 minutes","restart":true}"#)
        XCTAssertEqual(CallCue.callEnding(reason: .timeUsed, in: 70, restart: false).text,
                       #"{"event":"call_ending","reason":"time_used","in":"about a minute","restart":false}"#)
        XCTAssertEqual(CallCue.spoken(20), "less than a minute")
        XCTAssertEqual(CallCue.mark, "[app] ")
    }

    /// Warned at 75 s of quiet, ended at 100 s: always before the
    /// provider's own 120 s. The person's words start it over; the agent's
    /// answer to the warning doesn't put the end off.
    func testSilenceWarnsThenEndsBeforeTheProviderWould() {
        var cues = CallCues(since: 0)
        XCTAssertNil(cues.next(.init(now: 74)))
        // Not while someone speaks.
        XCTAssertNil(cues.next(.init(now: 75, personSpeaking: true)))
        XCTAssertEqual(cues.next(.init(now: 76)), .cue(.silence(endsIn: 25)))
        cues.agentSpoke(at: 80)
        XCTAssertNil(cues.next(.init(now: 100)))
        XCTAssertEqual(cues.next(.init(now: 101)), .end(.silence))
        XCTAssertLessThan(cues.timing.silenceEnd, 120)
        // Heard after the warning: no end, and the clock starts over.
        var again = CallCues(since: 0)
        _ = again.next(.init(now: 75))
        again.heard(at: 90)
        XCTAssertNil(again.next(.init(now: 120)))
        XCTAssertEqual(again.next(.init(now: 165)), .cue(.silence(endsIn: 25)))
    }

    /// Five minutes before the one-call limit the agent offers a fresh
    /// call; it ends ours 10 s before the provider's.
    func testTheCallLimitIsOfferedFiveMinutesAhead() {
        var cues = CallCues(since: 0)
        cues.heard(at: 3_280)
        XCTAssertNil(cues.next(.init(now: 3_289)))
        XCTAssertEqual(cues.next(.init(now: 3_290)), .cue(.callEnding(reason: .callLimit, in: 300, restart: true)))
        cues.heard(at: 3_580)
        XCTAssertNil(cues.next(.init(now: 3_589)))
        XCTAssertEqual(cues.next(.init(now: 3_590)), .end(.callLimit))
    }

    /// The voice time: two minutes ahead of the free 20, five of the paid
    /// hours, never a restart; past the limit only if time outlasts it.
    func testTheVoiceTimeIsSaidAheadAndOffersNoRestart() {
        var free = CallCues(since: 0)
        XCTAssertNil(free.next(.init(now: 10, allowanceLeft: 121, allowanceTotal: 1_200)))
        XCTAssertEqual(free.next(.init(now: 11, allowanceLeft: 120, allowanceTotal: 1_200)), .cue(.callEnding(reason: .timeUsed, in: 120, restart: false)))
        XCTAssertNil(free.next(.init(now: 12, allowanceLeft: 100, allowanceTotal: 1_200)))
        var paid = CallCues(since: 0)
        XCTAssertNil(paid.next(.init(now: 10, allowanceLeft: 301, allowanceTotal: 18_000)))
        XCTAssertEqual(paid.next(.init(now: 11, allowanceLeft: 300, allowanceTotal: 18_000)), .cue(.callEnding(reason: .timeUsed, in: 300, restart: false)))
        // At the limit with a minute or less to spare after it: no fresh call on offer.
        var short = CallCues(since: 0)
        short.heard(at: 3_290)
        XCTAssertEqual(short.next(.init(now: 3_290, allowanceLeft: 360, allowanceTotal: 18_000)), .cue(.callEnding(reason: .callLimit, in: 300, restart: false)))
        XCTAssertFalse(short.canRestart(allowanceLeft: 59))
        XCTAssertTrue(short.canRestart(allowanceLeft: nil))
    }

    /// Asked to restart: once the agent's words on it are said, or it says none.
    func testARestartWaitsForTheAgentsWords() {
        var cues = CallCues(since: 0)
        cues.restartAsked(at: 10)
        XCTAssertNil(cues.next(.init(now: 11)))
        XCTAssertNil(cues.next(.init(now: 12, agentSpeaking: true)))
        cues.agentSpoke(at: 13)
        XCTAssertEqual(cues.next(.init(now: 13)), .restart)
        var silent = CallCues(since: 0)
        silent.restartAsked(at: 10)
        XCTAssertNil(silent.next(.init(now: 13)))
        XCTAssertEqual(silent.next(.init(now: 14)), .restart)
        var endless = CallCues(since: 0)
        endless.restartAsked(at: 10)
        XCTAssertEqual(endless.next(.init(now: 22, agentSpeaking: true)), .restart)
    }
}

final class CallRecapTests: XCTestCase {
    private let backend = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)

    /// The first context says what earlier calls said, oldest first, how
    /// long ago, the interruptions inline, after the time.
    func testTheFirstContextRecapsEarlierCalls() async {
        let now = 1_700_000_000.0
        let slots: [CallSlot] = [.person("Check the release task.", at: now - 840), .assistant("It finished; all checks passed.\nNothing failed.", at: now - 830),
                                 .ended(.dropped, at: now - 720), .person("Hello?", at: now - 30)]
        let targets = FakeCallTargets(directory: [backend], states: [:], focus: nil)
        let text = await CallContext(targets: targets, now: { now }, timeZone: TimeZone(identifier: "UTC")!).initial(previous: slots)
        let parts = text.components(separatedBy: "\n\n")
        XCTAssertEqual(parts[1], """
        Previous voice conversation (earlier calls, oldest first):
        - 14 minutes ago, the person: Check the release task.
        - 13 minutes ago, you: It finished; all checks passed.
           Nothing failed.
        - 12 minutes ago: the call dropped (connection lost)
        - just now, the person: Hello?
        """)
        let none = await CallContext(targets: targets, now: { now }).initial()
        XCTAssertFalse(none.contains("Previous voice conversation"))
    }

    /// Its own 8 KB, each line's words within 1 KB, the newest kept; under
    /// the 32 KB the older turns and the directory give way before it.
    func testTheRecapKeepsItsBudgetAndTheNewestLines() async {
        let now = 1_700_000_000.0
        let long = String(repeating: "word ", count: 400)
        let slots = (0..<30).map { CallSlot.assistant("\($0) " + long, at: now - Double(30 - $0)) }
        let recap = CallContext.recap(slots, now: now, bytes: CallContext.Limits.recapBytes)!
        XCTAssertLessThanOrEqual(recap.utf8.count, CallContext.Limits.recapBytes)
        XCTAssertTrue(recap.contains("Older lines aren't shown."))
        XCTAssertTrue(recap.contains("you: 29 word"))
        XCTAssertFalse(recap.contains("you: 0 word"))
        XCTAssertTrue(recap.contains(" more words)"))
        let reply = String(repeating: "é", count: 4000)
        let turns = (0..<5).map { CallTurn(id: "r\($0)", user: "ask \($0)", reply: "\($0) " + reply) }
        let many = (0..<300).map { CallTarget(agentId: "x\($0)", title: String(repeating: "n", count: 200), kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: [backend] + many, states: ["a": CallTargetState(target: backend, turns: turns)], focus: "a")
        let text = await CallContext(targets: targets, now: { now }).initial(previous: slots)
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        XCTAssertTrue(text.contains("Agent: 4 é"), "the newest turn stays")
        XCTAssertFalse(text.contains("Agent: 0 é"), "older turns went first")
        XCTAssertTrue(text.contains("you: 29 word"), "the newest of the recap stays")
    }

    /// navigate to happy://call/restart is the call's, at any focusRevision.
    func testNavigateRestartsTheCallWhenTheCallLetsIt() async throws {
        let context = CallContext(targets: FakeCallTargets(directory: [backend], states: [:], focus: nil))
        _ = await context.initial()
        let refused = await context.handle(CallToolCall(id: "1", name: "navigate", parameters: Data(#"{"to":"happy://call/restart","focusRevision":0}"#.utf8)))
        XCTAssertTrue(refused.isError)
        let asked = LockedClock()
        await context.onRestart { asked.value += 1; return CallToolResult(text: #"{"ok":true,"restarting":true}"#) }
        let restarted = await context.handle(CallToolCall(id: "2", name: "navigate", parameters: Data(#"{"to":"HAPPY://call/restart/","focusRevision":9}"#.utf8)))
        XCTAssertEqual(restarted.text, #"{"ok":true,"restarting":true}"#)
        XCTAssertEqual(asked.value, 1)
    }
}
