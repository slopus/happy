import XCTest
@testable import HappyLayout

final class AccountSignInLayoutTests: XCTestCase {
    /// An iPhone 12's width, under its navigation bar.
    private func layout(width: CGFloat = 390, safeArea: LayoutInsets = LayoutInsets(top: 91, bottom: 34)) -> AccountSignInLayout {
        AccountSignInLayout(.init(width: width, safeArea: safeArea, nameLine: 20, headingLine: 25, codeLine: 40, messageLine: 20, statusLine: 18, button: 50))
    }

    /// A card a settings card's width, its places top to bottom, each the
    /// most it may hold, and the three buttons under it.
    func testTheCardsPlacesAndTheButtonsUnderIt() {
        let layout = layout()
        XCTAssertEqual(layout.card, CGRect(x: 16, y: 119, width: 358, height: 274))
        XCTAssertEqual(layout.name, CGRect(x: 36, y: 139, width: 318, height: 20))
        XCTAssertEqual(layout.heading, CGRect(x: 36, y: 167, width: 318, height: 50))
        XCTAssertEqual(layout.middle, CGRect(x: 36, y: 233, width: 318, height: 80), "four lines of message, more than a code or the field")
        XCTAssertEqual(layout.field, CGRect(x: 36, y: 251, width: 318, height: 44))
        XCTAssertEqual(layout.spinner, CGRect(x: 185, y: 329, width: 20, height: 20))
        XCTAssertEqual(layout.status, CGRect(x: 36, y: 355, width: 318, height: 18))
        XCTAssertEqual(layout.buttons, [
            CGRect(x: 16, y: 417, width: 358, height: 50),
            CGRect(x: 16, y: 479, width: 358, height: 50),
            CGRect(x: 16, y: 541, width: 358, height: 50),
        ])
        XCTAssertEqual(layout.height, 625)
    }

    /// A larger code than four lines of message takes the middle.
    func testABigCodeSetsTheMiddle() {
        let layout = AccountSignInLayout(.init(width: 390, safeArea: LayoutInsets(), nameLine: 20, headingLine: 25, codeLine: 96, messageLine: 20, statusLine: 18, button: 50))
        XCTAssertEqual(layout.middle.height, 96)
    }

    /// Landscape's sides keep the card inside the safe area.
    func testTheSafeAreasSidesInsetTheCard() {
        let layout = layout(width: 844, safeArea: LayoutInsets(top: 32, left: 47, bottom: 21, right: 47))
        XCTAssertEqual(layout.card.minX, 63)
        XCTAssertEqual(layout.card.width, 718)
        XCTAssertEqual(layout.buttons[0].minX, 63)
    }
}
