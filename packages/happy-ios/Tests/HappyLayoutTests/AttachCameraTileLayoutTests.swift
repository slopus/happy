import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The attach menu's live camera cell, measured as Telegram's.
final class AttachCameraTileLayoutTests: XCTestCase {
    private func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    private func assertEqual(_ a: CGRect, _ b: CGRect, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(a.minX, b.minX, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(a.minY, b.minY, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(a.width, b.width, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(a.height, b.height, accuracy: 0.001, file: file, line: line)
    }

    /// An iPhone 17 Pro's cell (`AttachMenuGridLayout`'s 133 × 267).
    func testTheGlyphSitsAtTheTopRightAPixelHigh() {
        let layout = AttachCameraTileLayout(size: CGSize(width: 133, height: 267), screenWidth: 402, scale: 3)
        // 133 − 30 − 3 across; 3 − ⅓ down.
        assertEqual(layout.glyph, rect(100, 3 - 1.0 / 3, 30, 30))

        let two = AttachCameraTileLayout(size: CGSize(width: 133, height: 267), screenWidth: 402, scale: 2)
        XCTAssertEqual(two.glyph, rect(100, 2.5, 30, 30))
    }

    /// The preview is a full-screen camera's picture, 402 × 714⅔ (402 ×
    /// 1.77778 floored to a pixel), scaled to fill the cell's height.
    func testThePreviewFillsTheCellAtFullScreenAspect() {
        let layout = AttachCameraTileLayout(size: CGSize(width: 133, height: 267), screenWidth: 402, scale: 3)
        XCTAssertEqual(layout.previewSize.width, 402)
        XCTAssertEqual(layout.previewSize.height, 2144.0 / 3, accuracy: 0.000001)
        XCTAssertEqual(layout.previewCenter, CGPoint(x: 66.5, y: 133.5))
        // The height decides: 267 / 714⅔ beats 133 / 402.
        XCTAssertEqual(layout.previewScale, 267 / (2144.0 / 3), accuracy: 0.000001)
        // 150.19 wide, its sides cropped evenly.
        let width = 402 * 267 / (2144.0 / 3)
        assertEqual(layout.preview, rect(66.5 - width / 2, 0, width, 267))
    }

    /// Sideways the screen's shorter side still sizes the preview; the
    /// wider cell is filled the same way.
    func testTheWideCellUsesTheShorterSide() {
        let layout = AttachCameraTileLayout(size: CGSize(width: 149, height: 299), screenWidth: 402, scale: 3)
        assertEqual(layout.glyph, rect(116, 3 - 1.0 / 3, 30, 30))
        XCTAssertEqual(layout.previewScale, 299 / (2144.0 / 3), accuracy: 0.000001)
        let width = 402 * 299 / (2144.0 / 3)
        assertEqual(layout.preview, rect(74.5 - width / 2, 0, width, 299))
    }

    /// A cell wider than 9:16 is filled by its width instead.
    func testAWideCellIsFilledByItsWidth() {
        let layout = AttachCameraTileLayout(size: CGSize(width: 300, height: 300), screenWidth: 402, scale: 2)
        XCTAssertEqual(layout.previewSize, CGSize(width: 402, height: 714.5))
        XCTAssertEqual(layout.previewScale, 300.0 / 402, accuracy: 0.000001)
        let height = 714.5 * 300 / 402
        assertEqual(layout.preview, rect(0, 150 - height / 2, 300, height))
    }

    /// Before the cell is laid out nothing divides by zero.
    func testAnEmptyCell() {
        let layout = AttachCameraTileLayout(size: .zero, screenWidth: 0, scale: 0)
        XCTAssertEqual(layout.glyph, rect(-33, 3, 30, 30))
        XCTAssertEqual(layout.previewScale, 1)
        XCTAssertEqual(layout.preview, .zero)
    }
}
