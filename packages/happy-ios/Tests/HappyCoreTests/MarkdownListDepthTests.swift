import Foundation
@testable import HappyCore
import XCTest

/// A list's depth is never negative, whatever its indentation: build 47
/// trapped off the main thread drawing a bullet at depth -2.
final class MarkdownListDepthTests: XCTestCase {
    /// The reply that crashed build 47, in shape: numbered lines with
    /// indented sub-bullets, and a bullet back at the margin. The numbered
    /// list doesn't take the sub-bullets, so they open a list of their own
    /// on an indented item and then go back out.
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

    func testAListThatOpensNestedCountsDepthFromItsLeastIndentedItem() {
        let blocks = Markdown.parse(Self.crashing)
        let lists = blocks.compactMap { block -> [Int]? in
            if case .list(let items) = block { return items.map(\.depth) }
            return nil
        }
        XCTAssertEqual(lists.first, [1, 1, 0])
        XCTAssertEqual(lists.last, [0, 0])
        for depth in lists.joined() { XCTAssertGreaterThanOrEqual(depth, 0) }
    }

    func testANumberedListThatOpensNestedNeverGoesNegative() {
        let blocks = Markdown.parse("    1. nested\n2. margin\n  3. half")
        guard case .numberedList(let items) = blocks.first else { return XCTFail("\(blocks)") }
        XCTAssertEqual(items.map(\.depth), [2, 0, 1])
    }

    /// Lists, numbered lists, tables, code, tabs and mixed indentation in
    /// random order and depth: every item's depth is 0 or more.
    func testFuzzedIndentationNeverGivesANegativeDepth() {
        var generator = SeededGenerator(seed: 47)
        for _ in 0..<3_000 {
            let markdown = Self.fuzzed(using: &generator)
            for block in Markdown.parse(markdown) {
                switch block {
                case .list(let items):
                    for item in items { XCTAssertGreaterThanOrEqual(item.depth, 0, markdown) }
                case .numberedList(let items):
                    for item in items { XCTAssertGreaterThanOrEqual(item.depth, 0, markdown) }
                default:
                    break
                }
            }
        }
    }

    static let pieces = [
        "- item", "* item", "+ item", "1. one", "2. **Bold:** two", "10. ten", "-", "1.",
        "| a | b |", "|---|---|", "| c |", "```", "```swift", "let x = 1", "# Title", "### Sub",
        "", "text with `code` and [link](https://example.com)", "---", "<options>", "<option>A</option>", "</options>",
        "![alt](https://example.com/a.png)", "**unclosed", "- [ ] task", "1) paren",
    ]
    static let indents = ["", " ", "  ", "   ", "    ", "      ", "\t", "\t\t", " \t", "\u{00A0}", "        "]

    static func fuzzed(using generator: inout SeededGenerator) -> String {
        (0..<Int.random(in: 1...14, using: &generator)).map { _ in
            indents.randomElement(using: &generator)! + pieces.randomElement(using: &generator)!
        }.joined(separator: Bool.random(using: &generator) ? "\n" : "\r\n")
    }
}

/// SplitMix64: the same fuzz every run.
struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
