import XCTest
import HappyLayout

final class ToolDetailLayoutTests: XCTestCase {
    func testTheHeaderCentresItsWordsOnTheTileAndEndsWithThePill() {
        let layout = ToolDetailHeaderLayout(width: 390, title: .fixed(width: 120, height: 20), subtitle: .fixed(width: 80, height: 16), pillText: CGSize(width: 60, height: 16))
        XCTAssertEqual(layout.tile, rect(14, 15, 36, 36))
        XCTAssertEqual(layout.glyph, rect(23, 24, 18, 18))
        XCTAssertEqual(layout.title, rect(62, 14, 120, 20))
        XCTAssertEqual(layout.subtitle, rect(62, 36, 80, 16))
        XCTAssertEqual(layout.pill, rect(296, 21, 80, 24))
        XCTAssertEqual(layout.pillText, rect(306, 25, 60, 16))
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 66))
    }

    func testARunningPillMakesRoomForItsSpinnerAndTheTitleWraps() {
        let title = Measurable { CGSize(width: $0, height: $0 < 200 ? 40 : 20) }
        let layout = ToolDetailHeaderLayout(width: 320, title: title, subtitle: nil, pillText: CGSize(width: 60, height: 16), pillLead: 18)
        XCTAssertEqual(layout.pill, rect(208, 22, 98, 24))
        XCTAssertEqual(layout.pillText, rect(236, 26, 60, 16))
        // What the pill leaves: 320 - 14 - 98 - 12 - 62.
        XCTAssertEqual(layout.title, rect(62, 14, 134, 40))
        XCTAssertNil(layout.subtitle)
        XCTAssertEqual(layout.tile, rect(14, 16, 36, 36))
        XCTAssertEqual(layout.glyph, rect(23, 25, 18, 18))
        XCTAssertEqual(layout.size, CGSize(width: 320, height: 68))
    }

    func testAShortValueSitsAtTheRowsEnd() {
        let layout = ToolFieldLayout(width: 300, label: .fixed(width: 60, height: 18), value: .fixed(width: 100, height: 18), inline: true, oneLine: 100)
        XCTAssertFalse(layout.stacked)
        XCTAssertEqual(layout.label, rect(0, 0, 60, 18))
        XCTAssertEqual(layout.value, rect(200, 0, 100, 18))
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 18))
    }

    func testABesideValueCentresOnItsLabel() {
        let layout = ToolFieldLayout(width: 300, label: .fixed(width: 60, height: 18), value: .fixed(width: 40, height: 22), inline: true, oneLine: 40)
        XCTAssertEqual(layout.label, rect(0, 2, 60, 18))
        XCTAssertEqual(layout.value, rect(260, 0, 40, 22))
        XCTAssertEqual(layout.size.height, 22)
    }

    func testAValueTooWideForItsLineGoesUnderTheLabel() {
        let value = Measurable { CGSize(width: $0, height: 54) }
        // 300 - 60 - 12 leaves 228, short of the line's 250.
        let layout = ToolFieldLayout(width: 300, label: .fixed(width: 60, height: 18), value: value, inline: true, oneLine: 250)
        XCTAssertTrue(layout.stacked)
        XCTAssertEqual(layout.label, rect(0, 0, 60, 18))
        XCTAssertEqual(layout.value, rect(0, 22, 300, 54))
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 76))
    }

    func testABlockAlwaysGoesUnderTheLabel() {
        let layout = ToolFieldLayout(width: 300, label: .fixed(width: 60, height: 18), value: .fixed(width: 30, height: 18), inline: false, oneLine: 30)
        XCTAssertTrue(layout.stacked)
        XCTAssertEqual(layout.value, rect(0, 22, 300, 18))
    }

    func testTheCardInsetsItsRowsAndRulesBetweenThem() {
        let layout = ToolFieldsCardLayout(width: 300, rows: [
            Measurable { CGSize(width: $0, height: 18) },
            Measurable { CGSize(width: $0, height: 40) },
        ])
        XCTAssertEqual(layout.rows, [rect(14, 11, 272, 18), rect(14, 51, 272, 40)])
        XCTAssertEqual(layout.separators, [rect(14, 40, 286, 0.5)])
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 102))
    }

    func testAnEmptyCardHasNoHeight() {
        let layout = ToolFieldsCardLayout(width: 300, rows: [])
        XCTAssertEqual(layout.rows, [])
        XCTAssertEqual(layout.size, CGSize(width: 300, height: 0))
    }
}
