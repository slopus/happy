import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class ChecklistLayoutTests: XCTestCase {
    func testChecklistRowCentresBoxAndTitleInTheHead() {
        let row = ChecklistRowLayout(origin: CGPoint(x: 10, y: 100), width: 300, title: text("Linked MacBook", lineHeight: 22), body: nil)
        assertFrame(row.head, rect(10, 100, 300, 32))
        assertFrame(row.box, rect(10, 103, 26, 26))
        assertFrame(row.title, rect(48, 105, 262, 22))
        XCTAssertNil(row.body)
        XCTAssertEqual(row.maxY, 132)
    }

    func testChecklistRowBodyIsIndentedUnderTheTitle() {
        let row = ChecklistRowLayout(
            origin: CGPoint(x: 10, y: 100),
            width: 300,
            title: text("Linked MacBook", lineHeight: 22),
            body: text(String(repeating: "b", count: 70), lineHeight: 21)
        )
        // 262 wide fits 32 characters: three lines.
        assertFrame(row.body, rect(48, 138, 262, 63))
        XCTAssertEqual(row.maxY, 201)
    }

    func testTerminalBlockPadsInsideItsBorder() {
        let layout = TerminalBlockLayout(width: 297, lines: [
            text("# comment", lineHeight: 24),
            text("$ npm install -g happy", lineHeight: 24),
        ])
        // 1 border + 14/18 padding.
        assertFrame(layout.lines[0], rect(19, 15, 259, 24))
        assertFrame(layout.lines[1], rect(19, 39, 259, 24))
        assertSize(layout.size, CGSize(width: 297, height: 78))
    }

    private func offline(size: CGSize = phone, safeArea: LayoutInsets = phoneUnderBar) -> OfflineChecklistLayout {
        OfflineChecklistLayout(.init(
            size: size,
            safeArea: safeArea,
            title: text("MacBook is offline", lineHeight: 30),
            linkedTitle: text("Linked MacBook", lineHeight: 22),
            openTitle: text("Open Happy on your computer", lineHeight: 22),
            openBody: text(String(repeating: "o", count: 100), lineHeight: 21),
            terminal: block(height: 54),
            buttons: [block(height: 50), block(height: 44)]
        ))
    }

    func testOfflineChecklistOnAPhone() {
        let layout = offline()
        // 16 under the bar; the title is inset 4 more than the rows.
        assertFrame(layout.title, rect(28, 119, 337, 30))
        assertFrame(layout.linked.head, rect(24, 165, 345, 32))
        assertFrame(layout.linked.box, rect(24, 168, 26, 26))
        assertFrame(layout.linked.title, rect(62, 170, 307, 22))
        // 20 between rows.
        assertFrame(layout.open.head, rect(24, 217, 345, 32))
        // The body is the text, then the terminal 12 under it.
        assertFrame(layout.openBody, rect(62, 255, 307, 63))
        assertFrame(layout.terminal, rect(62, 330, 307, 54))
        assertFrame(layout.open.body, rect(62, 255, 307, 129))
        // Actions 6 under the last row, 260 wide on the left, 8 apart.
        assertFrame(layout.buttons[0], rect(24, 390, 260, 50))
        assertFrame(layout.buttons[1], rect(24, 448, 260, 44))
        assertSize(layout.contentSize, phone)
    }

    func testOfflineChecklistScrollsWhenTaller() {
        let layout = offline(size: CGSize(width: 393, height: 400))
        // Last button ends at 492, then 8, 48 and the home indicator.
        assertSize(layout.contentSize, CGSize(width: 393, height: 582))
    }

    func testOfflineChecklistIsCappedAndCentredOnWideScreens() {
        let layout = offline(size: CGSize(width: 1024, height: 768), safeArea: LayoutInsets(top: 74, bottom: 20))
        // 480 wide block at (1024 - 480) / 2, padded 24.
        assertFrame(layout.title, rect(300, 90, 424, 30))
        assertFrame(layout.linked.head, rect(296, 136, 432, 32))
        assertFrame(layout.buttons[0], rect(296, layout.buttons[0].minY, 260, 50))
    }

    func testLoadingSpinnerSitsInTheMiddleOfWhatIsLeft() {
        let layout = LoadingLayout(size: phone, safeArea: phoneUnderBar, spinner: CGSize(width: 20, height: 20))
        // Between 103 and 852 - 34 - 32.
        assertFrame(layout.spinner, rect(186.5, 434.5, 20, 20))
    }

    func testTroubleshootGuide() {
        let layout = TroubleshootGuideLayout(
            width: 393,
            heading: text(String(repeating: "h", count: 37), lineHeight: 30),
            intro: text(String(repeating: "i", count: 100), lineHeight: 21),
            steps: [
                .init(title: text("Is the computer awake and online?", lineHeight: 22), body: text(String(repeating: "s", count: 52), lineHeight: 21)),
                .init(title: text("Using the terminal?", lineHeight: 22), body: text(String(repeating: "t", count: 30), lineHeight: 21), terminal: block(height: 102)),
            ]
        )
        assertFrame(layout.heading, rect(24, 20, 345, 30))
        assertFrame(layout.intro, rect(24, 58, 345, 63))
        // Icon 26×22 on the left, text 12 after it.
        assertFrame(layout.steps[0].icon, rect(24, 145, 26, 22))
        assertFrame(layout.steps[0].title, rect(62, 145, 307, 22))
        assertFrame(layout.steps[0].body, rect(62, 171, 307, 42))
        XCTAssertNil(layout.steps[0].terminal)
        assertFrame(layout.steps[1].icon, rect(24, 233, 26, 22))
        assertFrame(layout.steps[1].body, rect(62, 259, 307, 21))
        assertFrame(layout.steps[1].terminal, rect(62, 292, 307, 102))
        // Every step keeps 20 under it.
        assertSize(layout.size, CGSize(width: 393, height: 414))
    }

    func testTroubleshootGuideIsCappedOnTablets() {
        let layout = TroubleshootGuideLayout(width: 1024, maxWidth: 800, heading: block(height: 30), intro: block(height: 21), steps: [])
        assertFrame(layout.heading, rect(136, 20, 752, 30))
    }

    func testCopyPromptCentresTheButtonOverItsHint() {
        let layout = CopyPromptLayout(width: 393, button: block(height: 44), hint: text(String(repeating: "p", count: 80), lineHeight: 18))
        assertFrame(layout.button, rect(66.5, 20, 260, 44))
        assertFrame(layout.hint, rect(24, 72, 345, 36))
        assertSize(layout.size, CGSize(width: 393, height: 108))
    }
}
