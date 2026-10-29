#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Every row reuses the chat's braille loader. Titles stay still and the
/// loader stops when work ends, leaves the screen or enters the background.
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

    func testAWorkingRowUsesBrailleAndStopsWhenTheTurnEnds() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        let child = try view(sidebar, "session:child")
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertTrue(child.workingSignalRunning)
        XCTAssertNil(voice.titleSweepBegan)
        XCTAssertNil(child.titleSweepBegan)
        XCTAssertEqual(voice.accessibilityValue, "waveform")
        // Idle, asking or waiting: no sweep.
        for id in ["space:mic", "space:ask", "space:wait", "section:work"] {
            XCTAssertNil(try view(sidebar, id).titleSweepBegan, "\(id) shimmers")
            XCTAssertFalse(try view(sidebar, id).workingSignalRunning)
        }
        XCTAssertEqual(try view(sidebar, "space:mic").accessibilityValue, "microphone")

        // The turn ends.
        sidebar.apply(Self.rows(working: false))
        sidebar.layoutIfNeeded()
        XCTAssertFalse(voice.workingSignalRunning)
        XCTAssertFalse(child.workingSignalRunning)
        XCTAssertEqual(voice.accessibilityValue, "waveform")

        sidebar.apply(Self.rows(working: true))
        sidebar.layoutIfNeeded()
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertTrue(child.workingSignalRunning)
    }

    func testAWorkingRowOutOfSightStops() throws {
        // Short enough that a scroll takes the working rows out of sight.
        var rows = Self.rows(working: true)
        rows += (0..<30).map { StemCellsRow(id: "space:more\($0)", nodeId: "more\($0)", kind: .space, label: "More work \($0)") }
        let sidebar = sidebar(rows, height: 200)
        let voice = try view(sidebar, "space:voice")
        XCTAssertTrue(voice.workingSignalRunning)
        sidebar.contentOffset.y = 600
        sidebar.layoutIfNeeded()
        XCTAssertFalse(voice.workingSignalRunning)
        sidebar.contentOffset.y = 0
        sidebar.layoutIfNeeded()
        XCTAssertTrue(voice.workingSignalRunning)
        // Out of the window altogether.
        sidebar.removeFromSuperview()
        XCTAssertFalse(voice.workingSignalRunning)
    }

    func testTheAppGoingAwayStopsTheLoader() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertFalse(voice.workingSignalRunning)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(voice.workingSignalRunning)
    }
}
#endif
