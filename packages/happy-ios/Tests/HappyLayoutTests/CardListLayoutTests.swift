import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the card lists home's screens use (the artifacts, the
/// Surfaces, a todo list): home's inset grouped cards, held to the
/// readable column on an iPad.
final class CardListLayoutTests: XCTestCase {
    func testTheMeasuresAreHomesCards() {
        typealias M = CardListMetrics
        XCTAssertEqual([M.side, M.radius, M.inset], [16, 26, 16])
        XCTAssertEqual([M.headingHeight, M.headingLine, M.headingBottom, M.headingGap], [36, 18, 7, 14])
        XCTAssertEqual([M.tile, M.tileGap, M.padding, M.lineGap, M.trailingGap], [40, 12, 10, 2, 8])
        XCTAssertEqual([M.tiledRow, M.plainRow], [60, 44])
    }

    private func column(_ width: CGFloat, _ maxWidth: CGFloat) -> [CGFloat] {
        let column = CardColumn(width: width, maxWidth: maxWidth)
        return [column.x, column.width]
    }

    func testTheColumnIsTheWidthOnAPhoneAndTheReadableColumnOnAnIPad() {
        XCTAssertEqual(column(390, .greatestFiniteMagnitude), [16, 358])
        XCTAssertEqual(column(1024, 800), [128, 768])
        XCTAssertEqual(column(700, 800), [16, 668])
        XCTAssertEqual(column(0, 800), [16, 0])
    }

    func testPlacesRoundTheEndsOfARun() {
        XCTAssertEqual(CardPlace.run(0), [])
        XCTAssertEqual(CardPlace.run(1), [.alone])
        XCTAssertEqual(CardPlace.run(3), [CardPlace(first: true, last: false), CardPlace(first: false, last: false), CardPlace(first: false, last: true)])
    }

    /// A tile, a title with the time beside it, a subtitle under it; the
    /// hairline runs from the text to the card's edge.
    func testATiledRowWithATime() {
        let row = CardRowLayout(
            width: 390, place: CardPlace(first: true, last: false), leading: CGSize(width: 40, height: 40),
            title: .fixed(width: 216, height: 19), subtitle: .fixed(width: 100, height: 16),
            trailing: CGSize(width: 50, height: 16), titleLine: 19, hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.size, CGSize(width: 390, height: 60))
        XCTAssertEqual(row.card, CGRect(x: 16, y: 0, width: 358, height: 60))
        XCTAssertEqual(row.leading, CGRect(x: 32, y: 10, width: 40, height: 40))
        XCTAssertEqual(row.title, CGRect(x: 84, y: 11.5, width: 216, height: 19))
        XCTAssertEqual(row.subtitle, CGRect(x: 84, y: 32.5, width: 274, height: 16))
        XCTAssertEqual(row.trailing, CGRect(x: 308, y: 13, width: 50, height: 16))
        XCTAssertEqual(row.separator, CGRect(x: 84, y: 59.5, width: 290, height: 0.5))
    }

    /// A title on three lines grows the row; the time stays on its first.
    func testALongTitleGrowsTheRowAndTheTimeStaysOnItsFirstLine() {
        let row = CardRowLayout(
            width: 390, place: .alone, leading: CGSize(width: 40, height: 40),
            title: .fixed(width: 216, height: 60), subtitle: .fixed(width: 100, height: 16),
            trailing: CGSize(width: 50, height: 16), titleLine: 19, hairline: 0.5, scale: 2
        )
        XCTAssertEqual(row.size.height, 98)
        XCTAssertEqual(row.leading, CGRect(x: 32, y: 29, width: 40, height: 40))
        XCTAssertEqual(row.title, CGRect(x: 84, y: 10, width: 216, height: 60))
        XCTAssertEqual(row.subtitle, CGRect(x: 84, y: 72, width: 274, height: 16))
        XCTAssertEqual(row.trailing, CGRect(x: 308, y: 11.5, width: 50, height: 16))
        XCTAssertNil(row.separator)
    }

