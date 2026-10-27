import CoreGraphics
import HappyLayout
import XCTest

final class StemCellPickerPanelLayoutTests: XCTestCase {
    typealias Layout = StemCellPickerPanelLayout
    typealias M = StemCellPickerMetrics

    /// The screen above the composer, and a chip at its trailing end.
    let bounds = CGRect(x: 0, y: 62, width: 402, height: 800)
    let chip = CGRect(x: 280, y: 780, width: 90, height: 30)

    func testDesktopsPanelAtOneAndAQuarter() {
        XCTAssertEqual(M.row, 40)
        XCTAssertEqual(M.heading, 35)
        XCTAssertEqual(M.inset, 7.5)
        XCTAssertEqual(M.gap, 5)
        XCTAssertEqual(M.labelSize, 17.5)
        XCTAssertEqual(M.radius, 17.5)
    }

    /// Two services, each a heading over its models, a hairline between
    /// them; the benchmarks under a hairline of their own, outside the
    /// scroll. Its trailing edge on the chip's, 10 above it.
    func testTheModelListStandsOverItsChip() {
        let layout = Layout(
            items: [.heading, .row, .row, .row, .separator, .heading, .row, .row],
            footer: [.separator, .block(M.row)],
            width: M.modelsMaxWidth, over: chip, in: bounds
        )
        XCTAssertEqual(layout.frame, CGRect(x: 50, y: 423, width: 320, height: 347))
        XCTAssertEqual(layout.frame.maxX, chip.maxX)
        XCTAssertEqual(chip.minY - layout.frame.maxY, 10)
        XCTAssertEqual(layout.viewport, CGRect(x: 0, y: 7.5, width: 320, height: 281))
        XCTAssertEqual(layout.items, [
            CGRect(x: 7.5, y: 0, width: 305, height: 35),
            CGRect(x: 7.5, y: 35, width: 305, height: 40),
            CGRect(x: 7.5, y: 75, width: 305, height: 40),
            CGRect(x: 7.5, y: 115, width: 305, height: 40),
            CGRect(x: 7.5, y: 160, width: 305, height: 1),
            CGRect(x: 7.5, y: 166, width: 305, height: 35),
            CGRect(x: 7.5, y: 201, width: 305, height: 40),
            CGRect(x: 7.5, y: 241, width: 305, height: 40),
        ])
        XCTAssertEqual(layout.contentHeight, 281)
        XCTAssertEqual(layout.footer, [
            CGRect(x: 7.5, y: 293.5, width: 305, height: 1),
            CGRect(x: 7.5, y: 299.5, width: 305, height: 40),
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
        XCTAssertEqual(middle.viewport, CGRect(x: 0, y: 7.5, width: 160, height: 405))
        XCTAssertEqual(middle.contentHeight, 800)
        // Line 10's middle (420) on the viewport's (202.5).
        XCTAssertEqual(middle.initialOffset, 218)
        XCTAssertEqual(open(19).initialOffset, 395)
        XCTAssertEqual(open(0).initialOffset, 0)
        XCTAssertEqual(open(nil).initialOffset, 0)
        for index in [0, 3, 10, 16, 19] {
            let layout = open(index)
            let line = layout.items[index]
            XCTAssertGreaterThanOrEqual(line.minY, layout.initialOffset, "line \(index)")
            XCTAssertLessThanOrEqual(line.maxY, layout.initialOffset + layout.viewport.height, "line \(index)")
        }
        // Never taller than desktop's 480 at 1.25.
        let tall = Layout(items: Array(repeating: .row, count: 40), width: 300, over: CGRect(x: 280, y: 2000, width: 90, height: 30), in: CGRect(x: 0, y: 0, width: 402, height: 2000))
        XCTAssertEqual(tall.frame.height, 600)
    }

    /// A service's accounts over the model list in place: the same trailing
    /// edge and bottom, as wide as desktop's 288 at 1.25 where the screen
    /// has room.
    func testTheAccountsStackOverTheModelListInPlace() {
        let models = CGRect(x: 50, y: 423, width: 320, height: 347)
        let details = Layout.detailsHeight(lines: 2, primary: true)
        XCTAssertEqual(details, 65)
        let accounts = Layout(items: [.row, .row, .separator, .block(details)], width: M.accountsWidth, stackedOver: models, in: bounds, selected: 1)
        XCTAssertEqual(accounts.frame, CGRect(x: 10, y: 599, width: 360, height: 171))
        XCTAssertEqual(accounts.frame.maxY, models.maxY)
        XCTAssertEqual(accounts.frame.maxX, models.maxX)
        XCTAssertEqual(accounts.items, [
            CGRect(x: 7.5, y: 0, width: 345, height: 40),
            CGRect(x: 7.5, y: 40, width: 345, height: 40),
            CGRect(x: 7.5, y: 85, width: 345, height: 1),
            CGRect(x: 7.5, y: 91, width: 345, height: 65),
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

    /// A long name ends early so its check and the gauge at the line's end
    /// stay whole; a short one keeps its own width.
    func testALinesNameGivesWayToItsCheckAndGauge() {
        let line = CGRect(x: 7.5, y: 35, width: 305, height: 40)
        let check = CGSize(width: M.check, height: M.check)
        let long = StemCellPickerLineLayout(
            line: line,
            leading: [.init(CGSize(width: 400, height: 22), shrinks: true), .init(check, gapBefore: M.checkGap)],
            trailing: [.init(CGSize(width: 40, height: 15))]
        )
        XCTAssertEqual(long.trailing, [CGRect(x: 260, y: 47.5, width: 40, height: 15)])
        XCTAssertEqual(long.leading, [
            CGRect(x: 20, y: 44, width: 207.5, height: 22),
            CGRect(x: 235, y: 46.25, width: 17.5, height: 17.5),
        ])
        let short = StemCellPickerLineLayout(line: line, leading: [.init(CGSize(width: 90, height: 22), shrinks: true), .init(check, gapBefore: M.checkGap)])
        XCTAssertEqual(short.leading[0], CGRect(x: 20, y: 44, width: 90, height: 22))
        XCTAssertEqual(short.leading[1].minX, 117.5)
    }

    func testAGaugeIsItsNumberThenItsRing() {
        let gauge = StemCellUsageGaugeLayout(text: CGSize(width: 30, height: 18))
        XCTAssertEqual(gauge.text, CGRect(x: 0, y: 0, width: 30, height: 18))
        XCTAssertEqual(gauge.ring, CGRect(x: 35, y: 1.5, width: 15, height: 15))
        XCTAssertEqual(gauge.size, CGSize(width: 50, height: 18))
    }
}
