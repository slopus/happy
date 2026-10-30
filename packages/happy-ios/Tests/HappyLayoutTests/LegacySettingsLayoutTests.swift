import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class ItemRowTrailingTests: XCTestCase {
    func testASwitchTakesTheChevronsPlace() {
        let layout = ItemRowLayout(.init(
            width: 361,
            hasIcon: true,
            title: text("Analytics", lineHeight: 22, maxLines: 1),
            subtitle: text("Usage data is shared", lineHeight: 20, maxLines: 2),
            trailing: CGSize(width: 51, height: 31)
        ))
        XCTAssertEqual(layout.rowHeight, 66)
        assertFrame(layout.title, rect(57, 11, 229, 22))
        assertFrame(layout.trailing, rect(294, 17.5, 51, 31))
        XCTAssertNil(layout.accessory)
    }

    func testDetailSpinnerAndChevronKeepRNsSpacing() {
        let layout = ItemRowLayout(.init(
            width: 361,
            title: text("GitHub", lineHeight: 22, maxLines: 1),
            detail: text("slopus/happy", lineHeight: 22, maxLines: 1),
            trailing: CGSize(width: 20, height: 20),
            accessory: CGSize(width: 8, height: 14)
        ))
        XCTAssertEqual(layout.rowHeight, 46)
        assertFrame(layout.detail, rect(205, 12, 96, 22))
        assertFrame(layout.trailing, rect(307, 13, 20, 20))
        assertFrame(layout.accessory, rect(337, 16, 8, 14))
        XCTAssertEqual(layout.title.width, 181)
    }

    func testAnUntitledGroupWithOwnPadding() {
        // HomeListHeader's offline plaque: 4 above, 16 below.
        let layout = ItemGroupLayout(.init(width: 393, rows: [block(height: 66)], untitledPaddingTop: 4, paddingBottom: 16))
        assertFrame(layout.card, rect(16, 4, 361, 66))
        assertSize(layout.size, CGSize(width: 393, height: 86))
    }
}

final class SettingsPageLayoutTests: XCTestCase {
    func testProfileHeader() {
        let layout = SettingsProfileHeaderLayout(
            width: 393,
            name: text("Ada Lovelace", lineHeight: 25, maxLines: 1),
            bio: text("Math", lineHeight: 19)
        )
        assertFrame(layout.card, rect(16, 16, 361, 206))
        assertFrame(layout.avatar, rect(135.5, 24, 90, 90))
        assertFrame(layout.name, rect(132.5, 126, 96, 25))
        assertFrame(layout.bio, rect(164.5, 155, 32, 19))
        assertSize(layout.size, CGSize(width: 393, height: 222))

        let plain = SettingsProfileHeaderLayout(width: 393, name: text("Ada Lovelace", lineHeight: 25, maxLines: 1), bio: nil)
        XCTAssertNil(plain.bio)
        assertFrame(plain.card, rect(16, 16, 361, 183))
    }

    func testDropdownValue() {
        let layout = DropdownValueLayout(preview: CGSize(width: 46, height: 28), label: text("Gray", lineHeight: 20, maxLines: 1))
        assertFrame(layout.preview, rect(0, 0, 46, 28))
        assertFrame(layout.label, rect(54, 4, 32, 20))
        assertFrame(layout.chevron, rect(94, 5, 18, 18))
        assertSize(layout.size, CGSize(width: 112, height: 28))

        let long = DropdownValueLayout(preview: CGSize(width: 46, height: 28), label: text("Something very long name", lineHeight: 20, maxLines: 1))
        XCTAssertEqual(long.label.width, 104, "the name gives way first")
        XCTAssertEqual(long.size.width, 184)
    }

    func testOptionRowsAndList() {
        let row = OptionRowLayout(width: 361, preview: CGSize(width: 46, height: 28), title: text("Blue", lineHeight: 21, maxLines: 1))
        assertFrame(row.preview, rect(16, 10, 46, 28))
        assertFrame(row.title, rect(74, 13.5, 239, 21))
        assertFrame(row.check, rect(325, 14, 20, 20))
        assertSize(row.size, CGSize(width: 361, height: 48))

        let list = OptionListLayout(width: 361, rows: [block(height: 48), block(height: 48), block(height: 48)])
        XCTAssertEqual(list.rows.map(\.minY), [6, 54, 102])
        assertSize(list.size, CGSize(width: 361, height: 156))
    }

    func testBubblePreviewLines() {
        XCTAssertEqual(BubblePreviewLayout.lines, [rect(19, 9, 18, 3), rect(11, 16, 26, 3)])
    }

    func testConnectCommandIsCentred() {
        let layout = ConnectCommandLayout(
            size: phone,
            safeArea: phoneUnderBar,
            title: text("Connect Claude", lineHeight: 23),
            body: text("Run the following command in your terminal:", lineHeight: 19),
            command: text("$ happy connect claude", lineHeight: 19, maxLines: 1)
        )
        assertFrame(layout.title, rect(140.5, 392, 112, 23))
        assertFrame(layout.body, rect(24.5, 435, 344, 19))
        assertFrame(layout.terminal, rect(56.5, 478, 280, 51))
        assertFrame(layout.command, rect(16, 16, 176, 19))
    }

