import Foundation
import XCTest
@testable import HappyCore
import HappyWire

private actor SyncFixture: AgentTransport {
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
    /// Intents heard: `read:<agent>`, `archive:<task>`.
    var acts: [String] = []
    var refuseArchive = false
    var closedStreams: Set<Int> = []
    func closedStreamCount() -> Int { closedStreams.count }
    func streamClosed(_ id: Int) { closedStreams.insert(id) }

    func heardActs() -> [String] { acts }
    func refuseArchives() { refuseArchive = true }
    /// The computer says the task's agent has something unread, as a
    /// bootstrap read that hasn't caught up with this phone would.
    func setUnread(task taskId: String, _ unread: Bool) {
        var object = value.objectValue!
        object["tasks"] = .array(object["tasks"]!.arrayValue!.map { task in
            guard task["id"]?.stringValue == taskId, var whole = task.objectValue, var agent = whole["agent"]?.objectValue else { return task }
            agent["unread"] = unread ? .object(["reason": .string("finished")]) : nil
            whole["agent"] = .object(agent)
            return .object(whole)
        })
        value = .object(object)
        emit(.object(["type": .string("agent.updated"), "payload": .object([:])]))
    }

    func configure(online: Bool) { self.online = online }
    func writeCount() -> Int { writes.count }
    func savedWrites() -> [JSONValue] { writes }
    func savedSends() -> [JSONValue] { sends }
    func loseNextSendAcknowledgement() { loseSendAck = true }
    /// Each of the next `reads` bootstrap reads has news come while it is
    /// on its way, as when agents work.
    var newsDuringReads = 0
    /// The process every hello names; nil as an older daemon's.
    var daemonId: String?
    var nextHelloGap = false
    /// The next bootstrap read waits, deaf to cancellation, until `release`.
    var holdNextRead = false
    var held: CheckedContinuation<Void, Never>?
    func holdNextBootstrap() { holdNextRead = true }
    func isHolding() -> Bool { held != nil }
    func streamsOpened() -> Int { streamHeaders.count }
    func release() { held?.resume(); held = nil }
    var resets: [RequestCategory] = []
    var wakes = 0
    /// The stream's tunnel let go of: it ends, as a closed tunnel's does.
    /// The next stream's hello waits until `releaseHello`.
    var holdHello = false
    var heldHello: AsyncThrowingStream<Data, Error>.Continuation?
    func holdNextHello() { holdHello = true }
    func releaseHello() {
        let process = daemonId.map { ",\"daemonId\":\"\($0)\"" } ?? ""
        heldHello?.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true,\"gap\":false\(process)}\n\n".utf8))
        heldHello = nil
    }
    /// The next reset waits, as a tunnel slow to close, until `releaseReset`.
    var holdReset = false
    var heldReset: CheckedContinuation<Void, Never>?
    func holdNextReset() { holdReset = true }
    func isHoldingReset() -> Bool { heldReset != nil }
    func releaseReset() { heldReset?.resume(); heldReset = nil }
    func reset(_ category: RequestCategory) async {
        if holdReset { holdReset = false; await withCheckedContinuation { heldReset = $0 } }
        resets.append(category); if category == .realtime { drop() }
    }
    func resumed() { wakes += 1 }
    func heardResets() -> [RequestCategory] { resets }
    func heardWakes() -> Int { wakes }
    func setDaemon(_ id: String?) { daemonId = id }
    func gapNextHello() { nextHelloGap = true }
    func bootstrapReads() -> Int { requested.filter { $0 == "/v0/bootstrap/desktop" }.count }
    func lastStreamCursor() -> String? { streamHeaders.last?["Last-Event-ID"] }
    /// Ends the open streams, as a network that drops.
    func drop() { continuations.forEach { $0.finish() }; continuations.removeAll() }
    func emit(id: String, _ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("id: \(id)\nevent: message\ndata: \(json)\n\n".utf8)) }
    }
    func dropStreams() { continuations.forEach { $0.finish(throwing: URLError(.networkConnectionLost)) } }
    func emitHeld(id: String, _ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.first?.yield(Data("id: \(id)\nevent: message\ndata: \(json)\n\n".utf8))
    }
    func renameProject(withNewsDuringReads reads: Int) {
        newsDuringReads = reads
        var object = value.objectValue!
        var project = object["projects"]!.arrayValue!.first!.objectValue!
        project["name"] = .string("Renamed while busy")
        object["projects"] = .array([.object(project)])
        value = .object(object)
        emit(.object(["type": .string("project.updated"), "payload": .object(["projectId": .string("p")])]))
    }
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
        let setting: JSONValue = .object(["key": .string(DesktopSettingKeys.projectsVisibility), "value": .object(["projectsHidden": .bool(hidden)]), "version": .string(String(format: "%08d", version)), "updatedAt": .number(stamp)])
        var object = value.objectValue!
        object["userSettings"] = .array([setting])
        value = .object(object)
        emit(.object(["type": .string("user_settings.updated"), "payload": .object(["setting": setting])]))
    }
    var requested: [String] = []
    func requestedPaths() -> [String] { requested }
    /// The retired Stem Cells experiment turned on from the computer.
    func turnOnStemCells() {
        version += 1
        let setting: JSONValue = .object(["key": .string("happy-desktop.experiments.stemCells"), "value": .bool(true), "version": .string(String(format: "%08d", version)), "updatedAt": .number(Date().timeIntervalSince1970 * 1000)])
        var object = value.objectValue!
        object["userSettings"] = .array([setting])
        value = .object(object)
        emit(.object(["type": .string("user_settings.updated"), "payload": .object(["setting": setting])]))
    }
    func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard online else { throw URLError(.notConnectedToInternet) }
        requested.append(path)
        if path == "/v0/bootstrap/desktop" {
            if bootstrapFailures > 0 { bootstrapFailures -= 1; throw URLError(.timedOut) }
            if holdNextRead {
                holdNextRead = false
                await withCheckedContinuation { held = $0 }
            }
            let read = try JSONEncoder().encode(value)
            if newsDuringReads > 0 {
                newsDuringReads -= 1
                emit(.object(["type": .string("workspace.updated"), "payload": .object(["workspaceId": .string("work")])]))
                try await Task.sleep(for: .milliseconds(50))
            }
            return .init(status: 200, body: read)
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
        if method == "POST", path.hasPrefix("/v0/agents/"), path.hasSuffix("/read") {
            acts.append("read:" + path.split(separator: "/")[2])
            return .init(status: 200, body: Data("{}".utf8))
        }
        if method == "GET", path.hasPrefix("/v0/tasks/") {
            return .init(status: 200, body: Data(#"{"task":{"version":"v1"}}"#.utf8))
        }
        if method == "POST", path.hasPrefix("/v0/tasks/"), path.hasSuffix("/archive") {
            if refuseArchive { return .init(status: 403, body: Data(#"{"error":"Only its owner may archive it."}"#.utf8)) }
            acts.append("archive:" + path.split(separator: "/")[2])
            return .init(status: 200, body: Data("{}".utf8))
        }
        if method == "POST", path.hasPrefix("/v0/surfaces/"), path.hasSuffix("/join") {
            let id = String(path.split(separator: "/")[2])
            acts.append("join:" + id)
            var object = value.objectValue!
            object["surfaces"] = .array(object["surfaces"]!.arrayValue!.map { surface in
                guard surface["id"]?.stringValue == id, var whole = surface.objectValue else { return surface }
                whole["members"] = .array((whole["members"]?.arrayValue ?? []) + [.object(["userId": .null, "orderKey": .string("z")])])
                return .object(whole)
            })
            value = .object(object)
            emit(.object(["type": .string("surface.updated"), "payload": .object(["surfaceId": .string(id)])]))
            return .init(status: 200, body: Data("{}".utf8))
        }
        if method == "POST", path.hasSuffix("/send") {
            sends.append(try JSONDecoder().decode(JSONValue.self, from: body!))
            if loseSendAck { loseSendAck = false; throw URLError(.networkConnectionLost) }
            return .init(status: 200, body: Data("{}".utf8))
        }
        return .init(status: 404, body: Data("{}".utf8))
    }
    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        guard online else { throw URLError(.notConnectedToInternet) }
        streamHeaders.append(headers)
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let streamID = streamHeaders.count
        continuation.onTermination = { [weak self] _ in Task { await self?.streamClosed(streamID) } }
        continuations.append(continuation)
        let process = daemonId.map { ",\"daemonId\":\"\($0)\"" } ?? ""
        let gap = nextHelloGap ? "true" : "false"
        nextHelloGap = false
        if holdHello { holdHello = false; heldHello = continuation; return .init(status: 200, body: body) }
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true,\"gap\":\(gap)\(process)}\n\n".utf8))
        return .init(status: 200, body: body)
    }
    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

final class SyncEngineTests: XCTestCase {
    private actor StreamLease {
        var expired: (@Sendable () -> Void)?
        var releases = 0
        func acquire(_ expired: @escaping @Sendable () -> Void) -> (@Sendable () async -> Void)? {
            self.expired = expired
            return { await self.release() }
        }
        func release() { releases += 1 }
        func expire() { expired?() }
        func releaseCount() -> Int { releases }
    }

    func testShortBackgroundHoldsThenRacesFreshStream() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        await transport.setDaemon("d1")
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let reads = await transport.bootstrapReads()
        await engine.background()
        let closed = await transport.closedStreamCount()
        XCTAssertEqual(closed, 0)
        let delivering = await engine.deliveryAllowed
        XCTAssertFalse(delivering)
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let after = await transport.bootstrapReads()
        XCTAssertEqual(after, reads, "same daemon resumes without rereading bootstrap")
        try await eventually { await transport.closedStreamCount() == 1 }
        await engine.stop()
    }

    func testBackgroundLeaseExpirationClosesHeldStream() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.background()
        await lease.expire()
        try await eventually { await transport.closedStreamCount() == 1 }
        try await eventually { await lease.releaseCount() == 1 }
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        await engine.stop()
    }

    func testHeldFrameWinsAndResumesQueuedDeliveryWithoutFreshHello() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        await transport.setDaemon("d1")
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let reads = await transport.bootstrapReads()
        await engine.background()
        await engine.markRead("last-agent")
        let before = await transport.heardActs()
        XCTAssertTrue(before.isEmpty)
        await transport.holdNextHello()
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        let unproven = await engine.deliveryAllowed
        XCTAssertFalse(unproven)
        let reconnected = await transport.bootstrapReads()
        XCTAssertEqual(reconnected, reads)
        await transport.emitHeld(id: "held", .object(["type": .string("git.updated"), "payload": .object([:])]))
        try await eventually { await transport.heardActs().contains("read:last-agent") }
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.stop()
    }

    func testBackgroundDeadlineClosesHeldStreamWithoutExpirationCallback() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) }, streamHoldDuration: .milliseconds(30))
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.background()
        try await eventually { await transport.closedStreamCount() == 1 }
        _ = try await wait(engine) { !$0.live }
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        await engine.stop()
    }

    func testMoveWhileBackgroundedDropsHeldFlowWithoutOpeningAnother() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.background()
        await engine.moved()
        let count = await transport.streamsOpened()
        XCTAssertEqual(count, 1)
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        await engine.stop()
    }

    func testHeldFlowLostWhileBackgroundedReconnectsOnForeground() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.background()
        await transport.dropStreams()
        _ = try await wait(engine) { !$0.live }
        await engine.foreground()
        try await eventually { await transport.streamsOpened() == 2 }
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.stop()
    }

    func testSilentRaceClosesBothAndReconnects() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.background()
        await transport.configure(online: false)
        await engine.foreground()
        // Nothing wins within the race's few seconds: the held flow is
        // closed, the tunnel reset, and the stream opened as after any loss.
        for _ in 0..<200 where await !transport.heardResets().contains(.realtime) {
            try await Task.sleep(for: .milliseconds(50))
        }
        let closed = await transport.closedStreamCount()
        XCTAssertEqual(closed, 1)
        await transport.configure(online: true)
        _ = try await wait(engine) { $0.live && !$0.syncing && !$0.reconnecting }
        let delivering = await engine.deliveryAllowed
        XCTAssertTrue(delivering)
        await engine.stop()
    }

    func testFreshHelloAfterBackgroundDetectsDaemonRestart() async throws {
        let transport = SyncFixture(), lease = StreamLease()
        await transport.setDaemon("d1")
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil,
                                streamHold: { await lease.acquire($0) })
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let reads = await transport.bootstrapReads()
        await engine.background()
        await transport.setDaemon("d2")
        await engine.foreground()
        try await eventually { await transport.bootstrapReads() > reads }
        await engine.stop()
    }

    func testRepeatedEventIDIsDeliveredOnlyOnce() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let reads = await transport.bootstrapReads()
        let event: JSONValue = .object(["type": .string("workspace.updated"), "payload": .object([:])])
        await transport.emit(id: "once", event)
        try await eventually { await transport.bootstrapReads() > reads }
        _ = try await wait(engine) { !$0.syncing }
        let after = await transport.bootstrapReads()
        await transport.emit(id: "once", event)
        try await Task.sleep(for: .milliseconds(100))
        let duplicated = await transport.bootstrapReads()
        XCTAssertEqual(duplicated, after)
        await engine.stop()
    }

    private struct Timeout: Error {}
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
    private func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("direct-sync-\(UUID().uuidString)") }

    func testTransientReconcileFailureRetriesWithoutAnotherEvent() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        await transport.renameProjectAfterOneFailedRead()
        let changed = try await wait(engine) { $0.rows.contains { $0.label == "Renamed remotely" } }
        XCTAssertTrue(changed.live)
        await engine.stop()
    }

    /// News during every read, as while agents work: each read is still
    /// taken, so home moves at once rather than when the news stops.
    func testNewsDuringEveryReadStillMovesHome() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        await transport.renameProject(withNewsDuringReads: 1_000)
        let changed = try await wait(engine) { $0.rows.contains { $0.label == "Renamed while busy" } }
        XCTAssertTrue(changed.live)
        await engine.stop()
    }

    /// A dropped stream that comes back to the same process with nothing
    /// missed picks up after the last event and reads nothing again; a gap
    /// or another process reads home first.
    func testAReconnectReadsOnlyWhatItMissed() async throws {
        let transport = SyncFixture()
        await transport.setDaemon("d1")
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let first = await transport.bootstrapReads()
        await transport.emit(id: "cursor-2", .object(["type": .string("git.updated"), "payload": .object([:])]))
        try await Task.sleep(for: .milliseconds(100))

        await transport.drop()
        _ = try await wait(engine) { !$0.live }
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let resumed = await transport.bootstrapReads()
        XCTAssertEqual(resumed, first, "back on the same process with nothing stale: no read")
        let resumedFrom = await transport.lastStreamCursor()
        XCTAssertEqual(resumedFrom, "cursor-2", "picked up after the last event taken in")

        await transport.gapNextHello()
        await transport.drop()
        _ = try await wait(engine) { !$0.live }
        try await eventually { await transport.bootstrapReads() > resumed }

        let afterGap = await transport.bootstrapReads()
        await transport.setDaemon("d2")
        await transport.drop()
        _ = try await wait(engine) { !$0.live }
        try await eventually { await transport.bootstrapReads() > afterGap }
        await engine.stop()
    }

    /// A pause whose tasks wind down slowly, overtaken by a start that
    /// comes back live, leaves the outbox to that start: what the person
    /// does next still goes out.
    func testALatePauseDoesNotTakeALiveEngineOffline() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await transport.holdNextBootstrap()
        await transport.emit(.object(["type": .string("workspace.updated"), "payload": .object(["workspaceId": .string("work")])]))
        try await eventually { await transport.isHolding() }

        // The pause waits on that read; a start gets in once it let go of the run.
        let pausing = Task { await engine.pause() }
        try await eventually {
            await engine.start()
            return await transport.streamsOpened() == 2
        }
        await transport.release()
        await pausing.value

        await engine.markRead("last-agent")
        try await eventually { await transport.heardActs().contains("read:last-agent") }
        await engine.stop()
    }

    /// Wi-Fi to cellular: the stream, live over the old way, is opened
    /// again at once on a new tunnel, every tunnel woken, and home says it
    /// is reconnecting until the stream answers, then picks up where it was.
    func testAMoveOpensTheStreamAgainAtOnce() async throws {
        let transport = SyncFixture()
        await transport.setDaemon("d1")
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let reads = await transport.bootstrapReads()
        // The new stream's hello waits, so the step between is seen.
        await transport.holdNextHello()

        await engine.moved()
        let between = try await wait(engine) { !$0.live && $0.reconnecting }
        XCTAssertNil(between.error, "the header's \"connecting…\" (`Session.headerState`)")
        try await eventually { await transport.streamsOpened() == 2 }
        await transport.releaseHello()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        let resets = await transport.heardResets()
        XCTAssertEqual(resets, [.realtime])
        try await eventually { await transport.heardWakes() == 1 }
        let after = await transport.bootstrapReads()
        XCTAssertEqual(after, reads, "the same process with nothing missed: no read")
        await engine.stop()
    }

    /// The app goes to the background while a move closes the old tunnel:
    /// the move doesn't start the engine again behind the pause.
    func testAMoveDoesNotUndoAPauseThatCameMeanwhile() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await transport.holdNextReset()
        let moving = Task { await engine.moved() }
        try await eventually { await transport.isHoldingReset() }

        await engine.pause()
        await transport.releaseReset()
        await moving.value
        try await Task.sleep(for: .milliseconds(200))
        let streams = await transport.streamsOpened()
        XCTAssertEqual(streams, 1, "the paused engine opened its stream again")
        let delivering = await engine.deliveryAllowed
        XCTAssertFalse(delivering)
        await engine.stop()
    }

    private func eventually(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<80 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("not in time")
    }

    func testAccountDrainsPersistedSendWithoutOpeningConversation() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = SyncFixture()
        let mode = AgentWire.Mode(providerId: "test", modelId: "test-model", effort: "low", serviceTier: nil, permissionMode: "auto")
        let first = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
        try await first.enqueueMessage(.init(id: "stable-message", agentID: "never-opened", text: "Offline text", pictures: [], mode: mode))
        await first.stop()
        let reopened = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
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
        let transport = SyncFixture()
        await transport.loseNextSendAcknowledgement()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
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
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(SyncFixture.fixture.utf8))
        let all = SidebarRows.make(desktop, settings: [:])
        XCTAssertEqual(all.map { $0.kind == .separator ? "—" : $0.label }, ["Artifacts", "Todos", "Notes", "Groceries", "—", "Happy", "Delegated task", "—", "Last created", "First created", "—", "App", "Root chat", "Feature"])
        XCTAssertEqual(all.map(\.id).count, Set(all.map(\.id)).count)
        XCTAssertEqual(all.first { $0.label == "Delegated task" }?.depth, 1)
        // The task the person isn't in isn't listed, but search finds it, and it opens its conversation.
        XCTAssertEqual(SidebarRows.unjoinedTasks(desktop).map { [$0.label, $0.agentId ?? "", $0.targetKind ?? ""] }, [["Not joined", "unjoined-agent", "task"]])
        let settings: [String: JSONValue] = [DesktopSettingKeys.projectsVisibility: .object(["projectsHidden": .bool(true)]), "happy-desktop.bot.happy": .object(["hidden": .bool(true)])]
        let hidden = SidebarRows.make(desktop, settings: settings)
        XCTAssertEqual(hidden.map { $0.kind == .separator ? "—" : $0.label }, ["Artifacts", "Todos", "Notes", "Groceries", "—", "—", "Last created", "First created"])
    }

    func testOfflineCacheAndSettingsSurviveAccountRelaunchThenReplay() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        await engine.pause()
        await transport.configure(online: false)
        try await engine.setProjectsHidden(true)
        let optimistic = try await wait(engine) { DesktopSettingKeys.projectsHidden($0.settings) }
        XCTAssertFalse(optimistic.rows.contains { $0.targetKind == "project" })
        await engine.stop()

        let reopened = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
        await reopened.start()
        let offline = try await wait(reopened) { $0.loaded }
        XCTAssertFalse(offline.live)
        XCTAssertTrue(DesktopSettingKeys.projectsHidden(offline.settings))
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
        // A relaunch opens the stream from now, home read beside it: no replay.
        let headers = await transport.streamHeaders
        XCTAssertTrue(headers.allSatisfy { $0["Last-Event-ID"] == nil })
        await reopened.stop()
    }

    /// A session started is what the next one starts on: kept at once in
    /// the person's settings, offline too, under desktop's keys. On Default
    /// Model only the account and the model's memory move.
    func testAStartedSessionIsKeptInThePersonsSettings() async throws {
        typealias Key = ModelPreferences.Key
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        await engine.pause()
        await transport.configure(online: false)
        let started = AgentWire.Mode(providerId: "codex", modelId: "openai/sol", effort: "high", serviceTier: "priority", permissionMode: "auto")
        try await engine.sessionStarted(started)
        var settings = await engine.userSettings()
        XCTAssertEqual(settings[Key.defaultModel], .object(["modelId": .string("openai/sol")]))
        XCTAssertEqual(settings[Key.effort], .string("high"))
        XCTAssertEqual(settings[Key.provider], .string("codex"))
        XCTAssertEqual(ModelPreferences(settings).memory, [.init(providerId: "codex", modelId: "openai/sol", effort: "high", serviceTier: "priority")])
        XCTAssertNil(settings[Key.start])

        try await engine.updateModelPreferences { $0.start = .defaultModel }
        try await engine.sessionStarted(AgentWire.Mode(providerId: "claude", modelId: "anthropic/opus-5", effort: "max", serviceTier: nil, permissionMode: "auto"))
        settings = await engine.userSettings()
        XCTAssertEqual(settings[Key.start], .string("default"))
        XCTAssertEqual(settings[Key.defaultModel], .object(["modelId": .string("openai/sol")]), "Default Model moved the default")
        XCTAssertEqual(settings[Key.effort], .string("high"))
        XCTAssertEqual(settings[Key.provider], .string("claude"))
        XCTAssertEqual(ModelPreferences(settings).memory.map(\.modelId), ["openai/sol", "anthropic/opus-5"])
        let snapshot = try await wait(engine) { $0.settings[Key.provider] == .string("claude") }
        XCTAssertEqual(snapshot.settings[Key.start], .string("default"))
        await engine.stop()
    }

    func testRemoteSettingChangesHomeAndAStaleOfflineEditAdoptsServerWinner() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live }
        await transport.setProjectsHidden(true)
        let remote = try await wait(engine) { DesktopSettingKeys.projectsHidden($0.settings) }
        XCTAssertFalse(remote.rows.contains { $0.label == "App" })
        await engine.pause()
        try await engine.setProjectsHidden(false)
        await transport.setProjectsHidden(true, stamp: Date().timeIntervalSince1970 * 1000 + 1000)
        await engine.start()
        _ = try await wait(engine) { $0.live && DesktopSettingKeys.projectsHidden($0.settings) }
        await engine.stop()
    }

    /// A chat opened offline is read at once; a task archived offline is
    /// gone at once. Both stay so through a kill and an offline relaunch,
    /// whatever the cached bootstrap says, and go to the computer once it
    /// is reachable, each once.
    func testPendingReadAndArchiveSurviveARelaunchOfflineThenFlush() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = SyncFixture()
        await transport.setUnread(task: "last", true)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
        await engine.start()
        let first = try await wait(engine) { $0.live && $0.loaded }
        XCTAssertEqual(first.rows.first { $0.label == "Last created" }?.unread, true)
        await engine.pause()
        await transport.configure(online: false)

        await engine.markRead("last-agent")
        let read = try await wait(engine) { $0.rows.first { $0.label == "Last created" }?.unread == false }
        XCTAssertFalse(read.live)
        await engine.archive(kind: "task", id: "first")
        _ = try await wait(engine) { !$0.rows.contains { $0.label == "First created" } }
        await engine.stop()

        // Killed and opened again, still offline: as the person left it.
        let reopened = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: directory, rereadInterval: .zero)
        await reopened.start()
        let offline = try await wait(reopened) { $0.loaded }
        XCTAssertFalse(offline.live)
        XCTAssertEqual(offline.rows.first { $0.label == "Last created" }?.unread, false, "the dot came back from the cache")
        XCTAssertFalse(offline.rows.contains { $0.label == "First created" }, "the archived task came back from the cache")
        let pending = await reopened.intents.pending().map(\.kind)
        XCTAssertEqual(pending, [.read, .archive])
        let heardOffline = await transport.heardActs()
        XCTAssertEqual(heardOffline, [])

        await reopened.pause()
        await transport.configure(online: true)
        await reopened.start()
        _ = try await wait(reopened) { $0.live }
        for _ in 0..<200 where await !reopened.intents.pending().isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        let heard = await transport.heardActs()
        XCTAssertEqual(heard, ["read:last-agent", "archive:first"])
        await reopened.stop()
    }

    /// The computer still says unread (a bootstrap read before it heard):
    /// the dot stays off while the read waits.
    func testAStaleReadDoesNotBringTheDotBack() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        await engine.pause()
        await engine.markRead("last-agent")
        await transport.setUnread(task: "last", true)
        await transport.configure(online: true)
        // A read of the computer that predates the read: offline delivery
        // is held so only the stale bootstrap lands.
        await engine.intents.setDeliver { _ in throw URLError(.notConnectedToInternet) }
        await engine.start()
        let stale = try await wait(engine) { $0.live && $0.loaded }
        XCTAssertEqual(stale.rows.first { $0.label == "Last created" }?.unread, false)
        await engine.stop()
    }

    /// Opening a Surface the person isn't in joins it, as desktop's
    /// opening does (de78af49), and home lists it once the computer says
    /// so; one already in their list, or one home doesn't know, sends nothing.
    func testOpeningASurfaceThePersonIsntInJoinsIt() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        let before = try await wait(engine) { $0.live && $0.loaded }
        XCTAssertFalse(before.rows.contains { $0.label == "Other person's document" })
        await engine.join(surfaceId: "doc")
        await engine.join(surfaceId: "missing")
        await engine.join(surfaceId: "other")
        _ = try await wait(engine) { $0.rows.contains { $0.label == "Other person's document" } }
        let heard = await transport.heardActs()
        XCTAssertEqual(heard, ["join:other"])
        await engine.stop()
    }

    /// A refused archive rolls back: the row is back, and the list says why.
    func testARefusedArchiveRollsBackWithANotice() async throws {
        let transport = SyncFixture()
        await transport.refuseArchives()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && $0.loaded }
        let kept = await engine.archive(kind: "task", id: "first")
        let intent = try XCTUnwrap(kept)
        let taken = await engine.intents.outcome(intent.id)
        XCTAssertFalse(taken)
        let back = try await wait(engine) { $0.notice != nil }
        XCTAssertEqual(back.notice, "Only its owner may archive it.")
        XCTAssertTrue(back.rows.contains { $0.label == "First created" })
        await engine.stop()
    }

    /// Home is the classic sidebar, whatever the computer holds of the
    /// retired Stem Cells experiment: the spaces sidebar is never read.
    func testStemCellsSettingLeavesHomeClassic() async throws {
        let transport = SyncFixture()
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, rereadInterval: .zero)
        await engine.start()
        let classic = try await wait(engine) { $0.live && $0.loaded && !$0.syncing }
        await transport.turnOnStemCells()
        let after = try await wait(engine) { $0.settings["happy-desktop.experiments.stemCells"] == .bool(true) && !$0.syncing }
        XCTAssertEqual(after.rows, classic.rows)
        try await Task.sleep(for: .milliseconds(100))
        let requested = await transport.requestedPaths()
        XCTAssertFalse(requested.contains("/v0/spaces/sidebar?widgets=true"))
        await engine.stop()
    }

    /// A fresh stream (away past `resumeWindow`) paused before its read
    /// lands, then woken within the window: the wake asks for what came
    /// after the last event (`Last-Event-ID`) only when the stream came from
    /// the process an earlier read verified. Another process, or one that
    /// names none, opens from now and reads.
    private func wakeAfterAnUnreadStream(daemon first: String?, then second: String?) async throws -> String? {
        let transport = SyncFixture()
        await transport.setDaemon(first)
        let engine = SyncEngine(client: AgentClient(transport: transport, token: "test"), directory: nil, resumeWindow: .milliseconds(400), rereadInterval: .zero)
        await engine.start()
        _ = try await wait(engine) { $0.live && !$0.syncing }
        await engine.pause()
        try await Task.sleep(for: .milliseconds(500))
        await transport.setDaemon(second)
        await transport.holdNextBootstrap()
        await engine.start()
        _ = try await wait(engine) { $0.live }
        try await eventually { await transport.isHolding() }
        // The read lands only after the pause has let go of it.
        let release = Task { try await Task.sleep(for: .milliseconds(100)); await transport.release() }
        await engine.pause()
        try await release.value
        let opened = await transport.streamsOpened()
        await engine.start()
        try await eventually { await transport.streamsOpened() > opened }
        let cursor = await transport.lastStreamCursor()
        await engine.stop()
        return cursor
    }

    func testAWakeAfterAnUnreadStreamFromTheSameProcessPicksUp() async throws {
        let cursor = try await wakeAfterAnUnreadStream(daemon: "d1", then: "d1")
        XCTAssertEqual(cursor, "cursor-1")
    }

    func testAWakeAfterAnUnreadStreamFromAnotherProcessOpensFromNow() async throws {
        let cursor = try await wakeAfterAnUnreadStream(daemon: "d1", then: "d2")
        XCTAssertNil(cursor)
    }

    func testAProcessThatNamesNoneNeverPicksUp() async throws {
        let cursor = try await wakeAfterAnUnreadStream(daemon: nil, then: nil)
        XCTAssertNil(cursor)
    }
}
