import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
@testable import HappyLayout
import XCTest

/// Settings › Compute on a 390-wide phone: a machine's row with its
/// description wrapped under the title, and the name and description form.
final class ComputeLayoutTests: XCTestCase {
    /// A wrapped line under the title keeps the title where a subtitled
    /// row has it and grows the row by the extra lines; the tile, value and
    /// chevron stay in the row's middle.
    func testAWrappedSubtitleGrowsTheRowUnderItsTitle() {
        typealias L = SettingsLayout
        let spec = L.RowSpec(hasIcon: true, valueWidth: 60, accessory: .chevron, subtitle: true, subtitleHeight: 64)
        XCTAssertEqual(L.titleWidth(spec, width: 390), 196)
        let row = L(width: 390, nameHeight: 0, subtitleHeight: 0, cards: [[spec]], searching: true).cards[0].rows[0]
        XCTAssertEqual(row.box, CGRect(x: 0, y: 0, width: 358, height: 108))
        XCTAssertEqual(row.title, CGRect(x: 62, y: 10, width: 196, height: 22))
        XCTAssertEqual(row.subtitle, CGRect(x: 62, y: 32, width: 196, height: 64))
        XCTAssertEqual(row.icon, CGRect(x: 16, y: 39, width: 30, height: 30))
        XCTAssertEqual(row.value, CGRect(x: 266, y: 43, width: 60, height: 22))
        XCTAssertEqual(row.chevron, CGRect(x: 334, y: 47, width: 8, height: 14))
        // One line, or none measured, is the subtitled row it always was.
        let one = L(width: 390, nameHeight: 0, subtitleHeight: 0, cards: [[L.RowSpec(hasIcon: true, valueWidth: 60, accessory: .chevron, subtitle: true)]], searching: true).cards[0].rows[0]
        XCTAssertEqual(one.box.height, 62)
        XCTAssertEqual(one.subtitle, CGRect(x: 62, y: 32, width: 196, height: 18))
    }

    func testTheFormStacksTwoCardsWithTheirNamesAndHints() {
        let form = ComputeFormLayout(width: 390, header: 16, line: 21, nameHint: 32, descriptionHint: 16)
        XCTAssertEqual(form.nameHeader, CGRect(x: 32, y: 24, width: 326, height: 16))
        XCTAssertEqual(form.nameCard, CGRect(x: 16, y: 48, width: 358, height: 52))
        XCTAssertEqual(form.nameField, CGRect(x: 32, y: 48, width: 326, height: 52))
        XCTAssertEqual(form.nameHint, CGRect(x: 32, y: 108, width: 326, height: 32))
        XCTAssertEqual(form.descriptionHeader, CGRect(x: 32, y: 164, width: 326, height: 16))
        XCTAssertEqual(form.descriptionCard, CGRect(x: 16, y: 188, width: 358, height: 148))
        XCTAssertEqual(form.descriptionText, CGRect(x: 32, y: 202, width: 326, height: 120))
        XCTAssertEqual(form.descriptionPlaceholder, CGRect(x: 32, y: 202, width: 326, height: 21))
        XCTAssertEqual(form.descriptionHint, CGRect(x: 32, y: 344, width: 326, height: 16))
        XCTAssertEqual(form.contentHeight, 392)
        // Editing has no name hint: the description moves up by it and its gap.
        let editing = ComputeFormLayout(width: 390, header: 16, line: 21, nameHint: 0, descriptionHint: 16)
        XCTAssertEqual(editing.descriptionHeader, CGRect(x: 32, y: 124, width: 326, height: 16))
        XCTAssertEqual(editing.contentHeight, 352)
    }
}
