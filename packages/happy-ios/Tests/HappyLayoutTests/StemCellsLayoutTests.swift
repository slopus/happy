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
        // Desktop's pixels half again: the box 8 in, 48 tall (`SIDEBAR_ROW_HEIGHT`
        // 32); a 30 mark centred 38 in, under the header's left control, then 12 to the label.
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 9, width: 374, height: 48))
        XCTAssertEqual(frames[0].mark, CGRect(x: 23, y: 18, width: 30, height: 30))
        XCTAssertEqual(frames[0].label, CGRect(x: 65, y: 9, width: 299, height: 48))
        XCTAssertNil(frames[0].trailing)
        // The trailing square, 27, centred under the header's right button;
        // the label stops 12 short of it. Rows stand 3 apart (`SIDEBAR_ROW_GAP` 2).
        XCTAssertEqual(frames[1].trailing, CGRect(x: 337, y: 70, width: 27, height: 27))
        XCTAssertEqual(frames[1].label, CGRect(x: 65, y: 60, width: 260, height: 48))
        // The separator is 26 tall, its hairline across the box at its middle.
        XCTAssertEqual(frames[2].box, CGRect(x: 8, y: 111, width: 374, height: 26))
        XCTAssertEqual(frames[2].rule, CGRect(x: 8, y: 123, width: 374, height: 1))
        // A section heading is 42; its title starts where a mark does and keeps clear of its fold's lane.
        XCTAssertEqual(frames[3].box, CGRect(x: 8, y: 140, width: 374, height: 42))
        XCTAssertEqual(frames[3].label, CGRect(x: 23, y: 140, width: 308, height: 42))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 337, y: 147, width: 27, height: 27))
        // No mark: no leading space.
        XCTAssertNil(frames[4].mark)
        XCTAssertEqual(frames[4].label, CGRect(x: 23, y: 185, width: 341, height: 48))
        XCTAssertEqual(result.contentHeight, 233 + 9)
    }

    func testASectionsPlusStandsBeforeItsFold() {
        let frames = StemCellsSidebarLayout.layout([.init(kind: .section, hasMark: false, hasAdd: true), .init(kind: .section, hasMark: false)], width: 390).frames
        XCTAssertEqual(frames[0].chevron, CGRect(x: 337, y: 16, width: 27, height: 27))
        // One square and its gap before the fold; the title keeps clear of it.
        XCTAssertEqual(frames[0].add, CGRect(x: 298, y: 16, width: 27, height: 27))
        XCTAssertEqual(frames[0].label, CGRect(x: 23, y: 9, width: 269, height: 42))
        // Without one, nothing changes.
        XCTAssertNil(frames[1].add)
        XCTAssertEqual(frames[1].label.width, 308)
    }

    func testTheSidebarIsDesktopsHalfAgain() {
        typealias M = StemCellsMetrics
        XCTAssertEqual(M.phone, 1.5)
        XCTAssertEqual([M.rowHeight, M.sectionHeight, M.separatorHeight, M.rowGap, M.inset], [48, 42, 26, 3, 8])
        XCTAssertEqual([M.mark, M.glyph, M.markGap, M.trailing, M.unreadDot, M.addGlyph], [30, 24, 12, 27, 9, 21])
        XCTAssertEqual([M.labelSize, M.sectionLabelSize, M.chevronGlyph, M.questionGlyph, M.clockGlyph], [19.5, 16.5, 18, 22.5, 21])
        // Nesting and its lines aren't scaled: desktop's 28 a level, 1 thick.
        XCTAssertEqual([M.indent, M.line], [28, 1])
    }

    /// The sidebar's lanes are the header's: a top-level mark under the
    /// account picture, every fold and "+" under the search button.
    func testTheLanesLineUpWithTheHeader() {
        for width: CGFloat in [375, 402, 440] {
            var input = HomeHeaderLayout.Input(width: width, safeTop: 62, hairline: 1.0 / 3, title: Measurable { _ in CGSize(width: 90, height: 20) }, status: nil)
            input.showsAccountAvatar = true
            input.singleAction = true
            let header = HomeHeaderLayout(input)
            let frames = StemCellsSidebarLayout.layout([
                .init(kind: .row, hasFold: true),
                .init(kind: .section, hasMark: false, hasAdd: true),
                .init(kind: .row, depth: 1, hasTrailing: true),
            ], width: width).frames
            XCTAssertEqual(frames[0].mark!.midX, header.logo.midX)
            XCTAssertEqual(frames[0].chevron!.midX, header.filterButton.midX, accuracy: 1)
            XCTAssertEqual(frames[1].chevron!.midX, header.filterButton.midX, accuracy: 1)
            XCTAssertEqual(frames[1].label.minX, frames[0].mark!.minX)
            XCTAssertEqual(frames[2].trailing!.midX, header.filterButton.midX, accuracy: 1)
            XCTAssertLessThan(frames[1].add!.maxX, frames[1].chevron!.minX)
        }
    }

    func testNestedRowsHangOffTheirParentsMark() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row),
            .init(kind: .row, depth: 1),
            .init(kind: .row, depth: 2),
            .init(kind: .row, depth: 1),
        ], width: 320)
        let frames = result.frames
        // A nested row's mark stands 28 right of its parent's.
        XCTAssertEqual(frames[1].mark, CGRect(x: 51, y: 69, width: 30, height: 30))
        XCTAssertEqual(frames[2].mark, CGRect(x: 79, y: 120, width: 30, height: 30))
        XCTAssertEqual(frames[3].label, CGRect(x: 93, y: 162, width: 201, height: 48))
        XCTAssertEqual(result.connectors, [
            // Row 0's children (1 and 3): one stem down its mark's centre, from
            // under the mark to just past the last child's middle, and an elbow
            // into each child, 4 short of its mark.
            CGRect(x: 37, y: 48, width: 1, height: 139),
            CGRect(x: 38, y: 83, width: 9, height: 1),
            CGRect(x: 38, y: 185, width: 9, height: 1),
            // Row 1's child (2), one level in.
            CGRect(x: 65, y: 99, width: 1, height: 37),
            CGRect(x: 66, y: 134, width: 9, height: 1),
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
        XCTAssertEqual(frames[0].chevron, CGRect(x: 337, y: 19, width: 27, height: 27))
        XCTAssertNil(frames[0].trailing)
        XCTAssertEqual(frames[0].label, CGRect(x: 65, y: 9, width: 260, height: 48))
        // A status or dot stands one square before it, and the label stops short of both.
        XCTAssertEqual(frames[1].chevron, CGRect(x: 337, y: 70, width: 27, height: 27))
        XCTAssertEqual(frames[1].trailing, CGRect(x: 298, y: 70, width: 27, height: 27))
        XCTAssertEqual(frames[1].label, CGRect(x: 93, y: 60, width: 193, height: 48))
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
        XCTAssertEqual(open.contentHeight - folded.contentHeight, 51)
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
