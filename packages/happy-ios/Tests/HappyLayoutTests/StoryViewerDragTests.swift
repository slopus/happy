import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// The viewer under a vertical drag, in Telegram's numbers.
final class StoryViewerDragTests: XCTestCase {
    func testFollowsTheFingerAndShrinks() {
        let rest = StoryViewerDrag.state(translation: 0, height: 874)
        XCTAssertEqual(rest, .init(offset: 0, scale: 1, groundAlpha: 1))
        let quarter = StoryViewerDrag.state(translation: 218.5, height: 874)
        XCTAssertEqual(quarter.offset, 218.5, accuracy: 0.001)
        XCTAssertEqual(quarter.scale, 0.9, accuracy: 0.001)
        XCTAssertEqual(quarter.groundAlpha, 0.8, accuracy: 0.001)
        // The black never goes under half; up never moves it.
        XCTAssertEqual(StoryViewerDrag.state(translation: 800, height: 874).groundAlpha, 0.5)
        XCTAssertEqual(StoryViewerDrag.state(translation: -100, height: 874), rest)
        XCTAssertEqual(StoryViewerDrag.state(translation: 2000, height: 874).scale, 0.6, accuracy: 0.001)
    }

    func testLettingGo() {
        XCTAssertEqual(StoryViewerDrag.release(translation: 201, velocity: 0, canShowViewers: false), .close)
        XCTAssertEqual(StoryViewerDrag.release(translation: 6, velocity: 201, canShowViewers: false), .close)
        XCTAssertEqual(StoryViewerDrag.release(translation: 150, velocity: 100, canShowViewers: false), .stay)
        XCTAssertEqual(StoryViewerDrag.release(translation: -201, velocity: 0, canShowViewers: true), .viewers)
        XCTAssertEqual(StoryViewerDrag.release(translation: -101, velocity: -101, canShowViewers: true), .viewers)
        XCTAssertEqual(StoryViewerDrag.release(translation: -300, velocity: -500, canShowViewers: false), .stay)
        XCTAssertEqual(StoryViewerDrag.release(translation: -150, velocity: 0, canShowViewers: true), .stay)
    }
}
