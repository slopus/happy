import XCTest
@testable import HappyLayout

final class UsageActivityLayoutTests: XCTestCase {
    func testYearStartsOnItsFirstWeekdayWithMondayOnTop() {
        // Ten days from a Thursday; the 1st is the sixth of them.
        let grid = UsageGridLayout(count: 10, firstWeekday: 3, variant: .year, monthStarts: [0, 5], monthWidths: [20, 22], weekdayWidth: 18)
        XCTAssertEqual(grid.columns, 2)
        XCTAssertEqual(grid.cells[0], CGRect(x: 0, y: 56, width: 10, height: 10), "Thursday, under the month row")
        XCTAssertEqual(grid.cells[3], CGRect(x: 0, y: 92, width: 10, height: 10), "Sunday at the bottom")
        XCTAssertEqual(grid.cells[4], CGRect(x: 12, y: 20, width: 10, height: 10), "Monday tops the next week")
        XCTAssertEqual(grid.cells[9], CGRect(x: 12, y: 80, width: 10, height: 10))
        // The first month's name has one column before the next: it gives way.
        XCTAssertEqual(grid.months, [.init(index: 1, frame: CGRect(x: 12, y: 0, width: 22, height: 16))])
        XCTAssertEqual(grid.weekdays, [
            CGRect(x: 0, y: 20, width: 18, height: 10),
            CGRect(x: 0, y: 44, width: 18, height: 10),
            CGRect(x: 0, y: 68, width: 18, height: 10),
        ])
        XCTAssertEqual(grid.plot, CGSize(width: 34, height: 102), "the last name runs past the weeks")
    }

    func testMonthNamesNeedThreeColumns() {
        // From a Monday: 1sts on days 0, 21 (column 3) and 35 (column 5).
        let grid = UsageGridLayout(count: 50, firstWeekday: 0, variant: .year, monthStarts: [0, 21, 35], monthWidths: [20, 21, 22])
        XCTAssertEqual(grid.months.map(\.index), [0, 2])
        XCTAssertEqual(grid.months.map(\.frame.minX), [0, 60])
        XCTAssertEqual(grid.columns, 8)
        XCTAssertEqual(grid.plot.width, 94)
    }

    func testAFullYearIsFiftyThreeWeeks() {
        let grid = UsageGridLayout(count: 371, firstWeekday: 0, variant: .year, weekdayWidth: 18)
        XCTAssertEqual(grid.columns, 53)
        XCTAssertEqual(grid.plot, CGSize(width: 634, height: 102))
        XCTAssertEqual(grid.cells.last, CGRect(x: 624, y: 92, width: 10, height: 10))
    }

    func testTappingFindsTheDay() {
        let grid = UsageGridLayout(count: 10, firstWeekday: 3, variant: .year)
        XCTAssertEqual(grid.day(at: CGPoint(x: 13, y: 21)), 4)
        XCTAssertEqual(grid.day(at: CGPoint(x: 11, y: 57)), 0, "the gap after a cell is that cell's")
        XCTAssertEqual(grid.day(at: CGPoint(x: 12, y: 85)), 9)
        XCTAssertNil(grid.day(at: CGPoint(x: 1, y: 21)), "the blank cells above the first day")
        XCTAssertNil(grid.day(at: CGPoint(x: 12, y: 95)), "past the last day")
        XCTAssertNil(grid.day(at: CGPoint(x: 5, y: 10)), "the month row")
        XCTAssertNil(grid.day(at: CGPoint(x: -1, y: 30)))
    }

