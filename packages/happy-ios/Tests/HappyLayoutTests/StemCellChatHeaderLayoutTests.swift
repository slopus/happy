import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the conversation's glass header.
final class StemCellChatHeaderLayoutTests: XCTestCase {
    /// The capsule hugs the name, 16 either side, and both are centred on the screen.
    func testTheNameIsCentredOnTheScreenInACapsuleThatHugsIt() {
        // iPhone 17 Pro: 402 wide, 62 of status bar.
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 140.3, statusWidth: nil)
        XCTAssertEqual(layout.back, CGRect(x: 16, y: 66, width: 44, height: 44))
        XCTAssertEqual(layout.pill, CGRect(x: 115, y: 66, width: 173, height: 44))
        XCTAssertEqual(layout.pill.midX, 201.5, "centred, on a whole point")
        XCTAssertEqual(layout.title, CGRect(x: 131, y: 77, width: 141, height: 22))
        XCTAssertEqual(layout.title.midX, 201.5)
        XCTAssertNil(layout.status)
        XCTAssertEqual(layout.backdrop, CGRect(x: 0, y: 0, width: 402, height: 122))
        // The scrim's 36 of feather end under the capsule, not on it.
        XCTAssertEqual(layout.scrim, CGRect(x: 0, y: 0, width: 402, height: 148))
        XCTAssertEqual(layout.listTop, 114)
        XCTAssertEqual(layout.titleMaxWidth, 234)
    }

    /// The status is centred on the same axis, under the name.
    func testAStatusAddsAGreyLineUnderTheName() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 60, statusWidth: 52)
        XCTAssertEqual(layout.pill, CGRect(x: 155, y: 64, width: 92, height: 48))
        XCTAssertEqual(layout.title, CGRect(x: 171, y: 69, width: 60, height: 22))
        XCTAssertEqual(layout.status, CGRect(x: 175, y: 91, width: 52, height: 16))
        XCTAssertEqual(layout.title.midX, 201)
        XCTAssertEqual(layout.status?.midX, 201)
        // The same scrim with a status or without: it never moves.
        XCTAssertEqual(layout.scrim.maxY, 148)
        XCTAssertEqual(layout.scrim.maxY - layout.pill.maxY, HeaderScrim.rampPoints)
        // A status wider than the name sizes the capsule.
        let wide = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 30, statusWidth: 100)
        XCTAssertEqual(wide.pill, CGRect(x: 135, y: 64, width: 132, height: 48))
    }

    /// At rest nothing is under the header, so nothing is washed; scrolled
    /// the 8 of room under it, before anything meets the capsule, whole.
    func testTheScrimComesInAsTheTranscriptScrollsUnder() {
        XCTAssertEqual(HeaderScrim.presence(scrolledUnder: -20), 0)
        XCTAssertEqual(HeaderScrim.presence(scrolledUnder: 0), 0)
        XCTAssertEqual(HeaderScrim.presence(scrolledUnder: 4), 0.5)
        XCTAssertEqual(HeaderScrim.presence(scrolledUnder: 8), 1)
        XCTAssertEqual(HeaderScrim.presence(scrolledUnder: 400), 1)
    }

    /// A long name widens the capsule from 8 past the circle to as far short
    /// of the right edge, which stays free, and is cut inside it.
    func testALongNameIsCutInsideTheCapsule() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 900, statusWidth: nil)
        XCTAssertEqual(layout.pill, CGRect(x: 68, y: 66, width: 266, height: 44))
        XCTAssertEqual(layout.pill.minX - layout.back.maxX, 8)
        XCTAssertEqual(402 - layout.pill.maxX, layout.pill.minX)
        XCTAssertEqual(layout.title, CGRect(x: 84, y: 77, width: 234, height: 22))
        XCTAssertEqual(layout.title.midX, 201)
        XCTAssertEqual(layout.titleMaxWidth, 234)
    }

    /// A short name still makes a capsule at least as wide as it is tall.
    func testAShortNameKeepsARoundCapsule() {
        let layout = StemCellChatHeaderLayout(width: 402, safeTop: 62, titleWidth: 8, statusWidth: nil)
        XCTAssertEqual(layout.pill, CGRect(x: 179, y: 66, width: 44, height: 44))
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
