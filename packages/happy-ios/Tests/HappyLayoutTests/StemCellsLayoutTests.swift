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
        // Box 8 in from each side; ink 12 inside it.
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 4, width: 374, height: 40))
        XCTAssertEqual(frames[0].mark, CGRect(x: 20, y: 13, width: 22, height: 22))
        XCTAssertEqual(frames[0].label, CGRect(x: 52, y: 4, width: 318, height: 40))
        XCTAssertNil(frames[0].trailing)
        // A trailing mark takes 18 and 8 more from the label.
        // Rows stand 2 apart (`SIDEBAR_ROW_GAP`).
        XCTAssertEqual(frames[1].trailing, CGRect(x: 352, y: 57, width: 18, height: 18))
        XCTAssertEqual(frames[1].label, CGRect(x: 52, y: 46, width: 292, height: 40))
        // The separator's hairline runs the box's width at its middle.
        XCTAssertEqual(frames[2].box, CGRect(x: 8, y: 88, width: 374, height: 21))
        XCTAssertEqual(frames[2].rule, CGRect(x: 8, y: 98, width: 374, height: 1))
        // A section keeps clear of its fold's lane, whether or not it shows.
        XCTAssertEqual(frames[3].box, CGRect(x: 8, y: 111, width: 374, height: 34))
        XCTAssertEqual(frames[3].label, CGRect(x: 20, y: 111, width: 324, height: 34))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 352, y: 119, width: 18, height: 18))
        // No mark: no leading space.
        XCTAssertNil(frames[4].mark)
        XCTAssertEqual(frames[4].label, CGRect(x: 20, y: 147, width: 350, height: 40))
        XCTAssertEqual(result.contentHeight, 187 + 12)
    }

    func testNestedRowsHangOffTheirParentsMark() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row),
            .init(kind: .row, depth: 1),
            .init(kind: .row, depth: 2),
            .init(kind: .row, depth: 1),
        ], width: 320)
        let frames = result.frames
        XCTAssertEqual(frames[1].mark, CGRect(x: 52, y: 55, width: 22, height: 22))
        XCTAssertEqual(frames[2].mark, CGRect(x: 84, y: 97, width: 22, height: 22))
        XCTAssertEqual(frames[3].label, CGRect(x: 84, y: 130, width: 216, height: 40))
        XCTAssertEqual(result.connectors, [
            // Row 1: from under row 0's mark down to its middle, then the elbow.
            CGRect(x: 30.5, y: 35, width: 1, height: 31),
            CGRect(x: 31, y: 65.5, width: 17, height: 1),
            // Its sibling (row 3) follows: the stem runs on past row 2, gaps and all.
            CGRect(x: 30.5, y: 66, width: 1, height: 64),
            // Row 2, under row 1's mark.
            CGRect(x: 62.5, y: 77, width: 1, height: 31),
            CGRect(x: 63, y: 107.5, width: 17, height: 1),
            // Row 3: the last child, its stem from its own top.
            CGRect(x: 30.5, y: 130, width: 1, height: 20),
            CGRect(x: 31, y: 149.5, width: 17, height: 1),
        ])
    }

    func testFoldingMovesOnlyWhatFollows() {
        let open = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row), .init(kind: .row)], width: 390)
        let folded = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row)], width: 390)
        XCTAssertEqual(open.frames[0], folded.frames[0])
        XCTAssertEqual(open.frames[1], folded.frames[1])
        XCTAssertEqual(open.contentHeight - folded.contentHeight, 42)
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
}
