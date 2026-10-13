import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Stand-in for a UILabel: every character is `advance` points wide, lines
/// wrap at whole characters, and `maxLines` truncates like numberOfLines.
/// A single-line label reports its full text width, as UIKit does, and the
/// layout clamps it.
func text(
    _ string: String,
    advance: CGFloat = 8,
    lineHeight: CGFloat,
    maxLines: Int = 0
) -> Measurable {
    let count = string.count
    return Measurable { width in
        let total = CGFloat(count) * advance
        guard count > 0 else { return CGSize(width: 0, height: lineHeight) }
        if maxLines == 1 || total <= width {
            return CGSize(width: total, height: lineHeight)
        }
        let perLine = max(1, Int(width / advance))
        var lines = Int((Double(count) / Double(perLine)).rounded(.up))
        if maxLines > 0 { lines = min(lines, maxLines) }
        return CGSize(width: CGFloat(perLine) * advance, height: CGFloat(lines) * lineHeight)
    }
}

func fixed(_ width: CGFloat, _ height: CGFloat) -> Measurable {
    .fixed(width: width, height: height)
}

/// Content that fills whatever width it gets at a fixed height.
func block(height: CGFloat) -> Measurable {
    Measurable { width in CGSize(width: width, height: height) }
}

func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat) -> CGRect {
    CGRect(x: x, y: y, width: width, height: height)
}

/// Frames are compared to 1/1000 pt: exact for the spec, tolerant of the
/// last bit of floating point.
func assertFrame(_ actual: CGRect?, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
    guard let actual else {
        XCTFail("frame is nil, expected \(expected)", file: file, line: line)
        return
    }
    let tolerance: CGFloat = 0.001
    let close = abs(actual.minX - expected.minX) < tolerance
        && abs(actual.minY - expected.minY) < tolerance
        && abs(actual.width - expected.width) < tolerance
        && abs(actual.height - expected.height) < tolerance
    XCTAssertTrue(close, "\(actual) is not \(expected)", file: file, line: line)
}

func assertSize(_ actual: CGSize, _ expected: CGSize, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual.width, expected.width, accuracy: 0.001, "width", file: file, line: line)
    XCTAssertEqual(actual.height, expected.height, accuracy: 0.001, "height", file: file, line: line)
}

/// iPhone 15 portrait under a navigation bar: 59 status bar + 44 bar.
let phone = CGSize(width: 393, height: 852)
let phoneUnderBar = LayoutInsets(top: 103, bottom: 34)
let phoneFullScreen = LayoutInsets(top: 59, bottom: 34)
