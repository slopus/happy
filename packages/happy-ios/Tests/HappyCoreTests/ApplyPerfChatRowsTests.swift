import Foundation
import XCTest
import HappyWire
@testable import HappyCore

/// The chat's rows through the production window, grouping and planner,
/// with a planner that counts what it measures instead of laying out text.
final class ApplyPerfChatRowsTests: XCTestCase {
    struct Row: Equatable, Sendable {
        var item: ChatListItem
        var id: String { item.id }
    }

    /// `turns` turns of 4 messages, oldest first: a prompt, a line from the
    /// agent, a finished Read and an answer. The last answer is the one
    /// still streaming.
    static func conversation(turns: Int) -> [ChatMessage] {
        var messages: [ChatMessage] = []
        for index in 0..<turns {
            let turn = "turn-\(index)"
            let at = ApplyPerfFixtures.now + Int64(messages.count) * 1000
            messages.append(.userText(UserTextMessage(id: "user-\(index)", createdAt: at, text: "Question \(index)")))
            messages.append(.agentText(AgentTextMessage(id: "intro-\(index)", createdAt: at + 1, turn: turn, text: "Reading")))
            messages.append(.toolCall(ToolCallMessage(
                id: "tool-\(index)", createdAt: at + 1, turn: turn,
                tool: ToolCall(callId: "call-\(index)", name: "Read", state: .completed, input: .object(["file_path": .string("/work/\(index).swift")]), createdAt: at + 1)
            )))
            messages.append(.agentText(AgentTextMessage(id: "agent-\(index)", createdAt: at + 2, turn: turn, text: "Answer \(index)")))
        }
        return messages
    }

    static func streamed(_ messages: [ChatMessage], _ step: Int) -> [ChatMessage] {
        var messages = messages
        guard case .agentText(var last) = messages[messages.count - 1] else { fatalError("the conversation ends on an answer") }
        last.text += String(repeating: " more", count: step)
        messages[messages.count - 1] = .agentText(last)
        return messages
    }

    final class Pass {
        let planner = RowPlanner<Row, Int> { row, width in Int(width) + row.id.count }
        var window = ChatWindowState()
        var requests = ChatWindowRequests()
        var applied = PlannedRows<Row, Int>()
        var width: CGFloat = 390

        func derive(_ messages: [ChatMessage], thinking: Bool = false) -> ChatRowsDerivation.Result<Row, Int> {
            let result = ChatRowsDerivation.derive(
                messages: messages, window: window, requests: requests, groupToolCalls: true,
                currentTurnComplete: !thinking, inForeground: true, width: width,
                planner: planner, applied: applied,
                makeRows: { items, _ in items.map { Row(item: $0) } },
                id: \.id
            )
            window = result.window.state
            applied = result.rows
            return result
        }
    }

    func testStreamingIntoA2000MessageChatMeasuresOnlyTheLastBubble() {
        let messages = Self.conversation(turns: 500)
        XCTAssertEqual(messages.count, 2000)
        let pass = Pass()
        let first = pass.derive(messages, thinking: true)
        XCTAssertEqual(first.measured, first.rows.ids.count, "the first pass measures the window, once")
        XCTAssertEqual(first.changeset.inserts.count, first.rows.ids.count)
        XCTAssertLessThan(first.rows.ids.count, 200, "the window, not 2000 rows")
        XCTAssertEqual(first.rows.ids.first, "agent-499", "newest first")

        var times: [Duration] = []
        for step in 1...50 {
            let clock = ContinuousClock()
            var result: ChatRowsDerivation.Result<Row, Int>!
            times.append(clock.measure { result = pass.derive(Self.streamed(messages, step), thinking: true) })
            XCTAssertEqual(result.measured, 1, "step \(step)")
            XCTAssertEqual(result.changeset, RowChangeset(reconfigures: [0]), "step \(step)")
        }
        XCTAssertEqual(pass.planner.measured, first.rows.ids.count + 50)

        // The same messages again (a heartbeat, a cursor): nothing to measure
        // and nothing to change.
        let again = pass.derive(Self.streamed(messages, 50), thinking: true)
        XCTAssertEqual(again.measured, 0)
        XCTAssertTrue(again.changeset.isEmpty)
        let median = times.sorted()[times.count / 2]
        print("APPLY_PERF chat stream: 2000 messages, \(first.rows.ids.count) rows, 1 measured per token, derive median \(String(format: "%.2f", median.milliseconds)) ms off main (Linux debug, counting planner)")
    }

    func testAPageOfHistoryMeasuresOnlyTheRowsItAdds() {
        let messages = Self.conversation(turns: 500)
        let pass = Pass()
        let first = pass.derive(messages)
        pass.requests.grows += 1
        let grown = pass.derive(messages)
        let added = grown.rows.ids.count - first.rows.ids.count
        XCTAssertGreaterThan(added, 0)
        XCTAssertEqual(grown.measured, added)
        XCTAssertEqual(grown.changeset.inserts, Array(first.rows.ids.count..<grown.rows.ids.count), "older rows go after the oldest")
        XCTAssertEqual(grown.changeset.reconfigures, [])
        XCTAssertEqual(grown.changeset.deletes, [])
        XCTAssertEqual(Array(grown.rows.ids.prefix(first.rows.ids.count)), first.rows.ids)
        // A request is carried out once, however many passes follow.
        XCTAssertEqual(pass.derive(messages).measured, 0)
    }

