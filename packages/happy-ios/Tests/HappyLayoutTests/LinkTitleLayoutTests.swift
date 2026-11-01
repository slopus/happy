import Foundation
import HappyLayout
import XCTest

/// Home's title while the account isn't live: the link's spinner and
/// words in the account's name's place, in the switcher.
final class LinkTitleLayoutTests: XCTestCase {
    private let chevron = CGSize(width: 10, height: 6)
    private let spinner = CGSize(width: 16, height: 16)

    /// An iPhone 16's agent home: settings alone at the right.
    func testTheSpinnerAndWordsTakeTheNamesPlaceCentredOnItsLine() {
        let room = AccountSwitcherLayout.availableWidth(barWidth: 393, safeArea: .zero, trailingItems: 1)
        let status = AccountSwitcherLayout.Status(spinner: spinner, text: CGSize(width: 98, height: 20))
        let name = CGSize(width: 60, height: 20)
        let shown = AccountSwitcherLayout(title: name, status: status, showing: .status, chevron: chevron, maxWidth: room)
        XCTAssertEqual(shown.size, CGSize(width: 192, height: 44))
        XCTAssertEqual(shown.spinner, CGRect(x: 44, y: 14, width: 16, height: 16), "where the name began")
        XCTAssertEqual(shown.status, CGRect(x: 66, y: 12, width: 98, height: 20))
        XCTAssertEqual(shown.spinner.midY, shown.status.midY, "the spinner is centred on the words' line")
        XCTAssertEqual(shown.chevron, CGRect(x: 168, y: 19, width: 10, height: 6))
        XCTAssertEqual(shown.title, CGRect(x: 44, y: 12, width: 60, height: 20), "the name keeps its place to fade from")
        XCTAssertEqual(shown.glass, CGRect(x: 0, y: 0, width: 192, height: 44), "the bar's buttons' 44")

        let title = AccountSwitcherLayout(title: name, status: status, showing: .title, chevron: chevron, maxWidth: room)
        XCTAssertEqual(title.size, CGSize(width: 132, height: 44))
        XCTAssertEqual(title.chevron, CGRect(x: 108, y: 19, width: 10, height: 6))
        XCTAssertEqual(title.glass, CGRect(x: 0, y: 0, width: 132, height: 44), "the glass follows the width")
        XCTAssertEqual(title.picture, shown.picture, "the picture never moves")
        XCTAssertEqual(title.title, shown.title)
        XCTAssertEqual(title.spinner, shown.spinner, "the status keeps its place to fade from")
        XCTAssertEqual(title.status, shown.status)
        XCTAssertEqual(title, AccountSwitcherLayout(title: name, chevron: chevron, maxWidth: room).withStatus(of: title), "as it was with no status")
    }

    func testNoStatusLaysOutAsBefore() {
        let layout = AccountSwitcherLayout(title: CGSize(width: 60, height: 20), chevron: chevron, maxWidth: 313)
        XCTAssertEqual(layout.spinner, .zero)
        XCTAssertEqual(layout.status, .zero)
        XCTAssertEqual(layout.size.width, 132)
        let asked = AccountSwitcherLayout(title: CGSize(width: 60, height: 20), showing: .status, chevron: chevron, maxWidth: 313)
        XCTAssertEqual(asked, layout, "a status asked for with none to show shows the name")
    }

    /// The legacy home on a 375-point phone: filter and settings at the
    /// right. A long translation is cut before the chevron, which stays
    /// clear of the trailing items.
    func testALongTranslationIsCutBeforeTheTrailingItems() {
        let room = AccountSwitcherLayout.availableWidth(barWidth: 375, safeArea: .zero, trailingItems: 2)
        XCTAssertEqual(room, 247)
        let status = AccountSwitcherLayout.Status(spinner: spinner, text: CGSize(width: 300, height: 20))
        let layout = AccountSwitcherLayout(title: CGSize(width: 80, height: 20), status: status, showing: .status, chevron: chevron, maxWidth: room)
        XCTAssertEqual(layout.size.width, room)
        XCTAssertEqual(layout.spinner, CGRect(x: 44, y: 14, width: 16, height: 16), "the spinner is never cut")
        XCTAssertEqual(layout.status, CGRect(x: 66, y: 12, width: 153, height: 20))
        XCTAssertEqual(layout.chevron.maxX, room - 14, "its own room, then the glass's")
        XCTAssertEqual(layout.status.maxX + 4, layout.chevron.minX)
    }

    /// The narrowest bar there is: a 320-point split view with both items.
    func testANarrowBarStillShowsTheSpinner() {
        let room = AccountSwitcherLayout.availableWidth(barWidth: 320, safeArea: .zero, trailingItems: 2)
        XCTAssertEqual(room, 192)
        let status = AccountSwitcherLayout.Status(spinner: spinner, text: CGSize(width: 110, height: 20))
        let layout = AccountSwitcherLayout(title: CGSize(width: 200, height: 20), status: status, showing: .status, chevron: chevron, maxWidth: room)
        XCTAssertEqual(layout.size.width, 192)
        XCTAssertEqual(layout.spinner.width, 16)
        XCTAssertEqual(layout.status.width, 98)
        XCTAssertEqual(layout.title.width, 120, "the name is cut to the same room")
        // No room at all: the spinner stays whole, the words go.
        let none = AccountSwitcherLayout(title: CGSize(width: 200, height: 20), status: status, showing: .status, chevron: chevron, maxWidth: 80)
        XCTAssertEqual(none.status.width, 0)
        XCTAssertEqual(none.spinner.width, 16)
    }

    /// Words a little taller than the name's line (a script with deeper
    /// marks): the spinner still sits on their middle.
    func testTallerWordsKeepTheSpinnerOnTheirMiddle() {
        let status = AccountSwitcherLayout.Status(spinner: spinner, text: CGSize(width: 90, height: 23))
        let layout = AccountSwitcherLayout(title: CGSize(width: 60, height: 20), status: status, showing: .status, chevron: chevron)
        XCTAssertEqual(layout.status.minY, 11)
        XCTAssertEqual(layout.spinner.minY, 15)
        XCTAssertEqual(layout.spinner.midY.rounded(), layout.status.midY.rounded())
    }
}

private extension AccountSwitcherLayout {
    /// This layout with another's status frames, to compare the rest.
    func withStatus(of other: AccountSwitcherLayout) -> AccountSwitcherLayout {
        var copy = self
        copy.spinner = other.spinner
        copy.status = other.status
        return copy
    }
}
