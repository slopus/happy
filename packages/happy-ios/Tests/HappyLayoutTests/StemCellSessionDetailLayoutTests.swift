import CoreGraphics
@testable import HappyLayout
import XCTest

/// Exact frames for a conversation's detail on a 402-wide phone.
final class StemCellSessionDetailLayoutTests: XCTestCase {
    typealias Layout = StemCellSessionDetailLayout

    private func layout(
        media: Layout.Shown? = .init(count: 5, more: true), links: Layout.Shown? = .init(count: 2, more: false),
        family: CGFloat? = 100, running: Int = 2, completed: Int = 3, open: Bool = false
    ) -> Layout {
        Layout(width: 402, nameHeight: 34, subtitleHeight: 22, tiles: 3, actions: 1, media: media, links: links, family: family, running: running, completed: completed, countWidth: 10, open: open)
    }

    /// The mark centred, the name and its line under it, then Model and
    /// Effort side by side, Started under them the row's width.
    func testTheHeroAndTheTiles() {
        let detail = layout()
        XCTAssertEqual(detail.mark, CGRect(x: 157, y: 12, width: 88, height: 88))
        XCTAssertEqual(detail.name, CGRect(x: 24, y: 114, width: 354, height: 34))
        XCTAssertEqual(detail.subtitle, CGRect(x: 24, y: 150, width: 354, height: 22))
        XCTAssertEqual(detail.tiles.map(\.frame), [
            CGRect(x: 16, y: 196, width: 180, height: 80), CGRect(x: 206, y: 196, width: 180, height: 80),
            CGRect(x: 16, y: 286, width: 370, height: 80),
        ])
        XCTAssertEqual(detail.tiles[0].value, CGRect(x: 16, y: 14, width: 148, height: 30))
        XCTAssertEqual(detail.tiles[0].label, CGRect(x: 16, y: 44, width: 148, height: 18))
        XCTAssertEqual(detail.tiles[2].value, CGRect(x: 16, y: 14, width: 338, height: 30))
        XCTAssertEqual(detail.tiles[1].frame.maxX, 402 - 16)
        XCTAssertEqual(detail.actions.frame, CGRect(x: 16, y: 390, width: 370, height: 52))
    }

    /// Media first: three square cells to a row 2 apart, the last column
    /// on the card's edge, "Show more" under them in the same card.
    func testTheMediaGrid() {
        let detail = layout()
        XCTAssertEqual(detail.mediaHeading, CGRect(x: 32, y: 466, width: 338, height: 18))
        let media = try! XCTUnwrap(detail.media)
        XCTAssertEqual(media.frame, CGRect(x: 16, y: 492, width: 370, height: 298))
        XCTAssertEqual(media.cells, [
            CGRect(x: 0, y: 0, width: 122, height: 122), CGRect(x: 124, y: 0, width: 122, height: 122), CGRect(x: 248, y: 0, width: 122, height: 122),
            CGRect(x: 0, y: 124, width: 122, height: 122), CGRect(x: 124, y: 124, width: 122, height: 122),
        ])
        XCTAssertEqual(media.more?.box, CGRect(x: 0, y: 246, width: 370, height: 52))
        XCTAssertNil(media.more?.separator)
        XCTAssertNil(media.more?.icon)
        // All of it shown: no "Show more".
        let all = try! XCTUnwrap(layout(media: .init(count: 3, more: false)).media)
        XCTAssertEqual(all.frame.height, 122)
        XCTAssertNil(all.more)
    }

    /// Links under the media, a row each, a title over its host; with more
    /// to show, the last keeps its hairline over "Show more".
    func testTheLinks() {
        let detail = layout()
        XCTAssertEqual(detail.linksHeading, CGRect(x: 32, y: 814, width: 338, height: 18))
        let links = try! XCTUnwrap(detail.links)
        XCTAssertEqual(links.frame, CGRect(x: 16, y: 840, width: 370, height: 124))
        XCTAssertEqual(links.rows[0], .init(
            box: CGRect(x: 0, y: 0, width: 370, height: 62), icon: CGRect(x: 16, y: 16, width: 30, height: 30),
            title: CGRect(x: 62, y: 10, width: 292, height: 22), meta: CGRect(x: 62, y: 32, width: 292, height: 18),
            separator: CGRect(x: 62, y: 62 - 1.0 / 3, width: 308, height: 1.0 / 3)
        ))
        XCTAssertNil(links.rows[1].separator)
        XCTAssertNil(links.more)
        let more = try! XCTUnwrap(layout(links: .init(count: 2, more: true)).links)
        XCTAssertNotNil(more.rows[1].separator)
        XCTAssertEqual(more.more?.box, CGRect(x: 0, y: 124, width: 370, height: 52))
        XCTAssertEqual(more.frame.height, 176)
    }

    /// Then the family, then what is at work and what settled, folded
    /// under one row with its count, opening in the same card.
    func testTheFamilyThenTheActivity() {
        let closed = layout()
        XCTAssertEqual(closed.familyHeading, CGRect(x: 32, y: 988, width: 338, height: 18))
        XCTAssertEqual(closed.family, CGRect(x: 16, y: 1014, width: 370, height: 100))
        XCTAssertEqual(closed.activityHeading, CGRect(x: 32, y: 1138, width: 338, height: 18))
        XCTAssertEqual(closed.running?.frame, CGRect(x: 16, y: 1164, width: 370, height: 124))
        XCTAssertNil(closed.running?.rows[1].separator)
        let completed = try! XCTUnwrap(closed.completed)
        XCTAssertEqual(completed.frame, CGRect(x: 16, y: 1312, width: 370, height: 52))
        XCTAssertEqual(completed.disclosure?.chevron, CGRect(x: 346, y: 19, width: 8, height: 14))
        XCTAssertEqual(completed.disclosure?.value, CGRect(x: 328, y: 15, width: 10, height: 22))
        XCTAssertNil(completed.disclosure?.separator)
        XCTAssertEqual(completed.rows, [])
        XCTAssertEqual(closed.contentHeight, 1396)

        let open = layout(open: true)
        XCTAssertEqual(open.completed?.frame, CGRect(x: 16, y: 1312, width: 370, height: 238))
        XCTAssertEqual(open.completed?.rows.map(\.box.minY), [52, 114, 176])
        XCTAssertEqual(open.completed?.disclosure?.separator, CGRect(x: 62, y: 52 - 1.0 / 3, width: 308, height: 1.0 / 3))
        XCTAssertEqual(open.contentHeight, 1396 + 186)
    }

    /// Nothing shared, no family, nothing at work or settled: none of
    /// those sections, the page ending under the actions.
    func testEmptySectionsAreNotDrawn() {
        let bare = layout(media: nil, links: .init(count: 0, more: true), family: nil, running: 0, completed: 0)
        XCTAssertNil(bare.mediaHeading)
        XCTAssertNil(bare.media)
        XCTAssertNil(bare.linksHeading)
        XCTAssertNil(bare.links)
        XCTAssertNil(bare.familyHeading)
        XCTAssertNil(bare.activityHeading)
        XCTAssertNil(bare.running)
        XCTAssertNil(bare.completed)
        XCTAssertEqual(bare.contentHeight, 442 + 32)
        // Only links: they follow the actions.
        XCTAssertEqual(layout(media: nil, family: nil, running: 0, completed: 0).linksHeading?.minY, 466)
    }
}
