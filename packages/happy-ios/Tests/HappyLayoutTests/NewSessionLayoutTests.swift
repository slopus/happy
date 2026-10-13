import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// new/index.tsx on an iPhone 15: 59 status bar, 34 home indicator.
final class NewSessionScreenLayoutTests: XCTestCase {
    private func configRow(_ string: String) -> NewSessionScreenLayout.Row {
        .config(label: text(string, lineHeight: 20, maxLines: 1))
    }

    func testRowsSitOnTheComposerAtTheFootOfTheScreen() {
        let layout = NewSessionScreenLayout(.init(
            size: phone,
            safeTop: 59,
            safeBottom: 34,
            composerHeight: 98,
            rows: [configRow("MacBook"), configRow("~/code/happy"), configRow("no worktree")]
        ))
        XCTAssertEqual(layout.headerBottom, 111)
        // max(12, 34) under the composer, 12 either side of it.
        assertFrame(layout.composer, rect(12, 720, 369, 98))
        assertFrame(layout.scroll, rect(0, 111, 393, 609))
        assertSize(layout.contentSize, CGSize(width: 393, height: 609))
        XCTAssertEqual(layout.configHeight, 152)

        // 8 under the rows and 12 under that: 20 above the composer.
        assertFrame(layout.rows[0].frame, rect(20, 445, 353, 48))
        assertFrame(layout.rows[1].frame, rect(20, 493, 353, 48))
        assertFrame(layout.rows[2].frame, rect(20, 541, 353, 48))
        XCTAssertEqual(layout.scroll.minY + layout.rows[2].frame.maxY + 8 + 12, layout.composer.minY)

        let row = layout.rows[0]
        assertFrame(row.icon, rect(12, 16.5, 15, 15))
        assertFrame(row.label, rect(35, 14, 285, 20))
        assertFrame(row.chevron, rect(328, 17.5, 13, 13))
        XCTAssertNil(row.body)
    }

    func testTheKeyboardLiftsTheComposerAndTheRows() {
        let layout = NewSessionScreenLayout(.init(
            size: phone,
            safeTop: 59,
            safeBottom: 34,
            keyboardOverlap: 336,
            composerHeight: 98,
            rows: [configRow("MacBook"), configRow("~/code/happy"), configRow("no worktree")]
        ))
        // KeyboardAvoidingView pads by the keyboard; the spacer stays.
        assertFrame(layout.composer, rect(12, 384, 369, 98))
        assertFrame(layout.scroll, rect(0, 111, 393, 273))
        assertFrame(layout.rows[0].frame, rect(20, 109, 353, 48))
    }

    func testOfflineHelpAndRowsTallerThanTheGapScroll() {
        let layout = NewSessionScreenLayout(.init(
            size: phone,
            safeTop: 59,
            safeBottom: 34,
            keyboardOverlap: 336,
            composerHeight: 98,
            rows: [
                configRow("MacBook"),
                .offline(
                    title: text("Machine is offline", lineHeight: 18),
                    body: text(String(repeating: "x", count: 50), lineHeight: 18)
                ),
                configRow("~/code/happy"),
                configRow("no worktree"),
            ]
        ))
        XCTAssertEqual(layout.configHeight, 230)
        // 96 clear of the header, then the rows, then 12.
        assertSize(layout.contentSize, CGSize(width: 393, height: 338))
        assertFrame(layout.rows[0].frame, rect(20, 96, 353, 48))
        assertFrame(layout.rows[2].frame, rect(20, 222, 353, 48))
        assertFrame(layout.rows[3].frame, rect(20, 270, 353, 48))

        let offline = layout.rows[1]
        // 10 + title + 4 + two lines of body + 10.
        assertFrame(offline.frame, rect(20, 144, 353, 78))
        assertFrame(offline.icon, rect(12, 10, 14, 14))
        assertFrame(offline.label, rect(34, 10, 144, 18))
        assertFrame(offline.body, rect(34, 32, 304, 36))
        XCTAssertNil(offline.chevron)
    }

    func testTokensFromHappyApp() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.newSession {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
        // theme.ts glass.tint, glass.overlayTint and glass.highlight.
        XCTAssertEqual(Palette.glassTint.light, RGBA(red: 1, green: 1, blue: 1, alpha: 0.14))
        XCTAssertEqual(Palette.glassTint.dark, RGBA(red: 16 / 255, green: 16 / 255, blue: 16 / 255, alpha: 0.08))
        XCTAssertEqual(Palette.glassOverlayTint.dark, RGBA(red: 0, green: 0, blue: 0, alpha: 0.56))
        XCTAssertEqual(Palette.glassHighlight.dark, RGBA(red: 1, green: 1, blue: 1, alpha: 0.22))
        XCTAssertEqual(TextStyles.newSessionRow, TextStyle(.semiBold, size: 16))
        XCTAssertEqual(TextStyles.newSessionOfflineBody, TextStyle(.regular, size: 12, lineHeight: 18))
    }

