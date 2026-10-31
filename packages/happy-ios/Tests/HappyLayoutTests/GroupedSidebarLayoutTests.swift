import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for home's grouped sidebar: iOS's inset grouped cards in
/// Settings' measures, a heading over each.
final class GroupedSidebarLayoutTests: XCTestCase {
    /// A third of a point: lanes and glyphs sit on 3x pixels.
    private let third: CGFloat = 1.0 / 3

    private func grouped(_ rows: [SidebarLayout.Row], width: CGFloat = 390) -> SidebarLayout.Result {
        SidebarLayout.layout(rows, width: width, top: GroupedSidebarMetrics.contentTop, bottom: GroupedSidebarMetrics.contentBottom, scale: 3, style: .grouped)
    }

    func testTheMeasuresAreSettingsCards() {
        typealias G = GroupedSidebarMetrics
        XCTAssertEqual([G.side, G.radius, G.cardGap], [16, 26, 24])
        XCTAssertEqual([G.markInset, G.endCenter, G.indent], [16, 31, 42])
        XCTAssertEqual([G.headingHeight, G.headingLine, G.headingBottom, G.headingSize, G.headingGlyph, G.headingGap], [36, 18, 7, 13, 14, 14])
        XCTAssertEqual([G.contentTop, G.contentBottom, G.storyInset], [8, 24, 4])
    }

