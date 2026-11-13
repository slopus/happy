import Foundation
@testable import HappyCore
import HappyWire
import XCTest

/// A computer with one task whose agent works: each word moves its
/// version. Its bots and tasks reads are counted, and can be held.
private actor PlacesComputer: AgentTransport {
    private(set) var tasksReads = 0
    private(set) var botsReads = 0
    private(set) var version = 1
    private var holding = false
    private var held: [CheckedContinuation<Void, Never>] = []

    func hold() { holding = true }
    func release() { holding = false; held.forEach { $0.resume() }; held = [] }

    /// The agent's next word: its version moves on, and the event says so.
    func word() -> JSONValue {
        version += 1
        return .object(["type": .string("agent.updated"), "payload": .object([
            "agentId": .string("a1"), "previousVersion": .string(Self.name(version - 1)), "version": .string(Self.name(version)),
            "changes": .object(["statusLine": .object(["text": .string("word \(version)")])]),
        ])])
    }

    static func name(_ version: Int) -> String { String(format: "v%04d", version) }

    nonisolated func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await respond(path.split(separator: "?").first.map(String.init) ?? path)
    }

    private func respond(_ path: String) async throws -> HTTP1Response {
        let value: JSONValue
        switch path {
        case "/v0/tasks":
            tasksReads += 1
            // The list is as it was when asked, whatever comes while it travels.
            let at = version
            if holding { await withCheckedContinuation { held.append($0) } }
            value = .object(["tasks": .array([.object(["id": .string("t1"), "name": .string("Task"),
                                                       "agent": .object(["id": .string("a1"), "workspaceId": .string("w"), "version": .string(Self.name(at))])])]),
                             "memberships": .array([.object(["taskId": .string("t1")])])])
        case "/v0/bots":
            botsReads += 1
            value = .object(["bots": .array([])])
        default:
            return HTTP1Response(status: 404, body: Data("{}".utf8))
        }
        return HTTP1Response(status: 200, body: try JSONEncoder().encode(value))
    }

    nonisolated func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw AgentClientError.invalidResponse }
    nonisolated func close() async {}
}

/// The bots and tasks read again for news: never for every word an agent
/// writes, and never more often than `placesRereadInterval`.
final class PlacesReadTests: XCTestCase {
    private func eventually(_ what: String, _ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("not in time: \(what)")
    }

    private static let created: JSONValue = .object(["type": .string("task.created"), "payload": .object(["membership": .object(["taskId": .string("t1")])])])

    /// A fresh task's agent writes while its list is read: the words that
    /// came meanwhile follow the copy read, so the list is read once.
    func testAWorkingAgentDoesNotReadTheListsAgainWithEveryWord() async throws {
        let computer = PlacesComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"))
        await computer.hold()
        await store.externalEvent(Self.created)
        try await eventually("the read") { await computer.tasksReads == 1 }
        for _ in 0..<5 { await store.externalEvent(await computer.word()) }
        await computer.release()
        for _ in 0..<20 {
            await store.externalEvent(await computer.word())
            try await Task.sleep(for: .milliseconds(20))
        }
        try await Task.sleep(for: .milliseconds(500))
        let reads = await computer.tasksReads
        XCTAssertEqual(reads, 1)
        await store.stop()
    }

    /// News that does need the lists, coming fast: one read on its way,
    /// the next `placesRereadInterval` after it.
    func testListNewsIsReadAtMostOncePerInterval() async throws {
        let computer = PlacesComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"), placesRereadInterval: .seconds(1))
        let started = ContinuousClock.now
        await store.externalEvent(Self.created)
        try await eventually("the first read") { await computer.tasksReads == 1 }
        while ContinuousClock.now - started < .milliseconds(1500) {
            await store.externalEvent(Self.created)
            try await Task.sleep(for: .milliseconds(50))
        }
        let reads = await computer.tasksReads
        XCTAssertLessThanOrEqual(reads, 2)
        await store.stop()
    }

    /// A task made after the lists were read is taken from its own events,
    /// at its place in the person's list: the lists aren't read again for it.
    func testANewTaskIsTakenFromItsEventsWithoutReadingTheLists() async throws {
        let computer = PlacesComputer()
        let store = Store(client: AgentClient(transport: computer, token: "t"), placesRereadInterval: .zero)
        let seen = Task { () -> Bool in
            var read = false
            for await snapshot in store.updates {
                if snapshot.references.agents["a1"] != nil { read = true }
                if read, snapshot.references.agents["a2"]?.label == "New" { return true }
            }
            return false
        }
        await store.externalEvent(Self.created)
        try await eventually("the read") { await computer.tasksReads == 1 }
        try await Task.sleep(for: .milliseconds(200))
        await store.externalEvent(.object(["type": .string("task.created"), "payload": .object(["task": .object([
            "id": .string("t2"), "name": .string("New"), "agent": .object(["id": .string("a2"), "workspaceId": .string("w2")]),
        ])])]))
        await store.externalEvent(.object(["type": .string("task.joined"), "payload": .object(["membership": .object([
            "taskId": .string("t2"), "orderKey": .string("0"),
        ])])]))
        let timeout = Task { try await Task.sleep(for: .seconds(4)); seen.cancel() }
        let shown = await seen.value
        timeout.cancel()
        XCTAssertTrue(shown)
        try await Task.sleep(for: .milliseconds(200))
        let reads = await computer.tasksReads
        XCTAssertEqual(reads, 1)
        await store.stop()
    }
}
