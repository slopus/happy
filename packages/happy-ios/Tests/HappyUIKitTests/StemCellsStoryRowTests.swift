#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Sidebar v2's story rows (design "Sidebar v2: agent story rings"): the
/// mark in its ring, the agent's status under the title, one signal in the
/// corner, and a tap on the ring opening the stories rather than the chat.
/// With `HAPPY_PREVIEW_DIR` set, it writes what it drew there as a PNG.
@MainActor
final class StemCellsStoryRowTests: XCTestCase {
    private static func rows() -> [StemCellsRow] {
        func space(_ id: String, _ label: String, _ mark: StemCellsRow.Mark, status: StemCellsRow.Status = .none, line: String?, agent: String) -> StemCellsRow {
            var row = StemCellsRow(id: "space:\(id)", nodeId: id, kind: .space, label: label, mark: mark, status: status, agentId: agent)
            row.hasAgent = true
            row.statusLine = line
            return row
        }
        let rows = [
            space("happy", "Happy", .happy, line: "Two things running", agent: "a0"),
            StemCellsRow(id: "section:priority", nodeId: "priority", kind: .section, label: "Priority", collapsed: false),
            space("diffs", "Inline sidebar diffs", .clay("navigation"), line: "Shipped — Focus's ideas now show right in the sidebar", agent: "a1"),
            space("stories", "Stories", .clay("testing"), status: .working, line: "Testing with a few friends", agent: "a2"),
            space("ios", "iOS Stem Cells", .glyph("tasks"), status: .awaitingInput, line: "Ready for a new test build. Send it?", agent: "a3"),
            space("bench", "Agent benchmark", .glyph("agents"), status: .waiting, line: nil, agent: "a4"),
        ]
        return StemCellsRows.withStories(rows, rings: [
            "a1": StoryRing(agentId: "a1", storyIds: ["s1", "s2", "s3"], unseenCount: 3, latestPostedAt: nil),
            "a2": StoryRing(agentId: "a2", storyIds: ["s4", "s5", "s6", "s7"], unseenCount: 2, latestPostedAt: nil),
        ])
    }

    private func rowView(_ sidebar: StemCellsSidebarView, _ id: String) -> StemCellsRowView? {
        sidebar.subviews.compactMap { $0 as? StemCellsRowView }.first { $0.row?.id == id }
    }

    private func keep(_ view: UIView, _ name: String) {
        guard let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in view.layer.render(in: context.cgContext) }
        try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
    }

    func testStoryRowsWearRingsStatusesAndOneCornerSignal() throws {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 520))
        sidebar.overrideUserInterfaceStyle = .light
        sidebar.backgroundColor = UIColor(Palette.surface)
        sidebar.apply(Self.rows())
        sidebar.layoutIfNeeded()
        keep(sidebar, "story-rows")

        let frames = try XCTUnwrap(sidebar.layoutResult?.frames)
        XCTAssertEqual(frames[2].box.height, StemCellsStoryRowMetrics.rowHeight)
        // Every conversation's row has two lines and no trailing mark.
        for index in [0, 2, 3, 4, 5] {
            XCTAssertNotNil(frames[index].subtitle)
            XCTAssertNil(frames[index].trailing)
        }
        // A dot waiting on the person, a bar working, nothing on a timed wait.
        XCTAssertNotNil(frames[4].corner)
        XCTAssertEqual(frames[4].corner?.width, StemCellsStoryRowMetrics.dot)
        XCTAssertEqual(frames[3].corner?.size, StemCellsStoryRowMetrics.bar)
        XCTAssertNil(frames[5].corner)

        let stories = try XCTUnwrap(rowView(sidebar, "space:stories"))
        XCTAssertEqual(stories.accessibilityValue, "Testing with a few friends, 2 new stories")
        XCTAssertNotNil(stories.ringView)
        let ios = try XCTUnwrap(rowView(sidebar, "space:ios"))
        XCTAssertEqual(ios.accessibilityValue, "Ready for a new test build. Send it?, Waiting on you")
        // The design's no-ring rows keep their plate; the ring holds nothing.
        XCTAssertEqual(rowView(sidebar, "space:bench")?.row?.story?.segments, 0)
    }

    func testTheRingOpensStoriesAndTheTextOpensTheChat() throws {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 520))
        var opened: [String] = []
        var selected: [String] = []
        sidebar.onOpenStory = { row, _ in opened.append(row.id) }
        sidebar.onSelect = { row in selected.append(row.id) }
        sidebar.apply(Self.rows())
        sidebar.layoutIfNeeded()
        let view = try XCTUnwrap(rowView(sidebar, "space:diffs"))
        let index = try XCTUnwrap(sidebar.rows.firstIndex { $0.id == "space:diffs" })
        let frame = try XCTUnwrap(sidebar.layoutResult?.frames[index])
        // A tap on the ring, then on the title.
        let ring = try XCTUnwrap(frame.ring)
        sidebar.tap(view, at: CGPoint(x: ring.midX, y: ring.midY))
        sidebar.tap(view, at: CGPoint(x: frame.label.midX, y: frame.label.midY))
        XCTAssertEqual(opened, ["space:diffs"])
        XCTAssertEqual(selected, ["space:diffs"])
    }
}
#endif
