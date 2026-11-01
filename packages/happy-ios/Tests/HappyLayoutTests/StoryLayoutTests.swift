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
        XCTAssertEqual(viewer.name, CGRect(x: 54, y: 74, width: 280, height: 18))
        XCTAssertEqual(viewer.close, CGRect(x: 338, y: 61, width: 44, height: 44))
        XCTAssertEqual(viewer.caption, CGRect(x: 16, y: 754, width: 358, height: 40))
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
