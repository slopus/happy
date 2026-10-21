#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import HappyWire
import UIKit
import XCTest

/// The Codex cards on a message's screen clip their diff to the card's
/// inner corners, as React Native's `overflow: hidden` does. They need
/// UIKit, so they run only in the simulator.
@MainActor
final class MessageDetailCardTests: XCTestCase {
    private func plan(_ name: String, _ input: JSONValue) -> ChatRowPlan {
        let tool = ToolCall(name: name, state: .completed, input: input, createdAt: 0)
        let message = ChatMessage.toolCall(ToolCallMessage(id: "m1", createdAt: 0, tool: tool))
        let detail = MessageDetailInput(
            message: message, root: nil, showLineNumbers: false, devMode: false,
            diffExpanded: [:], maxContentWidth: .greatestFiniteMagnitude, focusFile: nil, text: .designed, render: .isolated()
        )
        return MessageDetailRenderer.plan(detail, width: 393)
    }

    private func diffClips(_ plan: ChatRowPlan) -> [(radius: CGFloat, corners: CACornerMask)] {
        plan.items.compactMap { item in
            if case .diff(_, _, _, _, let radius, let corners) = item { return (radius, corners) }
            return nil
        }
    }

    func testUnderAHeaderTheDiffClipsItsBottomCorners() {
        let patch = "--- a/a.swift\n+++ b/a.swift\n@@ -1 +1 @@\n-let a = 1\n+let a = 2"
        let clips = diffClips(plan("CodexDiff", .object(["unified_diff": .string(patch)])))
        XCTAssertEqual(clips.count, 1)
        // 8 less the 1 pt rim.
        XCTAssertEqual(clips.first?.radius, 7)
        XCTAssertEqual(clips.first?.corners, .bottom)
    }

    func testTheChatListsDiffsAreNotClipped() {
        let piece = ChatRowRenderer.diffPiece(
            ToolDiffChunk(oldText: "let a = 1", newText: "let a = 2", fileName: "a.swift"),
            index: 0, toolId: "t", showLineNumbers: false, expanded: [], render: .isolated(), text: .designed
        )
        let drawn = piece?.draw(CGRect(x: 0, y: 0, width: 393, height: 100)).items ?? []
        let clips = drawn.compactMap { item -> CGFloat? in
            if case .diff(_, _, _, _, let radius, _) = item { return radius }
            return nil
        }
        XCTAssertEqual(clips, [0])
    }
}
#endif
