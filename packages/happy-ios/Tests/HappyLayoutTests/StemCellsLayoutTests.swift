import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the Stem Cells sidebar, the new-work intro and the
/// conversation's stack.
final class StemCellsLayoutTests: XCTestCase {
    func testRowsStackAtTheirKindsHeights() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row),
            .init(kind: .row, hasMark: true, hasTrailing: true),
            .init(kind: .separator, hasMark: false),
            .init(kind: .section, hasMark: false),
            .init(kind: .row, hasMark: false),
        ], width: 390)
        let frames = result.frames
        // Desktop's pixels: the box 6 in (`--happy-panel-inset`), 32 tall
        // (`SIDEBAR_ROW_HEIGHT`); ink 10 inside it; a 20 mark, then 8 to the label.
        XCTAssertEqual(frames[0].box, CGRect(x: 6, y: 6, width: 378, height: 32))
        XCTAssertEqual(frames[0].mark, CGRect(x: 16, y: 12, width: 20, height: 20))
        XCTAssertEqual(frames[0].label, CGRect(x: 44, y: 6, width: 330, height: 32))
        XCTAssertNil(frames[0].trailing)
        // A trailing mark takes 18 and 8 more from the label.
        // Rows stand 2 apart (`SIDEBAR_ROW_GAP`).
        XCTAssertEqual(frames[1].trailing, CGRect(x: 356, y: 47, width: 18, height: 18))
        XCTAssertEqual(frames[1].label, CGRect(x: 44, y: 40, width: 304, height: 32))
        // The separator is 17 tall, its hairline across the box at its middle.
        XCTAssertEqual(frames[2].box, CGRect(x: 6, y: 74, width: 378, height: 17))
        XCTAssertEqual(frames[2].rule, CGRect(x: 6, y: 82, width: 378, height: 1))
        // A section heading is 28; its title keeps clear of its fold's lane.
        XCTAssertEqual(frames[3].box, CGRect(x: 6, y: 93, width: 378, height: 28))
        XCTAssertEqual(frames[3].label, CGRect(x: 16, y: 93, width: 336, height: 28))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 356, y: 98, width: 18, height: 18))
        // No mark: no leading space.
        XCTAssertNil(frames[4].mark)
        XCTAssertEqual(frames[4].label, CGRect(x: 16, y: 123, width: 358, height: 32))
        XCTAssertEqual(result.contentHeight, 155 + 6)
    }

    func testNestedRowsHangOffTheirParentsMark() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row),
            .init(kind: .row, depth: 1),
            .init(kind: .row, depth: 2),
            .init(kind: .row, depth: 1),
        ], width: 320)
        let frames = result.frames
        // A nested row: 16 more padding per level, its branch box pulled back
        // 16, then 8 to the mark.
        XCTAssertEqual(frames[1].mark, CGRect(x: 44, y: 46, width: 20, height: 20))
        XCTAssertEqual(frames[2].mark, CGRect(x: 60, y: 80, width: 20, height: 20))
        XCTAssertEqual(frames[3].label, CGRect(x: 72, y: 108, width: 232, height: 32))
        XCTAssertEqual(result.connectors, [
            // Row 0's children (1 and 3): one stem from 10 under its middle to
            // just past the last child's, and a 9-long elbow into each.
            CGRect(x: 25.5, y: 32, width: 1, height: 93),
            CGRect(x: 26.5, y: 56, width: 9, height: 1),
            CGRect(x: 26.5, y: 124, width: 9, height: 1),
            // Row 1's child (2), one level in.
            CGRect(x: 41.5, y: 66, width: 1, height: 25),
            CGRect(x: 42.5, y: 90, width: 9, height: 1),
        ])
    }

    func testFoldingMovesOnlyWhatFollows() {
        let open = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row), .init(kind: .row)], width: 390)
        let folded = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row)], width: 390)
        XCTAssertEqual(open.frames[0], folded.frames[0])
        XCTAssertEqual(open.frames[1], folded.frames[1])
        XCTAssertEqual(open.contentHeight - folded.contentHeight, 34)
    }

    func testIntroCentresItsMarkOverItsLine() {
        let line = text("Say what it is — it’ll find its place.", advance: 8, lineHeight: 20)
        let wide = MakeStuffIntroLayout(width: 390, line: line)
        XCTAssertEqual(wide.mark, CGRect(x: 163, y: 16, width: 64, height: 64))
        XCTAssertEqual(wide.line, CGRect(x: 16, y: 96, width: 358, height: 20))
        XCTAssertEqual(wide.size, CGSize(width: 390, height: 132))
        // Too narrow for one line: the line wraps and the row grows under it.
        let narrow = MakeStuffIntroLayout(width: 200, line: line)
        XCTAssertEqual(narrow.mark, CGRect(x: 68, y: 16, width: 64, height: 64))
        XCTAssertEqual(narrow.line, CGRect(x: 16, y: 96, width: 168, height: 40))
        XCTAssertEqual(narrow.size.height, 152)
        // Begun: the row ends under its (hidden) line, where the first message lands.
        let settled = MakeStuffIntroLayout(width: 390, line: line, settled: true)
        XCTAssertEqual(settled.mark, wide.mark)
        XCTAssertEqual(settled.line, wide.line)
        XCTAssertEqual(settled.size, CGSize(width: 390, height: 116))
    }

    func testTheComposerRidesTheKeyboard() {
        let size = CGSize(width: 390, height: 844)
        let safe = LayoutInsets(top: 103, left: 0, bottom: 34, right: 0)
        // Keyboard down: the guide's top is the safe area's foot.
        let down = StemCellChatScreenLayout(size: size, safeArea: safe, keyboardTop: 810) { _ in 60 }
        XCTAssertEqual(down.card, CGRect(x: 8, y: 742, width: 374, height: 60))
        XCTAssertEqual(down.listTop, 103)
        XCTAssertEqual(down.listBottom, 110)
        XCTAssertEqual(down.viewport, 631)
        // Keyboard up: the card sits 8 above it.
        let up = StemCellChatScreenLayout(size: size, safeArea: safe, keyboardTop: 508) { width in width == 374 ? 92 : 0 }
        XCTAssertEqual(up.card, CGRect(x: 8, y: 408, width: 374, height: 92))
        XCTAssertEqual(up.listBottom, 444)
        XCTAssertEqual(up.viewport, 297)
    }

    func testShortConversationsRestOnTheComposer() {
        let short = StemCellChatStackLayout(heights: [132, 50], width: 390, viewport: 600)
        XCTAssertEqual(short.frames, [CGRect(x: 0, y: 418, width: 390, height: 132), CGRect(x: 0, y: 550, width: 390, height: 50)])
        XCTAssertEqual(short.contentHeight, 600)
        let long = StemCellChatStackLayout(heights: [400, 300], width: 390, viewport: 600)
        XCTAssertEqual(long.frames, [CGRect(x: 0, y: 0, width: 390, height: 400), CGRect(x: 0, y: 400, width: 390, height: 300)])
        XCTAssertEqual(long.contentHeight, 700)
    }

    func testAgentParagraphsSitOneGapApart() {
        let layout = StemCellMessageLayout.agent(width: 390, blocks: [.text(block(height: 24)), .text(block(height: 48))])
        XCTAssertEqual(layout.markdownOrigin, CGPoint(x: 16, y: 8))
        let frames = layout.markdown?.blocks.compactMap { placed -> CGRect? in
            if case let .text(frame) = placed { return frame }
            return nil
        }
        // No outer margins: the first paragraph starts at the top, the next 8 below.
        XCTAssertEqual(frames, [rect(0, 0, 358, 24), rect(0, 32, 358, 48)])
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 96))
        // A wide screen keeps the reading column.
        let wide = StemCellMessageLayout.agent(width: 1000, maxContentWidth: 800, blocks: [.text(block(height: 24))])
        XCTAssertEqual(wide.markdownOrigin, CGPoint(x: 116, y: 8))
        XCTAssertEqual(wide.markdown?.size.width, 768)
    }

    func testAPersonsMessageHugsTheRightInItsBubble() {
        let short = StemCellMessageLayout.user(width: 390, text: text("hello", lineHeight: 20), showsStatus: false)
        XCTAssertEqual(short.bubble, rect(310, 8, 64, 40))
        XCTAssertEqual(short.text, rect(322, 18, 40, 20))
        XCTAssertNil(short.status)
        XCTAssertEqual(short.size, CGSize(width: 390, height: 56))
        // Long text wraps at 76% of the column, less the padding.
        let long = StemCellMessageLayout.user(width: 390, text: text(String(repeating: "a", count: 100), lineHeight: 20), showsStatus: true)
        XCTAssertEqual(long.bubble, rect(102, 8, 272, 100))
        XCTAssertEqual(long.text, rect(114, 18, 248, 80))
        XCTAssertEqual(long.status, rect(16, 110, 358, 14))
        XCTAssertEqual(long.size.height, 132)
    }

    func testTheIntroOffersWrapCentredUnderItsCaption() {
        let line = text("Say what it is — it’ll find its place.", advance: 8, lineHeight: 20)
        let caption = text("Or start one of these:", advance: 8, lineHeight: 20)
        let layout = MakeStuffIntroLayout(width: 390, line: line, caption: caption, optionLabels: [80, 90, 100, 60, 120, 70])
        XCTAssertEqual(layout.caption, rect(16, 120, 358, 20))
        // Buttons are their label and 42 of chrome; each line is centred.
        XCTAssertEqual(layout.options, [
            rect(64, 156, 122, 28), rect(194, 156, 132, 28),
            rect(69, 192, 142, 28), rect(219, 192, 102, 28),
            rect(54, 228, 162, 28), rect(224, 228, 112, 28),
        ])
        // desktop's makeStuffIntroHeight: 116 + 4 + 20 + 16 + 3 × 28 + 2 × 8 + 16.
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 272))
        // A wide screen wraps at 480.
        let wide = MakeStuffIntroLayout(width: 1000, line: line, caption: caption, optionLabels: [180, 180, 180])
        XCTAssertEqual(wide.options, [rect(274, 156, 222, 28), rect(504, 156, 222, 28), rect(389, 192, 222, 28)])
        // Begun: the options give way and the row ends under its line.
        let settled = MakeStuffIntroLayout(width: 390, line: line, caption: caption, optionLabels: [80], settled: true)
        XCTAssertNil(settled.caption)
        XCTAssertEqual(settled.options, [])
        XCTAssertEqual(settled.size.height, 116)
    }
}
