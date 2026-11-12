import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer with one conversation, "s", whose reads and stream can each be
/// held or made to fail, and which writes down what it was asked.
private actor PathServer: AgentTransport {
    var owner: JSONValue = .null
    var desktopReads = 0
    var holdDesktop = false
    var desktopWaiters: [CheckedContinuation<Void, Never>] = []
    var holdHello = false
    var heldHellos: [AsyncThrowingStream<Data, Error>.Continuation] = []
    var streams: [(headers: [String: String], continuation: AsyncThrowingStream<Data, Error>.Continuation)] = []
    var openStreams = 0
    var journal = 1
    var messageQueries: [String] = []
    var failMessages = 0
    var holdMessages = false
    var messageWaiters: [CheckedContinuation<Void, Never>] = []
    var sends = 0
    /// The conversation's runs, oldest first: each with its messages' ids.
    var runs: [(id: String, messages: [String], ended: Bool)] = [("r1", ["u1", "a1"], true), ("r2", ["u2", "a2"], true)]

    func setOwner(_ id: String) { owner = .string(id) }
    func holdDesktopReads(_ hold: Bool) {
        holdDesktop = hold
        if !hold { desktopWaiters.forEach { $0.resume() }; desktopWaiters.removeAll() }
    }
    func holdHellos(_ hold: Bool) {
        holdHello = hold
        if !hold { heldHellos.forEach { $0.yield(hello(resumed: false)) }; heldHellos.removeAll() }
    }
    func failNextMessageReads(_ count: Int) { failMessages = count }
    func holdMessageReads(_ hold: Bool) {
        holdMessages = hold
        if !hold { messageWaiters.forEach { $0.resume() }; messageWaiters.removeAll() }
    }
    /// A new run the phone hasn't seen, finished, and its event.
    func addRun(_ id: String) {
        runs.append((id, ["u-\(id)", "a-\(id)"], true))
        journal += 1
    }
    func lastStreamHeaders() -> [String: String]? { streams.last?.headers }
    func streamCount() -> Int { streams.count }
    func liveStreams() -> Int { openStreams }
    func reads() -> Int { desktopReads }
    func queries() -> [String] { messageQueries }
    func sent() -> Int { sends }
    func emit(_ event: JSONValue) {
        journal += 1
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        for stream in streams { stream.continuation.yield(Data("id: \(cursor)\nevent: message\ndata: \(json)\n\n".utf8)) }
    }
    func dropStreams() { streams.forEach { $0.continuation.finish() } }
    /// `event` again under `id`, as a replay brings it.
    func replay(_ event: JSONValue, id: String) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        for stream in streams { stream.continuation.yield(Data("id: \(id)\nevent: message\ndata: \(json)\n\n".utf8)) }
    }
    func journalCursor() -> String { cursor }

    private var cursor: String { String(format: "c%04d", journal) }

    private func hello(resumed: Bool) -> Data {
        Data("event: hello\ndata: {\"cursor\":\"\(cursor)\",\"resumed\":\(resumed),\"gap\":false,\"daemonId\":\"d1\"}\n\n".utf8)
    }

    private func message(_ id: String) -> JSONValue {
        .object(["id": .string(id), "role": .string(id.hasPrefix("u") ? "user" : "agent"), "createdAt": .number(1), "metadata": .object([:]),
                 "content": .array([.object(["type": .string("text"), "text": .string("text of \(id)")])])])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        let value: JSONValue
        if path == "/v0/bootstrap/desktop" {
            desktopReads += 1
            let at = cursor
            if holdDesktop { await withCheckedContinuation { desktopWaiters.append($0) } }
            value = .object(["cursor": .string(at), "profile": .object(["userId": owner]), "userSettings": .array([]),
                             "projects": .array([.object(["id": .string("p"), "name": .string("App"), "status": .string("active"), "orderKey": .string("a"),
                                                          "agents": .array([.object(["id": .string("s"), "workspaceId": .string("p"), "title": .string("Chat"), "status": .string("idle"), "version": .string("v0001")])])])]),
                             "workspaces": .array([])])
        } else if path.hasPrefix("/v0/agents/s/messages?") {
            messageQueries.append(path)
            if failMessages > 0 { failMessages -= 1; throw URLError(.timedOut) }
            if holdMessages { await withCheckedContinuation { messageWaiters.append($0) } }
            var selected = runs
            if let after = URLComponents(string: path)?.queryItems?.first(where: { $0.name == "after" })?.value {
                guard let index = runs.firstIndex(where: { $0.messages.contains(after) }) else { return .init(status: 404, body: Data("{}".utf8)) }
                selected = Array(runs[(index + 1)...])
            }
            value = .object(["cursor": .string(cursor), "hasMore": .bool(false), "runs": .array(selected.map { run in
                .object(["id": .string(run.id), "status": .string(run.ended ? "completed" : "running"), "startedAt": .number(1),
                         "endedAt": run.ended ? .number(2) : .null, "messages": .array(run.messages.map(message))])
            })])
        } else if path == "/v0/agents/s/bootstrap" {
            value = .object(["agent": .object(["id": .string("s"), "workspaceId": .string("p"), "status": .string("idle")]), "pending": .array([]), "cursor": .string(cursor)])
        } else if method == "POST", path.hasSuffix("/send") {
            sends += 1
            return .init(status: 200, body: Data("{}".utf8))
        } else {
            return .init(status: 404, body: Data("{}".utf8))
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        streams.append((headers, continuation))
        openStreams += 1
        continuation.onTermination = { _ in Task { await self.closed() } }
        if holdHello { heldHellos.append(continuation) }
        else { continuation.yield(hello(resumed: headers["Last-Event-ID"] != nil)) }
        return .init(status: 200, body: body)
    }
    private func closed() { openStreams -= 1 }
    func close() { dropStreams() }
}

