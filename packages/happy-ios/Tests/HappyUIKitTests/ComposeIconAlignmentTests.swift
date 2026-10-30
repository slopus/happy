#if canImport(UIKit)
import UIKit
import XCTest
@testable import HappyUI

@MainActor
final class ComposeIconAlignmentTests: XCTestCase {
    func testSquareIsCentredWithoutClippingThePencil() throws {
        for size: CGFloat in [18, 22, 28] {
            for scale: CGFloat in [2, 3] {
                let image = UIImage.composeIcon(size: size, scale: scale)
                let cg = try XCTUnwrap(image.cgImage)
                let bytes = try XCTUnwrap(cg.dataProvider?.data) as Data
                let alpha = cg.alphaInfo == .premultipliedLast || cg.alphaInfo == .last ? 3 : 0
                func painted(_ x: Int, _ y: Int) -> Bool {
                    bytes[y * cg.bytesPerRow + x * (cg.bitsPerPixel / 8) + alpha] > 20
                }
                // Below the pencil's tip, the horizontal slice crosses only
                // the square. Left of the pencil, the vertical slice does too.
                let row = Int(CGFloat(cg.height) * 0.65)
                let column = Int(CGFloat(cg.width) * 0.25)
                let horizontal = (0..<cg.width).filter { painted($0, row) }
                let vertical = (0..<cg.height).filter { painted(column, $0) }
                let left = try XCTUnwrap(horizontal.first), right = try XCTUnwrap(horizontal.last)
                let top = try XCTUnwrap(vertical.first), bottom = try XCTUnwrap(vertical.last)
                XCTAssertEqual(CGFloat(left + right + 1) / 2, CGFloat(cg.width) / 2, accuracy: 1)
                XCTAssertEqual(CGFloat(top + bottom + 1) / 2, CGFloat(cg.height) / 2, accuracy: 1)
                XCTAssertFalse((0..<cg.width).contains { painted($0, 0) || painted($0, cg.height - 1) })
                XCTAssertFalse((0..<cg.height).contains { painted(0, $0) || painted(cg.width - 1, $0) })
                XCTAssertEqual(image.renderingMode, .alwaysTemplate)
            }
        }
    }
}
#endif