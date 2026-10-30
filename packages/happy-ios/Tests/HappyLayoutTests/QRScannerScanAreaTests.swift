import CoreGraphics
import HappyLayout
import XCTest

/// The camera reads only inside its rect of interest; one that is empty or
/// outside the frame reads nothing, silently. It falls back to the frame.
final class QRScannerScanAreaTests: XCTestCase {
    private let whole = CGRect(x: 0, y: 0, width: 1, height: 1)

    func testAViewfinderInsideTheFrameIsKept() {
        let area = CGRect(x: 0.25, y: 0.125, width: 0.5, height: 0.625)
        XCTAssertEqual(QRScannerLayout.scanArea(area), area)
    }

    func testAnUnusableConversionReadsTheWholeFrame() {
        XCTAssertEqual(QRScannerLayout.scanArea(.zero), whole)
        XCTAssertEqual(QRScannerLayout.scanArea(CGRect(x: 2, y: 2, width: 0.5, height: 0.5)), whole)
        XCTAssertEqual(QRScannerLayout.scanArea(CGRect(x: .nan, y: 0, width: 0.5, height: 0.5)), whole)
        XCTAssertEqual(QRScannerLayout.scanArea(CGRect(x: 0.5, y: 0.5, width: 0.01, height: 0.5)), whole)
    }

    func testAnOverhangIsClippedToTheFrame() {
        XCTAssertEqual(QRScannerLayout.scanArea(CGRect(x: -0.125, y: 0.25, width: 0.625, height: 0.5)), CGRect(x: 0, y: 0.25, width: 0.5, height: 0.5))
    }
}