    func testStripIsOneRowWithoutLabels() {
        let strip = UsageGridLayout(count: 30, firstWeekday: 4, variant: .strip, monthStarts: [0, 3], monthWidths: [20, 20], weekdayWidth: 18)
        XCTAssertEqual(strip.cells[0], CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(strip.cells[29], CGRect(x: 348, y: 0, width: 10, height: 10))
        XCTAssertEqual(strip.months, [])
        XCTAssertEqual(strip.weekdays, [])
        XCTAssertEqual(strip.plot, CGSize(width: 358, height: 10))
        XCTAssertEqual(strip.day(at: CGPoint(x: 359, y: 5)), 29)
        XCTAssertNil(strip.day(at: CGPoint(x: 360, y: 5)))
        XCTAssertNil(strip.day(at: CGPoint(x: 5, y: 12)))
        XCTAssertEqual(UsageGridLayout(count: 0, firstWeekday: 0, variant: .year).plot, .zero)
    }

    func testTooWideTheWeeksScrollAndOpenOnToday() {
        let year = UsageGridLayout(count: 371, firstWeekday: 0, variant: .year)
        let phone = UsageGridFrame(grid: year, width: 338, weekdayWidth: 18, top: 16)
        XCTAssertEqual(phone.weekdays, CGRect(x: 0, y: 16, width: 18, height: 102))
        XCTAssertEqual(phone.viewport, CGRect(x: 24, y: 16, width: 310, height: 102), "26 whole weeks")
        XCTAssertEqual(phone.offset, 324)
        let tablet = UsageGridFrame(grid: year, width: 736, weekdayWidth: 18)
        XCTAssertEqual(tablet.viewport, CGRect(x: 24, y: 0, width: 634, height: 102))
        XCTAssertEqual(tablet.offset, 0)
        let strip = UsageGridFrame(grid: UsageGridLayout(count: 30, firstWeekday: 0, variant: .strip), width: 338, weekdayWidth: 18)
        XCTAssertEqual(strip.weekdays.width, 0)
        XCTAssertEqual(strip.viewport, CGRect(x: 0, y: 0, width: 334, height: 10), "28 whole days")
        XCTAssertEqual(strip.offset, 24)
    }

    func testCalloutSitsOverItsCellInsideTheBounds() {
        let bounds = CGRect(x: 0, y: 0, width: 400, height: 800)
        let models = [(id: CGSize(width: 110, height: 16), value: CGSize(width: 30, height: 16))]
        let callout = UsageCalloutLayout(cell: CGRect(x: 100, y: 200, width: 10, height: 10), bounds: bounds, title: CGSize(width: 120, height: 16), total: CGSize(width: 80, height: 16), models: models)
        XCTAssertEqual(callout.frame, CGRect(x: 21, y: 130, width: 168, height: 64))
        XCTAssertEqual(callout.title, CGRect(x: 8, y: 6, width: 120, height: 16))
        XCTAssertEqual(callout.total, CGRect(x: 8, y: 24, width: 80, height: 16))
        XCTAssertEqual(callout.models, [.init(id: CGRect(x: 8, y: 42, width: 110, height: 16), value: CGRect(x: 130, y: 42, width: 30, height: 16))])

        let high = UsageCalloutLayout(cell: CGRect(x: 100, y: 20, width: 10, height: 10), bounds: bounds, title: CGSize(width: 120, height: 16), total: CGSize(width: 80, height: 16), models: models)
        XCTAssertEqual(high.frame.minY, 36, "no room above: under the cell")
        let edge = UsageCalloutLayout(cell: CGRect(x: 390, y: 200, width: 10, height: 10), bounds: bounds, title: CGSize(width: 120, height: 16), total: CGSize(width: 80, height: 16), models: models)
        XCTAssertEqual(edge.frame.minX, 224, "kept inside the right edge")
        let start = UsageCalloutLayout(cell: CGRect(x: 0, y: 200, width: 10, height: 10), bounds: CGRect(x: -20, y: 0, width: 400, height: 800), title: CGSize(width: 120, height: 16), total: CGSize(width: 80, height: 16), models: [])
        XCTAssertEqual(start.frame, CGRect(x: -12, y: 148, width: 136, height: 46), "kept inside the left edge")

        let long = UsageCalloutLayout(cell: CGRect(x: 100, y: 200, width: 10, height: 10), bounds: bounds, title: CGSize(width: 120, height: 16), total: CGSize(width: 80, height: 16), models: [(CGSize(width: 400, height: 16), CGSize(width: 30, height: 16))])
        XCTAssertEqual(long.frame.width, 280)
        XCTAssertEqual(long.models[0].id.width, 222, "a long model gives way to its number")
        XCTAssertEqual(long.models[0].value.maxX, 272)
    }

    func testAccountStacksNameStripWindowsAndModels() {
        let layout = UsageAccountLayout(
            width: 338, name: CGSize(width: 100, height: 18), plan: CGSize(width: 40, height: 16), stripHeight: 10,
            limits: [
                .init(label: CGSize(width: 40, height: 16), resets: CGSize(width: 110, height: 16), gauge: CGSize(width: 70, height: 16)),
                .init(label: CGSize(width: 50, height: 16), resets: nil, gauge: CGSize(width: 70, height: 16)),
            ],
            notes: 1,
            models: [(CGSize(width: 100, height: 16), CGSize(width: 200, height: 16)), (CGSize(width: 150, height: 16), CGSize(width: 200, height: 16))]
        )
        XCTAssertEqual(layout.name, CGRect(x: 0, y: 17, width: 100, height: 18))
        XCTAssertEqual(layout.plan, CGRect(x: 108, y: 18, width: 40, height: 16))
        XCTAssertEqual(layout.strip, CGRect(x: 0, y: 42, width: 338, height: 10))
        XCTAssertEqual(layout.limits, [
            .init(label: CGRect(x: 0, y: 60, width: 40, height: 16), resets: CGRect(x: 56, y: 60, width: 110, height: 16), gauge: CGRect(x: 268, y: 60, width: 70, height: 16)),
            .init(label: CGRect(x: 0, y: 80, width: 50, height: 16), resets: nil, gauge: CGRect(x: 268, y: 80, width: 70, height: 16)),
        ])
        XCTAssertEqual(layout.notes, [CGRect(x: 0, y: 98, width: 338, height: 20)])
        XCTAssertEqual(layout.models, [
            .init(id: CGRect(x: 0, y: 128, width: 100, height: 16), totals: CGRect(x: 138, y: 128, width: 200, height: 16), stacked: false),
            .init(id: CGRect(x: 0, y: 146, width: 150, height: 16), totals: CGRect(x: 138, y: 164, width: 200, height: 16), stacked: true),
        ])
        XCTAssertEqual(layout.height, 196)
    }

    func testAccountWithOnlyAName() {
        let layout = UsageAccountLayout(width: 338, name: CGSize(width: 400, height: 18), plan: CGSize(width: 40, height: 16), stripHeight: nil, limits: [], notes: 0, models: [])
        XCTAssertEqual(layout.name.width, 290, "the name gives way to the plan")
        XCTAssertEqual(layout.plan?.minX, 298)
        XCTAssertNil(layout.strip)
        XCTAssertEqual(layout.height, 52)
    }

    func testResetsGiveWayToTheGauge() {
        let layout = UsageAccountLayout(width: 200, name: CGSize(width: 50, height: 18), plan: nil, stripHeight: nil,
                                        limits: [.init(label: CGSize(width: 60, height: 16), resets: CGSize(width: 150, height: 16), gauge: CGSize(width: 70, height: 16))], notes: 0, models: [])
        XCTAssertEqual(layout.limits[0].resets, CGRect(x: 68, y: 44, width: 54, height: 16), "past a label wider than the column")
        XCTAssertNil(layout.plan)
    }

    func testPageStacksSectionsWithTheirCards() {
        let page = UsagePageLayout(width: 402, sections: [.init(title: 18, subtitle: 16, blocks: [134]), .init(title: 18, blocks: [100, 80])])
        XCTAssertEqual(UsagePageLayout.innerWidth(402), 338)
        XCTAssertEqual(page.sections, [
            .init(title: CGRect(x: 32, y: 20, width: 338, height: 18), subtitle: CGRect(x: 32, y: 40, width: 338, height: 16),
                  card: CGRect(x: 16, y: 64, width: 370, height: 134), blocks: [CGRect(x: 16, y: 0, width: 338, height: 134)], separators: []),
            .init(title: CGRect(x: 32, y: 222, width: 338, height: 18), subtitle: nil,
                  card: CGRect(x: 16, y: 248, width: 370, height: 180),
                  blocks: [CGRect(x: 16, y: 0, width: 338, height: 100), CGRect(x: 16, y: 100, width: 338, height: 80)],
                  separators: [CGRect(x: 16, y: 100, width: 338, height: UsageMetrics.separator)]),
        ])
        XCTAssertEqual(page.contentHeight, 460)
        XCTAssertEqual(UsagePageLayout(width: 402, sections: []).contentHeight, 0)
    }

    func testEmptyIsCentredBetweenTheBars() {
        let empty = UsageEmptyLayout(size: CGSize(width: 402, height: 800), insets: LayoutInsets(top: 100, left: 0, bottom: 34, right: 0), title: CGSize(width: 100, height: 22), body: CGSize(width: 338, height: 40))
        XCTAssertEqual(empty.title, CGRect(x: 32, y: 399, width: 338, height: 22))
        XCTAssertEqual(empty.body, CGRect(x: 32, y: 427, width: 338, height: 40))
    }
}
