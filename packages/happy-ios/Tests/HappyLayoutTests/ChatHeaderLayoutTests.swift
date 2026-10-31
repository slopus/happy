import CoreGraphics
import HappyLayout
import XCTest

/// A conversation's title in the navigation bar. On an iPhone Pro Max's
/// 430-wide bar Back ends at 64 and Compose starts at 366, so the bar
/// leaves 72 to 358 for the title, its middle 215; on a 402-wide one, 72
/// to 330 about 201. The capsule's content is never under 150, as
/// Telegram's (a 178 capsule: Telegram's "Serafim / last seen recently"
/// measures 126 to 304 on the same bar), grows with a longer name, and
/// moves only as far as an item makes it. Widths: "hey" 26, "online" 40,
/// the widest status 150.
final class ChatHeaderLayoutTests: XCTestCase {
    private let wide: ClosedRange<CGFloat> = 72...358
    private let narrow: ClosedRange<CGFloat> = 72...330

    private func layout(
        _ title: CGFloat, _ status: CGFloat? = 40, room: ClosedRange<CGFloat>? = nil, centerX: CGFloat = 215, height: CGFloat = 44
    ) -> ChatHeaderLayout {
        ChatHeaderLayout(titleWidth: title, statusWidth: status, reservedStatusWidth: 150, centerX: centerX, room: room ?? wide, height: height)
    }

    /// "hey / offline": the capsule is the minimum, on the bar's middle.
    func testAShortTitleIsTheMinimumCentredOnTheBar() {
        let short = layout(26)
        XCTAssertEqual(short.capsule, CGRect(x: 126, y: 0, width: 178, height: 44))
        XCTAssertEqual(short.capsule.midX, 215)
        XCTAssertEqual(short.title, CGRect(x: 202, y: 3, width: 26, height: 22))
        XCTAssertEqual(short.status, CGRect(x: 140, y: 25, width: 150, height: 16))
        XCTAssertEqual(layout(26, nil).capsule, short.capsule, "no status, the same minimum")
    }

    func testAMediumTitleGrowsPastTheMinimumCentred() {
        let medium = layout(200)
        XCTAssertEqual(medium.capsule, CGRect(x: 101, y: 0, width: 228, height: 44))
        XCTAssertEqual(medium.title, CGRect(x: 115, y: 3, width: 200, height: 22))
        XCTAssertEqual(medium.status, CGRect(x: 140, y: 25, width: 150, height: 16))
    }

    func testAVeryLongTitleFillsTheRoomAndIsCut() {
        let veryLong = layout(400)
        XCTAssertEqual(veryLong.capsule, CGRect(x: 72, y: 0, width: 286, height: 44))
        XCTAssertEqual(veryLong.title, CGRect(x: 86, y: 3, width: 258, height: 22))
        XCTAssertEqual(veryLong.status, CGRect(x: 140, y: 25, width: 150, height: 16))
    }

    /// A wider item at the right leaves 72 to 330 about the bar's 215:
    /// centred, a 220 name would end at 339, so it moves left just enough.
    func testALongTitleMovesLeftOnlyAsFarAsTheRightItemMakesIt() {
        let long = layout(220, room: narrow)
        XCTAssertEqual(long.capsule, CGRect(x: 82, y: 0, width: 248, height: 44))
        XCTAssertEqual(long.title, CGRect(x: 96, y: 3, width: 220, height: 22))
        XCTAssertEqual(layout(26, room: narrow), layout(26), "a short one has room centred")
    }

    /// Right to left the wider item is at the left: the mirror image.
    func testRightToLeftMirrors() {
        let mirrored: ClosedRange<CGFloat> = 100...358
        let long = layout(220, room: mirrored)
        XCTAssertEqual(long.capsule, CGRect(x: 100, y: 0, width: 248, height: 44))
        XCTAssertEqual(long.capsule.minX, 430 - layout(220, room: narrow).capsule.maxX)
        XCTAssertEqual(long.title, CGRect(x: 114, y: 3, width: 220, height: 22))
        XCTAssertEqual(layout(26, room: mirrored), layout(26), "a short title is centred either way")
    }

    /// A 402-wide phone: the same minimum, about its own middle.
    func testANarrowerPhone() {
        let short = layout(26, room: narrow, centerX: 201)
        XCTAssertEqual(short.capsule, CGRect(x: 112, y: 0, width: 178, height: 44))
        XCTAssertEqual(short.title, CGRect(x: 188, y: 3, width: 26, height: 22))
        let medium = layout(200, room: narrow, centerX: 201)
        XCTAssertEqual(medium.capsule, CGRect(x: 87, y: 0, width: 228, height: 44))
        XCTAssertEqual(medium.title, CGRect(x: 101, y: 3, width: 200, height: 22))
        let veryLong = layout(400, room: narrow, centerX: 201)
        XCTAssertEqual(veryLong.capsule, CGRect(x: 72, y: 0, width: 258, height: 44))
        XCTAssertEqual(veryLong.title, CGRect(x: 86, y: 3, width: 230, height: 22))
        XCTAssertEqual(veryLong.status, CGRect(x: 126, y: 25, width: 150, height: 16))
    }

    /// "online" to "Waiting for your answer" and back: every status fits
    /// the capsule, so nothing changes.
    func testAStatusChangeChangesNothing() {
        XCTAssertEqual(layout(26, 40), layout(26, 150))
        XCTAssertEqual(layout(26, 40), layout(26, 90))
        XCTAssertEqual(layout(200, 40), layout(200, 150))
    }

    /// Less room than the minimum: the capsule is the room, the status's
    /// line cut to the capsule.
    func testTheMinimumGivesWayToTheRoom() {
        let squeezed = layout(26, room: 0...150, centerX: 75)
        XCTAssertEqual(squeezed.capsule, CGRect(x: 0, y: 0, width: 150, height: 44))
        XCTAssertEqual(squeezed.title, CGRect(x: 62, y: 3, width: 26, height: 22))
        XCTAssertEqual(squeezed.status, CGRect(x: 14, y: 25, width: 122, height: 16))
        XCTAssertEqual(layout(26, nil, room: 0...100, centerX: 50).capsule, CGRect(x: 0, y: 0, width: 100, height: 44))
    }

    /// In the header's own coordinates (the bar hands it 72 to 358) the
    /// frames are the same, shifted.
    func testTheHeadersOwnCoordinatesGiveTheSameFrames() {
        let local = ChatHeaderLayout(titleWidth: 200, statusWidth: 40, reservedStatusWidth: 150, centerX: 143, room: 0...286, height: 44)
        XCTAssertEqual(local.capsule, layout(200).capsule.offsetBy(dx: -72, dy: 0))
        XCTAssertEqual(local.title, layout(200).title.offsetBy(dx: -72, dy: 0))
    }

    /// A taller bar (a wide window's) centres the capsule on its height.
    func testTheCapsuleIsCentredOnATallerBar() {
        let tall = layout(26, height: 50)
        XCTAssertEqual(tall.capsule, CGRect(x: 126, y: 3, width: 178, height: 44))
        XCTAssertEqual(tall.title, CGRect(x: 202, y: 6, width: 26, height: 22))
    }
}
