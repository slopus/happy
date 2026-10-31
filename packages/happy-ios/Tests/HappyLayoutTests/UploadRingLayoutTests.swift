import CoreGraphics
import HappyLayout
import XCTest

/// The ring over a sending photo, measured as Telegram's radial status.
final class UploadRingLayoutTests: XCTestCase {
    func testTheDiscSitsInTheTilesMiddleOnWholePoints() {
        XCTAssertEqual(UploadRingLayout.disc(in: CGSize(width: 240, height: 180)), CGRect(x: 95, y: 65, width: 50, height: 50))
        XCTAssertEqual(UploadRingLayout.disc(in: CGSize(width: 125, height: 125)), CGRect(x: 37, y: 37, width: 50, height: 50))
        XCTAssertEqual(UploadRingLayout.disc(in: CGSize(width: 90, height: 90)), CGRect(x: 20, y: 20, width: 50, height: 50))
    }

    func testASmallTileTakesTheSmallDisc() {
        XCTAssertEqual(UploadRingLayout.disc(in: CGSize(width: 89, height: 200)), CGRect(x: 28, y: 84, width: 32, height: 32))
        XCTAssertEqual(UploadRingLayout.disc(in: CGSize(width: 60, height: 60)), CGRect(x: 14, y: 14, width: 32, height: 32))
    }

    func testTheArcSitsInsideTheEdge() {
        // 50: (50 - 2.25 - 5) / 2.
        XCTAssertEqual(UploadRingLayout.arcRadius(50), 21.375, accuracy: 0.0001)
        // 32: the line holds at 1.6, (32 - 1.6 - 5) / 2.
        XCTAssertEqual(UploadRingLayout.arcRadius(32), 12.7, accuracy: 0.0001)
        XCTAssertEqual(UploadRingLayout.factor(32), 0.64, accuracy: 0.0001)
    }

    func testTheTweenIsLongerForABigJump() {
        XCTAssertEqual(UploadRingLayout.tween(from: 0.1, to: 0.2), 0.2, accuracy: 0.0001)
        XCTAssertEqual(UploadRingLayout.tween(from: 0, to: 0.25), 0.2, accuracy: 0.0001)
        XCTAssertEqual(UploadRingLayout.tween(from: 0, to: 0.3), 0.2 + 0.45 * 0.05 * 5, accuracy: 0.0001)
        XCTAssertEqual(UploadRingLayout.tween(from: 0, to: 1), 0.65, accuracy: 0.0001)
        XCTAssertEqual(UploadRingLayout.tween(from: 0.8, to: 0.4), 0.2, accuracy: 0.0001)
    }
}
