import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer with one task and one bot. `storyFeed` and the `stories`
/// setting are each switched here; the feed serves whatever was posted.
private actor StoriesComputer: AgentTransport {
    var storyFeed: Bool
    var settingOn: Bool
    var feed: [JSONValue] = []
    var requested: [String] = []
    var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    /// Feed reads wait here while held, each answered with the feed as it was asked for.
    var holding = false
    var held: [CheckedContinuation<Void, Never>] = []

    init(storyFeed: Bool = true, settingOn: Bool = true) {
        self.storyFeed = storyFeed
        self.settingOn = settingOn
    }

    func post(_ story: JSONValue) { feed.append(story) }
    func hold() { holding = true }
    func release() { holding = false; held.forEach { $0.resume() }; held = [] }
    func setting(_ on: Bool) { settingOn = on }
    func paths() -> [String] { requested }
    func emit(_ event: JSONValue) {
        let json = String(data: try! JSONEncoder().encode(event), encoding: .utf8)!
        continuations.forEach { $0.yield(Data("event: message\ndata: \(json)\n\n".utf8)) }
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append("\(method) \(path)")
        func json(_ value: JSONValue) throws -> HTTP1Response { .init(status: 200, body: try JSONEncoder().encode(value)) }
        switch path {
        case "/v0/bootstrap/desktop":
            let settings: [JSONValue] = settingOn ? [["key": "stories", "value": .bool(true), "version": "1"]] : []
            return try json([
                "cursor": "c1", "profile": ["userId": .null], "userSettings": .array(settings), "projects": [], "workspaces": [], "surfaces": [],
                "bots": [["id": "bot1", "name": "Helper", "status": "active", "agent": ["id": "bot-agent", "workspaceId": "wb", "status": "idle"]]],
                "tasks": [["id": "task1", "name": "Launch", "agent": ["id": "task-agent", "workspaceId": "wt", "status": "idle"]]],
                "taskMemberships": [["taskId": "task1"]],
            ])
        case "/v0/health":
            return try json(["ready": .bool(true), "capabilities": storyFeed ? ["storyFeed": .bool(true)] : [:]])
        case "/v0/stories":
            let answer = feed
            if holding { await withCheckedContinuation { held.append($0) } }
            return try json(["stories": .array(answer), "cursor": .null])
        default:
            return .init(status: method == "GET" ? 404 : 200, body: Data("{}".utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"c1\",\"resumed\":true}\n\n".utf8))
        return .init(status: 200, body: body)
    }

    func close() { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

final class StoriesTests: XCTestCase {
    private static let now = Date().timeIntervalSince1970 * 1000

    private static func story(_ id: String, task: String? = nil, bot: String? = nil, seen: Bool = false, kind: String = "image", posted: Double = now - 60_000, expires: Double = now + 3_600_000) -> JSONValue {
        [
            "id": .string(id), "agentId": "a", "taskId": task.map(JSONValue.string) ?? .null, "botId": bot.map(JSONValue.string) ?? .null,
            "caption": "Shipped", "media": ["kind": .string(kind), "mimeType": "image/png", "size": 10],
            "postedAt": .number(posted), "expiresAt": .number(expires), "seen": .bool(seen), "repostOf": ["id": "ignored"],
        ]
    }

    private static func decode(_ values: [JSONValue]) throws -> [Story] {
        Stories.decode(feed: try JSONEncoder().encode(JSONValue.object(["stories": .array(values)])))
    }

    // MARK: Wire and rings

    /// One story this app can't read never costs the rest.
    func testTheFeedSkipsWhatItCantRead() throws {
        let stories = try Self.decode([Self.story("a", task: "t"), ["id": "broken"], Self.story("c", bot: "b", kind: "video")])
        XCTAssertEqual(stories.map(\.id), ["a", "c"])
        XCTAssertEqual(stories.first?.caption, "Shipped")
        XCTAssertTrue(stories[1].isVideo)
        XCTAssertEqual(Stories.decode(feed: Data("nope".utf8)), [])
    }

    /// Only live stories show, oldest first, however they arrived.
    func testOnlyLiveStoriesShowOldestFirst() async throws {
        let computer = StoriesComputer()
        await computer.post(Self.story("new", task: "task1", posted: Self.now - 10))
        await computer.post(Self.story("gone", task: "task1", expires: Self.now - 1))
        let engine = await engine(computer)
        _ = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        await computer.emit(["type": "story.changed", "payload": ["story": Self.story("old", task: "task1", posted: Self.now - 100)]])
        let snapshot = try await wait(engine) { $0.stories.count == 2 }
        XCTAssertEqual(snapshot.stories.map(\.id), ["old", "new"])
        await engine.stop()
    }

    func testARowsOutlineIsUnseenWhileAnyOfItsStoriesIs() throws {
        var task = Row(id: "task:t", nodeId: "task:t", kind: .space, label: "T", targetKind: "task"); task.targetId = "t"
        var bot = Row(id: "bot:t", nodeId: "bot:t", kind: .space, label: "B", targetKind: "bot"); bot.targetId = "t"
        var other = Row(id: "task:u", nodeId: "task:u", kind: .space, label: "U", targetKind: "task"); other.targetId = "u"
        let session = Row(id: "session:x", nodeId: "session:x", kind: .session, label: "S")
        let rows = [task, bot, other, session]

        let mixed = Stories.ring(rows, stories: try Self.decode([Self.story("1", task: "t", seen: true), Self.story("2", task: "t")]))
        XCTAssertEqual(mixed.map(\.story), [.unseen, nil, nil, nil], "a bot sharing the task's ID wore its story")
        let seen = Stories.ring(rows, stories: try Self.decode([Self.story("1", task: "t", seen: true), Self.story("3", bot: "t", seen: true)]))
        XCTAssertEqual(seen.map(\.story), [.seen, .seen, nil, nil])
        XCTAssertEqual(Stories.ring(rows, stories: []), rows)
    }

    // MARK: The engine

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

    private static func ring(_ snapshot: HomeSnapshot, _ label: String) -> StoryRing? { snapshot.allRows.first { $0.label == label }?.story }

    private func engine(_ computer: StoriesComputer) async -> SyncEngine {
        let engine = SyncEngine(client: AgentClient(transport: computer, token: "t"), directory: nil)
        await engine.start()
        return engine
    }

    /// Posted, seen here and on the computer, a new one live off the stream.
    func testAStoryRingsItsTaskTurnsGreyOnceSeenAndArrivesLive() async throws {
        let computer = StoriesComputer()
        await computer.post(Self.story("s1", task: "task1"))
        let engine = await engine(computer)
        var snapshot = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        XCTAssertNil(Self.ring(snapshot, "Helper"))
        XCTAssertEqual(snapshot.stories.map(\.id), ["s1"])

        await engine.markStorySeen("s1")
        snapshot = try await wait(engine) { Self.ring($0, "Launch") == .seen }
        try await Task.sleep(for: .milliseconds(100))
        let paths = await computer.paths()
        XCTAssertTrue(paths.contains("POST /v0/stories/s1/seen"))

        await computer.emit(["type": "story.changed", "payload": ["story": Self.story("s2", bot: "bot1")]])
        snapshot = try await wait(engine) { Self.ring($0, "Helper") == .unseen }
        XCTAssertEqual(Self.ring(snapshot, "Launch"), .seen)
        await engine.stop()
    }

    /// Turned off on another device: the outlines go without a relaunch.
    func testTurningTheSettingOffTakesEveryOutlineOff() async throws {
        let computer = StoriesComputer()
        await computer.post(Self.story("s1", task: "task1"))
        let engine = await engine(computer)
        _ = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        await computer.emit(["type": "user_settings.updated", "payload": ["setting": ["key": "stories", "value": .bool(false), "version": "2"]]])
        let off = try await wait(engine) { $0.allRows.contains { $0.label == "Launch" } && Self.ring($0, "Launch") == nil }
        XCTAssertEqual(off.stories, [])
        await engine.stop()
    }

    /// Off, or on a computer without `storyFeed`, no feed is asked for and the rows are main's.
    func testOffOrOnAnOlderComputerNothingIsReadOrDrawn() async throws {
        for computer in [StoriesComputer(settingOn: false), StoriesComputer(storyFeed: false)] {
            await computer.post(Self.story("s1", task: "task1"))
            let engine = await engine(computer)
            _ = try await wait(engine) { $0.live && $0.loaded }
            try await Task.sleep(for: .milliseconds(200))
            let snapshot = try await wait(engine) { _ in true }
            XCTAssertTrue(snapshot.allRows.allSatisfy { $0.story == nil })
            XCTAssertEqual(snapshot.stories, [])
            let feedReads = await computer.paths().filter { $0.contains("/v0/stories") }
            XCTAssertEqual(feedReads, [])
            let healthReads = await computer.paths().filter { $0.contains("/v0/health") }
            let asks = await computer.settingOn ? 1 : 0
            XCTAssertEqual(healthReads.count, asks, "off, the computer was asked; or asked twice")
            await engine.stop()
        }
    }

    /// A story's outline goes when it ends, with no read.
    func testAnEndedStoryTakesItsOutlineOff() async throws {
        let computer = StoriesComputer()
        await computer.post(Self.story("s1", task: "task1", expires: Date().timeIntervalSince1970 * 1000 + 600))
        await computer.post(Self.story("s0", task: "task1", expires: Self.now - 1))
        let engine = await engine(computer)
        let live = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        XCTAssertEqual(live.stories.map(\.id), ["s1"], "an ended story showed")
        let ended = try await wait(engine) { $0.allRows.contains { $0.label == "Launch" } && Self.ring($0, "Launch") == nil }
        XCTAssertEqual(ended.stories, [])
        await engine.stop()
    }

    // MARK: Review fixes

    /// Turned on here: the feed is read at once. A later read of the
    /// computer reads the feed again, and asks for `storyFeed` only once.
    func testTurningItOnHereReadsTheFeedAndEachReconcileReadsAgain() async throws {
        let computer = StoriesComputer(settingOn: false)
        await computer.post(Self.story("s1", task: "task1"))
        let engine = await engine(computer)
        _ = try await wait(engine) { $0.live && $0.loaded }
        await computer.setting(true)
        try await engine.setSetting(Stories.settingKey, value: .bool(true))
        _ = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        let reads = await computer.paths().filter { $0 == "GET /v0/stories" }.count
        await computer.post(Self.story("s2", bot: "bot1"))
        await computer.emit(["type": "task.updated", "payload": ["taskId": "task1"]])
        _ = try await wait(engine) { Self.ring($0, "Helper") == .unseen }
        let paths = await computer.paths()
        XCTAssertGreaterThan(paths.filter { $0 == "GET /v0/stories" }.count, reads)
        XCTAssertEqual(paths.filter { $0 == "GET /v0/health" }.count, 1)
        await engine.stop()
    }

    /// A feed read in flight never undoes what happened here meanwhile: a
    /// story seen, or one that arrived live.
    func testAFeedReadInFlightKeepsSeenAndLiveStories() async throws {
        let computer = StoriesComputer()
        await computer.post(Self.story("s1", task: "task1"))
        let engine = await engine(computer)
        _ = try await wait(engine) { Self.ring($0, "Launch") == .unseen }
        await computer.hold()
        await computer.emit(["type": "task.updated", "payload": ["taskId": "task1"]])
        try await Task.sleep(for: .milliseconds(400))
        await engine.markStorySeen("s1")
        await computer.emit(["type": "story.changed", "payload": ["story": Self.story("s2", bot: "bot1")]])
        _ = try await wait(engine) { Self.ring($0, "Launch") == .seen && Self.ring($0, "Helper") == .unseen }
        await computer.release()
        try await Task.sleep(for: .milliseconds(200))
        let after = try await wait(engine) { _ in true }
        XCTAssertEqual(Self.ring(after, "Launch"), .seen, "the stale read undid the seen")
        XCTAssertEqual(Self.ring(after, "Helper"), .unseen, "the stale read dropped the live story")
        await engine.stop()
    }

    /// A read that lands after a pause changes nothing.
    func testAReadThatLandsAfterAPauseIsIgnored() async throws {
        let computer = StoriesComputer()
        let engine = await engine(computer)
        _ = try await wait(engine) { $0.live && $0.loaded }
        await computer.hold()
        await computer.post(Self.story("s1", task: "task1"))
        await computer.emit(["type": "task.updated", "payload": ["taskId": "task1"]])
        try await Task.sleep(for: .milliseconds(400))
        let pausing = Task { await engine.pause() }
        try await Task.sleep(for: .milliseconds(50))
        await computer.release()
        await pausing.value
        try await Task.sleep(for: .milliseconds(100))
        let after = try await wait(engine) { _ in true }
        XCTAssertNil(Self.ring(after, "Launch"))
        await engine.stop()
    }

    /// An empty video asks for nothing and never traps.
    func testAnEmptyStoryAsksForNothing() async throws {
        let computer = StoriesComputer()
        var story = try XCTUnwrap(try Self.decode([Self.story("s0", task: "t", kind: "video")]).first)
        story.media.size = 0
        let source = AgentClient(transport: computer, token: "t").storySource(story)
        XCTAssertNil(source.length)
        let piece = try await source.fetch(0..<0)
        XCTAssertEqual(piece.data, Data())
        let paths = await computer.paths()
        XCTAssertEqual(paths, [])
    }
}
