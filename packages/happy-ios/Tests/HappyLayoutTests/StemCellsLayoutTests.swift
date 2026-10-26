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
        // Desktop's pixels twice over: the box 12 in (`--happy-panel-inset` 6),
        // 64 tall (`SIDEBAR_ROW_HEIGHT` 32); ink 20 inside it; a 40 mark, then 16 to the label.
        XCTAssertEqual(frames[0].box, CGRect(x: 12, y: 12, width: 366, height: 64))
        XCTAssertEqual(frames[0].mark, CGRect(x: 32, y: 24, width: 40, height: 40))
        XCTAssertEqual(frames[0].label, CGRect(x: 88, y: 12, width: 270, height: 64))
        XCTAssertNil(frames[0].trailing)
        // A trailing mark takes 36 and 16 more from the label.
        // Rows stand 4 apart (`SIDEBAR_ROW_GAP` 2).
        XCTAssertEqual(frames[1].trailing, CGRect(x: 322, y: 94, width: 36, height: 36))
        XCTAssertEqual(frames[1].label, CGRect(x: 88, y: 80, width: 218, height: 64))
        // The separator is 34 tall, its 2-thick rule across the box at its middle.
        XCTAssertEqual(frames[2].box, CGRect(x: 12, y: 148, width: 366, height: 34))
        XCTAssertEqual(frames[2].rule, CGRect(x: 12, y: 164, width: 366, height: 2))
        // A section heading is 56; its title keeps clear of its fold's lane.
        XCTAssertEqual(frames[3].box, CGRect(x: 12, y: 186, width: 366, height: 56))
        XCTAssertEqual(frames[3].label, CGRect(x: 32, y: 186, width: 282, height: 56))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 322, y: 196, width: 36, height: 36))
        // No mark: no leading space.
        XCTAssertNil(frames[4].mark)
        XCTAssertEqual(frames[4].label, CGRect(x: 32, y: 246, width: 326, height: 64))
        XCTAssertEqual(result.contentHeight, 310 + 12)
    }

    func testASectionsPlusStandsBeforeItsFold() {
        let frames = StemCellsSidebarLayout.layout([.init(kind: .section, hasMark: false, hasAdd: true), .init(kind: .section, hasMark: false)], width: 390).frames
        XCTAssertEqual(frames[0].chevron, CGRect(x: 322, y: 22, width: 36, height: 36))
        // One square and its gap before the fold; the title keeps clear of it.
        XCTAssertEqual(frames[0].add, CGRect(x: 270, y: 22, width: 36, height: 36))
        XCTAssertEqual(frames[0].label, CGRect(x: 32, y: 12, width: 230, height: 56))
        // Without one, nothing changes.
        XCTAssertNil(frames[1].add)
        XCTAssertEqual(frames[1].label.width, 282)
    }

    func testTheSidebarIsDesktopsTwiceOver() {
        typealias M = StemCellsMetrics
        XCTAssertEqual(M.phone, 2)
        XCTAssertEqual([M.rowHeight, M.sectionHeight, M.separatorHeight, M.rowGap, M.inset, M.padding], [64, 56, 34, 4, 12, 20])
        XCTAssertEqual([M.mark, M.glyph, M.markGap, M.indent, M.trailing, M.unreadDot], [40, 32, 16, 32, 36, 12])
        XCTAssertEqual([M.labelSize, M.sectionLabelSize, M.chevronGlyph, M.questionGlyph, M.clockGlyph, M.line], [26, 22, 24, 30, 28, 2])
    }

    func testNestedRowsHangOffTheirParentsMark() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row),
            .init(kind: .row, depth: 1),
            .init(kind: .row, depth: 2),
            .init(kind: .row, depth: 1),
        ], width: 320)
        let frames = result.frames
        // A nested row: 32 more padding per level, its branch box pulled back
        // 32, then 16 to the mark.
        XCTAssertEqual(frames[1].mark, CGRect(x: 88, y: 92, width: 40, height: 40))
        XCTAssertEqual(frames[2].mark, CGRect(x: 120, y: 160, width: 40, height: 40))
        XCTAssertEqual(frames[3].label, CGRect(x: 144, y: 216, width: 144, height: 64))
        XCTAssertEqual(result.connectors, [
            // Row 0's children (1 and 3): one stem from 20 under its middle to
            // just past the last child's, and an 18-long elbow into each, 2 thick.
            CGRect(x: 51, y: 64, width: 2, height: 186),
            CGRect(x: 53, y: 112, width: 18, height: 2),
            CGRect(x: 53, y: 248, width: 18, height: 2),
            // Row 1's child (2), one level in.
            CGRect(x: 83, y: 132, width: 2, height: 50),
            CGRect(x: 85, y: 180, width: 18, height: 2),
        ])
    }

    func testARowWithNestedRowsWearsItsFoldAtTheEnd() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, hasFold: true),
            .init(kind: .row, depth: 1, hasTrailing: true, hasFold: true),
            .init(kind: .row, depth: 2),
        ], width: 390)
        let frames = result.frames
        // The fold takes the trailing square, as a section's does.
        XCTAssertEqual(frames[0].chevron, CGRect(x: 322, y: 26, width: 36, height: 36))
        XCTAssertNil(frames[0].trailing)
        XCTAssertEqual(frames[0].label, CGRect(x: 88, y: 12, width: 218, height: 64))
        // A status or dot stands one square before it, and the label stops short of both.
        XCTAssertEqual(frames[1].chevron, CGRect(x: 322, y: 94, width: 36, height: 36))
        XCTAssertEqual(frames[1].trailing, CGRect(x: 270, y: 94, width: 36, height: 36))
        XCTAssertEqual(frames[1].label, CGRect(x: 144, y: 80, width: 110, height: 64))
        XCTAssertNil(frames[2].chevron)
        // Neither a separator nor a section takes a row's fold.
        let others = StemCellsSidebarLayout.layout([.init(kind: .separator, hasFold: true), .init(kind: .widget, hasFold: true)], width: 390).frames
        XCTAssertNil(others[0].chevron)
        XCTAssertNil(others[1].chevron)
    }

    func testFoldingMovesOnlyWhatFollows() {
        let open = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row), .init(kind: .row)], width: 390)
        let folded = StemCellsSidebarLayout.layout([.init(kind: .row), .init(kind: .section), .init(kind: .row)], width: 390)
        XCTAssertEqual(open.frames[0], folded.frames[0])
        XCTAssertEqual(open.frames[1], folded.frames[1])
        XCTAssertEqual(open.contentHeight - folded.contentHeight, 68)
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
