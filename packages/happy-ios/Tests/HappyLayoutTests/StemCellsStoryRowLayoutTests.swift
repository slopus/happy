import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for sidebar v2's story rows: the ring, the two lines and
/// the one corner signal, the design's 300-wide sidebar half again.
final class StemCellsStoryRowLayoutTests: XCTestCase {
    typealias S = StemCellsStoryRowMetrics

    func testTheStoryRowIsTheDesignsHalfAgain() {
        XCTAssertEqual([S.rowHeight, S.ring, S.plate, S.ringInset, S.textGap, S.textTrailing, S.indent], [78, 60, 45, 12, 15, 21, 42])
        XCTAssertEqual([S.titleSize, S.subtitleSize, S.titleLine, S.subtitleLine, S.lineGap], [19.5, 18, 24, 22.5, 1.5])
        XCTAssertEqual([S.cornerInset, S.dot, S.unseenWidth, S.seenWidth, S.segmentGap], [15, 12, 3, 1.875, 4.5])
        XCTAssertEqual(S.bar, CGSize(width: 27, height: 4.5))
    }

    func testARowWithAStatusStacksTwoLinesBesideItsRing() {
        let result = StemCellsSidebarLayout.layout([
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .dot)),
            .init(kind: .row, story: .init(hasSubtitle: true, corner: .bar)),
            .init(kind: .row, story: .init(hasSubtitle: false)),
        ], width: 390)
        let frames = result.frames
        // The box as ever, 8 in, but 78 tall.
        XCTAssertEqual(frames[0].box, CGRect(x: 8, y: 9, width: 374, height: 78))
        // The 60 ring 12 into the box, centred on its height; the 45 plate inside.
        XCTAssertEqual(frames[0].ring, CGRect(x: 20, y: 18, width: 60, height: 60))
        XCTAssertEqual(frames[0].mark, CGRect(x: 27.5, y: 25.5, width: 45, height: 45))
        // Title and status as one 48 block centred on the row, 15 past the ring,
        // stopping 21 short of the box's end.
        XCTAssertEqual(frames[0].label, CGRect(x: 95, y: 24, width: 266, height: 24))
        XCTAssertEqual(frames[0].subtitle, CGRect(x: 95, y: 49.5, width: 266, height: 22.5))
        // The dot 15 in from the bottom-right corner.
        XCTAssertEqual(frames[0].corner, CGRect(x: 355, y: 60, width: 12, height: 12))
        XCTAssertNil(frames[0].trailing)
        // The bar in the same corner, 27 × 4.5.
        XCTAssertEqual(frames[1].corner, CGRect(x: 340, y: 148.5, width: 27, height: 4.5))
        // No agent behind it: the title alone, centred, and no corner.
        XCTAssertNil(frames[2].subtitle)
        XCTAssertNil(frames[2].corner)
        XCTAssertEqual(frames[2].label.midY, frames[2].box.midY)
        XCTAssertEqual(result.contentHeight, 258)
    }

    func testAStoryRowKeepsItsFoldOnTheRowsColumn() {
        let classic = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true)], width: 402).frames[0]
        let story = StemCellsSidebarLayout.layout([.init(kind: .row, hasFold: true, story: .init())], width: 402).frames[0]
        // 24 in from the right, on the row's middle.
        XCTAssertEqual(story.chevron!.midX, classic.chevron!.midX)
        XCTAssertEqual(story.chevron!.midY, story.box.midY, accuracy: 1.0 / 3)
        XCTAssertEqual(story.label.maxX, story.chevron!.minX - StemCellsMetrics.trailingGap)
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
