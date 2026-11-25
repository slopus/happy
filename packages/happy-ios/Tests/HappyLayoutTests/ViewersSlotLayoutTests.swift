import Foundation
import HappyLayout
import XCTest

final class ViewersSlotLayoutTests: XCTestCase {
    typealias M = ViewersSlotLayout.Metrics

    func testTheSlotIsAsWideAsFourRingedFacesAndTheirMore() {
        XCTAssertEqual(M.width, 88)
        let full = ViewersSlotLayout(large: [true, true, true, true, true, true], total: 50)
        XCTAssertEqual(full.faces.map(\.minX), [4, 19, 34, 49])
        XCTAssertEqual(full.more, CGRect(x: 64, y: 6, width: 24, height: 24))
        XCTAssertGreaterThanOrEqual(ViewersSlotLayout.ring(full.faces[0]).minX - M.ringWidth / 2, 0)
    }

    func testFacesSitAtTheTrailingEdgeAndSeenOnesAreSmaller() {
        let one = ViewersSlotLayout(large: [true], total: 1)
        XCTAssertEqual(one.faces, [CGRect(x: 64, y: 6, width: 24, height: 24)])
        XCTAssertNil(one.more)
        let mixed = ViewersSlotLayout(large: [true, false], total: 2)
        XCTAssertEqual(mixed.faces, [CGRect(x: 53, y: 6, width: 24, height: 24), CGRect(x: 68, y: 8, width: 20, height: 20)])
        XCTAssertEqual(ViewersSlotLayout(large: [], total: 0).faces, [])
    }
}
