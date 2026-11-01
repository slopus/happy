import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Settings › Connection on a 393-wide phone: cards 361 wide, 16 in; rows
/// 16 in from the card's sides, so 329 for a title and its value.
final class ConnectionLayoutTests: XCTestCase {
    private func title(_ string: String) -> Measurable { text(string, lineHeight: 22) }
    private func line(_ string: String) -> Measurable { text(string, lineHeight: 22, maxLines: 1) }
    private func note(_ string: String) -> Measurable { text(string, lineHeight: 16) }

    private var layout: ConnectionLayout {
        ConnectionLayout(width: 393, cards: [
            .init(header: note("STATUS"), rows: [
                // 31 characters, 248 wide: fits the 285 beside "Type".
                .text(title: line("Type"), value: line("Tailcat · relayed via Frankfurt")),
                // 36 characters, 288 wide: over the 261 beside "Network", so cut to 261, one line.
                .text(title: line("Network"), value: line("Cellular · expensive · Low Data Mode")),
                // A 240-wide title would leave the value 77: the value keeps
                // half, 164.5, and the title is cut to 152.5.
                .text(title: line("A title as long as thirty chs"), value: line("A value as long as thirty chs")),
                // A short value and a long title: the title keeps its 240.
                .text(title: line("A title as long as thirty chs"), value: line("x")),
            ]),
            .init(header: note("LAST 10 MINUTES"), rows: [
                .chart(title: title("Bytes per minute"), caption: note("peak 12 KB")),
                .text(title: title("Copy Diagnostics"), value: nil),
            ], footer: note("Counting.  ")),
        ])
    }

    func testTheCardsStackWithTheirHeadersAndFooters() {
        let layout = layout
        XCTAssertEqual(layout.cards.count, 2)
        assertFrame(layout.cards[0].header, rect(32, 20, 48, 16))
        assertFrame(layout.cards[0].frame, rect(16, 42, 361, 176))
        XCTAssertNil(layout.cards[0].footer)
        // 24 under the first card, the header, 6, the card.
        assertFrame(layout.cards[1].header, rect(32, 242, 120, 16))
        assertFrame(layout.cards[1].frame, rect(16, 264, 361, 142))
        assertFrame(layout.cards[1].footer, rect(32, 414, 88, 16))
        XCTAssertEqual(layout.contentHeight, 462)
    }

    func testEveryRowIsOneLineAndALongValueIsCutShort() {
        let rows = layout.cards[0].rows
        assertFrame(rows[0].box, rect(0, 0, 361, 44))
        assertFrame(rows[0].title, rect(16, 11, 32, 22))
        assertFrame(rows[0].value, rect(97, 11, 248, 22))
        assertFrame(rows[0].separator, rect(16, 44 - 1.0 / 3, 345, 1.0 / 3))

        // Cut to what "Network" leaves, still one line.
        assertFrame(rows[1].box, rect(0, 44, 361, 44))
        assertFrame(rows[1].title, rect(16, 11, 56, 22))
        assertFrame(rows[1].value, rect(84, 11, 261, 22))
        assertFrame(rows[1].separator, rect(16, 44 - 1.0 / 3, 345, 1.0 / 3))

        assertFrame(rows[2].box, rect(0, 88, 361, 44))
        assertFrame(rows[2].title, rect(16, 11, 152.5, 22))
        assertFrame(rows[2].value, rect(180.5, 11, 164.5, 22))

        assertFrame(rows[3].box, rect(0, 132, 361, 44))
        assertFrame(rows[3].title, rect(16, 11, 232, 22))
        assertFrame(rows[3].value, rect(337, 11, 8, 22))
        XCTAssertNil(rows[3].separator, "a card's last row has none")
    }

    func testAChartRowHasItsTitleAndCaptionOverTheSparkline() {
        let rows = layout.cards[1].rows
        assertFrame(rows[0].box, rect(0, 0, 361, 98))
        assertFrame(rows[0].title, rect(16, 11, 128, 22))
        assertFrame(rows[0].value, rect(265, 11, 80, 16))
        assertFrame(rows[0].chart, rect(16, 43, 329, 44))
        assertFrame(rows[0].separator, rect(16, 98 - 1.0 / 3, 345, 1.0 / 3))
        // An action row is its title alone.
        assertFrame(rows[1].box, rect(0, 98, 361, 44))
        assertFrame(rows[1].title, rect(16, 11, 128, 22))
        XCTAssertNil(rows[1].value)
        XCTAssertNil(rows[1].chart)
    }

    func testAWiderPageWidensTheCards() {
        let layout = ConnectionLayout(width: 440, cards: [.init(rows: [.text(title: title("Sent"), value: title("1.2 MB"))])])
        assertFrame(layout.cards[0].frame, rect(16, 20, 408, 44))
        assertFrame(layout.cards[0].rows[0].value, rect(408 - 16 - 48, 11, 48, 22))
        XCTAssertNil(layout.cards[0].header)
        XCTAssertEqual(layout.contentHeight, 20 + 44 + 32)
    }
}

final class SparklineLayoutTests: XCTestCase {
    func testBarsShareTheWidthAndRiseInProportionFromTheBottom() {
        let bars = SparklineLayout.bars([0, 5, 10, 0], in: CGSize(width: 100, height: 40))
        // (100 - 3 gaps of 4) / 4 = 22 wide.
        XCTAssertEqual(bars.count, 4)
        assertFrame(bars[0], rect(0, 38, 22, 2))
        assertFrame(bars[1], rect(26, 20, 22, 20))
        assertFrame(bars[2], rect(52, 0, 22, 40))
        assertFrame(bars[3], rect(78, 38, 22, 2))
    }

    func testTenMinutesAcrossTheChartRow() {
        let bars = SparklineLayout.bars([3, 1, 0, 0, 0, 0, 0, 0, 0, 2], in: CGSize(width: 329, height: 44))
        // (329 - 9 × 4) / 10 = 29.3; heights rounded to whole points.
        assertFrame(bars[0], rect(0, 0, 29.3, 44))
        assertFrame(bars[1], rect(33.3, 29, 29.3, 15))
        assertFrame(bars[2], rect(66.6, 42, 29.3, 2))
        assertFrame(bars[9], rect(299.7, 15, 29.3, 29))
    }

    func testQuietMinutesAreStubsAndNothingIsNothing() {
        let quiet = SparklineLayout.bars([0, 0, 0], in: CGSize(width: 32, height: 10))
        XCTAssertEqual(quiet.map(\.height), [2, 2, 2])
        XCTAssertEqual(quiet.map(\.minY), [8, 8, 8])
        XCTAssertEqual(SparklineLayout.bars([], in: CGSize(width: 32, height: 10)), [])
        XCTAssertEqual(SparklineLayout.bars([1], in: .zero), [])
    }
}
