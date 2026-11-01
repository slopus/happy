import XCTest
@testable import HappyLayout

final class TodoLayoutTests: XCTestCase {
    /// One line: the box and the face centred on it, the tap from the
    /// card's edge to the text, the hairline from the text to the edge.
    func testATodoOnOneLine() {
        let row = TodoRowLayout(width: 390, place: CardPlace(first: true, last: false), text: .fixed(width: 200, height: 19), textLine: 19, face: true, hairline: 0.5, scale: 2)
        XCTAssertEqual(row.size, CGSize(width: 390, height: 44))
        XCTAssertEqual(row.card, CGRect(x: 16, y: 0, width: 358, height: 44))
        XCTAssertEqual(row.check, CGRect(x: 32, y: 11, width: 22, height: 22))
        XCTAssertEqual(row.text, CGRect(x: 66, y: 12.5, width: 262, height: 19))
        XCTAssertEqual(row.face, CGRect(x: 336, y: 11, width: 22, height: 22))
        XCTAssertEqual(row.hit, CGRect(x: 16, y: 0, width: 50, height: 44))
        XCTAssertEqual(row.separator, CGRect(x: 66, y: 43.5, width: 308, height: 0.5))
    }

    /// Wrapped: the row grows, and the box stays with the first line.
    func testAWrappedTodoKeepsItsBoxOnTheFirstLine() {
        let row = TodoRowLayout(width: 390, place: CardPlace(first: false, last: true), text: .fixed(width: 200, height: 57), textLine: 19, face: true, hairline: 0.5, scale: 2)
        XCTAssertEqual(row.size.height, 77)
        XCTAssertEqual(row.text, CGRect(x: 66, y: 10, width: 262, height: 57))
        XCTAssertEqual(row.check, CGRect(x: 32, y: 8.5, width: 22, height: 22))
        XCTAssertEqual(row.face, CGRect(x: 336, y: 8.5, width: 22, height: 22))
        XCTAssertEqual(row.hit, CGRect(x: 16, y: 0, width: 50, height: 77))
        XCTAssertNil(row.separator)
    }

    /// Without a face the text runs to the card's content edge.
    func testATodoWithNoAuthorAndOnAnIPad() {
        let row = TodoRowLayout(width: 1024, maxWidth: 800, place: .alone, text: .fixed(width: 200, height: 19), textLine: 19, face: false, hairline: 0.5, scale: 2)
        XCTAssertEqual(row.card, CGRect(x: 128, y: 0, width: 768, height: 44))
        XCTAssertEqual(row.text, CGRect(x: 178, y: 12.5, width: 702, height: 19))
        XCTAssertNil(row.face)
    }

    func testAHeadingStandsOverItsCard() {
        let after = TodoHeadingLayout(width: 390, label: .fixed(width: 120, height: 24), afterCard: true)
        XCTAssertEqual(after.size, CGSize(width: 390, height: 58))
        XCTAssertEqual(after.label, CGRect(x: 32, y: 26, width: 326, height: 24))
        let first = TodoHeadingLayout(width: 390, label: .fixed(width: 120, height: 24), afterCard: false)
        XCTAssertEqual(first.size, CGSize(width: 390, height: 40))
        XCTAssertEqual(first.label, CGRect(x: 32, y: 8, width: 326, height: 24))
    }

    func testTheCompletedToggle() {
        let toggle = TodoToggleLayout(width: 390, label: CGSize(width: 130, height: 18), afterCard: true)
        XCTAssertEqual(toggle.size, CGSize(width: 390, height: 50))
        XCTAssertEqual(toggle.chevron, CGRect(x: 32, y: 28, width: 12, height: 12))
        XCTAssertEqual(toggle.label, CGRect(x: 50, y: 25, width: 130, height: 18))
    }

    func testTheUndoBarOnAPhoneAndAnIPad() {
        let phone = TodoToastLayout(width: 390, height: 844, bottom: 34, label: CGSize(width: 200, height: 20), button: CGSize(width: 50, height: 22))
        XCTAssertEqual(phone.frame, CGRect(x: 16, y: 748, width: 358, height: 50))
        XCTAssertEqual(phone.button, CGRect(x: 290, y: 14, width: 50, height: 22))
        XCTAssertEqual(phone.label, CGRect(x: 18, y: 15, width: 200, height: 20))
        let pad = TodoToastLayout(width: 1024, height: 1366, bottom: 20, label: CGSize(width: 600, height: 20), button: CGSize(width: 50, height: 22))
        XCTAssertEqual(pad.frame, CGRect(x: 272, y: 1284, width: 480, height: 50))
        XCTAssertEqual(pad.label.width, 382, "a long label stops before the button")
    }
}
