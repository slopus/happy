import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the stem-cell sidebar's story rows, as desktop's
/// (`sidebar.css` "Story rows", 82e56f80's corners): a 64 card on a 70.5
/// pitch, the 50 disc with its ring outside it, the title, up to two status
/// lines, the time and the signal one inset from the card's corners.
final class StemCellsStoryRowLayoutTests: XCTestCase {
    typealias S = StemCellsStoryRowMetrics
    typealias L = StemCellsSidebarLayout

    private func assertRect(_ rect: CGRect?, _ expected: CGRect, accuracy: CGFloat = 1e-9, file: StaticString = #filePath, line: UInt = #line) {
        guard let rect else { return XCTFail("no frame", file: file, line: line) }
        for (a, b) in [(rect.minX, expected.minX), (rect.minY, expected.minY), (rect.width, expected.width), (rect.height, expected.height)] {
            XCTAssertEqual(a, b, accuracy: accuracy, "\(rect) is not \(expected)", file: file, line: line)
        }
    }

    func testTheMetricsAreDesktops() {
        XCTAssertEqual([S.rowHeight, S.cardInset, S.cornerRadius, S.rowGap, S.pad, S.disc, S.ringRoom, S.ring, S.textGap], [64, 3, 14, 6.5, 7, 50, 4, 58, 10])
        XCTAssertEqual([S.titleSize, S.titleBaseline, S.timeSize, S.statusSize, S.statusLine, S.corner], [15.5, 19.5, 12.5, 14, 16, 11.9])
        XCTAssertEqual([S.signal, S.signalRoom, S.dot, S.countsGap], [14, 20, 10, 4])
        XCTAssertEqual(S.statusLines, 2)
        XCTAssertEqual([S.ringRadius, S.unseenWidth, S.seenWidth, S.segmentGap], [27.5, 2, 1.5, 3])
    }

    func testTheCardTheDiscAndTheText() {
        let frame = L.layout([.init(kind: .row, story: .init(timeWidth: 20))], width: 390).frames[0]
        // The card 3 in from the list, 64 tall.
        XCTAssertEqual(frame.box, CGRect(x: 3, y: 9, width: 384, height: 64))
        // The disc 7 into it and centred on its height; the ring's room around it.
        XCTAssertEqual(frame.mark, CGRect(x: 10, y: 16, width: 50, height: 50))
        XCTAssertEqual(frame.ring, CGRect(x: 6, y: 12, width: 58, height: 58))
        // The text 10 past the disc; the title's baseline 19.5 into the card.
        let text = L.StoryText.standard()
        XCTAssertEqual(frame.label.minX, 70)
        XCTAssertEqual(frame.label.minY + text.title.ascender - frame.box.minY, S.titleBaseline, accuracy: 1e-9)
        // Two status lines, the last on the baseline 11.9 above the card's bottom.
        let status = try! XCTUnwrap(frame.subtitle)
        XCTAssertEqual(status.minX, 70)
        XCTAssertEqual(status.height, 32)
        XCTAssertEqual(status.minY + 16 + text.statusBaseline, frame.box.maxY - S.corner, accuracy: 1e-9)
        XCTAssertNil(frame.draft)
        XCTAssertNil(frame.empty)
        XCTAssertNil(frame.trailing)
        XCTAssertNil(frame.chevron)
    }

