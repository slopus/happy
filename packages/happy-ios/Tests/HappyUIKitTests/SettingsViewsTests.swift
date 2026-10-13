#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The settings pages' own views show what they were built with (the
/// didSet-in-init trap, see InitialStateTests) and measure through their
/// layouts.
@MainActor
final class SettingsViewsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testProfileHeaderShowsNameAndBio() {
        let header = SettingsProfileHeaderView(content: .init(
            id: "p1", name: "Ada Lovelace", bio: "Math", avatarURL: nil, style: .brutalist, monochrome: false
        ))
        XCTAssertEqual(header.nameLabel.string, "Ada Lovelace")
        XCTAssertEqual(header.bioLabel.string, "Math")
        XCTAssertFalse(header.bioLabel.isHidden)
        XCTAssertFalse(header.avatarView.isHidden, "no picture: the generated avatar shows")
        XCTAssertTrue(header.photo.isHidden)
        let size = header.sizeThatFits(CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude))
        XCTAssertEqual(size.height, header.layout(width: 393).size.height)
    }

    func testProfileHeaderWithAPictureHidesTheGeneratedAvatar() {
        let header = SettingsProfileHeaderView(content: .init(
            id: "p1", name: "Ada", bio: nil, avatarURL: URL(string: "https://example.com/a.png"), style: .gradient, monochrome: true
        ))
        XCTAssertTrue(header.avatarView.isHidden)
        XCTAssertFalse(header.photo.isHidden)
        XCTAssertTrue(header.bioLabel.isHidden)
    }

    func testDropdownValueMeasuresThroughItsLayout() {
        let value = DropdownValueView(preview: BubblePreviewView(color: .blue), previewSize: BubblePreviewLayout.size, text: "Blue")
        XCTAssertEqual(value.label.string, "Blue")
        XCTAssertNotNil(value.chevron.image)
        XCTAssertFalse(value.isUserInteractionEnabled, "the row takes the tap")
        XCTAssertEqual(value.sizeThatFits(.zero), value.layout().size)
    }

    func testOptionRowsCheckOnlyTheSelectedOne() {
        let selected = OptionRowView(preview: UIView(), previewSize: CGSize(width: 28, height: 28), title: "Gray", selected: true) {}
        let other = OptionRowView(preview: UIView(), previewSize: CGSize(width: 28, height: 28), title: "Blue", selected: false) {}
        XCTAssertFalse(selected.check.isHidden)
        XCTAssertNotNil(selected.backgroundColor)
        XCTAssertTrue(other.check.isHidden)
        XCTAssertNil(other.backgroundColor)
        let list = OptionListView(options: [selected, other])
        XCTAssertEqual(list.sizeThatFits(CGSize(width: 361, height: 0)).height, 6 + 48 + 48 + 6)
    }

    func testToggleRowsSurviveARebuild() {
        let toggles = SettingsToggleRows()
        let first = toggles.row("k", title: "Analytics", subtitle: "Usage data is shared", isOn: true) { _ in }
        let second = toggles.row("k", title: "Analytics", subtitle: "No data is shared", isOn: false) { _ in }
        XCTAssertTrue(first === second)
        XCTAssertEqual(second.subtitle, "No data is shared")
        XCTAssertEqual((second.trailingView as? UISwitch)?.isOn, false)
    }

    func testSecretKeyCardShowsTheKey() {
        let card = SecretKeyCardView(formattedKey: "ABCDE-FGHIJ")
        XCTAssertEqual(card.valueLabel.string, "ABCDE-FGHIJ")
        XCTAssertEqual(card.label.string, Strings.SettingsAccount.secretKeyLabel)
    }

    func testChangelogCardHasATextPerBlock() {
        let card = ChangelogCardView(entry: Changelog.Entry(
            title: "T",
            summary: "Thanks [@a](https://example.com)",
            markdown: "- **Bots** — one\n- two\n\nAfter."
        ))
        XCTAssertNotNil(card.summary)
        XCTAssertEqual(card.texts.count, 3)
        XCTAssertEqual(card.bullets.map { $0 != nil }, [true, true, false])
        XCTAssertEqual(card.texts[0].attributedText.string, "Bots — one")
    }
}
#endif
