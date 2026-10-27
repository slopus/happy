import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the Stem Cells sidebar, the new-work intro and the
/// conversation's stack.
final class StemCellsLayoutTests: XCTestCase {
    /// A third of a point: lanes and glyphs sit on 3x pixels.
    private let third: CGFloat = 1.0 / 3

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
        // 32); a 30 mark centred 24 into the box (32 from the edge), then 12
        // to the label, which rides 2 up so its x-height's middle is the row's.
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 9, width: 374, height: 48))
        XCTAssertEqual(frames[0].mark, CGRect(x: 17, y: 18, width: 30, height: 30))
        XCTAssertEqual(frames[0].label, CGRect(x: 59, y: 7, width: 312 + 2 * third, height: 48))
        XCTAssertNil(frames[0].trailing)
        // The trailing square, 27, centred 24 in from the box's right (on a
        // 3x pixel); the label stops 12 short of it. Rows stand 3 apart (`SIDEBAR_ROW_GAP` 2).
        XCTAssertEqual(frames[1].trailing, CGRect(x: 344 + 2 * third, y: 70 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[1].label, CGRect(x: 59, y: 58, width: 273 + 2 * third, height: 48))
        // The separator is 26 tall, its hairline across the box at its middle.
        XCTAssertEqual(frames[2].box, CGRect(x: 8, y: 111, width: 374, height: 26))
        XCTAssertEqual(frames[2].rule, CGRect(x: 8, y: 123, width: 374, height: 1))
        // A section heading is 42; its title starts 15 into the box (desktop's
        // 10), where a glyph's ink does, and keeps clear of its fold's lane.
        XCTAssertEqual(frames[3].box, CGRect(x: 8, y: 140, width: 374, height: 42))
        XCTAssertEqual(frames[3].label, CGRect(x: 23, y: 140, width: 315 + 2 * third, height: 42))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 344 + 2 * third, y: 147 + 2 * third, width: 27, height: 27))
        // No mark: no leading space.
        XCTAssertNil(frames[4].mark)
        XCTAssertEqual(frames[4].label, CGRect(x: 17, y: 183, width: 354 + 2 * third, height: 48))
        XCTAssertEqual(result.contentHeight, 233 + 9)
    }

    func testASectionsPlusStandsBeforeItsFold() {
        let frames = StemCellsSidebarLayout.layout([.init(kind: .section, hasMark: false, hasAdd: true), .init(kind: .section, hasMark: false)], width: 390).frames
        XCTAssertEqual(frames[0].chevron, CGRect(x: 344 + 2 * third, y: 16 + 2 * third, width: 27, height: 27))
        // One square and its gap before the fold; the title keeps clear of it.
        XCTAssertEqual(frames[0].add, CGRect(x: 305 + 2 * third, y: 16 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[0].label, CGRect(x: 23, y: 9, width: 276 + 2 * third, height: 42))
        // Without one, nothing changes.
        XCTAssertNil(frames[1].add)
        XCTAssertEqual(frames[1].label.width, 315 + 2 * third)
    }

    func testTheSidebarIsDesktopsHalfAgain() {
        typealias M = StemCellsMetrics
        XCTAssertEqual(M.phone, 1.5)
        XCTAssertEqual([M.rowHeight, M.sectionHeight, M.separatorHeight, M.rowGap, M.inset], [48, 42, 26, 3, 8])
        XCTAssertEqual([M.mark, M.glyph, M.markGap, M.trailing, M.addGlyph], [30, 24, 12, 27, 21])
        XCTAssertEqual([M.labelSize, M.sectionLabelSize, M.chevronGlyph, M.questionGlyph, M.clockGlyph], [19.5, 16.5, 18, 22.5, 21])
        // Nesting and its lines aren't scaled: desktop's 28 a level, 1 thick.
        XCTAssertEqual([M.indent, M.line], [28, 1])
    }

    /// Each end of a row holds its mark centred in a square the row's
    /// height (Kirill's rule, desktop's 16 in a 32 row): the leading mark's
    /// centre and the fold's optical centre (its ink's weight, not its box)
    /// half the row in from the row box's side, as far as from its top.
    func testEachEndsMarkIsCentredInASquareTheRowsHeight() {
        typealias M = StemCellsMetrics
        for width: CGFloat in [375, 402, 440] {
            let frames = StemCellsSidebarLayout.layout([
                .init(kind: .row, hasFold: true),
                .init(kind: .row, hasFold: true, foldClosed: true),
                .init(kind: .section, hasMark: false, hasAdd: true),
                .init(kind: .row, depth: 1, hasTrailing: true),
            ], width: width).frames
            for (index, frame) in frames.prefix(2).enumerated() {
                let box = frame.box
                // 24 in from the left, 24 down: on the row's middle.
                XCTAssertEqual(frame.mark!.midX - box.minX, 24)
                XCTAssertEqual(frame.mark!.midY - box.minY, 24)
                // The chevron's ink weighs 24 in from the right and 24 down,
                // to the nearest 3x pixel.
                let ink = index == 0 ? M.chevronDownInk : M.chevronRightInk
                let glyph = frame.chevronGlyph!
                XCTAssertEqual(glyph.size, CGSize(width: M.chevronGlyph, height: M.chevronGlyph))
                XCTAssertEqual(box.maxX - (glyph.midX + ink.dx), 24, accuracy: third / 2 + 0.001)
                XCTAssertEqual(glyph.midY + ink.dy - box.minY, 24, accuracy: third / 2 + 0.001)
                XCTAssertEqual((glyph.minX * 3).rounded(), glyph.minX * 3, accuracy: 0.0001)
                XCTAssertEqual((glyph.minY * 3).rounded(), glyph.minY * 3, accuracy: 0.0001)
                // Left inset = right inset: the row is balanced.
                XCTAssertEqual(frame.mark!.midX - box.minX, box.maxX - (glyph.midX + ink.dx), accuracy: third / 2 + 0.001)
                // The title keeps the mark's 12 and rides 2 up to the marks' middle.
                XCTAssertEqual(frame.label.minX - frame.mark!.maxX, 12)
                XCTAssertEqual(frame.label.midY, box.midY - M.titleLift)
            }
            // A section's fold, its "+" and a status mark stand on the same column.
            XCTAssertEqual(frames[2].chevron!.midX, frames[0].chevron!.midX)
            XCTAssertEqual(frames[3].trailing!.midX, frames[0].chevron!.midX)
            XCTAssertLessThan(frames[2].add!.maxX, frames[2].chevron!.minX)
            // A section's title starts where a top-level glyph's ink does.
            XCTAssertEqual(frames[2].label.minX, frames[2].box.minX + 15)
        }
        // On a 2x screen the ends land on its whole pixels, as near 24.
        for frame in StemCellsSidebarLayout.layout([.init(kind: .row, hasTrailing: true, hasFold: true)], width: 402, scale: 2).frames {
            for rect in [frame.chevronGlyph!, frame.trailing!] {
                XCTAssertEqual((rect.minX * 2).rounded(), rect.minX * 2, accuracy: 0.0001)
                XCTAssertEqual((rect.minY * 2).rounded(), rect.minY * 2, accuracy: 0.0001)
            }
            XCTAssertEqual(frame.box.maxX - (frame.chevronGlyph!.midX + StemCellsMetrics.chevronDownInk.dx), 24, accuracy: 0.25 + 0.001)
        }
        // The numbers: 8 + 24 = 32 from each edge; the "⌄" drawn 0.34 low
        // and the "›" 0.21 right and 0.13 low of their boxes' centres.
        let frame = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true)], width: 402).frames[0]
        XCTAssertEqual(frame.mark, CGRect(x: 17, y: 18, width: 30, height: 30))
        XCTAssertEqual(frame.chevronGlyph, CGRect(x: 361, y: 24 + third, width: 18, height: 18))
        let closed = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true, foldClosed: true)], width: 402).frames[0]
        XCTAssertEqual(closed.chevronGlyph, CGRect(x: 361 + third, y: 24, width: 18, height: 18))
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
        XCTAssertEqual(frames[1].mark, CGRect(x: 45, y: 69, width: 30, height: 30))
        XCTAssertEqual(frames[2].mark, CGRect(x: 73, y: 120, width: 30, height: 30))
        XCTAssertEqual(frames[3].label, CGRect(x: 87, y: 160, width: 301 + 2 * third - 87, height: 48))
        XCTAssertEqual(result.connectors, [
            // Row 0's children (1 and 3): one stem down its mark's centre, from
            // under the mark to just past the last child's middle, and an elbow
            // into each child, 4 short of its mark.
            CGRect(x: 31, y: 48, width: 1, height: 139),
            CGRect(x: 32, y: 83, width: 9, height: 1),
            CGRect(x: 32, y: 185, width: 9, height: 1),
            // Row 1's child (2), one level in.
            CGRect(x: 59, y: 99, width: 1, height: 37),
            CGRect(x: 60, y: 134, width: 9, height: 1),
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
        XCTAssertEqual(frames[0].chevron, CGRect(x: 344 + 2 * third, y: 19 + 2 * third, width: 27, height: 27))
        XCTAssertNil(frames[0].trailing)
        XCTAssertEqual(frames[0].label, CGRect(x: 59, y: 7, width: 273 + 2 * third, height: 48))
        // A status or dot stands one square before it, and the label stops short of both.
        XCTAssertEqual(frames[1].chevron, CGRect(x: 344 + 2 * third, y: 70 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[1].trailing, CGRect(x: 305 + 2 * third, y: 70 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[1].label, CGRect(x: 87, y: 58, width: 293 + 2 * third - 87, height: 48))
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

    /// Desktop's leading header: the intro stays under the bar and the
    /// rows fill in under it, then scroll as any others once they don't fit.
    func testAnIntroIsPinnedUnderTheBarAndTheRowsFillInUnderIt() {
        let short = StemCellChatStackLayout(heights: [116, 60, 0], width: 390, viewport: 600, pinsFirst: true)
        XCTAssertEqual(short.frames, [CGRect(x: 0, y: 0, width: 390, height: 116), CGRect(x: 0, y: 116, width: 390, height: 60), CGRect(x: 0, y: 176, width: 390, height: 0)])
        XCTAssertEqual(short.contentHeight, 600)
        let long = StemCellChatStackLayout(heights: [116, 400, 300], width: 390, viewport: 600, pinsFirst: true)
        XCTAssertEqual(long.frames.map(\.minY), [0, 116, 516])
        XCTAssertEqual(long.contentHeight, 816)
    }

    /// A send while the agent is idle goes 30% down the viewport, no
    /// higher than a pinned intro's line and no lower than half.
    func testTheSendLiftLineIsDesktopsUnderTheIntro() {
        XCTAssertEqual(StemCellSendLift(viewport: 600, introLine: 116).line, 180)
        // The keyboard up: 30% is above the intro's line, so the line is the intro's.
        XCTAssertEqual(StemCellSendLift(viewport: 297, introLine: 116).line, 116)
        XCTAssertEqual(StemCellSendLift(viewport: 600).line, 180)
        XCTAssertEqual(StemCellSendLift(viewport: 200, introLine: 160).line, 100)
        // The first send, right under the intro's line: there already.
        XCTAssertFalse(StemCellSendLift(viewport: 600, introLine: 116).lifts(shownAt: 116))
        XCTAssertTrue(StemCellSendLift(viewport: 600, introLine: 116).lifts(shownAt: 420))
    }

    /// A lifted follow-up under a pinned intro: on its line with the room
    /// under it held, whatever the viewport, until the reply fills it, and
    /// then where it would rest anyway.
    func testALiftedSendHoldsItsLineUntilTheReplyFillsTheRoom() {
        let lift = StemCellChatStackLayout.Lift(row: 3, line: 180)
        // Intro 116, a send 60, a reply 724, the follow-up 60, working 0.
        let heights: [CGFloat] = [116, 60, 724, 60, 0]
        let held = StemCellChatStackLayout(heights: heights, width: 390, viewport: 600, pinsFirst: true, lift: lift)
        XCTAssertTrue(held.holding)
        XCTAssertEqual(held.frames[3].minY, 900)
        XCTAssertEqual(held.contentHeight, 1320)
        // Following the end, the follow-up stands on the line.
        XCTAssertEqual(held.frames[3].minY - (held.contentHeight - 600), 180)
        // The keyboard up: the same line, the room shorter.
        let up = StemCellChatStackLayout(heights: heights, width: 390, viewport: 297, pinsFirst: true, lift: lift)
        XCTAssertEqual(up.frames[3].minY - (up.contentHeight - 297), 180)
        // The reply fills the room: spent, and nothing moves as it goes.
        let filling = StemCellChatStackLayout(heights: [116, 60, 724, 60, 359], width: 390, viewport: 600, pinsFirst: true, lift: lift)
        XCTAssertTrue(filling.holding)
        let full = StemCellChatStackLayout(heights: [116, 60, 724, 60, 360], width: 390, viewport: 600, pinsFirst: true, lift: lift)
        XCTAssertFalse(full.holding)
        XCTAssertEqual(full.contentHeight, 1320)
        XCTAssertEqual(filling.contentHeight, 1320)
    }

    /// Without an intro a short conversation rests on the composer; a send
    /// lifted from there stands on its line, and the rest it comes back to
    /// once the reply is in is that same place.
    func testALiftWithoutAnIntroComesUpFromTheComposer() {
        let lift = StemCellChatStackLayout.Lift(row: 0, line: 180)
        let sent = StemCellChatStackLayout(heights: [80, 0], width: 390, viewport: 600, lift: lift)
        XCTAssertTrue(sent.holding)
        XCTAssertEqual(sent.frames[0].minY, 180)
        XCTAssertEqual(sent.contentHeight, 600)
        // A reply streaming in stays under it, the send unmoved.
        let streaming = StemCellChatStackLayout(heights: [80, 200], width: 390, viewport: 600, lift: lift)
        XCTAssertEqual(streaming.frames[0].minY, 180)
        XCTAssertEqual(streaming.contentHeight, 600)
        // The reply fills the room: spent, the same place it rests at.
        let full = StemCellChatStackLayout(heights: [80, 340], width: 390, viewport: 600, lift: lift)
        XCTAssertFalse(full.holding)
        XCTAssertEqual(full.frames[0].minY, 180)
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
}
