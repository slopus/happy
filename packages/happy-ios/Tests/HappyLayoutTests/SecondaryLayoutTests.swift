import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// info.tsx's loading and deleted states, "Machine not found", and the
/// file viewer's centred states.
final class CenteredStackLayoutTests: XCTestCase {
    func testDeletedSessionState() {
        // Icon 48, title 20/24 at marginTop 16, description 15/20 at
        // marginTop 8 with paddingHorizontal 32, centred in 390 × 600.
        let layout = CenteredStackLayout(.init(size: CGSize(width: 390, height: 600), items: [
            .init(fixed(48, 48)),
            .init(text("Session has been deleted", advance: 10, lineHeight: 24), spacingBefore: 16),
            .init(text(String(repeating: "x", count: 40), advance: 10, lineHeight: 20), spacingBefore: 8, horizontalPadding: 32),
        ]))
        // 48 + 16 + 24 + 8 + 40 = 136 tall: starts at (600 - 136) / 2 = 232.
        assertFrame(layout.items[0], rect(171, 232, 48, 48))
        assertFrame(layout.items[1], rect(75, 296, 240, 24))
        // 400 wide doesn't fit in 390 - 64: wraps to 32 characters a line.
        assertFrame(layout.items[2], rect(35, 328, 320, 40))
    }

    func testPaddingNarrowsAndOffsets() {
        let layout = CenteredStackLayout(.init(size: CGSize(width: 200, height: 100), padding: 20, items: [
            .init(text(String(repeating: "x", count: 30), advance: 10, lineHeight: 10)),
        ]))
        // 160 wide → two lines of 16, centred in the 60 left after padding.
        assertFrame(layout.items[0], rect(20, 40, 160, 20))
    }

    func testEmpty() {
        XCTAssertTrue(CenteredStackLayout(.init(size: CGSize(width: 10, height: 10), items: [])).items.isEmpty)
    }
}

/// GitLineChanges (gap 4) and the Changes row's right element (gap 6).
final class HorizontalStackLayoutTests: XCTestCase {
    func testCentresEachPartVertically() {
        let layout = HorizontalStackLayout([CGSize(width: 60, height: 15), CGSize(width: 30, height: 14), CGSize(width: 10, height: 21)], spacing: 6)
        assertSize(layout.size, CGSize(width: 112, height: 21))
        assertFrame(layout.items[0], rect(0, 3, 60, 15))
        assertFrame(layout.items[1], rect(66, 3.5, 30, 14))
        assertFrame(layout.items[2], rect(102, 0, 10, 21))
    }

    func testEmptyIsZero() {
        assertSize(HorizontalStackLayout([], spacing: 4).size, .zero)
    }
}

/// components/CodeView.tsx inside info.tsx's raw JSON group.
final class CodeBlockLayoutTests: XCTestCase {
    func testInsetsAndPadding() {
        let layout = CodeBlockLayout(width: 358, pieces: [36])
        // Box 358 - 32 = 326, text 302.
        XCTAssertEqual(CodeBlockLayout.textWidth(358), 302)
        assertFrame(layout.box, rect(16, 0, 326, 60))
        assertFrame(layout.text, rect(28, 12, 302, 36))
        assertFrame(layout.pieces[0], rect(28, 12, 302, 36))
        assertSize(layout.size, CGSize(width: 358, height: 72))
    }

    func testPiecesStackWithNoGap() {
        let layout = CodeBlockLayout(width: 358, pieces: [720, 18, 0, 1080])
        assertFrame(layout.pieces[0], rect(28, 12, 302, 720))
        assertFrame(layout.pieces[1], rect(28, 732, 302, 18))
        assertFrame(layout.pieces[2], rect(28, 750, 302, 0))
        assertFrame(layout.pieces[3], rect(28, 750, 302, 1080))
        assertFrame(layout.text, rect(28, 12, 302, 1818))
        assertFrame(layout.box, rect(16, 0, 326, 1842))
        assertSize(layout.size, CGSize(width: 358, height: 1854))
    }

