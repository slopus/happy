import CoreGraphics
import HappyLayout
import XCTest

/// A conversation's title in the navigation bar, on an iPhone Pro Max's
/// 430-wide bar: Back ends at 60 and the compose and More capsule starts
/// at 314, so the bar leaves 68 to 306 for the title. The capsule hugs the
/// name and status, centred on the bar's 215, and moves only as far as an
/// item makes it. Widths: "hey" 26, "online" 40, the widest status 150.
final class ChatHeaderLayoutTests: XCTestCase {
    private let room: ClosedRange<CGFloat> = 68...306
    /// The same bar right to left: Back at the right, the group at the left.
    private let mirrored: ClosedRange<CGFloat> = 124...362

    private func layout(_ title: CGFloat, _ status: CGFloat? = 40, room: ClosedRange<CGFloat>? = nil, height: CGFloat = 44) -> ChatHeaderLayout {
        ChatHeaderLayout(titleWidth: title, statusWidth: status, reservedStatusWidth: 150, centerX: 215, room: room ?? self.room, height: height)
    }

    func testAShortTitleHugsItsTextCentredOnTheBar() {
        let short = layout(26)
        XCTAssertEqual(short.capsule, CGRect(x: 183, y: 0, width: 64, height: 44))
        XCTAssertEqual(short.title, CGRect(x: 202, y: 3, width: 26, height: 22))
        XCTAssertEqual(short.status, CGRect(x: 140, y: 25, width: 150, height: 16))
    }

    func testAMediumTitleStaysCentred() {
        let medium = layout(150)
        XCTAssertEqual(medium.capsule, CGRect(x: 128, y: 0, width: 174, height: 44))
        XCTAssertEqual(medium.title, CGRect(x: 140, y: 3, width: 150, height: 22))
        XCTAssertEqual(medium.capsule.midX, 215)
    }

    /// Centred it would end at 327, past the group's 306: it moves left
    /// just enough, and nothing is cut.
    func testALongTitleMovesLeftOnlyAsFarAsTheGroupMakesIt() {
        let long = layout(200)
        XCTAssertEqual(long.capsule, CGRect(x: 82, y: 0, width: 224, height: 44))
        XCTAssertEqual(long.title, CGRect(x: 94, y: 3, width: 200, height: 22))
        XCTAssertEqual(long.status, CGRect(x: 119, y: 25, width: 150, height: 16))
    }

    func testAVeryLongTitleFillsTheRoomAndIsCut() {
        let veryLong = layout(400)
        XCTAssertEqual(veryLong.capsule, CGRect(x: 68, y: 0, width: 238, height: 44))
        XCTAssertEqual(veryLong.title, CGRect(x: 80, y: 3, width: 214, height: 22))
        XCTAssertEqual(veryLong.status, CGRect(x: 112, y: 25, width: 150, height: 16))
    }

    /// Right to left the group is at the left: a long title moves right,
    /// the mirror image of the left-to-right frames.
    func testRightToLeftMirrors() {
        let long = layout(200, room: mirrored)
        XCTAssertEqual(long.capsule, CGRect(x: 124, y: 0, width: 224, height: 44))
        XCTAssertEqual(long.title, CGRect(x: 136, y: 3, width: 200, height: 22))
        XCTAssertEqual(long.capsule.minX, 430 - layout(200).capsule.maxX)
        XCTAssertEqual(layout(26, room: mirrored), layout(26), "a short title is centred either way")
        XCTAssertEqual(layout(400, room: mirrored).capsule, CGRect(x: 124, y: 0, width: 238, height: 44))
    }

    /// "online" to "Waiting for your answer" and back: the capsule grows
    /// and shrinks about the bar's middle; neither line moves.
    func testAStatusChangeMovesNeitherLine() {
        let online = layout(26, 40)
        let waiting = layout(26, 150)
        XCTAssertEqual(waiting.capsule, CGRect(x: 128, y: 0, width: 174, height: 44))
        XCTAssertEqual(online.capsule.midX, waiting.capsule.midX)
        XCTAssertEqual(online.title, waiting.title)
        XCTAssertEqual(online.status, waiting.status)
    }

    func testTheCapsuleIsNeverNarrowerThanItIsTall() {
        let tiny = layout(10, nil)
        XCTAssertEqual(tiny.capsule, CGRect(x: 193, y: 0, width: 44, height: 44))
        XCTAssertEqual(tiny.title, CGRect(x: 210, y: 3, width: 10, height: 22))
        XCTAssertNil(tiny.status)
    }

    /// In the header's own coordinates (the bar hands it 68 to 306) the
    /// frames are the same, shifted.
    func testTheHeadersOwnCoordinatesGiveTheSameFrames() {
        let local = ChatHeaderLayout(titleWidth: 200, statusWidth: 40, reservedStatusWidth: 150, centerX: 147, room: 0...238, height: 44)
        XCTAssertEqual(local.capsule, layout(200).capsule.offsetBy(dx: -68, dy: 0))
        XCTAssertEqual(local.title, layout(200).title.offsetBy(dx: -68, dy: 0))
    }

    /// A taller bar (a wide window's) centres the capsule on its height.
    func testTheCapsuleIsCentredOnATallerBar() {
        let tall = layout(26, height: 50)
        XCTAssertEqual(tall.capsule, CGRect(x: 183, y: 3, width: 64, height: 44))
        XCTAssertEqual(tall.title, CGRect(x: 202, y: 6, width: 26, height: 22))
    }
}