    /// Rows before the first heading are a card of their own; each heading
    /// stands over its card; a separator only parts two cards; a folded
    /// section is its heading alone.
    func testSectionsAreCardsUnderTheirHeadings() {
        let result = grouped([
            .init(kind: .row),
            .init(kind: .row, hasFold: true),
            .init(kind: .row, depth: 1, hasTrailing: true),
            .init(kind: .section, hasMark: false),
            .init(kind: .row),
            .init(kind: .row, hasMark: false),
            .init(kind: .separator, hasMark: false),
            .init(kind: .row),
            .init(kind: .section, hasMark: false, foldClosed: true),
            .init(kind: .section, hasMark: false),
        ])
        let frames = result.frames
        XCTAssertEqual(result.groups, [
            // The unheaded card at the top, nested row and all.
            .init(frame: CGRect(x: 16, y: 8, width: 358, height: 144), rows: 0..<3),
            // 14 down from the card, the 36 heading, then its card.
            .init(frame: CGRect(x: 16, y: 202, width: 358, height: 96), rows: 4..<6),
            // A separator: Settings' 24 between two cards, and nothing drawn.
            .init(frame: CGRect(x: 16, y: 322, width: 358, height: 48), rows: 7..<8),
        ])
        XCTAssertEqual(result.connectors, [])

        // A row fills its card's width: the mark 16 into the card, the title
        // the plain row's 12 past it (riding 2 up), the trailing column's
        // middle 31 in from the card's right, as the mark's is from its left.
        XCTAssertEqual(frames[0].box, CGRect(x: 16, y: 8, width: 358, height: 48))
        XCTAssertEqual(frames[0].mark, CGRect(x: 32, y: 17, width: 30, height: 30))
        XCTAssertEqual(frames[0].label, CGRect(x: 74, y: 6, width: 282 + 2 * third, height: 48))
        // The first row rounds the card's top; a hairline from its title's
        // start to the card's end stands on its bottom edge.
        XCTAssertEqual(frames[0].cell, .init(roundsTop: true, roundsBottom: false, separator: CGRect(x: 74, y: 56 - third, width: 300, height: third)))

        // A fold takes the trailing square, its "⌄" ink centred on the column.
        XCTAssertEqual(frames[1].chevron, CGRect(x: 329 + 2 * third, y: 66 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[1].chevronGlyph, CGRect(x: 334, y: 71 + third, width: 18, height: 18))
        XCTAssertEqual(frames[1].label, CGRect(x: 74, y: 54, width: 317 + 2 * third - 74, height: 48))
        XCTAssertEqual(frames[1].cell, .init(roundsTop: false, roundsBottom: false, separator: CGRect(x: 74, y: 104 - third, width: 300, height: third)))

        // A nested row stays in its parent's card, its mark under the
        // parent's title; last in the card, it rounds the bottom and has no hairline.
        XCTAssertEqual(frames[2].mark, CGRect(x: 74, y: 113, width: 30, height: 30))
        XCTAssertEqual(frames[2].mark?.minX, frames[1].label.minX)
        XCTAssertEqual(frames[2].trailing, CGRect(x: 329 + 2 * third, y: 114 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[2].label, CGRect(x: 116, y: 102, width: 317 + 2 * third - 116, height: 48))
        XCTAssertEqual(frames[2].cell, .init(roundsTop: false, roundsBottom: true, separator: nil))

        // The heading: 36 tall over its card, its 18 title line 7 above the
        // card from where a mark starts, its smaller fold on the rows'
        // column, on the title's middle.
        XCTAssertEqual(frames[3].box, CGRect(x: 16, y: 166, width: 358, height: 36))
        XCTAssertEqual(frames[3].label, CGRect(x: 32, y: 177, width: 291 + 2 * third, height: 18))
        XCTAssertEqual(frames[3].chevron, CGRect(x: 329 + 2 * third, y: 172 + 2 * third, width: 27, height: 27))
        XCTAssertEqual(frames[3].chevronGlyph, CGRect(x: 336, y: 179 + third, width: 14, height: 14))
        XCTAssertNil(frames[3].cell)

        XCTAssertEqual(frames[4].cell, .init(roundsTop: true, roundsBottom: false, separator: CGRect(x: 74, y: 250 - third, width: 300, height: third)))
        // No mark: the title starts where the mark would, and so does nothing else.
        XCTAssertNil(frames[5].mark)
        XCTAssertEqual(frames[5].label, CGRect(x: 32, y: 248, width: 324 + 2 * third, height: 48))
        XCTAssertEqual(frames[5].cell, .init(roundsTop: false, roundsBottom: true, separator: nil))

        XCTAssertEqual(frames[6].box, CGRect(x: 16, y: 298, width: 358, height: 24))
        XCTAssertNil(frames[6].rule)
        XCTAssertNil(frames[6].cell)
        // A card of one row rounds all four corners.
        XCTAssertEqual(frames[7].cell, .init(roundsTop: true, roundsBottom: true, separator: nil))

        // A folded section is its heading alone, "›" on the column; the
        // next heading follows it at once.
        XCTAssertEqual(frames[8].box, CGRect(x: 16, y: 384, width: 358, height: 36))
        XCTAssertEqual(frames[8].chevronGlyph, CGRect(x: 336, y: 397, width: 14, height: 14))
        XCTAssertEqual(frames[9].box, CGRect(x: 16, y: 420, width: 358, height: 36))
        XCTAssertEqual(result.contentHeight, 456 + 24)
    }

    /// Each row's ends mirror each other in its card, as in the plain list.
    func testEachEndsMarkIsAsFarFromItsCardsEdge() {
        typealias M = Metrics
        for width: CGFloat in [375, 402, 440, 744] {
            let frames = grouped([.init(kind: .row, hasFold: true), .init(kind: .section, hasMark: false), .init(kind: .row, hasTrailing: true)], width: width).frames
            let card = frames[0].box
            XCTAssertEqual(card, CGRect(x: 16, y: 8, width: width - 32, height: 48))
            XCTAssertEqual(frames[0].mark!.midX - card.minX, 31)
            XCTAssertEqual(card.maxX - (frames[0].chevronGlyph!.midX + M.chevronDownInk.dx), 31, accuracy: third / 2 + 0.001)
            XCTAssertEqual(card.maxX - frames[2].trailing!.midX, 31, accuracy: third / 2 + 0.001)
            // A heading's fold and a row's stand on one column.
            XCTAssertEqual(frames[1].chevron!.midX, frames[0].chevron!.midX)
        }
    }

    /// A story row is a cell too: its own card 4 inside the cell, so its
    /// disc and corner signal keep clear of the card's corners, and the
    /// hairline from where its text starts. Headings among story rows are
    /// the grouped list's, not desktop's.
    func testStoryRowsAreCellsOfTheirCard() {
        typealias S = StoryRowMetrics
        let story = SidebarLayout.StoryRow(corner: .dot, timeWidth: 30)
        let result = grouped([
            .init(kind: .section, hasMark: false, amongStories: true),
            .init(kind: .row, story: story),
            .init(kind: .row, story: story),
        ])
        let frames = result.frames
        XCTAssertEqual(frames[0].box, CGRect(x: 16, y: 8, width: 358, height: 36))
        XCTAssertEqual(frames[1].box, CGRect(x: 16, y: 44, width: 358, height: 64))
        XCTAssertEqual(frames[2].box, CGRect(x: 16, y: 108, width: 358, height: 64))
        XCTAssertEqual(frames[1].mark, CGRect(x: 27, y: 51, width: 50, height: 50))
        XCTAssertEqual(frames[1].label.minX, 87)
        XCTAssertEqual(frames[1].signalLane, CGRect(x: 370 - S.corner - S.signal, y: 108 - S.corner - S.signal, width: S.signal, height: S.signal))
        XCTAssertEqual(frames[1].cell, .init(roundsTop: true, roundsBottom: false, separator: CGRect(x: 87, y: 108 - third, width: 287, height: third)))
        XCTAssertEqual(frames[2].cell, .init(roundsTop: false, roundsBottom: true, separator: nil))
        XCTAssertEqual(result.groups, [.init(frame: CGRect(x: 16, y: 44, width: 358, height: 128), rows: 1..<3)])
        // A larger text size grows the row, and the card with it.
        let large = SidebarLayout.StoryRow(text: .standard(scale: 1.5))
        let grown = grouped([.init(kind: .row, story: large)])
        XCTAssertEqual(grown.frames[0].box.height, SidebarLayout.storyHeight(1.5))
        XCTAssertEqual(grown.groups[0].frame.height, SidebarLayout.storyHeight(1.5))
    }

    /// Folding a section moves only what follows it, and takes its card away.
    func testFoldingMovesOnlyWhatFollows() {
        let open = grouped([.init(kind: .row), .init(kind: .section), .init(kind: .row), .init(kind: .row), .init(kind: .section), .init(kind: .row)])
        let folded = grouped([.init(kind: .row), .init(kind: .section, foldClosed: true), .init(kind: .section), .init(kind: .row)])
        XCTAssertEqual(open.frames[0], folded.frames[0])
        XCTAssertEqual(open.frames[1].box, folded.frames[1].box)
        XCTAssertEqual(open.groups.count, 3)
        XCTAssertEqual(folded.groups.count, 2)
        // Two rows and the gap from their card to the next heading.
        XCTAssertEqual(open.contentHeight - folded.contentHeight, 2 * 48 + 14)
        XCTAssertEqual(open.frames[4].box.minY - folded.frames[2].box.minY, 2 * 48 + 14)
    }

    /// The plain list is untouched by the grouped one.
    func testThePlainStyleIsTheDesktopsColumn() {
        let rows: [SidebarLayout.Row] = [.init(kind: .row), .init(kind: .section), .init(kind: .row, depth: 1)]
        let plain = SidebarLayout.layout(rows, width: 390)
        XCTAssertEqual(SidebarLayout.layout(rows, width: 390, top: Metrics.contentTop, bottom: Metrics.contentBottom, style: .plain), plain)
        XCTAssertEqual(plain.groups, [])
        XCTAssertTrue(plain.frames.allSatisfy { $0.cell == nil })
    }
}
