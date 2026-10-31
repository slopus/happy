import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Home's list (`SidebarRows`): desktop's sections in desktop's order, each
/// parted from the last by a separator rather than titled, and nothing
/// folded.
final class ClassicSidebarTests: XCTestCase {
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":null},"userSettings":[],
     "projects":[
       {"id":"p1","name":"App","status":"active","orderKey":"a","agents":[{"id":"root","workspaceId":"p1","title":"Root chat","status":"idle"}]},
       {"id":"p2","name":"Docs","status":"active","orderKey":"b","agents":[]}],
     "workspaces":[
       {"id":"w1","projectId":"p1","parentId":"p1","name":"Feature","kind":"worktree","status":"active","orderKey":"a","agents":[]},
       {"id":"w2","projectId":"p1","parentId":"p1","name":"Fix","kind":"worktree","status":"active","orderKey":"b","agents":[]}],
     "bots":[
       {"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"happy-agent","workspaceId":"happy-work","status":"idle","subtasks":[
         {"id":"sub1","workspaceId":"happy-work","parentAgentId":"happy-agent","title":"Sub one","status":"idle"},
         {"id":"sub2","workspaceId":"happy-work","parentAgentId":"happy-agent","title":"Sub two","status":"idle"}]}},
       {"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"research-work","status":"idle"}},
       {"id":"release","name":"Release","status":"active","agent":{"id":"release-agent","workspaceId":"release-work","status":"idle","statusLine":{"text":"Signed and uploaded","updatedAt":1700000000000}}}],
     "tasks":[
       {"id":"t1","name":"One","agent":{"id":"t1-agent","workspaceId":"t1-work","status":"idle"}},
       {"id":"t2","name":"Two","agent":{"id":"t2-agent","workspaceId":"t2-work","status":"idle"}},
       {"id":"t3","name":"Three","agent":{"id":"t3-agent","workspaceId":"t3-work","status":"idle"}}],
     "taskMemberships":[{"taskId":"t3"},{"taskId":"t1"},{"taskId":"t2"}],
     "surfaces":[
       {"id":"todo","name":"Groceries","type":"todo","members":[{"userId":null,"orderKey":"b"}]},
       {"id":"doc","name":"Notes","type":"document","members":[{"userId":null,"orderKey":"a"}]}]}
    """#

    private func rows() throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
        return Rows.visible(SidebarRows.make(desktop, settings: [:]))
    }

    /// Each row's label, a separator as "—".
    private func labels(_ rows: [Row]) -> [String] { rows.map { $0.kind == .separator ? "—" : $0.label } }

    func testDesktopsSectionsAndOrder() throws {
        XCTAssertEqual(labels(try rows()), [
            "Artifacts", "Notes", "Groceries",
            "—", "Happy", "Sub one", "Sub two", "Research", "Release",
            "—", "Three", "One", "Two",
            "—", "App", "Root chat", "Feature", "Fix", "Docs",
        ])
    }

    /// No titles and nothing to fold: no heading row, and no row with a fold.
    func testSectionsHaveNoTitlesAndNothingFolds() throws {
        let rows = try rows()
        XCTAssertFalse(rows.contains { $0.kind == .section })
        XCTAssertEqual(rows.filter { $0.kind == .separator }.map(\.id), ["direct:bots", "direct:tasks", "direct:projects"])
        XCTAssertTrue(rows.allSatisfy { $0.collapsed == nil }, "a row has a fold")
    }

    func testRowsCarryWhatAStoryRowSays() throws {
        let release = try XCTUnwrap(try rows().first { $0.label == "Release" })
        XCTAssertTrue(release.hasAgent)
        XCTAssertEqual(release.statusLine, "Signed and uploaded")
        XCTAssertEqual(release.statusTime, 1700000000000)
        XCTAssertEqual(try rows().first { $0.label == "Groceries" }?.mark, .glyph("tasks"))
    }

    /// Stories on: bots and tasks wear their rings, and the tree stays,
    /// unlike the spaces sidebar's, which keeps its top level only.
    func testStoriesKeepTheTree() throws {
        let rows = try rows()
        let ring = StoryRing(agentId: "release-agent", storyIds: ["s1", "s2"], unseenCount: 1, latestPostedAt: nil)
        let shown = SidebarRows.withStories(rows, rings: ["release-agent": ring])
        XCTAssertEqual(labels(shown), labels(rows))
        XCTAssertEqual(shown.first { $0.label == "Release" }?.story, Row.StoryRowState(segments: 2, unseen: 1))
        XCTAssertEqual(shown.first { $0.label == "Three" }?.story, Row.StoryRowState())
        XCTAssertNil(shown.first { $0.label == "Sub one" }?.story)
        XCTAssertNil(shown.first { $0.label == "App" }?.story)
        XCTAssertTrue(shown.first { $0.id == "direct:bots" }?.amongStories == true)
        XCTAssertEqual(SidebarRows.withStories(rows, rings: nil), rows)
    }
}
