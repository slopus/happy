import CoreGraphics
@testable import HappyLayout
import XCTest

/// The agent's picture at the top of its connection's Settings: the
/// circle and the pencil badge on its rim, frame by frame.
final class AgentEditButtonLayoutTests: XCTestCase {
    func testTheBadgeSitsOnTheCircleRimInsideTheButton() {
        let layout = AgentEditButtonLayout()
        XCTAssertEqual(layout.size, CGSize(width: 100, height: 100))
        XCTAssertEqual(layout.avatar, CGRect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertEqual(layout.badge, CGRect(x: 68, y: 68, width: 32, height: 32))
        XCTAssertEqual(layout.pencil, CGRect(x: 8, y: 8, width: 16, height: 16))
        // Inside the button on every side: nothing for a parent to clip.
        XCTAssertTrue(CGRect(origin: .zero, size: layout.size).contains(layout.badge))
        XCTAssertTrue(CGRect(origin: .zero, size: layout.badge.size).contains(layout.pencil))
        // Its middle within a few points of the rim, 45° down and right.
        let radius = layout.avatar.width / 2
        let distance = hypot(layout.badge.midX - layout.avatar.midX, layout.badge.midY - layout.avatar.midY)
        XCTAssertEqual(distance, radius, accuracy: 4)
        XCTAssertEqual(layout.badge.midX - layout.avatar.midX, layout.badge.midY - layout.avatar.midY)
    }

    /// On the page: centred at the top, the name and line under it, then
    /// the cards; gone while searching, and without one the name is first.
    func testThePictureIsCentredOverTheName() {
        typealias L = SettingsLayout
        let row = [L.RowSpec(hasIcon: true, accessory: .chevron)]
        let layout = L(width: 402, nameHeight: 34, subtitleHeight: 21, cards: [row], showsStrip: false, picture: 100)
        XCTAssertEqual(layout.picture, CGRect(x: 151, y: 8, width: 100, height: 100))
        XCTAssertEqual(layout.name, CGRect(x: 24, y: 120, width: 354, height: 34))
        XCTAssertEqual(layout.subtitle, CGRect(x: 24, y: 156, width: 354, height: 21))
        XCTAssertEqual(layout.cards[0].frame.minY, 205)
        let searching = L(width: 402, nameHeight: 34, subtitleHeight: 21, cards: [row], searching: true, showsStrip: false, picture: 100)
        XCTAssertEqual(searching.picture, .zero)
        XCTAssertEqual(searching.cards[0].frame.minY, 8)
        let none = L(width: 402, nameHeight: 34, subtitleHeight: 21, cards: [row], showsStrip: false)
        XCTAssertEqual(none.picture, .zero)
        XCTAssertEqual(none.name.minY, 8)
    }
}
