#if canImport(UIKit)
import HappyCore
import HappyLayout
import XCTest
@testable import HappyUI

@MainActor
final class StoryViewersTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    func testWhenAViewerReactedReadsAsAgoThenYesterdayThenTheDate() {
        // 2026-10-25 12:00 UTC.
        let now: Int64 = 1_792_929_600_000
        XCTAssertEqual(Strings.Stories.when(now - 30_000, now: now, calendar: calendar), "just now")
        XCTAssertEqual(Strings.Stories.when(now - 2 * 60_000, now: now, calendar: calendar), "2m ago")
        XCTAssertEqual(Strings.Stories.when(now - 5 * 3_600_000, now: now, calendar: calendar), "5h ago")
        // The time's space before AM is a narrow no-break one, as Foundation writes it.
        XCTAssertEqual(Strings.Stories.when(now - 26 * 3_600_000, now: now, calendar: calendar).replacingOccurrences(of: "\u{202F}", with: " "), "yesterday at 10:00 AM")
        XCTAssertEqual(Strings.Stories.when(now - 4 * 86_400_000, now: now, calendar: calendar), "Oct 21")
    }

    func testAReactorsRowIsTallerAndOnlyItShowsAReaction() {
        let reactor = StoryViewer(userId: "u1", name: "Steve", photo: nil, thumbhash: nil, reaction: "❤️", reactedAt: 1)
        let viewer = StoryViewer(userId: "u2", name: "Ana", photo: nil, thumbhash: nil, reaction: nil, reactedAt: nil)
        let reacted = StoriesViewerCell.layout(reactor, width: 393)
        let plain = StoriesViewerCell.layout(viewer, width: 393)
        XCTAssertEqual(reacted.height, 60)
        XCTAssertEqual(plain.height, 50)
        XCTAssertEqual(reacted.reaction?.maxX, 393 - 14)
        XCTAssertNil(plain.reaction)
        XCTAssertNotNil(reacted.subtitle)
        XCTAssertNil(plain.subtitle)
    }
}
#endif
