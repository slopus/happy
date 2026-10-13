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