    func testTheTimeAndTheSignalStandOneInsetFromTheCorners() {
        let frames = L.layout([
            .init(kind: .row, story: .init(corner: .dot, timeWidth: 20)),
            .init(kind: .row, story: .init(corner: .braille, timeWidth: 36)),
            .init(kind: .row, story: .init(corner: .none)),
        ], width: 390).frames
        let text = L.StoryText.standard()
        for frame in frames {
            let card = frame.box
            // The lane: one width whatever it holds, standing on the last baseline.
            assertRect(frame.signalLane, CGRect(x: card.maxX - 11.9 - 14, y: card.maxY - 11.9 - 14, width: 14, height: 14))
            // The status ends the lane's room before it, signal or not.
            XCTAssertEqual(frame.subtitle!.maxX, card.maxX - 31.9, accuracy: 1e-9)
        }
        // The time's ink (its box less the digits' bearing) ends 11.9 in,
        // and its cap top is the title's, 8.65 under the card's top.
        for frame in frames.prefix(2) {
            let time = try! XCTUnwrap(frame.time)
            XCTAssertEqual(time.maxX - S.timeBearing, frame.box.maxX - 11.9, accuracy: 1e-9)
            let timeCap = time.minY + text.time.ascender - text.time.capHeight
            let titleCap = frame.label.minY + text.title.ascender - text.title.capHeight
            XCTAssertEqual(timeCap, titleCap, accuracy: 1e-9)
            XCTAssertEqual(timeCap - frame.box.minY, 8.65, accuracy: 1e-9)
            XCTAssertEqual(frame.label.maxX, time.minX - S.timeGap, accuracy: 1e-9)
        }
        // The dot and the spinner end on the lane's right edge and the last
        // baseline, on whole pixels at 3x.
        let dot = try! XCTUnwrap(frames[0].corner)
        XCTAssertEqual(dot.size, CGSize(width: 10, height: 10))
        XCTAssertEqual(dot.maxX, frames[0].signalLane!.maxX, accuracy: 1.0 / 6)
        XCTAssertEqual(dot.maxY, frames[0].box.maxY - 11.9, accuracy: 1.0 / 6)
        let braille = try! XCTUnwrap(frames[1].corner)
        XCTAssertEqual(braille.size, S.braille)
        XCTAssertEqual(braille.maxX, frames[1].signalLane!.maxX, accuracy: 1.0 / 6)
        XCTAssertEqual(braille.maxY, frames[1].box.maxY - 11.9, accuracy: 1.0 / 6)
        for rect in [dot, braille] {
            XCTAssertEqual((rect.minX * 3).rounded(), rect.minX * 3, accuracy: 1e-9)
            XCTAssertEqual((rect.minY * 3).rounded(), rect.minY * 3, accuracy: 1e-9)
        }
        XCTAssertNil(frames[2].corner)
        XCTAssertNil(frames[2].time)
        // No time: the title runs to the card's padding.
        XCTAssertEqual(frames[2].label.maxX, frames[2].box.maxX - S.pad)
    }

    func testCardsAre70AndAHalfApartAndHeadingsKeepTheirRoom() {
        let result = L.layout([
            .init(kind: .row, story: .init()),
            .init(kind: .row, story: .init()),
            .init(kind: .section),
            .init(kind: .row, story: .init()),
        ], width: 390)
        let boxes = result.frames.map(\.box)
        XCTAssertEqual(boxes[1].minY - boxes[0].minY, 70.5)
        XCTAssertEqual(boxes[2].minY - boxes[1].maxY, 12.5)
        XCTAssertEqual(boxes[3].minY - boxes[2].maxY, 6.5)
        XCTAssertEqual(result.contentHeight, boxes[3].maxY + StemCellsMetrics.contentBottom)
        // No hairlines and no tree.
        XCTAssertTrue(result.connectors.isEmpty)
    }

