import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

final class DocumentLayoutTests: XCTestCase {
    func testIndentsByKindAndDepth() {
        XCTAssertEqual(DocumentIndent(kind: .text, depth: 0), DocumentIndent(kind: .heading(1), depth: 0))
        XCTAssertEqual(DocumentIndent(kind: .text, depth: 0).head, 0)
        XCTAssertEqual(DocumentIndent(kind: .bullet, depth: 0).head, 26)
        XCTAssertEqual(DocumentIndent(kind: .check, depth: 2).firstLine, 74)
        XCTAssertEqual(DocumentIndent(kind: .numbered(width: 30), depth: 1).head, 50, "a wide number never moves the text")
        XCTAssertEqual(DocumentIndent(kind: .quote, depth: 0).head, 16)
        let code = DocumentIndent(kind: .code, depth: 0)
        XCTAssertEqual(code.head, 12)
        XCTAssertEqual(code.tail, 12)
    }

    func testMarkersSitOnTheFirstLine() {
        let first = rect(26, 4, 200, 26)
        let bullet = DocumentMarkerLayout(kind: .bullet, depth: 0, firstLine: first, lastLine: first, origin: 0, width: 335)
        assertFrame(bullet.marker, rect(6, 14, 6, 6))
        XCTAssertNil(bullet.decoration)
        let nested = DocumentMarkerLayout(kind: .bullet, depth: 1, firstLine: first, lastLine: first, origin: 0, width: 335)
        assertFrame(nested.marker, rect(30, 14, 6, 6))
        let number = DocumentMarkerLayout(kind: .numbered(width: 10), depth: 0, firstLine: first, lastLine: first, origin: 0, width: 335)
        assertFrame(number.marker, rect(10, 4, 10, 26))
        let wide = DocumentMarkerLayout(kind: .numbered(width: 40), depth: 0, firstLine: first, lastLine: first, origin: 0, width: 335)
        assertFrame(wide.marker, rect(0, 4, 40, 26))
        let check = DocumentMarkerLayout(kind: .check, depth: 0, firstLine: first, lastLine: first, origin: 0, width: 335)
        assertFrame(check.marker, rect(0, 8, 18, 18))
        assertFrame(check.target, rect(-13, -5, 44, 44))
    }

    func testQuoteBarsAndCodeFillsSpanTheWholeBlock() {
        let first = rect(16, 0, 200, 26)
        let quote = DocumentMarkerLayout(kind: .quote, depth: 1, firstLine: first, lastLine: rect(16, 52, 200, 26), origin: 0, width: 335)
        assertFrame(quote.decoration, rect(24, 0, 3, 78))
        XCTAssertNil(quote.marker)
        let code = DocumentMarkerLayout(kind: .code, depth: 0, firstLine: first, lastLine: rect(16, 34, 200, 26), origin: 0, width: 335)
        assertFrame(code.decoration, rect(0, -8, 335, 76))
    }

    func testMarkersSitLeftOfAFragmentThatStartsAtItsIndent() {
        let first = rect(0, 4, 200, 26)
        let bullet = DocumentMarkerLayout(kind: .bullet, depth: 0, firstLine: first, lastLine: first, origin: 26, width: 335)
        assertFrame(bullet.marker, rect(-20, 14, 6, 6))
        let check = DocumentMarkerLayout(kind: .check, depth: 1, firstLine: first, lastLine: first, origin: 50, width: 335)
        assertFrame(check.marker, rect(-26, 8, 18, 18))
        let quote = DocumentMarkerLayout(kind: .quote, depth: 0, firstLine: first, lastLine: first, origin: 16, width: 335)
        assertFrame(quote.decoration, rect(-16, 4, 3, 26))
        let code = DocumentMarkerLayout(kind: .code, depth: 0, firstLine: first, lastLine: rect(0, 30, 200, 26), origin: 12, width: 335)
        assertFrame(code.decoration, rect(-12, -4, 335, 68))
    }

    func testObjectsTakeTheLineLessItsIndent() {
        assertSize(DocumentObjectLayout.size(.divider(line: 26), width: 353, depth: 0), CGSize(width: 352, height: 26))
        assertSize(DocumentObjectLayout.size(.picture(nil), width: 353, depth: 1), CGSize(width: 328, height: 185))
        assertSize(DocumentObjectLayout.size(.picture(CGSize(width: 1000, height: 500)), width: 353, depth: 0), CGSize(width: 352, height: 176))
        assertSize(DocumentObjectLayout.size(.picture(CGSize(width: 100, height: 50)), width: 353, depth: 0), CGSize(width: 100, height: 50))
        assertSize(DocumentObjectLayout.size(.table(rows: 3, row: 32), width: 353, depth: 0), CGSize(width: 352, height: 96))
        assertSize(DocumentObjectLayout.size(.unsupported(height: 44), width: 353, depth: 0), CGSize(width: 352, height: 44))
        assertFrame(DocumentObjectLayout.rule(in: CGSize(width: 352, height: 26)), rect(0, 13, 352, 1))
        assertFrame(DocumentObjectLayout.centered(CGSize(width: 52, height: 20), in: CGSize(width: 352, height: 198)), rect(150, 89, 52, 20))
        assertFrame(DocumentObjectLayout.note(CGSize(width: 120, height: 20), in: CGSize(width: 352, height: 44)), rect(12, 12, 120, 20))
    }

