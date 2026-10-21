import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// At 3x a snapped frame's size is its whole pixels over the scale, exactly:
/// subtracting two snapped edges (67⅔ − 15⅔) gives 51.99999999999999 for a
/// 52-point box, which a view then reports as its height.
final class PixelGridSizeTests: XCTestCase {
    func testAtThirdsTheSizeIsExactlyWholePixels() {
        for top in 0..<300 {
            let y = CGFloat(top) / 3
            for points in [22, 28, 38, 52, 58, 63, 118, 120] {
                let snapped = PixelGrid.snap(rect(57, y, 197, CGFloat(points)), scale: 3)
                XCTAssertEqual(snapped.height, CGFloat(points), "\(points) at \(y)")
                XCTAssertEqual(snapped.minY, CGFloat(top) / 3, "\(points) at \(y)")
                XCTAssertEqual(snapped.width, 197)
            }
            let third = PixelGrid.snap(rect(0, y, 10, 67.0 / 3), scale: 3)
            XCTAssertEqual(third.height, 67.0 / 3, "22⅓ at \(y)")
        }
    }

    func testAHairlineIsOnePixelAtEveryScale() {
        for scale: CGFloat in [1, 2, 3] {
            XCTAssertEqual(PixelGrid.snap(rect(0, 10.4, 10, 0.01), scale: scale).height, 1 / scale)
        }
    }
}
