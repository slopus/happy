import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Making a bot from home's dock: Session | Bot at the top, the faces over
/// the composer (HomeDock.tsx, BotFacePicker.tsx).
final class HomeDockBotLayoutTests: XCTestCase {
    private let faceText = BotFacePickerLayout.Text(
        heading: text("Avatar", lineHeight: 15),
        credit: text("Art by Lisa Wischofsky", lineHeight: 13, maxLines: 1),
        creditLead: text("Art by ", lineHeight: 13, maxLines: 1)
    )

    // MARK: The faces

    func testFourFacesAtTheirMostAndTheDieBeside() {
        // The dock's faces line on a 393 phone: 345 less 6 each side.
        let layout = BotFacePickerLayout(width: 333, text: faceText)
        assertFrame(layout.heading, rect(0, 0, 48, 15))
        XCTAssertEqual(layout.faces.count, 4)
        // 52 square, 10 apart, 6 under the heading.
        assertFrame(layout.faces[0], rect(0, 21, 52, 52))
        assertFrame(layout.faces[1], rect(62, 21, 52, 52))
        assertFrame(layout.faces[3], rect(186, 21, 52, 52))
        // The fifth thing in the row, centred on it.
        assertFrame(layout.die, rect(248, 27, 40, 40))
        // The credit 6 below, the link after "Art by ".
        assertFrame(layout.credit, rect(0, 79, 176, 13))
        assertFrame(layout.creditLink, rect(56, 79, 120, 13))
        assertSize(layout.size, CGSize(width: 333, height: 92))
    }

    func testFacesShrinkTogetherOnANarrowPhone() {
        // 320 wide: 260 for the line, the die and four gaps take 80.
        let layout = BotFacePickerLayout(width: 260, text: faceText)
        assertFrame(layout.faces[0], rect(0, 21, 45, 45))
        assertFrame(layout.faces[3], rect(165, 21, 45, 45))
        assertFrame(layout.die, rect(220, 23.5, 40, 40))
        XCTAssertLessThanOrEqual(layout.die.maxX, 260, "the row never runs past the screen")
        assertFrame(layout.credit, rect(0, 72, 176, 13))
    }

    func testALongCreditIsCutToOneLine() {
        let layout = BotFacePickerLayout(width: 100, text: faceText)
        assertFrame(layout.credit, rect(0, layout.credit.minY, 100, 13))
        assertFrame(layout.creditLink, rect(56, layout.credit.minY, 44, 13))
    }

    func testFacePickerTokensFromHappyApp() {
        typealias M = BotFacePickerLayout.Metrics
        XCTAssertEqual(M.faceSize, 52)
        XCTAssertEqual(M.faceRadius, 14)
        XCTAssertEqual(M.ringWidth, 2)
        XCTAssertEqual(M.imageRadius, 12)
        XCTAssertEqual(M.dieSize, 40)
        XCTAssertEqual(M.dieIconSize, 22)
        XCTAssertEqual(BotFace.paintSize, 256)
        XCTAssertEqual(TextStyles.botFaceHeading, TextStyle(.semiBold, size: 12))
        XCTAssertEqual(TextStyles.botFaceCredit, TextStyle(.regular, size: 11))
        XCTAssertEqual(TextStyles.homeDockLede, TextStyle(.regular, size: 13, lineHeight: 18))
    }

    // MARK: The focused dock

    func testABotKeepsTheMachineRowAndTheFacesTakeTheRest() {
        let layout = HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: 102,
            rows: [text("MacBook Pro", lineHeight: 22, maxLines: 1)],
            faces: faceText
        ))
        assertFrame(layout.composer, rect(16, 708, 361, 102))
        // 42 of row, 1, then 6 + 92 + 4 of faces, 22 clear of the composer.
        XCTAssertEqual(layout.rows.count, 1)
        assertFrame(layout.rows[0].frame, rect(24, 541, 345, 42))
        assertFrame(layout.faces, rect(24, 584, 345, 102))
        // Lined up with the icon column.
        assertFrame(layout.facePicker, rect(30, 590, 333, 92))
        XCTAssertEqual(layout.facePickerLayout, BotFacePickerLayout(width: 333, text: faceText))
    }

    func testASessionHasNoFaces() {
        let layout = HomeDockFocusLayout(.init(
            size: phone,
            safeBottom: 34,
            composerHeight: 102,
            rows: [text("MacBook Pro", lineHeight: 22, maxLines: 1)]
        ))
        XCTAssertNil(layout.faces)
        XCTAssertNil(layout.facePicker)
        XCTAssertNil(layout.facePickerLayout)
        assertFrame(layout.rows[0].frame, rect(24, 644, 345, 42))
    }

    // MARK: Session | Bot

    func testTheSwitchHoldsTheTopOfTheScreen() {
        let layout = HomeDockHeaderLayout(.init(width: 393, safeTop: 59))
        // 8 under the safe area, at most 260, centred.
        assertFrame(layout.segment, rect(66.5, 67, 260, 32))
        XCTAssertNil(layout.lede)
        assertFrame(layout.content, rect(24, 67, 345, 32))
    }

    func testABotsLedeSitsTenBelowAtMost340() {
        let lede = text(String(repeating: "x", count: 50), lineHeight: 18)
        let layout = HomeDockHeaderLayout(.init(width: 393, safeTop: 59, lede: lede))
        assertFrame(layout.segment, rect(66.5, 67, 260, 32))
        // 340 holds 42 characters a line: two lines, centred.
        assertFrame(layout.lede, rect(28.5, 109, 336, 36))
        assertFrame(layout.content, rect(24, 67, 345, 78))
    }

    func testANarrowScreenNarrowsTheSwitch() {
        let layout = HomeDockHeaderLayout(.init(width: 280, safeTop: 20))
        // 232 of lane, less than 260.
        assertFrame(layout.segment, rect(24, 28, 232, 32))
    }
}
