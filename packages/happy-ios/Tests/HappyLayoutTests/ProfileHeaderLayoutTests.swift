import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for a chat's profile's head, the agent chat's and the
/// legacy session's, on a 402-wide phone.
final class ProfileHeaderLayoutTests: XCTestCase {
    /// The avatar centred 12 under the bar; the name 14 under it, centred,
    /// as wide as it reads; what it is 2 under that, the row's width.
    func testTheAvatarTheNameAndItsLine() {
        let head = ProfileHeaderLayout(width: 402, nameHeight: 34, nameWidth: 200, subtitleHeight: 22)
        XCTAssertEqual(head.mark, CGRect(x: 157, y: 12, width: 88, height: 88))
        XCTAssertEqual(head.name, CGRect(x: 101, y: 114, width: 200, height: 34))
        XCTAssertEqual(head.field, CGRect(x: 24, y: 114, width: 354, height: 34))
        XCTAssertEqual(head.subtitle, CGRect(x: 24, y: 150, width: 354, height: 22))
        XCTAssertNil(head.pencil)
        XCTAssertNil(head.pencilTouch)
        XCTAssertEqual(head.bottom, 172)
    }

    /// Renamed where it stands: the pencil 6 after the name, a finger's
    /// room around it; the name keeps the pencil's room on both sides.
    func testThePencil() {
        let head = ProfileHeaderLayout(width: 402, nameHeight: 34, nameWidth: 180, renames: true, subtitleHeight: 22)
        XCTAssertEqual(head.name, CGRect(x: 111, y: 114, width: 180, height: 34))
        XCTAssertEqual(head.pencil, CGRect(x: 297, y: 121, width: 20, height: 20))
        XCTAssertEqual(head.pencilTouch, CGRect(x: 285, y: 109, width: 44, height: 44))
        let long = ProfileHeaderLayout(width: 402, nameHeight: 34, nameWidth: 600, renames: true, subtitleHeight: 22)
        XCTAssertEqual(long.name, CGRect(x: 50, y: 114, width: 302, height: 34))
    }

    /// On a wider screen it stays centred, its name capped by the sides.
    func testATabletWidth() {
        let head = ProfileHeaderLayout(width: 820, nameHeight: 34, nameWidth: nil, subtitleHeight: 22)
        XCTAssertEqual(head.mark, CGRect(x: 366, y: 12, width: 88, height: 88))
        XCTAssertEqual(head.name, CGRect(x: 24, y: 114, width: 772, height: 34))
    }
}
