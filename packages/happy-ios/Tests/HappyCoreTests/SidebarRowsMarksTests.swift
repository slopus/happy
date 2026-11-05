import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// What the classic list's rows wear, as desktop's sidebar draws them: a
/// bot or a task without a picture its placeholder (where desktop draws
/// its glyph), a subtask or a project's session nothing, a project its
/// picture (or the home project its house, or one with neither yet its
/// placeholder), and a worktree nothing.
final class SidebarRowsMarksTests: XCTestCase {
    private static let fixture = #"""
    {"cursor":"c1","profile":{"userId":null},"userSettings":[],
     "projects":[
       {"id":"cloned","name":"happy","status":"active","orderKey":"a","avatar":{"url":"/v0/projects/cloned/avatar","width":64,"height":64},
        "agents":[{"id":"root","workspaceId":"cloned","title":"Root chat","status":"idle"}]},
       {"id":"adopted","name":"notes","status":"active","orderKey":"b","agents":[]},
       {"id":"elsewhere","name":"site","status":"active","orderKey":"c","avatar":{"url":"https://example.com/a.png","width":1,"height":1},"agents":[]},
       {"id":"broken","name":"odd","status":"active","orderKey":"d","avatar":"nope","agents":[]},
       {"id":"chosen","name":"brand","status":"active","orderKey":"e","avatar":{"kind":"image","source":"user","thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},"agents":[]},
       {"id":"made","name":"tool","status":"active","orderKey":"f","avatar":{"kind":"image","source":"generated","thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"agents":[]},
       {"id":"home","name":"Home","status":"active","orderKey":"g","avatar":{"kind":"home"},"agents":[]}],
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

    func testOnlyTopLevelRowsWearAMark() throws {
        let rows = try rows()
        XCTAssertEqual(rows["Research"]?.mark, .placeholder(seed: "research"))
        XCTAssertEqual(rows["One"]?.mark, .placeholder(seed: "t1"))
        XCTAssertEqual(rows["Artifacts"]?.mark, .glyph("doc"))
        XCTAssertEqual(rows["Sub"]?.mark, Row.Mark.none)
        XCTAssertEqual(rows["Root chat"]?.mark, Row.Mark.none)
    }

    /// The daemon's picture, chosen or made, read where it serves it; an
    /// older daemon's own URL; the house for home; and the placeholder for a
    /// project with no picture yet, one served elsewhere or one it can't
    /// read. A worktree wears nothing.
    func testAProjectAlwaysHasAFace() throws {
        let rows = try rows()
        XCTAssertEqual(rows["brand"]?.mark, .image(path: "/v0/projects/chosen/avatar", thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI"))
        XCTAssertEqual(rows["tool"]?.mark, .image(path: "/v0/projects/made/avatar", thumbhash: "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"))
        XCTAssertEqual(rows["happy"]?.mark, .image(path: "/v0/projects/cloned/avatar", thumbhash: nil))
        XCTAssertEqual(rows["Home"]?.mark, .glyph("home"))
        XCTAssertEqual(rows["notes"]?.mark, .placeholder(seed: "adopted"))
        XCTAssertEqual(rows["site"]?.mark, .placeholder(seed: "elsewhere"))
        XCTAssertEqual(rows["odd"]?.mark, .placeholder(seed: "broken"))
        XCTAssertEqual(rows["feature"]?.mark, Row.Mark.none)
    }

    /// A computer with a feed lists it after Artifacts, its unread count
    /// beside it; one without lists none.
    func testTheFeedRowCountsWhatIsUnread() throws {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(Self.fixture.utf8))
        XCTAssertFalse(SidebarRows.make(desktop, settings: [:]).contains { $0.targetKind == "feed" })
        let labels = SidebarRows.make(desktop, settings: [:], feed: .init(unread: 3)).map(\.label)
        let artifacts = try XCTUnwrap(labels.firstIndex(of: "Artifacts"))
        XCTAssertEqual(labels[artifacts + 1], "Activity")
        let row = try XCTUnwrap(SidebarRows.make(desktop, settings: [:], feed: .init(unread: 3)).first { $0.targetKind == "feed" })
        XCTAssertEqual(row.id, "direct:feed")
        XCTAssertEqual(row.mark, .glyph("feed"))
        XCTAssertEqual(row.count, 3)
        XCTAssertTrue(row.unread)
        let read = try XCTUnwrap(SidebarRows.make(desktop, settings: [:], feed: .init(unread: 0)).first { $0.targetKind == "feed" })
        XCTAssertNil(read.count)
        XCTAssertFalse(read.unread)
    }
}
