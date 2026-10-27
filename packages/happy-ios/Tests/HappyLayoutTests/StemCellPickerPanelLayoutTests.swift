import CoreGraphics
import HappyLayout
import XCTest

final class StemCellPickerPanelLayoutTests: XCTestCase {
    typealias Layout = StemCellPickerPanelLayout
    typealias M = StemCellPickerMetrics

    /// The screen above the composer, and a chip at its trailing end.
    let bounds = CGRect(x: 0, y: 62, width: 402, height: 800)
    let chip = CGRect(x: 280, y: 780, width: 90, height: 30)

    func testAMenusSizes() {
        XCTAssertEqual(M.row, 44)
        XCTAssertEqual(M.heading, 32)
        XCTAssertEqual(M.inset, 8)
        XCTAssertEqual(M.gap, 5)
        XCTAssertEqual(M.labelSize, 17)
        XCTAssertEqual(M.radius, 24)
        XCTAssertEqual(M.modelsMaxWidth, 250)
        XCTAssertEqual(M.accountsMinWidth, 250)
        XCTAssertEqual(M.accountsMaxWidth, 280)
    }

    /// Two services, each a heading over its models, a hairline between
    /// them; the benchmarks under a hairline of their own, outside the
    /// scroll. Its trailing edge on the chip's, 10 above it, a menu's 250 wide.
    func testTheModelListStandsOverItsChip() {
        let layout = Layout(
            items: [.heading, .row, .row, .row, .separator, .heading, .row, .row],
            footer: [.separator, .block(M.row)],
            width: M.modelsMaxWidth, over: chip, in: bounds
        )
        XCTAssertEqual(layout.frame, CGRect(x: 120, y: 404, width: 250, height: 366))
        XCTAssertEqual(layout.frame.maxX, chip.maxX)
        XCTAssertEqual(chip.minY - layout.frame.maxY, 10)
        XCTAssertEqual(layout.viewport, CGRect(x: 0, y: 8, width: 250, height: 295))
        XCTAssertEqual(layout.items, [
            CGRect(x: 8, y: 0, width: 234, height: 32),
            CGRect(x: 8, y: 32, width: 234, height: 44),
            CGRect(x: 8, y: 76, width: 234, height: 44),
            CGRect(x: 8, y: 120, width: 234, height: 44),
            CGRect(x: 8, y: 169, width: 234, height: 1),
            CGRect(x: 8, y: 175, width: 234, height: 32),
            CGRect(x: 8, y: 207, width: 234, height: 44),
            CGRect(x: 8, y: 251, width: 234, height: 44),
        ])
        XCTAssertEqual(layout.contentHeight, 295)
        XCTAssertEqual(layout.footer, [
            CGRect(x: 8, y: 308, width: 234, height: 1),
            CGRect(x: 8, y: 314, width: 234, height: 44),
        ])
        XCTAssertEqual(layout.footer.last!.maxY + M.inset, layout.frame.height)
        XCTAssertEqual(layout.initialOffset, 0)
    }

    /// A list longer than the room over the chip scrolls, and opens on the
    /// picked line: centred, the offset kept inside the list.
    func testALongListOpensOnThePickedLine() {
        let rows = Array(repeating: Layout.Item.row, count: 20)
        let low = CGRect(x: 280, y: 500, width: 90, height: 30)
        func open(_ selected: Int?) -> Layout { Layout(items: rows, width: M.effortsMinWidth, over: low, in: bounds, selected: selected) }
        let middle = open(10)
        // 490 down to 8 under the top of the room: 420 tall.
        XCTAssertEqual(middle.frame, CGRect(x: 210, y: 70, width: 160, height: 420))
        XCTAssertEqual(middle.viewport, CGRect(x: 0, y: 8, width: 160, height: 404))
        XCTAssertEqual(middle.contentHeight, 880)
        // Line 10's middle (462) on the viewport's (202).
        XCTAssertEqual(middle.initialOffset, 260)
        XCTAssertEqual(open(19).initialOffset, 476)
        XCTAssertEqual(open(0).initialOffset, 0)
        XCTAssertEqual(open(nil).initialOffset, 0)
        for index in [0, 3, 10, 16, 19] {
            let layout = open(index)
            let line = layout.items[index]
            XCTAssertGreaterThanOrEqual(line.minY, layout.initialOffset, "line \(index)")
            XCTAssertLessThanOrEqual(line.maxY, layout.initialOffset + layout.viewport.height, "line \(index)")
        }
        // Never taller than 560.
        let tall = Layout(items: Array(repeating: .row, count: 40), width: 300, over: CGRect(x: 280, y: 2000, width: 90, height: 30), in: CGRect(x: 0, y: 0, width: 402, height: 2000))
        XCTAssertEqual(tall.frame.height, 560)
    }

