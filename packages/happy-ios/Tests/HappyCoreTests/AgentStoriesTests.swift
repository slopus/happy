import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// Agents' stories (happy-agent `API.md` "Agent stories"): the new fields,
/// frames and overlays round trip as the spec writes them, rings stay live
/// off `story.*` events, and the sidebar draws them as sidebar v2's rows.
final class AgentStoriesTests: XCTestCase {
    static func agentStory(_ id: String, ring: String = "a1", agent: String = "a1", seen: Bool = false, postedAt: Int64 = 1_000, endedAt: Int64? = nil) -> String {
        """
        {"id":"\(id)","status":"posted","authorUserId":"u1","createdBy":{"kind":"agent","agentId":"\(agent)"},"source":{"agentId":"\(agent)","toolCallId":"t"},"caption":"Shipped",\
        "frames":[{"id":"f-\(id)","kind":"artifact","width":null,"height":null,"thumbhash":null,"durationMs":null,"asset":{"type":"artifact","artifactId":"art1"},\
        "available":true,"placement":{"x":0.5,"y":0.5,"scale":1,"rotation":0},"background":["#000000","#000000"],\
        "overlays":[{"id":"o1","type":"artifact","artifactId":"art2","version":3,"aspectRatio":0.8,"transform":{"x":0.5,"y":0.4,"scale":0.8,"rotation":0}}]}],\
        "audience":"self","artifactVersion":1,"createdAt":1,"updatedAt":1,"postedAt":\(postedAt),"expiresAt":null,"seen":\(seen),"viewCount":null,\
        "myReaction":null,"reactions":[],"version":"v1","author":{"kind":"agent","agentId":"\(agent)"},"ringAgentId":"\(ring)","supersedes":[],\
        "endedAt":\(endedAt.map(String.init) ?? "null"),"endReason":\(endedAt == nil ? "null" : "\"superseded\""),"repostOf":null}
        """
    }