    func testNoPiecesIsAnEmptyBox() {
        let layout = CodeBlockLayout(width: 358, pieces: [])
        assertFrame(layout.text, rect(28, 12, 302, 0))
        assertFrame(layout.box, rect(16, 0, 326, 24))
        assertSize(layout.size, CGSize(width: 358, height: 36))
        XCTAssertEqual(layout.pieces(from: 0, to: 1000), 0..<0)
    }

    func testNarrowerThanItsInsetsIsZeroWide() {
        let layout = CodeBlockLayout(width: 40, pieces: [18])
        XCTAssertEqual(CodeBlockLayout.textWidth(40), 0)
        assertFrame(layout.box, rect(16, 0, 8, 42))
        assertFrame(layout.pieces[0], rect(28, 12, 0, 18))
    }

    /// Pieces at 12..<732, 732..<1452, 1452..<2172, 2172..<2892.
    func testThePiecesMeetingARange() {
        let layout = CodeBlockLayout(width: 358, pieces: [720, 720, 720, 720])
        XCTAssertEqual(layout.pieces(from: 0, to: 12), 0..<0)
        XCTAssertEqual(layout.pieces(from: 0, to: 13), 0..<1)
        XCTAssertEqual(layout.pieces(from: 731, to: 733), 0..<2)
        XCTAssertEqual(layout.pieces(from: 732, to: 1452), 1..<2)
        XCTAssertEqual(layout.pieces(from: 1000, to: 2500), 1..<4)
        XCTAssertEqual(layout.pieces(from: -5000, to: 50_000), 0..<4)
        XCTAssertEqual(layout.pieces(from: 2892, to: 3000), 4..<4)
        XCTAssertEqual(layout.pieces(from: 900, to: 900), 0..<0)
    }

    func testAnEmptyPieceInsideTheRangeIsIncluded() {
        let layout = CodeBlockLayout(width: 358, pieces: [100, 0, 100])
        XCTAssertEqual(layout.pieces(from: 0, to: 1000), 0..<3)
        // The empty piece sits at 112; a range ending there stops before it.
        XCTAssertEqual(layout.pieces(from: 0, to: 112), 0..<1)
    }
}

/// components/DuplicateSheet.tsx, sized by utils/duplicateSheetLayout.ts.
/// A 0.5 hairline (2x) keeps the sums exact.
final class DuplicateSheetLayoutTests: XCTestCase {
    private func layout(
        window: CGSize = CGSize(width: 393, height: 852),
        body: DuplicateSheetLayout.Body
    ) -> DuplicateSheetLayout {
        DuplicateSheetLayout(.init(
            window: window,
            title: fixed(100, 20),
            subtitle: fixed(300, 32),
            body: body,
            buttonTextHeight: 18,
            hairline: 0.5
        ))
    }

    func testRowsOnAPhone() {
        let sheet = layout(body: .rows([(fixed(200, 38), fixed(50, 14)), (fixed(200, 38), fixed(50, 14))]))
        // min(560, 393 - 32) = 361 wide; the border leaves 360 inside.
        assertFrame(sheet.title, rect(20.5, 20.5, 320, 20))
        assertFrame(sheet.subtitle, rect(20.5, 44.5, 320, 32))
        assertFrame(sheet.headerDivider, rect(0.5, 88.5, 360, 0.5))
        // Rows: 12 + 38 + 4 + 14 + 12, then their hairline.
        XCTAssertEqual(sheet.rows.count, 2)
        assertFrame(sheet.rows[0].frame, rect(0, 8, 360, 80.5))
        assertFrame(sheet.rows[0].text, rect(20, 20, 320, 38))
        assertFrame(sheet.rows[0].meta, rect(20, 62, 320, 14))
        assertFrame(sheet.rows[0].divider, rect(0, 88, 360, 0.5))
        assertFrame(sheet.rows[1].frame, rect(0, 88.5, 360, 80.5))
        assertFrame(sheet.rows[1].divider, rect(0, 168.5, 360, 0.5))
        XCTAssertNil(sheet.body)
        assertSize(sheet.listContentSize, CGSize(width: 360, height: 177))
        assertFrame(sheet.list, rect(0.5, 89, 360, 177))
        // The action bar: hairline, 16, two 40pt buttons 8 apart, 16.
        assertFrame(sheet.actionsDivider, rect(0.5, 266, 360, 0.5))
        assertFrame(sheet.cancel, rect(16.5, 282.5, 160, 40))
        assertFrame(sheet.confirm, rect(184.5, 282.5, 160, 40))
        // 339 tall with both borders, centred in the window.
        assertFrame(sheet.card, rect(16, 256.5, 361, 339))
    }

