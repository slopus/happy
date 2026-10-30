import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A daemon with Stories, answered from memory.
actor StoriesTransport: AgentTransport {
    var capabilities = #"{"stories":true,"stickers":true,"sidebarOperations":true}"#
    var setting: String? = "true"
    var feed: String = ""
    var stories: [String: String] = [:]
    var requests: [(method: String, path: String, body: Data?)] = []
    var reactionDelays: [Duration] = []

    func configure(capabilities: String? = nil, setting: String?? = nil, feed: String? = nil) {
        if let capabilities { self.capabilities = capabilities }
        if let setting { self.setting = setting }
        if let feed { self.feed = feed }
    }

    func setStory(_ id: String, _ json: String?) { stories[id] = json }
    func delayReactions(_ delays: [Duration]) { reactionDelays = delays }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append((method, path, body))
        func ok(_ text: String) -> HTTP1Response { HTTP1Response(status: 200, body: Data(text.utf8)) }
        let route = path.split(separator: "?").first.map(String.init) ?? path
        switch (method, route) {
        case ("GET", "/v0/health"): return ok(#"{"ready":true,"capabilities":\#(capabilities)}"#)
        case ("GET", "/v0/user-settings/" + AgentClient.escape(AgentClient.storiesSettingKey)):
            guard let setting else { return HTTP1Response(status: 404, body: Data(#"{"error":"none","code":"not_found"}"#.utf8)) }
            return ok(#"{"setting":{"key":"\#(AgentClient.storiesSettingKey)","value":\#(setting)}}"#)
        case ("PUT", "/v0/user-settings/" + AgentClient.escape(AgentClient.storiesSettingKey)):
            let value = (try? JSONDecoder().decode(JSONValue.self, from: body ?? Data()))?["value"]
            setting = value == .bool(true) ? "true" : "false"
            return ok("{}")
        case ("GET", "/v0/stories/feed"):
            guard setting == "true" else { return HTTP1Response(status: 404) }
            return ok(feed)
        case ("GET", "/v0/stickers/recents"): return ok(#"{"recents":[{"packId":"p","stickerId":"s"}],"cursor":"c"}"#)
        default:
            let parts = route.split(separator: "/").map(String.init)
            if parts.count == 4, parts[3] == "reaction", !reactionDelays.isEmpty {
                let delay = reactionDelays.removeFirst()
                let emoji = (try? JSONDecoder().decode(JSONValue.self, from: body ?? Data()))?["emoji"]?.stringValue
                try await Task.sleep(for: delay)
                return ok(#"{"story":\#(StoriesSamples.story(parts[2], seen: true, myReaction: emoji, reactions: emoji.map { #"[{"emoji":"\#($0)","count":1}]"# } ?? "[]"))}"#)
            }
            if parts.count >= 3, parts[1] == "stories", let story = stories[parts[2]] {
                if parts.count == 4, parts[3] == "reaction" || parts[3] == "seen" || parts[3] == "post" { return ok(#"{"story":\#(story)}"#) }
                if parts.count == 3 { return ok(#"{"story":\#(story)}"#) }
            }
            return HTTP1Response(status: 404, body: Data(#"{"error":"not found","code":"not_found"}"#.utf8))
        }
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        HTTP1Stream(status: 503, headers: [:], body: AsyncThrowingStream { $0.finish() })
    }

    func close() async {}
    func paths() -> [String] { requests.map { "\($0.method) \($0.path)" } }
}

/// Stories JSON in the daemon's shape.
enum StoriesSamples {
    static func story(_ id: String, author: String? = "u9", status: String = "posted", seen: Bool = false, postedAt: Int64 = 1_000, expiresAt: Int64? = nil, myReaction: String? = nil, reactions: String = "[]", version: String = "v1") -> String {
        let posted = status == "draft" ? "null" : "\(postedAt)"
        let expires = status == "draft" ? "null" : "\(expiresAt ?? postedAt + StoryCanvas.lifetimeMs)"
        return """
        {"id":"\(id)","status":"\(status)","authorUserId":\(author.map { "\"\($0)\"" } ?? "null"),"createdBy":{"kind":"user","userId":null},"source":null,"caption":null,\
        "frames":[{"id":"f-\(id)","kind":"image","width":100,"height":200,"thumbhash":null,"durationMs":null,"asset":{"type":"chat_media","agentId":"a","toolCallId":"t","index":0},\
        "available":true,"placement":{"x":0.5,"y":0.5,"scale":1,"rotation":0},"background":["#000000","#000000"],"overlays":[]}],\
        "audience":"team","artifactVersion":1,"createdAt":1,"updatedAt":1,"postedAt":\(posted),"expiresAt":\(expires),"seen":\(seen),"viewCount":null,\
        "myReaction":\(myReaction.map { "\"\($0)\"" } ?? "null"),"reactions":\(reactions),"version":"\(version)"}
        """
    }

    static func author(_ id: String?, name: String, isSelf: Bool, storyIds: [String], unseen: Int, drafts: Int? = nil) -> String {
        let ids = storyIds.map { "\"\($0)\"" }.joined(separator: ",")
        return #"{"userId":\#(id.map { "\"\($0)\"" } ?? "null"),"name":"\#(name)","photo":null,"thumbhash":null,"isSelf":\#(isSelf),"storyIds":[\#(ids)],"unseenCount":\#(unseen),"draftCount":\#(drafts.map(String.init) ?? "null"),"latestPostedAt":null}"#
    }

    static func feed(_ authors: [String], stories: [String: String]) -> String {
        let map = stories.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",")
        return #"{"authors":[\#(authors.joined(separator: ","))],"stories":{\#(map)},"cursor":"c1"}"#
    }
}

final class StoriesStoreTests: XCTestCase {
    private var continuation: AsyncStream<Store.ConversationEvent>.Continuation?

    private func make(_ transport: StoriesTransport, offline: OfflineFile? = nil, now: Int64 = 2_000) -> StoriesStore {
        let (stream, continuation) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        self.continuation = continuation
        let client = AgentClient(transport: transport, token: "t")
        return StoriesStore(client: client, events: { stream }, offline: offline, now: { now }, firstReadDelay: firstReadDelay)
    }

    private var firstReadDelay: Duration = .zero

    private struct TimedOut: Error {}

    private func next(_ store: StoriesStore, where condition: @escaping @Sendable (StoriesSnapshot) -> Bool) async throws -> StoriesSnapshot {
        let updates = store.updates
        return try await withThrowingTaskGroup(of: StoriesSnapshot?.self) { group in
            group.addTask { for await snapshot in updates where condition(snapshot) { return snapshot }; return nil }
            group.addTask { try await Task.sleep(for: .seconds(3)); return nil }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let snapshot = first else { throw TimedOut() }
            return snapshot
        }
    }

    private func event(_ type: String, _ payload: String) {
        let json = try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"\#(type)","payload":\#(payload)}"#.utf8))
        continuation?.yield(.event(json))
    }

    private func twoAuthors() -> String {
        StoriesSamples.feed([
            StoriesSamples.author("u1", name: "Kirill Dubovitskiy", isSelf: true, storyIds: [], unseen: 0, drafts: 0),
            StoriesSamples.author("u9", name: "Steve Korshakov", isSelf: false, storyIds: ["s1", "s2"], unseen: 2),
        ], stories: ["s1": StoriesSamples.story("s1", postedAt: 1_000), "s2": StoriesSamples.story("s2", postedAt: 1_500)])
    }

    func testAComputerWithoutStoriesShowsNothing() async throws {
        let transport = StoriesTransport()
        await transport.configure(capabilities: #"{"sidebarOperations":true}"#)
        let store = make(transport)
        await store.start()
        let snapshot = try await next(store) { $0.availability != .unknown }
        XCTAssertEqual(snapshot.availability, .unsupported)
        XCTAssertNil(snapshot.feed)
        let paths = await transport.paths()
        XCTAssertFalse(paths.contains { $0.contains("/v0/stories") })
    }

    func testOffUntilTheSettingIsTrue() async throws {
        let transport = StoriesTransport()
        await transport.configure(setting: .some(nil), feed: twoAuthors())
        let store = make(transport)
        await store.start()
        let off = try await next(store) { $0.availability != .unknown }
        XCTAssertEqual(off.availability, .off)
        await store.setEnabled(true)
        let on = try await next(store) { $0.feed != nil }
        XCTAssertEqual(on.availability, .on)
        XCTAssertEqual(on.feed?.authors.count, 2)
        let paths = await transport.paths()
        XCTAssertTrue(paths.contains("PUT /v0/user-settings/\(AgentClient.escape(AgentClient.storiesSettingKey))"))
    }

    func testTheRowIsTheFeedsOrder() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        let snapshot = try await next(store) { $0.feed != nil }
        let items = StoriesRow.items(snapshot.feed, myStory: "My Story")
        XCTAssertEqual(items.map(\.title), ["Steve"])
        XCTAssertEqual(items[0].segments, 2)
        XCTAssertEqual(items[0].unseen, 2)
        XCTAssertEqual(snapshot.recents, [StickerRef(packId: "p", stickerId: "s")])
    }

    /// Seeing a story marks it and every earlier one of its author at once.
    func testSeenTurnsTheRingAtOnce() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        await transport.setStory("s2", StoriesSamples.story("s2", seen: true, postedAt: 1_500))
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.seen("s2")
        let seen = try await next(store) { $0.feed?.authors[1].unseenCount == 0 }
        XCTAssertEqual(seen.stories["s1"]?.seen, true)
        XCTAssertEqual(seen.stories["s2"]?.seen, true)
        XCTAssertTrue(StoriesRow.items(seen.feed, myStory: "My Story")[0].allSeen)
    }

    func testAnotherDevicesSeenEventMarksTheRing() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        event("story.seen", #"{"authorUserId":"u9","storyId":"s1"}"#)
        let snapshot = try await next(store) { $0.feed?.authors[1].unseenCount == 1 }
        XCTAssertEqual(snapshot.stories["s1"]?.seen, true)
        XCTAssertEqual(snapshot.stories["s2"]?.seen, false)
    }

    func testDeletingAnAuthorsLastStoryRemovesTheCircle() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        event("story.deleted", #"{"storyId":"s1","version":"v2"}"#)
        let one = try await next(store) { $0.feed?.authors.last?.storyIds == ["s2"] }
        XCTAssertEqual(one.feed?.authors.last?.unseenCount, 1)
        event("story.deleted", #"{"storyId":"s2","version":"v2"}"#)
        let none = try await next(store) { $0.feed?.authors.count == 1 }
        XCTAssertEqual(none.feed?.authors.first?.isSelf, true)
    }

    func testAPostedStoryJoinsItsAuthorsCircle() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        event("story.posted", #"{"story":\#(StoriesSamples.story("s3", postedAt: 1_800))}"#)
        let snapshot = try await next(store) { $0.feed?.authors[1].storyIds.count == 3 }
        XCTAssertEqual(snapshot.feed?.authors[1].storyIds, ["s1", "s2", "s3"])
        XCTAssertEqual(snapshot.feed?.authors[1].unseenCount, 3)
    }

    func testMyDraftsAreCounted() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        // The feed counts drafts; a new one reads it again.
        await transport.configure(feed: twoAuthors().replacingOccurrences(of: #""draftCount":0"#, with: #""draftCount":1"#))
        event("story.created", #"{"story":\#(StoriesSamples.story("d1", author: "u1", status: "draft"))}"#)
        let one = try await next(store) { $0.feed?.authors[0].draftCount == 1 }
        XCTAssertEqual(one.stories["d1"]?.status, .draft)
        await transport.configure(feed: twoAuthors())
        event("story.deleted", #"{"storyId":"d1","version":"v2"}"#)
        let none = try await next(store) { $0.feed?.authors[0].draftCount == 0 }
        XCTAssertEqual(none.stories["d1"]?.status, .deleted)
    }

    func testAReactionShowsAtOnceAndOthersCountsArrive() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        await transport.setStory("s1", StoriesSamples.story("s1", seen: true, myReaction: "❤️", reactions: #"[{"emoji":"❤️","count":1}]"#, version: "v2"))
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.react("s1", emoji: "❤️")
        let mine = try await next(store) { $0.stories["s1"]?.myReaction == "❤️" }
        XCTAssertEqual(mine.stories["s1"]?.reactions, [StoryReactionCount(emoji: "❤️", count: 1)])
        try await Task.sleep(for: .milliseconds(100))
        event("story.reacted", #"{"storyId":"s1","reactions":[{"emoji":"🔥","count":2},{"emoji":"❤️","count":1}]}"#)
        let others = try await next(store) { $0.stories["s1"]?.reactions.count == 2 }
        XCTAssertEqual(others.stories["s1"]?.myReaction, "❤️", "another person's reaction leaves mine")
    }

    /// Quick taps: only the last answer shows, whatever order they come in.
    func testTheLastReactionWins() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        await transport.delayReactions([.milliseconds(400), .milliseconds(50)])
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.react("s1", emoji: "❤️")
        await store.react("s1", emoji: "🔥")
        try await Task.sleep(for: .milliseconds(700))
        let paths = await transport.paths().filter { $0.hasSuffix("/reaction") }
        XCTAssertEqual(paths.count, 2)
        let snapshot = try await next(store) { _ in true }
        XCTAssertEqual(snapshot.stories["s1"]?.myReaction, "🔥")
        XCTAssertEqual(snapshot.stories["s1"]?.reactions, [StoryReactionCount(emoji: "🔥", count: 1)])
    }

    /// Seeing doesn't change a version, so a read from before it can't unsee.
    func testASeenStoryStaysSeen() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.seen("s2")
        _ = try await next(store) { $0.feed?.authors[1].unseenCount == 0 }
        continuation?.yield(.resync)
        try await Task.sleep(for: .milliseconds(300))
        let snapshot = try await next(store) { _ in true }
        XCTAssertEqual(snapshot.stories["s1"]?.seen, true)
        XCTAssertEqual(snapshot.feed?.authors[1].unseenCount, 0)
    }

    /// A read that began before a deletion doesn't bring the story back.
    func testADeletedStoryStaysDeleted() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        event("story.deleted", #"{"storyId":"s1","version":"v2"}"#)
        _ = try await next(store) { $0.feed?.authors.last?.storyIds == ["s2"] }
        continuation?.yield(.resync)
        try await Task.sleep(for: .milliseconds(300))
        let snapshot = try await next(store) { _ in true }
        XCTAssertEqual(snapshot.stories["s1"]?.status, .deleted)
        XCTAssertEqual(snapshot.feed?.authors.last?.storyIds, ["s2"])
    }

    /// A stream that has just connected says `resync`: one read, not two.
    func testConnectingReadsOnce() async throws {
        firstReadDelay = .seconds(1)
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        continuation?.yield(.resync)
        _ = try await next(store) { $0.feed != nil }
        try await Task.sleep(for: .milliseconds(1_200))
        let reads = await transport.paths().filter { $0 == "GET /v0/stories/feed" }.count
        XCTAssertEqual(reads, 1)
    }

    /// Off at once, with nothing of the row left to draw or keep.
    func testTurningOffForgetsTheRow() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.setEnabled(false)
        let off = try await next(store) { $0.availability == .off }
        XCTAssertNil(off.feed)
        XCTAssertTrue(off.stories.isEmpty)
        XCTAssertTrue(off.recents.isEmpty)
    }

    func testReactionCountsMoveOnePerson() {
        let counts = [StoryReactionCount(emoji: "🔥", count: 2), StoryReactionCount(emoji: "❤️", count: 2)]
        XCTAssertEqual(StoriesStore.counts(counts, from: nil, to: "❤️"), [StoryReactionCount(emoji: "❤️", count: 3), StoryReactionCount(emoji: "🔥", count: 2)])
        XCTAssertEqual(StoriesStore.counts(counts, from: "🔥", to: nil), [StoryReactionCount(emoji: "❤️", count: 2), StoryReactionCount(emoji: "🔥", count: 1)])
        XCTAssertEqual(StoriesStore.counts([StoryReactionCount(emoji: "🔥", count: 1)], from: "🔥", to: "😂"), [StoryReactionCount(emoji: "😂", count: 1)])
        XCTAssertEqual(StoriesStore.counts(counts, from: "🔥", to: "🔥"), counts)
    }

    func testExpiredStoriesLeaveTheRow() async throws {
        let transport = StoriesTransport()
        let feed = StoriesSamples.feed([
            StoriesSamples.author("u1", name: "Me", isSelf: true, storyIds: [], unseen: 0, drafts: 0),
            StoriesSamples.author("u9", name: "Old", isSelf: false, storyIds: ["s1"], unseen: 1),
            StoriesSamples.author("u8", name: "New", isSelf: false, storyIds: ["s2"], unseen: 1),
        ], stories: ["s1": StoriesSamples.story("s1", postedAt: 0, expiresAt: 1_999), "s2": StoriesSamples.story("s2", author: "u8", postedAt: 1_500)])
        await transport.configure(feed: feed)
        let store = make(transport, now: 2_000)
        await store.start()
        let snapshot = try await next(store) { $0.feed != nil }
        XCTAssertEqual(snapshot.feed?.authors.map(\.name), ["Me", "New"])
    }

    /// What the row last showed is drawn before the computer answers.
    func testTheRowOpensOnWhatWasKept() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let first = make(transport, offline: OfflineFile(directory: directory))
        await first.start()
        _ = try await next(first) { $0.feed != nil }
        await first.stop()
        try await Task.sleep(for: .milliseconds(200))

        let offlineFile = OfflineFile(directory: directory)
        XCTAssertNotNil(offlineFile.readExtra("stories.json"))
        let second = StoriesStore(client: AgentClient(transport: FailingTransport(), token: "t"), events: { AsyncStream { _ in } }, offline: offlineFile, now: { 2_000 })
        await second.start()
        let kept = try await next(second) { $0.feed != nil }
        XCTAssertEqual(kept.availability, .on)
        XCTAssertEqual(StoriesRow.items(kept.feed, myStory: "My Story").map(\.title), ["Steve"])
        XCTAssertEqual(kept.stories.count, 2)
    }

    /// The viewer holds the row's order: a read after a post waits until it closes.
    func testTheRowHoldsStillWhileTheViewerIsOpen() async throws {
        let transport = StoriesTransport()
        await transport.configure(feed: twoAuthors())
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        await store.hold(true)
        let before = await transport.paths().filter { $0 == "GET /v0/stories/feed" }.count
        event("story.posted", #"{"story":\#(StoriesSamples.story("s3", postedAt: 1_800))}"#)
        try await Task.sleep(for: .milliseconds(700))
        let during = await transport.paths().filter { $0 == "GET /v0/stories/feed" }.count
        XCTAssertEqual(during, before)
        await store.hold(false)
        try await Task.sleep(for: .milliseconds(700))
        let after = await transport.paths().filter { $0 == "GET /v0/stories/feed" }.count
        XCTAssertEqual(after, before + 1)
    }
}

/// A computer out of reach.
struct FailingTransport: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw PairingError.unavailable
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw PairingError.unavailable }
    func close() async {}
}
