import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class SettingsPagesLayoutTests: XCTestCase {
    func testChangelogTitle() {
        let layout = ChangelogTitleLayout(title: text("What's New", lineHeight: 21, maxLines: 1), maxWidth: 240)
        assertFrame(layout.title, rect(0, 9.5, 80, 21))
        assertFrame(layout.image, rect(86, 0, 40, 40))
        assertSize(layout.size, CGSize(width: 126, height: 40))

        let narrow = ChangelogTitleLayout(title: text("What's New", lineHeight: 21, maxLines: 1), maxWidth: 100)
        XCTAssertEqual(narrow.title.width, 54, "the words give way, the picture keeps its size")
        assertFrame(narrow.image, rect(60, 0, 40, 40))
    }

    func testCenteredMessage() {
        let layout = CenteredMessageLayout(
            size: phone,
            safeArea: phoneUnderBar,
            message: text("No changelog entries available.", lineHeight: 24)
        )
        assertFrame(layout.message, rect(72.5, 448.5, 248, 24))

        let wrapped = CenteredMessageLayout(
            size: phone,
            safeArea: phoneUnderBar,
            message: text(String(repeating: "x", count: 50), lineHeight: 24)
        )
        assertFrame(wrapped.message, rect(40.5, 436.5, 312, 48))
    }

    /// Appearance › User Bubble Color: the dropdown value replaces the
    /// chevron, and the two-line subtitle sets the height.
    func testDropdownRow() {
        let value = DropdownValueLayout(preview: BubblePreviewLayout.size, label: text("Gray", lineHeight: 20, maxLines: 1))
        let row = ItemRowLayout(.init(
            width: 361,
            hasIcon: true,
            title: text("User Bubble Color", lineHeight: 22, maxLines: 1),
            subtitle: text("Make your messages easier to spot in long chats", lineHeight: 20, maxLines: 2),
            trailing: value.size
        ))
        XCTAssertEqual(row.rowHeight, 86)
        assertFrame(row.icon, rect(16, 28.5, 29, 29))
        assertFrame(row.title, rect(57, 11, 168, 22))
        assertFrame(row.subtitle, rect(57, 35, 168, 40))
        assertFrame(row.trailing, rect(233, 29, 112, 28))
        XCTAssertNil(row.accessory)
    }

    /// Appearance › Avatar Style: a 28pt avatar in the value and the options.
    func testAvatarStyleDropdown() {
        let value = DropdownValueLayout(preview: CGSize(width: 28, height: 28), label: text("Brutalist", lineHeight: 20, maxLines: 1))
        assertFrame(value.preview, rect(0, 0, 28, 28))
        assertFrame(value.label, rect(36, 4, 72, 20))
        assertFrame(value.chevron, rect(116, 5, 18, 18))
        assertSize(value.size, CGSize(width: 134, height: 28))

        let option = OptionRowLayout(width: 361, preview: CGSize(width: 28, height: 28), title: text("Pixelated", lineHeight: 21, maxLines: 1))
        assertFrame(option.preview, rect(16, 10, 28, 28))
        assertFrame(option.title, rect(56, 13.5, 257, 21))
        assertFrame(option.check, rect(325, 14, 20, 20))
        assertSize(option.size, CGSize(width: 361, height: 48))
    }

    /// Settings › Account › Registered Tokens: a subtitle with its own line
    /// breaks grows the row, and the icon stays centred.
    func testPushTokenRow() {
        let subtitle = Measurable { _ in CGSize(width: 200, height: 100) }
        let row = ItemRowLayout(.init(
            width: 361,
            hasIcon: true,
            title: text("abcdef…klmnop", lineHeight: 22, maxLines: 1),
            subtitle: subtitle,
            showsDivider: true
        ))
        XCTAssertEqual(row.rowHeight, 146)
        assertFrame(row.icon, rect(16, 58.5, 29, 29))
        assertFrame(row.subtitle, rect(57, 35, 280, 100))
        assertFrame(row.divider, rect(75, 146, 286, 0.33))
    }
}

final class SettingsTokenTests: XCTestCase {
    func testBubbleGlass() {
        let gray = BubblePalette.gray.glass
        XCTAssertEqual(gray.background.light, RGBA(hex: "#f0eee6")!.with(alpha: 0.48))
        XCTAssertEqual(gray.background.dark, RGBA(hex: "#2C2C2E")!.with(alpha: 0.34))
        XCTAssertEqual(gray.border.light, RGBA(red: 1, green: 1, blue: 1, alpha: 0.76))
        XCTAssertEqual(gray.border.dark, RGBA(red: 1, green: 1, blue: 1, alpha: 0.18))

        let blue = BubblePalette.blue.glass
        XCTAssertEqual(blue.background.light, RGBA(hex: "#E8F2FF")!.with(alpha: 0.54))
        XCTAssertEqual(blue.background.dark, RGBA(hex: "#17324D")!.with(alpha: 0.46))
        XCTAssertEqual(blue.border.light, RGBA(hex: "#9CC9FF")!.with(alpha: 0.70))
        XCTAssertEqual(blue.border.dark, RGBA(hex: "#2F6EA8")!.with(alpha: 0.56))
    }

    func testPressedOption() {
        XCTAssertEqual(Palette.optionPressed.light, RGBA(red: 1, green: 1, blue: 1, alpha: 0.84))
        XCTAssertEqual(Palette.optionPressed.dark, RGBA(red: 28 / 255, green: 28 / 255, blue: 28 / 255, alpha: 0.68))
    }
}
