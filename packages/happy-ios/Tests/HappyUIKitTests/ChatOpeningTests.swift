#if canImport(UIKit)
@testable import HappyUI
import UIKit
import XCTest

/// A chat is shown once whole; past 150 ms without its rows, and past
/// 400 ms whatever it still lacks.
@MainActor
final class ChatOpeningTests: XCTestCase {
    func testAWholeChatShowsAtOnce() {
        XCTAssertTrue(ChatOpening.shows(missing: [], elapsed: 0))
    }

    func testUnderTheCapItWaitsForEveryPiece() {
        XCTAssertFalse(ChatOpening.shows(missing: ["rows"], elapsed: 0.149))
        XCTAssertFalse(ChatOpening.shows(missing: ["header"], elapsed: 0.1))
        XCTAssertFalse(ChatOpening.shows(missing: ["session", "rows"], elapsed: 0.01))
    }

    func testPastTheCapOnlyTheRowsMayComeLate() {
        XCTAssertTrue(ChatOpening.shows(missing: ["rows"], elapsed: 0.150))
        XCTAssertTrue(ChatOpening.shows(missing: ["rows", "placeholder"], elapsed: 0.2))
        for piece in ["session", "checkout", "header", "strip", "composer", "dock", "cliWarning"] {
            XCTAssertFalse(ChatOpening.shows(missing: ["rows", piece], elapsed: 0.2), piece)
            XCTAssertFalse(ChatOpening.shows(missing: [piece], elapsed: 0.399), piece)
            // A stalled read doesn't hold the tap past the limit.
            XCTAssertTrue(ChatOpening.shows(missing: [piece], elapsed: 0.400), piece)
        }
    }

    func testAnOpeningShowsOnceAndReportsWhatCameWhen() async throws {
        var missing = ["session", "rows"]
        var reports: [ChatOpening.Report] = []
        let opening = ChatOpening(missing: { missing }) { reports.append($0) }
        opening.check()
        XCTAssertEqual(reports, [])
        missing = ["rows"]
        opening.check()
        missing = []
        opening.check()
        opening.check()
        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?.missing, [])
        XCTAssertEqual(Set(reports.first?.arrivals.keys.map { $0 } ?? []), ["session", "rows"])
        XCTAssertFalse(reports.first?.hitCap ?? true)
    }

    func testACancelledOpeningNeverShows() async throws {
        var shown = false
        let opening = ChatOpening(missing: { [] }) { _ in shown = true }
        opening.cancel()
        opening.check()
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(shown)
    }

    /// Past the cap with only the rows missing, the display link shows it.
    func testTheCapShowsAChatWithoutItsRows() async throws {
        var reports: [ChatOpening.Report] = []
        let opening = ChatOpening(missing: { ["rows"] }) { reports.append($0) }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?.missing, ["rows"])
        XCTAssertTrue(reports.first?.hitCap ?? false)
        XCTAssertGreaterThanOrEqual(reports.first?.elapsed ?? 0, ChatOpening.cap)
        withExtendedLifetime(opening) {}
    }
}
#endif
