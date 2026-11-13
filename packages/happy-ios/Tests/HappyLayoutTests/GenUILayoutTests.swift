import Foundation
import HappyLayout
import XCTest

final class GenUILayoutTests: XCTestCase {
    typealias Child = GenUIBoxLayout.Child

    /// Text-like content: as wide as `width` allows up to `natural`, one
    /// 20pt line per `natural` points it has to wrap.
    private func words(_ natural: CGFloat, line: CGFloat = 20, grow: Bool = false) -> Child {
        Child(measure: { width in CGSize(width: min(width, natural), height: line * ceil(natural / max(1, width))) }, baseline: { _ in 15 }, minWidth: 40, grow: grow)
    }

    func testAPageHoldsItsDocumentInTheReadingColumn() {
        // A phone: the chat's margins either side.
        let phone = GenUIPageLayout(width: 390, maxWidth: .greatestFiniteMagnitude, margin: 16, height: 500)
        XCTAssertEqual(phone.block, CGRect(x: 16, y: 16, width: 358, height: 500))
        XCTAssertEqual(phone.contentHeight, 532)
        // A tablet: the readable column, centred.
        let pad = GenUIPageLayout(width: 1024, maxWidth: 800, margin: 16, height: 300)
        XCTAssertEqual(pad.block, CGRect(x: 128, y: 16, width: 768, height: 300))
        XCTAssertEqual(GenUIPageLayout.column(width: 1024, maxWidth: 800, margin: 16), 768)
    }

    func testAFigureTakesItsPixelRatioUpToTheCap() {
        // 1600×1067 in a phone's column: its own ratio, the column's width.
        XCTAssertEqual(GenUIMetrics.figure(width: 358, pixels: CGSize(width: 1600, height: 1067), shape: "landscape"), CGSize(width: 358, height: 239))
        // The same ratio at twice the pixels is the same box.
        XCTAssertEqual(GenUIMetrics.figure(width: 358, pixels: CGSize(width: 3200, height: 2134), shape: "landscape"), CGSize(width: 358, height: 239))
        // Twice as tall as wide in a wide column: capped, and narrowed to keep the ratio.
        XCTAssertEqual(GenUIMetrics.figure(width: 700, pixels: CGSize(width: 1000, height: 2000), shape: "portrait"), CGSize(width: 210, height: 420))
        // No usable pixels: the shape's ratio.
        XCTAssertEqual(GenUIMetrics.figure(width: 300, pixels: .zero, shape: "square"), CGSize(width: 300, height: 300))
    }

    func testCodeShowsItsLinesUpToTheCap() {
        XCTAssertEqual(GenUIMetrics.codeBody(lines: 0), 20)
        XCTAssertEqual(GenUIMetrics.codeBody(lines: 5), 100)
        XCTAssertEqual(GenUIMetrics.codeBody(lines: 20), 400)
        XCTAssertEqual(GenUIMetrics.codeBody(lines: 300), 400)
    }

