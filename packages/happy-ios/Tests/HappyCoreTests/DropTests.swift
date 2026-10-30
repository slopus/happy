@testable import HappyCore
import XCTest

/// A phone doesn't draw Search and Create; drops are anchored on what it
/// draws and the two never move.
final class DropTests: XCTestCase {
    private let html = """
    <nav>
      <happy-search/>
      <happy-create/>
      <happy-space id="happy"/>
      <happy-space id="a"/>
      <happy-section id="travel" label="Travel"/>
      <happy-space id="b"/>
      <happy-space id="c"/>
    </nav>
    """

    /// The rows as the sidebar makes them, for the document's own nodes.
    private func rows(_ document: SpaceSidebarDocument) -> [Row] {
        document.items.map { node in
            let kind: Row.Kind = switch node.kind {
            case .search: .search
            case .create: .create
            case .section: .section
            case .separator: .separator
            case .widget: .widget
            case .space: .space
            }
            return Row(id: node.id, nodeId: node.id, kind: kind, label: node.id, isHappy: node.id == "happy")
        }
    }

    private func order(_ document: SpaceSidebarDocument) -> [String] {
        document.items.map(\.id)
    }

    private func drop(_ moving: String, before: String?, in document: SpaceSidebarDocument) -> SpaceSidebarDocument? {
        guard case .some(let after) = Drop.after(moving, droppedBefore: before, rows: rows(document)) else { return nil }
        return SidebarDocumentEdits.move(document, moving, after: after)
    }

    func testADropAtTheTopLandsAfterTheHiddenRows() throws {
        let document = try SpaceSidebar.parse(html)
        XCTAssertEqual(order(document), ["happy-search", "happy-create", "happy", "a", "travel", "b", "c"])
        // Above the first drawn row (Happy): after Create, never before Search or Create.
        XCTAssertEqual(Drop.after("c", droppedBefore: "happy", rows: rows(document)), .some("happy-create"))
        let top = try XCTUnwrap(drop("c", before: "happy", in: document))
        XCTAssertEqual(order(top), ["happy-search", "happy-create", "c", "happy", "a", "travel", "b"])
    }

    func testDropsBetweenAndAtTheEnd() throws {
        let document = try SpaceSidebar.parse(html)
        let between = try XCTUnwrap(drop("c", before: "a", in: document))
        XCTAssertEqual(order(between), ["happy-search", "happy-create", "happy", "c", "a", "travel", "b"])
        let end = try XCTUnwrap(drop("a", before: nil, in: document))
        XCTAssertEqual(order(end), ["happy-search", "happy-create", "happy", "travel", "b", "c", "a"])
    }

    func testTheHiddenRowsAndHappyNeverMove() throws {
        let rows = rows(try SpaceSidebar.parse(html))
        XCTAssertNil(Drop.after("happy-search", droppedBefore: "c", rows: rows))
        XCTAssertNil(Drop.after("happy-create", droppedBefore: nil, rows: rows))
        XCTAssertNil(Drop.after("happy", droppedBefore: nil, rows: rows))
        XCTAssertNil(Drop.after("a", droppedBefore: "nowhere", rows: rows))
        // Nothing is set down against a row the phone doesn't draw.
        XCTAssertNil(Drop.after("c", droppedBefore: "happy-create", rows: rows))
        XCTAssertTrue(rows.filter(Drop.isHidden).map(\.nodeId) == ["happy-search", "happy-create"])
    }
}
