import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// A chat's subtitle while its account's link isn't live: the spinner
/// before "connecting…", the pair centred under the name. Widths as in
/// `ChatHeaderLayoutTests`: "connecting…" 72, the widest status 150.
final class ChatHeaderSpinnerLayoutTests: XCTestCase {
    func testTheSpinnerAndWordsAreCentredUnderTheName() throws {
        let layout = ChatHeaderLayout(titleWidth: 26, statusWidth: 72, reservedStatusWidth: 150, spins: true, centerX: 215, room: 72...358, height: 44)
        XCTAssertEqual(layout.capsule, CGRect(x: 126, y: 0, width: 178, height: 44), "the capsule is the one every status fits")
        XCTAssertEqual(layout.title, CGRect(x: 202, y: 3, width: 26, height: 22), "the name doesn't move")
        XCTAssertEqual(layout.spinner, CGRect(x: 170, y: 26, width: 14, height: 14))
        XCTAssertEqual(layout.status, CGRect(x: 189, y: 25, width: 72, height: 16))
        let spinner = try XCTUnwrap(layout.spinner), status = try XCTUnwrap(layout.status)
        XCTAssertEqual(spinner.midY, status.midY, "on the words' line")
        XCTAssertEqual(((spinner.minX + status.maxX) / 2).rounded(.down), layout.capsule.midX, "the pair is centred")
    }

    func testAStatusThatDoesntSpinIsAsBefore() {
        let still = ChatHeaderLayout(titleWidth: 26, statusWidth: 40, reservedStatusWidth: 150, centerX: 215, room: 72...358, height: 44)
        XCTAssertNil(still.spinner)
        XCTAssertEqual(still.status, CGRect(x: 140, y: 25, width: 150, height: 16))
    }

    /// A long translation in a cramped bar: the words are cut, never the
    /// spinner, and the pair stays inside the capsule.
    func testALongTranslationIsCutNotTheSpinner() throws {
        let layout = ChatHeaderLayout(titleWidth: 26, statusWidth: 100, reservedStatusWidth: 150, spins: true, centerX: 60, room: 0...120, height: 44)
        XCTAssertEqual(layout.capsule, CGRect(x: 0, y: 0, width: 120, height: 44))
        XCTAssertEqual(layout.spinner, CGRect(x: 14, y: 26, width: 14, height: 14))
        XCTAssertEqual(layout.status, CGRect(x: 33, y: 25, width: 73, height: 16))
        XCTAssertLessThanOrEqual(try XCTUnwrap(layout.status).maxX, layout.capsule.maxX - ChatHeaderLayout.Metrics.padding)
    }

    /// The widest status reserved without its spinner's room: the line
    /// grows to hold the pair rather than cutting it.
    func testTheLineHoldsTheSpinnerAndTheWidestWords() throws {
        let layout = ChatHeaderLayout(titleWidth: 26, statusWidth: 150, reservedStatusWidth: 150, spins: true, centerX: 215, room: 72...358, height: 44)
        XCTAssertEqual(layout.capsule.width, 169 + 28)
        XCTAssertEqual(try XCTUnwrap(layout.status).width, 150)
    }
}