    func testAColumnSkipsTheGapsOfEmptyChildren() {
        let layout = GenUIBoxLayout(
            width: 300, padding: LayoutInsets(top: 16, left: 16, bottom: 16, right: 16), row: false, gaps: [20, 20, 20],
            children: [words(100), .fixed(.zero), words(500), .fixed(CGSize(width: 20, height: 20))]
        )
        XCTAssertEqual(layout.frames[0], CGRect(x: 16, y: 16, width: 268, height: 20))
        XCTAssertEqual(layout.frames[2], CGRect(x: 16, y: 56, width: 268, height: 40))
        // A glyph keeps its own width at the leading edge.
        XCTAssertEqual(layout.frames[3], CGRect(x: 16, y: 116, width: 20, height: 20))
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 152))
        XCTAssertEqual(layout.baseline, 31)
    }

    func testARowGivesWhatIsLeftToTheChildThatGrows() {
        let layout = GenUIBoxLayout(
            width: 300, row: true, gaps: [10, 8], align: .center,
            children: [.fixed(CGSize(width: 20, height: 20)), words(120, grow: true), .fixed(CGSize(width: 60, height: 22))]
        )
        XCTAssertEqual(layout.frames.map(\.minX), [0, 30, 240])
        XCTAssertEqual(layout.frames[1].width, 202)
        XCTAssertEqual(layout.frames[0].minY, 1)
        XCTAssertEqual(layout.size.height, 22)
    }

    func testJustifyBetweenSpreadsAndTheWidestGivesWayFirst() {
        let spread = GenUIBoxLayout(width: 300, row: true, gaps: [8], justify: .between, children: [words(100), words(30)])
        XCTAssertEqual(spread.frames[1], CGRect(x: 270, y: 0, width: 30, height: 20))
        let tight = GenUIBoxLayout(width: 300, row: true, gaps: [8], align: .start, justify: .between, children: [words(400), words(30)])
        XCTAssertEqual(tight.frames[0].width, 262)
        XCTAssertEqual(tight.frames[1], CGRect(x: 270, y: 0, width: 30, height: 20))
        XCTAssertEqual(GenUIBoxLayout.fairShares([10, 500, 50], 200), [10, 140, 50])
    }

    func testFixedTextKeepsItsWidthAndTheOthersGiveWay() {
        var trailing = words(60)
        trailing.fixed = true
        let row = GenUIBoxLayout(width: 200, row: true, gaps: [8, 8], align: .start, children: [words(300), words(300), trailing])
        XCTAssertEqual(row.frames.map(\.width), [62, 62, 60])
    }

    /// A key and its fixed value: side by side while the key keeps its
    /// widest piece, else the key over the value, both at the start.
    func testAKeyTooNarrowBesideItsFixedValueGoesAboveIt() {
        var value = words(220)
        value.fixed = true
        var key = words(120, grow: true)
        key.minWidth = 70
        // 300 leaves the key 72: still a row, the key wrapping.
        let fits = GenUIBoxLayout(width: 300, row: true, gaps: [8], align: .baseline, children: [key, value])
        XCTAssertEqual(fits.frames.map(\.minX), [0, 80])
        XCTAssertEqual(fits.frames.map(\.width), [72, 220])
        // 280 would leave it 52: stacked, 2 apart.
        let stacked = GenUIBoxLayout(width: 280, row: true, gaps: [8], align: .baseline, children: [key, value])
        XCTAssertEqual(stacked.frames, [CGRect(x: 0, y: 0, width: 120, height: 20), CGRect(x: 0, y: 22, width: 220, height: 20)])
        XCTAssertEqual(stacked.size.height, 42)
        XCTAssertEqual(stacked.baseline, 15)
        // Without a fixed child the row only squeezes, as before.
        let squeezed = GenUIBoxLayout(width: 280, row: true, gaps: [8], align: .baseline, children: [key, words(220)])
        XCTAssertEqual(squeezed.frames.map(\.minY), [0, 0])
    }

    func testAnEqualRowThatMayNotWrapStaysOnOneLine() {
        let stat = Child(measure: { CGSize(width: $0, height: 50) }, minWidth: 120)
        let row = GenUIBoxLayout(width: 326, row: true, gaps: [16, 16], equal: true, wrap: false, children: [stat, stat, stat])
        XCTAssertEqual(row.frames.map(\.minY), [0, 0, 0])
        XCTAssertEqual(row.frames[0].width, 98)
    }

    func testBaselineAlignmentLinesUpFirstBaselines() {
        let big = Child(measure: { _ in CGSize(width: 60, height: 30) }, baseline: { _ in 24 }, fills: false)
        let small = Child(measure: { _ in CGSize(width: 30, height: 18) }, baseline: { _ in 13 }, fills: false)
        let layout = GenUIBoxLayout(width: 300, row: true, gaps: [8], align: .baseline, children: [big, small])
        XCTAssertEqual(layout.frames[1].minY, 11)
        XCTAssertEqual(layout.size.height, 30)
        XCTAssertEqual(layout.baseline, 24)
    }

    func testAnEqualRowWrapsWhenAShareIsTooNarrow() {
        let wide = Child(measure: { CGSize(width: $0, height: 50) }, minWidth: 120)
        let three = GenUIBoxLayout(width: 326, row: true, gaps: [16, 16], lineGap: 20, equal: true, wrap: true, children: [wide, wide, wide])
        XCTAssertEqual(three.frames.map(\.minY), [0, 0, 70])
        XCTAssertEqual(three.frames[0].width, 155)
        XCTAssertEqual(three.size.height, 120)
        let narrow = Child(measure: { CGSize(width: $0, height: 50) }, minWidth: 90)
        XCTAssertEqual(GenUIBoxLayout(width: 326, row: true, gaps: [16, 16], equal: true, wrap: true, children: [narrow, narrow, narrow]).frames.map(\.minY), [0, 0, 0])
    }

    func testAWrappingRowFlowsOntoNewLines() {
        let chip = { (width: CGFloat) in Child.fixed(CGSize(width: width, height: 36)) }
        let layout = GenUIBoxLayout(width: 300, row: true, gaps: [8, 8, 8], lineGap: 8, wrap: true, children: [chip(120), chip(120), chip(140), chip(60)])
        XCTAssertEqual(layout.frames.map(\.origin), [CGPoint(x: 0, y: 0), CGPoint(x: 128, y: 0), CGPoint(x: 0, y: 44), CGPoint(x: 148, y: 44)])
        XCTAssertEqual(layout.size.height, 80)
    }

    func testGapsFollowTheRelationAndTheRole() {
        typealias M = GenUIMetrics
        XCTAssertEqual(M.gap("related", role: "plain", row: false, divided: false, between: .text, and: .text), 2)
        XCTAssertEqual(M.gap("related", role: "plain", row: false, divided: false, between: .text, and: .graphic), 8)
        XCTAssertEqual(M.gap("tight", role: "plain", row: false, divided: false, between: .text, and: .text), 2)
        XCTAssertEqual(M.gap("heading", role: "section", row: false, divided: false, between: .text, and: .graphic), 10)
        XCTAssertEqual(M.gap("blocks", role: "card", row: false, divided: false, between: .other, and: .other), 18)
        XCTAssertEqual(M.gap("items", role: "plain", row: false, divided: true, between: .other, and: .other), 22)
        XCTAssertEqual(M.gap("inline", role: "header", row: true, divided: false, between: .text, and: .text), 10)
        XCTAssertEqual(M.padding(role: "card"), LayoutInsets(top: 16, left: 16, bottom: 16, right: 16))
        XCTAssertEqual(M.padding(role: "section"), .zero)
    }

    func testDividersSitInTheMiddleOfEachGap() {
        let frames = [CGRect(x: 0, y: 0, width: 300, height: 40), CGRect(x: 0, y: 62, width: 300, height: 40), CGRect(x: 0, y: 102, width: 300, height: 0)]
        XCTAssertEqual(GenUIDividers.frames(frames, insets: [0, 32, 0], width: 300, hairline: 1), [CGRect(x: 32, y: 50.5, width: 268, height: 1)])
    }

    func testTheMosaicFollowsTheCount() {
        XCTAssertEqual(GenUIMosaicLayout(width: 300, count: 1, ratio: 0.75).tiles, [CGRect(x: 0, y: 0, width: 300, height: 225)])
        XCTAssertEqual(GenUIMosaicLayout(width: 302, count: 2, ratio: 0.75).tiles.map(\.size), [CGSize(width: 150, height: 150), CGSize(width: 150, height: 150)])
        let three = GenUIMosaicLayout(width: 302, count: 3, ratio: 0.75)
        XCTAssertEqual(three.tiles[0], CGRect(x: 0, y: 0, width: 200, height: 150))
        XCTAssertEqual(three.tiles[2].maxY, 150)
        XCTAssertEqual(GenUIMosaicLayout(width: 302, count: 4, ratio: 0.75).size.height, 228)
        let five = GenUIMosaicLayout(width: 302, count: 5, ratio: 0.75)
        XCTAssertEqual(five.tiles.count, 5)
        XCTAssertEqual(five.tiles[2].minY, five.tiles[0].maxY + 2)
        XCTAssertEqual(GenUIMosaicLayout(width: 302, count: 9, ratio: 0.75).tiles.count, 5)
    }

    func testTheCarouselSizesCardsByShape() {
        let landscape = GenUICarouselLayout(viewport: 390, inset: 16, shape: "landscape", count: 3) { _ in 200 }
        XCTAssertEqual(landscape.cardWidth, 278)
        XCTAssertEqual(landscape.cards[1].minX, 306)
        XCTAssertEqual(landscape.stops, [0, 290, 500])
        XCTAssertEqual(GenUICarouselLayout(viewport: 390, inset: 16, shape: "portrait", count: 3) { _ in 200 }.cardWidth, 215)
        XCTAssertEqual(GenUICarouselLayout(viewport: 390, inset: 16, shape: "landscape", count: 1) { _ in 200 }.cardWidth, 358)
        XCTAssertEqual(landscape.stop(proposed: 100, velocity: 1, current: 0), 290)
    }

    func testAGridSizesAutoColumnsToTheirWidestCell() {
        let natural: [CGSize] = [CGSize(width: 80, height: 20), CGSize(width: 40, height: 20), CGSize(width: 120, height: 20), CGSize(width: 60, height: 20)]
        let layout = GenUIGridLayout(
            width: 300, columns: [.init(fills: false), .init(fills: true, end: true)], count: 4, density: "pairs", header: false,
            natural: { index, width in CGSize(width: min(width, natural[index].width), height: natural[index].height) }, fills: { _ in false }
        )
        XCTAssertEqual(layout.cells[0], CGRect(x: 0, y: 5, width: 80, height: 20))
        XCTAssertEqual(layout.cells[1], CGRect(x: 260, y: 5, width: 40, height: 20))
        XCTAssertEqual(layout.cells[2].width, 120)
        XCTAssertEqual(layout.rows.map(\.minY), [0, 30])
        XCTAssertEqual(layout.size.height, 60)
    }
}
