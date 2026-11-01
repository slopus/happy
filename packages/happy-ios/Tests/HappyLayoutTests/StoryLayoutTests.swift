import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

final class StoryLayoutTests: XCTestCase {
    /// The outline stands 2.5 outside a row's 30-point icon, 2 thick, and
    /// stays inside the row's 48: the row neither moves nor grows.
    func testTheOutlineHugsTheIconInsideTheRow() {
        let mark = CGRect(x: 16, y: 9, width: 30, height: 30)
        let ring = StoryLayout.ring(around: mark, markRadius: 8)
        XCTAssertEqual(ring.frame, CGRect(x: 11.5, y: 4.5, width: 39, height: 39))
        XCTAssertEqual(ring.radius, 12.5)
        XCTAssertTrue(CGRect(x: 0, y: 0, width: 390, height: 48).contains(ring.frame))
        // The tap target stops where the title starts, so its first letters open the chat.
        XCTAssertEqual(StoryLayout.ringTarget(around: mark, labelX: 58), CGRect(x: 3.5, y: -3.5, width: 54.5, height: 55))
        XCTAssertEqual(StoryLayout.ringTarget(around: mark, labelX: 100), CGRect(x: 3.5, y: -3.5, width: 55, height: 55))
    }

    func testViewerFramesOnAPhone() {
        let viewer = StoryLayout.viewer(size: CGSize(width: 390, height: 844), safeArea: LayoutInsets(top: 47, bottom: 34), count: 3, nameHeight: 18, captionHeight: 40)
        XCTAssertEqual(viewer.segments, [
            CGRect(x: 8, y: 55, width: 122, height: 2), CGRect(x: 134, y: 55, width: 122, height: 2), CGRect(x: 260, y: 55, width: 122, height: 2),
        ])
        XCTAssertEqual(viewer.mark, CGRect(x: 12, y: 67, width: 32, height: 32))
        XCTAssertEqual(viewer.name, CGRect(x: 54, y: 74, width: 202, height: 18))
        XCTAssertEqual([viewer.mute, viewer.more], [CGRect(x: 250, y: 61, width: 44, height: 44), CGRect(x: 294, y: 61, width: 44, height: 44)])
        XCTAssertEqual(viewer.close, CGRect(x: 338, y: 61, width: 44, height: 44))
        XCTAssertEqual(viewer.caption, CGRect(x: 16, y: 710, width: 358, height: 40))
        XCTAssertEqual(viewer.bar, CGRect(x: 12, y: 758, width: 366, height: 44))
        XCTAssertEqual([viewer.chip.height, viewer.round.width], [0, 0])
    }

    /// Replies and the keyboard lift the words and the bar over the media,
    /// which never moves; a repost's chip and round sit under the header.
    func testRepliesAndTheKeyboardLiftOnlyTheWords() {
        let viewer = StoryLayout.viewer(size: CGSize(width: 390, height: 844), safeArea: LayoutInsets(top: 47, bottom: 34), count: 1, nameHeight: 18, captionHeight: 40,
                                        repliesHeight: 60, chipWidth: 200, round: true, keyboard: 300)
        XCTAssertEqual(viewer.bar, CGRect(x: 12, y: 492, width: 366, height: 44))
        XCTAssertEqual(viewer.replies, CGRect(x: 16, y: 424, width: 358, height: 60))
        XCTAssertEqual(viewer.caption, CGRect(x: 16, y: 376, width: 358, height: 40))
        XCTAssertEqual(viewer.chip, CGRect(x: 12, y: 109, width: 200, height: 26))
        XCTAssertEqual(viewer.round, CGRect(x: 12, y: 145, width: 104, height: 104))
    }

    func testTheRowsTilesRunLeftToRight() {
        let row = StoryLayout.row(count: 2, nameHeight: 14)
        XCTAssertEqual(row.tiles.map(\.ring), [CGRect(x: 16, y: 4, width: 69, height: 69), CGRect(x: 97, y: 4, width: 69, height: 69)])
        XCTAssertEqual(row.tiles[0].mark, CGRect(x: 20.5, y: 8.5, width: 60, height: 60))
        XCTAssertEqual(row.tiles[0].name, CGRect(x: 12, y: 77, width: 77, height: 14))
        XCTAssertEqual(row.width, 182)
        XCTAssertLessThanOrEqual(row.tiles[0].name.maxY, StoryLayout.Metrics.rowHeight)
    }

    func testOneStoryIsOneFullSegment() {
        let viewer = StoryLayout.viewer(size: CGSize(width: 390, height: 844), safeArea: LayoutInsets(), count: 1, nameHeight: 18, captionHeight: 0)
        XCTAssertEqual(viewer.segments, [CGRect(x: 8, y: 8, width: 374, height: 2)])
    }

    func testATapOnTheLeftThirdGoesBack() {
        XCTAssertEqual(StoryLayout.step(atX: 100, width: 390), -1)
        XCTAssertEqual(StoryLayout.step(atX: 200, width: 390), 1)
    }
}
