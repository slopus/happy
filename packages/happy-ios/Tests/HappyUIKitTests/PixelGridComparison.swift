#if canImport(UIKit)
import UIKit
import XCTest

/// UIKit hands some geometry back at Float32 precision: a table's row rects
/// and what is worked out from its offset, a view's frame read back after
/// it was set. At a third of a point that is a few billionths off the exact
/// value (235.6666717529297 for 235⅔). Such values, and only those, are
/// compared where the screen draws them: both sides at the nearest device
/// pixel. Pure values (text environments, measurers, layouts) are compared
/// exactly, never through this.
func onPixelGrid(_ value: CGFloat, scale: CGFloat) -> CGFloat {
    (value * scale).rounded() / scale
}

/// `actual` and `expected` land on the same device pixel at `scale`.
func assertSamePixel(
    _ actual: CGFloat,
    _ expected: CGFloat,
    scale: CGFloat,
    _ message: @autoclosure () -> String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) {
    XCTAssertGreaterThan(scale, 0, "no screen scale", file: file, line: line)
    XCTAssertEqual(
        onPixelGrid(actual, scale: scale),
        onPixelGrid(expected, scale: scale),
        "\(message()) (\(actual) against \(expected) at \(scale)x)",
        file: file,
        line: line
    )
}

/// Every edge of `actual` and `expected` on the same device pixel.
func assertSamePixels(
    _ actual: CGRect,
    _ expected: CGRect,
    scale: CGFloat,
    _ message: @autoclosure () -> String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let text = message()
    assertSamePixel(actual.minX, expected.minX, scale: scale, "x, \(text)", file: file, line: line)
    assertSamePixel(actual.minY, expected.minY, scale: scale, "y, \(text)", file: file, line: line)
    assertSamePixel(actual.width, expected.width, scale: scale, "width, \(text)", file: file, line: line)
    assertSamePixel(actual.height, expected.height, scale: scale, "height, \(text)", file: file, line: line)
}
#endif
