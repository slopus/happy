@testable import HappyCore
import XCTest

/// Carrying rows through the sidebar, as desktop's reorder does it: peers,
/// sections with their blocks, blocked slots, and where each drop lands.
final class DragTests: XCTestCase {
    private let html = """
    <nav>
      <happy-search/>
      <happy-create/>
      <happy-space id="happy"/>
      <happy-space id="a" expanded="true"><happy-space id="a1"/></happy-space>
      <happy-section id="work" label="Work"/>
      <happy-space id="b"/>
      <happy-space id="c"/>
      <happy-separator id="sep"/>
      <happy-space id="d"/>
      <happy-section id="old" label="Old" collapsed="true"/>
      <happy-space id="e"/>
    </nav>
    """

    private func rows(_ document: SpaceSidebarDocument) -> [Row] {
        func row(_ node: SpaceSidebarNode, depth: Int) -> [Row] {
            let kind: Row.Kind = switch node.kind {
            case .search: .search
            case .create: .create
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            case .space: .space
            }
            let own = Row(id: node.id, nodeId: node.id, kind: kind, depth: depth, label: node.id, collapsed: node.kind == .section ? node.collapsed : nil, isHappy: node.id == "happy")
            return [own] + node.children.flatMap { row($0, depth: depth + 1) }
        }
        return document.items.flatMap { row($0, depth: 0) }
    }

    private func setUp(_ id: String) throws -> (Drag, SpaceSidebarDocument) {
        let document = try SpaceSidebar.parse(html)
        let all = rows(document)
        let drawn = Rows.visible(all).filter { !Drop.isHidden($0) }
        return (try XCTUnwrap(Drag(holding: id, drawn: drawn, all: all, document: document)), document)
    }

    private func drop(_ drag: Drag, to: Int, in document: SpaceSidebarDocument) throws -> [String] {
        guard case .some(let after) = drag.after(to: to) else { return document.items.map(\.id) }
        return try XCTUnwrap(SidebarDocumentEdits.move(document, drag.moving, after: after)).items.map(\.id)
    }

    func testASurfaceRowWearsItsKindsGlyph() {
        XCTAssertEqual(Rows.surfaceGlyph("todo"), "tasks")
        XCTAssertEqual(Rows.surfaceGlyph("document"), "doc")
        XCTAssertEqual(Rows.surfaceGlyph("calendar"), "calendar")
        XCTAssertEqual(Rows.surfaceGlyph("system_monitor"), "pulse")
        XCTAssertEqual(Rows.surfaceGlyph("chat"), "users")
        XCTAssertEqual(Rows.surfaceGlyph(nil), "doc")
    }

    func testARowsPeersAreTheTopLevelRowsWithTheirNestedOnes() throws {
        let (drag, document) = try setUp("c")
        // happy, a (+a1), work, b, c, sep, d, old: the folded section's run is not drawn.
        XCTAssertEqual(drag.units.map { $0.count }, [1, 2, 1, 1, 1, 1, 1, 1])
        XCTAssertEqual(drag.from, 4)
        XCTAssertEqual(drag.held.map(\.nodeId), ["c"])
        // To the very top: right after Create, before Happy.
        XCTAssertEqual(try drop(drag, to: 0, in: document), ["happy-search", "happy-create", "c", "happy", "a", "work", "b", "sep", "d", "old", "e"])
        // Between a's block and Work: after a, its nested row with it.
        XCTAssertEqual(try drop(drag, to: 2, in: document), ["happy-search", "happy-create", "happy", "a", "c", "work", "b", "sep", "d", "old", "e"])
        // Its own slot changes nothing.
        XCTAssertNil(drag.after(to: 4))
    }

    func testANestedRowComesAlong() throws {
        let (drag, document) = try setUp("a")
        XCTAssertEqual(drag.held.map(\.nodeId), ["a", "a1"])
        XCTAssertEqual(try drop(drag, to: 4, in: document), ["happy-search", "happy-create", "happy", "work", "b", "c", "a", "sep", "d", "old", "e"])
    }

