import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

final class StoryLayoutTests: XCTestCase {
    func testStagePlacementMatchesTheSameNineBySixteenMediaOnPhoneAndTablet() {
        for size in [CGSize(width: 390, height: 844), CGSize(width: 1024, height: 1366)] {
            let stage = StoryLayout.stage(in: size), position = CGPoint(x: 0.7, y: 0.3)
            XCTAssertEqual(stage.width / stage.height, 9 / 16, accuracy: 0.0001)
            XCTAssertTrue(stage.contains(CGRect(origin: .zero, size: size)))
            let frame = StoryLayout.layer(size: size, center: position, measured: CGSize(width: 104, height: 104))
            XCTAssertEqual(frame.midY, stage.minY + stage.height * 0.3)
            XCTAssertEqual(StoryLayout.normalized(CGPoint(x: frame.midX, y: frame.midY), in: size), position)
            let pill = StoryLayout.textFrame(size: size, center: CGPoint(x: 1, y: 0), measured: CGSize(width: 88, height: 29))
            XCTAssertEqual(pill.width, 108); XCTAssertEqual(pill.height, 41)
            XCTAssertTrue(stage.contains(pill))
            let before = StoryLayout.composer(size: size, safeArea: .zero, text: position, round: position, keyboard: 0, measuredText: CGSize(width: 88, height: 29))
            let viewer = StoryLayout.viewer(size: size, safeArea: .zero, count: 1, nameHeight: 18, captionHeight: 0)
            XCTAssertEqual(viewer.media, before.media)
            XCTAssertEqual(before.media, stage)
            let editing = StoryLayout.composer(size: size, safeArea: .zero, text: position, round: position, keyboard: size.height * 0.8, measuredText: CGSize(width: 88, height: 29))
            XCTAssertLessThan(editing.text.minY, before.text.minY)
            XCTAssertEqual(editing.round, before.round)
        }
    }
    func testNormalizedLayerCenterStaysAtTheSameFractionAcrossDevices() {
        let center = CGPoint(x: 0.7, y: 0.3)
        for size in [CGSize(width: 390, height: 844), CGSize(width: 1024, height: 1366)] {
            let frame = StoryLayout.layer(size: size, center: center, measured: CGSize(width: 104, height: 104))
            XCTAssertEqual(StoryLayout.normalized(CGPoint(x: frame.midX, y: frame.midY), in: size), center)
        }
        let size = CGSize(width: 390, height: 844), stage = StoryLayout.stage(in: CGSize(width: 390, height: 844))
        XCTAssertEqual(StoryLayout.normalized(CGPoint(x: stage.minX - 10, y: stage.maxY + 10), in: size), CGPoint(x: 0, y: 1))
    }

    func testInlineRepliesStopAboveTheCapsuleAndKeyboard() {
        let viewer = StoryLayout.viewer(size: CGSize(width: 390, height: 844), safeArea: LayoutInsets(top: 47, bottom: 34), count: 1, nameHeight: 18, captionHeight: 0, keyboard: 300)
        let overlay = StoryLayout.replies(size: CGSize(width: 390, height: 844), bar: viewer.bar, measured: 40, pull: 1)
        XCTAssertEqual(overlay.panel.maxY, viewer.bar.minY - 8)
        XCTAssertEqual(overlay.panel.height, 92)
        XCTAssertGreaterThan(overlay.text.minY, overlay.header.maxY)
    }
    func testRepliesGrowFromTheBottomToTheirCapAndTuckToAPeek() {
        let size = CGSize(width: 390, height: 844), bar = CGRect(x: 12, y: 758, width: 366, height: 44)
        let one = StoryLayout.replies(size: size, bar: bar, measured: 28, pull: 1)
        let many = StoryLayout.replies(size: size, bar: bar, measured: 2000, pull: 1)
        let peek = StoryLayout.replies(size: size, bar: bar, measured: 2000, pull: 0)
        XCTAssertEqual(one.panel.height, 80)
        XCTAssertEqual(many.panel.height, 844 * 0.6, accuracy: 0.001)
        XCTAssertEqual(one.panel.maxY, many.panel.maxY)
        XCTAssertEqual(peek.panel.height, 44); XCTAssertEqual(peek.text.height, 0)
        XCTAssertTrue(CGRect(origin: .zero, size: peek.panel.size).contains(peek.grabber))
    }
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
        XCTAssertEqual(viewer.chip, CGRect(x: 12, y: 109, width: 200, height: 34))
        XCTAssertEqual(viewer.round, CGRect(x: 12, y: 153, width: 104, height: 104))
    }

    func testTheRowsTilesRunLeftToRight() {
        let row = StoryLayout.row(count: 2, nameHeight: 14)
        XCTAssertEqual(row.tiles.map(\.ring), [CGRect(x: 16, y: 4, width: 69, height: 69), CGRect(x: 97, y: 4, width: 69, height: 69)])
        XCTAssertEqual(row.tiles[0].mark, CGRect(x: 20.5, y: 8.5, width: 60, height: 60))
        XCTAssertEqual(row.tiles[0].name, CGRect(x: 12, y: 77, width: 77, height: 14))
        XCTAssertEqual(row.tiles[0].add, CGRect(x: 62.5, y: 50.5, width: 22, height: 22))
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
