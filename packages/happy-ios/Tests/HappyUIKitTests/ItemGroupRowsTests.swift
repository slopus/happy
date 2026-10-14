#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

/// A view that counts the times it is put in or taken out of a superview.
private final class Moves: UIView {
    var moves = 0

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        moves += 1
    }
}

/// An ItemGroupView given its rows again (Settings › Agents patching its
/// computers): the rows it still has stay in the card, the others leave
/// or join it, and every row but the last has its divider.
@MainActor
final class ItemGroupRowsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testKeptRowsStayInTheCard() {
        let a = Moves(), b = Moves(), c = Moves(), d = Moves()
        let group = ItemGroupView(rows: [a, b, c])
        XCTAssertEqual([a, b, c].map(\.moves), [1, 1, 1])

        group.rows = [c, a, d]
        XCTAssertEqual([a, c].map(\.moves), [1, 1], "kept, never taken out and put back")
        XCTAssertNil(b.superview)
        XCTAssertEqual(b.moves, 2)
        XCTAssertTrue(d.superview === group.card)
        XCTAssertEqual(d.moves, 1)
        XCTAssertTrue(a.superview === group.card)
        XCTAssertTrue(c.superview === group.card)
    }

    func testEveryRowButTheLastHasItsDivider() {
        let one = ItemRowView(title: "One")
        let two = ItemRowView(title: "Two")
        let three = ItemRowView(title: "Three")
        let group = ItemGroupView(rows: [one, two, three])
        XCTAssertEqual([one, two, three].map(\.showsDivider), [true, true, false])

        group.rows = [three, one]
        XCTAssertEqual([three, one].map(\.showsDivider), [true, false])
        XCTAssertFalse(three.dividerView.isHidden)
        XCTAssertTrue(one.dividerView.isHidden)
        XCTAssertNil(two.superview)

        group.rows = [three, one, two]
        XCTAssertEqual([three, one, two].map(\.showsDivider), [true, true, false])
        XCTAssertTrue(two.superview === group.card)
    }
}
#endif
