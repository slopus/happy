import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The agent connection's voice call: its context, its four tools and its
/// life, with the provider faked. Nothing here opens a microphone.
final class CallContextTests: XCTestCase {
    private func waitFor(_ condition: () async -> Bool) async {
        for _ in 0..<500 { if await condition() { return }; try? await Task.sleep(for: .milliseconds(2)) }
    }

    private let backendTarget = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)
    /// A thousand words of the agent's, two pages: about 6 KB.
    private let thousandWords = Array(repeating: "The build in `packages/happy-ios` failed on step three: the cache key changed after the lockfile update, so the agent rebuilt it and reran the tests.", count: 40).joined(separator: " ")
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
        let utc = TimeZone(identifier: "UTC")!
        let context = CallContext(targets: backend(), now: { 1_700_000_000 }, timeZone: utc)
        let text = await context.initial()
        // Plain lines, as Happy Agent's own tools write them: the focus, its
        // turns (four finished and the message waiting: five), the directory once.
        XCTAssertEqual(text, """
        Now: \(CallContext.local(1_700_000_000, in: utc)) (the person's local time)
        focusRevision: 0

        On screen: Backend — bot, ref s1
        Working: no. Needs the person: no.
        Last turns, oldest first:
        1. The person: first ask
           Agent: first answer
        2. The person: second ask
           Agent: second answer
        3. The person: steer
           Ended: steering
        4. The person: third ask
           Agent: third answer
        Waiting for an answer, from the person:
           still waiting

        Conversations in the app, in the sidebar's order:
        - Backend — bot, ref s1
        - Docs — task, ref s2

        \(CallContext.newWorkText)

        Destinations (navigate's to):
        - happy://home — the home list
        - happy://back — one screen back; refused at home
        - happy://conversation/<ref> — that conversation on screen, such as happy://conversation/s1
        """)
        XCTAssertFalse(text.contains("{"), "no JSON")
        let followed = await context.followed
        XCTAssertEqual(followed, ["a"])
        // Told once: the screen, the person going back to it, says nothing of its ref again.
        _ = await context.focusChanged(to: "b")
        let back = try events(await context.focusChanged(to: "a"))
        XCTAssertNil(back.first?["ref"])
    }

    func testTheSnapshotKeepsItsBudgets() async throws {
        let long = String(repeating: "é", count: 5000)
        let turns = (0..<10).map { CallTurn(id: "r\($0)", user: long, reply: long) }
        let many = (0..<300).map { CallTarget(agentId: "x\($0)", title: String(repeating: "n", count: 200), kind: .task, status: .idle) }
        let targets = FakeCallTargets(directory: [backendTarget] + many,
                                      states: ["a": CallTargetState(target: backendTarget, turns: turns, unanswered: CallMessage(id: "p", role: .user, text: long))], focus: "a")
        let text = await CallContext(targets: targets).initial()
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        let parts = text.components(separatedBy: "\n\n")
        let directory = try XCTUnwrap(parts.first { $0.hasPrefix("Conversations in the app") })
        XCTAssertTrue(directory.hasSuffix("more; listConversations finds them by title."), directory)
        XCTAssertLessThanOrEqual(directory.utf8.count, CallContext.Limits.directoryBytes)
        let screen = try XCTUnwrap(parts.first { $0.hasPrefix("On screen:") })
        let shown = screen.components(separatedBy: "\n").filter { $0.first?.isNumber == true }
        XCTAssertLessThanOrEqual(shown.count, CallContext.Limits.turns)
        XCTAssertTrue(screen.contains(" … (cut, 1 more word)"))
        XCTAssertTrue(screen.contains("Older turns aren't shown."))
        XCTAssertTrue(text.hasSuffix(CallContext.newWorkText + "\n\n" + CallContext.destinationsText))
    }

    /// The models the message tool's description sends the agent to: the
    /// conversation on screen's, as a read lists them.
    func testTheFirstContextListsTheModelsTheScreensConversationCanSwitchTo() async throws {
        let targets = backend()
        await targets.set("a", CallTargetState(target: backendTarget, mode: CallMode(modelId: opus.id, model: opus.name, effort: "high"), models: [opus, CallModel(id: "plain", name: "Plain", efforts: [], defaultEffort: "")]))
        let text = await CallContext(targets: targets).initial()
        XCTAssertTrue(text.contains("""
        Model: Claude Opus 4.5, effort high
        Models it can switch to:
        - Claude Opus 4.5 — id claude-opus-4-5, efforts low, medium, high, max
        - Plain — id plain
        """), text)
    }

    func testTruncationKeepsWholeCharacters() {
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 4), "aé")
        XCTAssertEqual(CallContext.truncated("aé😀", bytes: 7), "aé😀")
    }

    func testReadingAConversationGivesItsLastFiveTurnsAndChangesNothingHeard() async throws {
        let context = CallContext(targets: backend(focus: nil))
        _ = await context.initial()
        let read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.map { $0["assistant"] as? String }, ["first answer", "second answer", nil, "third answer"])
        XCTAssertEqual((read["pendingUserMessage"] as? [String: Any])?["text"] as? String, "still waiting")
        XCTAssertEqual(read["working"] as? Bool, false)
        XCTAssertEqual(read["needsInput"] as? Bool, false)
        _ = await tool(context, "listConversations", "{}")
        let followed = await context.followed
        XCTAssertTrue(followed.isEmpty)
        // Not visited, so its new words say nothing.
        let quiet = await context.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "n", role: .assistant, text: "new")]))
        XCTAssertTrue(quiet.isEmpty)
    }

    /// Five in all: five finished turns with nothing waiting, four with a
    /// message waiting; an answer with no message of the person's is half
    /// a pair; a read within `Limits.readBytes` on the wire, the oldest
    /// first to go and the newest whole.
    func testFiveTurnsInAllAndTheBudgetHolds() async throws {
        var turns = (1...7).map { CallTurn(id: "r\($0)", user: "ask \($0)", reply: "answer \($0)") }
        turns.append(CallTurn(id: "r8", reply: "done on its own"))
        let targets = FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        var read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.map { $0["assistant"] as? String }, ["answer 4", "answer 5", "answer 6", "answer 7", "done on its own"])
        XCTAssertNil((read["turns"] as? [[String: Any]])?.last?["user"])
        XCTAssertEqual(read["olderTurns"] as? Bool, true)
        let waiting = CallMessage(id: "p", role: .user, text: "and now?")
        await targets.set("a", CallTargetState(target: backendTarget, turns: turns, unanswered: waiting))
        read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.count, 4)
        XCTAssertEqual((read["pendingUserMessage"] as? [String: Any])?["text"] as? String, "and now?")
        // Each reply within its own limit, but escaped six bytes a character on the wire.
        let heavy = String(repeating: "<<<< ", count: 1600)
        await targets.set("a", CallTargetState(target: backendTarget, turns: (0..<6).map { CallTurn(id: "l\($0)", user: "ask \($0)", reply: heavy) }))
        let big = await tool(context, "readConversation", #"{"ref":"s1"}"#)
        XCTAssertLessThanOrEqual(CallContext.escapedSize(Data(big.text.utf8)), CallContext.Limits.readBytes)
        let shown = try XCTUnwrap(try object(big.text)["turns"] as? [[String: Any]])
        XCTAssertEqual(shown.map { $0["user"] as? String }, ["ask 5"])
        XCTAssertEqual(shown.first?["assistant"] as? String, heavy)
        XCTAssertNil(shown.first?["truncated"])
    }

    /// About a thousand words of the agent's come back whole: in a read,
    /// five turns of them, and told as they come.
    func testAThousandWordReplyComesBackWhole() async throws {
        XCTAssertEqual(thousandWords.split(separator: " ").count, 1000)
        let turns = (1...5).map { CallTurn(id: "r\($0)", user: "ask \($0)", reply: thousandWords) }
        let context = CallContext(targets: FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: nil))
        _ = await context.initial()
        let read = await tool(context, "readConversation", #"{"ref":"s1"}"#)
        XCTAssertLessThanOrEqual(CallContext.escapedSize(Data(read.text.utf8)), CallContext.Limits.readBytes)
        let shown = try XCTUnwrap(try object(read.text)["turns"] as? [[String: Any]])
        XCTAssertEqual(shown.map { $0["assistant"] as? String }, Array(repeating: thousandWords, count: 5))
        XCTAssertTrue(shown.allSatisfy { $0["truncated"] == nil })
        let live = CallContext(targets: backend())
        _ = await live.initial()
        _ = await live.targetChanged(CallTargetState(target: backendTarget))
        let told = try events(await live.targetChanged(CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: thousandWords)])))
        XCTAssertEqual(told.first?["text"] as? String, thousandWords)
        XCTAssertNil(told.first?["truncated"])
    }

    /// Five turns of a thousand words fit the first context whole; five
    /// replies at their limit don't, and the older give way, the newest
    /// there whole.
    func testTheFirstContextKeepsTheNewestTurnWhole() async throws {
        func initial(_ reply: String) async -> String {
            let turns = (1...5).map { CallTurn(id: "r\($0)", user: "ask \($0)", reply: "Turn \($0). " + reply) }
            return await CallContext(targets: FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: "a")).initial()
        }
        let fits = await initial(thousandWords)
        XCTAssertLessThanOrEqual(fits.utf8.count, CallContext.Limits.totalBytes)
        for turn in 1...5 { XCTAssertTrue(fits.contains("Agent: Turn \(turn). " + thousandWords + "\n")) }
        XCTAssertFalse(fits.contains("(cut,"))
        let most = Array(repeating: thousandWords, count: 2).joined(separator: " ").split(separator: " ").prefix(1300).joined(separator: " ")
        XCTAssertLessThanOrEqual(most.utf8.count + 8, CallContext.Limits.replyBytes)
        let text = await initial(most)
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
        XCTAssertTrue(text.contains("Agent: Turn 5. " + most + "\n"))
        XCTAssertFalse(text.contains("Turn 1. "))
        XCTAssertFalse(text.contains("(cut,"))
        XCTAssertTrue(text.contains("Older turns aren't shown."))
    }

    func testClippingCutsAfterAWordAndCountsTheRest() {
        XCTAssertEqual(CallContext.clipped("short", bytes: 64), "short")
        XCTAssertEqual(CallContext.clipped(String(repeating: "word ", count: 100), bytes: 64), "word word word word word word … (cut, 94 more words)")
        XCTAssertEqual(CallContext.clipped(String(repeating: "é", count: 100), bytes: 64), String(repeating: "é", count: 16) + " … (cut, 1 more word)")
    }

    func testAFailedTurnIsReadWithItsReason() async throws {
        let turns = [CallTurn(id: "r1", user: "ask", reply: "fine"), CallTurn(id: "r2", user: "again", ended: "error", error: "Rate limited")]
        let context = CallContext(targets: FakeCallTargets(directory: [backendTarget], states: ["a": CallTargetState(target: backendTarget, turns: turns)], focus: nil))
        _ = await context.initial()
        let read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
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
        _ = await context.handle(CallToolCall(id: "o", name: "navigate", parameters: Data(#"{"to":"happy://conversation/s2","focusRevision":0}"#.utf8)))
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
        XCTAssertNil(focus[0]["turns"])
        XCTAssertFalse(focus.description.contains("answer"))
    }

    /// "queued" is no receipt: a send that fails afterwards is said by
    /// nothing on its own, and read where the agent looks for it.
    func testASendThatFailsLaterIsReadNotAnnounced() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let sent = try object(await tool(context, "message", #"{"to":"s1","text":"run it"}"#).text)
        XCTAssertEqual(sent["status"] as? String, "queued")
        let before = await targets.state(of: "a")
        var state = try XCTUnwrap(before)
        let failed = CallMessage(id: "run", role: .user, text: "run it", delivery: .failed)
        state.messages.append(failed)
        state.unanswered = failed
        await targets.set("a", state)
        let quiet = await context.targetChanged(state)
        XCTAssertTrue(quiet.isEmpty)
        let read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
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
        let opened = try object(await tool(context, "navigate", #"{"to":"happy://conversation/s2","focusRevision":0}"#).text)
        XCTAssertEqual(opened["focusRevision"] as? Int, 1)
        // The screen saying the same afterwards tells the agent nothing new.
        let screen = await context.focusChanged(to: "b")
        XCTAssertTrue(screen.isEmpty)
        // Chained on what the open gave, the next open goes.
        let next = await tool(context, "navigate", #"{"to":"happy://conversation/s1","focusRevision":1}"#)
        XCTAssertFalse(next.isError)
        XCTAssertEqual(try object(next.text)["focusRevision"] as? Int, 2)
        let followed = await context.followed
        XCTAssertEqual(followed, ["a", "b"])
        let send = try object(await tool(context, "message", #"{"to":"s2","text":"go"}"#).text)
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

    func testALongMessageGoesCutAfterAWordOnce() async throws {
        let context = CallContext(targets: backend())
        _ = await context.initial()
        _ = await context.targetChanged(CallTargetState(target: backendTarget))
        let words = (1...2000).map { "w\($0)" }
        let long = CallTargetState(target: backendTarget, messages: [CallMessage(id: "r", role: .assistant, text: words.joined(separator: " "))])
        let cut = try events(await context.targetChanged(long))
        let text = try XCTUnwrap(cut.first?["text"] as? String)
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.replyBytes)
        let kept = try XCTUnwrap(text.components(separatedBy: " … (cut, ").first).components(separatedBy: " ")
        XCTAssertEqual(kept, Array(words.prefix(kept.count)))
        XCTAssertTrue(text.hasSuffix(" … (cut, \(words.count - kept.count) more words)"), text)
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
        // The focus with its reference, then what was told; the directory never again.
        XCTAssertEqual(fixed[0]["event"] as? String, "focus")
        XCTAssertEqual(fixed[0]["resync"] as? Bool, true)
        XCTAssertEqual(fixed[0]["focusRevision"] as? Int, 2)
        XCTAssertEqual(fixed[0]["title"] as? String, "Backend")
        XCTAssertEqual(fixed[0]["ref"] as? String, "s1")
        XCTAssertEqual(fixed.dropFirst().map { $0["event"] as? String }, ["session_error", "assistant_text"])
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
        let call = CallToolCall(id: "t1", name: "message", parameters: Data(#"{"to":"s2","text":"  run the checks "}"#.utf8))
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

    func testMessageRefusesWhatItMustNotSend() async throws {
        let targets = backend()
        await targets.set("a", CallTargetState(target: CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .needsInput), needsInput: true))
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let refusals = [
            #"{"to":"s1","text":"yes"}"#,
            #"{"text":"yes"}"#,
            #"{"to":"s9","text":"go"}"#,
            #"{"to":"Docs","text":"go"}"#,
            #"{"to":2,"text":"go"}"#,
            #"{"to":"s2","text":"  "}"#,
            #"{"to":"s2","text":7}"#,
            "{\"to\":\"s2\",\"text\":\"\(String(repeating: "é", count: 4097))\"}",
        ]
        for json in refusals {
            let result = await tool(context, "message", json)
            XCTAssertTrue(result.isError, json)
        }
        let unknown = await tool(context, "processPermissionRequest", "{}")
        XCTAssertTrue(unknown.isError)
        let watch = await tool(context, "setSessionWatch", #"{"ref":"s2","enabled":true}"#)
        XCTAssertEqual(try object(watch.text)["reason"] as? String, "Unknown tool.")
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        // 8 KiB exactly is fine.
        let most = await tool(context, "message", "{\"to\":\"s2\",\"text\":\"\(String(repeating: "é", count: 4096))\"}")
        XCTAssertFalse(most.isError)
    }

    func testASendWithNoAnswerInTimeIsUncertainAndNeverGoesUnderANewID() async throws {
        let targets = backend()
        await targets.setSendDelay(.seconds(30))
        let context = CallContext(targets: targets, toolDeadline: .milliseconds(50))
        _ = await context.initial()
        func send(_ call: String, _ text: String) async -> CallToolResult {
            await tool(context, "message", "{\"to\":\"s2\",\"text\":\"\(text)\"}", id: call)
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
        // The first, cut off, may land on either side of the second: two
        // under one ID, the settled one under its own.
        let ids = await targets.sends.map(\.id)
        XCTAssertEqual(Dictionary(grouping: ids) { $0 }.values.map(\.count).sorted(), [1, 2])
    }

    func testMovingTheScreenRefusesANavigationAskedUnderTheOldFocus() async throws {
        let targets = backend()
        await targets.setScreens(1)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let moved = await context.focusChanged(to: "b")
        XCTAssertTrue(moved.context[0].contains(#""focusRevision":1"#))
        for to in ["happy://conversation/s1", "happy://back"] {
            let stale = await tool(context, "navigate", "{\"to\":\"\(to)\",\"focusRevision\":0}")
            XCTAssertTrue(stale.isError, to)
            XCTAssertTrue(stale.text.contains("screen changed"), to)
        }
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let screens = await targets.screens
        XCTAssertEqual(screens, 1)
        // A message names where it goes: a move on screen doesn't stop it.
        let sent = await tool(context, "message", #"{"to":"s1","text":"go"}"#)
        XCTAssertFalse(sent.isError)
        let fresh = await tool(context, "navigate", #"{"to":"happy://conversation/s1","focusRevision":1}"#)
        XCTAssertFalse(fresh.isError)
    }

    /// No `to`: the conversation on screen as the tool runs, named in the
    /// answer; with none on screen, nothing goes and the agent is told to ask.
    func testAMessageWithNoToGoesToTheConversationOnScreen() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let sent = try object(await tool(context, "message", #"{"text":"run the checks"}"#).text)
        XCTAssertEqual(sent["status"] as? String, "queued")
        XCTAssertEqual(sent["ref"] as? String, "s1")
        XCTAssertEqual(sent["title"] as? String, "Backend")
        let blank = try object(await tool(context, "message", #"{"to":" ","text":"and the lint"}"#).text)
        XCTAssertEqual(blank["ref"] as? String, "s1")
        let sends = await targets.sends
        XCTAssertEqual(sends.map(\.agentId), ["a", "a"])
        // A named one says no title: the agent named it.
        let named = try object(await tool(context, "message", #"{"to":"s2","text":"go"}"#).text)
        XCTAssertNil(named["title"])

        let none = backend(focus: nil)
        let away = CallContext(targets: none)
        _ = await away.initial()
        let refused = await tool(away, "message", #"{"text":"run the checks"}"#)
        XCTAssertTrue(refused.isError)
        XCTAssertEqual(try object(refused.text)["reason"] as? String, "No conversation is on screen. Ask which one, then send with its ref as to.")
        let nothing = await none.sends
        XCTAssertTrue(nothing.isEmpty)
    }

    /// navigate takes the destinations the context lists and nothing else,
    /// answering anything else with them.
    func testNavigateTakesOnlyTheContextsDestinations() async throws {
        let targets = backend()
        await targets.setScreens(2)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for bad in [#""happy://settings""#, #""s2""#, #""https://example.com""#, #""happy://conversation/""#, #""happy://conversation/s2/x""#, "3", "null"] {
            let result = await tool(context, "navigate", "{\"to\":\(bad),\"focusRevision\":0}")
            XCTAssertTrue(result.isError, bad)
            let value = try object(result.text)
            XCTAssertEqual(value["ok"] as? Bool, false, bad)
            XCTAssertEqual(value["destinations"] as? [String], ["happy://home", "happy://back", "happy://conversation/<ref>"], bad)
        }
        let settings = try object(await tool(context, "navigate", #"{"to":"happy://settings","focusRevision":0}"#).text)
        XCTAssertEqual(settings["reason"] as? String, #""happy://settings" isn't a destination. to is one of: happy://home, happy://back, happy://conversation/<ref>."#)
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        var screens = await targets.screens
        XCTAssertEqual(screens, 2)
        // The scheme and place in any case, a trailing slash too; home whatever focusRevision says.
        let home = try object(await tool(context, "navigate", #"{"to":" HAPPY://Home/ ","focusRevision":7}"#).text)
        XCTAssertEqual(home["home"] as? Bool, true)
        screens = await targets.screens
        XCTAssertEqual(screens, 0)
        XCTAssertEqual(CallContext.destination("happy://conversation/s12"), .conversation("s12"))
        XCTAssertEqual(CallContext.destination("Happy://Back"), .back)
    }

    func testAnEndedCallRunsNoTools() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await context.close()
        let late = await tool(context, "message", #"{"to":"s2","text":"go"}"#)
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
            let result = await tool(context, "navigate", "{\"to\":\"happy://conversation/s1\",\"focusRevision\":\(bad)}")
            XCTAssertTrue(result.isError, bad)
        }
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let fine = await tool(context, "navigate", #"{"to":"happy://conversation/s1","focusRevision":0}"#)
        XCTAssertFalse(fine.isError)
        for bad in [#"{"query":3}"#, #"{"cursor":5}"#, #"{"cursor":"-1"}"#, #"{"cursor":"x"}"#, "[]"] {
            let result = await tool(context, "listConversations", bad)
            XCTAssertTrue(result.isError, bad)
        }
        let unref = await tool(context, "readConversation", #"{"ref":1}"#)
        XCTAssertTrue(unref.isError)
    }

    // MARK: New work and the way back

    /// v2's tools are the shipped build's: this one calls v3, and knows none of them.
    func testV2sToolsAreUnknown() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        for name in ["sendMessage", "listSessions", "getSessionContext", "openSession", "newWork", "goBack", "goHome"] {
            let result = await tool(context, name, #"{"targetRef":"s2","text":"go","focusRevision":0,"kind":"bot"}"#)
            XCTAssertEqual(try object(result.text)["reason"] as? String, "Unknown tool.", name)
        }
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        let opens = await targets.opens
        XCTAssertTrue(opens.isEmpty)
        let made = await targets.made
        XCTAssertTrue(made.isEmpty)
    }

    /// One call: compose's new work with this message its first, off
    /// screen, reached by the reference the answer gives from then on.
    func testSendingToNewTaskStartsItOffScreenWithThatMessageFirst() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let started = try object(await tool(context, "message", #"{"to":"new-task","text":"Find papers on caching"}"#).text)
        XCTAssertEqual(started["status"] as? String, "queued")
        XCTAssertEqual(started["started"] as? String, "task")
        XCTAssertEqual(started["title"] as? String, "New Task")
        let ref = try XCTUnwrap(started["ref"] as? String)
        XCTAssertEqual(ref, "s3")
        // Nothing moved: the screen and its focus are as they were.
        XCTAssertNil(started["focusRevision"])
        let screens = await targets.screens
        XCTAssertEqual(screens, 0)
        let made = await targets.made
        XCTAssertEqual(made.map(\.kind), [.task])
        let sends = await targets.sends
        XCTAssertEqual(sends.map(\.agentId), ["new-1"])
        XCTAssertEqual(sends.map(\.text), ["Find papers on caching"])
        // Unlisted until the computer has it, it is read and sent to by that reference.
        let read = try object(await tool(context, "readConversation", "{\"ref\":\"\(ref)\"}").text)
        XCTAssertEqual(read["title"] as? String, "New Task")
        // Made, it is the sidebar's under the same reference.
        await targets.setDirectory([backendTarget, docsTarget, CallTarget(agentId: "new-1", title: "Caching papers", kind: .task, status: .running)])
        let listed = try object(await tool(context, "listConversations", #"{"query":"caching"}"#).text)
        XCTAssertEqual((listed["conversations"] as? [[String: Any]])?.first?["ref"] as? String, ref)
        let opened = try object(await tool(context, "navigate", "{\"to\":\"happy://conversation/\(ref)\",\"focusRevision\":0}").text)
        XCTAssertEqual(opened["opened"] as? Bool, true)
        // Only a send takes the new-work references.
        for (name, json) in [("readConversation", #"{"ref":"new-task"}"#), ("navigate", #"{"to":"happy://conversation/new-task","focusRevision":1}"#)] {
            let refused = await tool(context, name, json)
            XCTAssertTrue(refused.isError, name)
            XCTAssertTrue(refused.text.contains("start it with message to new-task or new-bot"), name)
        }
    }

    func testANewBotIsNamedAfterAColon() async throws {
        let targets = backend()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let started = try object(await tool(context, "message", #"{"to":"New-Bot: Release helper ","text":"Watch the release"}"#).text)
        XCTAssertEqual(started["started"] as? String, "bot")
        XCTAssertEqual(started["title"] as? String, "Release helper")
        let made = await targets.made
        XCTAssertEqual(made.map(\.kind), [.bot])
        XCTAssertEqual(made.map(\.name), ["Release helper"])
        let unnamed = try object(await tool(context, "message", #"{"to":"new-bot","text":"Watch the docs"}"#).text)
        XCTAssertEqual(unnamed["title"] as? String, "New Bot")
    }

    /// The model and effort go as compose's pickers would set them before
    /// its first send; without them, compose's default, said in the answer.
    func testNewWorkStartsOnTheModelAskedForOrComposesDefault() async throws {
        let targets = backend()
        await targets.setNewWork(mode: CallMode(modelId: opus.id, model: opus.name, effort: "high"), models: [opus, sonnet, gpt])
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let asked = try object(await tool(context, "message", #"{"to":"new-task","text":"go","model":"sonnet","effort":"low"}"#).text)
        XCTAssertEqual(asked["model"] as? String, "Claude Sonnet 4.5")
        XCTAssertEqual(asked["effort"] as? String, "low")
        let plain = try object(await tool(context, "message", #"{"to":"new-task","text":"also"}"#).text)
        XCTAssertEqual(plain["model"] as? String, "Claude Opus 4.5")
        XCTAssertEqual(plain["effort"] as? String, "high")
        let changes = await targets.changes
        XCTAssertEqual(changes, [CallModeChange(modelId: "claude-sonnet-4-5", effort: "low"), nil])
    }

    /// Refused for its model or its effort: nothing goes and nothing stays.
    func testARefusedStartLeavesNothing() async throws {
        let targets = backend()
        await targets.setNewWork(mode: CallMode(modelId: opus.id, model: opus.name, effort: "high"), models: [opus, sonnet])
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let unknown = await tool(context, "message", #"{"to":"new-task","text":"go","model":"gemini"}"#)
        XCTAssertTrue(unknown.isError)
        XCTAssertEqual((try object(unknown.text)["models"] as? [Any])?.count, 2)
        let effort = await tool(context, "message", #"{"to":"new-task","text":"go","model":"sonnet","effort":"max"}"#)
        XCTAssertTrue(effort.isError)
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
        let discarded = await targets.discarded
        XCTAssertEqual(discarded, ["new-1", "new-2"])
    }

    /// The provider asking again, its answer lost: the same new work, never a second.
    func testTheSameWordsAgainStartNothingNew() async throws {
        let targets = backend()
        await targets.setSendDelay(.milliseconds(300))
        let context = CallContext(targets: targets, toolDeadline: .milliseconds(100))
        _ = await context.initial()
        let first = await tool(context, "message", #"{"to":"new-task","text":"Fix the build"}"#)
        XCTAssertEqual(try object(first.text)["status"] as? String, "uncertain")
        await targets.setSendDelay(nil)
        try await Task.sleep(for: .milliseconds(300))
        let second = try object(await tool(context, "message", #"{"to":"new-task","text":"Fix the build"}"#).text)
        XCTAssertEqual(second["status"] as? String, "queued")
        let made = await targets.made
        XCTAssertEqual(made.count, 1)
        let sends = await targets.sends
        XCTAssertEqual(Set(sends.map(\.id)).count, 1)
        XCTAssertEqual(Set(sends.map(\.agentId)), ["new-1"])
    }

    func testComposeOpenedByHandIsReachedThroughTheFocus() async throws {
        let targets = backend(focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await targets.composeByHand()
        let focus = try events(await context.focusChanged(to: "new-1"))
        XCTAssertEqual(focus.last?["title"] as? String, "New Task")
        let ref = try XCTUnwrap(focus.last?["ref"] as? String)
        let sent = await tool(context, "message", "{\"to\":\"\(ref)\",\"text\":\"Fix the flaky test\"}")
        XCTAssertFalse(sent.isError)
    }

    func testBackPopsOneScreenAndHomeClearsThem() async throws {
        let targets = backend(focus: nil)
        await targets.setScreens(3)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let stale = await tool(context, "navigate", #"{"to":"happy://back","focusRevision":2}"#)
        XCTAssertTrue(stale.isError)
        var screens = await targets.screens
        XCTAssertEqual(screens, 3)
        let back = try object(await tool(context, "navigate", #"{"to":"happy://back","focusRevision":0}"#).text)
        XCTAssertEqual(back["home"] as? Bool, false)
        XCTAssertTrue(back["title"] is NSNull)
        screens = await targets.screens
        XCTAssertEqual(screens, 2)
        let home = try object(await tool(context, "navigate", #"{"to":"happy://home","focusRevision":0}"#).text)
        XCTAssertEqual(home["home"] as? Bool, true)
        let nowhere = await tool(context, "navigate", #"{"to":"happy://back","focusRevision":0}"#)
        XCTAssertTrue(nowhere.isError)
        XCTAssertEqual(try object(nowhere.text)["reason"] as? String, "This is home; there is nothing to go back to.")
    }

    // MARK: Model, effort and times

    private let opus = CallModel(id: "claude-opus-4-5", name: "Claude Opus 4.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "high")
    private let sonnet = CallModel(id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", efforts: ["low", "medium", "high"], defaultEffort: "medium")
    private let gpt = CallModel(id: "gpt-5.2-codex", name: "GPT-5.2 Codex", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium")

    /// Docs works on Opus at high effort, and the computer offers three models.
    private func modelled() async -> FakeCallTargets {
        let targets = backend()
        await targets.set("b", CallTargetState(target: docsTarget, working: true, mode: CallMode(modelId: opus.id, model: opus.name, effort: "high"), models: [opus, sonnet, gpt]))
        return targets
    }

    func testMessageSwitchesTheModelAndEffortTheComputerOffers() async throws {
        let targets = await modelled()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        // Working, it still takes the message, as the composer's send does.
        let both = try object(await tool(context, "message", #"{"to":"s2","text":"go","model":"sonnet","effort":"Low"}"#).text)
        XCTAssertEqual(both["status"] as? String, "queued")
        XCTAssertEqual(both["model"] as? String, "Claude Sonnet 4.5")
        XCTAssertEqual(both["effort"] as? String, "low")
        let effortOnly = try object(await tool(context, "message", #"{"to":"s2","text":"again","effort":"max"}"#).text)
        XCTAssertEqual(effortOnly["model"] as? String, "Claude Opus 4.5")
        XCTAssertEqual(effortOnly["effort"] as? String, "max")
        let modelOnly = try object(await tool(context, "message", #"{"to":"s2","text":"third","model":"GPT 5.2 codex"}"#).text)
        XCTAssertEqual(modelOnly["effort"] as? String, "medium")
        let plain = try object(await tool(context, "message", #"{"to":"s2","text":"fourth"}"#).text)
        XCTAssertNil(plain["model"])
        let changes = await targets.changes
        XCTAssertEqual(changes, [
            CallModeChange(modelId: "claude-sonnet-4-5", effort: "low"), CallModeChange(effort: "max"),
            CallModeChange(modelId: "gpt-5.2-codex"), nil,
        ])
    }

    func testAModelOrEffortItDoesntOfferIsRefusedWithWhatItDoes() async throws {
        let targets = await modelled()
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let unknown = await tool(context, "message", #"{"to":"s2","text":"go","model":"gemini"}"#)
        XCTAssertTrue(unknown.isError)
        let listed = try object(unknown.text)
        XCTAssertEqual((listed["models"] as? [[String: Any]])?.compactMap { $0["name"] as? String }, ["Claude Opus 4.5", "Claude Sonnet 4.5", "GPT-5.2 Codex"])
        XCTAssertTrue((listed["reason"] as? String)?.hasSuffix("Nothing was sent.") == true)
        let ambiguous = try object(await tool(context, "message", #"{"to":"s2","text":"go","model":"claude"}"#).text)
        XCTAssertEqual((ambiguous["models"] as? [Any])?.count, 2)
        let effort = try object(await tool(context, "message", #"{"to":"s2","text":"go","model":"sonnet","effort":"max"}"#).text)
        XCTAssertEqual(effort["reason"] as? String, "Claude Sonnet 4.5 takes effort low, medium, high, not \"max\". Nothing was sent.")
        let wrongType = await tool(context, "message", #"{"to":"s2","text":"go","model":4}"#)
        XCTAssertTrue(wrongType.isError)
        // Without the computer's models, nothing changes and nothing goes.
        let unread = await tool(context, "message", #"{"to":"s1","text":"go","effort":"high"}"#)
        XCTAssertTrue(unread.isError)
        let sends = await targets.sends
        XCTAssertTrue(sends.isEmpty)
    }

    func testReadsSayWhenItLastHeardFromEachSideWhereItRunsAndOnWhat() async throws {
        let now = 1_762_430_400.0 // 2025-11-06 12:00 UTC
        let app = CallTarget.Parent(id: "p", title: "App", kind: "project")
        let feature = CallTarget.Parent(id: "w", title: "Feature", kind: "workspace")
        let chat = CallTarget(agentId: "c", title: "Feature chat", kind: .conversation, status: .idle, parents: [app, feature], activityAt: (now - 300) * 1000)
        let state = CallTargetState(
            target: chat,
            messages: [CallMessage(id: "u", role: .user, text: "ship it", time: (now - 7200) * 1000), CallMessage(id: "x", role: .assistant, text: "Shipped")],
            turns: [CallTurn(id: "r", user: "ship it", reply: "Shipped", endedAt: (now - 300) * 1000)],
            mode: CallMode(modelId: opus.id, model: opus.name, effort: "high"), models: [opus, sonnet]
        )
        let context = CallContext(targets: FakeCallTargets(directory: [chat], states: ["c": state], focus: nil), now: { now }, timeZone: TimeZone(identifier: "Europe/Berlin")!)
        _ = await context.initial()
        let read = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
        XCTAssertEqual(read["lastUserMessage"] as? [String: String], ["ago": "2 hours ago", "at": "2025-11-06T11:00:00+01:00"])
        XCTAssertEqual(read["lastAgentReply"] as? [String: String], ["ago": "5 minutes ago", "at": "2025-11-06T12:55:00+01:00"])
        XCTAssertEqual(read["workspace"] as? String, "App / Feature")
        XCTAssertEqual(read["model"] as? [String: String], ["id": "claude-opus-4-5", "name": "Claude Opus 4.5", "effort": "high"])
        XCTAssertEqual((read["models"] as? [[String: Any]])?.first?["efforts"] as? [String], ["low", "medium", "high", "max"])
        let listed = try object(await tool(context, "listConversations", "{}").text)
        let row = try XCTUnwrap((listed["conversations"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["lastActivity"] as? [String: String], ["ago": "5 minutes ago", "at": "2025-11-06T12:55:00+01:00"])
        XCTAssertEqual(row["workspace"] as? String, "App / Feature")
        XCTAssertEqual(listed["now"] as? String, "2025-11-06T13:00:00+01:00")
    }

    func testAgoIsSaidAsAPersonWould() {
        XCTAssertEqual(CallContext.ago(-30), "just now")
        XCTAssertEqual(CallContext.ago(59), "just now")
        XCTAssertEqual(CallContext.ago(60), "a minute ago")
        XCTAssertEqual(CallContext.ago(5 * 60 + 20), "5 minutes ago")
        XCTAssertEqual(CallContext.ago(90 * 60), "an hour ago")
        XCTAssertEqual(CallContext.ago(5 * 3600), "5 hours ago")
        XCTAssertEqual(CallContext.ago(30 * 3600), "yesterday")
        XCTAssertEqual(CallContext.ago(4 * 86400), "4 days ago")
    }

    func testATeamsMessagesSayWhoWroteThem() async throws {
        let now = 1_762_430_400.0
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.items = [
            ChatItem(id: "m1", role: .user, pieces: [.text("Fix the login")], delivery: .sent, turn: "r1", time: (now - 600) * 1000, author: "ada"),
            ChatItem(id: "m2", role: .agent, pieces: [.text("Fixed")], delivery: .sent, turn: "r1"),
            ChatItem(id: "r1:status", role: .turnEnd(.init(reason: "completed", durationMs: 1000, tools: 0, copyText: "Fixed", endedAt: (now - 500) * 1000)), pieces: [], delivery: .sent, turn: "r1"),
            ChatItem(id: "m3", role: .user, pieces: [.text("Now the signup")], delivery: .pending, turn: "r2", time: (now - 60) * 1000, author: "me"),
        ]
        let chat = CallTarget(agentId: "c", title: "Auth", kind: .task, status: .idle)
        let read = CallTargetState.from(snapshot, target: chat)
        XCTAssertEqual(read.authors, ["ada", "me"])
        // The one on the call is "the person"; a member the computer didn't name, "a teammate".
        let named = read.named(["ada": "Ada Lovelace"], me: "me")
        XCTAssertEqual(named.turns.first?.userBy, "Ada Lovelace")
        XCTAssertEqual(named.unanswered?.by, "the person")
        XCTAssertEqual(read.named([:], me: nil).turns.first?.userBy, "a teammate")
        let context = CallContext(targets: FakeCallTargets(directory: [chat], states: ["c": named], focus: nil), now: { now }, timeZone: TimeZone(identifier: "UTC")!)
        _ = await context.initial()
        let body = try object(await tool(context, "readConversation", #"{"ref":"s1"}"#).text)
        XCTAssertEqual((body["turns"] as? [[String: Any]])?.first?["userBy"] as? String, "Ada Lovelace")
        XCTAssertEqual((body["pendingUserMessage"] as? [String: Any])?["by"] as? String, "the person")
        XCTAssertEqual((body["lastUserMessage"] as? [String: String])?["by"], "the person")
        // Outside a team nothing has an author, and nothing says who.
        let alone = CallTargetState.from(ChatSnapshot(), target: chat).named([:], me: nil)
        XCTAssertTrue(alone.authors.isEmpty)
    }

    func testMessagesCarryTheirAuthorFromTheWire() throws {
        let json = #"{"id":"m","role":"user","createdAt":1,"content":[{"type":"text","text":"hi"}],"metadata":{"userId":"ada"}}"#
        let message = try JSONDecoder().decode(AgentWire.Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.metadata?.userId, "ada")
    }

    // MARK: The prompt

    func testThePromptGoesFromThePhoneAsTheDocsHoldIt() throws {
        XCTAssertEqual(CallStart(context: "{}").prompt, CallPrompt.system)
        XCTAssertTrue(CallPrompt.system.contains("{{initialConversationContext}}"))
        for tool in CallTool.allCases { XCTAssertTrue(CallPrompt.system.contains(tool.rawValue), tool.rawValue) }
        var root = URL(fileURLWithPath: #filePath)
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("docs/agent-voice-call.md").path) { root.deleteLastPathComponent() }
        let doc = try String(contentsOf: root.appendingPathComponent("docs/agent-voice-call.md"), encoding: .utf8)
        XCTAssertTrue(doc.contains("```text\n" + CallPrompt.system + "\n```"), "docs/agent-voice-call.md holds the prompt the phone sends")
    }

    func testTheToolsAreDescribedForTheDashboard() {
        XCTAssertEqual(CallTool.allCases.map(\.rawValue), ["listConversations", "readConversation", "message", "navigate"])
        XCTAssertEqual(CallTool.listConversations.parameters["required"], .array([]))
        XCTAssertEqual(CallTool.readConversation.parameters["required"], .array([.string("ref")]))
        XCTAssertEqual(CallTool.message.parameters["required"], .array([.string("text")]))
        XCTAssertNil(CallTool.message.parameters["properties"]?["focusRevision"])
        XCTAssertEqual(CallTool.message.parameters["properties"]?["to"]?["type"], .string("string"))
        XCTAssertEqual(CallTool.message.parameters["properties"]?["model"]?["type"], .string("string"))
        XCTAssertEqual(CallTool.message.parameters["properties"]?["effort"]?["type"], .string("string"))
        XCTAssertEqual(CallTool.navigate.parameters["required"], .array([.string("to"), .string("focusRevision")]))
        XCTAssertEqual(CallTool.navigate.parameters["properties"]?["focusRevision"]?["type"], .string("integer"))
        XCTAssertTrue(CallTool.message.summary.contains("only when the person has explicitly asked you to send"))
        XCTAssertTrue(CallTool.message.summary.contains("queued on the person's device, not confirmed delivered"))
        XCTAssertTrue(CallTool.listConversations.summary.contains("case-insensitive substring"))
        for destination in CallContext.destinations { XCTAssertTrue(CallTool.navigate.summary.contains(destination), destination) }
    }

    /// docs/agent-voice-call.md's client tools are what the phone answers, word for word.
    func testTheDocsHoldTheseToolsExactly() throws {
        var root = URL(fileURLWithPath: #filePath)
        while !FileManager.default.fileExists(atPath: root.appendingPathComponent("docs/agent-voice-call.md").path) { root.deleteLastPathComponent() }
        let doc = try String(contentsOf: root.appendingPathComponent("docs/agent-voice-call.md"), encoding: .utf8)
        let blocks = doc.components(separatedBy: "```json\n").dropFirst().compactMap { $0.components(separatedBy: "\n```").first }
        let tools = try blocks.map { try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }.filter { $0["type"] == .string("client") }
        XCTAssertEqual(tools.map { $0["name"] }, CallTool.allCases.map { .string($0.rawValue) })
        for (tool, documented) in zip(CallTool.allCases, tools) {
            XCTAssertEqual(documented["description"], .string(tool.summary), tool.rawValue)
            XCTAssertEqual(documented["parameters"], tool.parameters, tool.rawValue)
        }
    }

    func testListConversationsPagesAndFiltersBySubstring() async throws {
        let many = (0..<120).map { CallTarget(agentId: "x\($0)", title: $0 % 2 == 0 ? "Even \($0)" : "Odd \($0)", kind: .task, status: .idle) }
        let context = CallContext(targets: FakeCallTargets(directory: many, states: [:], focus: nil))
        _ = await context.initial()
        let first = try object(await tool(context, "listConversations", "{}").text)
        XCTAssertEqual((first["conversations"] as? [Any])?.count, 50)
        XCTAssertEqual(first["nextCursor"] as? String, "50")
        let odd = try object(await tool(context, "listConversations", #"{"query":"DD 1","cursor":null}"#).text)
        XCTAssertEqual((odd["conversations"] as? [[String: Any]])?.count, 16)
        let paged = try object(await tool(context, "listConversations", #"{"query":"odd","cursor":"50"}"#).text)
        XCTAssertEqual((paged["conversations"] as? [Any])?.count, 10)
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
        let initial = await context.initial()
        XCTAssertTrue(initial.contains("""
        Conversations in the app, in the sidebar's order:
        - Architect — bot, ref s1
        - Release notes — task, ref s2
          - Fix cache race — subtask, ref s3
            - Check the lock — subtask, ref s4
        - New Task — task, ref s5
        - App — project
          - Root chat — conversation, ref s6
          - Feature — workspace
            - Feature chat — conversation, ref s7
        """), initial)
        // No IDs of the computer's in what the agent reads.
        for id in ["arch-agent", "t1-agent", "sub1", "subsub", "root", "wchat"] { XCTAssertFalse(initial.contains(id), id) }
        let listed = try object(await tool(context, "listConversations", #"{"query":"lock"}"#).text)
        let found = try XCTUnwrap((listed["conversations"] as? [[String: Any]])?.first)
        XCTAssertEqual(found["ref"] as? String, "s4")
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
        let read = try object(await tool(context, "readConversation", #"{"ref":"s2"}"#).text)
        XCTAssertEqual(read["title"] as? String, "Fix cache race")
        XCTAssertEqual(read["parents"] as? [String], ["Release notes"])
        XCTAssertNil(read["ref"])
        XCTAssertEqual((read["turns"] as? [[String: Any]])?.first?["assistant"] as? String, "sub answer")
        let opened = try object(await tool(context, "navigate", #"{"to":"happy://conversation/s2","focusRevision":0}"#).text)
        XCTAssertEqual(opened["opened"] as? Bool, true)
        let sent = try object(await tool(context, "message", #"{"to":"s2","text":"go on"}"#).text)
        XCTAssertEqual(sent["status"] as? String, "queued")
        let sends = await targets.sends
        XCTAssertEqual(sends.map(\.agentId), ["c"])
        // A reference no one gave reaches nothing.
        let forged = await tool(context, "readConversation", #"{"ref":"s9"}"#)
        XCTAssertTrue(forged.isError)
    }

    /// A reference reaches a conversation while the sidebar lists it; gone,
    /// it reaches nothing; back, it reaches it again.
    func testAReferenceReachesWhatIsListedNow() async throws {
        let docs = docsTarget
        let targets = FakeCallTargets(directory: [backendTarget, docs], states: [
            "a": CallTargetState(target: backendTarget), "b": CallTargetState(target: docs),
        ], focus: "b")
        let context = CallContext(targets: targets)
        _ = await context.initial()
        await targets.setDirectory([backendTarget])
        for (name, json) in [
            ("readConversation", #"{"ref":"s1"}"#),
            ("navigate", #"{"to":"happy://conversation/s1","focusRevision":0}"#),
            ("message", #"{"to":"s1","text":"hi"}"#),
        ] {
            let refused = await tool(context, name, json)
            XCTAssertTrue(refused.isError, name)
        }
        await targets.setDirectory([backendTarget, docs])
        let read = await tool(context, "readConversation", #"{"ref":"s1"}"#)
        XCTAssertFalse(read.isError)
    }

    /// The directory goes once, at the start: what came since gives its
    /// reference with the first update about it, and only then.
    func testWhatCameSinceTheStartComesWithItsReference() async throws {
        let targets = FakeCallTargets(directory: [releaseTarget], states: ["t": CallTargetState(target: releaseTarget)], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        let fresh = fixTarget
        await targets.setDirectory([releaseTarget, fresh])
        let focus = try events(await context.focusChanged(to: "c"))
        XCTAssertEqual(focus.map { $0["event"] as? String }, ["focus"])
        XCTAssertEqual(focus[0]["title"] as? String, "Fix cache race")
        XCTAssertEqual(focus[0]["parents"] as? [String], ["Release notes"])
        XCTAssertEqual(focus[0]["ref"] as? String, "s2")
        // Its words after that: by name alone.
        _ = await context.targetChanged(CallTargetState(target: fresh, working: true))
        let words = try events(await context.targetChanged(CallTargetState(target: fresh, messages: [CallMessage(id: "m", role: .assistant, text: "Fixed.")])))
        XCTAssertEqual(words.map { $0["event"] as? String }, ["assistant_text"])
        XCTAssertNil(words[0]["ref"])
        // listConversations gives references too: what it listed comes without one.
        let other = CallTarget(agentId: "o", title: "Other", kind: .task, status: .idle)
        await targets.setDirectory([releaseTarget, fresh, other])
        _ = await tool(context, "listConversations", #"{"query":"other"}"#)
        let listed = try events(await context.focusChanged(to: "o"))
        XCTAssertNil(listed[0]["ref"])
    }

    /// Work deleted since: a reply that comes late from it says nothing,
    /// under its old name or any.
    func testALateReplyFromWorkThatWentAwaySaysNothing() async throws {
        let targets = backend(focus: "b")
        let context = CallContext(targets: targets)
        _ = await context.initial()
        _ = await context.targetChanged(CallTargetState(target: docsTarget, working: true))
        await targets.setDirectory([backendTarget])
        _ = await tool(context, "listConversations", "{}")
        let late = await context.targetChanged(CallTargetState(target: docsTarget, messages: [CallMessage(id: "w", role: .assistant, text: "Done.")],
                                                               turns: [CallTurn(id: "x", ended: "error", error: "Boom")]))
        XCTAssertTrue(late.isEmpty)
    }

    /// A conversation under more than the directory can show: still
    /// listed, with what it sits under on one line cut to fit, and the ones after it too.
    func testAnEntryTooDeepForTheDirectoryStillGoes() async throws {
        let chain = (0..<80).map { CallTarget.Parent(id: "session:p\($0)", title: "Parent \($0) " + String(repeating: "y", count: 180), kind: "subtask", agentId: "p\($0)") }
        let deep = CallTarget(agentId: "deep", title: "Deep one", kind: .subtask, status: .idle, parents: chain)
        let after = CallTarget(agentId: "after", title: "After it", kind: .task, status: .idle)
        let text = await CallContext(targets: FakeCallTargets(directory: [deep, after], states: [:], focus: nil)).initial()
        XCTAssertTrue(text.contains("\n(under Parent 0 "), text)
        XCTAssertTrue(text.contains("\n- Deep one — subtask, ref "), text)
        // What comes after it is counted, for listConversations to find.
        XCTAssertTrue(text.contains("\n… and 1 more; listConversations finds them by title."), text)
        XCTAssertLessThanOrEqual(text.utf8.count, CallContext.Limits.totalBytes)
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
        // When the run ended is the turn's: what lastAgentReply says.
        let timed = ChatItem.TurnEnd(reason: "completed", durationMs: 5, tools: 0, copyText: "Done.", endedAt: 1_700_000_000_000)
        let ended = CallTargetState.from(chat(first + [ChatItem(id: "r1:status", role: .turnEnd(timed), pieces: [], delivery: .sent, turn: "r1")]), target: CallTarget(agentId: "a", title: "A", kind: .task, status: .idle))
        XCTAssertEqual(ended.turns.map(\.endedAt), [1_700_000_000_000])
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

    /// The agent's end_call is a hang-up, not a failure: the call goes
    /// idle as End leaves it, and whoever holds it hears once.
    func testTheAgentHangingUpEndsTheCallAsEndWould() async {
        let connection = FakeCallConnection()
        var events: CallEvents?
        let session = CallSession(grants: FakeGrants(.granted(CallGrant(agentId: "g", conversationToken: "t", userId: "u"))),
                                  permission: { true }) { _, _, callEvents in
            events = callEvents
            return connection
        }
        var hangUps = 0
        session.onHangUp = { hangUps += 1 }
        session.start(language: nil, context: { "" }, tool: { _ in CallToolResult(text: "") })
        await waitUntil { if case .active = session.state { true } else { false } }
        events?.hungUp()
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(hangUps, 1)
        await waitUntil { connection.ended }
        // What the dying connection still says changes nothing.
        events?.disconnected()
        events?.hungUp()
        XCTAssertEqual(session.state, .idle)
        XCTAssertEqual(hangUps, 1)
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

    /// Names full of quotes, backslashes, slashes and control characters
    /// keep a resync within what a call keeps waiting.
    func testBudgetsHoldInEncodedJSON() async throws {
        let nasty = "\"q\" \\b\\ /s/ \u{1}\u{2}\u{7}\u{1B}"
        let many = (0..<400).map { CallTarget(agentId: "x\($0)", title: "\($0) " + String(repeating: nasty, count: 8), kind: .task, status: .idle) }
        let visits = Array(many.prefix(4))
        var states: [String: CallTargetState] = [:]
        for target in visits { states[target.agentId] = CallTargetState(target: target) }
        let targets = FakeCallTargets(directory: many, states: states, focus: nil)
        let context = CallContext(targets: targets)
        let initial = await context.initial()
        XCTAssertLessThanOrEqual(initial.utf8.count, CallContext.Limits.totalBytes)
        for target in visits {
            _ = await context.focusChanged(to: target.agentId)
            _ = await context.targetChanged(CallTargetState(target: target))
            let words = (0..<6).map { CallMessage(id: "\(target.agentId)m\($0)", role: .assistant, text: String(repeating: nasty, count: 200)) }
            _ = await context.targetChanged(CallTargetState(target: target, messages: words))
        }
        func size(_ update: CallUpdate) -> Int { update.context.reduce(0) { $0 + $1.utf8.count + 1 } }
        let resync = await context.resync()
        XCTAssertLessThanOrEqual(size(resync), CallSession.pendingBytes)
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
        XCTAssertNil(CallAgent.id("$(HAPPY_CALL_AGENT_V3_ID)"))
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
            // Kept two months at least, however short the window.
            XCTAssertEqual(store.saved.spans.map(\.id), ["a", "b"])
            allowance.record(call: "c", from: CallAllowance.kept + 2_000, to: CallAllowance.kept + 2_010)
            XCTAssertEqual(store.saved.spans.map(\.id), ["b", "c"])
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
    func send(_ agentId: String, text: String, id: String, change: CallModeChange?) async -> CallSendOutcome {
        if let delay { try? await Task.sleep(for: delay) }
        sends.append((agentId, text, id))
        changes.append(change)
        return .queued
    }
    func follow(_ agentId: String, _ following: Bool) async { follows.append((agentId, following)) }

    /// New work started off screen: unlisted until its first message.
    private(set) var made: [(kind: CallTarget.Kind, name: String)] = []
    private(set) var discarded: [String] = []
    private(set) var changes: [CallModeChange?] = []
    private var unlistedWork: [String: CallTarget] = [:]
    /// What new work starts on, and may switch to, as compose's pickers have them.
    private var newWorkMode: CallMode?
    private var newWorkModels: [CallModel] = []
    func setNewWork(mode: CallMode?, models: [CallModel]) { newWorkMode = mode; newWorkModels = models }
    /// Screens over home, the top last: what `back` and `home` take away.
    var screens = 0
    func setScreens(_ count: Int) { screens = count }
    func draft(_ kind: CallTarget.Kind, name: String) async -> CallTarget? {
        made.append((kind, name))
        let draft = CallTarget(agentId: "new-\(made.count)", title: name.isEmpty ? (kind == .bot ? "New Bot" : "New Task") : name, kind: kind, status: .idle)
        unlistedWork[draft.agentId] = draft
        states[draft.agentId] = CallTargetState(target: draft, mode: newWorkMode, models: newWorkModels)
        return draft
    }
    func discard(_ agentId: String) async {
        discarded.append(agentId)
        unlistedWork[agentId] = nil
        states[agentId] = nil
    }
    /// Compose opened by the person: new work on a screen of its own.
    func composeByHand() {
        made.append((.task, ""))
        let draft = CallTarget(agentId: "new-\(made.count)", title: "New Task", kind: .task, status: .idle)
        unlistedWork[draft.agentId] = draft
        states[draft.agentId] = CallTargetState(target: draft)
        screens += 1
    }
    func unlisted(_ agentId: String) async -> CallTarget? { unlistedWork[agentId] }
    func back() async -> CallScreenMove {
        guard screens > 0 else { return .refused("This is home; there is nothing to go back to.") }
        screens -= 1
        return .moved(atHome: screens == 0)
    }
    func home() async -> CallScreenMove {
        screens = 0
        return .moved(atHome: true)
    }
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
