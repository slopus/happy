@testable import HappyCore
import HappyWire
import XCTest

/// An agent looped the person into a task: the person's membership of it
/// carries the mark, and the task's row is new until they read it.
final class LoopInTests: XCTestCase {
    private static func space(_ id: String, task: String) -> AgentWire.Space {
        AgentWire.Space(id: id, title: id.capitalized, icon: nil, target: AgentWire.SpaceTarget(kind: "task", id: task, agentId: nil, workspaceId: nil), version: 1, createdAt: 0, updatedAt: 0)
    }

    private static func task(_ id: String, unread: AgentWire.TaskUnread?) -> AgentWire.Task {
        AgentWire.Task(id: id, name: id, canArchive: false, version: "1", agent: nil, membership: AgentWire.TaskMembership(taskId: id, unread: unread))
    }

    func testALoopedInTasksRowIsNewUntilTheMarkClears() throws {
        let document = try SpaceSidebar.parse("<nav><happy-search/><happy-create/><happy-space id=\"refund\"/><happy-space id=\"other\"/></nav>")
        let spaces = ["refund": Self.space("refund", task: "t1"), "other": Self.space("other", task: "t2")]
        let mark = AgentWire.TaskUnread(reason: "looped_in", since: 1_761_620_000_000, agentId: "agt456", note: "This changes how refunds hit Stripe.")
        var places = Places(tasks: [Self.task("t1", unread: mark), Self.task("t2", unread: nil)])
        var rows = Rows.all(document, spaces: spaces, places: places, agentIcons: [:]).filter { $0.kind == .space }
        XCTAssertEqual(rows.map(\.isNew), [true, false])
        XCTAssertTrue(rows[0].hasTrailingMark)
        // Independent of the conversation's own unread turn.
        XCTAssertFalse(rows[0].unread)

        places.tasks[0].membership?.unread = nil
        rows = Rows.all(document, spaces: spaces, places: places, agentIcons: [:]).filter { $0.kind == .space }
        XCTAssertEqual(rows.map(\.isNew), [false, false])
        XCTAssertFalse(rows[0].hasTrailingMark)
    }

    /// The mark as the daemon sends it; one this build can't read is no mark, never a lost task.
    func testTheMembershipDecodesLeniently() throws {
        let sent = #"{"id":"t1","name":"Refund flow","membership":{"taskId":"t1","userId":"usrsteve","orderKey":"a0","joinedAt":1,"unread":{"reason":"looped_in","since":1761620000000,"agentId":"agt456","note":"Stripe."}}}"#
        let task = try JSONDecoder().decode(AgentWire.Task.self, from: Data(sent.utf8))
        XCTAssertEqual(task.membership?.unread, AgentWire.TaskUnread(reason: "looped_in", since: 1_761_620_000_000, agentId: "agt456", note: "Stripe."))
        let odd = #"{"id":"t1","membership":{"taskId":"t1","unread":"yes"}}"#
        XCTAssertNil(try JSONDecoder().decode(AgentWire.Task.self, from: Data(odd.utf8)).membership?.unread)
        let older = #"{"id":"t1"}"#
        XCTAssertNil(try JSONDecoder().decode(AgentWire.Task.self, from: Data(older.utf8)).membership)
    }

    /// `GET /v0/tasks?scope=joined` sends memberships beside the tasks; each lands on its task.
    func testJoinedTasksCarryTheirMembership() async throws {
        let answer = #"{"tasks":[{"id":"t1"},{"id":"t2"}],"memberships":[{"taskId":"t2","unread":{"reason":"looped_in","since":5}}]}"#
        let client = AgentClient(transport: Answering(body: Data(answer.utf8)), token: "x")
        let tasks = try await client.tasks()
        XCTAssertNil(tasks[0]["membership"])
        XCTAssertEqual(tasks[1]["membership"]?["unread"]?["reason"]?.stringValue, "looped_in")
    }
}

/// An HTML artifact that asks to be shown inline is a page the conversation draws.
final class InlinePageDecisionTests: XCTestCase {
    private func object(_ fields: [String: JSONValue]) -> JSONValue {
        var base: [String: JSONValue] = [
            "id": .string("a1"), "type": .string("html"), "title": .string("Voice waveform"), "status": .string("active"),
            "latestVersion": .number(3), "entry": .object(["path": .string("index.html"), "mimeType": .string("text/html")]),
            "display": .string("inline_expanded"), "live": .null, "background": .null,
        ]
        for (key, value) in fields { base[key] = value }
        return .object(base)
    }

    func testOnlyAnInlineExpandedPageOfFilesIsShownInline() {
        XCTAssertEqual(References.page(object([:])), References.Page(version: 3, entry: "index.html"))
        XCTAssertEqual(References.page(object(["background": .string("#0B0B0F")]))?.background, "#0b0b0f")
        XCTAssertNil(References.page(object(["background": .string("red")]))?.background)
        for display: JSONValue in [.null, .string("side"), .string("inline_compact"), .string("someday")] {
            XCTAssertNil(References.page(object(["display": display])), "\(display)")
        }
        XCTAssertNil(References.page(object(["type": .string("markdown")])))
        XCTAssertNil(References.page(object(["status": .string("deleted")])))
        XCTAssertNil(References.page(object(["live": .object(["url": .string("http://localhost:5173/")])])))
        XCTAssertNil(References.page(object(["entry": .null])))
    }
}

/// Answers every request with one body.
private struct Answering: AgentTransport {
    let body: Data
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        HTTP1Response(status: 200, body: self.body)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    func reset() async {}
    func close() async {}
}
