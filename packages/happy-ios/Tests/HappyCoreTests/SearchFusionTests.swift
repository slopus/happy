@testable import HappyCore
import XCTest

/// Search's fusion against the reference's vectors, vendored as
/// `Fixtures/search-fusion.json` from happy-agent c67719baf
/// (`packages/happy-agent-client/fixtures/searchFusion.fixtures.json`,
/// `@slopus/happy-agent-client` 0.0.158), and the phone's own half.
final class SearchFusionTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Case: Decodable {
            struct Remote: Decodable { let key: String; let rank: Int }
            struct Local: Decodable { let key: String }
            struct Expected: Decodable, Equatable { let key: String; let from: String }
            let name: String
            let remote: [Remote]
            let local: [Local]
            let expected: [Expected]
        }

        let k: Double
        let cases: [Case]
    }

    func testFusionMatchesTheReferencesVectors() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "search-fusion", withExtension: "json", subdirectory: "Fixtures"))
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        XCTAssertEqual(vectors.k, Search.k)
        XCTAssertEqual(vectors.cases.count, 8)
        for vector in vectors.cases {
            let fused = Search.fuse(remote: vector.remote.map { ($0.key, $0.rank) }, local: vector.local.map(\.key))
            let got = fused.map { Vectors.Case.Expected(key: $0.key, from: $0.remote == nil ? "local" : "remote") }
            XCTAssertEqual(got, vector.expected, vector.name)
        }
    }

    func testAResultDecodesFromTheContractsExample() throws {
        let json = #"""
        {"type": "vault_file", "key": "vault_file:f1", "rank": 1, "surfaceId": "v1", "fileId": "f1", "name": "Launch plan.md",
         "path": "/Docs/Launch plan.md", "kind": "file", "match": "content", "innerPath": null, "line": 4, "snippet": "The launch moves to Friday"}
        """#
        let result = try JSONDecoder().decode(Search.Result.self, from: Data(json.utf8))
        XCTAssertEqual(result.key, "vault_file:f1")
        XCTAssertEqual(result.rank, 1)
        XCTAssertEqual(result.label, "Launch plan.md")
        XCTAssertEqual(result.line, 4)
        XCTAssertEqual(result.snippet, "The launch moves to Friday")
        let agent = #"""
        {"type": "agent", "key": "agent:a1", "rank": 2, "agentId": "a1", "title": "Plan the launch", "kind": "task", "archived": false,
         "workspaceId": "w1", "projectId": null, "addedLater": {"any": "shape"}}
        """#
        let found = try JSONDecoder().decode(Search.Result.self, from: Data(agent.utf8))
        XCTAssertEqual([found.agentId, found.workspaceId, found.projectId, found.kind], ["a1", "w1", nil, "task"])
        XCTAssertEqual(found.label, "Plan the launch")
        let message = #"""
        {"type": "message", "key": "message:m1", "rank": 3, "agentId": "a1", "messageId": "m1", "role": "agent",
         "snippet": "The launch moves to Friday", "createdAt": 1755400000000, "workspaceId": null, "projectId": null}
        """#
        let said = try JSONDecoder().decode(Search.Result.self, from: Data(message.utf8))
        XCTAssertEqual([said.agentId, said.messageId, said.role], ["a1", "m1", "agent"])
        XCTAssertEqual(said.createdAt, 1_755_400_000_000)
        XCTAssertEqual(said.label, "The launch moves to Friday")
    }

    func testThePhonesHalfKeysWhatItHoldsAsTheComputerDoes() {
        var task = Row(id: "space:s1", nodeId: "n1", kind: .space, depth: 1, label: "Launch week", agentId: "a1", spaceId: "s1", targetKind: "task")
        task.targetId = "t1"
        task.activityTime = 30
        let subtask = Row(id: "session:a3", nodeId: "n6", kind: .session, depth: 2, label: "Draft the launch tweet", agentId: "a3")
        var plan = Row(id: "space:s2", nodeId: "n2", kind: .space, label: "Launch notes", spaceId: "s2", targetKind: "surface")
        plan.targetId = "d1"
        plan.surfaceType = "document"
        var chat = Row(id: "session:a2", nodeId: "n3", kind: .session, depth: 1, label: "Ask about launch", agentId: "a2")
        chat.activityTime = 10
        let other = Row(id: "space:s3", nodeId: "n4", kind: .space, label: "Launch pad", spaceId: "s3", targetKind: "folder")
        let heading = Row(id: "section:x", nodeId: "n5", kind: .section, label: "Launch")
        let surfaces = [AgentWire.Surface(id: "d1", type: "document", name: "Launch notes", updatedAt: 20),
                        AgentWire.Surface(id: "v1", type: "vault", name: "Prelaunch vault", updatedAt: 99),
                        AgentWire.Surface(id: "k1", type: "artifact", name: "Launch site, kept", updatedAt: 99)]
        let artifact = ArtifactSummary(id: "r1", type: "html", title: "Launch site", latestVersion: 1, entry: nil, createdAt: 1, updatedAt: 25)
        let gone = ArtifactSummary(id: "r2", type: "html", title: "Launch draft", latestVersion: 1, entry: nil, createdAt: 1, updatedAt: 99, deleted: true)
        let found = Search.local(rows: [heading, task, subtask, plan, chat, other], surfaces: surfaces, artifacts: [artifact, gone], query: "launch")
        XCTAssertEqual(found.map(\.key), [
            // Names that start with it, the latest changed first, as desktop's palette ties them.
            "agent:a1", "artifact:r1", "document:d1", "space:s3",
            // A word in the name starts with it.
            "agent:a2",
            // It is inside a word, in a Surface the person isn't in.
            "surface:v1",
        ])
        XCTAssertEqual(found.map(\.detail), ["Task", "Web page", "Document", nil, "Chat", "Vault · not joined"])
        XCTAssertFalse(found.contains { $0.key == "artifact:r2" }, "a deleted artifact isn't found")
        XCTAssertFalse(found.contains { $0.key == "surface:k1" }, "a kept artifact is found under its own name")
        XCTAssertFalse(found.contains { $0.key == "agent:a3" }, "a subtask is found through its task, as on desktop")
        guard case .row(let row) = found.first?.found else { return XCTFail("the sidebar's row stands for the task") }
        XCTAssertEqual(row.depth, 0)
        XCTAssertEqual(Search.local(rows: [task], query: "week").map(\.key), ["agent:a1"])
        // A task the person isn't in, after the ones they are.
        var theirs = Row(id: "unjoined:t9", nodeId: "unjoined:t9", kind: .space, label: "Launch retro", agentId: "a9", targetKind: "task")
        theirs.activityTime = 99
        XCTAssertEqual(Search.local(rows: [task], unjoined: [theirs], query: "launch").map { [$0.key, $0.detail ?? ""] },
                       [["agent:a1", "Task"], ["agent:a9", "Task you have not joined"]])
        // A subtask's title finds its task, under every title match.
        XCTAssertEqual(Search.local(rows: [task, subtask], query: "tweet").map { [$0.key, String($0.rank)] }, [["agent:a1", "4"]])
    }

    /// Desktop's "launch" on the test computer: a document, an artifact and
    /// a todo list whose names start with it, the latest changed first,
    /// then the open todos that say it, after every list.
    func testTodosAreFoundByWhatTheySayAfterEveryListAndTheListCountsThem() {
        var list = Row(id: "space:s1", nodeId: "n1", kind: .space, label: "Launch checklist", spaceId: "s1", targetKind: "surface")
        list.targetId = "l1"
        list.surfaceType = "todo"
        var faq = Row(id: "space:s2", nodeId: "n2", kind: .space, label: "Launch FAQ", spaceId: "s2", targetKind: "surface")
        faq.targetId = "f1"
        faq.surfaceType = "document"
        let surfaces = [AgentWire.Surface(id: "l1", type: "todo", name: "Launch checklist", updatedAt: 1_794_160_514_714),
                        AgentWire.Surface(id: "f1", type: "document", name: "Launch FAQ", updatedAt: 1_794_160_538_666)]
        let countdown = ArtifactSummary(id: "c1", type: "html", title: "Launch countdown", latestVersion: 1, entry: nil, createdAt: 1, updatedAt: 1_794_160_515_695)
        func todo(_ id: String, _ text: String, _ status: TodoItem.Status = .active) -> TodoItem {
            TodoItem(id: id, surfaceId: "l1", authorUserId: nil, text: text, status: status, orderKey: id, createdAt: 1, updatedAt: 2, completedAt: nil, deletedAt: nil, version: "1")
        }
        let todos = ["l1": [todo("h", "# Launch day"), todo("a", "Launch the beta"), todo("b", "Write the launch post"), todo("c", "Launch rehearsal", .completed)]]
        let found = Search.local(rows: [list, faq], surfaces: surfaces, artifacts: [countdown], todos: todos, query: "launch")
        XCTAssertEqual(found.map(\.key), ["document:f1", "artifact:c1", "surface:l1", "todo:a", "todo:b"])
        XCTAssertEqual(found.map(\.detail), ["Document", "Web page", "Todo list · 2 open", "Launch checklist", "Launch checklist"])
        guard case .todo(let item, let opens) = found[3].found else { return XCTFail("a todo") }
        XCTAssertEqual(item.text, "Launch the beta")
        XCTAssertEqual(opens.id, "l1")
        // Before its todos are read, a list says nothing of them.
        XCTAssertEqual(Search.local(rows: [list, faq], surfaces: surfaces, query: "launch").map(\.detail), ["Document", "Todo list"])
    }
}
