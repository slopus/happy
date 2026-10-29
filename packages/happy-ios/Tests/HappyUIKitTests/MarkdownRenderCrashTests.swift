#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Build 47 trapped in `MarkdownPiece.init` planning an agent reply off the
/// main thread: a list item at depth -2 picked `bullets[-2]`. Planning any
/// markdown must never trap.
@MainActor
final class MarkdownRenderCrashTests: XCTestCase {
    /// The reply that crashed, in shape: sub-bullets under numbered lines,
    /// then a bullet back at the margin.
    static let crashing = """
    Done:
    1. **Bold:** the first thing
       - a sub item
       - another sub item
    - back at the margin

    | Column | Other |
    |---|---|
    | a | b |

    2. **Next:** text
    \t- tabbed sub item
    - margin again
    """

    func testTheMarkerClampsAnyDepth() {
        XCTAssertEqual(MarkdownPiece.bullet(depth: -2), "•")
        XCTAssertEqual(MarkdownPiece.bullet(depth: 0), "•")
        XCTAssertEqual(MarkdownPiece.bullet(depth: 1), "◦")
        XCTAssertEqual(MarkdownPiece.bullet(depth: 99), "▪")
    }

    func testTheCrashingReplyPlans() {
        let plan = Self.plan(Self.crashing)
        XCTAssertGreaterThan(plan.size.height, 0)
    }

    /// Random lists, numbered lists, tables, code, headers and quotes at
    /// random indentation, planned whole, as the chat does.
    func testFuzzedMarkdownPlans() {
        let pieces = [
            "- item", "* star", "+ plus", "1. one", "12) twelve", "**bold:** x", "# Head", "### Small",
            "| a | b |", "|---|---|", "| 1 | 2 |", "```swift", "```", "> quote", "plain text", "",
            "- [ ] task", "`code`", "---", "-", "1.", "    code?",
        ]
        let indents = ["", " ", "  ", "   ", "    ", "      ", "\t", "\t\t", " \t"]
        var state: UInt64 = 47
        func next(_ bound: Int) -> Int {
            // SplitMix64: deterministic, so a failure reproduces.
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return Int((z ^ (z >> 31)) % UInt64(bound))
        }
        for _ in 0..<400 {
            let lines = (0..<(1 + next(14))).map { _ in indents[next(indents.count)] + pieces[next(pieces.count)] }
            let markdown = lines.joined(separator: "\n")
            XCTAssertGreaterThanOrEqual(Self.plan(markdown).size.height, 0, markdown)
        }
    }

    static func plan(_ markdown: String) -> ChatRowPlan {
        let item = StemCellChatItem(id: "m1", role: .agent, pieces: [.text(markdown)], delivery: .sent)
        let key = StemCellChatPlanner.Key(width: 393, maxContentWidth: 10_000, environment: nil)
        return StemCellChatPlanner.plan(item, key: key, copied: false, syntax: CodeSyntaxService())
    }
}
#endif
