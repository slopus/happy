import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// The grouped sidebar's bots (home's FlatSessionRow) sized without cells at
/// every text size, from the lines home's flat rows take, and kept in the
/// headings' table: measured again only for a new kind of row, width or
/// text size.
final class TabletBotHeightsTests: XCTestCase {
    private typealias Heights = TabletGroupedRowHeights

    /// The lines at a text size as RN scales them: the fixed lines × the
    /// multiplier, and the counts' Plex line, which has no fixed height.
    private func lines(_ scale: TextScale) -> FlatSessionRowLayout.Lines {
        let m = scale.multiplier
        return FlatSessionRowLayout.Lines(title: 22 * m, project: 20 * m, workspace: 18 * m, changes: 14.3 * m)
    }

    private func metrics(_ scale: TextScale = .standard, branchIcon: CGFloat = 13.5) -> TabletHeadingMetrics {
        func line(_ style: TextStyle) -> CGFloat {
            style.scaled(scale).lineHeight ?? 0
        }
        return TabletHeadingMetrics(
            sectionLine: line(TextStyles.sessionDayHeader),
            machineLine: 15,
            machineIcon: CGSize(width: 11, height: 11.5),
            workspaceTitleLine: line(TextStyles.tabletWorkspaceTitle),
            workspaceBranchLine: line(TextStyles.tabletWorkspaceBranch),
            changesApproximateLine: line(TextStyles.gitApproximate),
            changesCountLine: line(TextStyles.gitLineCount),
            archiveToggleLine: line(TextStyles.archiveToggle),
            sessionLines: lines(scale),
            branchIcon: branchIcon,
            hairline: 0.5
        )
    }

    private let kinds: [(workspace: Bool, changes: Bool)] = [(false, false), (true, false), (false, true), (true, true)]

    func testABotIsHomesFlatRowAtTheDesignedSize() {
        // 10 above and below the 22 title, 20 project, 1 and the 18 row,
        // past the 60 avatar: whatever the row shows.
        for kind in kinds {
            XCTAssertEqual(Heights.heading(.bot(workspace: kind.workspace, changes: kind.changes), width: 320, metrics: metrics()), 81)
        }
        // The metrics made without session lines are the designed ones.
        let unset = TabletHeadingMetrics(
            sectionLine: 18, machineLine: 15, machineIcon: .zero, workspaceTitleLine: 18, workspaceBranchLine: 16,
            changesApproximateLine: 14, changesCountLine: 14, archiveToggleLine: 18, hairline: 0.5
        )
        XCTAssertEqual(Heights.heading(.bot(workspace: true, changes: true), width: 320, metrics: unset), HomeRowHeights.flatSession(width: 320))
    }

    func testABotGrowsWithItsLinesAtEveryTextSize() {
        for category in TextSizeCategory.allCases {
            let scale = TextScale(category)
            let m = scale.multiplier
            for kind in kinds {
                // The workspace's row: at least 18, the workspace's line
                // beside its unscaled glyph, the counts' line.
                let row = max(18, kind.workspace ? max(18 * m, 13.5) : 0, kind.changes ? 14.3 * m : 0)
                let expected = 20 + max(60, max(22, 22 * m) + 20 * m + 1 + row)
                XCTAssertEqual(
                    Heights.heading(.bot(workspace: kind.workspace, changes: kind.changes), width: 320, metrics: metrics(scale)),
                    expected,
                    accuracy: 1e-9,
                    "\(category) \(kind)"
                )
                XCTAssertEqual(
                    Heights.heading(.bot(workspace: kind.workspace, changes: kind.changes), width: 320, metrics: metrics(scale)),
                    FlatSessionRowLayout.height(lines: lines(scale), workspace: kind.workspace, changes: kind.changes, branchIcon: 13.5),
                    accuracy: 1e-9
                )
            }
        }
    }

    func testTheSmallestSizesKeepTheAvatarsHeight() {
        // 22 + 20 × 0.82 + 1 + 18 is under the 60 avatar.
        let smallest = TextScale(.extraSmall)
        XCTAssertLessThan(smallest.multiplier, 1)
        XCTAssertEqual(Heights.heading(.bot(workspace: true, changes: false), width: 320, metrics: metrics(smallest)), 80)
    }

    func testTheLargestSizeLaysTheWorkspacesLineUnderTheProject() {
        let largest = TextScale(.accessibilityExtraExtraExtraLarge)
        let m = largest.multiplier
        let plain = Heights.heading(.bot(workspace: false, changes: false), width: 320, metrics: metrics(largest))
        let workspace = Heights.heading(.bot(workspace: true, changes: false), width: 320, metrics: metrics(largest))
        let counts = Heights.heading(.bot(workspace: false, changes: true), width: 320, metrics: metrics(largest))
        XCTAssertEqual(plain, 20 + 22 * m + 20 * m + 1 + 18, accuracy: 1e-9)
        XCTAssertEqual(workspace, plain - 18 + 18 * m, accuracy: 1e-9)
        XCTAssertEqual(counts, plain - 18 + 14.3 * m, accuracy: 1e-9)
    }

    // MARK: The table

    private enum ID: Hashable, Sendable { case header, bot(String) }

    func testBotsAreKeptWithTheHeadingsAndMoveWithTheTextSize() {
        var table = TabletHeadingHeights<ID>()
        let rows: [(id: ID, heading: TabletHeading?)] = [
            (.header, .section),
            (.bot("a"), .bot(workspace: false, changes: false)),
            (.bot("b"), .bot(workspace: true, changes: true)),
        ]
        XCTAssertEqual(table.update(rows, width: 320, metrics: metrics()), [])
        XCTAssertEqual(table.measured, 3)
        XCTAssertEqual(table.height(.bot("a")), 81)
        XCTAssertEqual(table.height(.bot("b")), 81)

        // Nothing new: nothing measured.
        XCTAssertEqual(table.update(rows, width: 320, metrics: metrics()), [])
        XCTAssertEqual(table.measured, 0)

        // A workspace appears: that bot alone is measured; at this size
        // its height stays.
        var next = rows
        next[1] = (.bot("a"), .bot(workspace: true, changes: false))
        XCTAssertEqual(table.update(next, width: 320, metrics: metrics()), [])
        XCTAssertEqual(table.measured, 1)

        // The largest size: every row moves. The workspace's line is taller
        // than the counts', so it alone sizes both bots' last row.
        let largest = metrics(TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertEqual(table.update(next, width: 320, metrics: largest), [.header, .bot("a"), .bot("b")])
        XCTAssertEqual(table.measured, 3)
        XCTAssertGreaterThan(table.height(.bot("a")) ?? 0, 81)
        XCTAssertEqual(table.height(.bot("b")), table.height(.bot("a")))

        // There, losing the workspace moves the bot.
        XCTAssertEqual(table.update(rows, width: 320, metrics: largest), [.bot("a")])
        XCTAssertEqual(table.measured, 1)
    }
}