    func testASectionCarriesItsBlockAmongBlocks() throws {
        let (drag, document) = try setUp("work")
        // [happy, a, a1], [work, b, c], [sep], [d], [old].
        XCTAssertEqual(drag.units.map { $0.count }, [3, 3, 1, 1, 1])
        XCTAssertEqual(drag.held.map(\.nodeId), ["work", "b", "c"])
        XCTAssertEqual(try drop(drag, to: 0, in: document), ["happy-search", "happy-create", "work", "b", "c", "happy", "a", "sep", "d", "old", "e"])
        XCTAssertEqual(try drop(drag, to: 3, in: document), ["happy-search", "happy-create", "happy", "a", "sep", "d", "work", "b", "c", "old", "e"])
        XCTAssertEqual(drag.order(to: 4).map(\.nodeId), ["happy", "a", "a1", "sep", "d", "old", "work", "b", "c"])
    }

    func testTheSeparatorMoves() throws {
        let (drag, document) = try setUp("sep")
        XCTAssertEqual(try drop(drag, to: 2, in: document), ["happy-search", "happy-create", "happy", "a", "sep", "work", "b", "c", "d", "old", "e"])
    }

    func testASlotThatWouldHideARowIsPassedOver() throws {
        let (drag, _) = try setUp("sep")
        // After the folded section, the separator would end its run there and
        // show e, never hide anything; carrying it above d files d away
        // nowhere either. Only a landing that hides a shown row is blocked.
        XCTAssertFalse(drag.blocked.contains(true))
        let (row, _) = try setUp("d")
        // d set down after the folded section would vanish into it.
        XCTAssertEqual(row.blocked, [false, false, false, false, false, false, false, false].enumerated().map { $0.offset == 7 })
        // The hand over that slot stops short of it.
        XCTAssertEqual(row.target(deltaY: 1000, heights: Array(repeating: 34, count: 8)), 6)
    }

    func testTheTargetIsTheSlotWhoseNeighboursTheHandPassedByHalf() throws {
        let (drag, _) = try setUp("c")
        let heights: [Double] = [34, 68, 30, 34, 34, 19, 34, 30]
        XCTAssertEqual(drag.target(deltaY: 0, heights: heights), 4)
        XCTAssertEqual(drag.target(deltaY: 9, heights: heights), 4)
        XCTAssertEqual(drag.target(deltaY: 10, heights: heights), 5)
        XCTAssertEqual(drag.target(deltaY: -17, heights: heights), 4)
        XCTAssertEqual(drag.target(deltaY: -18, heights: heights), 3)
        XCTAssertEqual(drag.target(deltaY: -1000, heights: heights), 0)
    }

    func testAFoldedSectionIsNotSetDownAboveRowsItWouldFold() throws {
        let (drag, document) = try setUp("old")
        // [happy, a, a1], [work, b, c], [sep], [d], [old]: above Happy or d it
        // would fold them away; before Work or the separator its run is empty.
        XCTAssertEqual(drag.blocked, [true, false, false, true, false])
        XCTAssertEqual(drag.target(deltaY: -1000, heights: [68, 102, 19, 34, 30]), 1)
        XCTAssertEqual(try drop(drag, to: 1, in: document), ["happy-search", "happy-create", "happy", "a", "old", "e", "work", "b", "c", "sep", "d"])
    }

    func testANestedRowMovesAmongItsFamily() throws {
        let html = """
        <nav>
          <happy-search/>
          <happy-create/>
          <happy-space id="happy"/>
          <happy-space id="t" expanded="true">
            <happy-space id="s1"/>
            <happy-space id="s2" expanded="true"><happy-space id="s2a"/></happy-space>
            <happy-space id="s3"/>
          </happy-space>
          <happy-space id="u"/>
        </nav>
        """
        let document = try SpaceSidebar.parse(html)
        let all = rows(document)
        let drawn = Rows.visible(all).filter { !Drop.isHidden($0) }
        let drag = try XCTUnwrap(Drag(holding: "s1", drawn: drawn, all: all, document: document))
        XCTAssertEqual(drag.parent, "t")
        // s1, [s2, s2a], s3: its siblings with what is under them.
        XCTAssertEqual(drag.units.map { $0.map { drawn[$0].nodeId } }, [["s1"], ["s2", "s2a"], ["s3"]])
        XCTAssertEqual(drag.blocked, [false, false, false])
        // The rows around the family stay; only the family reorders.
        XCTAssertEqual(drag.order(to: 2).map(\.nodeId), ["happy", "t", "s2", "s2a", "s3", "s1", "u"])
        let last = try XCTUnwrap(drag.after(to: 2))
        XCTAssertEqual(last, "s3")
        let moved = try XCTUnwrap(SidebarDocumentEdits.move(document, "s1", after: last))
        XCTAssertEqual(moved.items[3].children.map(\.id), ["s2", "s3", "s1"])
        // First under the parent, carrying what is nested under it.
        let middle = try XCTUnwrap(Drag(holding: "s2", drawn: drawn, all: all, document: document))
        XCTAssertEqual(middle.held.map(\.nodeId), ["s2", "s2a"])
        let first = try XCTUnwrap(middle.after(to: 0))
        XCTAssertNil(first)
        let top = try XCTUnwrap(SidebarDocumentEdits.move(document, "s2", after: first))
        XCTAssertEqual(top.items[3].children.map(\.id), ["s2", "s1", "s3"])
        // The daemon gets one move inside the family.
        XCTAssertEqual(try SpaceSidebar.diff(document, top).count, 1)
        // An only child has nowhere to go.
        XCTAssertNil(Drag(holding: "s2a", drawn: drawn, all: all, document: document))
    }

