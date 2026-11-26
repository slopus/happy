import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A Happy Cloud server that runs pipelines and keeps the account's
/// features (API.md, "Account features"): what `GET` answers, the event
/// that tells of a change, and a pipelines route that refuses while they
/// are off.
private actor FeaturesServer: AgentTransport {
    static let bootstrap = #"""
    {"cursor":"cursor-1","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[],
     "health":{"ready":true,"capabilities":{"pipelines":true,"plugins":true}}}
    """#
    static let refusal = #"{"error":"Pipelines are turned off for your account. Turn them on in your account settings to use them again.","code":"feature_not_installed","feature":"pipelines"}"#

    /// Nil answers the list as an older server does: `status` with no body.
    var pipelinesOn: Bool? = true
    var missingStatus = 404
    /// Pipelines routes refuse, as they do once the switch is off, without
    /// the list having said so yet.
    var refusing = false
    /// No way to the server at all.
    var offline = false
    var requested: [(method: String, path: String, body: JSONValue?)] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func set(pipelinesOn: Bool?, missingStatus: Int = 404) { self.pipelinesOn = pipelinesOn; self.missingStatus = missingStatus }
    func refuse() { refusing = true }
    func goOffline() { offline = true }
    func featureReads() -> Int { requested.filter { $0.method == "GET" && $0.path == "/v0/account/features" }.count }

    private func list() -> JSONValue {
        .object(["features": .array([.object(["id": .string("pipelines"), "name": .string("Pipelines"), "enabled": .bool(pipelinesOn ?? true)])])])
    }

    func emitFeatures(enabled: Bool) {
        pipelinesOn = enabled
        let event: JSONValue = .object(["cursor": .string("cursor-2"), "type": .string(AccountFeatures.updated), "occurredAt": .number(1_795_737_600_000), "payload": list()])
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard !offline else { throw URLError(.notConnectedToInternet) }
        requested.append((method, path, body.flatMap { try? JSONValue.decode($0) }))
        func json(_ value: JSONValue, status: Int = 200) throws -> HTTP1Response { .init(status: status, body: try JSONEncoder().encode(value)) }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"):
            return .init(status: 200, body: Data(Self.bootstrap.utf8))
        case ("GET", "/v0/account/features"):
            guard pipelinesOn != nil else { return .init(status: missingStatus, body: Data(#"{"error":"Not found"}"#.utf8)) }
            return try json(list())
        case ("GET", "/v0/pipelines"):
            if refusing || pipelinesOn == false { return .init(status: 403, body: Data(Self.refusal.utf8)) }
            return try json(.object(["pipelines": .array([])]))
        case ("GET", _) where path.hasPrefix("/v0/pipeline-runs"):
            if refusing || pipelinesOn == false { return .init(status: 403, body: Data(Self.refusal.utf8)) }
            return try json(.object(["runs": .array([])]))
        default:
            return .init(status: 404, body: Data("{}".utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard !offline else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":false,\"gap\":false}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func reset(_ category: RequestCategory) {}
    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

final class AccountFeaturesTests: XCTestCase {
    private struct Timeout: Error {}

    private func engine(_ server: FeaturesServer, directory: URL? = nil) -> SyncEngine {
        SyncEngine(client: AgentClient(transport: server, token: "test"), directory: directory, cloud: true, rereadInterval: .zero)
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

    private func eventually(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw Timeout()
    }

    private static func listsPipelines(_ snapshot: HomeSnapshot) -> Bool { snapshot.allRows.contains { $0.targetKind == "pipelines" } }

    // MARK: The wire

    func testTheListIsReadAsTheContractWritesIt() throws {
        let answer = try JSONValue.decode(Data(#"{"features":[{"id":"pipelines","name":"Pipelines","enabled":false},{"id":"later"},{"id":"other","enabled":true}]}"#.utf8))
        let features = AccountFeatures(AccountFeatures.read(answer))
        XCTAssertEqual(features.list, [AccountFeature(id: "pipelines", name: "Pipelines", enabled: false), AccountFeature(id: "other", name: "other", enabled: true)])
        XCTAssertFalse(features.enabled(AccountFeatures.pipelines))
        // Every feature is on until the person turns it off.
        XCTAssertTrue(features.enabled("unknown"))
        XCTAssertTrue(AccountFeatures().enabled(AccountFeatures.pipelines))
        XCTAssertNil(AccountFeatures.read(.object([:])))
    }

    func testOnlyAFeatureNotInstalledRefusalTurnsAFeatureOff() {
        XCTAssertTrue(AccountFeatures.refused(AgentClientError.status(403, code: "feature_not_installed", message: "Pipelines are turned off")))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.status(403, code: "forbidden", message: nil)))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.status(404, code: "feature_not_installed", message: nil)))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.revoked))
    }

    func testAnOlderServerHasEveryFeatureOn() async throws {
        for status in [404, 501] {
            let server = FeaturesServer()
            await server.set(pipelinesOn: nil, missingStatus: status)
            let read = try await AgentClient(transport: server, token: "test").accountFeatures()
            XCTAssertNil(read, "\(status)")
            XCTAssertTrue(AccountFeatures(read).enabled(AccountFeatures.pipelines))
        }
    }

    // MARK: The engine

    func testConnectingReadsTheFeaturesAndOffHidesThePipelinesRow() async throws {
        let server = FeaturesServer()
        await server.set(pipelinesOn: false)
        let engine = engine(server)
        await engine.start()
        let off = try await wait(engine) { $0.loaded && $0.features.list != nil }
        XCTAssertFalse(off.features.enabled(AccountFeatures.pipelines))
        XCTAssertFalse(Self.listsPipelines(off))
        // Only Pipelines: the server's Plugins row stays.
        XCTAssertTrue(off.allRows.contains { $0.targetKind == "plugins" })
        await engine.stop()
    }

    func testTheEventReplacesTheListLive() async throws {
        let server = FeaturesServer()
        let engine = engine(server)
        await engine.start()
        _ = try await wait(engine) { $0.live && Self.listsPipelines($0) && $0.features.list != nil }
        await server.emitFeatures(enabled: false)
        let off = try await wait(engine) { !Self.listsPipelines($0) }
        XCTAssertEqual(off.features.feature(AccountFeatures.pipelines)?.enabled, false)
        await server.emitFeatures(enabled: true)
        let on = try await wait(engine) { Self.listsPipelines($0) }
        XCTAssertTrue(on.features.enabled(AccountFeatures.pipelines))
        await engine.stop()
    }

    func testARefusedPipelinesRouteTurnsThemOffWithoutBeingAnError() async throws {
        let server = FeaturesServer()
        let engine = engine(server)
        await engine.start()
        _ = try await wait(engine) { $0.live && Self.listsPipelines($0) }
        await server.refuse()
        do {
            _ = try await engine.client.pipelines()
            XCTFail("refused")
        } catch {
            XCTAssertTrue(AccountFeatures.refused(error))
        }
        let off = try await wait(engine) { !Self.listsPipelines($0) }
        XCTAssertFalse(off.features.enabled(AccountFeatures.pipelines))
        XCTAssertNil(off.error)
        await engine.stop()
    }

    func testAnOlderServerListsPipelinesAsBefore() async throws {
        let server = FeaturesServer()
        await server.set(pipelinesOn: nil, missingStatus: 501)
        let engine = engine(server)
        await engine.start()
        let home = try await wait(engine) { $0.live && Self.listsPipelines($0) }
        XCTAssertNil(home.features.list)
        try await eventually { await server.featureReads() > 0 }
        await engine.stop()
    }

    func testComingBackToTheForegroundReadsTheFeaturesAgain() async throws {
        let server = FeaturesServer()
        let engine = engine(server)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.features.list != nil }
        try await eventually { await server.featureReads() >= 1 }
        let before = await server.featureReads()
        // Turned off on another device while this one was away, with no event heard.
        await server.set(pipelinesOn: false)
        await engine.background()
        await engine.foreground()
        try await eventually { await server.featureReads() > before }
        _ = try await wait(engine) { !Self.listsPipelines($0) }
        await engine.stop()
    }

    func testWhatTheEventSaidIsKeptForTheNextLaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("account-features-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let server = FeaturesServer()
        let first = engine(server, directory: directory)
        await first.start()
        _ = try await wait(first) { $0.live && Self.listsPipelines($0) && $0.features.list != nil }
        await server.emitFeatures(enabled: false)
        _ = try await wait(first) { !Self.listsPipelines($0) }
        await first.stop()

        // Offline, the next launch draws home without Pipelines from its first frame.
        let offline = FeaturesServer()
        await offline.goOffline()
        let second = engine(offline, directory: directory)
        await second.start()
        let kept = try await wait(second) { $0.loaded }
        XCTAssertFalse(kept.features.enabled(AccountFeatures.pipelines))
        XCTAssertFalse(Self.listsPipelines(kept))
        await second.stop()
    }

    // MARK: The screens' feed

    func testTheListsFeedSaysNoErrorWhenPipelinesAreOff() async throws {
        let server = FeaturesServer()
        await server.refuse()
        let client = AgentClient(transport: server, token: "test")
        let feed = PipelinesFeed(source: .init(
            pipelines: { try await client.pipelines() },
            runs: { try await client.pipelineRuns(cursor: $0) },
            events: { _ in AsyncStream { _ in } }
        ))
        await feed.start()
        try await Task.sleep(for: .milliseconds(200))
        let states = await feed.states()
        var iterator = states.makeAsyncIterator()
        let state = await iterator.next()
        XCTAssertEqual(state?.failed, false)
        XCTAssertEqual(state?.runs.failed, false)
        await feed.finish()
    }
}
