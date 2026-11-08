@testable import HappyCore
import HappyWire
import XCTest

/// Search as desktop's ⌘K palette shows it (happy-desktop
/// `commandPaletteResults.ts`): what the phone asks the computer, how each
/// result reads and where it goes, and how many are listed.
final class SearchShownTests: XCTestCase {
    private let names = Search.Names(
        surfaces: ["v1": AgentWire.Surface(id: "v1", type: "vault", name: "Company Drive"),
                   "t1": AgentWire.Surface(id: "t1", type: "todo", name: "Launch checklist"),
                   "c1": AgentWire.Surface(id: "c1", type: "calendar", name: "Team")],
        conversations: ["a1": "Research Assistant"],
        timeZone: TimeZone(identifier: "UTC")!, locale: Locale(identifier: "en_US")
    )

    private func result(_ json: String) throws -> Search.Result {
        try JSONDecoder().decode(Search.Result.self, from: Data(json.utf8))
    }

    func testThePhoneAsksAsDesktopDoesForEveryType() throws {
        XCTAssertEqual(Search.request("launch"), .object(["q": .string("launch"), "limit": .number(20)]))
        XCTAssertNil(Search.request("launch")["types"], "every type is searched, as on desktop")
        XCTAssertEqual(Search.resultTypes.count, 13)
    }