    func testALaneNarrowerThanTheScreenIsCentred() {
        let layout = NewSessionScreenLayout(.init(
            size: phone,
            safeTop: 59,
            safeBottom: 34,
            maxWidth: 300,
            composerHeight: 98,
            rows: [configRow("MacBook")]
        ))
        assertFrame(layout.composer, rect(58.5, 720, 276, 98))
        assertFrame(layout.rows[0].frame, rect(66.5, 541, 260, 48))
    }
}

final class NewSessionComposerLayoutTests: XCTestCase {
    private let hairline: CGFloat = 1.0 / 3

    func testOneLineOverTheActionRow() {
        let h = hairline
        let layout = NewSessionComposerLayout(.init(
            width: 369,
            hairline: h,
            textHeight: 22,
            agentLabel: text("codex", lineHeight: 18, maxLines: 1),
            showsSettings: true
        ))
        // Content is 96.67 tall; the box keeps its 98 minimum.
        assertSize(layout.size, CGSize(width: 369, height: 98))
        XCTAssertFalse(layout.textScrolls)
        // The 22pt line centred in the 44pt field, 10 in from the left.
        assertFrame(layout.input, rect(8 + h + 10, 6 + h + 11, 338 + h, 22))
        assertFrame(layout.actionRow, rect(8 + h, 50 + h, 354 + h, 40))
        assertFrame(layout.send, rect(324 + 2 * h, 51 + h, 38, 38))
        assertFrame(layout.mic, rect(284 + 2 * h, 51 + h, 38, 38))

        // 9 + 14 + 6 + label + 6 + 12 + 9.
        assertFrame(layout.agent, rect(8 + h, 52 + h, 96, 36))
        assertFrame(layout.agentIcon, rect(9, 11, 14, 14))
        assertFrame(layout.agentLabel, rect(29, 9, 40, 18))
        assertFrame(layout.agentChevron, rect(75, 12, 12, 12))
        assertFrame(layout.settings, rect(106 + h, 51 + h, 38, 38))
    }

    func testALongHarnessNameShrinksInside132() {
        let layout = NewSessionComposerLayout(.init(
            width: 369,
            hairline: hairline,
            textHeight: 22,
            agentLabel: text("claude code", lineHeight: 18, maxLines: 1),
            showsSettings: false
        ))
        XCTAssertEqual(layout.agent.width, 132)
        assertFrame(layout.agentLabel, rect(29, 9, 76, 18))
        assertFrame(layout.agentChevron, rect(111, 12, 12, 12))
        XCTAssertNil(layout.settings)
    }

    func testTheInputGrowsTo120ThenScrolls() {
        let h = hairline
        let grown = NewSessionComposerLayout(.init(
            width: 369,
            hairline: h,
            textHeight: 88,
            agentLabel: text("codex", lineHeight: 18, maxLines: 1),
            showsSettings: true
        ))
        assertFrame(grown.input, rect(18 + h, 6 + h, 338 + h, 88))
        assertSize(grown.size, CGSize(width: 369, height: 140 + 2 * h))
        XCTAssertFalse(grown.textScrolls)

        let capped = NewSessionComposerLayout(.init(
            width: 369,
            hairline: h,
            textHeight: 150,
            agentLabel: text("codex", lineHeight: 18, maxLines: 1),
            showsSettings: true
        ))
        assertFrame(capped.input, rect(18 + h, 6 + h, 338 + h, 120))
        assertFrame(capped.actionRow, rect(8 + h, 126 + h, 354 + h, 40))
        assertSize(capped.size, CGSize(width: 369, height: 172 + 2 * h))
        XCTAssertTrue(capped.textScrolls)
    }
}

final class NewSessionPickerLayoutTests: XCTestCase {
    private func picker(_ anchor: NewSessionPickerLayout.Anchor, content: CGFloat, composer: CGFloat = 98) -> NewSessionPickerLayout {
        NewSessionPickerLayout(.init(
            size: phone,
            safeTop: 59,
            safeBottom: 34,
            composerHeight: composer,
            configHeight: 152,
            anchor: anchor,
            contentHeight: content
        ))
    }

