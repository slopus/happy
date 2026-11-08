#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Every row reuses the chat's braille loader, and a bot, task or subtask
/// whose work runs shimmers its title, as desktop's sidebar does. Both
/// stop when work ends, leave the screen or enter the background.
@MainActor
final class WorkingRowTests: XCTestCase {
    private var window: UIWindow!

    override func setUp() {
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 400))
        window.isHidden = false
    }

    override func tearDown() {
        window.isHidden = true
        window = nil
    }

    private static func rows(working: Bool) -> [Row] {
        let status: Row.Status = working ? .working : .none
        return [
            Row(id: "section:work", nodeId: "work", kind: .section, label: "Work", collapsed: false),
            Row(id: "space:voice", nodeId: "voice", kind: .space, label: "Voice mode polish", mark: .clay("waveform"), status: status),
            Row(id: "session:child", nodeId: "child", kind: .session, depth: 1, label: "Record the waveform", status: status),
            Row(id: "space:mic", nodeId: "mic", kind: .space, label: "Microphone permission copy", mark: .clay("microphone")),
            Row(id: "space:ask", nodeId: "ask", kind: .space, label: "Asks a question", status: .awaitingInput),
            Row(id: "space:wait", nodeId: "wait", kind: .space, label: "Waits an hour", status: .waiting),
        ]
    }

    private func sidebar(_ rows: [Row], height: CGFloat = 400) -> SidebarView {
        let sidebar = SidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: height))
        window.addSubview(sidebar)
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        return sidebar
    }

    private func view(_ sidebar: SidebarView, _ id: String) throws -> RowView {
        try XCTUnwrap(sidebar.subviews.compactMap { $0 as? RowView }.first { $0.row?.id == id })
    }

    func testAWorkingRowUsesBrailleAndStopsWhenTheTurnEnds() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        let child = try view(sidebar, "session:child")
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertTrue(child.workingSignalRunning)
        XCTAssertNotNil(voice.titleSweepBegan)
        XCTAssertNotNil(child.titleSweepBegan)
        // One clock: neighbouring titles sweep together.
        XCTAssertEqual(voice.titleSweepBegan, child.titleSweepBegan)
        XCTAssertEqual(voice.accessibilityValue, "waveform, working")
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
        XCTAssertNil(voice.titleSweepBegan)
        XCTAssertNil(child.titleSweepBegan)
        XCTAssertEqual(voice.accessibilityValue, "waveform")

        sidebar.apply(Self.rows(working: true))
        sidebar.layoutIfNeeded()
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertTrue(child.workingSignalRunning)
    }

    func testAWorkingRowOutOfSightStops() throws {
        // Short enough that a scroll takes the working rows out of sight.
        var rows = Self.rows(working: true)
        rows += (0..<30).map { Row(id: "space:more\($0)", nodeId: "more\($0)", kind: .space, label: "More work \($0)") }
        let sidebar = sidebar(rows, height: 200)
        let voice = try view(sidebar, "space:voice")
        XCTAssertTrue(voice.workingSignalRunning)
        sidebar.contentOffset.y = 600
        sidebar.layoutIfNeeded()
        XCTAssertFalse(voice.workingSignalRunning)
        XCTAssertNil(voice.titleSweepBegan, "a title out of sight stops sweeping")
        sidebar.contentOffset.y = 0
        sidebar.layoutIfNeeded()
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertNotNil(voice.titleSweepBegan)
        // Out of the window altogether.
        sidebar.removeFromSuperview()
        XCTAssertFalse(voice.workingSignalRunning)
        XCTAssertNil(voice.titleSweepBegan)
    }

    func testTheAppGoingAwayStopsTheLoader() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        XCTAssertFalse(voice.workingSignalRunning)
        XCTAssertNil(voice.titleSweepBegan)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertTrue(voice.workingSignalRunning)
        XCTAssertNotNil(voice.titleSweepBegan)
    }

    /// Desktop shimmers places only: a Surface is never busy.
    func testOnlyBotsTasksAndSubtasksShimmer() {
        var surface = Row(id: "space:doc", nodeId: "doc", kind: .space, label: "Notes", status: .working)
        surface.targetKind = "surface"
        var task = Row(id: "space:task", nodeId: "task", kind: .space, label: "A task", status: .working)
        task.targetKind = "task"
        var bot = Row(id: "space:bot", nodeId: "bot", kind: .space, label: "A bot", status: .working)
        bot.targetKind = "bot"
        let subtask = Row(id: "session:sub", nodeId: "sub", kind: .session, depth: 1, label: "A subtask", status: .working)
        let section = Row(id: "section:s", nodeId: "s", kind: .section, label: "Work", status: .working)
        XCTAssertFalse(RowView.shimmers(surface))
        XCTAssertTrue(RowView.shimmers(task))
        XCTAssertTrue(RowView.shimmers(bot))
        XCTAssertTrue(RowView.shimmers(subtask))
        XCTAssertFalse(RowView.shimmers(section))
        for status in [Row.Status.none, .waiting, .awaitingInput] {
            task.status = status
            XCTAssertFalse(RowView.shimmers(task), "\(status)")
        }
    }

    /// In Low Power Mode the loader keeps going while the title holds
    /// still, until Shimmer in Low Power Mode brings its sweep back, live.
    func testLowPowerModeKeepsTheLoaderAndStillsTheTitleUnlessAsked() throws {
        let clock = ShimmerClock.shared
        let kept = clock.shimmersInLowPower
        clock.shimmersInLowPower = false
        clock.lowPowerOverride = true
        defer {
            clock.lowPowerOverride = nil
            clock.shimmersInLowPower = kept
        }
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        XCTAssertTrue(voice.workingSignalRunning, "the loader holds still in Low Power Mode")
        XCTAssertNil(voice.titleSweepBegan)
        clock.shimmersInLowPower = true
        XCTAssertNotNil(voice.titleSweepBegan, "the setting doesn't reach a title on screen")
        XCTAssertTrue(voice.workingSignalRunning)
        clock.shimmersInLowPower = false
        XCTAssertNil(voice.titleSweepBegan)
        clock.lowPowerOverride = false
        XCTAssertNotNil(voice.titleSweepBegan)
    }

    /// Asked for less motion, a working title stays still at its colour.
    func testReduceMotionKeepsTitlesStill() throws {
        let sidebar = sidebar(Self.rows(working: true))
        let voice = try view(sidebar, "space:voice")
        XCTAssertNotNil(voice.titleSweepBegan)
        ShimmerClock.shared.reduceMotionOverride = true
        defer { ShimmerClock.shared.reduceMotionOverride = nil }
        XCTAssertNil(voice.titleSweepBegan)
        ShimmerClock.shared.reduceMotionOverride = false
        XCTAssertNotNil(voice.titleSweepBegan)
    }
}
#endif