    func testTheListStopsAt420() {
        let many = Array(repeating: (text: fixed(200, 19), meta: fixed(50, 14)), count: 20)
        let sheet = layout(body: .rows(many.map { ($0.text, $0.meta) }))
        // Each row 12 + 19 + 4 + 14 + 12 + 0.5 = 61.5; twenty and the padding.
        assertSize(sheet.listContentSize, CGSize(width: 360, height: 1246))
        assertFrame(sheet.list, rect(0.5, 89, 360, 420))
        assertFrame(sheet.card, rect(16, 135, 361, 582))
    }

    func testTheListShrinksToFitAShortWindow() {
        let many = Array(repeating: (text: fixed(200, 19), meta: fixed(50, 14)), count: 20)
        let sheet = layout(window: CGSize(width: 320, height: 400), body: .rows(many.map { ($0.text, $0.meta) }))
        // round(400 × 0.85) = 340 tall at most: 89 header, 72.5 actions, 0.5 border.
        assertFrame(sheet.list, rect(0.5, 89, 287, 178))
        assertFrame(sheet.card, rect(16, 30, 288, 340))
    }

    func testAWideWindowCapsTheWidth() {
        let sheet = layout(window: CGSize(width: 1024, height: 1366), body: .loading(CGSize(width: 20, height: 20)))
        assertFrame(sheet.card, rect(232, sheet.card.minY, 560, sheet.card.height))
        assertFrame(sheet.cancel, rect(16.5, sheet.cancel.minY, 259.5, 40))
    }

    func testSpinnerAndMessage() {
        let loading = layout(body: .loading(CGSize(width: 20, height: 20)))
        // 8 list padding, then 32 above and below the spinner.
        assertFrame(loading.body, rect(170, 40, 20, 20))
        assertSize(loading.listContentSize, CGSize(width: 360, height: 100))

        // The message wraps inside 20 on each side and is centred.
        let message = layout(body: .message(text(String(repeating: "x", count: 40), advance: 10, lineHeight: 17)))
        assertFrame(message.body, rect(20, 40, 320, 34))
        assertSize(message.listContentSize, CGSize(width: 360, height: 114))
        XCTAssertTrue(message.rows.isEmpty)
    }
}

final class SecondaryTokenTests: XCTestCase {
    func testEveryTokenParsed() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in SecondaryPalette.all + DiffPalette.all + FileIconPalette.all + FileViewerPalette.all {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
        // `${theme.colors.textLink}66`.
        XCTAssertEqual(FileViewerPalette.toggleSelected.light, RGBA(red: 0x2B / 255, green: 0xAC / 255, blue: 0xCC / 255, alpha: 0x66 / 255))
    }

    func testDiffPaletteFromTheme() {
        XCTAssertEqual(DiffPalette.rowAdded.dark, RGBA(hex: "#12261E"))
        XCTAssertEqual(DiffPalette.Syntax.keyword.light, RGBA(hex: "#CF222E"))
        XCTAssertEqual(DiffPalette.hunkBackground, ColorToken(light: RGBA(hex: "#F1F8FF")!, dark: RGBA(hex: "#161B22")!))
    }
}
