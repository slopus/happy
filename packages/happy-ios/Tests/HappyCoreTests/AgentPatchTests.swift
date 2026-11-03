import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer with one task whose agent streams: every token is an
/// `agent.updated` carrying `status` and `updatedAt`, as the daemon sends it.
private actor StreamingFixture: AgentTransport {
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":null},"userSettings":[],
     "projects":[{"id":"p","name":"App","status":"active","orderKey":"a","agents":[]}],
     "workspaces":[],
     "bots":[{"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"bot-agent","workspaceId":"bot-work","status":"idle","version":"b1","lastActivityAt":1792141200000,"subtasks":[{"id":"child","workspaceId":"w2","parentAgentId":"bot-agent","title":"Delegated","status":"idle","version":"c1","lastActivityAt":1792141200000}]}}],
     "tasks":[{"id":"t","name":"Streaming task","agent":{"id":"t-agent","workspaceId":"w1","status":"idle","version":"v0","lastActivityAt":1792141200000,"updatedAt":1792141200000}}],
     "taskMemberships":[{"taskId":"t"}],
     "surfaces":[]}
    """#
    var requested: [String] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func catalogReads() -> Int { requested.filter { $0 == "/v0/bootstrap/desktop" }.count }

    func emit(_ events: [JSONValue]) {
        var chunk = ""
        for event in events {
            chunk += "event: message\ndata: \(String(data: try! JSONEncoder().encode(event), encoding: .utf8)!)\n\n"
        }
        continuations.forEach { $0.yield(Data(chunk.utf8)) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append(path)
        if path == "/v0/bootstrap/desktop" { return .init(status: 200, body: Data(Self.fixture.utf8)) }
        return .init(status: 404, body: Data("{}".utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

private func updated(_ agentId: String, _ previous: String, _ version: String, _ changes: [String: JSONValue]) -> JSONValue {
    .object(["type": "agent.updated", "payload": .object([
        "agentId": .string(agentId), "previousVersion": .string(previous), "version": .string(version), "changes": .object(changes),
    ])])
}

/// Agents' own changes are applied where the phone holds them, as desktop
/// applies them, never by reading the whole catalog again.
final class AgentPatchTests: XCTestCase {
    private struct Timeout: Error {}

    private func desktop() throws -> DesktopSnapshot {
        try JSONDecoder().decode(DesktopSnapshot.self, from: Data(StreamingFixture.fixture.utf8))
    }

    private func wait(_ engine: SyncEngine, _ predicate: @escaping @Sendable (HomeSnapshot) -> Bool) async throws -> HomeSnapshot {
        try await withThrowingTaskGroup(of: HomeSnapshot.self) { group in
            group.addTask {
                for await snapshot in await engine.snapshots() where predicate(snapshot) { return snapshot }
                throw Timeout()
            }
            group.addTask { try await Task.sleep(for: .seconds(4)); throw Timeout() }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    func testAStatusChangeIsAppliedToTheHeldAgent() throws {
        let update = try XCTUnwrap(AgentPatch.update(updated("t-agent", "v0", "v1", ["status": "working", "updatedAt": 1792141201000])))
        let next = try XCTUnwrap(AgentPatch.apply(update, to: try desktop()))
        let agent = try XCTUnwrap(next.tasks?.first?.agent)
        XCTAssertEqual(agent.status, "working")
        XCTAssertEqual(agent.version, "v1")
        XCTAssertEqual(agent.updatedAt, 1792141201000)
        XCTAssertEqual(agent.lastActivityAt, 1792141200000)
        // Everything else is as it was.
        XCTAssertEqual(next.bots, try desktop().bots)
    }

    func testASubtaskIsPatchedInsideItsParent() throws {
        let update = try XCTUnwrap(AgentPatch.update(updated("child", "c1", "c2", ["status": "working"])))
        let next = try XCTUnwrap(AgentPatch.apply(update, to: try desktop()))
        let parent = try XCTUnwrap(next.bots?.first?.agent)
        XCTAssertEqual(parent.version, "b1")
        XCTAssertEqual(parent.subtasks?.first?.status, "working")
        XCTAssertEqual(parent.subtasks?.first?.version, "c2")
    }

    /// A gap, an agent not held, or a change that moves rows: a full read.
    func testWhatCantBePlacedIsLeftToARead() throws {
        let gap = try XCTUnwrap(AgentPatch.update(updated("t-agent", "v7", "v8", ["status": "working"])))
        XCTAssertNil(AgentPatch.apply(gap, to: try desktop()))
        let unknown = try XCTUnwrap(AgentPatch.update(updated("nobody", "v0", "v1", ["status": "working"])))
        XCTAssertNil(AgentPatch.apply(unknown, to: try desktop()))
        for key in ["archivedAt", "orderKey", "subtasks", "subtaskOrderKey", "workspaceId", "unread"] {
            XCTAssertNil(AgentPatch.update(updated("t-agent", "v0", "v1", [key: .null])), key)
        }
        XCTAssertNil(AgentPatch.update(.object(["type": "agent.updated", "payload": .object([:])])))
    }

    func testTheKeptBootstrapCarriesTheChange() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(StreamingFixture.fixture.utf8))
        let update = try XCTUnwrap(AgentPatch.update(updated("child", "c1", "c2", ["status": "working"])))
        let kept = AgentPatch.apply(update, to: value)
        let child = kept["bots"]?.arrayValue?.first?["agent"]?["subtasks"]?.arrayValue?.first
        XCTAssertEqual(child?["status"], "working")
        XCTAssertEqual(child?["version"], "c2")
        // Read back, it is the patched catalog.
        let typed = try JSONDecoder().decode(DesktopSnapshot.self, from: JSONEncoder().encode(kept))
        XCTAssertEqual(typed, AgentPatch.apply(update, to: try desktop()))
    }

    /// 200 tokens streamed: no read of the catalog, and Home hears exactly
    /// the two changes it shows (working, then idle), never a token's
    /// `updatedAt`.
    func testStreamedTokensReadNothingAndPublishOnlyWhatHomeShows() async throws {
        let transport = StreamingFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        try await Task.sleep(for: .milliseconds(400))
        let reads = await transport.catalogReads()
        let published = await engine.published
        XCTAssertEqual(reads, 1)

        var events = [updated("t-agent", "v0", "v1", ["status": "working", "updatedAt": 1792141201000])]
        for token in 1..<200 {
            events.append(updated("t-agent", "v\(token)", "v\(token + 1)", ["status": "working", "updatedAt": .number(1792141201000 + Double(token))]))
        }
        events.append(updated("t-agent", "v200", "v201", ["status": "idle", "updatedAt": 1792141202000]))
        await transport.emit(Array(events.prefix(100)))
        _ = try await wait(engine) { $0.rows.contains { $0.label == "Streaming task" && $0.status == .working } }
        await transport.emit(Array(events.dropFirst(100)))
        _ = try await wait(engine) { $0.rows.contains { $0.label == "Streaming task" && $0.status == .none } }
        // Past the coalescing delay a read would wait for.
        try await Task.sleep(for: .milliseconds(500))

        let readsAfter = await transport.catalogReads()
        let publishedAfter = await engine.published
        XCTAssertEqual(readsAfter - reads, 0, "a token's agent.updated read the whole catalog")
        XCTAssertEqual(publishedAfter - published, 2, "Home heard a change it doesn't show")
        await engine.stop()
    }

    /// A version gap is caught up by one read, and the stream goes on in place after it.
    func testAGapReadsTheCatalogOnce() async throws {
        let transport = StreamingFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        try await Task.sleep(for: .milliseconds(400))
        let reads = await transport.catalogReads()
        await transport.emit([updated("t-agent", "v5", "v6", ["status": "working"])])
        try await Task.sleep(for: .milliseconds(600))
        let readsAfter = await transport.catalogReads()
        XCTAssertEqual(readsAfter - reads, 1)
        // Conversation-only state never reads Home again.
        await transport.emit([
            .object(["type": "agent.context.updated", "payload": .object(["agentId": "t-agent", "context": .null])]),
            .object(["type": "agent.slash_commands.updated", "payload": .object(["agentId": "t-agent"])]),
        ])
        try await Task.sleep(for: .milliseconds(600))
        let readsLast = await transport.catalogReads()
        XCTAssertEqual(readsLast - readsAfter, 0)
        await engine.stop()
    }
}
