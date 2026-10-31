import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A protocol-34 daemon serving story artifacts (API.md "Stories") beside main's stories routes, answered from memory.
actor StoryArtifactsTransport: AgentTransport {
    let stories: [String]
    var requests: [(path: String, body: Data?)] = []

    init(_ stories: [String]) { self.stories = stories }
    func paths() -> [String] { requests.map(\.path) }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requests.append(("\(method) \(path)", body))
        let answers = [
            "GET /v0/health": #"{"ready":true,"capabilities":{"stories":true,"storyArtifacts":true,"taskSections":true}}"#,
            "GET /v0/user-settings/happy-desktop.experiments.stories": #"{"setting":{"key":"happy-desktop.experiments.stories","value":true}}"#,
            "GET /v0/stories/feed": #"{"authors":[],"stories":{},"cursor":"c0"}"#,
            "GET /v0/stickers/recents": #"{"recents":[]}"#,
            "GET /v0/stories?scope=feed": #"{"stories":[\#(stories.joined(separator: ","))],"cursor":"c1"}"#,
            "GET /v0/artifacts/m2/versions/1": #"{"version":{"artifactId":"m2","number":1,"title":"Demo","entry":{"path":"demo.mp4","mimeType":"video/mp4","size":1},"files":[]}}"#,
            "GET /v0/agents/a1/bootstrap": #"{"mode":{"providerId":"codex","modelId":"gpt","effort":"medium","serviceTier":null,"permissionMode":"auto"}}"#,
        ]
        guard let answer = answers["\(method) \(path)"] ?? (method == "POST" ? "{}" : nil) else { return HTTP1Response(status: 404, body: Data("{}".utf8)) }
        return HTTP1Response(status: 200, body: Data(answer.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { HTTP1Stream(status: 503, headers: [:], body: AsyncThrowingStream { $0.finish() }) }
    func close() async {}
}

final class StoryArtifactsTests: XCTestCase {
    private var continuation: AsyncStream<Store.ConversationEvent>.Continuation?
    private let me = "u1"

    private func story(_ id: String, agent: String = "a1", at: Int64 = 1_755_400_000_000, state: String = "live", seen: Bool = false, poster: String? = nil, more: String = "") -> String {
        #"{"artifactId":"\#(id)","artifactVersion":1,"poster":\#(poster ?? #"{"kind":"agent","agentId":"\#(agent)","taskId":"t1","botId":null}"#),"replyAgentId":"a1","audience":"owner","caption":"Live","media":{"artifactId":"m1","version":3,"path":"demo.mp4"},"postedAt":\#(at),"expiresAt":\#(at + 86_400_000),"state":"\#(state)","seenBy":[\#(seen ? #"{"userId":"u1","seenAt":1}"# : "")],"replies":2\#(more)}"#
    }

    private func make(_ stories: [String], gated: Bool = true) async -> (StoriesStore, StoryArtifactsTransport) {
        let transport = StoryArtifactsTransport(stories), (stream, continuation) = AsyncStream.makeStream(of: Store.ConversationEvent.self)
        self.continuation = continuation
        let store = StoriesStore(client: AgentClient(transport: transport, token: "t"), events: { stream }, offline: nil, now: { 1_755_400_000_000 }, firstReadDelay: .zero)
        await store.start()
        if gated { await store.gate(true, me: me) }
        return (store, transport)
    }

    private func changed(_ story: String) throws {
        continuation?.yield(.event(try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"story.changed","payload":{"story":\#(story)}}"#.utf8))))
    }

    private func next(_ store: StoriesStore, where condition: @escaping @Sendable (StoriesSnapshot) -> Bool) async throws -> StoriesSnapshot {
        try await withThrowingTaskGroup(of: StoriesSnapshot?.self) { [updates = store.updates] group in
            group.addTask { for await snapshot in updates where condition(snapshot) { return snapshot }; return nil }
            group.addTask { try await Task.sleep(for: .seconds(3)); return nil }
            defer { group.cancelAll() }
            let first = try await group.next()
            return try XCTUnwrap(first ?? nil)
        }
    }

    func testTheFeedIsMainsStoriesOneCirclePerPosterPeopleThenBotsThenTasks() throws {
        let bot = #"{"kind":"agent","agentId":"b1","botId":"health","name":"System Health"}"#, steve = #"{"kind":"user","userId":"steve"}"#
        let stories = try [story("s1", seen: true), story("s2", at: 1_755_400_100_000), story("s3", state: "replaced"), story("h1", poster: bot),
                           story("r1", poster: steve, more: #","round":{"path":"round.mp4"},"repostOf":"h1""#)].map { try JSONDecoder().decode(StoryArtifact.self, from: Data($0.utf8)) }
        let feed = StoryArtifacts.feed(stories, me: me, cursor: "c1")
        XCTAssertEqual(feed.authors.map { [$0.key, $0.name, $0.photo ?? ""] }, [["steve", "", ""], ["ring:b1", "System Health", "/v0/bots/health/avatar"], ["ring:a1", "", ""]])
        XCTAssertEqual(feed.rings?.last, StoryRing(agentId: "a1", storyIds: ["s1", "s2"], unseenCount: 1, latestPostedAt: 1_755_400_100_000))
        let s1 = try XCTUnwrap(feed.stories["s1"])
        XCTAssertEqual([s1.frames.first?.kind, s1.frames.first?.asset, s1.seen, s1.isArtifact, s1.source?.agentId] as [AnyHashable?],
                       [StoryFrame.Kind.video, StoryAsset.storyFile(artifactId: "m1", version: 3, path: "demo.mp4", own: false), true, true, "a1"])
        guard case .roundVideo(_, .file(let round), _, _, _) = feed.stories["r1"]?.frames.first?.overlays.first else { return XCTFail("no round video") }
        XCTAssertEqual(AgentClient.path(round), "/v0/artifacts/r1/versions/1/files/round.mp4?type=story")
        XCTAssertEqual(feed.stories["r1"]?.repostOf, StoryRepostOf(storyId: "h1", agentId: "b1", title: "System Health", canOpen: true))
    }

    func testARecordingArtifactsEntryPlaysAsAVideoNotAPage() async throws {
        let (store, _) = await make([story("s1").replacingOccurrences(of: #""media":{"artifactId":"m1","version":3,"path":"demo.mp4"}"#, with: #""media":{"artifactId":"m2","version":1}"#)])
        let frame = try await next(store) { $0.stories["s1"] != nil }.stories["s1"]?.frames.first
        XCTAssertEqual([frame?.kind, frame?.asset] as [AnyHashable?], [StoryFrame.Kind.video, StoryAsset.storyFile(artifactId: "m2", version: 1, path: "demo.mp4", own: false)])
    }

    func testSeeingTheLaterStoryLeavesTheEarlierNewAndAReplyCarriesReplyTo() async throws {
        let (store, transport) = await make([story("s1"), story("s2", at: 1_755_400_100_000)])
        _ = try await next(store) { $0.feed?.rings?.first?.unseenCount == 2 }
        await store.seen("s2")
        let seen = try await next(store) { $0.feed?.rings?.first?.unseenCount == 1 }
        XCTAssertEqual([seen.stories["s1"]?.seen, seen.stories["s2"]?.seen], [false, true])
        try await Task.sleep(for: .milliseconds(50))
        try await store.feedback("s1", frameId: "media", text: "ship it")
        let posted = await transport.requests.filter { $0.path.hasPrefix("POST") }
        XCTAssertEqual(posted.map(\.path), ["POST /v0/stories/s2/seen", "POST /v0/agents/a1/send"])
        let body = try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(posted.last?.body))
        XCTAssertEqual(body["replyTo"], .object(["kind": .string("story"), "artifactId": .string("s1")]))
        XCTAssertEqual([body["text"], body["mode"]?["providerId"]], [.string("ship it"), .string("codex")])
    }

    /// A change is shown from the event at once, a take-down even under an open viewer; the feed is read once after, for its order.
    func testAStoryChangedEventShowsAtOnceAndReadsTheFeedOnce() async throws {
        let (store, transport) = await make([story("s1")])
        _ = try await next(store) { $0.feed?.rings?.count == 1 }
        let before = await transport.paths().filter { $0 == "GET /v0/stories?scope=feed" }.count
        try changed(story("s9", agent: "a9", at: 1_755_400_200_000))
        _ = try await next(store) { $0.feed?.rings?.first?.agentId == "a9" }
        try await Task.sleep(for: .milliseconds(600))
        let reads = await transport.paths().filter { $0 == "GET /v0/stories?scope=feed" }.count
        XCTAssertEqual(reads, before + 1)
        await store.hold(true)
        try changed(story("s1", state: "taken_down"))
        _ = try await next(store) { $0.stories["s1"]?.status == .deleted }
        let after = await transport.paths().filter { $0 == "GET /v0/stories?scope=feed" }.count
        XCTAssertEqual(after, reads, "the row waits for the viewer; the story didn't")
    }

    /// Rich tasks off, or an older daemon: the store asks exactly what main's does.
    func testUngatedTheRequestsAreMainsExactly() async throws {
        let (store, transport) = await make([story("s1")], gated: false)
        _ = try await next(store) { $0.availability == .on && $0.live && !$0.artifacts }
        let paths = await transport.paths()
        XCTAssertEqual(paths.sorted(), ["GET /v0/health", "GET /v0/stickers/recents", "GET /v0/stories/feed", "GET /v0/user-settings/happy-desktop.experiments.stories"])
        await store.stop()
    }
}
