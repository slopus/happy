import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Rich tasks (protocol 34, `tasks.rich`): an older daemon, or the setting
/// off, leaves Home's rows exactly as they are; on, the tasks become cards.
final class RichTasksTests: XCTestCase {
    static let health31 = #"{"ready":true,"version":{"protocol":31},"capabilities":{"sidebarOperations":true,"stories":true}}"#
    static let health34 = #"{"ready":true,"version":{"protocol":34},"capabilities":{"sidebarOperations":true,"stories":true,"taskSections":true,"storyArtifacts":true,"chatActions":true,"chatOnboarding":true}}"#

    enum Shape { case v31, v34, malformed }

    /// One payload, as protocol 31 sends it, with every field protocol 34 adds, or with each of those unreadable.
    static func bootstrap(_ shape: Shape, inlineSections: Bool = true, settings: String = "[]") -> String {
        func new(_ fields: String, _ bad: String = "") -> String { shape == .v31 ? "" : shape == .v34 ? fields : bad }
        return #"""
        {"cursor":"c1","profile":{"userId":"me"},"userSettings":\#(settings),
         "projects":[{"id":"p1","name":"App","status":"active","orderKey":"a","agents":[]}],
         "workspaces":[
           {"id":"w1","projectId":"p1","parentId":"p1","name":"Made","kind":"worktree","status":"active","orderKey":"a","agents":[]\#(new(#","creatorAgentId":"t1-agent","subtaskAgentId":null"#, #","creatorAgentId":1,"subtaskAgentId":{}"#))},
           {"id":"w2","projectId":"p1","parentId":"p1","name":"Resident","kind":"worktree","status":"active","orderKey":"b","agents":[]\#(new(#","creatorAgentId":"t1-agent","subtaskAgentId":"t1-working""#))},
           {"id":"w3","projectId":"p1","parentId":"p1","name":"Other","kind":"worktree","status":"active","orderKey":"c","agents":[]\#(new(#","creatorAgentId":"t2-agent""#))}],
         "bots":[],
         "tasks":[
           {"id":"t1","name":"One","status":"active"\#(new(#","icon":{"type":"library","slug":"rocket"},"children":[{"ref":{"kind":"artifact","id":"a1"},"visibility":"shown","by":{"agentId":"t1-agent","userId":null},"updatedAt":5},{"ref":{"kind":"future"},"visibility":"odd"}]"#, #","icon":5,"children":{}"#)),
            "agent":{"id":"t1-agent","workspaceId":"t1-work","status":"idle","unread":{"reason":"message","since":4\#(new(#","from":["steve","jordan"]"#, #","from":7"#))},"subtasks":[
              {"id":"t1-asking","workspaceId":"t1-work","parentAgentId":"t1-agent","title":"Asking","status":"idle","pendingQuestionId":"q1"},
              {"id":"t1-working","workspaceId":"w2","parentAgentId":"t1-agent","title":"Working","status":"working"},
              {"id":"t1-idle","workspaceId":"t1-work","parentAgentId":"t1-agent","title":"Idle","status":"idle"}]}},
           {"id":"t2","name":"Two","status":"active"\#(new(#","icon":{"type":"image","url":"/x"},"children":[{"ref":{"kind":"workspace","id":"w3"},"visibility":"hidden","by":{"agentId":null,"userId":"me"},"updatedAt":6},{"ref":{"kind":"artifact","id":"a3"},"visibility":"hidden"}]"#, #","icon":"x","children":[1]"#)),"agent":{"id":"t2-agent","workspaceId":"t2-work","status":"idle"}},
           {"id":"t3","name":"Three","status":"active"\#(new(#","icon":null"#, #","icon":[]"#)),"agent":{"id":"t3-agent","workspaceId":"t3-work","status":"idle"}},
           {"id":"t4","name":"Four","status":"archived","agent":{"id":"t4-agent","workspaceId":"t4-work","status":"idle"}}],
         "taskMemberships":[{"taskId":"t1"\#(new(#","orderKey":"b""#, #","orderKey":3,"hidden":"yes""#))},{"taskId":"t2"\#(new(#","orderKey":"d""#))},{"taskId":"t3"\#(new(#","orderKey":"d5","hidden":true"#))},{"taskId":"t4"\#(new(#","orderKey":"f""#))}]
         \#(new(#","taskArtifacts":[{"artifactId":"a2","taskId":"t1","agentId":"t1-working","title":"Plan","type":"markdown","updatedAt":7},{"artifactId":"a3","taskId":"t2","agentId":"t2-agent"},{"artifactId":5}]"#, #","taskArtifacts":"nope","taskSections":{"id":"x"}"#))
         \#(inlineSections ? new(#","taskSections":[{"id":"s2","name":"Later","orderKey":"e","collapsed":true},{"id":"broken"},{"id":"s1","name":"Priorities","orderKey":"c","collapsed":false}]"#) : "")}
        """#
    }

    static let richOn: [String: JSONValue] = [RichTasks.richKey: .bool(true), RichTasks.sectionsKey: .bool(true)]
    static let settingsOn = #"[{"key":"tasks.rich","value":true,"version":"1"},{"key":"tasks.sections","value":true,"version":"2"}]"#

    private func desktop(_ json: String) throws -> DesktopSnapshot { try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8)) }
    private func capabilities(_ json: String) throws -> AgentWire.Health.Capabilities? { try JSONDecoder().decode(AgentWire.Health.self, from: Data(json.utf8)).capabilities }
    private func mainRows() throws -> [Row] { SidebarRows.make(try desktop(Self.bootstrap(.v31)), settings: [:]) }

    func testDecodesProtocol31AndEveryProtocol34Field() throws {
        XCTAssertNil(try capabilities(Self.health31)?.taskSections)
        XCTAssertNil(try capabilities(Self.health31)?.chatActions)
        XCTAssertEqual(try capabilities(Self.health34)?.taskSections, true)
        XCTAssertEqual(try capabilities(Self.health34)?.chatActions, true)
        let old = try desktop(Self.bootstrap(.v31))
        XCTAssertNil(old.taskSections)
        XCTAssertNil(old.tasks?.first?.children)
        let new = try desktop(Self.bootstrap(.v34))
        let one = try XCTUnwrap(new.tasks?.first)
        XCTAssertEqual(one.icon?.librarySlug, "rocket")
        XCTAssertNil(new.tasks?[1].icon?.librarySlug, "an icon kind this build can't draw is none")
        XCTAssertNil(new.tasks?[2].icon)
        XCTAssertEqual(one.children?.map(\.ref), [TaskChild.Ref(kind: "artifact", id: "a1")], "an unreadable child alone is dropped")
        XCTAssertEqual(one.children?.first?.by?.agentId, "t1-agent")
        XCTAssertEqual(one.agent?.unread?.from, ["steve", "jordan"])
        XCTAssertEqual(new.taskMemberships?.map(\.hidden), [nil, nil, true, nil])
        XCTAssertEqual(new.taskSections?.map(\.name), ["Later", "Priorities"])
        XCTAssertEqual(new.taskArtifacts?.map(\.artifactId), ["a2", "a3"])
        XCTAssertEqual(new.workspaces.first?.creatorAgentId, "t1-agent")
    }

    /// Every new field unreadable: nothing is lost, and the list is main's.
    func testMalformedFieldsLeaveTodaysList() throws {
        let bad = try desktop(Self.bootstrap(.malformed))
        XCTAssertNil(bad.taskSections); XCTAssertNil(bad.taskArtifacts)
        XCTAssertNil(bad.tasks?.first?.icon); XCTAssertNil(bad.tasks?.first?.children); XCTAssertEqual(bad.tasks?[1].children, [])
        XCTAssertNil(bad.tasks?.first?.agent?.unread?.from)
        XCTAssertNil(bad.taskMemberships?.first?.orderKey); XCTAssertNil(bad.taskMemberships?.first?.hidden)
        XCTAssertNil(bad.workspaces.first?.creatorAgentId)
        XCTAssertEqual(SidebarRows.make(bad, settings: [:]), try mainRows())
        XCTAssertEqual(RichTasks.make(bad, capabilities: try capabilities(Self.health34), settings: Self.richOn)?.unsectioned.map(\.name), ["One", "Two", "Three"])
    }

    /// Main's `SidebarRows` is untouched: the new fields change no row.
    func testClassicRowsAreMainsWhateverTheDaemonSends() throws {
        XCTAssertEqual(SidebarRows.make(try desktop(Self.bootstrap(.v34)), settings: Self.richOn), try mainRows())
        XCTAssertTrue(try mainRows().contains { $0.label == "Three" }, "a task Focus hid still shows in the classic list")
    }

    func testGateNeedsTheCapabilityAndTheSetting() throws {
        let new = try desktop(Self.bootstrap(.v34))
        XCTAssertNil(RichTasks.make(new, capabilities: nil, settings: Self.richOn))
        XCTAssertNil(RichTasks.make(new, capabilities: try capabilities(Self.health31), settings: Self.richOn))
        XCTAssertNil(RichTasks.make(new, capabilities: try capabilities(Self.health34), settings: [RichTasks.sectionsKey: .bool(true)]))
        XCTAssertNotNil(RichTasks.make(new, capabilities: try capabilities(Self.health34), settings: Self.richOn))
    }

    func testCardsSectionsHiddenChildrenAndFaces() throws {
        let model = try XCTUnwrap(RichTasks.make(try desktop(Self.bootstrap(.v34)), capabilities: try capabilities(Self.health34), settings: Self.richOn))
        XCTAssertEqual(model.unsectioned.map(\.name), ["One"])
        XCTAssertEqual(model.sections.map(\.name), ["Priorities", "Later"])
        XCTAssertEqual(model.sections.map { $0.cards.map(\.name) }, [["Two"], []], "hidden Three and archived Four are left out")
        XCTAssertEqual(model.sections.map(\.collapsed), [false, true])
        let one = model.unsectioned[0]
        XCTAssertEqual(one.iconSlug, "rocket")
        XCTAssertEqual(one.faces, ["steve", "jordan"])
        XCTAssertEqual(one.subRows, [
            .init(ref: .init(kind: "agent", id: "t1-asking"), reason: .question),
            .init(ref: .init(kind: "agent", id: "t1-working"), reason: .working),
            .init(ref: .init(kind: "workspace", id: "w1"), reason: .made),
            .init(ref: .init(kind: "artifact", id: "a2"), reason: .made),
            .init(ref: .init(kind: "artifact", id: "a1"), reason: .linked),
        ])
        let two = model.sections[0].cards[0]
        XCTAssertEqual(two.subRows, [])
        XCTAssertEqual(two.hiddenCount, 2)
        XCTAssertFalse(model.focus)
        // Sections off: one list, in the person's order.
        let flat = try XCTUnwrap(RichTasks.make(try desktop(Self.bootstrap(.v34)), capabilities: try capabilities(Self.health34), settings: [RichTasks.richKey: .bool(true)]))
        XCTAssertEqual(flat.unsectioned.map(\.name), ["One", "Two"])
        XCTAssertEqual(flat.sections, [])
    }

    func testOldDaemonShowsTodaysList() async throws {
        let transport = RichFixture(health: Self.health31, bootstrap: Self.bootstrap(.v34, inlineSections: false, settings: Self.settingsOn))
        let (snapshot, requested) = try await settle(transport, directory: nil)
        XCTAssertNil(snapshot.richTasks)
        XCTAssertEqual(snapshot.allRows, try mainRows())
        XCTAssertFalse(requested.contains { $0.hasPrefix("/v0/tasks") }, "nothing new is asked of an old daemon")
    }

    func testRichOnReadsSectionsFromTheTaskList() async throws {
        let transport = RichFixture(health: Self.health34, bootstrap: Self.bootstrap(.v34, inlineSections: false, settings: Self.settingsOn))
        let (snapshot, requested) = try await settle(transport, directory: nil)
        XCTAssertEqual(snapshot.richTasks?.sections.map(\.name), ["Priorities", "Later"])
        XCTAssertEqual(snapshot.allRows, try mainRows())
        XCTAssertTrue(requested.contains("/v0/tasks?scope=joined"))
    }

    /// Rich on a protocol-34 daemon, then the computer rolled back: an
    /// unanswered health on the new connection is no capabilities.
    func testRollbackToAnOldDaemonShowsTodaysList() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("rich-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let rich = try await settle(RichFixture(health: Self.health34, bootstrap: Self.bootstrap(.v34, settings: Self.settingsOn)), directory: directory)
        XCTAssertNotNil(rich.0.richTasks)
        let (snapshot, requested) = try await settle(RichFixture(health: nil, bootstrap: Self.bootstrap(.v31, settings: Self.settingsOn)), directory: directory)
        XCTAssertNil(snapshot.richTasks)
        XCTAssertEqual(snapshot.allRows, try mainRows())
        XCTAssertFalse(requested.contains { $0.hasPrefix("/v0/tasks") })
    }

    /// Headers read once stay when the task list can't be read, and after a relaunch offline.
    func testFallbackSectionsSurviveARelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("rich-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RichFixture(health: Self.health34, bootstrap: Self.bootstrap(.v34, inlineSections: false, settings: Self.settingsOn))
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.richTasks?.sections.count == 2 }
        await transport.failTasks(renaming: "Uno")
        let failed = try await wait(engine) { $0.rows.contains { $0.label == "Uno" } }
        XCTAssertEqual(failed.richTasks?.sections.map(\.name), ["Priorities", "Later"])
        await engine.stop()
        await transport.goOffline()
        let reopened = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory)
        await reopened.start()
        let offline = try await wait(reopened) { $0.loaded }
        XCTAssertEqual(offline.richTasks?.sections.map(\.name), ["Priorities", "Later"])
        XCTAssertEqual(offline.richTasks?.unsectioned.map(\.name), ["Uno"])
        await reopened.stop()
    }

    /// An artifact changing reads the cards again, and never the classic list.
    func testArtifactEventsReReadOnlyCards() async throws {
        for (settings, extra) in [("[]", 0), (Self.settingsOn, 1)] {
            let transport = RichFixture(health: Self.health34, bootstrap: Self.bootstrap(.v34, settings: settings))
            let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil)
            await engine.start()
            _ = try await wait(engine) { $0.live && $0.loaded && !$0.syncing && ($0.richTasks != nil) == (extra == 1) }
            let before = await transport.bootstrapReads()
            await transport.emit("artifact.updated")
            try await Task.sleep(for: .milliseconds(400))
            let after = await transport.bootstrapReads()
            XCTAssertEqual(after - before, extra)
            await engine.stop()
        }
    }

    /// Home once the connection is up and every read it sets off has settled.
    private func settle(_ transport: RichFixture, directory: URL?) async throws -> (HomeSnapshot, [String]) {
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded && !$0.syncing }
        try await Task.sleep(for: .milliseconds(400))
        let snapshot = try await wait(engine) { _ in true }
        await engine.stop()
        return (snapshot, await transport.requested)
    }

    private func wait(_ engine: SyncEngine, _ predicate: @escaping @Sendable (HomeSnapshot) -> Bool) async throws -> HomeSnapshot {
        try await withThrowingTaskGroup(of: HomeSnapshot.self) { group in
            group.addTask {
                for await snapshot in await engine.snapshots() where predicate(snapshot) { return snapshot }
                throw CancellationError()
            }
            group.addTask { try await Task.sleep(for: .seconds(4)); throw CancellationError() }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
}

private actor RichFixture: AgentTransport {
    /// Nil: the health read fails.
    let health: String?
    var bootstrap: String
    var requested: [String] = []
    var tasksFail = false, online = true
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    init(health: String?, bootstrap: String) { self.health = health; self.bootstrap = bootstrap }
    func goOffline() { online = false }
    /// The task list stops answering, and a rename says the next read has landed.
    func failTasks(renaming name: String) {
        tasksFail = true
        bootstrap = bootstrap.replacingOccurrences(of: #""name":"One""#, with: #""name":"\#(name)""#)
        emit("task.updated")
    }
    func emit(_ type: String) {
        continuations.forEach { $0.yield(Data(#"event: message\#ndata: {"type":"\#(type)","payload":{"taskId":"t1"}}\#n\#n"#.utf8)) }
    }
    func bootstrapReads() -> Int { requested.filter { $0 == "/v0/bootstrap/desktop" }.count }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        requested.append(path)
        switch path {
        case "/v0/health":
            guard let health else { throw URLError(.timedOut) }
            return .init(status: 200, body: Data(health.utf8))
        case "/v0/bootstrap/desktop": return .init(status: 200, body: Data(bootstrap.utf8))
        case "/v0/tasks?scope=joined" where !tasksFail:
            return .init(status: 200, body: Data(#"{"tasks":[],"memberships":[],"sections":[{"id":"s1","name":"Priorities","orderKey":"c","collapsed":false},{"id":"s2","name":"Later","orderKey":"e","collapsed":true}]}"#.utf8))
        default: return .init(status: 500, body: Data("{}".utf8))
        }
    }
    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}
