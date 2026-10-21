import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class ItemRowLayoutTests: XCTestCase {
    let chevron = CGSize(width: 9, height: 17)

    func testTitleOnlyRowIsPaddedPastTheMinimumHeight() {
        let layout = ItemRowLayout(.init(width: 375, title: text("Logout", lineHeight: 22)))
        // 12 + 22 + 12 = 46, which beats the 44 minimum.
        XCTAssertEqual(layout.rowHeight, 46)
        assertSize(layout.size, CGSize(width: 375, height: 46))
        // Title spans to the right section's 8pt margin: 375 - 16 - 16 - 8.
        assertFrame(layout.title, rect(16, 12, 335, 22))
        XCTAssertNil(layout.icon)
        XCTAssertNil(layout.subtitle)
        XCTAssertNil(layout.divider)
    }

    func testShortContentKeepsTheMinimumHeight() {
        let layout = ItemRowLayout(.init(width: 375, title: text("Hi", lineHeight: 14)))
        XCTAssertEqual(layout.rowHeight, 44)
        assertFrame(layout.title, rect(16, 15, 335, 14))
    }

    func testIconSubtitleChevronAndDivider() {
        let layout = ItemRowLayout(.init(
            width: 375,
            hasIcon: true,
            title: text("Link New Device", lineHeight: 22, maxLines: 1),
            subtitle: text("Scan QR code to link device", lineHeight: 20, maxLines: 2),
            accessory: chevron,
            showsDivider: true
        ))
        // Subtitle rows pad 11: 11 + (22 + 2 + 20) + 11 = 66.
        XCTAssertEqual(layout.rowHeight, 66)
        assertFrame(layout.icon, rect(16, 18.5, 29, 29))
        // Text starts after icon and its 12pt margin: 16 + 29 + 12 = 57.
        // Width: 375 - 57 - 16 - 8 - (4 + 9) = 281.
        assertFrame(layout.title, rect(57, 11, 281, 22))
        assertFrame(layout.subtitle, rect(57, 35, 281, 20))
        assertFrame(layout.accessory, rect(350, 24.5, 9, 17))
        // Divider inset 15 + 16 + 29 + 15 = 75, hairline under the row.
        assertFrame(layout.divider, rect(75, 66, 300, 0.33))
        assertSize(layout.size, CGSize(width: 375, height: 66.33))
    }

    func testDividerWithoutIconInsetsBy31() {
        let layout = ItemRowLayout(.init(width: 375, title: text("Status", lineHeight: 22), showsDivider: true))
        assertFrame(layout.divider, rect(31, 46, 344, 0.33))
    }

    func testDetailSitsBeforeTheChevron() {
        let layout = ItemRowLayout(.init(
            width: 375,
            title: text("Version", lineHeight: 22),
            detail: text("1.8.0", lineHeight: 22, maxLines: 1),
            accessory: chevron
        ))
        // Right section: detail 40 + 6 + 4 + chevron 9 = 59.
        assertFrame(layout.detail, rect(300, 12, 40, 22))
        assertFrame(layout.accessory, rect(350, 14.5, 9, 17))
        assertFrame(layout.title, rect(16, 12, 276, 22))
    }

    func testDetailWithoutChevronHugsTheTrailingPadding() {
        let layout = ItemRowLayout(.init(width: 375, title: text("Status", lineHeight: 22), detail: text("Active", lineHeight: 22, maxLines: 1)))
        assertFrame(layout.detail, rect(311, 12, 48, 22))
        XCTAssertNil(layout.accessory)
    }

    func testLongDetailIsCappedSoTheTitleStays() {
        let layout = ItemRowLayout(.init(
            width: 375,
            title: text("Analytics ID", lineHeight: 22),
            detail: text(String(repeating: "a", count: 100), lineHeight: 22, maxLines: 1),
            accessory: chevron
        ))
        // (335 - 13 - 6) × 0.6 = 189.6
        XCTAssertEqual(layout.detail?.width ?? 0, 189.6, accuracy: 0.001)
        XCTAssertEqual(layout.title.width, 335 - (189.6 + 6 + 13), accuracy: 0.001)
    }

    func testTitleWrapsToTwoLinesWithoutSubtitle() {
        let layout = ItemRowLayout(.init(width: 375, title: text(String(repeating: "x", count: 60), lineHeight: 22, maxLines: 2)))
        XCTAssertEqual(layout.rowHeight, 68)
        assertFrame(layout.title, rect(16, 12, 335, 44))
    }

    func testZeroWidthDoesNotGoNegative() {
        let layout = ItemRowLayout(.init(width: 0, hasIcon: true, title: text("Title", lineHeight: 22), accessory: chevron, showsDivider: true))
        XCTAssertEqual(layout.title.width, 0)
        XCTAssertEqual(layout.divider?.width, 0)
    }
}

