import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the conversation's glass header.
final class StemCellChatHeaderLayoutTests: XCTestCase {
    /// The capsule runs from 8 past the circle to the standard 16 short of
    /// the right edge, whatever the name; the name is centred in it.
    func testTheNameSitsInAGlassCapsuleRunningToTheRightEdge() {
        // iPhone 17 Pro: 402 wide, 62 of status bar.
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 140.3, statusWidth: nil)
        XCTAssertEqual(layout.back, CGRect(x: 16, y: 66, width: 44, height: 44))
        XCTAssertEqual(layout.pill, CGRect(x: 68, y: 66, width: 318, height: 44))
        XCTAssertEqual(layout.pill.minX - layout.back.maxX, 8)
        XCTAssertEqual(402 - layout.pill.maxX, 16)
        XCTAssertEqual(layout.title, CGRect(x: 157, y: 77, width: 141, height: 22))
        XCTAssertNil(layout.status)
        XCTAssertEqual(layout.backdrop, CGRect(x: 0, y: 0, width: 402, height: 122))
        XCTAssertEqual(layout.listTop, 114)
        XCTAssertEqual(layout.titleMaxWidth, 286)
    }

    func testAStatusAddsAGreyLineUnderTheName() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 60, statusWidth: 52)
        XCTAssertEqual(layout.pill, CGRect(x: 68, y: 64, width: 318, height: 48))
        XCTAssertEqual(layout.title, CGRect(x: 197, y: 69, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 201, y: 91, width: 52, height: 16))
    }

    func testALongNameIsCutInsideTheCapsule() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 900, statusWidth: nil)
        XCTAssertEqual(layout.pill, CGRect(x: 68, y: 66, width: 318, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 84, y: 77, width: 286, height: 22))
        XCTAssertEqual(layout.titleMaxWidth, 286)
    }

    /// The back circle stands where home's account picture does.
    func testTheBackCircleIsHomesLeftControl() {
        var input = HomeHeaderLayout.Input(width: 402, safeTop: 62, hairline: 1.0 / 3, title: Measurable { _ in CGSize(width: 90, height: 20) }, status: nil)
        input.showsAccountAvatar = true
        let home = HomeHeaderLayout(input)
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 90, statusWidth: nil)
        XCTAssertEqual(layout.back, home.logoControl)
    }
}