    /// A plain row is iOS's 44, in the readable column on an iPad.
    func testAPlainRowInTheReadableColumn() {
        let row = CardRowLayout(width: 1024, maxWidth: 800, place: .alone, title: .fixed(width: 100, height: 19), hairline: 0.5, scale: 2)
        XCTAssertEqual(row.size, CGSize(width: 1024, height: 44))
        XCTAssertEqual(row.card, CGRect(x: 128, y: 0, width: 768, height: 44))
        XCTAssertNil(row.leading)
        XCTAssertEqual(row.title, CGRect(x: 144, y: 12.5, width: 736, height: 19))
        XCTAssertNil(row.subtitle)
        XCTAssertNil(row.trailing)
        XCTAssertNil(row.separator)
    }

    /// The title is measured at the width the trailing leaves it.
    func testTheTitleIsOfferedWhatTheTrailingLeaves() {
        var offered: CGFloat = 0
        let title = Measurable { width in offered = width; return CGSize(width: width, height: 19) }
        let row = CardRowLayout(width: 390, place: .alone, leading: CGSize(width: 40, height: 40), title: title, trailing: CGSize(width: 60, height: 16), hairline: 0.5, scale: 2)
        XCTAssertEqual(offered, 358 - 60 - 8 - 84)
        XCTAssertEqual(row.title.maxX, 290)
    }

    func testAHeadingStandsOverItsCard() {
        let first = CardHeadingLayout(width: 390, afterCard: false)
        XCTAssertEqual(first.size, CGSize(width: 390, height: 36))
        XCTAssertEqual(first.label, CGRect(x: 32, y: 11, width: 326, height: 18))
        XCTAssertEqual(first.trailingEdge, 358)
        let next = CardHeadingLayout(width: 1024, maxWidth: 800, afterCard: true)
        XCTAssertEqual(next.size, CGSize(width: 1024, height: 50))
        XCTAssertEqual(next.label, CGRect(x: 144, y: 25, width: 736, height: 18))
    }

    func testANoteIsCentredInTheColumn() {
        let note = CardNoteLayout(width: 390, text: .fixed(width: 200, height: 20))
        XCTAssertEqual(note.size, CGSize(width: 390, height: 68))
        XCTAssertEqual(note.text, CGRect(x: 95, y: 24, width: 200, height: 20))
        XCTAssertNil(note.art)
    }

    /// A scene stands centred over the words, which move down by it and
    /// its gap; the note grows by as much.
    func testANotesSceneStandsOverItsWords() {
        let note = CardNoteLayout(width: 390, text: .fixed(width: 200, height: 20), art: 128)
        XCTAssertEqual(note.art, CGRect(x: 131, y: 24, width: 128, height: 128))
        XCTAssertEqual(note.text, CGRect(x: 95, y: 168, width: 200, height: 20))
        XCTAssertEqual(note.size, CGSize(width: 390, height: 212))
        let wide = CardNoteLayout(width: 1024, maxWidth: 800, text: .fixed(width: 300, height: 40), padding: 32, art: 128)
        XCTAssertEqual(wide.art, CGRect(x: 448, y: 32, width: 128, height: 128))
        XCTAssertEqual(wide.text, CGRect(x: 362, y: 176, width: 300, height: 40))
        XCTAssertEqual(wide.size, CGSize(width: 1024, height: 248))
    }

    /// In place of a whole list the note is as tall as what the list
    /// shows, its scene and words in the middle; too tall for that, it
    /// keeps its own height.
    func testANoteInPlaceOfTheListStandsInItsMiddle() {
        let note = CardNoteLayout(width: 390, text: .fixed(width: 200, height: 20), art: 128, fill: 700)
        XCTAssertEqual(note.size, CGSize(width: 390, height: 700))
        // 212 of its own: (700 - 212) / 2 = 244 above, then the padding.
        XCTAssertEqual(note.art, CGRect(x: 131, y: 268, width: 128, height: 128))
        XCTAssertEqual(note.text, CGRect(x: 95, y: 412, width: 200, height: 20))
        XCTAssertEqual(note.art!.minY - 24, 700 - (note.text.maxY + 24), "as much room above as below")
        let odd = CardNoteLayout(width: 390, text: .fixed(width: 200, height: 20), fill: 69)
        XCTAssertEqual(odd.text, CGRect(x: 95, y: 24, width: 200, height: 20), "the odd half point goes below")
        XCTAssertEqual(odd.size.height, 69)
        let short = CardNoteLayout(width: 390, text: .fixed(width: 200, height: 20), art: 128, fill: 100)
        XCTAssertEqual(short.size.height, 212)
        XCTAssertEqual(short.art?.minY, 24)
    }
}
