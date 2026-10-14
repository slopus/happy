import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The grouped sidebar's headings sized without cells, at the designed text
/// size and the largest, and the table that keeps them between
/// derivations: measured again only for a new heading, width or text size.
final class TabletHeadingHeightsTests: XCTestCase {
    private typealias Heights = TabletGroupedRowHeights

    /// The metrics at a text size: every style with a fixed line height
    /// scaled as RN scales it; the computer's name has none, so its line is
    /// the font's, given here.
    private func metrics(_ scale: TextScale = .standard, machineLine: CGFloat = 15, hairline: CGFloat = 0.5) -> TabletHeadingMetrics {
        func line(_ style: TextStyle) -> CGFloat {
            style.scaled(scale).lineHeight ?? 0
        }
        return TabletHeadingMetrics(
            sectionLine: line(TextStyles.sessionDayHeader),
            machineLine: machineLine,
            machineIcon: CGSize(width: 11, height: 11.5),
            workspaceTitleLine: line(TextStyles.tabletWorkspaceTitle),
            workspaceBranchLine: line(TextStyles.tabletWorkspaceBranch),
            changesApproximateLine: line(TextStyles.gitApproximate),
            changesCountLine: line(TextStyles.gitLineCount),
            archiveToggleLine: line(TextStyles.archiveToggle),
            hairline: hairline
        )
    }

    private let added = TabletHeadingChanges(approximate: false, added: true, removed: false)
    private let largest = TextScale(.accessibilityExtraExtraExtraLarge)

    // MARK: Heights

    func testEachHeadingAtTheDesignedSize() {
        let metrics = metrics()
        // 20 above, 18, 8 below.
        XCTAssertEqual(Heights.heading(.section, width: 300, metrics: metrics), 46)
        // 8 above the taller of the glyph, the name and the hairline.
        XCTAssertEqual(Heights.heading(.machine(name: "Studio"), width: 300, metrics: metrics), 23)
        XCTAssertEqual(Heights.heading(.machine(name: ""), width: 300, metrics: metrics), 19.5)
        // 12 above, the title over the branch (34, past the 30 face), 6 below.
        XCTAssertEqual(Heights.heading(.workspace(title: "happy", branch: "main", changes: .none), width: 300, metrics: metrics), 52)
        // The changes' 18 is taller than the branch's 16.
        XCTAssertEqual(Heights.heading(.workspace(title: "happy", branch: "main", changes: added), width: 300, metrics: metrics), 54)
        // No title: the 30 face and `+` hold the row.
        XCTAssertEqual(Heights.heading(.workspace(title: "", branch: "main", changes: .none), width: 300, metrics: metrics), 48)
        // Unbanded: 20 above, 12 below.
        XCTAssertEqual(Heights.heading(.archiveToggle, width: 300, metrics: metrics), 50)
    }

    func testEachHeadingAtTheLargestTextSize() {
        let m = largest.multiplier
        let metrics = metrics(largest, machineLine: 53.5)
        XCTAssertEqual(Heights.heading(.section, width: 300, metrics: metrics), 28 + 18 * m, accuracy: 1e-9)
        // The name outgrows the glyph, which never scales.
        XCTAssertEqual(Heights.heading(.machine(name: "Studio"), width: 300, metrics: metrics), 8 + 53.5, accuracy: 1e-9)
        XCTAssertEqual(Heights.heading(.machine(name: ""), width: 300, metrics: metrics), 19.5, accuracy: 1e-9)
        // The text outgrows the 30 face: 18 and 16, or 18 and the changes'
        // 18, each scaled.
        XCTAssertEqual(
            Heights.heading(.workspace(title: "happy", branch: "main", changes: .none), width: 300, metrics: metrics),
            18 + 34 * m, accuracy: 1e-9
        )
        XCTAssertEqual(
            Heights.heading(.workspace(title: "happy", branch: "main", changes: added), width: 300, metrics: metrics),
            18 + 36 * m, accuracy: 1e-9
        )
        XCTAssertEqual(Heights.heading(.archiveToggle, width: 300, metrics: metrics), 32 + 18 * m, accuracy: 1e-9)
    }

    func testOneLineHeadingsAreOneHeightAtAnyWidth() {
        for metrics in [metrics(), metrics(largest, machineLine: 53.5)] {
            for heading: TabletHeading in [
                .section,
                .machine(name: String(repeating: "Mac ", count: 40)),
                .workspace(title: String(repeating: "project ", count: 30), branch: "feature/long", changes: added),
                .archiveToggle,
            ] {
                let narrow = Heights.heading(heading, width: 180, metrics: metrics)
                XCTAssertEqual(Heights.heading(heading, width: 320, metrics: metrics), narrow, "\(heading)")
                XCTAssertEqual(Heights.heading(heading, width: 640, metrics: metrics), narrow, "\(heading)")
            }
        }
    }

    // MARK: The table

    private func rows(workspace: TabletHeading = .workspace(title: "happy", branch: "main", changes: .none)) -> [(id: String, heading: TabletHeading?)] {
        [
            ("bots", .section),
            ("bot", nil),
            ("machine", .machine(name: "Studio")),
            ("workspace", workspace),
            ("chat", nil),
            ("toggle", .archiveToggle),
        ]
    }

