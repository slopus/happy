import CoreGraphics
@testable import HappyLayout
import XCTest

/// The Profile page on a 393-wide phone, frame by frame, and the square a
/// picked picture is cut to.
final class ProfileLayoutTests: XCTestCase {
    typealias Spec = SettingsLayout.RowSpec

    func testThePictureButtonAndCardsStackUnderTheBar() {
        let name = Spec(hasIcon: false, accessory: .none)
        let remove = Spec(hasIcon: false, accessory: .none)
        let layout = ProfileLayout(width: 393, buttonWidth: 101.4, cards: [[name], [remove]])
        // 100 round, centred: (393 - 100) / 2 = 146.5, rounded.
        XCTAssertEqual(layout.avatar, CGRect(x: 147, y: 16, width: 100, height: 100))
        // 102 measured, 12 either side: 126 wide, centred.
        XCTAssertEqual(layout.changePhoto, CGRect(x: 134, y: 124, width: 126, height: 32))
        // Settings' cards: 16 in, 52 a row, 24 apart, from 20 under the button.
        XCTAssertEqual(layout.cards.map(\.frame), [
            CGRect(x: 16, y: 176, width: 361, height: 52),
            CGRect(x: 16, y: 252, width: 361, height: 52),
        ])
        // The name is typed where a plain row's title goes: 16 in, 15 down.
        XCTAssertEqual(layout.cards[0].rows[0].title, CGRect(x: 16, y: 15, width: 329, height: 22))
        XCTAssertEqual(layout.nameField, CGRect(x: 32, y: 191, width: 329, height: 22))
        XCTAssertNil(layout.cards[0].rows[0].separator)
        XCTAssertEqual(layout.contentHeight, 304 + 32)
    }

    /// No picture: only the name's card, and the page ends under it.
    func testWithoutAPictureOnlyTheNameCard() {
        let layout = ProfileLayout(width: 393, buttonWidth: 101.4, cards: [[Spec(hasIcon: false, accessory: .none)], []])
        XCTAssertEqual(layout.cards.count, 1)
        XCTAssertEqual(layout.contentHeight, 228 + 32)
        let empty = ProfileLayout(width: 393, buttonWidth: 101.4, cards: [])
        XCTAssertEqual(empty.nameField, .zero)
        XCTAssertEqual(empty.contentHeight, 156 + 32)
    }

    /// A narrow screen never gets a button wider than itself.
    func testTheButtonFitsTheWidth() {
        let layout = ProfileLayout(width: 100, buttonWidth: 300, cards: [])
        XCTAssertEqual(layout.changePhoto, CGRect(x: 0, y: 124, width: 100, height: 32))
        XCTAssertEqual(layout.avatar, CGRect(x: 0, y: 16, width: 100, height: 100))
    }

    func testAPictureIsCutToItsMiddleSquareAndShrunk() {
        // A 4032 x 3024 photo: 512 across, its sides cut off evenly.
        let landscape = ProfilePhotoCrop(size: CGSize(width: 4032, height: 3024))
        XCTAssertEqual(landscape.side, 512)
        XCTAssertEqual(landscape.draw, CGRect(x: -85, y: 0, width: 683, height: 512))
        // Upright: its top and bottom go.
        let portrait = ProfilePhotoCrop(size: CGSize(width: 3024, height: 4032))
        XCTAssertEqual(portrait.draw, CGRect(x: 0, y: -85, width: 512, height: 683))
        // Smaller than 512 is never enlarged.
        let small = ProfilePhotoCrop(size: CGSize(width: 300, height: 200))
        XCTAssertEqual(small.side, 200)
        XCTAssertEqual(small.draw, CGRect(x: -50, y: 0, width: 300, height: 200))
        let square = ProfilePhotoCrop(size: CGSize(width: 1024, height: 1024))
        XCTAssertEqual(square.draw, CGRect(x: 0, y: 0, width: 512, height: 512))
    }
}
