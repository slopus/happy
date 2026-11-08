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
        XCTAssertEqual(connection.cues, [#"{"event":"silence","endsIn":"less than a minute"}"#])
        XCTAssertEqual(call.state, .idle)
        XCTAssertEqual(ended, .silence)
        XCTAssertEqual(history.slots, [.ended(.silence, at: history.slots.first?.at ?? 0)])
    }

    /// The person's voice after a warning: the call goes on, and the agent
    /// is told once, as an update it reads without answering, never a cue.
    /// Muted, the voice doesn't count.
    func testVoiceAfterAWarningKeepsTheCallAndSaysTheSilenceIsOver() async throws {
        var timing = CallCues.Timing()
        timing.silenceWarning = 0.2
        timing.silenceEnd = 0.6
        let connection = FakeCallConnection()
        var events: CallEvents?
        var ended: CallEnding?
        let call = session(CallHistory(store: nil), timing: timing, connection: connection) { events = $0 }
        call.onEnded = { ended = $0 }
        call.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await live(call)
        await waitUntil { !connection.cues.isEmpty }
        events?.activity(.userSpeaking, 0.9)
        await waitUntil { connection.updates.contains(CallCues.silenceOver) }
        await call.delivered()
        XCTAssertEqual(connection.updates, [CallCues.silenceOver])
        XCTAssertEqual(connection.cues.count, 1)
        XCTAssertNil(ended)
        // Talking on past the end it warned of: the call goes on, told once.
        try await Task.sleep(for: .milliseconds(400))
        events?.activity(.userSpeaking, 0.9)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(ended)
        XCTAssertEqual(connection.updates, [CallCues.silenceOver])
        // Muted, the person's voice is silence to the provider, and to the app.
        await call.toggleMute()
        await waitUntil { ended != nil }
        XCTAssertEqual(ended, .silence)
        XCTAssertEqual(connection.updates, [CallCues.silenceOver])
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
        XCTAssertEqual(CallCue.silence(endsIn: 110).text, #"{"event":"silence","endsIn":"about 2 minutes"}"#)
        XCTAssertEqual(CallCue.callEnding(reason: .callLimit, in: 300, restart: true).text,
                       #"{"event":"call_ending","reason":"call_limit","in":"about 5 minutes","restart":true}"#)
        XCTAssertEqual(CallCue.callEnding(reason: .timeUsed, in: 70, restart: false).text,
                       #"{"event":"call_ending","reason":"time_used","in":"about a minute","restart":false}"#)
        XCTAssertEqual(CallCue.spoken(20), "less than a minute")
        XCTAssertEqual(CallCue.mark, "[app] ")
    }

    /// Warned at 180 s of quiet, ended at 290 s: always before the
    /// provider's own 300 s. The person's words start it over; the agent's
    /// answer to the warning doesn't put the end off.
    func testSilenceWarnsThenEndsBeforeTheProviderWould() {
        var cues = CallCues(since: 0)
        XCTAssertNil(cues.next(.init(now: 179)))
        // Not while the agent speaks.
        XCTAssertNil(cues.next(.init(now: 180, agentSpeaking: true)))
        XCTAssertEqual(cues.next(.init(now: 181)), .cue(.silence(endsIn: 110)))
        cues.agentSpoke(at: 190)
        XCTAssertNil(cues.next(.init(now: 290)))
        XCTAssertEqual(cues.next(.init(now: 291)), .end(.silence))
        XCTAssertLessThan(cues.timing.silenceEnd, 300)
        // Heard after the warning: no end, the agent told once, and the clock starts over.
        var again = CallCues(since: 0)
        _ = again.next(.init(now: 180))
        again.heard(at: 200)
        XCTAssertEqual(again.next(.init(now: 201)), .silenceOver)
        XCTAssertNil(again.next(.init(now: 300)))
        XCTAssertNil(again.next(.init(now: 379)))
        XCTAssertEqual(again.next(.init(now: 380)), .cue(.silence(endsIn: 110)))
    }

    /// One long turn has no transcript until it ends: the person's voice
    /// restarts the clock, so talking never reads as quiet, and the quiet
    /// after it counts from the last of the voice.
    func testTheVoiceRestartsTheSilenceClock() {
        var cues = CallCues(since: 0)
        for second in stride(from: 10.0, through: 400, by: 1) {
            XCTAssertNil(cues.next(.init(now: second, personSpeaking: true)), "at \(second)")
        }
        XCTAssertNil(cues.next(.init(now: 402)))
        XCTAssertNil(cues.next(.init(now: 579)))
        XCTAssertEqual(cues.next(.init(now: 580)), .cue(.silence(endsIn: 110)))
    }

    /// Voice after a warning: the warning is over, said once, and the call
    /// never ends while the person talks, however long.
    func testVoiceAfterAWarningEndsItOnceAndNeverTheCall() {
        var cues = CallCues(since: 0)
        XCTAssertEqual(cues.next(.init(now: 180)), .cue(.silence(endsIn: 110)))
        var actions: [CallCues.Action] = []
        for second in stride(from: 200.0, through: 700, by: 1) {
            if let action = cues.next(.init(now: second, personSpeaking: true)) { actions.append(action) }
        }
        XCTAssertEqual(actions, [.silenceOver])
        // A breath after it is no reason to warn, nor a transcript to say it is over again.
        cues.heard(at: 701)
        XCTAssertNil(cues.next(.init(now: 702)))
        XCTAssertNil(cues.next(.init(now: 880)))
        XCTAssertEqual(cues.next(.init(now: 881)), .cue(.silence(endsIn: 110)))
        // Each warning its own end of it.
        XCTAssertEqual(cues.next(.init(now: 900, personSpeaking: true)), .silenceOver)
        XCTAssertNil(cues.next(.init(now: 901, personSpeaking: true)))
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
        XCTAssertNil(paid.next(.init(now: 10, allowanceLeft: 301, allowanceTotal: 7_200)))
        XCTAssertEqual(paid.next(.init(now: 11, allowanceLeft: 300, allowanceTotal: 7_200)), .cue(.callEnding(reason: .timeUsed, in: 300, restart: false)))
        // At the limit with a minute or less to spare after it: no fresh call on offer.
        var short = CallCues(since: 0)
        short.heard(at: 3_290)
        XCTAssertEqual(short.next(.init(now: 3_290, allowanceLeft: 360, allowanceTotal: 7_200)), .cue(.callEnding(reason: .callLimit, in: 300, restart: false)))
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

    /// An update waits for its moment: never while either side speaks,
    /// not before the agent has answered from the read (or said nothing
    /// for 4 s) and been quiet a moment, and not before it answered what
    /// the person said meanwhile. One at a time, oldest first: the next
    /// once the agent has told this one.
    func testAnUpdateIsToldOnceTheAgentHasAnsweredWhatCameBefore() {
        let first = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s1"}"#)
        let second = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s2"}"#)
        XCTAssertEqual(first.text, #"{"event":"conversation_update","ref":"s1"}"#)
        var cues = CallCues(since: 0)
        cues.refreshing(at: 10)
        cues.later(first)
        // The agent hasn't answered from the read yet.
        XCTAssertNil(cues.next(.init(now: 11)))
        XCTAssertNil(cues.next(.init(now: 12, agentSpeaking: true)))
        cues.agentSpoke(at: 12)
        // Quiet a moment first, so it isn't cut off between its words.
        XCTAssertNil(cues.next(.init(now: 13)))
        // The person speaks meanwhile, and the agent answers them first.
        XCTAssertNil(cues.next(.init(now: 14, personSpeaking: true)))
        cues.heard(at: 15)
        XCTAssertNil(cues.next(.init(now: 16)))
        XCTAssertNil(cues.next(.init(now: 17, agentSpeaking: true)))
        cues.agentSpoke(at: 18)
        XCTAssertNil(cues.next(.init(now: 19)))
        XCTAssertEqual(cues.next(.init(now: 20)), .cue(first))
        // The next waits for the agent to tell this one.
        cues.later(second)
        XCTAssertNil(cues.next(.init(now: 21)))
        cues.agentSaid(String(repeating: "word ", count: 14), event: 7, at: 21)
        XCTAssertNil(cues.next(.init(now: 22, agentSpeaking: true)))
        cues.agentSpoke(at: 24)
        XCTAssertNil(cues.next(.init(now: 25)))
        XCTAssertEqual(cues.next(.init(now: 26)), .cue(second))
        XCTAssertEqual(cues.waiting, 1)
        // An agent that says nothing: its silence is its answer after 4 s.
        var silent = CallCues(since: 0)
        silent.refreshing(at: 10)
        silent.later(first)
        XCTAssertNil(silent.next(.init(now: 13)))
        XCTAssertEqual(silent.next(.init(now: 14)), .cue(first))
    }

    /// An update the person talked over goes again once they have had
    /// their answer: spoken over before the agent answered, or its answer
    /// cut off short; and one the agent never answered. Twice more at most.
    func testAnUpdateTalkedOverGoesAgainTwiceAtMost() {
        let update = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s1"}"#)
        var cues = CallCues(since: 0)
        cues.refreshing(at: 0)
        cues.agentSpoke(at: 1)
        cues.later(update)
        XCTAssertEqual(cues.next(.init(now: 5)), .cue(update))
        // The person starts talking as it goes: heard before any answer.
        XCTAssertNil(cues.next(.init(now: 6, personSpeaking: true)))
        cues.heard(at: 7)
        XCTAssertEqual(cues.waiting, 1)
        // The agent answers them, then the update goes again.
        cues.agentSaid(String(repeating: "word ", count: 6), event: 1, at: 8)
        XCTAssertNil(cues.next(.init(now: 8, agentSpeaking: true)))
        cues.agentSpoke(at: 10)
        XCTAssertNil(cues.next(.init(now: 11)))
        XCTAssertEqual(cues.next(.init(now: 12)), .cue(update))
        // Its answer begins and is cut off after three words.
        cues.agentSaid(String(repeating: "word ", count: 25), event: 2, at: 12.5)
        XCTAssertNil(cues.next(.init(now: 13, agentSpeaking: true)))
        cues.agentCorrected(String(repeating: "word ", count: 3), event: 2)
        cues.agentSpoke(at: 13.5)
        XCTAssertNil(cues.next(.init(now: 14, personSpeaking: true)))
        cues.heard(at: 15)
        cues.agentSaid(String(repeating: "word ", count: 5), event: 3, at: 15.5)
        cues.agentSpoke(at: 17)
        XCTAssertNil(cues.next(.init(now: 18)))
        XCTAssertEqual(cues.next(.init(now: 21)), .cue(update))
        // The third time unanswered: let go, never a fourth.
        XCTAssertNil(cues.next(.init(now: 25)))
        XCTAssertNil(cues.next(.init(now: 29)))
        XCTAssertEqual(cues.waiting, 0)
        XCTAssertNil(cues.next(.init(now: 60)))
        // Told, uninterrupted: it never goes again, and the person speaking after changes nothing.
        var told = CallCues(since: 0)
        told.refreshing(at: 0)
        told.agentSpoke(at: 1)
        told.later(update)
        XCTAssertEqual(told.next(.init(now: 5)), .cue(update))
        told.agentSaid(String(repeating: "word ", count: 20), event: 1, at: 5.5)
        XCTAssertNil(told.next(.init(now: 6, agentSpeaking: true)))
        told.agentSpoke(at: 9)
        told.heard(at: 10)
        XCTAssertEqual(told.waiting, 0)
        XCTAssertNil(told.next(.init(now: 30)))
        // Never answered at all: again after 8 s of quiet.
        var unanswered = CallCues(since: 0)
        unanswered.refreshing(at: 0)
        unanswered.agentSpoke(at: 1)
        unanswered.later(update)
        XCTAssertEqual(unanswered.next(.init(now: 5)), .cue(update))
        XCTAssertNil(unanswered.next(.init(now: 12)))
        XCTAssertEqual(unanswered.next(.init(now: 13)), .cue(update))
    }

    /// A newer update of a conversation takes the place of one still
    /// waiting, and of one that wasn't told; another conversation's waits.
    func testANewerUpdateOfAConversationTakesTheWaitingOnesPlace() {
        let old = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s1","turns":[1]}"#)
        let new = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s1","turns":[1,2]}"#)
        let other = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s2"}"#)
        XCTAssertEqual(new.conversation, "s1")
        XCTAssertNil(CallCue.silence(endsIn: 25).conversation)
        var cues = CallCues(since: 0)
        cues.refreshing(at: 0)
        cues.agentSpoke(at: 1)
        cues.later(old)
        cues.later(other)
        cues.later(new)
        XCTAssertEqual(cues.waiting, 2)
        XCTAssertEqual(cues.next(.init(now: 5)), .cue(other))
        // The person talks over it; meanwhile s2 has news again: the untold one goes no more.
        cues.heard(at: 6)
        cues.agentSpoke(at: 7)
        let newer = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s2","turns":[3]}"#)
        cues.later(newer)
        XCTAssertNil(cues.next(.init(now: 8)))
        XCTAssertEqual(cues.next(.init(now: 11)), .cue(new))
        cues.agentSaid(String(repeating: "word ", count: 20), event: 1, at: 11.5)
        cues.agentSpoke(at: 14)
        XCTAssertEqual(cues.next(.init(now: 16)), .cue(newer))
        XCTAssertEqual(cues.waiting, 1)
    }

    /// Talked over, an update the agent folds into its answer to the person
    /// is told: it goes no more. An answer that doesn't say it isn't.
    func testAnUpdateFoldedIntoTheAnswerAfterATalkOverIsTold() {
        let update = CallCue.conversationUpdate(#"{"event":"conversation_update","ref":"s2","turns":[{"ref":"t:r2","assistant":"Added: the pineapple fix is now listed first in the 2.1 notes."}]}"#)
        XCTAssertEqual(update.gist, ["added", "pineapple", "listed", "first", "notes"])
        var cues = CallCues(since: 0)
        cues.refreshing(at: 0)
        cues.agentSpoke(at: 1)
        cues.later(update)
        XCTAssertEqual(cues.next(.init(now: 5)), .cue(update))
        cues.heard(at: 6)
        cues.agentSaid("Seven days in a week. And there's a small update on the Release notes task: the pineapple fix was added to the version two point one notes.", event: 1, at: 7)
        XCTAssertNil(cues.next(.init(now: 8, agentSpeaking: true)))
        cues.agentSpoke(at: 12)
        XCTAssertNil(cues.next(.init(now: 14)))
        XCTAssertEqual(cues.waiting, 0)
        XCTAssertNil(cues.next(.init(now: 40)))
        // The same, its answer only "Seven days in a week, as always.": not told, so it goes again.
        var plain = CallCues(since: 0)
        plain.refreshing(at: 0)
        plain.agentSpoke(at: 1)
        plain.later(update)
        XCTAssertEqual(plain.next(.init(now: 5)), .cue(update))
        plain.heard(at: 6)
        plain.agentSaid("Seven days in a week, as always, every single week of the year.", event: 1, at: 7)
        plain.agentSpoke(at: 10)
        XCTAssertEqual(plain.next(.init(now: 12)), .cue(update))
    }

    /// An update for a read of another call (asked before a restart) is
    /// told to nobody.
    func testAnUpdateThisCallNeverReadForGoesNowhere() {
        var cues = CallCues(since: 0)
        cues.later(.conversationUpdate(#"{"event":"conversation_update","ref":"s1"}"#))
        XCTAssertEqual(cues.waiting, 0)
        XCTAssertNil(cues.next(.init(now: 30)))
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
