import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact places for home's stories in the header, after Telegram's
/// `StoryPeerListComponent` and `ChatListNavigationBar`: a 390 wide header
/// with a 70 × 20 title centred at 73, between a logo ending at 60 and a
/// pill starting at 284.
final class StoriesHeaderLayoutTests: XCTestCase {
    private typealias State = StoriesHeaderLayout.State

    private func layout(_ state: State, count: Int = 3, start: Int = 0, scroll: CGFloat = 0, width: CGFloat = 390) -> StoriesHeaderLayout {
        StoriesHeaderLayout(.init(
            width: width, title: rect(160, 63, 70, 20), bandMinX: 60, bandMaxX: 284,
            count: count, collapseStart: start, scroll: scroll, state: state
        ))
    }

    private func assertPoint(_ actual: CGPoint, _ x: CGFloat, _ y: CGFloat, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.x, x, accuracy: 0.001, "x", file: file, line: line)
        XCTAssertEqual(actual.y, y, accuracy: 0.001, "y", file: file, line: line)
    }

    /// Open at rest: three circles spread about the middle 66 under the
    /// title's middle, full size, the title centred alone.
    func testOpenAtRest() {
        let open = layout(.target(unlocked: true, pull: 96))
        XCTAssertEqual(open.row, rect(0, 97, 390, 98))
        XCTAssertEqual(open.rowItems, [rect(59, 12, 60, 77), rect(165, 12, 60, 77), rect(271, 12, 60, 77)])
        assertPoint(open.items[0].center, 89, 139)
        assertPoint(open.items[1].center, 195, 139)
        assertPoint(open.items[2].center, 301, 139)
        XCTAssertEqual(open.items.map(\.scale), [1, 1, 1])
        XCTAssertEqual(open.items.map(\.alpha), [1, 1, 1])
        XCTAssertEqual(open.items.map(\.neighbor), [nil, nil, nil])
        XCTAssertEqual(open.titleX, 160)
        XCTAssertNil(open.button)
        // The first is drawn over the rest.
        XCTAssertGreaterThan(open.items[0].zPosition, open.items[1].zPosition)
    }

    /// Closed: 24 pt avatars 14 apart before the title, the group centred
    /// as far as the pill allows, each cut around the one before it.
    func testClosedIntoTheTitle() {
        let closed = layout(.target(unlocked: false, pull: 0))
        assertPoint(closed.items[0].center, 142, 73)
        assertPoint(closed.items[1].center, 156, 73)
        assertPoint(closed.items[2].center, 170, 73)
        for item in closed.items { XCTAssertEqual(item.scale, 24.0 / 52, accuracy: 0.0001) }
        XCTAssertEqual(closed.titleX, 190)
        XCTAssertEqual(closed.button, rect(60, 51, 224, 44))
        XCTAssertEqual(closed.tooltipTip, CGPoint(x: 157, y: 103))
        XCTAssertNil(closed.items[0].neighbor)
        assertPoint(closed.items[1].neighbor!, -14, 0)
        assertPoint(closed.items[2].neighbor!, -14, 0)
        XCTAssertEqual(closed.collapsedCount, 3)
    }

    /// Only three close; the rest fade into the third.
    func testOnlyThreeClose() {
        let closed = layout(.target(unlocked: false, pull: 0), count: 5)
        XCTAssertEqual(closed.rowItems.map(\.minX), [23, 94, 165, 236, 307])
        assertPoint(closed.items[3].center, 170, 73)
        XCTAssertEqual(closed.items[3].alpha, 0)
        XCTAssertFalse(closed.items[4].collapses)
        XCTAssertEqual(closed.titleX, 190)
    }

    /// Pulled half way while closed: the avatars grow toward 28 and lean
    /// out right and down, the title 6 to the right.
    func testPulledWhileClosed() {
        let pulled = layout(.target(unlocked: false, pull: 48))
        assertPoint(pulled.items[0].center, 141, 75.5)
        assertPoint(pulled.items[1].center, 160, 80.5)
        assertPoint(pulled.items[2].center, 179, 85.5)
        XCTAssertEqual(pulled.items[0].scale, 0.5, accuracy: 0.0001)
        XCTAssertEqual(pulled.titleX, 196)
        assertPoint(pulled.items[1].neighbor!, -19, -5)
    }

    /// Half open: half way from the title to the row, the avatars closing
    /// up as they go, the title half way back to the middle.
    func testHalfOpen() {
        let half = layout(.target(unlocked: true, pull: 48))
        assertPoint(half.items[0].center, 115.5, 106)
        assertPoint(half.items[1].center, 172, 106)
        assertPoint(half.items[2].center, 228.5, 106)
        XCTAssertEqual(half.items[0].scale, (24.0 / 52 + 1) / 2, accuracy: 0.0001)
        XCTAssertEqual(half.titleX, 175)
        XCTAssertNil(half.items[1].neighbor)
        XCTAssertNil(half.button)
    }

    /// Past the open rest the circles follow the list down and grow.
    func testPulledPastOpen() {
        let over = layout(.target(unlocked: true, pull: 144))
        assertPoint(over.items[0].center, 89, 159.75)
        XCTAssertEqual(over.items[0].scale, 1.05, accuracy: 0.0001)
    }

    /// The person's own circle, first, stays out of the title.
    func testMyOwnStaysOutOfTheTitle() {
        let closed = layout(.target(unlocked: false, pull: 0), count: 3, start: 1)
        XCTAssertFalse(closed.items[0].collapses)
        XCTAssertEqual(closed.items[0].alpha, 0)
        XCTAssertEqual(closed.collapsedCount, 2)
        // Two avatars: 38 wide, then 8, then the title.
        XCTAssertEqual(closed.titleX, 183)
        let alone = layout(.target(unlocked: false, pull: 0), count: 1, start: 1)
        XCTAssertNil(alone.titleX)
        XCTAssertNil(alone.button)
    }

    /// Scrolled sideways, what closes is what the row shows from its left.
    func testScrolledRowClosesWhatShows() {
        let closed = layout(.target(unlocked: false, pull: 0), count: 10, scroll: 150)
        // 74 apart from 12: the third starts at 160, the first to show.
        XCTAssertEqual(closed.contentWidth, 12 + 600 + 9 * 14 + 12)
        XCTAssertFalse(closed.items[1].collapses)
        XCTAssertTrue(closed.items[2].collapses)
        XCTAssertTrue(closed.items[4].collapses)
        XCTAssertFalse(closed.items[5].collapses)
        assertPoint(closed.items[2].center, 142, 73)
    }

    /// Scrolled past the person's own, or to the row's end, three still
    /// close: the person's never, the last three at most.
    func testWhatClosesAfterScrolling() {
        let past = layout(.target(unlocked: false, pull: 0), count: 10, start: 1, scroll: 150)
        XCTAssertEqual(past.items.indices.filter { past.items[$0].collapses }, [2, 3, 4])
        let mine = layout(.target(unlocked: false, pull: 0), count: 10, start: 1)
        XCTAssertEqual(mine.items.indices.filter { mine.items[$0].collapses }, [1, 2, 3])
        let end = layout(.target(unlocked: false, pull: 0), count: 10, scroll: 600)
        XCTAssertEqual(end.items.indices.filter { end.items[$0].collapses }, [7, 8, 9])
        assertPoint(end.items[7].center, 142, 73)
        XCTAssertNil(end.items[7].neighbor)
        XCTAssertNotNil(end.items[8].neighbor)
    }

    /// A long title balances in the band between the buttons.
    func testALongTitleBalancesBetweenTheButtons() {
        XCTAssertEqual(StoriesHeaderLayout.contentOrigin(width: 390, content: 130, minX: 60, maxX: 284), 130)
        // Clear of both by 40 or more: centred.
        XCTAssertEqual(StoriesHeaderLayout.contentOrigin(width: 390, content: 100, minX: 60, maxX: 284), 145)
        // Touching the right end: in the band's middle, 4 in from each end;
        // 10 from it, half way there on the smooth step.
        XCTAssertEqual(StoriesHeaderLayout.contentOrigin(width: 390, content: 170, minX: 60, maxX: 284), (64 + 280 - 170) / 2, accuracy: 0.0001)
        XCTAssertEqual(StoriesHeaderLayout.contentOrigin(width: 390, content: 150, minX: 60, maxX: 284), 108.5, accuracy: 0.0001)
    }

    /// Opens past 65, closes under 61, keeps what it was between.
    func testOpensAndClosesWithRoomBetween() {
        XCTAssertTrue(StoriesHeaderLayout.unlocked(false, pull: 65))
        XCTAssertFalse(StoriesHeaderLayout.unlocked(false, pull: 64))
        XCTAssertTrue(StoriesHeaderLayout.unlocked(true, pull: 62))
        XCTAssertFalse(StoriesHeaderLayout.unlocked(true, pull: 61))
        XCTAssertEqual(State.target(unlocked: true, pull: 48), State(min: 0, max: 0.5, side: 1))
        XCTAssertEqual(State.target(unlocked: false, pull: -20), State(min: 0, max: 0, side: 0))
    }

    func testRingsKeepTheirWidthWhenSmall() {
        XCTAssertEqual(StoriesHeaderLayout.ringWidth(2.33, scale: 1), 2.33)
        XCTAssertEqual(StoriesHeaderLayout.ringWidth(2.33, scale: 0), 4.3)
        XCTAssertEqual(StoriesHeaderLayout.ringWidth(1.33, scale: 0.5), 2.815, accuracy: 0.0001)
    }

    /// The change between open and closed runs on the keyboard's spring,
    /// 0.35 s opening and 0.25 s closing, from what was drawn.
    func testMotion() {
        let from = State(min: 0, max: 0, side: 0)
        let opening = StoriesHeaderMotion(from: from, start: 10, opening: true)
        XCTAssertEqual(opening.duration, 0.35)
        XCTAssertEqual(StoriesHeaderMotion(from: from, start: 10, opening: false).duration, 0.25)
        XCTAssertEqual(opening.progress(at: 10), 0)
        XCTAssertEqual(opening.progress(at: 10.35), 1)
        // Quick at first, settling slowly.
        XCTAssertGreaterThan(opening.progress(at: 10.0875), 0.6)
        let target = State(min: 0, max: 1, side: 1)
        XCTAssertEqual(opening.state(toward: target, at: 11), target)
        XCTAssertFalse(opening.isFinished(at: 10.2))
        XCTAssertTrue(opening.isFinished(at: 10.35))
        XCTAssertEqual(StoriesHeaderMotion.curve(0.5), 0.966, accuracy: 0.001)
    }

    /// Let go of part way into the row's room, the list rests at the row as
    /// it will be: a glide past 61 up has closed it, so a short flick up puts
    /// it away and a nudge leaves it open; closed, it rests closed.
    func testRestingWhereTheRowWillBe() {
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: 80), 96)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: 62), 96)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: 61), 0)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: 20), 0)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: false, glide: 80), 0)
        // Outside the room, the glide is left alone.
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: -300), -300)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: true, glide: 96), 96)
        XCTAssertEqual(StoriesHeaderLayout.resting(unlocked: false, glide: 0), 0)
    }
}
