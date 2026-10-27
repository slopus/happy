import CoreGraphics
@testable import HappyLayout
import XCTest

/// Stem Cells settings on a 390-wide phone: the bar, the profile strip,
/// the cards and the QR sheet, frame by frame.
final class StemCellsSettingsLayoutTests: XCTestCase {
    func testSearchingTheCardsMoveUpUnderTheField() {
        typealias L = StemCellsSettingsLayout
        let layout = L(width: 390, nameHeight: 34, subtitleHeight: 22, cards: [[L.RowSpec(hasIcon: true, accessory: .chevron)]], searching: true)
        XCTAssertEqual(layout.cards[0].frame, CGRect(x: 16, y: 8, width: 358, height: 52))
        XCTAssertEqual(layout.empty, CGRect(x: 0, y: 40, width: 390, height: 24))
        XCTAssertEqual(layout.contentHeight, 92)
        let nothing = L(width: 390, nameHeight: 34, subtitleHeight: 22, cards: [], searching: true)
        XCTAssertEqual(nothing.contentHeight, 40)
    }

    func testTheChosenProfileIsCentredLargerAndTheOthersShrinkWithDistance() {
        typealias C = StemCellsProfileCarousel
        XCTAssertEqual(C.Metrics.height, 104)
        XCTAssertEqual(C.contentWidth(count: 3, width: 390), 558)
        XCTAssertEqual(C.item(0, offset: 0, width: 390), C.Item(frame: CGRect(x: 149, y: 6, width: 92, height: 92), emphasis: 1))
        XCTAssertEqual(C.item(1, offset: 0, width: 390), C.Item(frame: CGRect(x: 249, y: 22, width: 60, height: 60), emphasis: 0))
        // Halfway between two, both are halfway sizes.
        XCTAssertEqual(C.item(0, offset: 42, width: 390), C.Item(frame: CGRect(x: 157, y: 14, width: 76, height: 76), emphasis: 0.5))
        XCTAssertEqual(C.item(1, offset: 42, width: 390), C.Item(frame: CGRect(x: 241, y: 14, width: 76, height: 76), emphasis: 0.5))
        // A flick rests on an item, never past the ends.
        XCTAssertEqual(C.snapped(100, count: 3), 84)
        XCTAssertEqual(C.snapped(500, count: 3), 168)
        XCTAssertEqual(C.index(at: -50, count: 3), 0)
    }

    func testTheCardsAreInsetWithTilesValuesChevronsAndAToggle() {
        typealias L = StemCellsSettingsLayout
        let layout = L(width: 390, nameHeight: 34, subtitleHeight: 22, cards: [
            [L.RowSpec(hasIcon: true, accessory: .toggle)],
            [L.RowSpec(hasIcon: true, accessory: .chevron), L.RowSpec(hasIcon: true, valueWidth: 40, accessory: .chevron)],
            [L.RowSpec(hasIcon: false, accessory: .none)],
        ])
        XCTAssertEqual(layout.strip, CGRect(x: 0, y: 8, width: 390, height: 104))
        XCTAssertEqual(layout.name, CGRect(x: 24, y: 124, width: 342, height: 34))
        XCTAssertEqual(layout.subtitle, CGRect(x: 24, y: 160, width: 342, height: 22))

        let prioritizing = layout.cards[0]
        XCTAssertEqual(prioritizing.frame, CGRect(x: 16, y: 210, width: 358, height: 52))
        XCTAssertEqual(prioritizing.rows[0].icon, CGRect(x: 16, y: 11, width: 30, height: 30))
        XCTAssertEqual(prioritizing.rows[0].title, CGRect(x: 62, y: 15, width: 209, height: 22))
        XCTAssertEqual(prioritizing.rows[0].toggle, CGRect(x: 279, y: 12, width: 63, height: 28))
        XCTAssertNil(prioritizing.rows[0].separator)

        let more = layout.cards[1]
        XCTAssertEqual(more.frame, CGRect(x: 16, y: 286, width: 358, height: 104))
        XCTAssertEqual(more.rows[0].chevron, CGRect(x: 334, y: 19, width: 8, height: 14))
        XCTAssertEqual(more.rows[0].title, CGRect(x: 62, y: 15, width: 264, height: 22))
        XCTAssertEqual(more.rows[0].separator, CGRect(x: 62, y: 52 - 1.0 / 3, width: 296, height: 1.0 / 3))
        XCTAssertEqual(more.rows[1].chevron, CGRect(x: 334, y: 71, width: 8, height: 14))
        XCTAssertEqual(more.rows[1].value, CGRect(x: 286, y: 67, width: 40, height: 22))
        XCTAssertEqual(more.rows[1].title, CGRect(x: 62, y: 67, width: 216, height: 22))
        XCTAssertNil(more.rows[1].separator)

        let disconnect = layout.cards[2]
        XCTAssertEqual(disconnect.frame, CGRect(x: 16, y: 414, width: 358, height: 52))
        XCTAssertNil(disconnect.rows[0].icon)
        XCTAssertEqual(disconnect.rows[0].title, CGRect(x: 16, y: 15, width: 326, height: 22))
        XCTAssertEqual(layout.contentHeight, 498)
    }

