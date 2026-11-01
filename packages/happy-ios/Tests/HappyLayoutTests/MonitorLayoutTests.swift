import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Exact frames for the System Monitor's card rows on a 390-point phone
/// at 2x, and the readable column on an iPad.
final class MonitorLayoutTests: XCTestCase {
    func testAReadingWithItsChartAndBars() {
        let layout = MonitorSummaryLayout(
            width: 390, place: CardPlace(first: true, last: false),
            title: .fixed(width: 30, height: 18), value: .fixed(width: 70, height: 26), subtitle: .fixed(width: 100, height: 16),
            chart: true, bars: true, hairline: 0.5, scale: 2
        )
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 204))
        XCTAssertEqual(layout.card, CGRect(x: 16, y: 0, width: 358, height: 204))
        XCTAssertEqual(layout.tile, CGRect(x: 32, y: 14, width: 30, height: 30))
        XCTAssertEqual(layout.title, CGRect(x: 72, y: 20, width: 208, height: 18))
        XCTAssertEqual(layout.value, CGRect(x: 288, y: 16, width: 70, height: 26))
        XCTAssertEqual(layout.subtitle, CGRect(x: 32, y: 52, width: 326, height: 16))
        XCTAssertEqual(layout.chart, CGRect(x: 32, y: 80, width: 326, height: 72))
        XCTAssertEqual(layout.bars, CGRect(x: 32, y: 162, width: 326, height: 28))
        XCTAssertEqual(layout.separator, CGRect(x: 32, y: 203.5, width: 342, height: 0.5))
    }

    func testAReadingWithoutBarsInTheReadableColumn() {
        let layout = MonitorSummaryLayout(
            width: 1024, maxWidth: 800, place: .alone,
            title: .fixed(width: 30, height: 18), value: .fixed(width: 70, height: 26), subtitle: .fixed(width: 100, height: 16),
            chart: true, bars: false, hairline: 0.5, scale: 2
        )
        XCTAssertEqual(layout.card, CGRect(x: 128, y: 0, width: 768, height: 166))
        XCTAssertEqual(layout.tile.minX, 144)
        XCTAssertEqual(layout.value.maxX, 880)
        XCTAssertEqual(layout.chart, CGRect(x: 144, y: 80, width: 736, height: 72))
        XCTAssertNil(layout.bars)
        XCTAssertNil(layout.separator)
    }

    func testADetailWithAMeterAndANote() {
        let layout = MonitorDetailLayout(
            width: 390, place: CardPlace(first: false, last: false),
            label: .fixed(width: 100, height: 19), value: .fixed(width: 60, height: 19), meter: true, note: .fixed(width: 120, height: 16),
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(layout.size.height, 69)
        XCTAssertNil(layout.dot)
        XCTAssertEqual(layout.label, CGRect(x: 32, y: 10, width: 258, height: 19))
        XCTAssertEqual(layout.value, CGRect(x: 298, y: 10, width: 60, height: 19))
        XCTAssertEqual(layout.meter, CGRect(x: 32, y: 35, width: 326, height: 4))
        XCTAssertEqual(layout.note, CGRect(x: 32, y: 43, width: 326, height: 16))
        XCTAssertEqual(layout.separator, CGRect(x: 32, y: 68.5, width: 342, height: 0.5))
    }

    /// A plain detail is 40 tall; a dot moves its label over.
    func testAPlainDetailWithADot() {
        let layout = MonitorDetailLayout(
            width: 390, place: CardPlace(first: false, last: true), dot: true,
            label: .fixed(width: 100, height: 19), value: .fixed(width: 60, height: 19), meter: false,
            hairline: 0.5, scale: 2
        )
        XCTAssertEqual(layout.size.height, 40)
        XCTAssertEqual(layout.dot, CGRect(x: 32, y: 16, width: 8, height: 8))
        XCTAssertEqual(layout.label, CGRect(x: 46, y: 10.5, width: 244, height: 19))
        XCTAssertEqual(layout.value, CGRect(x: 298, y: 10.5, width: 60, height: 19))
        XCTAssertNil(layout.meter)
        XCTAssertNil(layout.note)
        XCTAssertNil(layout.separator)
    }

    /// The sparklines stand in one column whatever the percentage's width.
    func testAProcessKeepsItsSparklineColumn() {
        let wide = MonitorProcessLayout(
            width: 390, place: .alone, name: .fixed(width: 80, height: 19), cpu: CGSize(width: 40, height: 19), cpuWidth: 52,
            meta: .fixed(width: 150, height: 16), memory: CGSize(width: 50, height: 16), hairline: 0.5, scale: 2
        )
        XCTAssertEqual(wide.size.height, 57)
        XCTAssertEqual(wide.name, CGRect(x: 32, y: 10, width: 214, height: 19))
        XCTAssertEqual(wide.spark, CGRect(x: 254, y: 11.5, width: 44, height: 16))
        XCTAssertEqual(wide.cpu, CGRect(x: 318, y: 10, width: 40, height: 19))
        XCTAssertEqual(wide.meta, CGRect(x: 32, y: 31, width: 268, height: 16))
        XCTAssertEqual(wide.memory, CGRect(x: 308, y: 31, width: 50, height: 16))
        XCTAssertNil(wide.separator)
        let narrow = MonitorProcessLayout(
            width: 390, place: CardPlace(first: true, last: false), name: .fixed(width: 80, height: 19), cpu: CGSize(width: 30, height: 19), cpuWidth: 52,
            meta: .fixed(width: 150, height: 16), memory: CGSize(width: 50, height: 16), hairline: 0.5, scale: 2
        )
        XCTAssertEqual(narrow.spark, wide.spark)
        XCTAssertEqual(narrow.cpu.maxX, 358)
        XCTAssertEqual(narrow.separator, CGRect(x: 32, y: 56.5, width: 342, height: 0.5))
    }

    func testTheHost() {
        let layout = MonitorHostLayout(
            width: 390, title: .fixed(width: 150, height: 27), titleLine: 27,
            meta: .fixed(width: 200, height: 16), status: CGSize(width: 30, height: 16), scale: 2
        )
        XCTAssertEqual(layout.size, CGSize(width: 390, height: 73))
        XCTAssertEqual(layout.title, CGRect(x: 32, y: 14, width: 274, height: 27))
        XCTAssertEqual(layout.status, CGRect(x: 328, y: 19.5, width: 30, height: 16))
        XCTAssertEqual(layout.dot, CGRect(x: 314, y: 23.5, width: 8, height: 8))
        XCTAssertEqual(layout.meta, CGRect(x: 32, y: 43, width: 326, height: 16))
    }
}
