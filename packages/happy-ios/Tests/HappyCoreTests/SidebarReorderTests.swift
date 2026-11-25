import Foundation
import HappyWire
import XCTest
@testable import HappyCore

/// Moving a bot or task in home's list (`SidebarReorder`): only among its
/// own kind, with what nests under it, told to the computer as desktop
/// tells it, and shown where it was put until the computer has it.
final class SidebarReorderTests: XCTestCase {
    private func rows() throws -> [Row] {
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(ClassicSidebarTests.fixture.utf8))
        return Rows.visible(SidebarRows.make(desktop, settings: [:]))
    }

    private func labels(_ rows: [Row]) -> [String] { rows.map { $0.kind == .separator ? "—" : $0.label } }

    private func index(_ rows: [Row], _ label: String) throws -> Int {
        try XCTUnwrap(rows.firstIndex { $0.label == label })
    }

    func testOnlyBotsAndTasksMove() throws {
        let rows = try rows()
        XCTAssertEqual(rows.filter(SidebarReorder.movable).map(\.label), ["Happy", "Research", "Release", "Three", "One", "Two"])
    }

    /// A bot's family is the bots, each with its subtasks; a task's the tasks.
    func testAFamilyIsItsKindsRowsWithWhatNestsUnderThem() throws {
        let rows = try rows()
        let bots = try XCTUnwrap(SidebarReorder.family(rows, at: try index(rows, "Research")))
        XCTAssertEqual(bots.map { labels(Array(rows[$0])) }, [["Happy", "Sub one", "Sub two"], ["Research"], ["Release"]])
        let tasks = try XCTUnwrap(SidebarReorder.family(rows, at: try index(rows, "Two")))
        XCTAssertEqual(tasks.map { labels(Array(rows[$0])) }, [["Three"], ["One"], ["Two"]])
        XCTAssertNil(SidebarReorder.family(rows, at: try index(rows, "Sub one")), "a subtask moved")
        XCTAssertNil(SidebarReorder.family(rows, at: try index(rows, "App")), "a project moved")
    }

    func testAMoveCarriesWhatNestsAndStaysInItsSection() throws {
        let rows = try rows()
        let last = SidebarReorder.moved(rows, SidebarReorder.Move(kind: "bot", id: "happy", afterId: "release"))
        XCTAssertEqual(labels(last), [
            "Artifacts", "Todos", "Notes", "Groceries",
            "—", "Research", "Release", "Happy", "Sub one", "Sub two",
            "—", "Three", "One", "Two",
            "—", "App", "Root chat", "Feature", "Fix", "Docs",
        ])
        let first = SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t2", afterId: nil))
        XCTAssertEqual(Array(labels(first)[11...13]), ["Two", "Three", "One"])
        let middle = SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t3", afterId: "t1"))
        XCTAssertEqual(Array(labels(middle)[11...13]), ["One", "Three", "Two"])
    }

    /// Where it already stands, after one of another kind, or after one
    /// that isn't listed: nothing moves.
    func testAMoveThatGoesNowhereChangesNothing() throws {
        let rows = try rows()
        XCTAssertEqual(SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t1", afterId: "t3")), rows)
        XCTAssertEqual(SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t3", afterId: nil)), rows)
        XCTAssertEqual(SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t1", afterId: "research")), rows)
        XCTAssertEqual(SidebarReorder.moved(rows, SidebarReorder.Move(kind: "task", id: "t1", afterId: "gone")), rows)
        XCTAssertEqual(SidebarReorder.moved(rows, SidebarReorder.Move(kind: "bot", id: "t1", afterId: nil)), rows)
    }

    /// A place among the peers, counted without the row, as the route's
    /// `afterId`: the peer it now follows, nil for first.
    func testAPlaceIsTheRowItNowFollows() throws {
        let rows = try rows()
        let release = try index(rows, "Release")
        XCTAssertEqual(SidebarReorder.move(rows, at: release, to: 0), SidebarReorder.Move(kind: "bot", id: "release", afterId: nil))
        XCTAssertEqual(SidebarReorder.move(rows, at: release, to: 1), SidebarReorder.Move(kind: "bot", id: "release", afterId: "happy"))
        XCTAssertNil(SidebarReorder.move(rows, at: release, to: 2), "where it stands")
        let happy = try index(rows, "Happy")
        XCTAssertEqual(SidebarReorder.move(rows, at: happy, to: 2), SidebarReorder.Move(kind: "bot", id: "happy", afterId: "release"))
        XCTAssertEqual(SidebarReorder.move(rows, at: happy, to: 9), SidebarReorder.Move(kind: "bot", id: "happy", afterId: "release"), "past the end is last")
        XCTAssertNil(SidebarReorder.move(rows, at: try index(rows, "App"), to: 0))
    }

    /// Moves waiting for the computer replay in the order made, each kept
    /// as its own: moving one row twice keeps both.
    func testWaitingMovesShowInTheOrderMade() async throws {
        let outbox = IntentOutbox(storage: MemoryIntentStorage())
        try await outbox.enqueue(.reorder, target: "t2", value: .object(["kind": "task", "afterId": .null]))
        try await outbox.enqueue(.reorder, target: "t1", value: .object(["kind": "task", "afterId": "t2"]))
        try await outbox.enqueue(.reorder, target: "t2", value: .object(["kind": "task", "afterId": "t3"]))
        let pending = await outbox.pending()
        XCTAssertEqual(pending.count, 3, "a later move of the same row replaced an earlier one")
        let overlay = IntentOverlay(Array(pending.reversed()))
        XCTAssertEqual(overlay.moves.map(\.id), ["t2", "t1", "t2"])
        // Three One Two → Two Three One → Two One Three → One Three Two.
        XCTAssertEqual(Array(labels(overlay.apply(try rows()))[11...13]), ["One", "Three", "Two"])
    }

    /// A task archived here is gone even while a move of it waits.
    func testAMoveOfAnArchivedRowIsNothing() throws {
        let overlay = IntentOverlay([
            Intent(kind: .archive, target: "t1", value: .object(["kind": "task"]), createdAt: 1),
            Intent(kind: .reorder, target: "t1", value: .object(["kind": "task", "afterId": .null]), createdAt: 2),
        ])
        XCTAssertEqual(Array(labels(overlay.apply(try rows()))[11...12]), ["Three", "Two"])
    }

    // MARK: Routes

    private actor ReorderServer: AgentTransport {
        struct Sent: Equatable { var method: String; var path: String; var headers: [String: String]; var body: JSONValue? }
        private(set) var sent: [Sent] = []
        var version = "v1"
        var conflicts = 0

        func setConflicts(_ count: Int) { conflicts = count }

        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            sent.append(Sent(method: method, path: path, headers: headers, body: try body.map { try JSONDecoder().decode(JSONValue.self, from: $0) }))
            switch (method, path) {
            case ("GET", "/v0/bots/b1"):
                return HTTP1Response(status: 200, body: Data(#"{"bot":{"id":"b1","version":"\#(version)"}}"#.utf8))
            case ("POST", "/v0/bots/b1/reorder"):
                if conflicts > 0 || headers["If-Match"] != version {
                    conflicts = max(0, conflicts - 1)
                    version = "v\(sent.count)"
                    return HTTP1Response(status: 409, body: Data(#"{"error":"The bot has changed.","code":"version_conflict"}"#.utf8))
                }
                return HTTP1Response(status: 200, body: Data(#"{"bot":{"id":"b1"}}"#.utf8))
            case ("POST", "/v0/tasks/t1/reorder"):
                return HTTP1Response(status: 200, body: Data(#"{"task":{"id":"t1"},"membership":null}"#.utf8))
            default:
                return HTTP1Response(status: 404)
            }
        }

        func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
        func reset() async {}
        func close() async {}
    }

    /// A task moves in the person's own list by its route; a bot names the
    /// version it moves, and one that lost a race reads the newer and moves
    /// that. Each carries the intent's ID as its mutation ID.
    func testMovesGoByDesktopsRoutes() async throws {
        let server = ReorderServer()
        let client = AgentClient(transport: server, token: "t")
        let task = Intent(kind: .reorder, target: "t1", value: .object(["kind": "task", "afterId": "t3"]), createdAt: 1)
        try await SyncEngine.deliver(task, client: client)
        var sent = await server.sent
        XCTAssertEqual(sent.map(\.path), ["/v0/tasks/t1/reorder"])
        XCTAssertEqual(sent[0].body, .object(["afterId": "t3", "mutationId": .string(task.id)]))

        await server.setConflicts(1)
        let bot = Intent(kind: .reorder, target: "b1", value: .object(["kind": "bot", "afterId": .null]), createdAt: 2)
        try await SyncEngine.deliver(bot, client: client)
        sent = Array(await server.sent.dropFirst())
        XCTAssertEqual(sent.map { "\($0.method) \($0.path)" }, ["GET /v0/bots/b1", "POST /v0/bots/b1/reorder", "GET /v0/bots/b1", "POST /v0/bots/b1/reorder"])
        XCTAssertEqual(sent[1].headers["If-Match"], "v1")
        XCTAssertEqual(sent[3].headers["If-Match"], "v3")
        XCTAssertEqual(sent[3].body, .object(["afterId": .null, "mutationId": .string(bot.id)]))
    }
}