    func testAVaultFileSaysWhereItIsOrTheWordsItMatched() throws {
        let named = try XCTUnwrap(Search.shown(result(#"""
        {"type":"vault_file","key":"vault_file:f1","rank":1,"surfaceId":"v1","fileId":"f1","name":"Site.artifact","path":"/Launch materials/Site.artifact",
         "kind":"artifact","match":"name","innerPath":null,"line":null,"snippet":null}
        """#), names: names))
        XCTAssertEqual(named.title, "Site")
        XCTAssertEqual(named.detail, "Company Drive · /Launch materials/Site")
        XCTAssertEqual(named.glyph, "globe-outline")
        XCTAssertEqual(named.opens, .vaultItem(surfaceId: "v1", itemId: "f1", folder: false, vaultName: "Company Drive"))
        let content = try XCTUnwrap(Search.shown(result(#"""
        {"type":"vault_file","key":"vault_file:f2","rank":2,"surfaceId":"v1","fileId":"f2","name":"Budget.md","path":"/Budget.md",
         "kind":"file","match":"content","innerPath":null,"line":3,"snippet":"Marketing spend for the  launch\nweek"}
        """#), names: names))
        XCTAssertEqual(content.detail, "Marketing spend for the launch week")
        XCTAssertEqual(content.snippet, "Marketing spend for the launch week")
        let folder = try XCTUnwrap(Search.shown(result(#"""
        {"type":"vault_folder","key":"vault_folder:d1","rank":3,"surfaceId":"v9","folderId":"d1","name":"Launch materials","path":"/Launch materials","match":"name"}
        """#), names: names))
        XCTAssertEqual(folder.detail, "/Launch materials", "a vault the phone can't name: the path alone")
        XCTAssertEqual(folder.opens, .vaultItem(surfaceId: "v9", itemId: "d1", folder: true, vaultName: nil))
    }

    func testSurfacesTodosAndEventsSayWhatAndWhereTheyAre() throws {
        let document = try XCTUnwrap(Search.shown(result(#"""
        {"type":"document","key":"document:s1","rank":1,"surfaceId":"s1","name":"Launch FAQ","match":"name","line":null,"snippet":null}
        """#), names: names))
        XCTAssertEqual([document.title, document.detail], ["Launch FAQ", "Document"])
        XCTAssertEqual(document.opens, .surface(id: "s1", type: "document", name: "Launch FAQ"))
        let todo = try XCTUnwrap(Search.shown(result(#"""
        {"type":"todo","key":"todo:x1","rank":2,"surfaceId":"t1","todoId":"x1","text":"Book the venue","status":"completed"}
        """#), names: names))
        XCTAssertEqual([todo.title, todo.detail], ["Book the venue", "Done · Launch checklist"])
        XCTAssertEqual(todo.opens, .surface(id: "t1", type: "todo", name: "Launch checklist"))
        let open = try XCTUnwrap(Search.shown(result(#"""
        {"type":"todo","key":"todo:x2","rank":2,"surfaceId":"t9","todoId":"x2","text":"Freeze","status":"active"}
        """#), names: names))
        XCTAssertNil(open.detail, "an open todo in a list the phone can't name says nothing more")
        let event = try XCTUnwrap(Search.shown(result(#"""
        {"type":"calendar_event","key":"calendar_event:e1","rank":3,"surfaceId":"c1","eventId":"e1","title":"Release v1.1.0","allDay":true,
         "start":1794787200000,"match":"name","snippet":null}
        """#), names: names))
        XCTAssertEqual([event.title, event.detail], ["Release v1.1.0", "Team · Nov 16"])
        let surface = try XCTUnwrap(Search.shown(result(#"""
        {"type":"surface","key":"surface:t1","rank":4,"surfaceId":"t1","surfaceType":"todo","name":"Launch checklist"}
        """#), names: names))
        XCTAssertEqual([surface.detail, surface.glyph], ["Todo list", "tasks"])
        let unknown = try XCTUnwrap(Search.shown(result(#"""
        {"type":"surface","key":"surface:z1","rank":5,"surfaceId":"z1","surfaceType":"whiteboard","name":"Sketches"}
        """#), names: names))
        XCTAssertEqual(unknown.detail, "Shared")
    }

    func testAMessageIsItsWordsUnderItsConversation() throws {
        let message = try XCTUnwrap(Search.shown(result(#"""
        {"type":"message","key":"message:m1","rank":1,"agentId":"a1","messageId":"m1","role":"agent","snippet":"The launch moves to Friday",
         "createdAt":1794614400000,"workspaceId":"w1","projectId":null}
        """#), names: names))
        XCTAssertEqual([message.title, message.detail], ["The launch moves to Friday", "Research Assistant · Agent · Nov 14"])
        XCTAssertEqual(message.opens, .conversation(agentId: "a1", title: "Research Assistant"))
        let theirs = try XCTUnwrap(Search.shown(result(#"""
        {"type":"message","key":"message:m2","rank":2,"agentId":"a7","messageId":"m2","role":"user","snippet":"launch?","createdAt":1794614400000,
         "workspaceId":"w1","projectId":null}
        """#), names: names))
        XCTAssertEqual(theirs.detail, "Chat · Nov 14")
        XCTAssertNil(try Search.shown(result(#"""
        {"type":"message","key":"message:m3","rank":3,"agentId":"a1","messageId":"m3","role":"user","snippet":"launch","createdAt":1,"workspaceId":null,"projectId":null}
        """#), names: names), "a message in no workspace isn't offered, as on desktop")
    }

    func testWhatThePhoneCantOpenIsLeftOut() throws {
        let agent = try XCTUnwrap(Search.shown(result(#"""
        {"type":"agent","key":"agent:a2","rank":1,"agentId":"a2","title":"Write release notes","kind":"task","archived":false,"workspaceId":"w2","projectId":null}
        """#), names: names))
        XCTAssertEqual([agent.title, agent.detail], ["Write release notes", "Task"])
        XCTAssertNil(try Search.shown(result(#"""
        {"type":"agent","key":"agent:a3","rank":1,"agentId":"a3","title":"Old","kind":"chat","archived":true,"workspaceId":"w2","projectId":null}
        """#), names: names), "archived")
        for json in [
            #"{"type":"project","key":"project:p1","rank":1,"projectId":"p1","name":"demo-app","archived":false}"#,
            #"{"type":"workspace","key":"workspace:w1","rank":1,"workspaceId":"w1","projectId":"p1","name":"fix","archived":false}"#,
            #"{"type":"user","key":"user:u1","rank":1,"userId":"u1","name":"Sam"}"#,
            #"{"type":"skill","key":"skill:k1","rank":1,"skillId":"k1","name":"release","description":"Ship it"}"#,
        ] {
            XCTAssertNil(Search.shown(try result(json), names: names), json)
        }
    }

    func testTheListHoldsTwelveFusedAsEveryPlatformFusesThem() {
        let local = (1...20).map { "agent:l\($0)" }
        let remote = (1...20).map { (key: "document:r\($0)", rank: $0) }
        let found = Search.found(local: local, remote: remote)
        XCTAssertEqual(found.count, Search.foundLimit)
        XCTAssertEqual(Array(found.prefix(2).map(\.key)), ["document:r1", "agent:l1"])
        XCTAssertFalse(found.contains { $0.key == "agent:l13" }, "the phone offers its best twelve")
        let both = Search.found(local: ["agent:a1"], remote: [("agent:a1", 3)])
        XCTAssertEqual(both, [Search.Placed(key: "agent:a1", local: 0, remote: 0)])
        XCTAssertEqual(Search.foundBest(localRanks: [2, 1], answered: false), 1)
        XCTAssertEqual(Search.foundBest(localRanks: [], answered: false), .max)
        XCTAssertEqual(Search.foundBest(localRanks: [2], answered: true), .min)
    }

    func testRankingFindsWordsInAnyOrderAndAKindsName() {
        XCTAssertEqual(Search.rank("Change agent avatar", "avatar agent"), 1)
        XCTAssertNil(Search.rank("Change agent avatar", "avatar name"))
        XCTAssertEqual(Search.rank("Groceries", "todo", secondary: ["Todo list"]), 3)
        XCTAssertEqual(Search.rank("Groceries", "groceries todo", secondary: ["Todo list"]), 4)
        XCTAssertEqual(Search.rank("Groceries", "gro", secondary: ["Todo list"]), 0)
        let list = AgentWire.Surface(id: "t1", type: "todo", name: "Groceries")
        XCTAssertEqual(Search.local(rows: [], surfaces: [list], query: "todo").map(\.key), ["surface:t1"])
        XCTAssertEqual(Search.detail(.surface(list)), "Todo list")
    }
}
