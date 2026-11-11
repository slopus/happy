import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// `readConversation`'s paging and cuts (`CallRead`): backwards by turn,
/// each with its `t:` reference, messages cut in the middle past their
/// words, the whole within the wire's limit. Android's `CallReadTest` holds
/// the same cases.
final class CallReadTests: XCTestCase {
    private let target = CallTarget(agentId: "a", title: "Backend", kind: .bot, status: .idle)

    /// Eight finished turns, `run-…01` to `run-…08`, oldest first.
    private func eight(reply: (Int) -> String = { "answer \($0)" }) -> [CallTurn] {
        (1...8).map { CallTurn(id: "run-\(String(format: "%02d", $0 * 11))", user: "ask \($0)", reply: reply($0)) }
    }

    private func context(_ state: CallTargetState) async -> (CallContext, FakeCallTargets) {
        let targets = FakeCallTargets(directory: [target], states: ["a": state], focus: nil)
        let context = CallContext(targets: targets)
        _ = await context.initial()
        return (context, targets)
    }

    private func read(_ context: CallContext, _ arguments: String = "") async -> CallToolResult {
        await context.handle(CallToolCall(id: UUID().uuidString, name: "readConversation", parameters: Data(#"{"ref":"s1"\#(arguments)}"#.utf8)))
    }

    private func object(_ result: CallToolResult) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(result.text.utf8)) as? [String: Any])
    }

    private func turns(_ value: [String: Any]) -> [[String: Any]] {
        value["turns"] as? [[String: Any]] ?? []
    }

    // MARK: Paging

    /// No arguments: the five newest turns, as before paging, each with its
    /// reference, and where a read further back starts.
    func testNoArgumentsIsTheFiveNewestEachWithItsRef() async throws {
        let (context, _) = await context(CallTargetState(target: target, turns: eight()))
        let value = try object(await read(context))
        XCTAssertEqual(turns(value).map { $0["user"] as? String }, ["ask 4", "ask 5", "ask 6", "ask 7", "ask 8"])
        XCTAssertEqual(turns(value).map { $0["ref"] as? String }, ["t:44", "t:55", "t:66", "t:77", "t:88"])
        XCTAssertEqual(value["olderTurns"] as? Bool, true)
        XCTAssertEqual(value["continueFrom"] as? String, "t:33")
    }

