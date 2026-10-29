import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for sidebar v2's story rows, on Telegram's chat list: the
/// ring, the title on a fixed first line with the time and fold at its end,
/// the status on one line, the braille corner signal, the hairlines.
final class StemCellsStoryRowLayoutTests: XCTestCase {
    typealias S = StemCellsStoryRowMetrics

    func testTheStoryRowIsTelegramsChatRow() {
        XCTAssertEqual([S.rowHeight, S.ring, S.plate, S.ringInset, S.textGap, S.textTrailing, S.indent], [64, 48, 36, 12, 12, 16, 60])
        XCTAssertEqual([S.titleSize, S.titleLine, S.titleTop, S.subtitleSize, S.subtitleLine, S.lineGap, S.timeSize], [17, 22, 10, 14, 18, 2, 12])
        XCTAssertEqual(S.subtitleLines, 1)
        XCTAssertEqual([S.dot, S.cornerSlot, S.unseenWidth, S.seenWidth, S.segmentGap], [12, 20, 3, 1.875, 4.5])
        XCTAssertEqual(S.braille, CGSize(width: 8, height: 14))
    }

    func testARowsTitleStaysOnItsLineWhateverItsStatus() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .dot)),
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .braille)),
            .init(kind: .row, story: .init(hasSubtitle: false)),
        ], width: 390)
        let frames = result.frames
        // The box is 8 in, and 64 tall for every top-level row.
        XCTAssertEqual(frames.map(\.box.height), [64, 64, 64])
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 9, width: 374, height: 64))
        // The 48 ring is 12 into the box, with a 36 plate inside.
        XCTAssertEqual(frames[0].ring, CGRect(x: 20, y: 17, width: 48, height: 48))
        XCTAssertEqual(frames[0].mark, CGRect(x: 26, y: 23, width: 36, height: 36))
        // The title is 12 past the ring on a 22 line, 10 into the box.
        XCTAssertEqual(frames[0].label, CGRect(x: 80, y: 19, width: 286, height: 22))
        // One 18-point status line, clear of the fixed corner slot.
        XCTAssertEqual(frames[0].subtitle, CGRect(x: 80, y: 43, width: 266, height: 18))
        // The dot at the text's end, centred on the status, on whole pixels.
        XCTAssertEqual(frames[0].corner, CGRect(x: 354, y: 46, width: 12, height: 12))
        XCTAssertNil(frames[0].trailing)
        XCTAssertNil(frames[0].time)
        // The chat's 8 × 14 braille loader uses the same corner.
        XCTAssertEqual(frames[1].corner!.minX, 358)
        XCTAssertEqual(frames[1].corner!.midY - frames[1].box.minY, frames[0].corner!.midY - frames[0].box.minY, accuracy: 1.0 / 3)
        // Every title sits the same way, including while its status is empty.
        for frame in frames { XCTAssertEqual(frame.label.minY - frame.box.minY, 10) }
        // No agent behind it: no status and no corner.
        XCTAssertNil(frames[2].subtitle)
        XCTAssertNil(frames[2].corner)
        XCTAssertEqual(result.contentHeight, 210)
    }

    func testTheTimeEndsTheFirstLineAndTheFoldRidesBesideIt() {
        let plain = StemCellsSidebarLayout.layout([.init(kind: .row, story: .init(timeWidth: 40))], width: 390).frames[0]
        // Right-aligned on the title's line, 8 clear of the title.
        XCTAssertEqual(plain.time, CGRect(x: 326, y: 19, width: 40, height: 22))
        XCTAssertEqual(plain.label.maxX, 318)
        let classic = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true)], width: 402).frames[0]
        let folds = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true, story: .init(timeWidth: 40))], width: 402).frames[0]
        // The fold on the rows' column, on the title's line, the time before it.
        XCTAssertEqual(folds.chevron!.midX, classic.chevron!.midX)
        XCTAssertEqual(folds.chevron!.midY, folds.label.midY, accuracy: 1.0 / 3)
        XCTAssertEqual(folds.time!.maxX, folds.chevron!.minX - StemCellsMetrics.trailingGap)
        XCTAssertEqual(folds.label.maxX, folds.time!.minX - S.timeGap)
        // The status and the corner don't make way for it.
        XCTAssertEqual(folds.subtitle!.maxX, 402 - 8 - 16 - 20)
    }

    func testHairlinesRunBetweenStoryRowsFromTheText() {
        let frames = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init()),
            .init(kind: .row, story: .init()),
            .init(kind: .section),
            .init(kind: .row, story: .init()),
            .init(kind: .row, depth: 1, story: .init()),
        ], width: 390).frames
        // A third of a point at the foot of the box, from the title's start to the box's end.
        XCTAssertEqual(frames[0].separator, CGRect(x: 80, y: 73 - 1.0 / 3, width: 302, height: 1.0 / 3))
        // None after the last of a run.
        XCTAssertNil(frames[1].separator)
        XCTAssertNil(frames[2].separator)
        // Under a nested row's parent, it starts at the parent's text.
        XCTAssertEqual(frames[3].separator?.minX, frames[3].label.minX)
        XCTAssertNil(frames[4].separator)
    }

    func testNestedStoryRowsAlignWithParentTextWithoutConnectorsOrGaps() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init()),
            .init(kind: .row, depth: 1, story: .init()),
        ], width: 390)
        let (parent, child) = (result.frames[0], result.frames[1])
        XCTAssertEqual(child.ring!.minX, parent.label.minX)
        XCTAssertEqual(child.ring!.width, 42)
        XCTAssertEqual(child.box.height, 56)
        XCTAssertEqual(child.box.minY, parent.box.maxY)
        XCTAssertEqual(child.subtitle!.height, 15.75)
        XCTAssertTrue(result.connectors.isEmpty)
    }

    func testClassicRowsAreUntouched() {
        let frame = StemCellsSidebarLayout.layout([.init(kind: .row)], width: 390).frames[0]
        XCTAssertNil(frame.ring)
        XCTAssertNil(frame.subtitle)
        XCTAssertNil(frame.corner)
        XCTAssertEqual(frame.box.height, 48)
    }

    func testRingSegmentsRunClockwiseFromTwelveSeenFirst() {
        XCTAssertEqual(StoryRingLayout.arcs(segments: 0, seen: 0, radius: 27.75, gap: 4.5), [])
        // One story: a whole circle, no gap.
        let one = StoryRingLayout.arcs(segments: 1, seen: 0, radius: 27.75, gap: 4.5)
        XCTAssertEqual(one.count, 1)
        XCTAssertEqual(one[0].start, -.pi / 2, accuracy: 1e-9)
        XCTAssertEqual(one[0].end - one[0].start, 2 * .pi, accuracy: 1e-9)
        XCTAssertFalse(one[0].seen)
        // Four with two seen: quarters less the gap, the first two grey.
        let four = StoryRingLayout.arcs(segments: 4, seen: 2, radius: 27.75, gap: 4.5)
        let gap = 4.5 / 27.75
        XCTAssertEqual(four.map(\.seen), [true, true, false, false])
        for (index, arc) in four.enumerated() {
            XCTAssertEqual(arc.start, -.pi / 2 + CGFloat(index) * .pi / 2 + gap / 2, accuracy: 1e-9)
            XCTAssertEqual(arc.end - arc.start, .pi / 2 - gap, accuracy: 1e-9)
        }
        // More seen than there are is all of them.
        XCTAssertEqual(StoryRingLayout.arcs(segments: 2, seen: 5, radius: 10, gap: 1).map(\.seen), [true, true])
    }
}
