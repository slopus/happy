#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

// Swift skips didSet for assignments in a class's own initializer, even
// after super.init. These views once kept their init arguments in the
// properties without showing them, which left Settings and Server as
// empty cards. Each test builds a view and checks what is on screen.
@MainActor
final class InitialStateTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testItemGroupShowsItsRowsHeaderAndFooter() {
        let first = ItemRowView(title: "One")
        let second = ItemRowView(title: "Two")
        let group = ItemGroupView(title: "Title", footer: "Footer", rows: [first, second])
        XCTAssertTrue(first.superview === group.card)
        XCTAssertTrue(second.superview === group.card)
        XCTAssertFalse(first.dividerView.isHidden, "every row but the last has a divider")
        XCTAssertTrue(second.dividerView.isHidden)
        XCTAssertEqual(group.headerLabel.attributedText?.string, "TITLE")
        XCTAssertFalse(group.headerLabel.isHidden)
        XCTAssertEqual(group.footerLabel.string, "Footer")
        XCTAssertFalse(group.footerLabel.isHidden)
    }

    func testItemGroupWithoutTitleHidesTheHeader() {
        let group = ItemGroupView(rows: [ItemRowView(title: "One")])
        XCTAssertTrue(group.headerLabel.isHidden)
        XCTAssertTrue(group.footerLabel.isHidden)
    }

    func testItemRowShowsItsInitArguments() {
        let row = ItemRowView(
            title: "Log out and start over",
            subtitle: "Subtitle",
            detail: "Default",
            icon: ItemIcon("server.rack", tint: Palette.textSecondary),
            isDestructive: true,
            onTap: {}
        )
        XCTAssertEqual(row.subtitleLabel.string, "Subtitle")
        XCTAssertFalse(row.subtitleLabel.isHidden)
        XCTAssertEqual(row.titleLabel.numberOfLines, 1, "a subtitle caps the title at one line")
        XCTAssertEqual(row.detailLabel.string, "Default")
        XCTAssertFalse(row.detailLabel.isHidden)
        XCTAssertNotNil(row.iconView.image)
        XCTAssertFalse(row.iconView.isHidden)
        XCTAssertEqual(row.titleLabel.color, Palette.textDestructive)
        XCTAssertTrue(row.isUserInteractionEnabled)
    }

    func testPlainItemRowHidesWhatItDoesNotHave() {
        let row = ItemRowView(title: "Status")
        XCTAssertTrue(row.subtitleLabel.isHidden)
        XCTAssertTrue(row.detailLabel.isHidden)
        XCTAssertTrue(row.iconView.isHidden)
        XCTAssertFalse(row.isUserInteractionEnabled)
    }

    func testGroupedListShowsItsSections() {
        let section = ItemGroupView(rows: [])
        let list = GroupedListView(sections: [section])
        XCTAssertTrue(section.superview === list)
    }

    func testNavigationTitleShowsItsInitArguments() {
        let title = NavigationTitleView(title: "Happy", subtitle: "example.com")
        XCTAssertEqual(title.titleLabel.string, "Happy")
        XCTAssertEqual(title.subtitleLabel.string, "example.com")
        XCTAssertGreaterThan(title.intrinsicContentSize.height, 0)
    }

    func testServerFormStartsWithNothingButTheField() {
        let form = ServerFormView()
        XCTAssertTrue(form.errorLabel.isHidden)
        XCTAssertTrue(form.validatingLabel.isHidden)
        XCTAssertTrue(form.reset.isHidden)
        XCTAssertTrue(form.statusLabel.isHidden)
        form.isCustomServer = true
        XCTAssertFalse(form.reset.isHidden)
    }

    func testOfflineChecklistMeasuresItsTerminalBlock() {
        let terminal = TerminalBlockView(lines: [.command("happy")])
        // One 24pt line, 14 padding and a 1pt border on each side.
        XCTAssertEqual(terminal.sizeThatFits(CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude)).height, 54)
        XCTAssertEqual(terminal.labels[0].attributedText?.string, "$ happy")
    }
}
#endif
