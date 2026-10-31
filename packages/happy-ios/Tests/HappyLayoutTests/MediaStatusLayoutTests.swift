import CoreGraphics
import HappyLayout
import XCTest

/// Telegram's size badge and download arrow over chat media.
final class MediaStatusLayoutTests: XCTestCase {
    func testTheBadgeSitsInTheCornerAroundItsLines() {
        let badge = MediaStatusLayout.badge(in: CGSize(width: 240, height: 180), lines: [CGSize(width: 28.4, height: 15.2), CGSize(width: 70.1, height: 15.2)])
        XCTAssertEqual(badge.frame, CGRect(x: 6, y: 6, width: 83, height: 36))
        XCTAssertEqual(badge.lines, [CGRect(x: 6, y: 2, width: 71, height: 16), CGRect(x: 6, y: 18, width: 71, height: 16)])
        XCTAssertEqual(badge.radius, 9)
    }

    func testAOneLineBadgeIsAPill() {
        let badge = MediaStatusLayout.badge(in: CGSize(width: 240, height: 180), lines: [CGSize(width: 40, height: 14)])
        XCTAssertEqual(badge.frame, CGRect(x: 6, y: 6, width: 52, height: 18))
        XCTAssertEqual(badge.radius, 9)
    }

    func testANarrowTileCutsTheBadgeToItsWidth() {
        let badge = MediaStatusLayout.badge(in: CGSize(width: 80, height: 80), lines: [CGSize(width: 200, height: 15)])
        XCTAssertEqual(badge.frame, CGRect(x: 6, y: 6, width: 68, height: 19))
        XCTAssertEqual(badge.lines[0].width, 56)
    }

    func testNoLinesNoHeightBeyondPadding() {
        let badge = MediaStatusLayout.badge(in: CGSize(width: 100, height: 100), lines: [])
        XCTAssertEqual(badge.frame, CGRect(x: 6, y: 6, width: 12, height: 4))
    }

    func testTheBadgeTapIsFingerSizedInTheCorner() {
        XCTAssertEqual(MediaStatusLayout.badgeHit(in: CGRect(x: 16, y: 40, width: 240, height: 180)), CGRect(x: 16, y: 40, width: 132, height: 44))
        XCTAssertEqual(MediaStatusLayout.badgeHit(in: CGRect(x: 0, y: 0, width: 100, height: 60)), CGRect(x: 0, y: 0, width: 100, height: 30))
    }

    func testTheArrowPointsDownTheDiscsMiddle() {
        let arrow = MediaStatusLayout.arrow(side: 50)
        XCTAssertEqual(arrow.shaft, [CGPoint(x: 25, y: 16), CGPoint(x: 25, y: 34)])
        XCTAssertEqual(arrow.head, [CGPoint(x: 18, y: 27), CGPoint(x: 25, y: 34), CGPoint(x: 32, y: 27)])
        // The small disc scales it.
        let small = MediaStatusLayout.arrow(side: 32)
        XCTAssertEqual(small.shaft[0].y, 16 - 9 * 0.64, accuracy: 0.0001)
    }

    func testThePlayGlyphIsUnderHalfTheDisc() {
        XCTAssertEqual(MediaStatusLayout.playGlyph(side: 50), 22)
        XCTAssertEqual(MediaStatusLayout.playGlyph(side: 32), 14)
    }

    func testTheStartingSpinnerIsAboutThePlayGlyphsSize() {
        XCTAssertEqual(MediaStatusLayout.spinnerRadius(side: 50), 10)
        XCTAssertEqual(MediaStatusLayout.spinnerRadius(side: 32), 6)
    }
}