    func testTheFirstUpdateMeasuresEveryHeadingAndNothingElse() {
        var table = TabletHeadingHeights<String>()
        XCTAssertNil(table.metrics)
        let moved = table.update(rows(), width: 300, metrics: metrics())
        XCTAssertEqual(moved, [])
        XCTAssertEqual(table.measured, 4)
        XCTAssertEqual(table.count, 4)
        XCTAssertEqual(table.height("bots"), 46)
        XCTAssertEqual(table.height("machine"), 23)
        XCTAssertEqual(table.height("workspace"), 52)
        XCTAssertEqual(table.height("toggle"), 50)
        XCTAssertNil(table.height("bot"))
        XCTAssertNil(table.height("chat"))
    }

    func testTheSameListMeasuresNothing() {
        var table = TabletHeadingHeights<String>()
        table.update(rows(), width: 300, metrics: metrics())
        let before = table
        let moved = table.update(rows(), width: 300, metrics: metrics())
        XCTAssertEqual(moved, [])
        XCTAssertEqual(table.measured, 0)
        XCTAssertEqual(table, before)
    }

    func testOnlyAChangedHeadingIsMeasuredAgain() {
        var table = TabletHeadingHeights<String>()
        table.update(rows(), width: 300, metrics: metrics())
        let before = table
        // New text, one line all the same: measured, not moved.
        var moved = table.update(rows(workspace: .workspace(title: "other", branch: "main", changes: .none)), width: 300, metrics: metrics())
        XCTAssertEqual(table.measured, 1)
        XCTAssertEqual(moved, [])
        XCTAssertNotEqual(table, before)
        // Line changes taller than the branch: moved.
        moved = table.update(rows(workspace: .workspace(title: "other", branch: "main", changes: added)), width: 300, metrics: metrics())
        XCTAssertEqual(table.measured, 1)
        XCTAssertEqual(moved, ["workspace"])
        XCTAssertEqual(table.height("workspace"), 54)
    }

    func testANewTextSizeMeasuresEveryHeadingAgainAndMovesThem() {
        var table = TabletHeadingHeights<String>()
        table.update(rows(), width: 300, metrics: metrics())
        let scaled = metrics(largest, machineLine: 53.5)
        let moved = table.update(rows(), width: 300, metrics: scaled)
        XCTAssertEqual(table.measured, 4)
        XCTAssertEqual(moved, ["bots", "machine", "workspace", "toggle"])
        XCTAssertEqual(table.metrics, scaled)
        XCTAssertEqual(table.height("bots") ?? 0, 28 + 18 * largest.multiplier, accuracy: 1e-9)
        // Back to the designed size.
        let back = table.update(rows(), width: 300, metrics: metrics())
        XCTAssertEqual(back, ["bots", "machine", "workspace", "toggle"])
        XCTAssertEqual(table.height("bots"), 46)
    }

    func testANewScreenScaleMeasuresAgainAndMovesOnlyWhatItMoves() {
        var table = TabletHeadingHeights<String>()
        let twoX = metrics(hairline: 0.5)
        table.update(rows(), width: 300, metrics: twoX)
        // The hairline is under every line, so nothing moves.
        var threeX = metrics(hairline: 1.0 / 3)
        var moved = table.update(rows(), width: 300, metrics: threeX)
        XCTAssertEqual(table.measured, 4)
        XCTAssertEqual(moved, [])
        // The glyph's box on a 3x screen outgrows an empty name's row.
        table.update(rows().map { $0.id == "machine" ? ($0.id, .machine(name: "")) : $0 }, width: 300, metrics: threeX)
        threeX.machineIcon = CGSize(width: 11, height: 11.67)
        moved = table.update(rows().map { $0.id == "machine" ? ($0.id, .machine(name: "")) : $0 }, width: 300, metrics: threeX)
        XCTAssertEqual(moved, ["machine"])
        XCTAssertEqual(table.height("machine") ?? 0, 19.67, accuracy: 1e-9)
    }

    func testANewWidthMeasuresAgainButMovesNothing() {
        var table = TabletHeadingHeights<String>()
        table.update(rows(), width: 300, metrics: metrics())
        let before = table
        let moved = table.update(rows(), width: 420, metrics: metrics())
        XCTAssertEqual(table.measured, 4)
        XCTAssertEqual(moved, [])
        XCTAssertEqual(table.width, 420)
        XCTAssertNotEqual(table, before)
    }

    func testRowsThatLeaveAreLetGo() {
        var table = TabletHeadingHeights<String>()
        table.update(rows(), width: 300, metrics: metrics())
        table.update(rows().filter { $0.id != "machine" && $0.id != "toggle" }, width: 300, metrics: metrics())
        XCTAssertEqual(table.count, 2)
        XCTAssertEqual(table.measured, 0)
        XCTAssertNil(table.height("machine"))
        // Back again: measured as new, not moved.
        let moved = table.update(rows(), width: 300, metrics: metrics())
        XCTAssertEqual(table.measured, 2)
        XCTAssertEqual(moved, [])
        XCTAssertEqual(table.count, 4)
    }
}
