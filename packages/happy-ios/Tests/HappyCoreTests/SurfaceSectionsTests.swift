import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Home's Documents and TODOs rows, as desktop has them: two fixed rows in
/// the first group, and no document or todo list as a row of its own,
/// whichever way it came to the sidebar. Other Surfaces stay as they were.
final class SurfaceSectionsTests: XCTestCase {
    static let fixture = #"""
    {"cursor":"c1","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],
     "surfaces":[
       {"id":"todo","name":"Groceries","type":"todo","members":[{"userId":"me","orderKey":"b"}]},
       {"id":"doc","name":"Notes","type":"document","members":[{"userId":"me","orderKey":"a"}]},
       {"id":"cal","name":"Family","type":"calendar","members":[{"userId":"me","orderKey":"c"}]},
       {"id":"vault","name":"Files","type":"vault","members":[{"userId":"me","orderKey":"d"}]},
       {"id":"other","name":"Not mine","type":"document","members":[{"userId":"someone","orderKey":"a"}]}]}
    """#

    private func desktop() throws -> DesktopSnapshot {
        try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
    }

    /// Plugins and Pipelines follow them, as the drawer lists them.
    func testTheTwoRowsComeAfterArtifactsAndBeforePluginsAndTheOtherSurfaces() throws {
        let rows = SidebarRows.make(try desktop(), settings: [:], feed: SidebarRows.FeedRow(unread: 0), plugins: true, pipelines: true)
        XCTAssertEqual(Array(rows.map(\.id).prefix(8)), [
            "direct:feed", "direct:artifacts", "direct:documents", "direct:todos",
            "direct:plugins", "direct:pipelines", "surface:cal", "surface:vault",
        ])
        let documents = try XCTUnwrap(rows.first { $0.id == "direct:documents" })
        XCTAssertEqual([documents.label, documents.targetKind], ["Documents", "documents"])
        XCTAssertEqual(documents.mark, .glyph("doc"))
        let todos = try XCTUnwrap(rows.first { $0.id == "direct:todos" })
        XCTAssertEqual([todos.label, todos.targetKind], ["TODOs", "todos"])
        XCTAssertEqual(todos.mark, .glyph("tasks"))
    }

    func testNoDocumentOrTodoListIsARow() throws {
        let rows = SidebarRows.make(try desktop(), settings: [:])
        XCTAssertEqual(rows.filter { $0.targetKind == "surface" }.compactMap(\.surfaceType), ["calendar", "vault"])
    }

    /// What search still finds as the person's own: the ones they are in,
    /// in their order, as their rows were.
    func testTheJoinedOnesAreKeptForSearch() throws {
        let sectioned = SidebarRows.sectioned(try desktop())
        XCTAssertEqual(sectioned.map(\.id), ["surface:doc", "surface:todo"])
        XCTAssertEqual(sectioned.map(\.targetId), ["doc", "todo"])
        XCTAssertEqual(sectioned.map(\.surfaceType), ["document", "todo"])
        XCTAssertTrue(sectioned.allSatisfy { $0.targetKind == "surface" && $0.depth == 0 })
        let found = Search.local(rows: sectioned, surfaces: [AgentWire.Surface(id: "doc", type: "document", name: "Notes")], query: "notes")
        XCTAssertEqual(found.map(\.key), ["document:doc"])
        XCTAssertEqual(found.first?.detail, "Document", "a joined document is found as the person's own")
    }

    func testAFixedRowCanNotMove() throws {
        let rows = SidebarRows.make(try desktop(), settings: [:])
        for id in ["direct:documents", "direct:todos"] {
            XCTAssertFalse(SidebarReorder.movable(try XCTUnwrap(rows.first { $0.id == id })), id)
        }
    }

    // MARK: The spaces sidebar

    private static func space(_ id: String, kind: String, target: String) -> AgentWire.Space {
        AgentWire.Space(id: id, title: id.capitalized, icon: nil, target: AgentWire.SpaceTarget(kind: kind, id: target, agentId: nil, workspaceId: nil), version: 1, createdAt: 0, updatedAt: 0)
    }

    /// A space whose target is a document or todo list draws nothing; what
    /// was put under it keeps its place, and other Surfaces are drawn.
    func testASpaceForADocumentOrTodoListIsNotDrawn() throws {
        let document = try SpaceSidebar.parse(#"<nav><happy-search/><happy-create/><happy-space id="doc"><happy-space id="work"/></happy-space><happy-space id="list"/><happy-space id="cal"/></nav>"#)
        let spaces = [
            "doc": Self.space("doc", kind: "surface", target: "s-doc"),
            "work": Self.space("work", kind: "task", target: "t1"),
            "list": Self.space("list", kind: "surface", target: "s-list"),
            "cal": Self.space("cal", kind: "surface", target: "s-cal"),
        ]
        let places = Places(tasks: [AgentWire.Task(id: "t1", name: "Work", canArchive: false, version: "1", agent: nil, membership: nil)], surfaces: [
            AgentWire.Surface(id: "s-doc", type: "document", name: "Doc"),
            AgentWire.Surface(id: "s-list", type: "todo", name: "List"),
            AgentWire.Surface(id: "s-cal", type: "calendar", name: "Cal"),
        ])
        let rows = Rows.all(document, spaces: spaces, places: places, agentIcons: [:]).filter { $0.kind == .space }
        XCTAssertEqual(rows.map(\.id), ["space:work", "space:cal"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
    }
}
