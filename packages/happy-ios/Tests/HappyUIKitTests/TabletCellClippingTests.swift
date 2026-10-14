#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The grouped sidebar's fixed-height rows at the largest text size: a
/// chat's title and dot are cut at its own 56 row (RN's Swipeable,
/// `overflow: 'hidden'`), an archived card's content at the card's edge
/// (`sessionItemContainer`'s `overflow: 'hidden'`); what cuts them takes
/// no touches, so a tap on the text still reaches the cell.
@MainActor
final class TabletCellClippingTests: XCTestCase {
    private let category = UIContentSizeCategory.accessibilityExtraExtraExtraLarge
    private let scale: CGFloat = 3
    private let width: CGFloat = 320

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// `cell` at the largest text size, laid out at its own height.
    private func laidOut(_ cell: UITableViewCell) {
        cell.traitOverrides.displayScale = scale
        cell.traitOverrides.preferredContentSizeCategory = category
        cell.updateTraitsIfNeeded()
        cell.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        cell.layoutIfNeeded()
        let height = cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        cell.frame = CGRect(x: 0, y: 0, width: width, height: height)
        cell.layoutIfNeeded()
    }

    /// `label` draws its style at the largest size.
    private func assertScaled(_ label: StyledLabel, _ message: String, line: UInt = #line) {
        XCTAssertEqual(label.renderedStyle.size, label.style.size * TextScale(TextSizeCategory(category)).multiplier, message, line: line)
    }

    /// A tap on the middle of `view` lands in the cell, on nothing of
    /// `passive`'s: the text, the glyphs and what cuts them take no touches.
    private func assertTapReachesTheCell(_ cell: UITableViewCell, on view: UIView, passive: [UIView], _ message: String, line: UInt = #line) {
        let point = view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: cell)
        let hit = cell.hitTest(point, with: nil)
        XCTAssertTrue(hit?.isDescendant(of: cell) ?? false, "\(message): \(String(describing: hit))", line: line)
        for quiet in passive {
            XCTAssertFalse(hit?.isDescendant(of: quiet) ?? true, "\(message): \(String(describing: hit))", line: line)
        }
    }

    func testAChatsTitleAndDotAreCutAtItsOwnRow() throws {
        let cell = TabletChatCell(style: .default, reuseIdentifier: nil)
        cell.configure(TabletChatRow(
            id: "c",
            title: "A chat whose title runs to two lines at the largest size",
            connected: true,
            indicator: .dot(.working, pulsing: false),
            showsBorder: true,
            first: true,
            last: false,
            projectEnd: false
        ))
        laidOut(cell)
        assertScaled(cell.titleLabel, "title")

        let clip = try XCTUnwrap(cell.titleLabel.superview)
        XCTAssertFalse(clip === cell.contentView, "the title is in a box of its own")
        XCTAssertTrue(clip.superview === cell.contentView)
        XCTAssertTrue(cell.dot.superview === clip, "the dot too")
        XCTAssertTrue(clip.clipsToBounds)
        XCTAssertFalse(clip.isUserInteractionEnabled)

        let layout = TabletChatRowLayout(.init(
            width: cell.contentView.bounds.width,
            hairline: cell.hairline,
            title: cell.titleLabel.measurable,
            first: true,
            last: false,
            projectEnd: false,
            showsBorder: true
        ))
        XCTAssertEqual(layout.row.height, TabletChatRowLayout.Metrics.rowHeight)
        // The box is the 56 row, not the card around it.
        assertSamePixels(clip.frame, PixelGrid.snap(layout.row, scale: scale), scale: scale, "the row's box")
        func inRow(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: -layout.row.minX, dy: -layout.row.minY) }
        assertSamePixels(cell.titleLabel.frame, PixelGrid.snap(inRow(layout.title), scale: scale), scale: scale, "title")
        assertSamePixels(cell.dot.frame, PixelGrid.snap(inRow(layout.dot), scale: scale), scale: scale, "dot")
        // Taller than the row at this size, so the box cuts it.
        XCTAssertGreaterThan(cell.titleLabel.frame.height, clip.bounds.height)
        XCTAssertFalse(clip.bounds.contains(cell.titleLabel.frame))

        assertTapReachesTheCell(cell, on: cell.titleLabel, passive: [clip], "on the title")
        assertTapReachesTheCell(cell, on: cell.dot, passive: [clip], "on the dot")
    }

    func testAnArchivedCardsContentIsCutAtTheCard() throws {
        let cell = TabletArchivedCell(style: .default, reuseIdentifier: nil)
        cell.titleLabel.string = "An archived chat"
        cell.subtitleLabel.string = "~/happy"
        cell.statusLabel.string = "Last seen 3 days ago"
        cell.providerIcon.isHidden = true
        laidOut(cell)
        for label in [cell.titleLabel, cell.subtitleLabel, cell.statusLabel] { assertScaled(label, label.string) }

        let card = cell.card
        XCTAssertTrue(card.superview === cell.contentView)
        XCTAssertTrue(card.clipsToBounds)
        let content: [(String, UIView)] = [
            ("avatar", cell.avatar), ("title", cell.titleLabel), ("provider", cell.providerIcon),
            ("subtitle", cell.subtitleLabel), ("dot", cell.dot), ("status", cell.statusLabel),
        ]
        for (name, view) in content {
            XCTAssertTrue(view.superview === card, "\(name) is in the card")
            XCTAssertFalse(view.isUserInteractionEnabled, name)
        }

        let layout = TabletArchivedRowLayout(.init(
            width: cell.contentView.bounds.width,
            hairline: cell.hairline,
            title: cell.titleLabel.measurable,
            subtitle: cell.subtitleLabel.measurable,
            subtitleRow: false,
            subtitleIcon: nil,
            status: cell.statusLabel.measurable,
            last: true
        ))
        XCTAssertEqual(layout.row.height, TabletArchivedRowLayout.Metrics.rowHeight)
        assertSamePixels(card.frame, PixelGrid.snap(layout.card, scale: scale), scale: scale, "card")
        func inCard(_ frame: CGRect) -> CGRect { frame.offsetBy(dx: -layout.card.minX, dy: -layout.card.minY) }
        assertSamePixels(cell.avatar.frame, PixelGrid.snap(inCard(layout.avatar), scale: scale), scale: scale, "avatar")
        assertSamePixels(cell.titleLabel.frame, PixelGrid.snap(inCard(layout.title), scale: scale), scale: scale, "title")
        assertSamePixels(cell.subtitleLabel.frame, PixelGrid.snap(inCard(layout.subtitle), scale: scale), scale: scale, "subtitle")
        assertSamePixels(cell.dot.frame, PixelGrid.snap(inCard(layout.dot), scale: scale), scale: scale, "dot")
        assertSamePixels(cell.statusLabel.frame, PixelGrid.snap(inCard(layout.status), scale: scale), scale: scale, "status")
        // The lines outgrow the 88 card at this size, so the card cuts them.
        let lines = cell.titleLabel.frame.union(cell.subtitleLabel.frame).union(cell.statusLabel.frame)
        XCTAssertFalse(card.bounds.contains(lines), "\(lines) in \(card.bounds)")

        for (name, view) in content where !view.isHidden && card.bounds.contains(CGPoint(x: view.frame.midX, y: view.frame.midY)) {
            assertTapReachesTheCell(cell, on: view, passive: content.map(\.1), "on the \(name)")
        }
    }
}
#endif
