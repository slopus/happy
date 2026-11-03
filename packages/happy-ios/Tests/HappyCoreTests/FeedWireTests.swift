import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The Feed's wire as current daemons send it, references only (API.md
/// "Showing an entry", `@slopus/happy-agent-client` `protocol/feed.ts`),
/// and as the first Feed daemons (0.4.111) sent it, with a `snapshot` on
/// every entry and a `name` on every cluster, which are never read.
final class FeedWireTests: XCTestCase {
    /// `GET /v0/feed` as the client's fixture has it.
    static let page = #"""
    {"items":[{"id":"01991f3a-5c1e-7000-8000-2f9a1b3c4d5e","version":"01991f3b-0a1c-7000-8000-1b2c3d4e5f60",
      "cursor":"01991f3b-09f2-7000-8000-7a6b5c4d3e2f","subject":{"type":"surface","id":"s4k8m2q9w1e5r7y3u6i0o2p4"},
      "cluster":"surface:s4k8m2q9w1e5r7y3u6i0o2p4","created":false,"updates":3,
      "actors":[{"userId":null,"agentId":"a9b8c7d6e5f4g3h2i1j0k9l8"}],"actorCount":1,
      "latest":{"type":"todo.created","todoId":"t9k8m2q9w1e5r7y3u6i0o2p4"},
      "firstAt":1755300000000,"lastAt":1755400000000,"seenAt":null}],
     "unread":1,"hasMore":false,"cursor":"01991f3a-6d2f-7000-8000-3a0b2c4d5e6f"}
    """#

    func testAnEntryWithNoSnapshotDecodes() throws {
        let page = try JSONDecoder().decode(FeedPage.self, from: Data(Self.page.utf8))
        XCTAssertEqual(page.items.count, 1)
        let item = try XCTUnwrap(page.items.first)
        XCTAssertEqual(item.subject, FeedSubject(type: "surface", id: "s4k8m2q9w1e5r7y3u6i0o2p4"))
        XCTAssertEqual(item.latest, FeedLatest(type: "todo.created", todoId: "t9k8m2q9w1e5r7y3u6i0o2p4"))
        XCTAssertEqual(item.updates, 3)
        XCTAssertEqual(item.actors, [FeedActor(agentId: "a9b8c7d6e5f4g3h2i1j0k9l8")])
        XCTAssertTrue(item.open)
        XCTAssertEqual(page.unread, 1)
        XCTAssertEqual(page.cursor, "01991f3a-6d2f-7000-8000-3a0b2c4d5e6f")
    }

    func testEveryKindOfLatestDecodes() throws {
        func latest(_ json: String) throws -> FeedLatest? {
            let item = #"{"id":"i","version":"v","cursor":"c","subject":{"type":"task","id":"t"},"latest":\#(json)}"#
            return try JSONDecoder().decode(FeedItem.self, from: Data(item.utf8)).latest
        }
        XCTAssertEqual(try latest(#"{"type":"task.created"}"#), FeedLatest(type: "task.created"))
        XCTAssertEqual(try latest(#"{"type":"document.edited","seq":42}"#), FeedLatest(type: "document.edited", seq: 42))
        XCTAssertEqual(try latest(#"{"type":"artifact.updated","artifactVersion":50}"#), FeedLatest(type: "artifact.updated", artifactVersion: 50))
        // A type this phone doesn't know is a change with nothing more to say.
        XCTAssertEqual(try latest(#"{"type":"story.posted","storyId":"s1"}"#), FeedLatest(type: "story.posted"))
        // One it can't read at all costs only itself, never the entry.
        XCTAssertNil(try latest(#"{"todoId":"t1"}"#))
        XCTAssertNil(try latest("7"))
    }

    /// The first Feed daemons' entry, a snapshot and all: it decodes, the
    /// snapshot is read past, and nothing of it is kept.
    func testAFirstDaemonsEntryDecodesAndItsSnapshotIsNeverKept() throws {
        let json = #"""
        {"id":"01991f3a-5c1e-7000-8000-2f9a1b3c4d5e","version":"01991f3b-0a1c-7000-8000-1b2c3d4e5f60",
         "cursor":"01991f3b-09f2-7000-8000-7a6b5c4d3e2f","subject":{"type":"task","id":"t4k8m2q9w1e5r7y3u6i0o2p4"},
         "cluster":"task:t4k8m2q9w1e5r7y3u6i0o2p4","created":true,"updates":0,
         "actors":[{"userId":"u1","agentId":null}],"actorCount":1,
         "snapshot":{"title":"New Task","agentId":"a9b8c7d6e5f4g3h2i1j0k9l8"},
         "firstAt":1755300000000,"lastAt":1755400000000,"seenAt":null}
        """#
        let item = try JSONDecoder().decode(FeedItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.subject.id, "t4k8m2q9w1e5r7y3u6i0o2p4")
        XCTAssertNil(item.latest, "the first daemons send no latest")
        let kept = String(data: try JSONEncoder().encode(item), encoding: .utf8) ?? ""
        XCTAssertFalse(kept.contains("snapshot"))
        XCTAssertFalse(kept.contains("New Task"))
    }

    /// A feed this phone kept under an earlier build, snapshots and people
    /// in it, opens as references.
    func testAFeedKeptByAnEarlierBuildOpens() async throws {
        let keep = MemoryFeedKeep()
        let kept = #"""
        {"available":true,"unread":1,"hasMore":false,
         "items":[{"id":"i1","version":"v1","cursor":"c1","subject":{"type":"task","id":"t1"},"cluster":"team","created":true,"updates":0,
                   "actors":[],"actorCount":0,"snapshot":{"title":"New Task","agentId":"a1"},"firstAt":1,"lastAt":1}],
         "people":[{"id":"u1","name":"Ann"}]}
        """#
        await keep.write(FeedLibrary.resource, try JSONDecoder().decode(JSONValue.self, from: Data(kept.utf8)))
        let library = FeedLibrary(routes: FakeFeedServer(), outbox: IntentOutbox(storage: MemoryIntentStorage(), deliver: { _ in }), keep: keep)
        await library.start()
        let state = await library.current
        XCTAssertEqual(state.items.map(\.subject), [FeedSubject(type: "task", id: "t1")])
        XCTAssertEqual(state.unread, 1)
    }

    /// Clusters are references only: no name, and one that sends a name
    /// has it read past. Without a kind, the name says it.
    func testClustersWithNoNameDecode() throws {
        struct Answer: Decodable { var clusters: [Lossy<FeedCluster>] }
        let json = #"""
        {"clusters":[{"cluster":"*","kind":"everything","state":"subscribed","lastAt":1},
                     {"cluster":"team","kind":"team","state":null,"lastAt":null},
                     {"cluster":"task:t1","kind":"task","state":"muted","lastAt":2},
                     {"cluster":"project:p1","state":null},
                     {"cluster":"bot:b1","kind":"bot","name":"Research","state":null,"lastAt":3}]}
        """#
        let clusters = try JSONDecoder().decode(Answer.self, from: Data(json.utf8)).clusters.compactMap(\.value)
        XCTAssertEqual(clusters.map(\.cluster), ["*", "team", "task:t1", "project:p1", "bot:b1"])
        XCTAssertEqual(clusters.map(\.kind), ["everything", "team", "task", "project", "bot"])
        XCTAssertEqual(clusters[2].state, "muted")
        XCTAssertEqual(clusters[3].placeId, "p1")
    }

    func testAPeekWithNoNamesDecodes() throws {
        let peek = try JSONDecoder().decode(FeedPeek.self, from: Data(#"""
        {"cluster":{"cluster":"task:t4k8m2q9w1e5r7y3u6i0o2p4","kind":"task","state":null,"lastAt":1755400000000},
         "entries":[{"cursor":"01991f3b-09f2-7000-8000-7a6b5c4d3e2f","subject":{"type":"task","id":"t4k8m2q9w1e5r7y3u6i0o2p4"},
                     "cluster":"task:t4k8m2q9w1e5r7y3u6i0o2p4","created":true,"updates":0,"actors":[],"actorCount":0,
                     "latest":{"type":"task.created"},"firstAt":1,"lastAt":2}]}
        """#.utf8))
        XCTAssertEqual(peek.cluster?.placeId, "t4k8m2q9w1e5r7y3u6i0o2p4")
        XCTAssertEqual(peek.entries.first?.id, "task:t4k8m2q9w1e5r7y3u6i0o2p4", "a peek's entry is known by its subject")
        // A cluster it can't read leaves the entries.
        let bare = try JSONDecoder().decode(FeedPeek.self, from: Data(#"{"cluster":{"kind":"task"},"entries":[]}"#.utf8))
        XCTAssertNil(bare.cluster)
    }

    func testTheSeenAnswerAndAnEventDecodeWithNoSnapshot() throws {
        let answer = try JSONDecoder().decode(FeedSeenAnswer.self, from: Data(#"""
        {"items":[{"id":"i","version":"v2","cursor":"c","subject":{"type":"bot","id":"b"},"latest":{"type":"bot.created"},"seenAt":5}],"unread":0}
        """#.utf8))
        XCTAssertEqual(answer.items.first?.seenAt, 5)
        XCTAssertEqual(answer.unread, 0)
        let event: JSONValue = ["type": "feed.item.created", "cursor": "e1", "payload": ["item": [
            "id": "i", "version": "v", "cursor": "c", "subject": ["type": "artifact", "id": "r1"],
            "latest": ["type": "artifact.updated", "artifactVersion": 3], "firstAt": 1, "lastAt": 2,
        ]]]
        let items = FeedLibrary.decode(.array([event["payload"]?["item"] ?? .null]))
        XCTAssertEqual(items.first?.latest?.artifactVersion, 3)
    }
}
