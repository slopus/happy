import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// Archive and Leave take a row off the sidebar the moment they are asked
/// for, keep it off through every read while the computer answers, and put
/// it back only when the computer refuses.
final class StemCellsRemovalTests: XCTestCase {
    private func space(_ id: String) -> AgentWire.Space {
        AgentWire.Space(
            id: id, title: "Task \(id)", icon: nil,
            target: AgentWire.SpaceTarget(kind: "task", id: "t\(id)", agentId: "a\(id)", workspaceId: "w\(id)"),
            placement: "settled", version: 1, createdAt: 1, updatedAt: 1
        )
    }

    private func store(_ computer: Computer) -> (StemCellsStore, AsyncStream<StemCellsSnapshot>.AsyncIterator) {
        let store = StemCellsStore(client: DirectAgentClient(transport: computer, token: "t"))
        return (store, store.updates.makeAsyncIterator())
    }

    private func shown(_ updates: inout AsyncStream<StemCellsSnapshot>.AsyncIterator) async -> [String] {
        await updates.next()?.rows.compactMap(\.spaceId) ?? []
    }

    func testArchiveTakesTheRowOffAtOnceAndARefusalPutsItBack() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        var rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "b"])

        await computer.hold()
        await store.archive(kind: "task", id: "ta", nodeId: "a")
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"], "the row waited for the computer")

        // A read while the computer hasn't answered still lists it: it stays off.
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["b"], "a read brought the row back")

        await computer.answer(409)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a", "b"], "a refusal didn't bring the row back")
    }

    func testLeaveStaysOffUntilTheComputerNoLongerHasIt() async throws {
        let computer = Computer(spaces: [space("a"), space("b")])
        var (store, updates) = store(computer)
        await store.externalResync(loadSidebar: true)
        _ = await shown(&updates)

        await computer.hold()
        await store.leave(taskId: "tb", nodeId: "b")
        var rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
        await computer.answer(200)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"], "confirmed, the row came back")

        // The computer's events lag its answer: a read that still lists it keeps it off.
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"], "a late read brought the row back")

        // Then the computer drops it, and it is let go of.
        await computer.drop("b")
        await store.externalResync(loadSidebar: true)
        rows = await shown(&updates)
        XCTAssertEqual(rows, ["a"])
    }
}

/// A computer holding a sidebar of spaces. A write waits while `hold` is
/// on, until `answer` says how it went.
private actor Computer: DirectTransport {
    private var spaces: [AgentWire.Space]
    private var holding = false
    private var waiting: [CheckedContinuation<Int, Never>] = []
    private var held: Int?

    init(spaces: [AgentWire.Space]) { self.spaces = spaces }

    func hold() { holding = true }

    func answer(_ status: Int) {
        holding = false
        held = status
        for waiter in waiting { waiter.resume(returning: status) }
        waiting = []
    }

    func drop(_ id: String) { spaces.removeAll { $0.id == id } }

    nonisolated func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        try await respond(method, path)
    }

    private func respond(_ method: String, _ path: String) async throws -> DirectHTTPResponse {
        func json(_ value: Any) -> DirectHTTPResponse {
            DirectHTTPResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: value))
        }
        if method != "GET" {
            let status = holding ? await withCheckedContinuation { waiting.append($0) } : (held ?? 200)
            return DirectHTTPResponse(status: status, body: Data("{}".utf8))
        }
        switch path.split(separator: "?").first.map(String.init) ?? path {
        case "/v0/health":
            return json(["ready": true, "capabilities": ["sidebarOperations": true]])
        case "/v0/spaces/sidebar":
            let html = "<nav><happy-search/><happy-create/>" + spaces.map { "<happy-space id=\"\($0.id)\"/>" }.joined() + "</nav>"
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(spaces))
            return json(["artifactId": "sidebar", "version": 1, "html": html, "spaces": encoded])
        case "/v0/bots":
            return json(["bots": []])
        case "/v0/tasks":
            return json(["tasks": []])
        default:
            if path.hasPrefix("/v0/tasks/") { return json(["task": ["version": "v1"]]) }
            return DirectHTTPResponse(status: 404, body: Data("{}".utf8))
        }
    }

    nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> DirectHTTPStream { throw DirectAgentError.invalidResponse }
    nonisolated func reset() async {}
    nonisolated func close() async {}
}
