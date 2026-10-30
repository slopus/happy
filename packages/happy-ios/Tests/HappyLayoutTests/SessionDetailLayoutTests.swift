import CoreGraphics
@testable import HappyLayout
import XCTest

/// Exact frames for a conversation's detail on a 402-wide phone.
final class SessionDetailLayoutTests: XCTestCase {
    typealias Layout = SessionDetailLayout

    private func layout(
        nameWidth: CGFloat? = 180, renames: Bool = true,
        media: Layout.Shown? = .init(count: 5, more: true), links: Layout.Shown? = .init(count: 2, more: false),
        family: CGFloat? = 100, running: Int = 2, completed: Int = 3, open: Bool = false
    ) -> Layout {
        Layout(width: 402, nameHeight: 34, nameWidth: nameWidth, renames: renames, subtitleHeight: 22, tiles: 3, media: media, links: links, family: family, running: running, completed: completed, countWidth: 10, open: open)
    }

    /// The mark centred, the name centred under it with the pencil just
    /// after it, its line under them.
    func testTheHero() {
        let detail = layout()
        XCTAssertEqual(detail.mark, CGRect(x: 157, y: 12, width: 88, height: 88))
        XCTAssertEqual(detail.name, CGRect(x: 111, y: 114, width: 180, height: 34))
        XCTAssertEqual(detail.name.midX, detail.mark.midX)
        XCTAssertEqual(detail.pencil, CGRect(x: 297, y: 121, width: 20, height: 20))
        XCTAssertEqual(detail.pencilTouch, CGRect(x: 285, y: 109, width: 44, height: 44))
        // Renamed in a field the row's width, where the name stands.
        XCTAssertEqual(detail.field, CGRect(x: 24, y: 114, width: 354, height: 34))
        XCTAssertEqual(detail.subtitle, CGRect(x: 24, y: 150, width: 354, height: 22))
    }

    /// A long name keeps the pencil's room on both sides and stays centred;
    /// one that can't be renamed has no pencil and the whole row.
    func testALongNameAndNoPencil() {
        let long = layout(nameWidth: 500)
        XCTAssertEqual(long.name, CGRect(x: 50, y: 114, width: 302, height: 34))
        XCTAssertEqual(long.pencil?.minX, 358)
        XCTAssertEqual(long.pencil.map { $0.maxX + 24 }, 402)
        let fixed = layout(nameWidth: 500, renames: false)
        XCTAssertEqual(fixed.name, CGRect(x: 24, y: 114, width: 354, height: 34))
        XCTAssertNil(fixed.pencil)
        XCTAssertNil(fixed.pencilTouch)
        XCTAssertEqual(layout(nameWidth: nil, renames: false).name, CGRect(x: 24, y: 114, width: 354, height: 34))
    }

    /// The family first, right under the name; then Model and Effort side
    /// by side, Started under them the row's width.
    func testTheFamilyThenTheTiles() {
        let detail = layout()
        XCTAssertEqual(detail.familyHeading, CGRect(x: 32, y: 196, width: 338, height: 18))
        XCTAssertEqual(detail.family, CGRect(x: 16, y: 222, width: 370, height: 100))
        XCTAssertEqual(detail.tiles.map(\.frame), [
            CGRect(x: 16, y: 346, width: 180, height: 80), CGRect(x: 206, y: 346, width: 180, height: 80),
            CGRect(x: 16, y: 436, width: 370, height: 80),
        ])
        XCTAssertEqual(detail.tiles[0].value, CGRect(x: 16, y: 14, width: 148, height: 30))
        XCTAssertEqual(detail.tiles[0].label, CGRect(x: 16, y: 44, width: 148, height: 18))
        XCTAssertEqual(detail.tiles[2].value, CGRect(x: 16, y: 14, width: 338, height: 30))
        XCTAssertEqual(detail.tiles[1].frame.maxX, 402 - 16)
        // No family: the tiles take its place.
        XCTAssertEqual(layout(family: nil).tiles.first?.frame.minY, 196)
    }

