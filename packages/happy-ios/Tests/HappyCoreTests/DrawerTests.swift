import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// The phone's drawer and the home it leaves: the drawer lists Home, the
/// places and the other Surfaces; home keeps only the shared bot, the bots
/// and the tasks.
final class DrawerTests: XCTestCase {
    static let fixture = #"""
    {"cursor":"c1","profile":{"userId":"me"},"userSettings":[],
     "projects":[{"id":"p1","name":"App","path":"/app","orderKey":"a","status":"active","agents":[{"id":"root","workspaceId":"p1","title":"Root chat","status":"idle"}]}],
     "workspaces":[],
     "bots":[
       {"id":"cos","name":"Happy","systemKey":"chief_of_staff","kind":"shared","status":"active","agent":{"id":"cos-a","workspaceId":"w","status":"idle","subtasks":[{"id":"cos-sub","workspaceId":"w2","title":"Sub","status":"idle"}]}},
       {"id":"helper","name":"Helper","kind":"personal","status":"active","agent":{"id":"helper-a","workspaceId":"w3","status":"idle"}}],
     "tasks":[{"id":"t1","name":"Ship","status":"active","agent":{"id":"t1-a","workspaceId":"w4","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"}],
     "surfaces":[
       {"id":"cal","name":"Family","type":"calendar","members":[{"userId":"me","orderKey":"b"}]},
       {"id":"doc","name":"Notes","type":"document","members":[{"userId":"me","orderKey":"a"}]},
       {"id":"vault","name":"Files","type":"vault","members":[{"userId":"me","orderKey":"c"}]}]}
    """#

    private func rows(pipelines: Bool = false) throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
        return Rows.visible(SidebarRows.make(desktop, settings: [:], feed: SidebarRows.FeedRow(unread: 3), plugins: true, pipelines: pipelines))
    }

    func testTheDrawerListsHomeThePlacesThenTheOtherSurfaces() throws {
        let items = Drawer.items(try rows(pipelines: true), home: Drawer.homeRow(label: "Home"))
        XCTAssertEqual(items.map(\.id), [
            "drawer:home", "direct:feed", "direct:artifacts", "direct:documents", "direct:todos", "direct:plugins", "direct:pipelines",
            "drawer:surfaces", "surface:cal", "surface:vault",
        ])
        XCTAssertEqual(items.first { $0.id == "direct:feed" }?.count, 3, "Activity keeps its unread count")
        XCTAssertEqual(items.first?.mark, .glyph("home"))
        XCTAssertFalse(items.contains { $0.sharedBot }, "the shared bot stays on home")
    }

    func testNoDividerWithoutOtherSurfaces() {
        let rows = [
            Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", targetKind: "artifacts"),
            Row(id: "direct:bots", nodeId: "direct:bots", kind: .separator, label: ""),
        ]
        XCTAssertEqual(Drawer.items(rows, home: Drawer.homeRow(label: "Home")).map(\.id), ["drawer:home", "direct:artifacts"])
    }

    func testHomeIsTheBotsAndTasksOnly() throws {
        let home = Drawer.home(try rows())
        XCTAssertEqual(home.map(\.id), ["bot:cos", "session:cos-sub", "direct:bots", "bot:helper", "direct:tasks", "task:t1"])
    }

    /// A group with nothing in it leaves no divider of its own.
    func testEmptyGroupsLeaveNoDividers() {
        func separator(_ id: String) -> Row { Row(id: id, nodeId: id, kind: .separator, label: "") }
        let rows = [
            Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", targetKind: "artifacts"),
            separator("direct:bots"),
            separator("direct:tasks"),
            Row(id: "task:t1", nodeId: "task:t1", kind: .space, label: "Ship", targetKind: "task"),
            separator("direct:projects"),
            Row(id: "project:p", nodeId: "project:p", kind: .space, label: "App", targetKind: "project"),
            Row(id: "session:s", nodeId: "session:s", kind: .session, depth: 1, label: "Chat"),
        ]
        XCTAssertEqual(Drawer.home(rows).map(\.id), ["task:t1"])
    }

    /// Only what the drawer lists, and projects, leave home: a row of a
    /// kind it doesn't know stays where it was.
    func testWhatTheDrawerDoesntListStays() {
        let rows = [
            Row(id: "direct:feed", nodeId: "direct:feed", kind: .space, label: "Activity", targetKind: "feed"),
            Row(id: "surface:cal", nodeId: "surface:cal", kind: .space, label: "Family", targetKind: "surface"),
            Row(id: "space:0", nodeId: "space:0", kind: .space, label: "Space"),
            Row(id: "s:0", nodeId: "s:0", kind: .session, depth: 1, label: "Chat"),
            Row(id: "workspace:w", nodeId: "workspace:w", kind: .space, label: "Tree", targetKind: "workspace"),
        ]
        XCTAssertEqual(Drawer.home(rows).map(\.id), ["space:0", "s:0"])
    }
}