    func testTheQRSheetSitsAtTheFootWithThePictureCentredAboveIt() {
        let sheet = StemCellsQRSheetLayout(size: CGSize(width: 390, height: 844), safeTop: 47, safeBottom: 34, nameHeight: 28, text: .fixed(width: 300, height: 44))
        XCTAssertEqual(sheet.sheet, CGRect(x: 0, y: 570, width: 390, height: 274))
        XCTAssertEqual(sheet.close, CGRect(x: 330, y: 16, width: 44, height: 44))
        XCTAssertEqual(sheet.title, CGRect(x: 74, y: 25, width: 242, height: 22))
        XCTAssertEqual(sheet.text, CGRect(x: 30, y: 58, width: 330, height: 44))
        XCTAssertEqual(sheet.primary, CGRect(x: 30, y: 126, width: 330, height: 52))
        XCTAssertEqual(sheet.secondary, CGRect(x: 30, y: 188, width: 330, height: 52))
        XCTAssertEqual(sheet.avatar, CGRect(x: 145, y: 237, width: 100, height: 100))
        XCTAssertEqual(sheet.name, CGRect(x: 30, y: 353, width: 330, height: 28))
    }

    func testTheLinkSheetTitlesItThenNumbersItsSteps() {
        let line = Measurable { _ in CGSize(width: 200, height: 22) }
        let body = Measurable { _ in CGSize(width: 300, height: 42) }
        let layout = StemCellsLinkContentLayout(width: 345, title: Measurable { _ in CGSize(width: 200, height: 34) }, steps: [
            .init(title: line, body: body), .init(title: line, body: body), .init(title: line, body: body),
        ])
        XCTAssertEqual(layout.title, CGRect(x: 0, y: 0, width: 345, height: 34))
        // The relay checklist's rows: the number in a 26 circle beside the
        // step's line, centred on its 32 head, the line under it at 38.
        XCTAssertEqual(layout.steps.map(\.box), [
            CGRect(x: 0, y: 61, width: 26, height: 26),
            CGRect(x: 0, y: 161, width: 26, height: 26),
            CGRect(x: 0, y: 261, width: 26, height: 26),
        ])
        XCTAssertEqual(layout.steps[0].title, CGRect(x: 38, y: 63, width: 307, height: 22))
        XCTAssertEqual(layout.steps[0].body, CGRect(x: 38, y: 96, width: 307, height: 42))
        XCTAssertEqual(layout.steps[2].body?.maxY, 338)
        XCTAssertEqual(layout.size, CGSize(width: 345, height: 350))
    }

    func testTheSwitchIsThreeFifthsOfTheButtonsCentred() {
        let layout = StemCellsLinkSwitchLayout(accessory: CGRect(x: 24, y: 400, width: 354, height: 36), tag: CGSize(width: 40.2, height: 17.5))
        XCTAssertEqual(layout.control, CGRect(x: 95, y: 400, width: 212, height: 36))
        XCTAssertEqual(layout.tag, CGRect(x: 256, y: 391, width: 41, height: 18))
    }

    func testTheBetaTagSitsAstrideTheSwitchAtDirectsEnd() {
        let layout = StemCellsLinkSwitchLayout(control: CGRect(x: 24, y: 400, width: 354, height: 36), tag: CGSize(width: 40.2, height: 17.5))
        XCTAssertEqual(layout.tag, CGRect(x: 327, y: 391, width: 41, height: 18))
    }
}
