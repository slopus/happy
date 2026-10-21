#if canImport(UIKit)
import UIKit
import XCTest

/// UIKit keeps a view's frame as its centre and bounds, so the origin read
/// back is `center - size / 2`: at a third of a point that lands an ulp or
/// two off where it was set (15.666666666666664 for 47/3, -0.3333333333333339
/// for -1/3). Frames read back from views are compared to this much, a
/// millionth of a point, so they still match to the exact pixel: a third of
/// a point at 3x, or half of one, is far outside it. Values a layout or
/// `PixelGrid.snap` returns are compared exactly, never through this.
let frameReadbackNoise: CGFloat = 1e-6

/// `actual`, read back from a view, is `expected` up to readback noise.
func assertSameFrame(
    _ actual: CGRect,
    _ expected: CGRect,
    _ message: @autoclosure () -> String = "",
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let close = abs(actual.minX - expected.minX) <= frameReadbackNoise
        && abs(actual.minY - expected.minY) <= frameReadbackNoise
        && abs(actual.width - expected.width) <= frameReadbackNoise
        && abs(actual.height - expected.height) <= frameReadbackNoise
    XCTAssertTrue(close, "\(actual) is not \(expected) to \(frameReadbackNoise). \(message())", file: file, line: line)
}
#endif
