import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for sidebar v2's story rows, on Telegram's chat list: the
/// ring, the title on a fixed first line with the time and fold at its end,
/// the status in up to two lines, the one corner signal, the hairlines.
final class StemCellsStoryRowLayoutTests: XCTestCase {
    typealias S = StemCellsStoryRowMetrics

    func testTheStoryRowIsTelegramsChatRow() {
        XCTAssertEqual([S.rowHeight, S.ring, S.plate, S.ringInset, S.textGap, S.textTrailing, S.indent], [78, 60, 45, 12, 12, 16, 42])
        XCTAssertEqual([S.titleSize, S.titleLine, S.titleTop, S.subtitleSize, S.subtitleLine, S.lineGap, S.timeSize], [17, 22, 9, 15, 19, 1, 14])
        XCTAssertEqual(S.subtitleLines, 2)
        XCTAssertEqual([S.dot, S.cornerSlot, S.unseenWidth, S.seenWidth, S.segmentGap], [12, 35, 3, 1.875, 4.5])
        XCTAssertEqual(S.bar, CGSize(width: 27, height: 4.5))
    }

    func testARowsTitleStaysOnItsLineWhateverItsStatus() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .dot)),
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .bar)),
            .init(kind: .row, story: .init(hasSubtitle: false)),
        ], width: 390)
        let frames = result.frames
        // The box as ever, 8 in, and 78 tall for every row.
        XCTAssertEqual(frames.map(\.box.height), [78, 78, 78])
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 9, width: 374, height: 78))
        // The 60 ring 12 into the box, centred on its height; the 45 plate inside.
        XCTAssertEqual(frames[0].ring, CGRect(x: 20, y: 18, width: 60, height: 60))
        XCTAssertEqual(frames[0].mark, CGRect(x: 27.5, y: 25.5, width: 45, height: 45))
        // The title 12 past the ring on a 22 line 9 into the box, to 16 short of its end.
        XCTAssertEqual(frames[0].label, CGRect(x: 92, y: 18, width: 274, height: 22))
        // The status 1 under it, room for two 19 lines, clear of the corner's 35.
        XCTAssertEqual(frames[0].subtitle, CGRect(x: 92, y: 41, width: 239, height: 38))
        // The dot at the text's end, centred on the status's second line, on whole pixels.
        XCTAssertEqual(frames[0].corner, CGRect(x: 354, y: 191.0 / 3, width: 12, height: 12))
        XCTAssertNil(frames[0].trailing)
        XCTAssertNil(frames[0].time)
        // The bar in the same place, 27 × 4.5, on whole pixels.
        XCTAssertEqual(frames[1].corner!.minX, 339)
        XCTAssertEqual(frames[1].corner!.midY - frames[1].box.minY, frames[0].corner!.midY - frames[0].box.minY, accuracy: 1.0 / 3)
        // Every title sits the same way in its row: no status, one, or two.
        for frame in frames { XCTAssertEqual(frame.label.minY - frame.box.minY, 9) }
        // No agent behind it: no status and no corner.
        XCTAssertNil(frames[2].subtitle)
        XCTAssertNil(frames[2].corner)
        XCTAssertEqual(result.contentHeight, 258)
    }

    func testTheTimeEndsTheFirstLineAndTheFoldRidesBesideIt() {
        let plain = StemCellsSidebarLayout.layout([.init(kind: .row, story: .init(timeWidth: 40))], width: 390).frames[0]
        // Right-aligned on the title's line, 8 clear of the title.
        XCTAssertEqual(plain.time, CGRect(x: 326, y: 18, width: 40, height: 22))
        XCTAssertEqual(plain.label.maxX, 318)
        let classic = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true)], width: 402).frames[0]
        let folds = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true, story: .init(timeWidth: 40))], width: 402).frames[0]
        // The fold on the rows' column, on the title's line, the time before it.
        XCTAssertEqual(folds.chevron!.midX, classic.chevron!.midX)
        XCTAssertEqual(folds.chevron!.midY, folds.label.midY, accuracy: 1.0 / 3)
        XCTAssertEqual(folds.time!.maxX, folds.chevron!.minX - StemCellsMetrics.trailingGap)
        XCTAssertEqual(folds.label.maxX, folds.time!.minX - S.timeGap)
        // The status and the corner don't make way for it.
        XCTAssertEqual(folds.subtitle!.maxX, 402 - 8 - 16 - 35)
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
        XCTAssertEqual(frames[0].separator, CGRect(x: 92, y: 87 - 1.0 / 3, width: 290, height: 1.0 / 3))
        // None after the last of a run.
        XCTAssertNil(frames[1].separator)
        XCTAssertNil(frames[2].separator)
        // Under a nested row's parent, it starts at the parent's text.
        XCTAssertEqual(frames[3].separator?.minX, frames[3].label.minX)
        XCTAssertNil(frames[4].separator)
    }

    func testNestedStoryRowsHangOffTheirParentsRing() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init()),
            .init(kind: .row, depth: 1, story: .init()),
        ], width: 390)
        let (parent, child) = (result.frames[0], result.frames[1])
        XCTAssertEqual(child.ring!.minX - parent.ring!.minX, 42)
        // The stem down the parent's ring's middle from its foot, an elbow to 4 short of the child's ring.
        XCTAssertEqual(result.connectors[0], CGRect(x: 49, y: parent.ring!.maxY, width: 1, height: child.box.midY + 1 - parent.ring!.maxY))
        XCTAssertEqual(result.connectors[1], CGRect(x: 50, y: (child.box.midY - 0.5).rounded(.down), width: child.ring!.minX - 4 - 50, height: 1))
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