    func testHeadingsAndSeparatorsAmongStoryRowsAreDesktopsOwnSize() {
        XCTAssertEqual([S.headingHeight, S.headingSize, S.headingInset, S.rowInset, S.headingFoldInset, S.headingBox, S.headingStep, S.headingGlyph, S.headingsGap, S.separatorHeight, S.ruleInset], [22, 11, 10, 6, 7, 18, 22, 12, 2, 17, 6])
        let result = L.layout([
            .init(kind: .section, hasMark: false, hasAdd: true, amongStories: true),
            .init(kind: .row, story: .init()),
            .init(kind: .section, hasMark: false, hasAdd: true, foldClosed: true, amongStories: true),
            .init(kind: .section, hasMark: false, amongStories: true),
        ], width: 390, scale: 3)
        let frames = result.frames
        // 22 tall in a row box 6 in from the list.
        XCTAssertEqual(frames[0].box, CGRect(x: 6, y: 9, width: 378, height: 22))
        // The title on the discs' left edge, 4 clear of the "+".
        XCTAssertEqual(frames[0].label, CGRect(x: 10, y: 9, width: 323, height: 22))
        XCTAssertEqual(frames[0].label.minX, frames[1].mark!.minX)
        // The fold's 18 box 7 in from the row box, the 12 glyph in it by its ink;
        // the "+" one 22 step before it.
        XCTAssertEqual(frames[0].chevron, CGRect(x: 359, y: 11, width: 18, height: 18))
        XCTAssertEqual(frames[0].chevronGlyph, CGRect(x: 362, y: 43.0 / 3, width: 12, height: 12))
        XCTAssertEqual(frames[0].add, CGRect(x: 337, y: 11, width: 18, height: 18))
        // Folded: the "›"'s ink is within a pixel of its middle at this size.
        XCTAssertEqual(frames[2].chevronGlyph!.offsetBy(dx: 0, dy: -frames[2].box.minY), CGRect(x: 362, y: 5, width: 12, height: 12))
        // Without a "+" the title runs to 4 short of the fold.
        XCTAssertNil(frames[3].add)
        XCTAssertEqual(frames[3].label.maxX, 355)
        // 6.5 down to the card it heads, 12.5 from a card down to the next
        // heading, 2 between two headings.
        XCTAssertEqual(frames[1].box.minY - frames[0].box.maxY, 6.5)
        XCTAssertEqual(frames[2].box.minY - frames[1].box.maxY, 12.5)
        XCTAssertEqual(frames[3].box.minY - frames[2].box.maxY, 2)
        // A separator among story rows: desktop's 17, 2 from a card and a heading,
        // its hairline 6 in from the ends of its box, which is 6 in from the list.
        let pinned = L.layout([
            .init(kind: .row, story: .init()),
            .init(kind: .separator, amongStories: true),
            .init(kind: .section, hasMark: false, amongStories: true),
        ], width: 390).frames
        XCTAssertEqual(pinned[1].box, CGRect(x: 6, y: 9 + 64 + 2, width: 378, height: 17))
        XCTAssertEqual(pinned[1].rule, CGRect(x: 12, y: 9 + 64 + 2 + 8, width: 366, height: 1))
        XCTAssertEqual(pinned[2].box.minY - pinned[1].box.maxY, 2)
        XCTAssertEqual(L.layout([.init(kind: .separator, amongStories: true), .init(kind: .row, story: .init())], width: 390).frames[1].box.minY, 9 + 17 + 2)
        // Without stories a heading keeps the phone's size.
        XCTAssertEqual(L.layout([.init(kind: .section, hasMark: false)], width: 390).frames[0].box.height, 42)
    }

    func testTheDraftAndTheEmptyMarkTakeTheLastLine() {
        let frames = L.layout([
            .init(kind: .row, story: .init(last: .status)),
            .init(kind: .row, story: .init(last: .draft)),
            .init(kind: .row, story: .init(last: .empty)),
        ], width: 390).frames
        let text = L.StoryText.standard()
        // The status keeps its first line where it always stands.
        for frame in frames { XCTAssertEqual(frame.subtitle!.minY - frame.box.minY, frames[0].subtitle!.minY - frames[0].box.minY, accuracy: 1e-9) }
        XCTAssertEqual(frames[1].subtitle!.height, 16)
        XCTAssertEqual(frames[2].subtitle!.height, 16)
        // The draft on the second line, ending where the status does.
        let draft = try! XCTUnwrap(frames[1].draft)
        XCTAssertEqual(draft.minY, frames[1].subtitle!.maxY, accuracy: 1e-9)
        XCTAssertEqual(draft.minY + text.statusBaseline, frames[1].box.maxY - S.corner, accuracy: 1e-9)
        XCTAssertEqual(draft.maxX, frames[1].subtitle!.maxX)
        // The dinosaur as tall as "Ag" from the last line's cap top, its ground a
        // cell under it, on whole pixels: 14 × 31 at 3x.
        let empty = try! XCTUnwrap(frames[2].empty)
        assertRect(empty.offsetBy(dx: 0, dy: -frames[2].box.minY), CGRect(x: 70, y: 127.0 / 3, width: 31, height: 14))
        XCTAssertEqual(empty.minY, frames[2].box.maxY - S.corner - text.status.capHeight, accuracy: 1.0 / 6)
        let atTwo = L.layout([.init(kind: .row, story: .init(last: .empty))], width: 390, scale: 2).frames[0].empty!
        for value in [atTwo.minX, atTwo.minY, atTwo.width, atTwo.height] { XCTAssertEqual((value * 2).rounded(), value * 2, accuracy: 1e-9) }
    }