    func testANewWidthMeasuresEveryRowOnce() {
        let messages = Self.conversation(turns: 500)
        let pass = Pass()
        let first = pass.derive(messages)
        pass.width = 744
        let wide = pass.derive(messages)
        XCTAssertEqual(wide.measured, first.rows.ids.count)
        XCTAssertEqual(wide.changeset.reconfigures, Array(0..<first.rows.ids.count))
        XCTAssertFalse(wide.changeset.isStructural)
        XCTAssertEqual(pass.derive(messages).measured, 0)
    }

    /// What each measured row saw of the syntax deadline, in order.
    final class DeadlineLog: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [ContinuousClock.Instant?] = []
        func add(_ deadline: ContinuousClock.Instant?) { lock.withLock { seen.append(deadline) } }
        var all: [ContinuousClock.Instant?] { lock.withLock { seen } }
    }

    func derive(_ messages: [ChatMessage], planner: RowPlanner<Row, Int>, width: CGFloat = 390, deadline: ContinuousClock.Instant? = nil) -> ChatRowsDerivation.Result<Row, Int> {
        ChatRowsDerivation.derive(
            messages: messages, window: ChatWindowState(), requests: ChatWindowRequests(), groupToolCalls: true,
            currentTurnComplete: true, inForeground: true, width: width,
            planner: planner, applied: PlannedRows(),
            makeRows: { items, _ in items.map { Row(item: $0) } },
            id: \.id, syntaxDeadline: deadline
        )
    }

    /// Every row a pass measures sees the pass's one deadline, however
    /// long measuring takes; the next pass has its own.
    func testOnePassSharesOneSyntaxDeadline() throws {
        let log = DeadlineLog()
        let planner = RowPlanner<Row, Int> { row, width in
            log.add(SyntaxPass.current)
            Thread.sleep(forTimeInterval: 0.001)
            return Int(width)
        }
        let messages = Self.conversation(turns: 500)
        let first = derive(messages, planner: planner)
        XCTAssertEqual(log.all.count, first.measured)
        XCTAssertEqual(Set(log.all).count, 1, "one deadline for \(first.measured) rows")
        let deadline = try XCTUnwrap(log.all.first ?? nil)
        XCTAssertNil(SyntaxPass.current, "nothing outside the pass")

        let next = derive(messages, planner: planner, width: 744)
        XCTAssertEqual(log.all.count, first.measured + next.measured)
        let later = Set(log.all.dropFirst(first.measured))
        XCTAssertEqual(later.count, 1)
        XCTAssertGreaterThan(try XCTUnwrap(later.first ?? nil), deadline, "a new pass, a new second")
    }

    /// With each row taking 600 ms of colour work, a shared second colours
    /// the first two rows and leaves the rest to the background; a budget
    /// per row, as before, would colour all of them, one second each.
    func testASecondRowDoesNotResetTheDeadline() {
        let start = ContinuousClock.now
        let rowCost = Duration.milliseconds(600)
        func run(inPass: Bool) -> [Bool] {
            let log = DeadlineLog()
            let planner = RowPlanner<Row, Int> { row, width in
                // A fake clock: row n starts its colour work n × 600 ms in.
                log.add(SyntaxPass.deadline(now: start + rowCost * log.all.count))
                return Int(width)
            }
            let messages = Array(Self.conversation(turns: 1).prefix(4))
            if inPass {
                _ = derive(messages, planner: planner, deadline: start + .milliseconds(DiffSyntax.revealMilliseconds))
            } else {
                _ = planner.plan(messages.reversed().map { Row(item: .message($0)) }, id: \.id, width: 390, applied: PlannedRows())
            }
            return log.all.enumerated().map { index, deadline in deadline.map { start + rowCost * index < $0 } ?? false }
        }
        let shared = run(inPass: true)
        XCTAssertGreaterThanOrEqual(shared.count, 3)
        XCTAssertEqual(shared, [true, true] + Array(repeating: false, count: shared.count - 2))
        XCTAssertEqual(run(inPass: false), [true, true, true, true], "outside a pass every row starts its own second")
    }

    func testOpeningAWorkGroupMeasuresItsHeaderAndInsertsItsMembers() throws {
        let messages = Self.conversation(turns: 500)
        let pass = Pass()
        let first = pass.derive(messages)
        let header = try XCTUnwrap(first.rows.inputs.first { if case .workHeader = $0.item { return true } else { return false } })
        pass.requests.toggles.append(header.id)
        let opened = pass.derive(messages)
        XCTAssertGreaterThan(opened.changeset.inserts.count, 0, "the Read shows")
        XCTAssertEqual(opened.changeset.deletes, [])
        XCTAssertEqual(opened.measured, opened.changeset.inserts.count + opened.changeset.reconfigures.count)
        XCTAssertLessThanOrEqual(opened.changeset.reconfigures.count, 1, "only the header's own row, if it changed")
    }
}