    /// A service's accounts over the model list in place: the same trailing
    /// edge and bottom, a menu's 250 wide.
    func testTheAccountsStackOverTheModelListInPlace() {
        let models = CGRect(x: 120, y: 404, width: 250, height: 366)
        let details = Layout.detailsHeight(lines: 2, primary: true)
        XCTAssertEqual(details, 59)
        let accounts = Layout(items: [.row, .row, .separator, .block(details)], width: M.accountsMinWidth, stackedOver: models, in: bounds, selected: 1)
        XCTAssertEqual(accounts.frame, CGRect(x: 120, y: 596, width: 250, height: 174))
        XCTAssertEqual(accounts.frame.maxY, models.maxY)
        XCTAssertEqual(accounts.frame.maxX, models.maxX)
        XCTAssertEqual(accounts.items, [
            CGRect(x: 8, y: 0, width: 234, height: 44),
            CGRect(x: 8, y: 44, width: 234, height: 44),
            CGRect(x: 8, y: 93, width: 234, height: 1),
            CGRect(x: 8, y: 99, width: 234, height: 59),
        ])
        XCTAssertEqual(accounts.initialOffset, 0)
    }

    /// Kept 8 inside the screen at both sides.
    func testAPanelKeepsInsideTheScreen() {
        let edge = Layout(items: [.row], width: M.modelsMaxWidth, over: CGRect(x: 360, y: 780, width: 42, height: 30), in: bounds)
        XCTAssertEqual(edge.frame.maxX, 394)
        let wide = Layout(items: [.row], width: 500, over: chip, in: bounds)
        XCTAssertEqual(wide.frame.minX, 8)
        XCTAssertEqual(wide.frame.width, 386)
    }

    /// A long name ends early so the gauge at the line's end stays whole;
    /// a short one keeps its own width. The name stands past the check's
    /// column: the line it is laid in starts there.
    func testALinesNameGivesWayToItsGauge() {
        let row = CGRect(x: 8, y: 32, width: 234, height: 44)
        let named = CGRect(x: row.minX + M.checkColumn, y: row.minY, width: row.width - M.checkColumn, height: row.height)
        let long = StemCellPickerLineLayout(
            line: named,
            leading: [.init(CGSize(width: 400, height: 22), shrinks: true)],
            trailing: [.init(CGSize(width: 40, height: 15))]
        )
        XCTAssertEqual(long.trailing, [CGRect(x: 190, y: 46.5, width: 40, height: 15)])
        // From 8 + 23 + 12 to 8 before the gauge.
        XCTAssertEqual(long.leading, [CGRect(x: 43, y: 43, width: 139, height: 22)])
        let short = StemCellPickerLineLayout(line: named, leading: [.init(CGSize(width: 90, height: 22), shrinks: true)])
        XCTAssertEqual(short.leading, [CGRect(x: 43, y: 43, width: 90, height: 22)])
        // A heading's account gives way to its chevron, at most 110 wide.
        let heading = StemCellPickerLineLayout(
            line: row,
            leading: [.init(CGSize(width: 60, height: 16)), .init(CGSize(width: 200, height: 16), maxWidth: M.accountMax, shrinks: true, gapBefore: M.headingGap)],
            trailing: [.init(CGSize(width: M.chevron, height: M.chevron))],
            trailingGap: M.headingGap
        )
        XCTAssertEqual(heading.trailing, [CGRect(x: 217, y: 47.5, width: 13, height: 13)])
        XCTAssertEqual(heading.leading, [CGRect(x: 20, y: 46, width: 60, height: 16), CGRect(x: 85, y: 46, width: 110, height: 16)])
        // With no room for both, the account goes before the service.
        let tight = StemCellPickerLineLayout(
            line: CGRect(x: 0, y: 0, width: 120, height: 32),
            leading: [.init(CGSize(width: 70, height: 16), shrinks: true), .init(CGSize(width: 60, height: 16), shrinks: true, gapBefore: 5)],
            trailing: [.init(CGSize(width: 13, height: 13))],
            trailingGap: 5
        )
        // 12 to 120 − 12 − 13 − 5 = 90: 78 for 70 + 5 + 60.
        XCTAssertEqual(tight.leading.map(\.width), [70, 3])
        let tighter = StemCellPickerLineLayout(
            line: CGRect(x: 0, y: 0, width: 80, height: 32),
            leading: [.init(CGSize(width: 70, height: 16), shrinks: true), .init(CGSize(width: 60, height: 16), shrinks: true, gapBefore: 5)],
            trailing: [.init(CGSize(width: 13, height: 13))],
            trailingGap: 5
        )
        XCTAssertEqual(tighter.leading.map(\.width), [33, 0])
    }

    func testAGaugeIsItsNumberThenItsRing() {
        let gauge = StemCellUsageGaugeLayout(text: CGSize(width: 30, height: 18))
        XCTAssertEqual(gauge.text, CGRect(x: 0, y: 0, width: 30, height: 18))
        XCTAssertEqual(gauge.ring, CGRect(x: 34, y: 2.5, width: 13, height: 13))
        XCTAssertEqual(gauge.size, CGSize(width: 47, height: 18))
    }
}