    func testNothingARowShowsMovesItsBoxes() {
        let variants: [L.StoryRow] = [
            .init(), .init(corner: .dot), .init(corner: .braille), .init(timeWidth: 30),
            .init(last: .draft), .init(last: .empty), .init(corner: .braille, timeWidth: 12, last: .draft),
        ]
        let base = L.layout([.init(kind: .row, story: variants[0])], width: 390).frames[0]
        for variant in variants {
            let frame = L.layout([.init(kind: .row, story: variant)], width: 390).frames[0]
            XCTAssertEqual(frame.box, base.box)
            XCTAssertEqual(frame.mark, base.mark)
            XCTAssertEqual(frame.ring, base.ring)
            XCTAssertEqual(frame.label.minY, base.label.minY)
            XCTAssertEqual(frame.subtitle!.minY, base.subtitle!.minY)
            XCTAssertEqual(frame.subtitle!.maxX, base.subtitle!.maxX)
            XCTAssertEqual(frame.signalLane, base.signalLane)
        }
        // A row with no mark keeps the disc's room, so its text starts on the same line.
        let bare = L.layout([.init(kind: .row, hasMark: false, story: .init())], width: 390).frames[0]
        XCTAssertNil(bare.ring)
        XCTAssertEqual(bare.label.minX, base.label.minX)
    }

    func testALargerTextSizeGrowsTheLinesAndKeepsTheStructure() {
        XCTAssertEqual(L.storyHeight(1), 64)
        XCTAssertEqual(L.storyHeight(0.823), 64, "smaller text keeps the card")
        XCTAssertEqual(L.storyHeight(2), 64 + 16.6 + 32, accuracy: 1e-9)
        let text = L.StoryText.standard(scale: 2)
        let frame = L.layout([.init(kind: .row, story: .init(corner: .dot, timeWidth: 40, text: text))], width: 390).frames[0]
        // The disc stays 50 and centred; the text column, the lane and the insets stay.
        XCTAssertEqual(frame.mark!.size, CGSize(width: 50, height: 50))
        XCTAssertEqual(frame.mark!.midY, frame.box.midY, accuracy: 1.0 / 3)
        XCTAssertEqual(frame.label.minX, 70)
        XCTAssertEqual(frame.subtitle!.height, 64)
        XCTAssertEqual(frame.subtitle!.minY + 32 + text.statusBaseline, frame.box.maxY - S.corner, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(frame.label.minY, frame.box.minY)
        XCTAssertEqual(frame.signalLane!.maxX, frame.box.maxX - S.corner, accuracy: 1e-9)
    }

    func testClassicRowsAreUntouched() {
        let frame = L.layout([.init(kind: .row)], width: 390).frames[0]
        XCTAssertNil(frame.ring)
        XCTAssertNil(frame.subtitle)
        XCTAssertNil(frame.corner)
        XCTAssertEqual(frame.box.height, 48)
    }

    func testRingSegmentsRunClockwiseFromTwelveSeenFirst() {
        XCTAssertEqual(StoryRingLayout.arcs(segments: 0, seen: 0, radius: 27.5, gap: 3), [])
        // One story: a whole circle, no gap.
        let one = StoryRingLayout.arcs(segments: 1, seen: 0, radius: 27.5, gap: 3)
        XCTAssertEqual(one.count, 1)
        XCTAssertEqual(one[0].start, -.pi / 2, accuracy: 1e-9)
        XCTAssertEqual(one[0].end - one[0].start, 2 * .pi, accuracy: 1e-9)
        XCTAssertFalse(one[0].seen)
        // Four with two seen: quarters less the gap, the first two grey.
        let four = StoryRingLayout.arcs(segments: 4, seen: 2, radius: 27.5, gap: 3)
        let gap = 3 / 27.5
        XCTAssertEqual(four.map(\.seen), [true, true, false, false])
        for (index, arc) in four.enumerated() {
            XCTAssertEqual(arc.start, -.pi / 2 + CGFloat(index) * .pi / 2 + gap / 2, accuracy: 1e-9)
            XCTAssertEqual(arc.end - arc.start, .pi / 2 - gap, accuracy: 1e-9)
        }
        // More seen than there are is all of them.
        XCTAssertEqual(StoryRingLayout.arcs(segments: 2, seen: 5, radius: 10, gap: 1).map(\.seen), [true, true])
    }
}
