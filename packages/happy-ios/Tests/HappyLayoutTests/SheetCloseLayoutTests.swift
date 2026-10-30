import CoreGraphics
@testable import HappyLayout
import XCTest

/// Every modal sheet closes from a 44 circle at the top right of its
/// header, as far from the sheet's top as from its right side.
final class SheetCloseLayoutTests: XCTestCase {
    private func assertSymmetric(_ close: CGRect?, width: CGFloat, top: CGFloat = 0, _ name: String, line: UInt = #line) {
        guard let close else { return XCTFail("\(name) has no close button", line: line) }
        XCTAssertEqual(close, CGRect(x: width - 60, y: top + 16, width: 44, height: 44), name, line: line)
        XCTAssertEqual(close.minY - top, width - close.maxX, "\(name): top inset isn't the side one", line: line)
    }

    func testEverySheetsCloseIsAsFarFromTheTopAsFromTheSide() {
        for width in [CGFloat(375), 402, 440] {
            assertSymmetric(SheetCloseLayout.frame(width: width), width: width, "the shared frame")
            assertSymmetric(AttachSheetLayout(width: width, titleWidth: 120, photosWidth: 52, tiles: 4, values: [nil, nil, 30]).close, width: width, "the attach sheet")
            assertSymmetric(QRSheetLayout(size: CGSize(width: width, height: 844), safeTop: 47, safeBottom: 34, nameHeight: 28, text: .fixed(width: 300, height: 44)).close, width: width, "the QR sheet")
        }
    }

}
