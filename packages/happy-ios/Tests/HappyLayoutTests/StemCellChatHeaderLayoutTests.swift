import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the conversation's glass header.
final class StemCellChatHeaderLayoutTests: XCTestCase {
    func testTheNameAloneSitsInAGlassCapsuleBesideTheBackCircle() {
        // iPhone 17 Pro: 402 wide, 62 of status bar.
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 140.3, statusWidth: nil)
        XCTAssertEqual(layout.back, CGRect(x: 16, y: 66, width: 44, height: 44))
        XCTAssertEqual(layout.pill, CGRect(x: 115, y: 66, width: 173, height: 44))
        XCTAssertEqual(layout.title, CGRect(x: 131, y: 77, width: 141, height: 22))
        XCTAssertNil(layout.status)
        XCTAssertEqual(layout.backdrop, CGRect(x: 0, y: 0, width: 402, height: 122))
        XCTAssertEqual(layout.listTop, 114)
        XCTAssertEqual(layout.titleMaxWidth, 234)
    }

    func testAStatusAddsAGreyLineUnderTheName() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 60, statusWidth: 52)
        XCTAssertEqual(layout.pill, CGRect(x: 155, y: 64, width: 92, height: 48))
        XCTAssertEqual(layout.title, CGRect(x: 171, y: 69, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 175, y: 91, width: 52, height: 16))
    }

    func testALongNameIsCutAndTheCapsuleStaysCentredClearOfTheCircle() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 900, statusWidth: nil)
        XCTAssertEqual(layout.pill, CGRect(x: 68, y: 66, width: 266, height: 44))
        XCTAssertEqual(layout.pill.minX - layout.back.maxX, 8)
        XCTAssertEqual(layout.pill.midX, 201)
        XCTAssertEqual(layout.title.width, 234)
        XCTAssertEqual(layout.titleMaxWidth, 234)
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
