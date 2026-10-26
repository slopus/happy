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
            assertSymmetric(StemCellAttachSheetLayout(width: width, titleWidth: 120, photosWidth: 52, tiles: 4, values: [nil, nil, 30]).close, width: width, "the attach sheet")
            assertSymmetric(StemCellsQRSheetLayout(size: CGSize(width: width, height: 844), safeTop: 47, safeBottom: 34, nameHeight: 28, text: .fixed(width: 300, height: 44)).close, width: width, "the QR sheet")
            // The link sheet's glass bar, its row dropped to put the circle there.
            let bar = StemCellsGlassBarLayout(width: width, safeTop: 0, hairline: 1, hasLeading: false, actions: 0, titleWidth: 100, closes: true)
            assertSymmetric(bar.close, width: width, "the link sheet")
        }
    }

    func testTheLinkSheetsRowDropsWithItsClose() {
        let bar = StemCellsGlassBarLayout(width: 402, safeTop: 0, hairline: 1, hasLeading: false, actions: 1, titleWidth: 100, closes: true)
        XCTAssertNil(bar.leading)
        XCTAssertEqual(bar.close, CGRect(x: 342, y: 16, width: 44, height: 44))
        // The title is level with it, and an action goes left of it, 8 clear.
        XCTAssertEqual(bar.pill, CGRect(x: 135, y: 16, width: 132, height: 44))
        XCTAssertEqual(bar.actions, CGRect(x: 288, y: 15, width: 46, height: 46))
        XCTAssertEqual(bar.contentTop, 64)
        XCTAssertEqual(StemCellsGlassBarLayout.Metrics.span(closes: true), 64)
        XCTAssertEqual(StemCellsGlassBarLayout.Metrics.span(closes: false), 52)
    }
}
