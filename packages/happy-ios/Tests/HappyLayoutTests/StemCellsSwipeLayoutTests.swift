import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

final class StemCellsSwipeLayoutTests: XCTestCase {
    func testOpenActionsStandAtTheBoxsRight() {
        let open = StemCellsSwipeLayout(box: CGSize(width: 378, height: 32), actions: 2, pull: 152)
        XCTAssertEqual(open.offset, 152)
        XCTAssertEqual(open.actions, [CGRect(x: 226, y: 0, width: 76, height: 32), CGRect(x: 302, y: 0, width: 76, height: 32)])
    }

    func testAPullPastThemStretchesByAThird() {
        let stretched = StemCellsSwipeLayout(box: CGSize(width: 378, height: 32), actions: 2, pull: 212)
        XCTAssertEqual(stretched.offset, 172)
        XCTAssertEqual(stretched.actions, [CGRect(x: 206, y: 0, width: 86, height: 32), CGRect(x: 292, y: 0, width: 86, height: 32)])
        XCTAssertEqual(StemCellsSwipeLayout(box: CGSize(width: 378, height: 32), actions: 1, pull: -20).offset, 0)
    }

    func testAReleaseOpensPastHalfOrOnAFling() {
        XCTAssertTrue(StemCellsSwipeLayout.opens(pull: 76, velocity: 0, actions: 2))
        XCTAssertFalse(StemCellsSwipeLayout.opens(pull: 75, velocity: 0, actions: 2))
        XCTAssertTrue(StemCellsSwipeLayout.opens(pull: 20, velocity: 600, actions: 2))
        XCTAssertFalse(StemCellsSwipeLayout.opens(pull: 140, velocity: -600, actions: 2))
    }
}
