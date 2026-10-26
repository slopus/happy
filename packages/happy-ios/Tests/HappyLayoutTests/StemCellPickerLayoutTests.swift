import CoreGraphics
@testable import HappyLayout
import XCTest

final class StemCellPickerLayoutTests: XCTestCase {
    func testAPickersSectionsRowsAndFooter() {
        let layout = StemCellPickerLayout(
            width: 390, safeBottom: 34, hairline: 0.5,
            title: .fixed(width: 120, height: 22),
            sections: [
                .init(header: .fixed(width: 60, height: 16), rows: [
                    .init(title: .fixed(width: 100, height: 20), trailing: CGSize(width: 20, height: 20)),
                    .init(title: .fixed(width: 100, height: 20), subtitle: .fixed(width: 200, height: 32), trailing: CGSize(width: 60, height: 16)),
                ]),
                .init(rows: [.init(title: .fixed(width: 80, height: 20))]),
            ],
            footer: .init(title: .fixed(width: 140, height: 20), trailing: CGSize(width: 12, height: 12))
        )
        // Level with the close circle at the right, as far from the top as from the side.
        XCTAssertEqual(layout.close, CGRect(x: 330, y: 16, width: 44, height: 44))
        XCTAssertEqual(layout.close.minY, 390 - layout.close.maxX)
        XCTAssertEqual(layout.title, CGRect(x: 16, y: 27, width: 120, height: 22))
        XCTAssertNil(layout.notice)
        let first = layout.sections[0]
        XCTAssertEqual(first.header, CGRect(x: 32, y: 66, width: 60, height: 16))
        XCTAssertEqual(first.group, CGRect(x: 16, y: 88, width: 358, height: 126))
        XCTAssertEqual(first.rows[0], .init(
            frame: CGRect(x: 16, y: 88, width: 358, height: 48),
            title: CGRect(x: 32, y: 102, width: 100, height: 20),
            subtitle: nil,
            trailing: CGRect(x: 338, y: 102, width: 20, height: 20),
            separator: CGRect(x: 32, y: 135.5, width: 342, height: 0.5)
        ))
        // A subtitle makes the row taller; its end stays centred.
        XCTAssertEqual(first.rows[1], .init(
            frame: CGRect(x: 16, y: 136, width: 358, height: 78),
            title: CGRect(x: 32, y: 148, width: 100, height: 20),
            subtitle: CGRect(x: 32, y: 170, width: 200, height: 32),
            trailing: CGRect(x: 298, y: 167, width: 60, height: 16),
            separator: nil
        ))
        let second = layout.sections[1]
        XCTAssertNil(second.header)
        XCTAssertEqual(second.group, CGRect(x: 16, y: 232, width: 358, height: 48))
        XCTAssertEqual(second.rows[0].title, CGRect(x: 32, y: 246, width: 80, height: 20))
        XCTAssertNil(second.rows[0].trailing)
        XCTAssertEqual(layout.footer?.group, CGRect(x: 16, y: 298, width: 358, height: 48))
        XCTAssertEqual(layout.footer?.rows[0].trailing, CGRect(x: 346, y: 316, width: 12, height: 12))
        XCTAssertEqual(layout.contentHeight, 396)
    }

    func testANoticeSitsUnderTheTitle() {
        let layout = StemCellPickerLayout(
            width: 390, safeBottom: 0, hairline: 0.5, title: .fixed(width: 120, height: 22),
            notice: .fixed(width: 300, height: 40),
            sections: [.init(rows: [.init(title: .fixed(width: 80, height: 20))])]
        )
        XCTAssertEqual(layout.notice, CGRect(x: 16, y: 66, width: 358, height: 64))
        XCTAssertEqual(layout.noticeText, CGRect(x: 28, y: 78, width: 300, height: 40))
        XCTAssertEqual(layout.sections[0].group, CGRect(x: 16, y: 144, width: 358, height: 48))
        XCTAssertEqual(layout.contentHeight, 208)
    }

    func testAUsageGauge() {
        let gauge = StemCellUsageGaugeLayout(text: CGSize(width: 30, height: 16))
        XCTAssertEqual(gauge.text, CGRect(x: 0, y: 0, width: 30, height: 16))
        XCTAssertEqual(gauge.ring, CGRect(x: 34, y: 1, width: 14, height: 14))
        XCTAssertEqual(gauge.size, CGSize(width: 48, height: 16))
    }

    func testARowsEndIsItsGaugeThenItsCheck() {
        let both = StemCellPickerTrailingLayout(gauge: CGSize(width: 48, height: 16), checked: true)
        XCTAssertEqual(both.gauge, CGRect(x: 0, y: 1, width: 48, height: 16))
        XCTAssertEqual(both.check, CGRect(x: 58, y: 0, width: 18, height: 18))
        XCTAssertEqual(both.size, CGSize(width: 76, height: 18))
        XCTAssertEqual(StemCellPickerTrailingLayout(gauge: CGSize(width: 48, height: 16), checked: false).size, CGSize(width: 48, height: 16))
        XCTAssertEqual(StemCellPickerTrailingLayout(gauge: nil, checked: true).check, CGRect(x: 0, y: 0, width: 18, height: 18))
        XCTAssertEqual(StemCellPickerTrailingLayout(gauge: nil, checked: false).size, .zero)
    }
}