    static func ringFeed(_ rings: [(String, [String], Int)], stories: [String: String]) -> String {
        let list = rings.map { ring in
            #"{"agentId":"\#(ring.0)","storyIds":[\#(ring.1.map { "\"\($0)\"" }.joined(separator: ","))],"unseenCount":\#(ring.2),"latestPostedAt":1000}"#
        }.joined(separator: ",")
        let map = stories.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",")
        let me = StoriesSamples.author("u1", name: "Kirill Dubovitskiy", isSelf: true, storyIds: [], unseen: 0, drafts: 0)
        return #"{"authors":[\#(me)],"rings":[\#(list)],"stories":{\#(map)},"cursor":"c1"}"#
    }

    private func json(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }

    private func roundTrips<T: Codable>(_ type: T.Type, _ text: String, file: StaticString = #filePath, line: UInt = #line) throws -> T {
        let decoded = try JSONDecoder().decode(T.self, from: Data(text.utf8))
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(decoded)), try json(text), file: file, line: line)
        return decoded
    }

    // MARK: Wire

    func testAnAgentsStoryRoundTrips() throws {
        let story = try roundTrips(Story.self, Self.agentStory("s1"))
        XCTAssertEqual(story.author, .agent(agentId: "a1"))
        XCTAssertEqual(story.ringAgentId, "a1")
        XCTAssertTrue(story.isAgents)
        XCTAssertEqual(story.frames[0].kind, .artifact)
        XCTAssertEqual(story.frames[0].asset, .artifact(artifactId: "art1", version: nil))
        XCTAssertEqual(story.frames[0].overlays[0], .artifact(id: "o1", artifactId: "art2", version: 3, aspectRatio: 0.8, transform: StoryTransform(x: 0.5, y: 0.4, scale: 0.8, rotation: 0)))
        // Ten seconds of untouched time.
        XCTAssertEqual(story.frames[0].showMs, 10_000)
    }

    func testAnOlderDaemonsStoryHasNoneOfTheNewFields() throws {
        let story = try roundTrips(Story.self, StoriesSamples.story("s1"))
        XCTAssertNil(story.author)
        XCTAssertFalse(story.isAgents)
    }

    func testARepostCarriesWhereItCameFrom() throws {
        var text = Self.agentStory("s2")
        text = text.replacingOccurrences(of: #""author":{"kind":"agent","agentId":"a1"}"#, with: #""author":{"kind":"user","userId":"u1"}"#)
        text = text.replacingOccurrences(of: #""ringAgentId":"a1""#, with: #""ringAgentId":null"#)
        text = text.replacingOccurrences(of: #""repostOf":null"#, with: #""repostOf":{"storyId":"s1","agentId":"a1","title":"Inline sidebar diffs","canOpen":true}"#)
        let story = try roundTrips(Story.self, text)
        XCTAssertFalse(story.isAgents)
        XCTAssertEqual(story.repostOf, StoryRepostOf(storyId: "s1", agentId: "a1", title: "Inline sidebar diffs", canOpen: true))
    }

    func testARoundVideoReadsAsAFileAndWritesAsAnUpload() throws {
        let read = try roundTrips(StoryOverlay.self, #"{"id":"r1","type":"round_video","media":{"type":"artifact_file","artifactId":"s1","version":2,"path":"media/r1.mp4"},"durationMs":4200,"mirrored":true,"transform":{"x":0.2,"y":0.8,"scale":0.3,"rotation":0}}"#)
        XCTAssertEqual(read, .roundVideo(id: "r1", media: .file(.artifactFile(artifactId: "s1", version: 2, path: "media/r1.mp4")), durationMs: 4200, mirrored: true, transform: StoryTransform(x: 0.2, y: 0.8, scale: 0.3, rotation: 0)))
        _ = try roundTrips(StoryOverlay.self, #"{"id":"r2","type":"round_video","media":{"type":"upload","uploadId":"up1","name":"round.mp4"},"durationMs":900,"transform":{"x":0.5,"y":0.5,"scale":0.3,"rotation":0}}"#)
        // A window's shape defaults to 0.8 when a write leaves it out.
        let window = try JSONDecoder().decode(StoryOverlay.self, from: Data(#"{"id":"w","type":"artifact","artifactId":"a","transform":{"x":0.5,"y":0.5,"scale":1,"rotation":0}}"#.utf8))
        guard case .artifact(_, _, nil, let ratio, _) = window else { return XCTFail() }
        XCTAssertEqual(ratio, 0.8)
    }

    func testAFrameStaysUpWhileItsRoundVideoPlays() {
        let frame = StoryFrame(id: "f", kind: .image, width: 1, height: 1, thumbhash: nil, durationMs: nil, asset: .chatMedia(agentId: "a", toolCallId: "t", index: 0), available: true,
                               overlays: [.roundVideo(id: "r", media: .upload(uploadId: "u", name: "r.mp4"), durationMs: 12_000, mirrored: nil, transform: .fitted)])
        XCTAssertEqual(frame.showMs, 12_000)
        XCTAssertEqual(frame.roundVideoMs, 12_000)
    }

    func testTheFeedKeepsItsRings() throws {
        let feed = try roundTrips(StoryFeed.self, Self.ringFeed([("a1", ["s1"], 1)], stories: ["s1": Self.agentStory("s1")]))
        XCTAssertEqual(feed.rings, [StoryRing(agentId: "a1", storyIds: ["s1"], unseenCount: 1, latestPostedAt: 1000)])
        // An older daemon's feed has no rings, and writes none back.
        let old = try roundTrips(StoryFeed.self, StoriesSamples.feed([], stories: [:]))
        XCTAssertNil(old.rings)
        XCTAssertNil(StoriesRow.rings(old))
    }

    func testAStatusLineArrivesOnTheAgent() throws {
        let agent = try JSONDecoder().decode(AgentWire.Agent.self, from: Data(#"{"id":"a1","workspaceId":"w","status":"idle","statusLine":{"text":"Testing with a few friends","updatedAt":1}}"#.utf8))
        XCTAssertEqual(agent.statusLine?.text, "Testing with a few friends")
    }

    func testARingPlaysAsOneAuthor() {
        let author = StoriesRow.ringAuthor(StoryRing(agentId: "a1", storyIds: ["s1", "s2"], unseenCount: 1, latestPostedAt: 5), name: "Inline sidebar diffs")
        XCTAssertEqual(author.ringAgentId, "a1")
        XCTAssertEqual(author.key, "ring:a1")
        XCTAssertFalse(author.isSelf)
        XCTAssertNil(StoryFeedAuthor(userId: "u9", name: "S", photo: nil, thumbhash: nil, isSelf: false, storyIds: [], unseenCount: 0, draftCount: nil, latestPostedAt: nil).ringAgentId)
    }

    // MARK: Store

    private var continuation: AsyncStream<StemCellsStore.ConversationEvent>.Continuation?

    private func make(_ transport: StoriesTransport) -> StoriesStore {
        let (stream, continuation) = AsyncStream.makeStream(of: StemCellsStore.ConversationEvent.self)
        self.continuation = continuation
        return StoriesStore(client: DirectAgentClient(transport: transport, token: "t"), events: { stream }, offline: nil, now: { 2_000 }, firstReadDelay: .zero)
    }

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

    private func loaded(_ feed: String) async throws -> StoriesStore {
        let transport = StoriesTransport()
        await transport.configure(feed: feed)
        let store = make(transport)
        await store.start()
        _ = try await next(store) { $0.feed != nil }
        return store
    }

    func testAPostedAgentsStoryJoinsTheEndOfItsRingUnseen() async throws {
        let store = try await loaded(Self.ringFeed([("a1", ["s1"], 1)], stories: ["s1": Self.agentStory("s1")]))
        // A subtask's story rolls up into its task's ring; it never makes a circle.
        event("story.posted", #"{"story":\#(Self.agentStory("s2", agent: "sub1", postedAt: 1_500))}"#)
        let snapshot = try await next(store) { $0.feed?.rings?.first?.storyIds.count == 2 }
        XCTAssertEqual(snapshot.feed?.rings, [StoryRing(agentId: "a1", storyIds: ["s1", "s2"], unseenCount: 2, latestPostedAt: 1_500)])
        XCTAssertEqual(snapshot.feed?.authors.count, 1)
        // A new ring goes first.
        event("story.posted", #"{"story":\#(Self.agentStory("s3", ring: "b1", agent: "b1", postedAt: 1_600))}"#)
        let two = try await next(store) { $0.feed?.rings?.count == 2 }
        XCTAssertEqual(two.feed?.rings?.map(\.agentId), ["b1", "a1"])
    }

    func testAnEndedStoryLeavesItsRingAndAnEmptyRingGoes() async throws {
        let store = try await loaded(Self.ringFeed([("a1", ["s1", "s2"], 2)], stories: ["s1": Self.agentStory("s1"), "s2": Self.agentStory("s2", postedAt: 1_500)]))
        event("story.ended", #"{"storyId":"s1","version":"v2","ringAgentId":"a1","endedAt":1600,"endReason":"superseded","story":\#(Self.agentStory("s1", endedAt: 1_600).replacingOccurrences(of: #""version":"v1""#, with: #""version":"v2""#))}"#)
        let one = try await next(store) { $0.feed?.rings?.first?.storyIds == ["s2"] }
        XCTAssertEqual(one.feed?.rings?.first?.unseenCount, 1)
        // Ended, it stays readable.
        XCTAssertEqual(one.stories["s1"]?.endedAt, 1_600)
        event("story.deleted", #"{"storyId":"s2","version":"v2"}"#)
        let none = try await next(store) { $0.feed?.rings?.isEmpty == true }
        XCTAssertEqual(none.feed?.rings, [])
    }

    func testSeeingOneStoryOfARingMarksItsEarlierOnesOnly() async throws {
        let store = try await loaded(Self.ringFeed([("a1", ["s1", "s2"], 2), ("b1", ["s3"], 1)], stories: [
            "s1": Self.agentStory("s1", postedAt: 1_000), "s2": Self.agentStory("s2", postedAt: 1_500), "s3": Self.agentStory("s3", ring: "b1", agent: "b1", postedAt: 900),
        ]))
        event("story.seen", #"{"authorUserId":"u1","storyId":"s1","ringAgentId":"a1"}"#)
        let snapshot = try await next(store) { $0.feed?.rings?.first { $0.agentId == "a1" }?.unseenCount == 1 }
        // Another ring by the same person is untouched.
        XCTAssertEqual(snapshot.feed?.rings?.first { $0.agentId == "b1" }?.unseenCount, 1)
        XCTAssertEqual(snapshot.stories["s3"]?.seen, false)
    }

    // MARK: Repost

    func testARoundVideoIsUploadedOnSaveAndOneToAFrame() throws {
        var draft = StoryDraft(editing: try JSONDecoder().decode(Story.self, from: Data(Self.agentStory("s1").utf8)))
        let file = URL(fileURLWithPath: "/tmp/round-1.mov")
        XCTAssertTrue(draft.setRoundVideo(id: "r1", file: file, durationMs: 4_200, mirrored: true, transform: StoryTransform(x: 0.2, y: 0.8, scale: 0.3, rotation: 0)))
        // A second recording replaces the first.
        XCTAssertTrue(draft.setRoundVideo(id: "r2", file: URL(fileURLWithPath: "/tmp/round-2.mp4"), durationMs: 90_000, mirrored: false, transform: StoryTransform(x: 0.2, y: 0.8, scale: 0.3, rotation: 0)))
        XCTAssertEqual(draft.uploads.map(\.frameId), ["r2"])
        XCTAssertEqual(draft.uploads.first?.name, "round.mp4")
        XCTAssertThrowsError(try draft.inputs(uploaded: [:]))
        let inputs = try draft.inputs(uploaded: ["r2": "up9"])
        let round = inputs[0].overlays?.last
        XCTAssertEqual(round, .roundVideo(id: "r2", media: .upload(uploadId: "up9", name: "round.mp4"), durationMs: 60_000, mirrored: nil, transform: StoryTransform(x: 0.2, y: 0.8, scale: 0.3, rotation: 0)))
        // The artifact window it had stays, as read.
        XCTAssertEqual(inputs[0].overlays?.count, 2)
        // The preview carries where a repost came from.
        XCTAssertEqual(draft.preview(draft.frames[0]).0.author, .agent(agentId: "a1"))
    }

    // MARK: Rows

    func testRowsWearTheirRingsOnlyWhileAgentStoriesAreOn() {
        var task = StemCellsRow(id: "space:1", nodeId: "1", kind: .space, label: "Stories", status: .working, agentId: "a1")
        task.hasAgent = true
        task.statusLine = "Testing with a few friends"
        let session = StemCellsRow(id: "session:sub", nodeId: "sub", kind: .session, depth: 1, label: "Sub", status: .awaitingInput, agentId: "sub")
        let section = StemCellsRow(id: "s", nodeId: "s", kind: .section, label: "Priority")
        let rows = [section, task, session]
        // Off: untouched.
        XCTAssertEqual(StemCellsRows.withStories(rows, rings: nil), rows)
        let on = StemCellsRows.withStories(rows, rings: ["a1": StoryRing(agentId: "a1", storyIds: ["s1", "s2", "s3", "s4"], unseenCount: 2, latestPostedAt: nil), "sub": StoryRing(agentId: "sub", storyIds: ["x"], unseenCount: 1, latestPostedAt: nil)])
        XCTAssertNil(on[0].story)
        XCTAssertEqual(on[1].story, StemCellsRow.StoryRowState(segments: 4, unseen: 2))
        // A session row is a story row without a ring.
        XCTAssertEqual(on[2].story, StemCellsRow.StoryRowState(segments: 0, unseen: 0))
        // One signal, in the corner; nothing in the trailing square.
        XCTAssertEqual(on[1].corner, .bar)
        XCTAssertEqual(on[2].corner, .dot)
        XCTAssertFalse(on[2].hasTrailingMark)
        XCTAssertTrue(rows[2].hasTrailingMark)
        var waiting = task
        waiting.status = .waiting
        XCTAssertEqual(waiting.corner, .none)
    }
}