    func testChangelogBodyListsAndParagraphs() {
        let items = [
            ChangelogBodyLayout.Item(text: text("aaaa", lineHeight: 25), bulleted: true),
            ChangelogBodyLayout.Item(text: text("bb", lineHeight: 25), bulleted: true),
            ChangelogBodyLayout.Item(text: text("cc", lineHeight: 25), bulleted: false),
        ]
        let layout = ChangelogBodyLayout(width: 361, summary: nil, items: items, bullet: CGSize(width: 7, height: 25))
        XCTAssertNil(layout.summary)
        assertFrame(layout.bullets[0], rect(16, 15, 7, 25))
        assertFrame(layout.texts[0], rect(31, 14, 314, 25))
        assertFrame(layout.bullets[1], rect(16, 47, 7, 25))
        assertFrame(layout.texts[1], rect(31, 46, 314, 25))
        XCTAssertNil(layout.bullets[2])
        assertFrame(layout.texts[2], rect(16, 88, 329, 25))
        assertSize(layout.size, CGSize(width: 361, height: 129))

        let summarised = ChangelogBodyLayout(width: 361, summary: text("s", lineHeight: 23), items: items, bullet: CGSize(width: 7, height: 25))
        assertFrame(summarised.summary, rect(16, 14, 329, 23))
        XCTAssertEqual(summarised.texts[0].minY, 53)
    }
}

final class UsageLayoutTests: XCTestCase {
    func testPeriodSelector() {
        let layout = UsagePeriodSelectorLayout(width: 393, labels: [
            text("Today", lineHeight: 18, maxLines: 1),
            text("Last 7 days", lineHeight: 18, maxLines: 1),
            text("Last 30 days", lineHeight: 18, maxLines: 1),
        ])
        let third: CGFloat = 329.0 / 3
        assertFrame(layout.card, rect(16, 16, 361, 50))
        assertFrame(layout.buttons[0], rect(8, 8, third, 34))
        assertFrame(layout.buttons[2], rect(8 + 2 * (third + 8), 8, third, 34))
        assertFrame(layout.labels[0], rect((third - 40) / 2, 8, 40, 18))
        XCTAssertEqual(layout.labels[2].width, third - 24, accuracy: 0.001, "clamped inside the button's padding")
        assertSize(layout.size, CGSize(width: 393, height: 82))
    }

    func testStats() {
        let layout = UsageStatsLayout(width: 393, rows: [
            .init(label: text("Total Tokens", lineHeight: 21), value: text("1.23M", lineHeight: 25)),
            .init(label: text("Total Cost", lineHeight: 21), value: text("$1.5000", lineHeight: 25)),
        ])
        assertFrame(layout.labels[0], rect(16, 18, 96, 21))
        assertFrame(layout.values[0], rect(305, 16, 40, 25))
        assertFrame(layout.labels[1], rect(16, 55, 80, 21))
        assertFrame(layout.values[1], rect(289, 53, 56, 25))
        assertFrame(layout.card, rect(16, 16, 361, 94))
        assertSize(layout.size, CGSize(width: 393, height: 126))
    }

    func testChartSection() {
        let layout = UsageChartSectionLayout(
            width: 393,
            title: text("Usage over time", lineHeight: 23),
            toggles: [text("Tokens", lineHeight: 18), text("Cost", lineHeight: 18)],
            chartHeight: 180
        )
        assertFrame(layout.title, rect(16, 16, 329, 23))
        assertFrame(layout.toggles[0], rect(100.5, 63, 80, 30))
        assertFrame(layout.toggles[1], rect(196.5, 63, 64, 30))
        assertFrame(layout.toggleLabels[1], rect(16, 6, 32, 18))
        assertFrame(layout.chart, rect(0, 125, 361, 180))
        assertFrame(layout.card, rect(16, 16, 361, 321))
        assertSize(layout.size, CGSize(width: 393, height: 337))
    }

    func testChartBars() {
        let layout = UsageChartLayout(fractions: [1, 0.5, 0], value: CGSize(width: 30, height: 13), label: CGSize(width: 60, height: 13))
        assertFrame(layout.bars[0], rect(10, 17, 40, 123))
        assertFrame(layout.values[0], rect(15, 0, 30, 13))
        assertFrame(layout.labels[0], rect(0, 151, 60, 13))
        assertFrame(layout.bars[1], rect(54, 78.5, 40, 61.5))
        assertFrame(layout.values[1], rect(59, 61.5, 30, 13))
        assertFrame(layout.bars[2], rect(98, 138, 40, 2))
        XCTAssertNil(layout.values[2], "an empty bar shows no value")
        assertSize(layout.contentSize, CGSize(width: 148, height: 180))
    }

    func testModelBars() {
        let layout = UsageModelBarsLayout(width: 361, rows: [
            .init(label: text("opus", lineHeight: 18), value: text("3,000", lineHeight: 18), fraction: 1),
            .init(label: text("haiku", lineHeight: 18), value: text("500", lineHeight: 18), fraction: 0.25),
        ])
        assertFrame(layout.labels[0], rect(16, 24, 32, 18))
        assertFrame(layout.values[0], rect(305, 24, 40, 18))
        assertFrame(layout.tracks[0], rect(16, 46, 329, 8))
        assertFrame(layout.fills[0], rect(16, 46, 329, 8))
        assertFrame(layout.labels[1], rect(16, 70, 40, 18))
        assertFrame(layout.fills[1], rect(16, 92, 82.25, 8))
        assertSize(layout.size, CGSize(width: 361, height: 124))
    }

    func testLoadingAndError() {
        assertFrame(UsageStatusLayout.spinner(size: phone, safeArea: phoneUnderBar, spinner: CGSize(width: 37, height: 37)), rect(178, 442, 37, 37))
        let error = UsageStatusLayout(size: phone, safeArea: phoneUnderBar, message: text("Failed to load usage data", lineHeight: 18))
        assertFrame(error.icon, rect(172.5, 135, 48, 48))
        assertFrame(error.message, rect(96.5, 183, 200, 18))
    }
}
