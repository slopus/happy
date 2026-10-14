#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The grouped sidebar's heading heights, measured off the main thread
/// from metrics, against the cells they stand in for, at each text size
/// and screen scale the cells draw at.
@MainActor
final class TabletGroupedHeightsTests: XCTestCase {
    private let widths: [CGFloat] = [280, 320]
    private let scales: [CGFloat] = [2, 3]
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func header(title: String, branch: String, changes: GitLineChanges?) -> TabletWorkspaceHeader {
        TabletWorkspaceHeader(
            id: "p\u{0}c",
            projectName: title,
            avatar: SessionAvatar(seed: "s"),
            branch: branch,
            changes: changes,
            checkout: nil,
            place: TabletNewSessionPlace(machineId: nil, path: nil, worktreeKey: nil)
        )
    }

    /// The cell's own height, drawn at `category` on a screen of `scale`.
    private func height(_ cell: UITableViewCell, width: CGFloat, scale: CGFloat, category: UIContentSizeCategory) -> CGFloat {
        cell.traitOverrides.displayScale = scale
        cell.traitOverrides.preferredContentSizeCategory = category
        cell.updateTraitsIfNeeded()
        cell.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        cell.layoutIfNeeded()
        return cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    func testEveryHeadingMatchesItsCellAtEveryTextSize() throws {
        for category in categories {
            for scale in scales {
                let environment = TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
                let metrics = TabletGroupedHeights.metrics(environment)
                for width in widths {
                    func check(_ cell: UITableViewCell, _ row: TabletGroupedRow, line: UInt = #line) throws {
                        let heading = try XCTUnwrap(TabletGroupedHeights.heading(row), line: line)
                        XCTAssertEqual(
                            TabletGroupedRowHeights.heading(heading, width: width, metrics: metrics),
                            height(cell, width: width, scale: scale, category: category),
                            accuracy: 0.001,
                            "\(row) at \(width) @\(scale)x, \(category.rawValue)",
                            line: line
                        )
                    }

                    let section = TabletSectionHeaderCell(style: .default, reuseIdentifier: nil)
                    section.configure(Strings.Tablet.bots)
                    try check(section, .botsHeader)
                    section.configure(SessionListViewController.dayTitle(.daysAgo(3)))
                    try check(section, .archiveHeader(.daysAgo(3)))

                    let machine = TabletMachineRuleCell(style: .default, reuseIdentifier: nil)
                    machine.configure(name: "MacBook Pro", opens: true)
                    try check(machine, .machine(id: "m", name: "MacBook Pro"))
                    machine.configure(name: "", opens: false)
                    try check(machine, .machine(id: nil, name: ""))

                    for changes in [nil, GitLineChanges(approximate: true, insertions: 12, deletions: 3)] {
                        let workspace = TabletWorkspaceHeaderCell(style: .default, reuseIdentifier: nil)
                        let row = header(title: "happy", branch: "main", changes: changes)
                        workspace.configure(row, style: .gradient, monochrome: false)
                        try check(workspace, .workspace(row))
                    }

                    for hidden in [true, false] {
                        let toggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
                        // As the grouped list configures it.
                        toggle.traitOverrides.followsTextSize = true
                        toggle.banded = false
                        toggle.configure(hidden: hidden)
                        try check(toggle, .archiveToggle(hidden: hidden))
                    }
                }
            }
        }
    }

    func testANewTextSizeAloneMovesTheHeadingsWithoutNewRows() throws {
        let list = TabletGroupedList(
            ids: [.botsHeader, .machine("m"), .archiveToggle],
            rows: [.botsHeader, .machine(id: "m", name: "Studio"), .archiveToggle(hidden: true)],
            avatarStyle: .gradient,
            avatarMonochrome: false,
            offline: nil
        )
        let wake = ClockWake()
        defer { wake.cancel() }
        let large = TextEnvironment(scale: TextScale(.large), displayScale: 3)
        var input = TabletSidebarViewInput(width: 320, text: large)
        var state = TabletSidebarViewState()
        state.feeds.grouped = list
        let first = try XCTUnwrap(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        XCTAssertNil(first.output.rows)
        XCTAssertEqual(first.output.headings.count, 3)
        XCTAssertEqual(first.output.moved, [])
        state = first.state
        // Nothing new: nothing for the main thread.
        XCTAssertNil(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        input.text = TextEnvironment(scale: TextScale(.accessibilityExtraExtraExtraLarge), displayScale: 3)
        let larger = try XCTUnwrap(TabletGroupedHeights.derive(input, applied: state, wake: wake))
        XCTAssertNil(larger.output.rows)
        XCTAssertEqual(larger.output.moved, [.botsHeader, .machine("m"), .archiveToggle])
        for id in list.ids {
            XCTAssertGreaterThan(larger.output.headings.height(id) ?? 0, first.output.headings.height(id) ?? .infinity)
        }
    }
}
#endif
