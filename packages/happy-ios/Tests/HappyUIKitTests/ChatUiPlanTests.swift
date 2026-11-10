#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit
import XCTest
@testable import HappyUI

/// Quick replies and a live card as a row plans them: each pill and each
/// button a control VoiceOver presses on its own.
@MainActor
final class ChatUiPlanTests: XCTestCase {
    private func plan(_ piece: ChatItem.Piece, id: String, granted: Set<String>? = nil) -> ChatRowPlan {
        var key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        key.uiGranted = granted
        let item = ChatItem(id: id, role: .agent, pieces: [piece], delivery: .sent, turn: "r1")
        return ChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
    }

    /// The sent pill is selected, and the stack's frames are the same
    /// whichever is sent and whether it still takes a tap.
    func testEachPillIsAControlAndOnlyTheNewestStackTakesATap() throws {
        let options = ["Sprout", "Tally", "Pebble"]
        let live = plan(.quickReplies(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, live: true)), id: "replies:a1:call1")
        XCTAssertEqual(live.controls.map(\.label), options)
        XCTAssertEqual(live.controls.map(\.selected), [false, false, false])
        XCTAssertTrue(live.controls.allSatisfy { $0.action != nil })
        XCTAssertEqual(live.hits.count, 3)
        XCTAssertEqual(live.accessibilityLabel, "", "the pills read as themselves, not again as the row")

        let sent = plan(.quickReplies(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, chosen: 1)), id: "replies:a1:call1")
        XCTAssertEqual(sent.controls.map(\.selected), [false, true, false])
        XCTAssertTrue(sent.controls.allSatisfy { $0.action == nil })
        XCTAssertTrue(sent.hits.isEmpty)
        // Nothing moves: the same frames, the same height.
        XCTAssertEqual(sent.controls.map(\.frame), live.controls.map(\.frame))
        XCTAssertEqual(sent.size, live.size)
        // At the agent's words' left edge, every pill one width.
        XCTAssertEqual(live.controls.map(\.frame.minX), Array(repeating: MessageLayout.Metrics.marginH, count: 3))
        XCTAssertEqual(Set(live.controls.map(\.frame.width)).count, 1)
    }

    /// The default model's card has one button, which takes a press only
    /// from someone who may change the default and while nothing is on its way.
    func testTheDefaultModelCardsButtonIsAControl() throws {
        let config: JSONValue = .object(["config": .object([
            "defaults": .object(["providerId": .string("claude"), "modelId": .string("opus"), "effort": .string("high"), "permissionMode": .string("auto")]),
            "models": .object(["opus": .object(["name": .string("Claude Opus"), "efforts": .array([.string("low"), .string("high")])])]),
            "providers": .object(["claude": .object(["type": .string("claude"), "enabled": .bool(true), "models": .array([.object(["id": .string("opus"), "enabled": .bool(true)])])])]),
        ])])
        let defaults = try XCTUnwrap(UiModelDefaults(response: JSONEncoder().encode(config)))
        var shown = UiShown(offer: UiOffer(messageId: "a1", uiId: "u1", componentId: "model"), type: "default_model", kind: .defaultModel, fallback: "Choose your default model", defaults: defaults)
        let mine = plan(.ui(shown), id: "a1")
        XCTAssertEqual(mine.controls.map(\.label), ["Change"])
        XCTAssertEqual(mine.hits.map(\.action), [.ui(ChatUiTap(kind: .card(shown, .pickModel)))])
        XCTAssertTrue(mine.accessibilityLabel?.contains("Claude Opus · high") ?? false)

        let members = plan(.ui(shown), id: "a1", granted: ["content.write"])
        XCTAssertTrue(members.hits.isEmpty)
        XCTAssertNil(members.controls.first?.action)

        shown.attempt = UiAttempt(type: "default_model.set", outcome: UiOutcome(status: "pending"))
        XCTAssertTrue(plan(.ui(shown), id: "a1").hits.isEmpty)
    }
}
#endif
