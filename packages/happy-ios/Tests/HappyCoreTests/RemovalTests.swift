import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// Archive, Leave and Close new work take a row off the sidebar the moment
/// they are asked for, as desktop's `spaceRemove` (c15edf9c) does: nothing
/// that still lists the row brings it back, neither a read nor an event,
/// and no timer does either. It is let go of once the computer no longer
/// has it, and comes back only when the computer refuses.
final class RemovalTests: XCTestCase {
    private func space(_ id: String, kind: String = "task", title: String? = nil) -> AgentWire.Space {
        AgentWire.Space(
            id: id, title: title ?? "Task \(id)", icon: nil,
            target: AgentWire.SpaceTarget(kind: kind, id: "t\(id)", agentId: "a\(id)", workspaceId: "w\(id)"),
            placement: "settled", version: 1, createdAt: 1, updatedAt: 1
        )
    }

    private func newWork(_ id: String) -> AgentWire.Space {
        AgentWire.Space(
            id: id, title: nil, icon: .seedling,
            target: AgentWire.SpaceTarget(kind: "task", id: "t\(id)", agentId: "a\(id)", workspaceId: "w\(id)"),
            placement: "settled", version: 1, createdAt: 1, updatedAt: 1
        )
    }

    private func store(_ computer: Computer) -> (Store, AsyncStream<Snapshot>.AsyncIterator) {
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        return (store, store.updates.makeAsyncIterator())
    }

    private func shown(_ updates: inout AsyncStream<Snapshot>.AsyncIterator) async -> [String] {
        await updates.next()?.rows.compactMap(\.spaceId) ?? []
    }

    /// Every space and session row, folded or not.
    private func every(_ updates: inout AsyncStream<Snapshot>.AsyncIterator) async -> [String] {
        await updates.next()?.allRows.filter { $0.kind == .space || $0.kind == .session }.map(\.id) ?? []
    }

