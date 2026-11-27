import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A Happy Cloud server with feature plugins (API.md, "Feature plugins"):
/// the Pipelines plugin in `GET /v0/plugins` with whether the account has
/// it, its installation `pipelines`, `GET /v0/features`, the two events an
/// install or uninstall journals, and pipelines routes that refuse while it
/// is uninstalled.
private actor FeaturesServer: AgentTransport {
    static let refusal = #"{"error":"Pipelines are not installed for your account. Install the Pipelines plugin to use them again.","code":"feature_not_installed","feature":"pipelines","plugin":"pipelines"}"#

    var installed = true
    /// What health says of `features`; false is a server from before them.
    var served = true
    /// `GET /v0/features` answers this instead, as a server whose health
    /// says one thing and whose routes another.
    var missingStatus: Int?
    /// Pipelines routes refuse without the list or an event having said so.
    var refusing = false
    /// No way to the server at all.
    var offline = false
    var requested: [(method: String, path: String)] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    func set(installed: Bool) { self.installed = installed }
    func set(served: Bool, missingStatus: Int? = nil) { self.served = served; self.missingStatus = missingStatus }
    func refuse() { refusing = true }
    func goOffline() { offline = true }
    func featureReads() -> Int { requested.filter { $0.method == "GET" && $0.path == "/v0/features" }.count }

    private var health: String { #"{"ready":true,"capabilities":{"pipelines":true,"plugins":true\#(served ? #","features":true"# : "")}}"# }
    private var features: String { #"{"features":[{"id":"pipelines","available":\#(installed)}]}"# }
    private var installation: String {
        #"{"id":"pipelines","plugin":"pipelines","pluginName":"Pipelines","kind":"feature","ordinal":1,"label":null,"status":"active","reason":null,"authMethod":null,"toolPrefix":"","image":null,"available":true}"#
    }

    private func emit(_ type: String, _ payload: String) {
        let event = #"{"cursor":"cursor-\#(requested.count)","type":"\#(type)","occurredAt":1795737600000,"payload":\#(payload)}"#
        continuations.forEach { $0.yield(Data("event: message\ndata: \(event)\n\n".utf8)) }
    }

    /// Installed or uninstalled on another device: both events, as the server journals them.
    func change(installed: Bool) {
        self.installed = installed
        emit("plugins.changed", #"{"installationId":"pipelines"}"#)
        emit(AccountFeatures.updated, features)
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard !offline else { throw URLError(.notConnectedToInternet) }
        requested.append((method, path))
        func answer(_ text: String, _ status: Int = 200) -> HTTP1Response { .init(status: status, body: Data(text.utf8)) }
        switch (method, path) {
        case ("GET", "/v0/bootstrap/desktop"):
            return answer(#"{"cursor":"cursor-1","profile":{"userId":"me"},"userSettings":[],"projects":[],"workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[],"health":\#(health)}"#)
        case ("GET", "/v0/health"):
            return answer(health)
        case ("GET", "/v0/features"):
            if let missingStatus { return answer(#"{"error":"Not found"}"#, missingStatus) }
            return answer(features)
        case ("GET", "/v0/plugins"):
            return answer(#"""
            {"plugins":[
              {"id":"github","name":"GitHub","kind":"integration","description":"Repositories.","version":"1.0.0","tools":[],"auth":{"required":true,"methods":[]}},
              {"id":"pipelines","name":"Pipelines","kind":"feature","installed":\#(installed),"description":"Fixed graphs of work agents run.","version":"1.0.0",
               "tools":[{"name":"run_pipeline","summary":"Starts a run."}],"auth":{"required":false,"methods":[]}}]}
            """#)
        case ("GET", "/v0/plugins/installations"):
            return answer(#"{"installations":[\#(installed ? installation : "")],"canManage":false}"#)
        case ("POST", "/v0/plugins/installations"):
            guard body.flatMap({ try? JSONValue.decode($0) })?["plugin"]?.stringValue == "pipelines" else { return answer("{}", 400) }
            if installed { return answer(#"{"installation":\#(installation)}"#) }
            change(installed: true)
            return answer(#"{"installation":\#(installation)}"#, 201)
        case ("DELETE", "/v0/plugins/installations/pipelines"):
            guard installed else { return answer(#"{"error":"Not found"}"#, 404) }
            change(installed: false)
            return answer(#"{"deleted":true,"secretsDeleted":0,"storageEntriesDeleted":0,"cleanedUpOutside":false}"#)
        case ("GET", "/v0/pipelines"):
            if refusing || !installed { return answer(Self.refusal, 403) }
            return answer(#"{"pipelines":[]}"#)
        case ("GET", _) where path.hasPrefix("/v0/pipeline-runs"):
            if refusing || !installed { return answer(Self.refusal, 403) }
            return answer(#"{"runs":[]}"#)
        default:
            return answer("{}", 404)
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
        let answer = try JSONValue.decode(Data(#"{"features":[{"id":"pipelines","available":false},{"id":"later"},{"id":"other","available":true}]}"#.utf8))
        let features = AccountFeatures(AccountFeatures.read(answer))
        XCTAssertEqual(features.list, [AccountFeature(id: "pipelines", available: false), AccountFeature(id: "other", available: true)])
        XCTAssertFalse(features.available(AccountFeatures.pipelines))
        // Every feature is available until its plugin is uninstalled.
        XCTAssertTrue(features.available("unknown"))
        XCTAssertTrue(AccountFeatures().available(AccountFeatures.pipelines))
        XCTAssertNil(AccountFeatures.read(.object([:])))
    }

    func testOnlyAFeatureNotInstalledRefusalMakesAFeatureUnavailable() {
        XCTAssertTrue(AccountFeatures.refused(AgentClientError.status(403, code: "feature_not_installed", message: "Pipelines are not installed")))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.status(403, code: "forbidden", message: nil)))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.status(404, code: "feature_not_installed", message: nil)))
        XCTAssertFalse(AccountFeatures.refused(AgentClientError.revoked))
    }

    /// Health without `capabilities.features`: every feature available,
    /// and `/v0/features` never asked. Health saying so but the route
    /// missing (`404`, `501`) is the same.
    func testAServerWithoutFeaturePluginsHasEveryFeatureAvailable() async throws {
        let before = FeaturesServer()
        await before.set(served: false)
        let none = try await AgentClient(transport: before, token: "test").accountFeatures()
        XCTAssertNil(none)
        let reads = await before.featureReads()
        XCTAssertEqual(reads, 0)
        for status in [404, 501] {
            let server = FeaturesServer()
            await server.set(served: true, missingStatus: status)
            let read = try await AgentClient(transport: server, token: "test").accountFeatures()
            XCTAssertNil(read, "\(status)")
            XCTAssertTrue(AccountFeatures(read).available(AccountFeatures.pipelines))
        }
    }

    /// The Pipelines plugin in the catalog: a feature, with whether the
    /// account has it, and its installation named by the plugin's ID.
    func testTheCatalogListsTheFeaturePluginApartFromIntegrations() async throws {
        let server = FeaturesServer()
        let client = AgentClient(transport: server, token: "test")
        let catalog = try await client.pluginCatalog()
        XCTAssertEqual(catalog.features.map(\.id), ["pipelines"])
        XCTAssertEqual(catalog.integrations.map(\.id), ["github"])
        let pipelines = try XCTUnwrap(catalog.plugin("pipelines"))
        XCTAssertEqual(pipelines.kind, .feature)
        XCTAssertTrue(catalog.installed(pipelines))
        XCTAssertEqual(catalog.installations(of: "pipelines").map(\.id), ["pipelines"])
        // Every member's own, whatever `canManage` says.
        XCTAssertFalse(catalog.canManage)

        try await client.removePluginInstallation("pipelines")
        let after = try await client.pluginCatalog()
        XCTAssertFalse(after.installed(try XCTUnwrap(after.plugin("pipelines"))))
        // Uninstalled already: the server's 404 counts as uninstalled.
        try await client.removePluginInstallation("pipelines")
        let installation = try await client.installPlugin("pipelines")
        XCTAssertEqual(installation.id, "pipelines")
        XCTAssertEqual(installation.toolPrefix, "")
    }

    // MARK: The engine

    func testConnectingReadsWhatIsAvailableAndUninstalledHidesThePipelinesRow() async throws {
        let server = FeaturesServer()
        await server.set(installed: false)
        let engine = engine(server)
        await engine.start()
        let off = try await wait(engine) { $0.loaded && $0.features.list != nil }
        XCTAssertFalse(off.features.available(AccountFeatures.pipelines))
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
        await server.change(installed: false)
        let off = try await wait(engine) { !Self.listsPipelines($0) }
        XCTAssertEqual(off.features.feature(AccountFeatures.pipelines)?.available, false)
        await server.change(installed: true)
        let on = try await wait(engine) { Self.listsPipelines($0) }
        XCTAssertTrue(on.features.available(AccountFeatures.pipelines))
        await engine.stop()
    }

    /// Installed and uninstalled from this phone, through the plugin
    /// routes: the row follows, by the event and the read beside it.
    func testUninstallingAndInstallingThePluginMovesTheRow() async throws {
        let server = FeaturesServer()
        let engine = engine(server)
        await engine.start()
        _ = try await wait(engine) { $0.live && Self.listsPipelines($0) && $0.features.list != nil }
        try await engine.client.removePluginInstallation("pipelines")
        await engine.refreshFeatures()
        _ = try await wait(engine) { !Self.listsPipelines($0) }
        _ = try await engine.client.installPlugin("pipelines")
        await engine.refreshFeatures()
        _ = try await wait(engine) { Self.listsPipelines($0) }
        await engine.stop()
    }

    func testARefusedPipelinesRouteMakesThemUnavailableWithoutBeingAnError() async throws {
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
        XCTAssertFalse(off.features.available(AccountFeatures.pipelines))
        XCTAssertNil(off.error)
        await engine.stop()
    }

    func testAServerWithoutFeaturePluginsListsPipelinesAsBefore() async throws {
        let server = FeaturesServer()
        await server.set(served: false)
        let engine = engine(server)
        await engine.start()
        let home = try await wait(engine) { $0.live && Self.listsPipelines($0) }
        XCTAssertNil(home.features.list)
        try await Task.sleep(for: .milliseconds(200))
        let reads = await server.featureReads()
        XCTAssertEqual(reads, 0)
        await engine.stop()
    }

    func testComingBackToTheForegroundReadsWhatIsAvailableAgain() async throws {
        let server = FeaturesServer()
        let engine = engine(server)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.features.list != nil }
        try await eventually { await server.featureReads() >= 1 }
        let before = await server.featureReads()
        // Uninstalled on another device while this one was away, with no event heard.
        await server.set(installed: false)
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
        await server.change(installed: false)
        _ = try await wait(first) { !Self.listsPipelines($0) }
        await first.stop()

        // Offline, the next launch draws home without Pipelines from its first frame.
        let offline = FeaturesServer()
        await offline.goOffline()
        let second = engine(offline, directory: directory)
        await second.start()
        let kept = try await wait(second) { $0.loaded }
        XCTAssertFalse(kept.features.available(AccountFeatures.pipelines))
        XCTAssertFalse(Self.listsPipelines(kept))
        await second.stop()
    }

    // MARK: The screens' feed

    func testTheListsFeedSaysNoErrorWhenPipelinesAreUninstalled() async throws {
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