    /// Only a start: five back from it, given as a ref, as digits or as a
    /// JSON integer alike.
    func testFromAloneReadsFiveBackFromIt() async throws {
        let (context, _) = await context(CallTargetState(target: target, turns: eight()))
        for from in [#""t:66""#, #""2""#, "2", #"" T:66 ""#] {
            let value = try object(await read(context, #","from":\#(from)"#))
            XCTAssertEqual(turns(value).map { $0["ref"] as? String }, ["t:22", "t:33", "t:44", "t:55", "t:66"], from)
            XCTAssertEqual(value["continueFrom"] as? String, "t:11", from)
        }
        let oldest = try object(await read(context, #","from":"t:33""#))
        XCTAssertEqual(turns(oldest).map { $0["ref"] as? String }, ["t:11", "t:22", "t:33"])
        XCTAssertEqual(oldest["olderTurns"] as? Bool, false)
        XCTAssertNil(oldest["continueFrom"])
    }

    /// Both: that range, its ends in either order; back past the oldest
    /// reads to the oldest; never more than fifty.
    func testFromAndBackToReadThatRange() async throws {
        let (context, targets) = await context(CallTargetState(target: target, turns: eight()))
        let range = try object(await read(context, #","from":"t:77","backTo":"t:22""#))
        XCTAssertEqual(turns(range).map { $0["ref"] as? String }, ["t:22", "t:33", "t:44", "t:55", "t:66", "t:77"])
        let reversed = try object(await read(context, #","from":"t:22","backTo":"t:77""#))
        XCTAssertEqual(turns(reversed).map { $0["ref"] as? String }, turns(range).map { $0["ref"] as? String })
        let all = try object(await read(context, #","from":0,"backTo":"100""#))
        XCTAssertEqual(turns(all).count, 8)
        XCTAssertEqual(all["olderTurns"] as? Bool, false)
        let many = (1...80).map { CallTurn(id: "x\($0)", user: "ask \($0)") }
        await targets.set("a", CallTargetState(target: target, turns: many))
        let capped = try object(await read(context, #","backTo":79"#))
        XCTAssertEqual(turns(capped).count, CallRead.maxTurns)
        XCTAssertEqual(turns(capped).first?["user"] as? String, "ask 31")
        XCTAssertEqual(capped["continueFrom"] as? String, "t:30")
    }

    /// The message still waiting for an answer is the newest turn, 0 back,
    /// with its own ref; a read from further back leaves it out.
    func testTheWaitingMessageIsTheNewestTurn() async throws {
        let waiting = CallMessage(id: "msg-9z", role: .user, text: "and now?", delivery: .queued)
        let (context, _) = await context(CallTargetState(target: target, turns: eight(), unanswered: waiting))
        let newest = try object(await read(context))
        XCTAssertEqual(turns(newest).count, 4)
        let pending = try XCTUnwrap(newest["pendingUserMessage"] as? [String: Any])
        XCTAssertEqual(pending["ref"] as? String, "t:9z")
        XCTAssertEqual(pending["text"] as? String, "and now?")
        XCTAssertEqual(pending["delivery"] as? String, "queued")
        let back = try object(await read(context, #","from":1"#))
        XCTAssertNil(back["pendingUserMessage"])
        XCTAssertEqual(turns(back).map { $0["ref"] as? String }, ["t:44", "t:55", "t:66", "t:77", "t:88"])
    }

    /// Two characters, or as many more as tell one ID from the others.
    func testRefsGrowWhereTwoCharactersFitAnother() {
        XCTAssertEqual(CallRead.references(["aa13f", "bb13f", "cc77", "7"]), ["t:a13f", "t:b13f", "t:77", "t:7"])
        XCTAssertEqual(CallRead.references(["x13f", "13f"]), ["t:x13f", "t:13f"])
    }

    /// A ref that fits several turns or none, a conversation's ref, a
    /// start past the oldest and words that aren't a number are refused,
    /// each saying why.
    func testUnclearArgumentsAreRefusedSayingWhy() async throws {
        let turns = ["aa13f", "bb13f", "cc77"].map { CallTurn(id: $0, user: "ask \($0)") }
        let (context, _) = await context(CallTargetState(target: target, turns: turns))
        let cases: [(String, String)] = [
            (#","from":"t:3f""#, "t:3f fits several turns: t:a13f, t:b13f. Use one of those."),
            (#","backTo":"t:zz""#, "No turn t:zz in this conversation. Use a ref from one of its reads."),
            (#","from":"s1""#, "s1 is a conversation's ref; from takes a turn's ref, such as t:3f, or a number of turns back."),
            (#","from":"3""#, "from 3 is past the oldest of the 3 turns (0 to 2 back)."),
            (#","from":"latest""#, "from is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest)."),
            (#","backTo":-1"#, "backTo is a turn's ref from a read, such as t:3f, or a number of turns back from the newest (0 is the newest)."),
            (#","words":"lots""#, "words must be a number of words, 20 to 5000."),
        ]
        for (arguments, reason) in cases {
            let result = await read(context, arguments)
            XCTAssertTrue(result.isError, arguments)
            XCTAssertEqual(try object(result)["reason"] as? String, reason, arguments)
        }
        let full = try object(await read(context, #","from":"t:a13f","backTo":"t:a13f""#))
        XCTAssertEqual(self.turns(full).map { $0["user"] as? String }, ["ask aa13f"])
    }

    // MARK: Exchanges

    private func ask(_ id: String, _ text: String) -> ChatItem {
        ChatItem(id: id, role: .user, pieces: [.text(text)], delivery: .sent, turn: String(id.dropFirst()))
    }

    private func end(_ run: String, _ reason: String = "completed", copy: String? = nil) -> ChatItem {
        ChatItem(id: "\(run):status", role: .turnEnd(ChatItem.TurnEnd(reason: reason, durationMs: 5, tools: 0, copyText: copy)), pieces: [], delivery: .sent, turn: run)
    }

    private func said(_ id: String, _ text: String, run: String) -> ChatItem {
        ChatItem(id: id, role: .agent, pieces: [.text(text)], delivery: .sent, turn: run)
    }

    private func state(_ items: [ChatItem], working: Bool = true) -> CallTargetState {
        var snapshot = ChatSnapshot()
        snapshot.loaded = true
        snapshot.working = working
        snapshot.items = items
        return CallTargetState.from(snapshot, target: target)
    }

    /// The conversation as the computer has it, read through the chat:
    /// each run's last words are its answer, tool calls after them or not,
    /// never its earlier words; a steered run and the agent's own run go on
    /// with the exchange before them; the person's message still being
    /// answered is the one waiting.
    func testAConversationReadsAsExchangesOfThePersonsMessageAndTheLastWords() async throws {
        func run(_ id: String, user: String?, ended reason: String?, _ content: [Any]) -> JSONValue {
            let blocks: [JSONValue] = content.map { part in
                if let text = part as? String { return .object(["type": .string("text"), "text": .string(text)]) }
                return part as? JSONValue ?? .null
            }
            var messages: [JSONValue] = []
            if let user { messages.append(TurnServer.message("u-\(id)", role: "user", content: [.object(["type": .string("text"), "text": .string(user)])])) }
            messages.append(TurnServer.message("m-\(id)", role: "agent", content: blocks))
            let status = switch reason {
            case nil: "running"
            case "steering"?: "aborted"
            case "error"?: "failed"
            default: "completed"
            }
            var value: [String: JSONValue] = ["id": .string(id), "status": .string(status), "startedAt": .number(1_000), "messages": .array(messages)]
            if let reason { value["reason"] = .string(reason); value["endedAt"] = .number(2_000) }
            return .object(value)
        }
        let server = TurnServer(runs: [
            run("r1", user: "Fix the build", ended: "completed", ["Looking.", TurnServer.call("t1", "exec_command"), "Fixed it.", TurnServer.call("t2", "exec_command")]),
            run("r2", user: "Why did it fail?", ended: "steering", ["Checking the logs.", TurnServer.call("t3", "exec_command")]),
            run("r3", user: "And add a test", ended: "completed", ["The lockfile changed; the test is in.", TurnServer.call("t4", "exec_command")]),
            run("r4", user: nil, ended: "completed", ["The subagent's checks are green.", TurnServer.call("t5", "exec_command")]),
            run("r5", user: "Ship it", ended: "completed", ["Shipped."]),
            run("r6", user: "Now the docs", ended: nil, ["Writing"]),
        ])
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "a")
        var updates = conversation.updates.makeAsyncIterator()
        await conversation.start()
        var snapshot: ChatSnapshot?
        while let next = await updates.next() {
            if next.loaded, next.items.contains(where: { $0.id == "r5:status" }) { snapshot = next; break }
        }
        await conversation.stop()
        let state = CallTargetState.from(try XCTUnwrap(snapshot), target: target)
        XCTAssertEqual(state.exchanges.map(\.id), ["r1", "r2", "r5"])
        XCTAssertEqual(state.exchanges.map(\.user), ["Fix the build", "Why did it fail?", "Ship it"])
        XCTAssertEqual(state.exchanges.map(\.reply), ["Fixed it.", "The subagent's checks are green.", "Shipped."])
        XCTAssertEqual(state.unanswered?.text, "Now the docs")
        let (context, _) = await context(state)
        let value = try object(await read(context))
        XCTAssertEqual(turns(value).map { $0["ref"] as? String }, ["t:r1", "t:r2", "t:r5"])
        XCTAssertEqual(turns(value).map { $0["assistant"] as? String }, ["Fixed it.", "The subagent's checks are green.", "Shipped."])
        XCTAssertEqual((value["pendingUserMessage"] as? [String: Any])?["text"] as? String, "Now the docs")
    }

    /// Steering doesn't start a turn: the exchange keeps the message that
    /// started it, and its answer is the last words of the run that ended
    /// it, as it ended. While it runs, its message is the one waiting.
    func testASteeredExchangeIsOneTurnWithTheFirstMessageAndTheLastWords() async throws {
        let steered = [ask("ur1", "Fix the build"), said("a1", "Looking at the logs.", run: "r1"), end("r1", "steering", copy: "Looking at the logs.")]
        let going = state(steered + [ask("ur2", "And add a test"), said("a2", "On it", run: "r2")])
        XCTAssertEqual(going.exchanges, [])
        XCTAssertEqual(going.unanswered?.id, "ur1")
        XCTAssertEqual(going.unanswered?.text, "Fix the build")
        // Queued on the phone before the run took it: still the first.
        XCTAssertEqual(state([ask("ur1", "Fix the build"), said("a1", "Looking", run: "r1"),
                              ChatItem(id: "q", role: .user, pieces: [.text("and a test")], delivery: .sending)]).unanswered?.id, "ur1")
        let failure = ChatItem(id: "f", role: .failure(Failure(messageId: "f", reason: "Rate limited")), pieces: [], delivery: .sent, turn: "r2")
        let done = state(steered + [ask("ur2", "And add a test"), said("a2", "Fixed, with a test.", run: "r2"), failure,
                                    end("r2", "error", copy: "Fixed, with a test.")], working: false)
        XCTAssertEqual(done.exchanges, [CallTurn(id: "r1", user: "Fix the build", reply: "Fixed, with a test.", ended: "error", error: "Rate limited")])
        XCTAssertNil(done.unanswered)
        let (context, _) = await context(done)
        let value = try object(await read(context))
        XCTAssertEqual(turns(value).count, 1)
        XCTAssertEqual(turns(value).first?["ref"] as? String, "t:r1")
        XCTAssertEqual(turns(value).first?["user"] as? String, "Fix the build")
        XCTAssertEqual(turns(value).first?["assistant"] as? String, "Fixed, with a test.")
        XCTAssertEqual(turns(value).first?["ended"] as? String, "error")
        XCTAssertEqual(turns(value).first?["error"] as? String, "Rate limited")
    }

    /// The agent's own runs after an answer go on with that exchange: its
    /// answer is their last words, or stays when they have none. The
    /// person's steering of one starts a new exchange, the first having
    /// its answer.
    func testTheAgentsOwnRunsGoOnWithTheExchangeBeforeThem() {
        let exchanges = CallTurn.exchanges([
            CallTurn(id: "r1", user: "Start the subagent", reply: "Started.", endedAt: 1),
            CallTurn(id: "r2", reply: "It reported: all green.", endedAt: 2),
            CallTurn(id: "r3", endedAt: 3),
            CallTurn(id: "r4", user: "Deploy", reply: "Deploying.", endedAt: 4),
            CallTurn(id: "r5", reply: "Checking the rollout", ended: "steering", endedAt: 5),
            CallTurn(id: "r6", user: "Stop it", reply: "Stopped.", endedAt: 6),
        ])
        XCTAssertEqual(exchanges.answered, [
            CallTurn(id: "r1", user: "Start the subagent", reply: "It reported: all green.", endedAt: 3),
            CallTurn(id: "r4", user: "Deploy", reply: "Deploying.", endedAt: 4),
            CallTurn(id: "r6", user: "Stop it", reply: "Stopped.", endedAt: 6),
        ])
        XCTAssertFalse(exchanges.open)
        // An error answered, then the agent's own run answered again.
        XCTAssertEqual(CallTurn.exchanges([CallTurn(id: "r1", user: "go", ended: "error", error: "Boom"), CallTurn(id: "r2", reply: "Recovered.")]).answered,
                       [CallTurn(id: "r1", user: "go", reply: "Recovered.")])
        // The oldest the phone has is the agent's own: no message, then the person's steering takes it.
        XCTAssertEqual(CallTurn.exchanges([CallTurn(id: "r1", reply: "Half", ended: "compaction"), CallTurn(id: "r2", user: "and?", reply: "Done.")]).answered,
                       [CallTurn(id: "r1", user: "and?", reply: "Done.")])
    }

    /// Five turns back from the newest are five exchanges, each the
    /// person's message and the agent's last words, however much came
    /// between: steered runs, the agent's own runs, a run with no words.
    func testFiveTurnsAreFiveExchangesWhateverCameBetween() async throws {
        var runs: [CallTurn] = []
        for n in 1...7 {
            runs.append(CallTurn(id: "r\(n)a", user: "ask \(n)", reply: "commentary \(n)", ended: "steering"))
            runs.append(CallTurn(id: "r\(n)b", user: "steer \(n)", reply: "answer \(n)"))
            runs.append(CallTurn(id: "r\(n)c"))
            if n.isMultiple(of: 2) { runs.append(CallTurn(id: "r\(n)d", reply: "later \(n)")) }
        }
        let waiting = CallMessage(id: "u8", role: .user, text: "ask 8", delivery: .accepted)
        let (context, _) = await context(CallTargetState(target: target, turns: runs, unanswered: waiting))
        let value = try object(await read(context, #","backTo":"t:3a""#))
        let page = turns(value)
        XCTAssertEqual(page.map { $0["ref"] as? String }, ["t:3a", "t:4a", "t:5a", "t:6a", "t:7a"])
        XCTAssertEqual(page.map { $0["user"] as? String }, ["ask 3", "ask 4", "ask 5", "ask 6", "ask 7"])
        XCTAssertEqual(page.map { $0["assistant"] as? String }, ["answer 3", "later 4", "answer 5", "later 6", "answer 7"])
        XCTAssertEqual(page.map { $0["ended"] as? String }, Array(repeating: "completed", count: 5))
        XCTAssertEqual(value["continueFrom"] as? String, "t:2a")
        let newest = try object(await read(context))
        XCTAssertEqual(turns(newest).map { $0["user"] as? String }, ["ask 4", "ask 5", "ask 6", "ask 7"])
        XCTAssertEqual((newest["pendingUserMessage"] as? [String: Any])?["text"] as? String, "ask 8")
        // The first context's turns are the same.
        XCTAssertEqual(CallContext.recent(CallTargetState(target: target, turns: runs)).map(\.reply), ["answer 3", "later 4", "answer 5", "later 6", "answer 7"])
    }

    // MARK: Words

    /// Past its words a message is cut in the middle, half its start and
    /// half its end, saying how many words it has and how many went; read
    /// again with more words, it comes whole.
    func testAMessagePastItsWordsIsCutInTheMiddleWithItsWholeSize() async throws {
        let long = (1...1200).map { "w\($0)" }.joined(separator: " ")
        let (context, _) = await context(CallTargetState(target: target, turns: [CallTurn(id: "r1", user: "tell me all", reply: long)]))
        let first = try object(await read(context))
        let turn = try XCTUnwrap(turns(first).first)
        let expected = (1...250).map { "w\($0)" } + ["… (700 words left out) …"] + (951...1200).map { "w\($0)" }
        XCTAssertEqual(turn["assistant"] as? String, expected.joined(separator: " "))
        XCTAssertEqual(turn["user"] as? String, "tell me all")
        let cut = try XCTUnwrap(turn["cut"] as? [String: Any])
        XCTAssertEqual(cut["assistant"] as? [String: Int], ["words": 1200, "leftOut": 700])
        XCTAssertNil(cut["user"])
        let again = try object(await read(context, #","from":"t:r1","words":2000"#))
        let whole = try XCTUnwrap(turns(again).first)
        XCTAssertEqual(whole["assistant"] as? String, long)
        XCTAssertNil(whole["cut"])
        // Fewer than twenty is twenty, more than five thousand five thousand.
        let fewest = try object(await read(context, #","words":1"#))
        let least = try XCTUnwrap(turns(fewest).first)
        XCTAssertEqual((least["cut"] as? [String: Any])?["assistant"] as? [String: Int], ["words": 1200, "leftOut": 1180])
    }

    /// The cut itself: whole within its words and ten bytes a word; a text
    /// with no spaces cut between characters, half its bytes each side.
    func testTheCutKeepsWholeWordsOrHalfTheBytes() throws {
        XCTAssertNil(CallRead.cut("a few words", words: 20))
        XCTAssertEqual(CallRead.cut("one two three four five", words: 2)?.text, "one … (3 words left out) … five")
        let blob = String(repeating: "x", count: 600)
        let cut = try XCTUnwrap(CallRead.cut(blob, words: 20))
        XCTAssertEqual(cut.text, String(repeating: "x", count: 100) + " … (1 word left out) … " + String(repeating: "x", count: 100))
        XCTAssertEqual(cut.words, 1)
        XCTAssertEqual(cut.leftOut, 1)
        let wide = String(repeating: "é", count: 300)
        XCTAssertEqual(CallRead.cut("start " + wide + " end", words: 20)?.text, "start … (1 word left out) … end")
    }

    // MARK: The wire

    /// Within 56 KB as escaped on the wire: the oldest of the range give
    /// way first and `continueFrom` names the newest of those left out; a
    /// turn alone too big has its words halved until it fits.
    func testTheWireLimitDropsTheOldestThenHalvesTheWords() async throws {
        let heavy = String(repeating: "<<<< ", count: 1600)
        let (context, targets) = await context(CallTargetState(target: target, turns: eight { _ in heavy }))
        let result = await read(context, #","backTo":7,"words":5000"#)
        XCTAssertLessThanOrEqual(CallContext.escapedSize(Data(result.text.utf8)), CallContext.Limits.readBytes)
        let value = try object(result)
        XCTAssertEqual(turns(value).map { $0["ref"] as? String }, ["t:88"])
        XCTAssertEqual(turns(value).first?["assistant"] as? String, heavy)
        XCTAssertEqual(value["continueFrom"] as? String, "t:77")
        await targets.set("a", CallTargetState(target: target, turns: [CallTurn(id: "r1", user: heavy, reply: heavy + heavy)]))
        let alone = await read(context, #","words":5000"#)
        XCTAssertLessThanOrEqual(CallContext.escapedSize(Data(alone.text.utf8)), CallContext.Limits.readBytes)
        let turn = try XCTUnwrap(turns(try object(alone)).first)
        XCTAssertEqual(((turn["cut"] as? [String: Any])?["assistant"] as? [String: Int])?["words"], 3200)
        XCTAssertEqual(((turn["cut"] as? [String: Any])?["user"] as? [String: Int])?["words"], 1600)
    }

    // MARK: Not current

    /// A read of a conversation that isn't current is paged as asked at
    /// once, marked `refreshing`; what the refresh finds new comes as one
    /// cue, its turns cut by the most words a read of it asked for.
    func testANotCurrentReadIsPagedAtOnceAndItsUpdateCutAsRead() async throws {
        var state = CallTargetState(target: target, turns: eight())
        state.fresh = false
        let (_, targets) = await context(state)
        await targets.setRefresh("a", .after(.milliseconds(150)))
        let context = CallContext(targets: targets, refresh: .seconds(2))
        let cues = CueBox()
        await context.onReading { reading in
            if case .update(let cue) = reading { cues.add(cue.text) }
        }
        _ = await context.initial()
        let answer = try object(await read(context, #","from":"t:66","words":30"#))
        XCTAssertEqual(answer["refreshing"] as? Bool, true)
        XCTAssertEqual(turns(answer).map { $0["ref"] as? String }, ["t:22", "t:33", "t:44", "t:55", "t:66"])
        XCTAssertEqual(answer["continueFrom"] as? String, "t:11")
        let refused = await read(context, #","from":"t:zz""#)
        XCTAssertTrue(refused.isError)
        let long = (1...100).map { "w\($0)" }.joined(separator: " ")
        await targets.set("a", CallTargetState(target: target, turns: eight() + [CallTurn(id: "run-99", user: "more", reply: long)]))
        for _ in 0..<100 where cues.all.isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(cues.all.count, 1)
        let update = try XCTUnwrap(cues.all.first.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] })
        XCTAssertEqual(update["event"] as? String, "conversation_update")
        let turn = try XCTUnwrap(turns(update).first)
        XCTAssertEqual(turns(update).count, 1)
        XCTAssertEqual(turn["ref"] as? String, "t:99")
        XCTAssertEqual((turn["cut"] as? [String: Any])?["assistant"] as? [String: Int], ["words": 100, "leftOut": 70])
        XCTAssertEqual(update["continueFrom"] as? String, "t:88")
    }
}

private final class CueBox: @unchecked Sendable {
    private let lock = NSLock()
    private var texts: [String] = []
    var all: [String] { lock.withLock { texts } }
    func add(_ text: String) { lock.withLock { texts.append(text) } }
}