    func testTheComposersPickersOpen10AboveIt() {
        let layout = picker(.composer, content: 200)
        assertFrame(layout.frame, rect(20, 490, 353, 220))
        assertFrame(layout.content, rect(12, 10, 329, 200))
    }

    func testARowsPickerOpens8AboveTheRow() {
        // The path row is at 604 (see the screen's rows); 264 at most.
        let layout = picker(.row(1), content: 300)
        assertFrame(layout.frame, rect(20, 332, 353, 264))
        assertFrame(layout.content, rect(12, 10, 329, 244))
    }

    func testAPickerNeverRisesAboveTheHeader() {
        let layout = picker(.row(0), content: 500, composer: 400)
        XCTAssertEqual(layout.frame.minY, 123)
    }
}

final class NewSessionPickerContentLayoutTests: XCTestCase {
    private func option(_ label: String, detail: String? = nil, trailing: CGFloat? = nil) -> NewSessionPickerContentLayout.Element {
        .option(
            icon: 16,
            label: text(label, lineHeight: 20, maxLines: 1),
            detail: detail.map { text($0, lineHeight: 18, maxLines: 1) },
            trailing: trailing
        )
    }

    func testSearchOverAListThatScrollsPast176() {
        let layout = NewSessionPickerContentLayout(.init(
            width: 329,
            header: [.search(fieldHeight: 18)],
            list: Array(repeating: option("MacBook", detail: "online"), count: 5)
        ))
        assertFrame(layout.header[0].frame, rect(0, 0, 329, 34))
        assertFrame(layout.header[0].icon, rect(4, 9, 16, 16))
        assertFrame(layout.header[0].label, rect(30, 8, 295, 18))

        let row = layout.list[1]
        assertFrame(row.frame, rect(0, 54, 329, 54))
        assertFrame(row.icon, rect(4, 19, 16, 16))
        assertFrame(row.label, rect(32, 8, 293, 20))
        assertFrame(row.detail, rect(32, 28, 293, 18))
        XCTAssertNil(row.trailing)

        XCTAssertEqual(layout.listContentHeight, 270)
        assertFrame(layout.listFrame, rect(0, 38, 329, 176))
        XCTAssertEqual(layout.height, 216)
    }

    func testThePathPickersRows() {
        let layout = NewSessionPickerContentLayout(.init(
            width: 329,
            header: [.pathField(fieldHeight: 18)],
            list: [
                .text(text("Recent", lineHeight: 18)),
                option("~/code/happy", trailing: 18),
                .divider,
                .empty(text("No results", lineHeight: 20)),
            ]
        ))
        assertFrame(layout.header[0].frame, rect(0, 0, 329, 38))
        assertFrame(layout.header[0].icon, rect(4, 11, 16, 16))
        assertFrame(layout.header[0].label, rect(30, 2, 295, 34))

        assertFrame(layout.list[0].frame, rect(0, 0, 329, 26))
        assertFrame(layout.list[0].label, rect(4, 0, 48, 18))
        let folder = layout.list[1]
        assertFrame(folder.frame, rect(0, 26, 329, 36))
        assertFrame(folder.icon, rect(4, 10, 16, 16))
        assertFrame(folder.label, rect(32, 8, 263, 20))
        assertFrame(folder.trailing, rect(307, 9, 18, 18))
        assertFrame(layout.list[2].frame, rect(12, 66, 305, 1))
        assertFrame(layout.list[3].frame, rect(0, 71, 329, 60))
        assertFrame(layout.list[3].label, rect(124.5, 20, 80, 20))

        assertFrame(layout.listFrame, rect(0, 42, 329, 131))
        XCTAssertEqual(layout.height, 175)
    }

    func testASettingsPageNeverScrollsItsList() {
        let layout = NewSessionPickerContentLayout(.init(
            width: 329,
            header: [.back(title: text("Permissions", lineHeight: 18))],
            list: Array(repeating: option("Default", detail: "Ask"), count: 5),
            listMaxHeight: nil,
            paddingTop: 4,
            paddingBottom: 8
        ))
        assertFrame(layout.header[0].frame, rect(0, 4, 329, 40))
        assertFrame(layout.header[0].icon, rect(0, 2, 36, 36))
        assertFrame(layout.header[0].label, rect(40, 11, 289, 18))
        assertFrame(layout.listFrame, rect(0, 48, 329, 270))
        XCTAssertEqual(layout.height, 326)
    }
}