    func testATablesGridAndCells() {
        let table = DocumentObjectLayout.Table(rows: 2, columns: 3, size: CGSize(width: 300, height: 64), textHeight: 18)
        XCTAssertEqual(table.rowLines, [32])
        XCTAssertEqual(table.columnLines, [100, 200])
        XCTAssertEqual(table.cells.count, 2)
        assertFrame(table.cells[0][0], rect(8, 7, 84, 18))
        assertFrame(table.cells[1][2], rect(208, 39, 84, 18))
        let one = DocumentObjectLayout.Table(rows: 0, columns: 0, size: CGSize(width: 300, height: 32), textHeight: 18)
        XCTAssertEqual(one.rowLines, [])
        XCTAssertEqual(one.columnLines, [])
        XCTAssertEqual(one.cells.map(\.count), [1])
    }

    func testThePhoneColumnIsTheWidthLessPadding() {
        let layout = DocumentScreenLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, bottom: 34), keyboard: 0, maxWidth: .greatestFiniteMagnitude, status: fixed(200, 40))
        assertFrame(layout.text, rect(0, 0, 393, 852))
        XCTAssertEqual(layout.inset, LayoutInsets(top: 16, left: 20, bottom: 96, right: 20))
        assertFrame(layout.status, rect(56.5, 440.5, 280, 40))
    }

    func testTheKeyboardAddsToTheBottomInset() {
        let layout = DocumentScreenLayout(size: CGSize(width: 393, height: 852), safeArea: LayoutInsets(top: 103, bottom: 34), keyboard: 336, maxWidth: .greatestFiniteMagnitude, status: fixed(200, 40))
        XCTAssertEqual(layout.inset.bottom, 96)
        XCTAssertEqual(layout.scrollBottom, 302, "the safe area is already scrolled past")
    }

    func testAnIPadKeepsAReadableColumn() {
        let layout = DocumentScreenLayout(size: CGSize(width: 1180, height: 820), safeArea: LayoutInsets(top: 74, left: 0, bottom: 20), keyboard: 0, maxWidth: 800, status: fixed(200, 40))
        XCTAssertEqual(layout.inset.left, 190)
        XCTAssertEqual(layout.inset.right, 190)
        let narrow = DocumentScreenLayout(size: CGSize(width: 700, height: 820), safeArea: LayoutInsets(left: 10, right: 10), keyboard: 0, maxWidth: 800, status: fixed(200, 40))
        XCTAssertEqual(narrow.inset.left, 30, "the padding's least")
    }

    func testToolbarButtonsScrollAndDoneStays() {
        let layout = DocumentToolbarLayout(width: 393, safeArea: .zero, count: 12)
        assertFrame(layout.done, rect(333, 2, 52, 52))
        assertFrame(layout.strip, rect(8, 2, 317, 52))
        assertFrame(layout.buttons[0], rect(4, 4, 44, 44))
        assertFrame(layout.buttons[1], rect(50, 4, 44, 44))
        XCTAssertEqual(layout.content.width, 4 + 12 * 44 + 11 * 2 + 4)
        let few = DocumentToolbarLayout(width: 393, safeArea: .zero, count: 2)
        XCTAssertEqual(few.content.width, 317, "never narrower than the strip")
    }

    func testHistoryRowsCentreTheFaceBesideTwoLines() {
        let layout = DocumentHistoryRowLayout(width: 393, safeArea: .zero, title: fixed(120, 20), detail: fixed(80, 18))
        XCTAssertEqual(layout.height, 60)
        assertFrame(layout.avatar, rect(16, 12, 36, 36))
        assertFrame(layout.title, rect(64, 10, 313, 20))
        assertFrame(layout.detail, rect(64, 32, 313, 18))
    }

    func testACursorsNameSitsAboveItAndInsideTheText() {
        let layout = DocumentCursorLayout(caret: rect(100, 40, 2, 22), name: CGSize(width: 40, height: 14), width: 353)
        assertFrame(layout.bar, rect(99, 40, 2, 22))
        assertFrame(layout.label, rect(99, 24, 48, 16))
        let atEnd = DocumentCursorLayout(caret: rect(340, 40, 2, 22), name: CGSize(width: 40, height: 14), width: 353)
        assertFrame(atEnd.label, rect(305, 24, 48, 16))
    }

    func testPeersOverlapAndCountTheRest() {
        let two = DocumentPeersLayout(count: 2, more: 20)
        XCTAssertEqual(two.faces, [rect(0, 0, 28, 28), rect(20, 0, 28, 28)])
        XCTAssertNil(two.more)
        assertSize(two.size, CGSize(width: 48, height: 28))
        let five = DocumentPeersLayout(count: 5, more: 22)
        XCTAssertEqual(five.faces.count, 3)
        assertFrame(five.more, rect(72, 0, 22, 28))
        assertSize(five.size, CGSize(width: 94, height: 28))
        assertSize(DocumentPeersLayout(count: 0, more: 0).size, .zero)
        assertFrame(DocumentPeersLayout.initial(CGSize(width: 8, height: 14), in: rect(20, 0, 28, 28)), rect(30, 7, 8, 14))
        assertFrame(DocumentPeersLayout.more(CGSize(width: 18, height: 14), in: rect(72, 0, 22, 28)), rect(72, 7, 18, 14))
        assertFrame(DocumentMarkerLayout.number(CGSize(width: 12, height: 20), in: rect(10, 4, 10, 26)), rect(8, 7, 12, 20))
    }
}
