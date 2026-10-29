#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// A sidebar row whose work is running shimmers its title, as desktop's
/// `ShimmerText sweep="sheen"` does: every working title on one clock, an
/// idle one still, and the sweep gone once the turn ends or the row
/// scrolls out of sight.
@MainActor
final class StemCellsWorkingRowTests: XCTestCase {
    private var window: UIWindow!

    override func setUp() {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 400))
        window.isHidden = false
    }

    override func tearDown() {
        window.isHidden = true
        window = nil
    }

    private static func rows(working: Bool) -> [StemCellsRow] {
        let status: StemCellsRow.Status = working ? .working : .none
        return [
            StemCellsRow(id: "section:work", nodeId: "work", kind: .section, label: "Work", collapsed: false),
            StemCellsRow(id: "space:voice", nodeId: "voice", kind: .space, label: "Voice mode polish", mark: .clay("waveform"), status: status),
            StemCellsRow(id: "session:child", nodeId: "child", kind: .session, depth: 1, label: "Record the waveform", status: status),
            StemCellsRow(id: "space:mic", nodeId: "mic", kind: .space, label: "Microphone permission copy", mark: .clay("microphone")),
            StemCellsRow(id: "space:ask", nodeId: "ask", kind: .space, label: "Asks a question", status: .awaitingInput),
            StemCellsRow(id: "space:wait", nodeId: "wait", kind: .space, label: "Waits an hour", status: .waiting),
        ]
    }

    private func sidebar(_ rows: [StemCellsRow], height: CGFloat = 400) -> StemCellsSidebarView {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: height))
        window.addSubview(sidebar)
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        return sidebar
    }

    private func view(_ sidebar: StemCellsSidebarView, _ id: String) throws -> StemCellsRowView {
        try XCTUnwrap(sidebar.subviews.compactMap { $0 as? StemCellsRowView }.first { $0.row?.id == id })
    }

    func testAWorkingRowShimmersAndStopsWhenTheTurnEnds() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        let child = try view(sidebar, "session:child")
        XCTAssertNotNil(voice.titleSweepBegan, "the working row is still")
        XCTAssertNotNil(child.titleSweepBegan, "the working subtask is still")
        XCTAssertEqual(voice.accessibilityValue, "waveform, working")
        // One clock: the two sweep together.
        XCTAssertEqual(voice.titleSweepBegan, child.titleSweepBegan)
        // Idle, asking or waiting: no sweep.
        for id in ["space:mic", "space:ask", "space:wait", "section:work"] {
            XCTAssertNil(try view(sidebar, id).titleSweepBegan, "\(id) shimmers")
        }
        XCTAssertEqual(try view(sidebar, "space:mic").accessibilityValue, "microphone")

        // The turn ends.
        sidebar.apply(Self.rows(working: false))
        sidebar.layoutIfNeeded()
        XCTAssertNil(voice.titleSweepBegan, "the row kept shimmering after its turn")
        XCTAssertNil(child.titleSweepBegan)
        XCTAssertEqual(voice.accessibilityValue, "waveform")

        // And starts again on the same clock as before.
        let began = try XCTUnwrap({ () -> CFTimeInterval? in
            sidebar.apply(Self.rows(working: true))
            sidebar.layoutIfNeeded()
            return voice.titleSweepBegan
        }())
        XCTAssertEqual(began, child.titleSweepBegan)
    }

    func testAWorkingRowOutOfSightStops() throws {
        // Short enough that a scroll takes the working rows out of sight.
        var rows = Self.rows(working: true)
        rows += (0..<30).map { StemCellsRow(id: "space:more\($0)", nodeId: "more\($0)", kind: .space, label: "More work \($0)") }
        let sidebar = sidebar(rows, height: 200)
        let voice = try view(sidebar, "space:voice")
        XCTAssertNotNil(voice.titleSweepBegan)
        sidebar.contentOffset.y = 600
        sidebar.layoutIfNeeded()
        XCTAssertNil(voice.titleSweepBegan, "a row out of sight still sweeps")
        sidebar.contentOffset.y = 0
        sidebar.layoutIfNeeded()
        XCTAssertNotNil(voice.titleSweepBegan, "back in sight, the row is still")
        // Out of the window altogether.
        sidebar.removeFromSuperview()
        XCTAssertNil(voice.titleSweepBegan)
    }

    func testTheAppGoingAwayStopsTheSweep() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertNil(voice.titleSweepBegan, "it sweeps in the background")
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertNotNil(voice.titleSweepBegan)
    }
}
#endif
