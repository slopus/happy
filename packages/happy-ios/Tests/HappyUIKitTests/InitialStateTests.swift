#if canImport(UIKit)
import HappyIcons
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
            icon: ItemIcon(.ionicons("server-outline"), tint: Palette.textSecondary, size: 28),
            isDestructive: true,
            onTap: {}
        )
        XCTAssertEqual(row.subtitleLabel.string, "Subtitle")
        XCTAssertFalse(row.subtitleLabel.isHidden)
        XCTAssertEqual(row.titleLabel.numberOfLines, 1, "a subtitle caps the title at one line")
        XCTAssertEqual(row.detailLabel.string, "Default")
        XCTAssertFalse(row.detailLabel.isHidden)
        XCTAssertEqual(row.glyphView.icon, .ionicons("server-outline"))
        XCTAssertEqual(row.glyphView.size, 28)
        XCTAssertFalse(row.glyphView.isHidden)
        XCTAssertTrue(row.iconView.isHidden, "pictures only")
        XCTAssertEqual(row.titleLabel.color, Palette.textDestructive)
        XCTAssertTrue(row.isUserInteractionEnabled)
    }

    func testPlainItemRowHidesWhatItDoesNotHave() {
        let row = ItemRowView(title: "Status")
        XCTAssertTrue(row.subtitleLabel.isHidden)
        XCTAssertTrue(row.detailLabel.isHidden)
        XCTAssertTrue(row.iconView.isHidden)
        XCTAssertTrue(row.glyphView.isHidden)
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
        XCTAssertNil(terminal.lines[0].textLayoutManager, "TextKit 1, laid out as the labels are")
        // One 24pt line, 14 padding and a 1pt border on each side.
        XCTAssertEqual(terminal.sizeThatFits(CGSize(width: 300, height: CGFloat.greatestFiniteMagnitude)).height, 54)
        XCTAssertEqual(terminal.lines[0].attributedText?.string, "$ happy")
    }

    func testTerminalLinesCopyTheCommandWithoutItsPrompt() {
        let line = TerminalBlockView(lines: [.command("happy"), .comment("# done")]).lines
        XCTAssertTrue(line[0].isSelectable)
        XCTAssertFalse(line[0].isEditable)
        line[0].selectedRange = NSRange(location: 0, length: 7)
        line[0].textViewDidChangeSelection(line[0])
        XCTAssertEqual(line[0].selectedRange, NSRange(location: 2, length: 5))
        line[0].selectedRange = NSRange(location: 0, length: 1)
        line[0].textViewDidChangeSelection(line[0])
        XCTAssertEqual(line[0].selectedRange.length, 0, "a selection inside the prompt collapses")
        line[1].selectedRange = NSRange(location: 0, length: 6)
        line[1].textViewDidChangeSelection(line[1])
        XCTAssertEqual(line[1].selectedRange, NSRange(location: 0, length: 6), "a comment has no prompt")
    }
}
#endif
