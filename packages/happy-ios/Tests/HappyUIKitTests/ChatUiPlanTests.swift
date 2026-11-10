#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
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

    /// The stack stands at the agent's words' left edge, every pill the
    /// widest option's width; a provider's option has its mark, and its
    /// note changing (or arriving) moves nothing.
    func testAProvidersPillHasItsMarkAndItsNoteMovesNothing() throws {
        let options = ["Add another Claude Code account", "That's all for now"]
        let ui: [ReplyUi?] = [ReplyUi(type: "provider", props: .object(["provider": .string("claude")])), nil]
        let unread = plan(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, live: true, ui: ui))
        let two = plan(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, live: true, ui: ui, notes: ["2 accounts", nil]))
        let none = plan(QuickReplies(messageId: "a1", toolCallId: "call1", options: options, live: true, ui: ui, notes: ["Not installed", nil]))
        XCTAssertEqual(two.controls.map(\.frame), unread.controls.map(\.frame))
        XCTAssertEqual(none.controls.map(\.frame), unread.controls.map(\.frame))
        XCTAssertEqual(none.size, unread.size)
        let frames = unread.controls.map(\.frame)
        XCTAssertEqual(frames[0].minX, MessageLayout.Metrics.marginH)
        XCTAssertEqual(frames[0].width, frames[1].width)
        XCTAssertLessThan(frames[0].width, 393 - MessageLayout.Metrics.bubbleLeading - MessageLayout.Metrics.marginH + 1)
        let marks = two.items.compactMap { if case .image(let name, let frame, _) = $0 { (name, frame) } else { nil } }
        XCTAssertEqual(marks.map(\.0), ["icon-claude"])
        XCTAssertEqual(marks.first?.1.minX, frames[0].minX + MessageLayout.Metrics.bubblePaddingH)
    }

    /// A sign-in row is one height whatever it says: signed out, waiting
    /// for a code, refused, signed in with two accounts.
    func testASignInRowKeepsItsHeightInEveryState() throws {
        func cli(_ extra: [String: JSONValue]) throws -> UiLive {
            var value: [String: JSONValue] = [
                "id": .string("claude"), "name": .string("Claude Code"), "version": .string("v"),
                "installation": .object(["status": .string("installed")]), "signIn": .object(["status": .string("signed_out")]),
            ]
            for (key, one) in extra { value[key] = one }
            return .provider(try XCTUnwrap(UiProviderCli(.object(value))))
        }
        func row(_ live: UiLive?, attempt: UiAttempt? = nil) -> ChatRowPlan {
            var shown = UiShown(offer: UiOffer(messageId: "a1", uiId: "u1", componentId: "sign"), type: "provider_sign_in", props: .object(["provider": .string("claude")]), kind: .live,
                                fallback: "Sign in to Claude", state: .init(attempt: attempt))
            shown.live = live
            let key = ChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
            return ChatPlanner.plan(ChatItem(id: "a1", role: .agent, pieces: [.ui(shown)], delivery: .sent, turn: "r1"), key: key, copied: false, syntax: CodeSyntaxService())
        }
        let out = row(try cli([:]))
        let waiting = row(try cli(["operation": .object(["id": .string("op"), "kind": .string("sign_in"), "status": .string("waiting"),
                                                       "authorization": .object(["url": .string("https://claude.com/x"), "acceptsCode": .bool(true)])])]))
        let refused = row(try cli([:]), attempt: UiAttempt(type: "provider_sign_in.submit_token", outcome: UiOutcome(status: "rejected", reason: "Claude didn't accept this token, and here is a long reason that would wrap")))
        let two = row(try cli(["accounts": .array([.object(["id": .string("a"), "label": .string("ada@example.com"), "signIn": .string("signed_in")]),
                                                   .object(["id": .string("b"), "label": .string("work@example.com"), "signIn": .string("signed_in")])])]))
        let unread = row(nil)
        for plan in [waiting, refused, two, unread] { XCTAssertEqual(plan.size, out.size) }
        XCTAssertEqual(out.controls.map(\.label), ["Sign in"])
        XCTAssertEqual(waiting.controls.map(\.label), ["Open page", "Paste code", "Cancel"])
        XCTAssertTrue(out.items.contains { if case .image("icon-claude", _, _) = $0 { true } else { false } })
    }
}
#endif
