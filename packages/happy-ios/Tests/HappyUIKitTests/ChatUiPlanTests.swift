#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import XCTest
@testable import HappyUI

/// Quick replies as a row plans them: each pill a control VoiceOver
/// presses on its own, the sent one selected, and the stack's frames the
/// same whichever is sent and whether it still takes a tap.
@MainActor
final class ChatUiPlanTests: XCTestCase {
    private func plan(_ replies: QuickReplies) -> ChatRowPlan {
        let key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        let item = ChatItem(id: "replies:a1:call1", role: .agent, pieces: [.quickReplies(replies)], delivery: .sent, turn: "r1")
        return ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
    }

    func testEachPillIsAControlAndOnlyTheNewestStackTakesATap() throws {
        let options = ["Sprout", "Tally", "Pebble"]
        let live = plan(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, live: true))
        XCTAssertEqual(live.controls.map(\.label), options)
        XCTAssertEqual(live.controls.map(\.selected), [false, false, false])
        XCTAssertTrue(live.controls.allSatisfy { $0.action != nil })
        XCTAssertEqual(live.hits.count, 3)
        XCTAssertEqual(live.accessibilityLabel, "", "the pills read as themselves, not again as the row")

        let sent = plan(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, chosen: 1))
        XCTAssertEqual(sent.controls.map(\.selected), [false, true, false])
        XCTAssertTrue(sent.controls.allSatisfy { $0.action == nil })
        XCTAssertTrue(sent.hits.isEmpty)
        // Nothing moves: the same frames, the same height.
        XCTAssertEqual(sent.controls.map(\.frame), live.controls.map(\.frame))
        XCTAssertEqual(sent.size, live.size)
    }
}
#endif
