import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// A personal bot's settings page, frame by frame: the picture centred
/// over Change Photo, the name's card, the instructions' card growing with
/// its text, and the line under it.
final class BotSettingsLayoutTests: XCTestCase {
    func testAShortTextKeepsTheCardsLeastHeightAndTheNoteFollows() {
        let layout = BotSettingsLayout(width: 390, captionWidth: 109.6, instructionsHeight: 60, noteHeight: 35.2)
        XCTAssertEqual(layout.avatar, CGRect(x: 147, y: 24, width: 96, height: 96))
        XCTAssertEqual(layout.photoButton, CGRect(x: 140, y: 128, width: 110, height: 22))
        XCTAssertEqual(layout.nameHeading, CGRect(x: 32, y: 178, width: 326, height: 18))
        XCTAssertEqual(layout.nameCard, CGRect(x: 16, y: 204, width: 358, height: 52))
        XCTAssertEqual(layout.nameText, CGRect(x: 32, y: 204, width: 326, height: 52))
        XCTAssertEqual(layout.instructionsHeading, CGRect(x: 32, y: 280, width: 326, height: 18))
        XCTAssertEqual(layout.instructionsCard, CGRect(x: 16, y: 306, width: 358, height: 160))
        XCTAssertEqual(layout.instructionsText, CGRect(x: 32, y: 320, width: 326, height: 132))
        XCTAssertEqual(layout.note, CGRect(x: 32, y: 474, width: 326, height: 36))
        XCTAssertEqual(layout.contentHeight, 542)
        XCTAssertEqual(BotSettingsLayout.instructionsTextWidth(width: 390), layout.instructionsText.width)
        XCTAssertEqual(BotSettingsLayout.noteWidth(width: 390), layout.note?.width)
    }

    /// Long instructions make the card as tall as they are; without a
    /// note the page ends under the card.
    func testLongInstructionsGrowTheCard() {
        let layout = BotSettingsLayout(width: 390, captionWidth: 110, instructionsHeight: 300.4, noteHeight: 0)
        XCTAssertEqual(layout.instructionsText, CGRect(x: 32, y: 320, width: 326, height: 301))
        XCTAssertEqual(layout.instructionsCard, CGRect(x: 16, y: 306, width: 358, height: 329))
        XCTAssertNil(layout.note)
        XCTAssertEqual(layout.contentHeight, 667)
        // Every frame inside the page across.
        for frame in [layout.avatar, layout.photoButton, layout.nameCard, layout.nameText, layout.instructionsCard, layout.instructionsText] {
            XCTAssertGreaterThanOrEqual(frame.minX, 0)
            XCTAssertLessThanOrEqual(frame.maxX, 390)
        }
    }
}