    func testWhatCantBeCarried() throws {
        let document = try SpaceSidebar.parse(html)
        let all = rows(document)
        let drawn = Rows.visible(all).filter { !Drop.isHidden($0) }
        XCTAssertNil(Drag(holding: "happy", drawn: drawn, all: all, document: document))
        // a1 is a's only nested row: it has no sibling to pass.
        XCTAssertNil(Drag(holding: "a1", drawn: drawn, all: all, document: document))
        XCTAssertNil(Drag(holding: "happy-search", drawn: drawn, all: all, document: document))
    }

    /// What the list shows while the hand is over a slot is exactly what the
    /// edited document draws once the drop lands, for every row that can be
    /// carried and every slot `allows`, with stories off and on: the rows
    /// never move again when the daemon confirms. Slots it refuses are
    /// never offered.
    func testEveryDropDrawsTheOrderItsGapShowed() throws {
        let document = try SpaceSidebar.parse(html)
        func drawn(_ document: SpaceSidebarDocument, stories: Bool) -> [Row] {
            let shown = Rows.visible(rows(document)).filter { !Drop.isHidden($0) }
            return stories ? Rows.withStories(shown, rings: [:]) : shown
        }
        for stories in [false, true] {
            let shown = drawn(document, stories: stories)
            var carried = 0
            for row in shown {
                guard let drag = Drag(holding: row.id, drawn: shown, all: rows(document), document: document) else { continue }
                carried += 1
                XCTAssertEqual(drag.order(to: drag.from), shown, "\(row.id) as drawn")
                for to in drag.units.indices {
                    XCTAssertEqual(drag.allows(to), to == drag.from || !drag.blocked[to])
                    guard drag.allows(to) else {
                        XCTAssertNotEqual(drag.target(deltaY: 0, heights: drag.units.map { _ in 40 }), to)
                        continue
                    }
                    var landed = document
                    if case .some(let after) = drag.after(to: to) {
                        landed = try XCTUnwrap(SidebarDocumentEdits.move(document, drag.moving, after: after), "\(row.id) to \(to)")
                    }
                    XCTAssertEqual(drawn(landed, stories: stories).map(\.id), drag.order(to: to).map(\.id), "\(row.id) to \(to), stories \(stories)")
                }
            }
            // a, b, c, d, a1, the two sections and the separator; with stories a1 is not drawn.
            XCTAssertEqual(carried, stories ? 7 : 7)
        }
    }

    /// A nested row folds as a top-level one does: one `set` of its own `expanded`.
    func testANestedRowFoldsByItself() throws {
        let document = try SpaceSidebar.parse(#"<nav><happy-search/><happy-create/><happy-space id="t" expanded="true"><happy-space id="s1"><happy-space id="g1"/></happy-space><happy-space id="s2"/></happy-space></nav>"#)
        let opened = try XCTUnwrap(SidebarDocumentEdits.fold(document, "s1"))
        XCTAssertEqual(try SpaceSidebar.diff(document, opened), [.set(SpaceSidebarSet(id: "s1", expanded: true))])
        let closed = try XCTUnwrap(SidebarDocumentEdits.fold(opened, "s1"))
        XCTAssertEqual(try SpaceSidebar.diff(opened, closed), [.set(SpaceSidebarSet(id: "s1", expanded: false))])
    }
}