    /// Media after the tiles: three square cells to a row 2 apart, the last
    /// column on the card's edge, "Show more" under them in the same card.
    func testTheMediaGrid() {
        let detail = layout()
        XCTAssertEqual(detail.mediaHeading, CGRect(x: 32, y: 540, width: 338, height: 18))
        let media = try! XCTUnwrap(detail.media)
        XCTAssertEqual(media.frame, CGRect(x: 16, y: 566, width: 370, height: 298))
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
        XCTAssertEqual(detail.linksHeading, CGRect(x: 32, y: 888, width: 338, height: 18))
        let links = try! XCTUnwrap(detail.links)
        XCTAssertEqual(links.frame, CGRect(x: 16, y: 914, width: 370, height: 124))
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

    /// Last, what is at work and what settled, folded under one row with
    /// its count, opening in the same card.
    func testTheActivity() {
        let closed = layout()
        XCTAssertEqual(closed.activityHeading, CGRect(x: 32, y: 1062, width: 338, height: 18))
        XCTAssertEqual(closed.running?.frame, CGRect(x: 16, y: 1088, width: 370, height: 124))
        XCTAssertNil(closed.running?.rows[1].separator)
        let completed = try! XCTUnwrap(closed.completed)
        XCTAssertEqual(completed.frame, CGRect(x: 16, y: 1236, width: 370, height: 52))
        XCTAssertEqual(completed.disclosure?.chevron, CGRect(x: 346, y: 19, width: 8, height: 14))
        XCTAssertEqual(completed.disclosure?.value, CGRect(x: 328, y: 15, width: 10, height: 22))
        XCTAssertNil(completed.disclosure?.separator)
        XCTAssertEqual(completed.rows, [])
        XCTAssertEqual(closed.contentHeight, 1320)

        let open = layout(open: true)
        XCTAssertEqual(open.completed?.frame, CGRect(x: 16, y: 1236, width: 370, height: 238))
        XCTAssertEqual(open.completed?.rows.map(\.box.minY), [52, 114, 176])
        XCTAssertEqual(open.completed?.disclosure?.separator, CGRect(x: 62, y: 52 - 1.0 / 3, width: 308, height: 1.0 / 3))
        XCTAssertEqual(open.contentHeight, 1320 + 186)
    }

    /// No family, nothing shared, nothing at work or settled: none of
    /// those sections, the page ending under the tiles.
    func testEmptySectionsAreNotDrawn() {
        let bare = layout(media: nil, links: .init(count: 0, more: true), family: nil, running: 0, completed: 0)
        XCTAssertNil(bare.familyHeading)
        XCTAssertNil(bare.family)
        XCTAssertNil(bare.mediaHeading)
        XCTAssertNil(bare.media)
        XCTAssertNil(bare.linksHeading)
        XCTAssertNil(bare.links)
        XCTAssertNil(bare.activityHeading)
        XCTAssertNil(bare.running)
        XCTAssertNil(bare.completed)
        XCTAssertEqual(bare.contentHeight, 366 + 32)
        // Only links: they follow the tiles.
        XCTAssertEqual(layout(media: nil, family: nil, running: 0, completed: 0).linksHeading?.minY, 390)
    }

    /// Past the top or past the bottom, by any amount; a page shorter than
    /// the screen ends at its top both ways.
    func testStretched() {
        func stretched(_ offset: CGFloat, content: CGFloat = 1320) -> Bool {
            Layout.stretched(offset: offset, top: 114, bottom: 34, contentHeight: content, viewport: 874)
        }
        XCTAssertTrue(stretched(-114.5))
        XCTAssertFalse(stretched(-114))
        XCTAssertFalse(stretched(200))
        XCTAssertFalse(stretched(480))
        XCTAssertTrue(stretched(480.5))
        XCTAssertFalse(stretched(-114, content: 300))
        XCTAssertTrue(stretched(-113, content: 300))
    }

    /// Held while stretched and applied once let go; laid out back at the
    /// size it has, nothing stale is left to apply.
    func testHeldSize() {
        let base = CGSize(width: 402, height: 1320)
        let grown = CGSize(width: 402, height: 1506)
        var size = Layout.HeldSize()
        XCTAssertEqual(size.laidOut(grown, current: base, holding: false), grown)
        XCTAssertNil(size.held)
        XCTAssertNil(size.laidOut(grown, current: base, holding: true))
        XCTAssertEqual(size.held, grown)
        XCTAssertNil(size.release(current: base, holding: true))
        XCTAssertEqual(size.release(current: base, holding: false), grown)
        XCTAssertNil(size.held)
        XCTAssertNil(size.release(current: grown, holding: false))
        // Grown and back again mid-stretch.
        XCTAssertNil(size.laidOut(grown, current: base, holding: true))
        XCTAssertNil(size.laidOut(base, current: base, holding: true))
        XCTAssertNil(size.held)
        XCTAssertNil(size.release(current: base, holding: false))
        // A later layout at rest wins over the held size.
        let later = CGSize(width: 402, height: 1400)
        XCTAssertNil(size.laidOut(grown, current: base, holding: true))
        XCTAssertEqual(size.laidOut(later, current: base, holding: false), later)
        XCTAssertNil(size.held)
    }
}
