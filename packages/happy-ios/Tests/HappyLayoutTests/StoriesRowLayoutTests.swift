import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the stories row, after Telegram's
/// `StoryPeerListComponent` and `StoryPeerListItemComponent`.
final class StoriesRowLayoutTests: XCTestCase {
    private func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect { CGRect(x: x, y: y, width: w, height: h) }

    func testOneCircle() {
        let item = StoriesRowLayout.item
        XCTAssertEqual(item.avatar, rect(4, 4, 52, 52))
        // 30.66 out from the avatar's centre.
        XCTAssertEqual(item.ring.minX, -0.66, accuracy: 0.0001)
        XCTAssertEqual(item.ring.width, 61.32, accuracy: 0.0001)
        XCTAssertEqual(item.plus, rect(39, 38, 16, 16))
        XCTAssertEqual(item.cutout, rect(38, 37, 18, 18))
        // 2 under the ring's 68 pt square; a long name is held to 70.
        XCTAssertEqual(item.title(width: 39.4, height: 13.2), rect(10, 66, 40, 14))
        XCTAssertEqual(item.title(width: 120, height: 13.2), rect(-5, 66, 70, 14))
    }

    func testCirclesSit14Apart() {
        let layout = StoriesRowLayout(width: 390, count: 3)
        XCTAssertEqual(layout.items, [rect(12, 12, 60, 77), rect(86, 12, 60, 77), rect(160, 12, 60, 77)])
        XCTAssertEqual(layout.contentSize, CGSize(width: 390, height: 98))
        XCTAssertEqual(layout.size.height, 98)
    }

    func testARowThatOverflowsScrolls() {
        let layout = StoriesRowLayout(width: 390, count: 10)
        XCTAssertEqual(layout.spacing, 14)
        XCTAssertEqual(layout.contentSize.width, 12 + 600 + 9 * 14 + 12)
    }

    /// The edge would show a 2.66 pt sliver of the sixth ring: the spacing
    /// grows until the fifth is cut at its centre.
    func testTheEdgeNeverShowsASliverOfARing() {
        let layout = StoriesRowLayout(width: 384, count: 10)
        XCTAssertEqual(layout.spacing, 25)
        XCTAssertEqual(layout.items[4].midX, 384, accuracy: 9)
        XCTAssertEqual(StoriesRowLayout(width: 390, count: 2).spacing, 14)
    }

    func testRingSegments() {
        XCTAssertEqual(StoriesRowLayout.segments(count: 1).count, 1)
        let three = StoriesRowLayout.segments(count: 3, radius: 29.5)
        XCTAssertEqual(three.count, 3)
        let gap = 4 / 29.5
        XCTAssertEqual(three[0].start, -.pi / 2 + gap / 2, accuracy: 1e-9)
        XCTAssertEqual(three[1].start - three[0].end, gap, accuracy: 1e-9)
        XCTAssertEqual(three[2].end + gap / 2 - 2 * .pi, -.pi / 2, accuracy: 1e-9)
        // Telegram draws at most 30.
        XCTAssertEqual(StoriesRowLayout.segments(count: 80).count, 30)
    }

    func testHomeKeepsTheRowAboveTheFirstRow() {
        let layout = StemCellsHomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 0, storiesHeight: 98)
        XCTAssertEqual(layout.listInsets, LayoutInsets(top: 218, left: 0, bottom: 90, right: 0))
        XCTAssertEqual(layout.stories, rect(0, -98, 390, 98))
        XCTAssertEqual(layout.indicatorInsets, LayoutInsets(top: 110, left: 0, bottom: 90, right: 0))
        // Off: home exactly as it was.
        let off = StemCellsHomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 0, storiesHeight: 0)
        XCTAssertEqual(off, StemCellsHomeLayout(size: CGSize(width: 390, height: 844), contentTop: 120, chromeTop: 110, listBottom: 90, bannerHeight: 0))
        XCTAssertEqual(off.stories, .zero)
        XCTAssertEqual(off.listInsets.top, 120)
    }
}