    private func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        .object(["type": .string(type), "payload": .object(payload)])
    }

    private func json(_ space: AgentWire.Space) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(space))
    }

    func testArchiveTakesTheRowOffAtOnceAndARefusalPutsItBack() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        var rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "b"])

        await computer.hold()
        let archived = Task { await store.archive(kind: "task", id: "ta", nodeId: "a") }
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"], "the row waited for the computer")

        // A read while the computer hasn't answered still lists it: it stays off.
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"], "a read brought the row back")

        await computer.answer(409, error: "Only its owner may archive it")
        let snapshot = await updates.next()
        XCTAssertEqual(snapshot?.rows.compactMap(\.spaceId), ["a", "b"], "a refusal didn't bring the row back where it was")
        XCTAssertEqual(snapshot?.error, "Only its owner may archive it", "the computer's reason wasn't shown")
        let taken = await archived.value
        XCTAssertFalse(taken)
    }

    /// No timer lets go of it: a read or an event that still lists it,
    /// long after the computer said yes, keeps it off. It is let go of
    /// once a full read no longer lists it.
    func testLeaveStaysOffUntilAReadNoLongerListsIt() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        let left = Task { await store.leave(taskId: "tb", nodeId: "b") }
        var rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
        await computer.answer(200)
        let taken = await left.value
        XCTAssertTrue(taken)

        // The computer's events lag its answer: what still lists it keeps it off.
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"], "a late read brought the row back")
        var renamed = space("b", title: "Renamed")
        renamed.version = 2
        await store.externalEvent(event("space.updated", ["space": try json(renamed)]))
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"], "a late event brought the row back")

        // Then a read no longer lists it, and it is let go of: joined
        // again later, it shows.
        await computer.drop("b")
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
        await computer.add(space("b"))
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "b"], "the row was held off after the computer let it go")
    }

    func testSpaceRemovedLetsGoOfIt() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        _ = await store.archive(kind: "bot", id: "tb", nodeId: "b")
        _ = await shown(&updates)
        await store.externalEvent(event("space.removed", ["spaceId": .string("b")]))
        _ = await shown(&updates)
        // Made again, it is a new row and shows.
        await store.externalResync(loadSidebar: true)
        let rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "b"], "space.removed didn't let go of it")
    }

    /// A second press while the first is on its way sends nothing and
    /// gets the first one's answer.
    func testASecondPressSharesTheFirst() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        let first = Task { await store.archive(kind: "task", id: "ta", nodeId: "a") }
        let rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"])
        let second = Task { await store.archive(kind: "task", id: "ta", nodeId: "a") }
        try await Task.sleep(for: .milliseconds(100))
        await computer.answer(409)
        let (one, two) = await (first.value, second.value)
        XCTAssertFalse(one)
        XCTAssertFalse(two, "the second press didn't share the refusal")
        let archives = await computer.writes.filter { $0.hasSuffix("/archive") }
        XCTAssertEqual(archives, ["/v0/tasks/ta/archive"], "the second press asked again")
    }

    /// Already gone on the computer (404) is taken, not refused.
    func testGoneAlreadyIsTaken() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        let left = Task { await store.leave(taskId: "ta", nodeId: "a") }
        _ = await shown(&updates)
        await computer.answer(404)
        let taken = await left.value
        XCTAssertTrue(taken)
        await store.externalResync(loadSidebar: true)
        let rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"], "gone already brought the row back")
    }

    func testLeavingASurfaceTakesItsRowOff() async throws {
        let computer = Computer(spaces: [space("a"), space("s", kind: "surface")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        let left = Task { await store.leave(surfaceId: "ts", nodeId: "s") }
        let rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
        await computer.answer(200)
        _ = await left.value
        let writes = await computer.writes
        XCTAssertEqual(writes, ["/v0/surfaces/ts/leave"])
    }

    /// Close new work: gone already (404) stays gone.
    func testClosedNewWorkGoneAlreadyStaysGone() async throws {
        let computer = Computer(spaces: [space("a"), newWork("n")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        let closed = Task { await store.discard("n") }
        var rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
        await computer.answer(404)
        let taken = await closed.value
        XCTAssertTrue(taken)
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"], "new work already gone came back")
    }

    /// Close new work whose chat has a message (409): back, and the
    /// sidebar read again.
    func testClosedNewWorkWithAMessageComesBack() async throws {
        let computer = Computer(spaces: [space("a"), newWork("n")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)
        let readsBefore = await computer.sidebarReads

        await computer.hold()
        let closed = Task { await store.discard("n") }
        _ = await shown(&updates)
        await computer.answer(409)
        let rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "n"], "refused, the new work stayed off")
        let taken = await closed.value
        XCTAssertFalse(taken)
        var readsAfter = readsBefore
        for _ in 0..<50 where readsAfter == readsBefore {
            try await Task.sleep(for: .milliseconds(20))
            readsAfter = await computer.sidebarReads
        }
        XCTAssertGreaterThan(readsAfter, readsBefore, "the sidebar wasn't read again")
    }

    /// A subtask's row stays in the computer's document after it is
    /// archived; it stays off until no bot or task holds the subtask.
    func testAnArchivedSubtaskStaysOffWhileTheDocumentKeepsIt() async throws {
        let computer = Computer(spaces: [space("b", kind: "bot")], nested: ["b": ["s1"]], subtasks: ["s1"])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        var rows = await every(&updates)
        XCTAssertEqual(rows, ["space:b", "session:s1"])

        await computer.hold()
        let archived = Task { await store.archiveSubtask("s1", nodeId: "s1") }
        rows = await every(&updates)
        XCTAssertEqual(rows, ["space:b"], "the subtask's row waited for the computer")
        await computer.answer(200)
        _ = await archived.value

        // Its events haven't come yet: the bot still holds it.
        await store.externalResync(loadSidebar: true)
        rows = await every(&updates)
        XCTAssertEqual(rows, ["space:b"], "a late read brought the subtask back")

        // The bot no longer holds it, though the document still does.
        await computer.setSubtasks([])
        await store.externalResync(loadSidebar: true)
        rows = await every(&updates)
        XCTAssertEqual(rows, ["space:b"])
        // Let go of: restored later, it shows again.
        await computer.setSubtasks(["s1"])
        await store.externalResync(loadSidebar: true)
        rows = await every(&updates)
        XCTAssertEqual(rows, ["space:b", "session:s1"], "the subtask was held off after the computer let it go")
    }
}

/// New work asked for again while the first ask is still on its way gets
/// that same one, as desktop's `create` does: the dock any, a
/// heading's "+" only its own heading's.
final class NewWorkGuardTests: XCTestCase {
    func testAnAskOnItsWayAnswersTheNextOne() async throws {
        var empty = AgentWire.Space(
            id: "n", title: nil, icon: .seedling,
            target: AgentWire.SpaceTarget(kind: "task", id: "tn", agentId: "an", workspaceId: "wn"),
            placement: "settled", version: 1, createdAt: 1, updatedAt: 1
        )
        empty.sectionId = nil
        let computer = Computer(spaces: [empty])
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        await store.externalResync(loadSidebar: true)
        // The computer is slow to say whether the new work is empty.
        await computer.hold(reads: true)
        let dock = await store.goToNewWork(under: nil)
        let again = await store.goToNewWork(under: nil)
        XCTAssertEqual(dock.id, again.id, "a second tap made a second ask")
        let plus = await store.goToNewWork(under: "work")
        XCTAssertNotEqual(plus.id, dock.id, "a heading's + took the dock's ask")
        let plusAgain = await store.goToNewWork(under: "work")
        XCTAssertEqual(plus.id, plusAgain.id)
        await computer.answer(200)
        let went = await dock.work.value
        XCTAssertEqual(went.spaceId, "n", "the empty new work wasn't reused")
    }
}

/// A computer holding a sidebar of spaces, and one bot's subtasks. A write
/// waits while `hold` is on, until `answer` says how it went.
private actor Computer: AgentTransport {
    private var spaces: [AgentWire.Space]
    /// The sessions the document nests under each space.
    private let nested: [String: [String]]
    /// The subtasks the bot `tb` holds.
    private var subtasks: [String]
    private var holding = false
    /// Reads of a conversation wait too.
    private var holdingReads = false
    private var waiting: [CheckedContinuation<(Int, String?), Never>] = []
    private var held: (Int, String?)?
    /// Every write's path, in order.
    private(set) var writes: [String] = []
    private(set) var sidebarReads = 0

    init(spaces: [AgentWire.Space], nested: [String: [String]] = [:], subtasks: [String] = []) {
        self.spaces = spaces
        self.nested = nested
        self.subtasks = subtasks
    }

    func hold(reads: Bool = false) { holding = true; holdingReads = reads }

    func answer(_ status: Int, error: String? = nil) {
        holding = false
        holdingReads = false
        held = (status, error)
        for waiter in waiting { waiter.resume(returning: (status, error)) }
        waiting = []
    }

    func drop(_ id: String) { spaces.removeAll { $0.id == id } }
    func add(_ space: AgentWire.Space) { spaces.append(space) }
    func setSubtasks(_ ids: [String]) { subtasks = ids }

    nonisolated func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await respond(method, path)
    }

    private func respond(_ method: String, _ path: String) async throws -> HTTP1Response {
        func json(_ value: Any) -> HTTP1Response {
            HTTP1Response(status: 200, body: try! JSONSerialization.data(withJSONObject: value))
        }
        if holdingReads, path.hasPrefix("/v0/agents/") {
            _ = await withCheckedContinuation { waiting.append($0) }
        }
        if path.hasPrefix("/v0/agents/"), method == "GET" {
            if path.contains("/messages") { return json(["runs": [], "hasMore": false]) }
            if path.hasSuffix("/bootstrap") { return json(["agent": ["id": "an", "workspaceId": "wn", "status": "idle"], "pending": [], "draft": ["value": NSNull(), "updatedAt": NSNull()]]) }
        }
        if method != "GET" {
            writes.append(path)
            let (status, error) = holding ? await withCheckedContinuation { waiting.append($0) } : (held ?? (200, nil))
            let body = try JSONSerialization.data(withJSONObject: error.map { ["error": $0] } ?? [:])
            return HTTP1Response(status: status, body: body)
        }
        switch path.split(separator: "?").first.map(String.init) ?? path {
        case "/v0/health":
            return json(["ready": true, "capabilities": ["sidebarOperations": true]])
        case "/v0/spaces/sidebar":
            sidebarReads += 1
            let html = "<nav><happy-search/><happy-create/>" + spaces.map { space in
                let sessions = nested[space.id] ?? []
                return sessions.isEmpty ? "<happy-space id=\"\(space.id)\"/>"
                    : "<happy-space id=\"\(space.id)\" expanded=\"true\">" + sessions.map { "<happy-space id=\"\($0)\"/>" }.joined() + "</happy-space>"
            }.joined() + "</nav>"
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(spaces))
            return json(["artifactId": "sidebar", "version": 1, "html": html, "spaces": encoded])
        case "/v0/bots":
            let children = subtasks.map { ["id": $0, "workspaceId": "w\($0)", "parentAgentId": "ab", "subtask": true, "status": "idle", "version": "1"] as [String: Any] }
            return json(["bots": [["id": "tb", "name": "Bot", "version": "1", "agent": ["id": "ab", "workspaceId": "wb", "status": "idle", "version": "1", "subtasks": children]]]])
        case "/v0/tasks":
            return json(["tasks": []])
        default:
            if path.hasPrefix("/v0/tasks/") { return json(["task": ["version": "v1"]]) }
            if path.hasPrefix("/v0/bots/") { return json(["bot": ["version": "v1"]]) }
            return HTTP1Response(status: 404, body: Data("{}".utf8))
        }
    }

    nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    nonisolated func reset() async {}
    nonisolated func close() async {}
}
