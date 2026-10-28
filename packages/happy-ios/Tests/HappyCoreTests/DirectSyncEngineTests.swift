import Foundation
import XCTest
@testable import HappyCore
import HappyWire

private actor DirectSyncFixture: DirectTransport {
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":null},"userSettings":[],
     "projects":[{"id":"p","name":"App","status":"active","orderKey":"a","agents":[{"id":"root","workspaceId":"p","title":"Root chat","status":"idle"}]}],
     "workspaces":[
       {"id":"work","projectId":"p","parentId":"p","name":"Feature","kind":"worktree","status":"active","orderKey":"b","agents":[]},
       {"id":"delegated","projectId":"p","parentId":"p","name":"Duplicated worktree","kind":"worktree","status":"active","orderKey":"a","agents":[]}],
     "bots":[{"id":"happy","name":"Happy","systemKey":"chief_of_staff","status":"active","agent":{"id":"bot-agent","workspaceId":"bot-work","status":"idle","subtasks":[{"id":"child","workspaceId":"delegated","parentAgentId":"bot-agent","title":"Delegated task","status":"running"}]}}],
     "tasks":[{"id":"unjoined","name":"Not joined","agent":{"id":"unjoined-agent","workspaceId":"x","status":"idle"}},
       {"id":"first","name":"First created","agent":{"id":"first-agent","workspaceId":"one","status":"idle"}},
       {"id":"last","name":"Last created","agent":{"id":"last-agent","workspaceId":"two","status":"idle"}}],
     "taskMemberships":[{"taskId":"last"},{"taskId":"first"}],
     "surfaces":[{"id":"other","name":"Other person's document","type":"document","members":[{"userId":"other-user","orderKey":"a"}]},
       {"id":"todo","name":"Groceries","type":"todo","members":[{"userId":null,"orderKey":"b"}]},
       {"id":"doc","name":"Notes","type":"document","members":[{"userId":null,"orderKey":"a"}]}]}
    """#
    var value = try! JSONDecoder().decode(JSONValue.self, from: Data(fixture.utf8))
    var online = true
    var writes: [JSONValue] = []
    var streamHeaders: [[String: String]] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    var version = 0
    var bootstrapFailures = 0
    var sends: [JSONValue] = []
    var loseSendAck = false

    func configure(online: Bool) { self.online = online }
    func writeCount() -> Int { writes.count }
    func savedWrites() -> [JSONValue] { writes }
    func savedSends() -> [JSONValue] { sends }
    func loseNextSendAcknowledgement() { loseSendAck = true }
    func renameProjectAfterOneFailedRead() {
        bootstrapFailures = 1
        var object = value.objectValue!
        var project = object["projects"]!.arrayValue!.first!.objectValue!
        project["name"] = .string("Renamed remotely")
        object["projects"] = .array([.object(project)])
        value = .object(object)
        emit(.object(["type": .string("project.updated"), "payload": .object(["projectId": .string("p")])]))
    }
    func setProjectsHidden(_ hidden: Bool, stamp: Double = Date().timeIntervalSince1970 * 1000) {
        version += 1
        let setting: JSONValue = .object(["key": .string(DirectSettings.projectsVisibility), "value": .object(["projectsHidden": .bool(hidden)]), "version": .string(String(format: "%08d", version)), "updatedAt": .number(stamp)])
        var object = value.objectValue!
        object["userSettings"] = .array([setting])
        value = .object(object)
        emit(.object(["type": .string("user_settings.updated"), "payload": .object(["setting": setting])]))
    }
    func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> DirectHTTPResponse {
        guard online else { throw URLError(.notConnectedToInternet) }
        if path == "/v0/bootstrap/desktop" {
            if bootstrapFailures > 0 { bootstrapFailures -= 1; throw URLError(.timedOut) }
            return .init(status: 200, body: try JSONEncoder().encode(value))
        }
        if method == "PUT", path.hasPrefix("/v0/user-settings/") {
            let request = try JSONDecoder().decode(JSONValue.self, from: body!)
            writes.append(request)
            let held = value["userSettings"]?.arrayValue?.first
            if (held?["updatedAt"]?.numberValue ?? 0) <= (request["updatedAt"]?.numberValue ?? 0) {
                setProjectsHidden(request["value"]?["projectsHidden"] == .bool(true), stamp: request["updatedAt"]!.numberValue!)
            }
            return .init(status: 200, body: try JSONEncoder().encode(JSONValue.object(["setting": value["userSettings"]!.arrayValue!.first!])))
        }
        if method == "POST", path.hasSuffix("/send") {
            sends.append(try JSONDecoder().decode(JSONValue.self, from: body!))
            if loseSendAck { loseSendAck = false; throw URLError(.networkConnectionLost) }
            return .init(status: 200, body: Data("{}".utf8))
        }
        return .init(status: 404, body: Data("{}".utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) throws -> DirectHTTPStream {
        guard online else { throw URLError(.notConnectedToInternet) }
        streamHeaders.append(headers)
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

final class DirectSyncEngineTests: XCTestCase {
    private struct Timeout: Error {}
    private func wait(_ engine: DirectSyncEngine, _ predicate: @escaping @Sendable (DirectHomeSnapshot) -> Bool) async throws -> DirectHomeSnapshot {
        try await withThrowingTaskGroup(of: DirectHomeSnapshot.self) { group in
            group.addTask {
                for await snapshot in await engine.snapshots() where predicate(snapshot) { return snapshot }
                throw Timeout()
            }
            group.addTask { try await Task.sleep(for: .seconds(4)); throw Timeout() }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
    private func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("direct-sync-\(UUID().uuidString)") }

    func testTransientReconcileFailureRetriesWithoutAnotherEvent() async throws {
        let transport = DirectSyncFixture()
        let engine = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        await transport.renameProjectAfterOneFailedRead()
        let changed = try await wait(engine) { $0.rows.contains { $0.label == "Renamed remotely" } }
        XCTAssertTrue(changed.live)
        await engine.stop()
    }

    func testAccountDrainsPersistedSendWithoutOpeningConversation() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = DirectSyncFixture()
        let mode = AgentWire.Mode(providerId: "test", modelId: "test-model", effort: "low", serviceTier: nil, permissionMode: "auto")
        let first = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: directory)
        try await first.enqueueMessage(.init(id: "stable-message", agentID: "never-opened", text: "Offline text", pictures: [], mode: mode))
        await first.stop()
        let reopened = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: directory)
        await reopened.start()
        _ = try await wait(reopened) { $0.live }
        for _ in 0..<100 {
            if !(await transport.savedSends()).isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let sends = await transport.savedSends()
        XCTAssertEqual(sends.count, 1)
        XCTAssertEqual(sends.first?["id"], .string("stable-message"))
        XCTAssertEqual(sends.first?["text"], .string("Offline text"))
        XCTAssertEqual(sends.first?["mode"]?["modelId"], .string("test-model"))
        let pending = try await reopened.queuedMessages(for: "never-opened")
        XCTAssertTrue(pending.isEmpty)
        await reopened.stop()
    }

    func testAmbiguousSendAcknowledgementRetainsExactPayloadAndPausesRetries() async throws {
        let transport = DirectSyncFixture()
        await transport.loseNextSendAcknowledgement()
        let engine = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        let mode = AgentWire.Mode(providerId: "test", modelId: "chosen-model", effort: "high", serviceTier: nil, permissionMode: "auto")
        try await engine.enqueueMessage(.init(id: "same-message", agentID: "chat", text: "Keep this exact text", pictures: [.init(mimeType: "image/png", data: Data([1, 2, 3]))], mode: mode))
        for _ in 0..<100 {
            if !(await transport.savedSends()).isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        await engine.pause()
        try await Task.sleep(for: .milliseconds(1100))
        let pausedSends = await transport.savedSends()
        XCTAssertEqual(pausedSends.count, 1)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        for _ in 0..<100 {
            if (await transport.savedSends()).count == 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let retried = await transport.savedSends()
        XCTAssertEqual(retried.count, 2)
        XCTAssertEqual(retried.first, retried.last)
        await engine.stop()
    }

    func testCanonicalDesktopOrderMembershipHierarchyAndVisibility() throws {
        let desktop = try JSONDecoder().decode(DirectDesktopSnapshot.self, from: Data(DirectSyncFixture.fixture.utf8))
        let all = DirectSidebarRows.make(desktop, settings: [:])
        XCTAssertEqual(all.map(\.label), ["Artifacts", "Notes", "Groceries", "Bots", "Happy", "Delegated task", "Tasks", "Last created", "First created", "Projects", "App", "Root chat", "Feature"])
        XCTAssertEqual(all.map(\.id).count, Set(all.map(\.id)).count)
        XCTAssertEqual(all.first { $0.label == "Delegated task" }?.depth, 1)
        let settings: [String: JSONValue] = [DirectSettings.projectsVisibility: .object(["projectsHidden": .bool(true)]), "happy-desktop.bot.happy": .object(["hidden": .bool(true)])]
        let hidden = DirectSidebarRows.make(desktop, settings: settings)
        XCTAssertEqual(hidden.map(\.label), ["Artifacts", "Notes", "Groceries", "Bots", "Tasks", "Last created", "First created"])
        let folded = StemCellsRows.visible(DirectSidebarRows.make(desktop, settings: [:], collapsed: ["project:p"]))
        XCTAssertFalse(folded.contains { $0.label == "Root chat" || $0.label == "Feature" })
        XCTAssertTrue(folded.contains { $0.label == "App" })
    }

    func testOfflineCacheAndSettingsSurviveAccountRelaunchThenReplay() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = DirectSyncFixture()
        let engine = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: directory)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        await engine.pause()
        await transport.configure(online: false)
        try await engine.setProjectsHidden(true)
        let optimistic = try await wait(engine) { DirectSettings.projectsHidden($0.settings) }
        XCTAssertFalse(optimistic.rows.contains { $0.label == "Projects" })
        await engine.stop()

        let reopened = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: directory)
        await reopened.start()
        let offline = try await wait(reopened) { $0.loaded }
        XCTAssertFalse(offline.live)
        XCTAssertTrue(DirectSettings.projectsHidden(offline.settings))
        XCTAssertTrue(offline.rows.contains { $0.label == "Last created" })
        await reopened.pause()
        await transport.configure(online: true)
        await reopened.start()
        _ = try await wait(reopened) { $0.live }
        for _ in 0..<100 where await transport.writeCount() == 0 { try await Task.sleep(for: .milliseconds(10)) }
        let writes = await transport.savedWrites()
        XCTAssertEqual(writes.count, 1)
        XCTAssertNotNil(writes.first?["mutationId"]?.stringValue)
        XCTAssertNotNil(writes.first?["updatedAt"]?.numberValue)
        let headers = await transport.streamHeaders
        XCTAssertTrue(headers.allSatisfy { $0["Last-Event-ID"] == "cursor-1" })
        await reopened.stop()
    }

    func testRemoteSettingChangesHomeAndAStaleOfflineEditAdoptsServerWinner() async throws {
        let transport = DirectSyncFixture()
        let engine = DirectSyncEngine(client: DirectAgentClient(transport: transport, token: "test"), directory: nil)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        await transport.setProjectsHidden(true)
        let remote = try await wait(engine) { DirectSettings.projectsHidden($0.settings) }
        XCTAssertFalse(remote.rows.contains { $0.label == "App" })
        await engine.pause()
        try await engine.setProjectsHidden(false)
        await transport.setProjectsHidden(true, stamp: Date().timeIntervalSince1970 * 1000 + 1000)
        await engine.start()
        _ = try await wait(engine) { $0.live && DirectSettings.projectsHidden($0.settings) }
        await engine.stop()
    }
}