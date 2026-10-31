import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Stop's rounded square: 12 with corners of 3 in send's 16 box, centred on
/// the pixel grid in the round button and in the flat panel's stop.
final class StopGlyphLayoutTests: XCTestCase {
    private func assertSquare(
        _ square: StopGlyphLayout.Square, _ x: CGFloat, _ y: CGFloat, _ side: CGFloat, radius: CGFloat,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(square.frame.minX, x, accuracy: 0.0001, "x", file: file, line: line)
        XCTAssertEqual(square.frame.minY, y, accuracy: 0.0001, "y", file: file, line: line)
        XCTAssertEqual(square.frame.width, side, accuracy: 0.0001, "width", file: file, line: line)
        XCTAssertEqual(square.frame.height, side, accuracy: 0.0001, "height", file: file, line: line)
        XCTAssertEqual(square.cornerRadius, radius, accuracy: 0.0001, "radius", file: file, line: line)
    }

    /// The round send / stop button, 42 across, at both scales.
    func testRoundButton() {
        let bounds = CGRect(x: 0, y: 0, width: 42, height: 42)
        assertSquare(StopGlyphLayout.square(in: bounds, glyphSize: 16, scale: 2), 15, 15, 12, radius: 3)
        assertSquare(StopGlyphLayout.square(in: bounds, glyphSize: 16, scale: 3), 15, 15, 12, radius: 3)
    }

    /// The flat panel's stop: a 16 glyph 8 in from either side, 32 tall.
    func testFlatPanelStop() {
        let bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
        assertSquare(StopGlyphLayout.square(in: bounds, glyphSize: 16, scale: 2), 10, 10, 12, radius: 3)
        assertSquare(StopGlyphLayout.square(in: bounds, glyphSize: 16, scale: 3), 10, 10, 12, radius: 3)
    }

    /// An odd number of pixels across takes a square a pixel bigger, so it
    /// is still exactly centred rather than half a pixel off.
    func testOddPixelsTakeAnOddSquare() {
        let at2 = StopGlyphLayout.square(in: CGRect(x: 0, y: 0, width: 41.5, height: 41.5), glyphSize: 16, scale: 2)
        assertSquare(at2, 14.5, 14.5, 12.5, radius: 3)
        let at3 = StopGlyphLayout.square(in: CGRect(x: 0, y: 0, width: 41, height: 41), glyphSize: 16, scale: 3)
        assertSquare(at3, 43.0 / 3, 43.0 / 3, 37.0 / 3, radius: 3)
    }

    /// Wherever the bounds are, the square is on the grid and its centre is
    /// theirs to within half a pixel.
    func testCentredOnTheGridEverywhere() {
        for scale: CGFloat in [1, 2, 3] {
            for pixels in 40...140 {
                let side = CGFloat(pixels) / scale
                let bounds = CGRect(x: 0, y: 0, width: side, height: side)
                for glyph: CGFloat in [14, 16, 20] {
                    let square = StopGlyphLayout.square(in: bounds, glyphSize: glyph, scale: scale)
                    for edge in [square.frame.minX, square.frame.minY, square.frame.maxX, square.frame.maxY] {
                        XCTAssertEqual((edge * scale).rounded(), edge * scale, accuracy: 0.0001, "off the grid: \(bounds) \(glyph)@\(scale)")
                    }
                    XCTAssertEqual(square.frame.midX, bounds.midX, accuracy: 0.5 / scale + 0.0001)
                    XCTAssertEqual(square.frame.midY, bounds.midY, accuracy: 0.5 / scale + 0.0001)
                    // Rounded to a pixel, then perhaps a pixel more for parity.
                    XCTAssertEqual(square.frame.width, glyph * StopGlyphLayout.Metrics.sideRatio, accuracy: 1.5 / scale + 0.0001)
                }
            }
        }
    }

    func testGlyphMotion() {
        XCTAssertEqual(AgentInputPrimaryGlyphMotion.duration, 0.2)
        XCTAssertEqual(AgentInputPrimaryGlyphMotion.scale, 0.5)
    }
}
