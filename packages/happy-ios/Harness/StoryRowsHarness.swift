#if canImport(UIKit) && (DEBUG || HAPPY_FIXTURES)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// The Stem Cells sidebar's story rows in every state they come in
/// (`-screen storyRows`): a status of no line, one or two, idle, working or
/// asking, a timed wait, rings seen and unseen, a subtask and a selected row.
@MainActor
final class StoryRowsHarness {
    init(window: UIWindow) {
        let controller = UIViewController()
        controller.view.backgroundColor = UIColor(Palette.surface)
        let sidebar = StemCellsSidebarView(frame: .zero)
        sidebar.backgroundColor = UIColor(Palette.surface)
        sidebar.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(sidebar)
        window.rootViewController = controller
        DispatchQueue.main.async {
            sidebar.frame = controller.view.bounds.inset(by: UIEdgeInsets(top: controller.view.safeAreaInsets.top, left: 0, bottom: 0, right: 0))
            sidebar.apply(Self.rows())
            sidebar.selectedRowId = "space:deploy"
        }
    }

    static func rows() -> [StemCellsRow] {
        let now = Date().timeIntervalSince1970 * 1000
        func agent(_ id: String, _ label: String, _ mark: StemCellsRow.Mark, _ status: StemCellsRow.Status, _ line: String?, ago minutes: Double, depth: Int = 0, unread: Bool = false) -> StemCellsRow {
            var row = StemCellsRow(id: "space:\(id)", nodeId: id, kind: .space, depth: depth, label: label, mark: mark, status: status, unread: unread, agentId: id)
            row.hasAgent = true
            row.statusLine = line
            row.statusTime = now - minutes * 60_000
            return row
        }
        let rows = [
            StemCellsRow(id: "section:work", nodeId: "work", kind: .section, label: "Tasks", collapsed: false),
            agent("charts", "Sales chart", .clay("deploy"), .none, "Your sales chart is live — tap a bar to see its month", ago: 4, unread: true),
            agent("stories", "Stories", .clay("testing"), .working, "Recording the demo on the simulator", ago: 1),
            agent("ios", "iOS Stem Cells", .glyph("tasks"), .awaitingInput, "Ready for a new test build with the story rings, the round videos and the repost chip. Send it to TestFlight?", ago: 12),
            agent("deploy", "Deploy", .clay("navigation"), .none, "Shipped", ago: 60 * 26),
            agent("bench", "Agent benchmark", .glyph("agents"), .waiting, "Checking the scores again at 9", ago: 60 * 24 * 3),
            agent("quiet", "New task", .glyph("tasks"), .none, nil, ago: 0),
            agent("busy", "Indexing", .glyph("tasks"), .working, nil, ago: 0),
            agent("old", "Release notes", .glyph("tasks"), .none, "Drafted the notes for 1.7 and left them in the doc", ago: 60 * 24 * 12),
        ]
        return StemCellsRows.withStories(rows, rings: [
            "charts": StoryRing(agentId: "charts", storyIds: ["s1"], unseenCount: 1, latestPostedAt: nil),
            "stories": StoryRing(agentId: "stories", storyIds: ["s2", "s3", "s4"], unseenCount: 2, latestPostedAt: nil),
            "deploy": StoryRing(agentId: "deploy", storyIds: ["s5"], unseenCount: 0, latestPostedAt: nil),
        ])
    }
}
#endif
