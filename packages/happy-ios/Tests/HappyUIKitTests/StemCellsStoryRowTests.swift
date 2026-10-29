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
            if line != nil { row.statusTime = Date().addingTimeInterval(-1_800).timeIntervalSince1970 * 1000 }
            if id == "stories" { row.statusTime = Date().addingTimeInterval(-300).timeIntervalSince1970 * 1000 }
            if id == "ios" {
                let tuesday = Calendar.current.nextDate(after: Calendar.current.startOfDay(for: Date()), matching: DateComponents(weekday: 3), matchingPolicy: .nextTime, direction: .backward)!
                row.statusTime = tuesday.timeIntervalSince1970 * 1000
            }
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
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { context in view.layer.render(in: context.cgContext) }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }

    func testStoryRowsWearRingsStatusesAndOneCornerSignal() throws {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 560))
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
        // A dot waiting on the person, braille while running, nothing on a timed wait.
        XCTAssertNotNil(frames[4].corner)
        XCTAssertEqual(frames[4].corner?.width, StemCellsStoryRowMetrics.dot)
        XCTAssertEqual(frames[3].corner?.size, StemCellsStoryRowMetrics.braille)
        XCTAssertNil(frames[5].corner)

        let stories = try XCTUnwrap(rowView(sidebar, "space:stories"))
        XCTAssertEqual(stories.accessibilityValue, "Testing with a few friends, 2 new stories")
        XCTAssertNotNil(stories.ringView)
        let ios = try XCTUnwrap(rowView(sidebar, "space:ios"))
        XCTAssertEqual(ios.accessibilityValue, "Ready for a new test build. Send it?, Waiting on you")
        // The design's no-ring rows keep their plate; the ring holds nothing.
        XCTAssertEqual(rowView(sidebar, "space:bench")?.row?.story?.segments, 0)
    }

    /// Telegram's chat list: whatever the status says, and whatever the
    /// agent is doing, every row is one height and its title one place.
    private static func states() -> [StemCellsRow] {
        let now = Date().timeIntervalSince1970 * 1000
        let lines: [(String, String?)] = [
            ("none", nil),
            ("one", "Shipped the sidebar diffs"),
            ("two", "Ready for a new test build with the story rings, the round videos and the repost chip. Send it to TestFlight now?"),
        ]
        let states: [(String, StemCellsRow.Status)] = [("idle", .none), ("working", .working), ("asking", .awaitingInput)]
        var rows: [StemCellsRow] = []
        for (line, text) in lines {
            for (name, status) in states {
                var row = StemCellsRow(id: "space:\(line)-\(name)", nodeId: "\(line)-\(name)", kind: .space, label: "\(line == "none" ? "New task" : line == "one" ? "Sidebar polish" : "Preview release")", mark: .glyph("tasks"), status: status, agentId: "\(line)-\(name)")
                row.hasAgent = true
                row.statusLine = text
                row.statusTime = now - 3_600_000
                rows.append(row)
            }
        }
        // A timed wait shows nothing in the corner.
        var timed = StemCellsRow(id: "space:timed", nodeId: "timed", kind: .space, label: "Timed wait", mark: .glyph("agents"), status: .waiting, agentId: "timed")
        timed.hasAgent = true
        timed.statusLine = "Checking the build again at 9"
        timed.statusTime = now - 86_400_000 * 2
        rows.append(timed)
        return StemCellsRows.withStories(rows, rings: ["one-idle": StoryRing(agentId: "one-idle", storyIds: ["s1", "s2"], unseenCount: 1, latestPostedAt: nil)])
    }

    func testEveryStatusAndStateKeepsTheRowAndItsTitleStill() throws {
        let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 860))
        sidebar.overrideUserInterfaceStyle = .light
        sidebar.backgroundColor = UIColor(Palette.surface)
        let rows = Self.states()
        sidebar.apply(rows)
        sidebar.layoutIfNeeded()
        keep(sidebar, "story-row-states")

        let frames = try XCTUnwrap(sidebar.layoutResult?.frames)
        XCTAssertEqual(frames.count, 10)
        let first = frames[0]
        for (row, frame) in zip(rows, frames) {
            let view = try XCTUnwrap(rowView(sidebar, row.id))
            view.layoutIfNeeded()
            // One height, and the title, ring and status where every row has them.
            XCTAssertEqual(frame.box.height, 64, row.id)
            XCTAssertEqual(frame.label.minY - frame.box.minY, first.label.minY - first.box.minY, row.id)
            XCTAssertEqual(frame.ring!.minY - frame.box.minY, first.ring!.minY - first.box.minY, row.id)
            XCTAssertEqual(frame.subtitle!.minY - frame.box.minY, first.subtitle!.minY - first.box.minY, row.id)
            // An empty or truncated status occupies the same single line.
            let subtitle = try XCTUnwrap(view.subviews.compactMap { $0 as? UILabel }.first { $0.attributedText?.string == row.statusLine && $0.frame.minY > 25 })
            XCTAssertLessThanOrEqual(subtitle.frame.height, 18, row.id)
            XCTAssertEqual(subtitle.numberOfLines, 1)
            XCTAssertEqual(subtitle.lineBreakMode, .byTruncatingTail)
            XCTAssertEqual(subtitle.frame.minY, frame.subtitle!.minY - frame.box.minY, row.id)
            // The time ends the first line while there is a status.
            XCTAssertEqual(frame.time != nil, row.statusLine != nil, row.id)
            // One signal: a dot asking, braille running, nothing at rest or on a timed wait.
            switch row.status {
            case .awaitingInput: XCTAssertEqual(frame.corner?.size, CGSize(width: 12, height: 12), row.id)
            case .working: XCTAssertEqual(frame.corner?.size, StemCellsStoryRowMetrics.braille, row.id)
            case .none, .waiting: XCTAssertNil(frame.corner, row.id)
            }
        }
        // Hairlines between them, none after the last.
        XCTAssertEqual(frames.dropLast().filter { $0.separator != nil }.count, 9)
        XCTAssertNil(frames.last?.separator)
        // A selected row parts the hairlines on both its sides.
        sidebar.selectedRowId = rows[4].id
        XCTAssertEqual(rows.compactMap { rowView(sidebar, $0.id)?.aboveSelected == true ? $0.id : nil }, [rows[3].id])
        XCTAssertEqual(rowView(sidebar, rows[4].id)?.selected, true)
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

    func testNestedRowsAndSectionControlsInBothThemes() throws {
        var parent = StemCellsRow(id: "parent", nodeId: "parent", kind: .space, label: "iOS row polish", mark: .clay("navigation"), status: .working, collapsed: false)
        parent.statusLine = "Polishing the session list for iPhone"
        parent.statusTime = Date().addingTimeInterval(-9 * 86_400).timeIntervalSince1970 * 1000
        var child = StemCellsRow(id: "child", nodeId: "child", kind: .session, depth: 1, label: "Snapshot coverage", mark: .glyph("tasks"), status: .working, collapsed: false)
        child.statusLine = "Checking every state and nested row at phone widths"
        child.statusTime = Date().addingTimeInterval(-600).timeIntervalSince1970 * 1000
        var grandchild = StemCellsRow(id: "grandchild", nodeId: "grandchild", kind: .session, depth: 2, label: "Small phone", status: .awaitingInput)
        grandchild.statusLine = "Ready for your review"
        grandchild.statusTime = Date().addingTimeInterval(-120).timeIntervalSince1970 * 1000
        var rows = [StemCellsRow(id: "section", nodeId: "section", kind: .section, label: "Priority", collapsed: false), parent, child, grandchild]
        rows += Self.rows().filter { $0.kind == .space }
        rows = StemCellsRows.withStories(rows, rings: [
            "a1": StoryRing(agentId: "a1", storyIds: ["s1", "s2", "s3"], unseenCount: 3, latestPostedAt: nil),
            "a2": StoryRing(agentId: "a2", storyIds: ["s4", "s5", "s6", "s7"], unseenCount: 2, latestPostedAt: nil),
        ])
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let sidebar = StemCellsSidebarView(frame: CGRect(x: 0, y: 0, width: 402, height: 570))
            sidebar.overrideUserInterfaceStyle = style
            sidebar.backgroundColor = UIColor(Palette.surface)
            sidebar.apply(rows)
            sidebar.layoutIfNeeded()
            let frames = try XCTUnwrap(sidebar.layoutResult?.frames)
            XCTAssertNotNil(frames[0].add)
            XCTAssertNotNil(frames[0].chevronGlyph)
            XCTAssertEqual(frames[2].ring!.minX, frames[1].label.minX)
            XCTAssertEqual(frames[3].ring!.minX, frames[2].label.minX)
            XCTAssertNotNil(frames[3].mark)
            XCTAssertTrue(sidebar.layoutResult!.connectors.isEmpty)
            for index in 4..<frames.count {
                XCTAssertNotNil(frames[index].subtitle)
                XCTAssertEqual(frames[index].time != nil, rows[index].statusLine != nil)
            }
            keep(sidebar, style == .light ? "story-rows-nested-light" : "story-rows-nested-dark")
        }
    }
}
#endif