/// One way back to the computer, on a cold start and on every return to
/// the foreground: the stream opens at once, home and the chat on screen
/// are read beside it, and none of them waits on another.
final class SyncPathTests: XCTestCase {
    private func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("sync-path-\(UUID().uuidString)") }

    private func eventually(_ what: String = "", file: StaticString = #filePath, line: UInt = #line, _ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("not in time: \(what)", file: file, line: line)
    }

    private static func home(_ engine: SyncEngine) async -> HomeSnapshot {
        var iterator = await engine.snapshots().makeAsyncIterator()
        return await iterator.next()!
    }

    private final class Shown: @unchecked Sendable {
        private let lock = NSLock()
        private var value = ChatSnapshot()
        var snapshot: ChatSnapshot { lock.withLock { value } }
        func set(_ snapshot: ChatSnapshot) { lock.withLock { value = snapshot } }
        var texts: [String] { snapshot.items.map(\.text) }
    }

    private func open(_ engine: SyncEngine, _ client: AgentClient) async -> (Conversation, Shown) {
        let conversation = Conversation(client: client, store: engine.spaces, agentId: "s", persistence: engine)
        let shown = Shown()
        let updates = conversation.updates
        Task { for await snapshot in updates { shown.set(snapshot) } }
        await conversation.start()
        await conversation.setVisible(true)
        return (conversation, shown)
    }

    /// Home's read hangs: the stream is live, and a chat opened from a
    /// push shows its newest message, while home says it is still syncing
    /// and nothing is sent until the computer's owner is checked.
    func testNeitherTheStreamNorAChatWaitsForHome() async throws {
        let server = PathServer()
        await server.holdDesktopReads(true)
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        let (conversation, shown) = await open(engine, client)
        try await eventually("live while home is read") { await Self.home(engine).live }
        try await eventually("the chat's newest message") { shown.texts.contains("text of a2") }
        let held = await Self.home(engine)
        XCTAssertTrue(held.syncing)
        let allowed = await engine.deliveryAllowed
        XCTAssertFalse(allowed, "delivered before the owner was checked")
        // Words come on the stream meanwhile.
        await server.emit(.object(["type": .string("message.created"), "payload": .object(["agentId": .string("s"), "runId": .string("r2"),
            "message": .object(["id": .string("a3"), "role": .string("agent"), "createdAt": .number(3), "metadata": .object([:]),
                                "content": .array([.object(["type": .string("text"), "text": .string("live")])])])])]))
        try await eventually("a live word") { shown.texts.contains("live") }

        await server.holdDesktopReads(false)
        try await eventually("home caught up") { let home = await Self.home(engine); return home.loaded && !home.syncing }
        try await eventually("delivery once checked") { await engine.deliveryAllowed }
        await conversation.stop()
        await engine.stop()
    }

    /// The stream hangs before its hello: home is read and drawn anyway,
    /// and says it is connecting rather than live.
    func testHomeDoesNotWaitForTheStream() async throws {
        let server = PathServer()
        await server.holdHellos(true)
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        let (conversation, shown) = await open(engine, client)
        try await eventually("home drawn") { await !Self.home(engine).rows.isEmpty }
        try await eventually("chat drawn") { shown.texts.contains("text of a2") }
        let before = await Self.home(engine)
        XCTAssertFalse(before.live)
        XCTAssertTrue(before.syncing)
        await server.holdHellos(false)
        try await eventually("live") { let home = await Self.home(engine); return home.live && !home.syncing }
        await conversation.stop()
        await engine.stop()
    }

    /// A chat's read that fails says so, and is asked again by itself
    /// until it lands.
    func testAFailedChatReadIsAskedAgain() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        try await eventually("live") { let home = await Self.home(engine); return home.live && !home.syncing }
        await server.failNextMessageReads(1)
        let (conversation, shown) = await open(engine, client)
        try await eventually("the failure said") { shown.snapshot.error != nil && shown.snapshot.loaded }
        try await eventually("read again") { shown.texts.contains("text of a2") && shown.snapshot.error == nil && shown.snapshot.synced }
        await conversation.stop()
        await engine.stop()
    }

    /// Away briefly, the stream picks up where it left off and nothing is
    /// read again; away longer, it opens from now, home is read, and the
    /// chat reads only the runs after the newest it holds.
    func testShortAwayPicksUpAndLongAwayReadsOnlyWhatIsNew() async throws {
        for long in [false, true] {
            let server = PathServer()
            let client = AgentClient(transport: server, token: "t")
            let engine = SyncEngine(client: client, directory: folder(), resumeWindow: long ? .zero : .seconds(30))
            await engine.start()
            let (conversation, shown) = await open(engine, client)
            try await eventually("settled") { let home = await Self.home(engine); return home.live && !home.syncing && shown.snapshot.synced }
            await server.emit(.object(["type": .string("git.updated"), "payload": .object([:])]))
            try await Task.sleep(for: .milliseconds(100))
            let reads = await server.reads()
            let queries = await server.queries().count

            await engine.pause()
            await server.addRun("r3")
            await engine.start()
            try await eventually("live again") { let home = await Self.home(engine); return home.live && !home.syncing }
            let from = await server.lastStreamHeaders()?["Last-Event-ID"]
            if long {
                XCTAssertNil(from, "a long absence replayed the journal")
                try await eventually("home read") { await server.reads() == reads + 1 }
                try await eventually("the new run") { shown.texts.contains("text of a-r3") }
                let asked = await server.queries().dropFirst(queries)
                XCTAssertEqual(asked.count, 1, "\(asked)")
                XCTAssertTrue(asked.first?.contains("after=a2") == true, "\(asked)")
                XCTAssertTrue(shown.texts.contains("text of a1"), "the runs held were let go")
            } else {
                XCTAssertNotNil(from)
                // The chat on screen reads only what is new, beside the replay.
                try await eventually("the new run") { shown.texts.contains("text of a-r3") }
                try await Task.sleep(for: .milliseconds(200))
                let again = await server.reads()
                XCTAssertEqual(again, reads)
                let asked = await server.queries().dropFirst(queries)
                XCTAssertEqual(asked.count, 1, "\(asked)")
                XCTAssertTrue(asked.first?.contains("after=a2") == true, "\(asked)")
            }
            await conversation.stop()
            await engine.stop()
        }
    }

    /// A stream picked up where it left off verifies its process too: the
    /// next short absence picks up again, with nothing read.
    func testEveryShortAbsencePicksUp() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        try await eventually("settled") { let home = await Self.home(engine); return home.live && !home.syncing }
        try await Task.sleep(for: .milliseconds(100))
        let reads = await server.reads()
        for away in 1...2 {
            await engine.pause()
            await engine.start()
            try await eventually("live again") { let home = await Self.home(engine); return home.live && !home.syncing }
            let from = await server.lastStreamHeaders()?["Last-Event-ID"]
            XCTAssertNotNil(from, "absence \(away) opened from now")
        }
        try await Task.sleep(for: .milliseconds(200))
        let again = await server.reads()
        XCTAssertEqual(again, reads)
        await engine.stop()
    }

    /// A launch straight into a chat from a push: the chat's read, on its
    /// way before the stream opens, is let land rather than asked again.
    func testALaunchIntoAChatKeepsTheChatsReadOnItsWay() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await server.holdMessageReads(true)
        let (conversation, shown) = await open(engine, client)
        try await eventually("the chat's read") { await server.queries().count == 1 }
        await engine.start()
        try await eventually("live") { let home = await Self.home(engine); return home.live }
        try await Task.sleep(for: .milliseconds(200))
        let asked = await server.queries().count
        XCTAssertEqual(asked, 1, "the read on its way was asked again")
        await server.holdMessageReads(false)
        try await eventually("shown") { shown.snapshot.synced && shown.texts.contains("text of a2") }
        await conversation.stop()
        await engine.stop()
    }

    /// Back in the foreground into an open chat, within the window: the
    /// chat reads what is new at once, while the stream's replay, however
    /// slow, has yet to bring it.
    func testAForegroundIntoAnOpenChatReadsItWithoutWaitingForTheReplay() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        let (conversation, shown) = await open(engine, client)
        try await eventually("settled") { let home = await Self.home(engine); return home.live && !home.syncing && shown.snapshot.synced }
        await engine.pause()
        await server.addRun("r3")
        await server.holdHellos(true)
        await engine.start()
        // The stream hasn't said a word; the chat has what is new.
        try await eventually("the new run") { shown.texts.contains("text of a-r3") }
        let from = await server.lastStreamHeaders()?["Last-Event-ID"]
        XCTAssertNotNil(from)
        await server.holdHellos(false)
        await conversation.stop()
        await engine.stop()
    }

    /// News a read of home already has asks for no read: a replay's, once
    /// the read beside it has landed, and one that came during a read
    /// whose cursor is past it.
    func testNewsAReadAlreadyHasReadsNothing() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder(), rereadInterval: .zero)
        await engine.start()
        try await eventually("live") { let home = await Self.home(engine); return home.live && !home.syncing }
        try await Task.sleep(for: .milliseconds(100))
        let reads = await server.reads()
        let news: JSONValue = .object(["type": .string("project.updated"), "payload": .object(["projectId": .string("p")])])
        await server.replay(news, id: await server.journalCursor())
        try await Task.sleep(for: .milliseconds(300))
        let replayed = await server.reads()
        XCTAssertEqual(replayed, reads, "a replay's news read home again")

        await server.holdDesktopReads(true)
        await server.emit(news)
        try await eventually("the read") { await server.reads() == reads + 1 }
        let at = await server.journalCursor()
        for _ in 0..<5 { await server.replay(news, id: at) }
        try await Task.sleep(for: .milliseconds(100))
        await server.holdDesktopReads(false)
        try await Task.sleep(for: .milliseconds(400))
        let after = await server.reads()
        XCTAssertEqual(after, reads + 1, "news the read had read home again")
        await engine.stop()
    }

    /// Back twice in quick succession: one stream stays open, and the
    /// account delivers.
    func testForegroundTwiceQuickly() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder(), resumeWindow: .zero)
        await engine.start()
        try await eventually("live") { await Self.home(engine).live }
        await engine.pause()
        await engine.start()
        await engine.pause()
        await engine.start()
        try await eventually("live again") { let home = await Self.home(engine); return home.live && !home.syncing }
        try await eventually("one stream") { await server.liveStreams() == 1 }
        try await eventually("delivers") { await engine.deliveryAllowed }
        await engine.stop()
    }

    /// Sent to the background while home is being read: nothing is
    /// delivered while away, and back again it reads and delivers.
    func testBackgroundDuringTheReads() async throws {
        let server = PathServer()
        await server.holdDesktopReads(true)
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder(), resumeWindow: .zero)
        await engine.start()
        try await eventually("reading") { await server.reads() == 1 }
        let pausing = Task { await engine.pause() }
        await server.holdDesktopReads(false)
        await pausing.value
        let away = await Self.home(engine)
        XCTAssertFalse(away.live)
        let allowed = await engine.deliveryAllowed
        XCTAssertFalse(allowed)
        await engine.start()
        try await eventually("back") { let home = await Self.home(engine); return home.live && !home.syncing }
        try await eventually("delivers") { await engine.deliveryAllowed }
        await engine.stop()
    }

    /// Agents at work while live: their updates, words, context and runs
    /// are laid over what is held and read nothing; news home must read
    /// for comes together into one read, `rereadInterval` after the last.
    func testABurstOfAgentEventsReadsHomeAtMostOnce() async throws {
        let server = PathServer()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: folder())
        await engine.start()
        try await eventually("live") { let home = await Self.home(engine); return home.live && !home.syncing }
        let reads = await server.reads()
        func event(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
            var payload = payload
            payload["agentId"] = .string("s")
            return .object(["type": .string(type), "payload": .object(payload)])
        }
        for step in 1...200 {
            await server.emit(event("agent.updated", ["version": .string(String(format: "v%04d", step + 1)), "previousVersion": .string(String(format: "v%04d", step)),
                                                      "changes": .object(["status": .string(step % 2 == 0 ? "working" : "idle"), "updatedAt": .number(Double(step))])]))
            await server.emit(event("agent.context.updated", ["context": .object([:])]))
            await server.emit(event("message.delta", ["messageId": .string("a2"), "blockIndex": .number(0), "offset": .number(0), "append": .string("")]))
            await server.emit(event("run.started", ["run": .object(["id": .string("r\(step)")])]))
        }
        try await eventually("the last update drawn") { await Self.home(engine).rows.contains { $0.agentId == "s" && $0.status == .working } }
        try await Task.sleep(for: .milliseconds(500))
        let afterAgents = await server.reads()
        XCTAssertEqual(afterAgents, reads, "agents' work read home again")

        for _ in 0..<20 { await server.emit(.object(["type": .string("project.updated"), "payload": .object(["projectId": .string("p")])])) }
        try await Task.sleep(for: .seconds(1))
        let soon = await server.reads()
        XCTAssertEqual(soon, reads, "read again within the interval")
        await engine.stop()
    }

    /// Another person answers on the computer's address: what was kept is
    /// not sent to them, and home says why.
    func testAnotherOwnerStopsDelivery() async throws {
        let server = PathServer()
        await server.setOwner("first")
        let directory = folder()
        let client = AgentClient(transport: server, token: "t")
        let engine = SyncEngine(client: client, directory: directory, resumeWindow: .zero)
        await engine.start()
        try await eventually("live") { let home = await Self.home(engine); return home.live && !home.syncing }
        await engine.pause()
        await server.setOwner("second")
        try await engine.enqueueMessage(QueuedMessage(id: "m1", agentID: "s", text: "hi", pictures: [], mode: nil))
        await engine.start()
        try await eventually("refused") { await Self.home(engine).error != nil }
        try await Task.sleep(for: .milliseconds(200))
        let sent = await server.sent()
        XCTAssertEqual(sent, 0)
        let allowed = await engine.deliveryAllowed
        XCTAssertFalse(allowed)
        await engine.stop()
    }
}
