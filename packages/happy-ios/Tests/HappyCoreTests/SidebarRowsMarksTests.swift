import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// What the classic list's rows wear, as desktop's sidebar draws them: a
/// bot or a task its glyph, a subtask or a project's session nothing, a
/// cloned repo its picture and any other project or worktree nothing.
final class SidebarRowsMarksTests: XCTestCase {
    private static let fixture = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],
     "projects":[
       {"id":"cloned","name":"happy","status":"active","orderKey":"a","avatar":{"url":"/v0/projects/cloned/avatar","width":64,"height":64},
        "agents":[{"id":"root","workspaceId":"cloned","title":"Root chat","status":"idle"}]},
       {"id":"adopted","name":"notes","status":"active","orderKey":"b","agents":[]},
       {"id":"elsewhere","name":"site","status":"active","orderKey":"c","avatar":{"url":"https://example.com/a.png","width":1,"height":1},"agents":[]},
       {"id":"broken","name":"odd","status":"active","orderKey":"d","avatar":"nope","agents":[]}],
     "workspaces":[{"id":"w1","projectId":"cloned","parentId":"cloned","name":"feature","kind":"worktree","status":"active","orderKey":"a","agents":[]}],
     "bots":[{"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle","subtasks":[
        {"id":"sub","workspaceId":"r","parentAgentId":"research-agent","title":"Sub","status":"idle"}]}}],
     "tasks":[{"id":"t1","name":"One","agent":{"id":"t1-agent","workspaceId":"t","status":"idle"}}],
     "taskMemberships":[{"taskId":"t1"}],
     "surfaces":[]}
    """#

    private func rows() throws -> [String: Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
        return Dictionary(SidebarRows.make(desktop, settings: [:]).map { ($0.label, $0) }, uniquingKeysWith: { first, _ in first })
    }

    func testOnlyTopLevelRowsWearAGlyph() throws {
        let rows = try rows()
        XCTAssertEqual(rows["Research"]?.mark, .glyph("agents"))
        XCTAssertEqual(rows["One"]?.mark, .glyph("tasks"))
        XCTAssertEqual(rows["Artifacts"]?.mark, .glyph("doc"))
        XCTAssertEqual(rows["Sub"]?.mark, Row.Mark.none)
        XCTAssertEqual(rows["Root chat"]?.mark, Row.Mark.none)
    }

    /// The daemon's picture for a repo it cloned; nothing for one it
    /// adopted, a picture it doesn't serve, one it can't read, or a worktree.
    func testARepoWearsItsPictureOnlyWhenItHasOne() throws {
        let rows = try rows()
        XCTAssertEqual(rows["happy"]?.mark, .image(path: "/v0/projects/cloned/avatar", thumbhash: nil))
        for label in ["notes", "site", "odd", "feature"] {
            XCTAssertEqual(rows[label]?.mark, Row.Mark.none, label)
        }
    }
}
