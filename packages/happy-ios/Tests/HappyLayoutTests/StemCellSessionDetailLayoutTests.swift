import CoreGraphics
@testable import HappyLayout
import XCTest

/// Exact frames for a conversation's detail on a 402-wide phone.
final class StemCellSessionDetailLayoutTests: XCTestCase {
    private func layout(family: CGFloat? = 100, running: Int = 2, completed: Int = 3, open: Bool = false) -> StemCellSessionDetailLayout {
        StemCellSessionDetailLayout(width: 402, nameHeight: 34, subtitleHeight: 22, tiles: 6, actions: 1, family: family, running: running, completed: completed, countWidth: 10, open: open)
    }

    /// The mark centred, the name and its line under it, then six tiles two
    /// to a row on the cards' edges.
    func testTheHeroAndTheTiles() {
        let detail = layout()
        XCTAssertEqual(detail.mark, CGRect(x: 157, y: 12, width: 88, height: 88))
        XCTAssertEqual(detail.name, CGRect(x: 24, y: 114, width: 354, height: 34))
        XCTAssertEqual(detail.subtitle, CGRect(x: 24, y: 150, width: 354, height: 22))
        XCTAssertEqual(detail.tiles.map(\.frame), [
            CGRect(x: 16, y: 196, width: 180, height: 80), CGRect(x: 206, y: 196, width: 180, height: 80),
            CGRect(x: 16, y: 286, width: 180, height: 80), CGRect(x: 206, y: 286, width: 180, height: 80),
            CGRect(x: 16, y: 376, width: 180, height: 80), CGRect(x: 206, y: 376, width: 180, height: 80),
        ])
        XCTAssertEqual(detail.tiles[0].value, CGRect(x: 16, y: 14, width: 148, height: 30))
        XCTAssertEqual(detail.tiles[0].label, CGRect(x: 16, y: 44, width: 148, height: 18))
        XCTAssertEqual(detail.tiles[5].frame.maxX, 402 - 16)
    }

    /// Rename is a Settings row; Family's heading sits a card's text in.
    func testTheActionsThenTheFamily() {
        let detail = layout()
        XCTAssertEqual(detail.actions.frame, CGRect(x: 16, y: 480, width: 370, height: 52))
        XCTAssertEqual(detail.actions.rows[0].icon, CGRect(x: 16, y: 11, width: 30, height: 30))
        XCTAssertEqual(detail.actions.rows[0].title, CGRect(x: 62, y: 15, width: 292, height: 22))
        XCTAssertNil(detail.actions.rows[0].separator)
        XCTAssertEqual(detail.familyHeading, CGRect(x: 32, y: 556, width: 338, height: 18))
        XCTAssertEqual(detail.family, CGRect(x: 16, y: 582, width: 370, height: 100))
    }

    /// What is at work in its own card, two lines to a row; what settled
    /// folded under one row with its count, opening in the same card.
    func testTheActivity() {
        let closed = layout()
        XCTAssertEqual(closed.activityHeading, CGRect(x: 32, y: 706, width: 338, height: 18))
        let running = try! XCTUnwrap(closed.running)
        XCTAssertEqual(running.frame, CGRect(x: 16, y: 732, width: 370, height: 124))
        XCTAssertEqual(running.rows[0], .init(
            box: CGRect(x: 0, y: 0, width: 370, height: 62), icon: CGRect(x: 16, y: 16, width: 30, height: 30),
            title: CGRect(x: 62, y: 10, width: 292, height: 22), meta: CGRect(x: 62, y: 32, width: 292, height: 18),
            separator: CGRect(x: 62, y: 62 - 1.0 / 3, width: 308, height: 1.0 / 3)
        ))
        XCTAssertNil(running.rows[1].separator)
        let completed = try! XCTUnwrap(closed.completed)
        XCTAssertEqual(completed.frame, CGRect(x: 16, y: 880, width: 370, height: 52))
        XCTAssertEqual(completed.disclosure?.chevron, CGRect(x: 346, y: 19, width: 8, height: 14))
        XCTAssertEqual(completed.disclosure?.value, CGRect(x: 328, y: 15, width: 10, height: 22))
        XCTAssertEqual(completed.disclosure?.title, CGRect(x: 62, y: 15, width: 258, height: 22))
        XCTAssertNil(completed.disclosure?.separator)
        XCTAssertEqual(completed.rows, [])
        XCTAssertNil(closed.empty)
        XCTAssertEqual(closed.contentHeight, 964)

        let open = layout(open: true)
        XCTAssertEqual(open.completed?.frame, CGRect(x: 16, y: 880, width: 370, height: 238))
        XCTAssertEqual(open.completed?.rows.map(\.box.minY), [52, 114, 176])
        XCTAssertEqual(open.completed?.disclosure?.separator, CGRect(x: 62, y: 52 - 1.0 / 3, width: 308, height: 1.0 / 3))
        XCTAssertEqual(open.contentHeight, 964 + 186)
    }

    /// Nothing at work or settled: one quiet line. No family: Activity moves up.
    func testQuietAndUnfiled() {
        let quiet = layout(running: 0, completed: 0)
        XCTAssertNil(quiet.running)
        XCTAssertNil(quiet.completed)
        XCTAssertEqual(quiet.empty, CGRect(x: 16, y: 732, width: 370, height: 52))
        XCTAssertEqual(quiet.contentHeight, 816)
        let unfiled = layout(family: nil, running: 0, completed: 0)
        XCTAssertNil(unfiled.familyHeading)
        XCTAssertNil(unfiled.family)
        XCTAssertEqual(unfiled.activityHeading.minY, 556)
    }
}