final class ItemGroupLayoutTests: XCTestCase {
    func testTitledGroupWithFooter() {
        let layout = ItemGroupLayout(.init(
            width: 375,
            title: text("Backup", lineHeight: 18),
            footer: text(String(repeating: "f", count: 60), lineHeight: 18),
            rows: [fixed(343, 46.33), fixed(343, 46)]
        ))
        assertFrame(layout.header, rect(32, 35, 311, 18))
        // Header: 35 + 18 + 6 = 59.
        assertFrame(layout.card, rect(16, 59, 343, 92.33))
        assertFrame(layout.rows[0], rect(0, 0, 343, 46.33))
        assertFrame(layout.rows[1], rect(0, 46.33, 343, 46))
        // 60 characters wrap at 38 per line: two 18pt lines.
        assertFrame(layout.footer, rect(32, 157.33, 311, 36))
        assertSize(layout.size, CGSize(width: 375, height: 151.33 + 6 + 36 + 8))
    }

    func testUntitledGroupStartsTwentyDown() {
        let layout = ItemGroupLayout(.init(width: 375, rows: [fixed(343, 46)]))
        XCTAssertNil(layout.header)
        XCTAssertNil(layout.footer)
        assertFrame(layout.card, rect(16, 20, 343, 46))
        assertSize(layout.size, CGSize(width: 375, height: 66))
    }

    func testRowsAreMeasuredAtTheCardWidth() {
        var offered: [CGFloat] = []
        let row = Measurable { width in
            offered.append(width)
            return CGSize(width: width, height: 44)
        }
        _ = ItemGroupLayout(.init(width: 375, rows: [row]))
        XCTAssertEqual(offered, [343])
        XCTAssertEqual(ItemGroupLayout.cardWidth(forWidth: 375), 343)
    }

    func testGroupCentresAtMaxWidth() {
        let layout = ItemGroupLayout(.init(width: 1000, title: text("About", lineHeight: 18), rows: [block(height: 44)], maxWidth: 600))
        assertFrame(layout.header, rect(232, 35, 536, 18))
        assertFrame(layout.card, rect(216, 59, 568, 44))
        XCTAssertEqual(layout.size.width, 1000)
    }

    func testEmptyGroupHasAnEmptyCard() {
        let layout = ItemGroupLayout(.init(width: 375, rows: []))
        assertFrame(layout.card, rect(16, 20, 343, 0))
    }
}

final class GroupedListLayoutTests: XCTestCase {
    func testSectionsStackBelowTheBarAndFillTheViewport() {
        let layout = GroupedListLayout(.init(size: phone, safeArea: phoneUnderBar, sections: [block(height: 150), block(height: 100)]))
        assertFrame(layout.sections[0], rect(0, 103, 393, 150))
        assertFrame(layout.sections[1], rect(0, 253, 393, 100))
        // Short content still fills the screen.
        assertSize(layout.contentSize, phone)
    }

    func testTallContentAddsBottomPaddingAndHomeIndicator() {
        let layout = GroupedListLayout(.init(size: phone, safeArea: phoneUnderBar, sections: [block(height: 500), block(height: 400)]))
        // 103 + 900 + 34 padding + 34 home indicator.
        XCTAssertEqual(layout.contentSize.height, 1071)
    }

    func testLandscapeInsetsSectionsBySafeArea() {
        let size = CGSize(width: 852, height: 393)
        let insets = LayoutInsets(top: 32, left: 59, bottom: 21, right: 59)
        let layout = GroupedListLayout(.init(size: size, safeArea: insets, sections: [block(height: 100)]))
        assertFrame(layout.sections[0], rect(59, 32, 734, 100))
        XCTAssertEqual(GroupedListLayout.contentWidth(size: size, safeArea: insets), 734)
    }
}

final class SettingsHeaderLayoutTests: XCTestCase {
    func testLogoCard() {
        let layout = SettingsHeaderLayout(width: 375)
        // 24 + 90 + 12 + 24 = 150, 16 below the top.
        assertFrame(layout.card, rect(16, 16, 343, 150))
        assertFrame(layout.logo, rect(21.5, 24, 300, 90))
        assertSize(layout.size, CGSize(width: 375, height: 166))
    }

    func testLogoShrinksOnNarrowScreens() {
        let layout = SettingsHeaderLayout(width: 320)
        assertFrame(layout.logo, rect(16, 24, 256, 76.8))
        XCTAssertEqual(layout.card.height, 24 + 76.8 + 12 + 24, accuracy: 0.001)
    }
}

final class SecretKeyCardLayoutTests: XCTestCase {
    func testLabelIconAndWrappedKey() {
        let key = String(repeating: "X", count: 59)
        let layout = SecretKeyCardLayout(
            width: 343,
            label: text("SECRET KEY (TAP TO COPY)", lineHeight: 13, maxLines: 1),
            value: text(key, lineHeight: 20)
        )
        // Header row is the icon's 18; the 13pt label centres in it.
        assertFrame(layout.label, rect(16, 16.5, 285, 13))
        assertFrame(layout.icon, rect(309, 14, 18, 18))
        // 59 characters at 38 per line: two 20pt lines, 10 under the header.
        assertFrame(layout.value, rect(16, 42, 311, 40))
        assertSize(layout.size, CGSize(width: 343, height: 96))
    }
}
