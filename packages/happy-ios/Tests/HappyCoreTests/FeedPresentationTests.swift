import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The Feed's words in every language, its faces, and its row on home.
final class FeedPresentationTests: XCTestCase {
    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread, where these tests run.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    private static func item(_ subject: String, id: String = "x1", surfaceType: String? = nil, artifactType: String? = nil, created: Bool = false, updates: Int = 0, actors: [FeedActor] = [], count: Int? = nil, detail: String? = nil) -> FeedItem {
        FeedItem(
            id: "i", version: "v", cursor: "c", subject: FeedSubject(type: subject, id: id), created: created, updates: updates,
            actors: actors, actorCount: count, snapshot: FeedSnapshot(title: "T", surfaceType: surfaceType, artifactType: artifactType, detail: detail),
            firstAt: 1, lastAt: 1
        )
    }

    /// Everything said in English, as the catalogs' English has it.
    private static func sayings(_ words: FeedWords) -> [String] {
        [
            words.activity, words.following, words.markAllRead, words.open, words.peek, words.empty, words.loading,
            words.unavailable, words.unsupported, words.everywhere, words.places, words.noClusters, words.loadingClusters,
            words.clustersUnavailable, words.peekEmpty, words.unreadMark, words.you, words.anAgent, words.aPerson, words.untitled,
            words.follow("Research"), words.followFailed("Offline."), words.unread(1), words.unread(5),
            words.activity(created: true, updates: 0, kind: .task),
            words.activity(created: true, updates: 2, kind: .artifact),
            words.activity(created: false, updates: 1, kind: .todoList),
            words.activity(created: false, updates: 3, kind: .document),
            words.activity(created: false, updates: 0, kind: .bot),
            words.actors(["Ann"], count: 1), words.actors(["Ann", "Bo"], count: 2), words.actors(["Ann", "Bo"], count: 4),
            words.muted, words.mute("Research"),
        ]
    }

    func testEnglishIsTheCatalogsEnglish() {
        let written = Self.sayings(.english)
        XCTAssertEqual(written, Self.sayings(FeedWords(reading: .english)))
        XCTAssertEqual(written[24...28], ["Created", "Created · 2 new versions", "1 new todo", "3 edits", "Changed"])
        XCTAssertEqual(written[29...31], ["Ann", "Ann and Bo", "Ann and 3 others"])
        XCTAssertEqual(written[32...], ["Muted", "Mute Research"])
    }

    func testEveryLanguageSaysEverything() {
        for language in AppLanguage.supported.map(\.code) where language != "en" {
            let words = FeedWords(catalog: TranslationCatalog.catalog(for: language))
            XCTAssertEqual(words.language, language)
            for saying in Self.sayings(words) {
                XCTAssertFalse(saying.contains("native.feed"), "\(language): \(saying)")
                XCTAssertFalse(saying.contains("${"), "\(language): \(saying)")
            }
        }
    }

    func testCountsTakeTheirLanguagesForms() {
        let russian = FeedWords(catalog: TranslationCatalog.catalog(for: "ru"))
        XCTAssertEqual(russian.activity(created: false, updates: 1, kind: .task), "1 обновление")
        XCTAssertEqual(russian.activity(created: false, updates: 3, kind: .task), "3 обновления")
        XCTAssertEqual(russian.activity(created: false, updates: 5, kind: .task), "5 обновлений")
        XCTAssertEqual(russian.activity(created: false, updates: 21, kind: .task), "21 обновление")
        let japanese = FeedWords(catalog: TranslationCatalog.catalog(for: "ja"))
        XCTAssertEqual(japanese.activity(created: true, updates: 1, kind: .task), "作成 · 1 件の更新")
        XCTAssertEqual(FeedWords.pluralCategory(language: "pl", count: 22), "few")
        XCTAssertEqual(FeedWords.pluralCategory(language: "pl", count: 25), "many")
        XCTAssertEqual(FeedWords.pluralCategory(language: "zh-Hant", count: 1), "other")
        XCTAssertEqual(FeedWords.pluralCategory(language: "es", count: 1), "one")
    }

    func testTheSummaryIsTheChangesOwnWordsFirst() {
        let words = FeedWords.english
        XCTAssertEqual(words.summary(Self.item("surface", surfaceType: "todo", updates: 2, detail: " Buy\nmilk ")), "Buy milk")
        XCTAssertEqual(words.summary(Self.item("surface", surfaceType: "todo", updates: 2)), "2 new todos")
        XCTAssertEqual(words.summary(Self.item("artifact", created: true, updates: 1)), "Created · 1 new version")
    }

    func testKinds() {
        XCTAssertEqual(FeedSubjectKind(Self.item("task")), .task)
        XCTAssertEqual(FeedSubjectKind(Self.item("bot")), .bot)
        XCTAssertEqual(FeedSubjectKind(Self.item("artifact")), .artifact)
        XCTAssertEqual(FeedSubjectKind(Self.item("surface", surfaceType: "document")), .document)
        XCTAssertEqual(FeedSubjectKind(Self.item("surface", surfaceType: "todo")), .todoList)
        XCTAssertEqual(FeedSubjectKind(Self.item("surface", surfaceType: "calendar")), .calendar)
        XCTAssertEqual(FeedSubjectKind(Self.item("surface", surfaceType: "chat")), .surface)
        XCTAssertEqual(FeedSubjectKind(Self.item("story")), .unknown)
    }

    private func faces(userId: String? = "me", photo: String? = nil, people: [String: TeamUser] = [:]) -> FeedFaces {
        var bot = Row(id: "bot:b1", nodeId: "bot:b1", kind: .space, label: "Research", mark: .image(path: "/v0/bots/b1/avatar", thumbhash: "th"))
        bot.targetKind = "bot"
        bot.targetId = "b1"
        bot.agentId = "agent-b1"
        var task = Row(id: "task:t1", nodeId: "task:t1", kind: .space, label: "Fix it", mark: .none)
        task.targetKind = "task"
        task.targetId = "t1"
        task.agentId = "agent-t1"
        return FeedFaces(rows: [bot, task], userId: userId, photo: photo, personSeed: "person:seed", people: people)
    }

    func testASubjectWearsItsFaceOrItsKindsGlyph() {
        let faces = faces()
        XCTAssertEqual(faces.subject(Self.item("bot", id: "b1")), .mark(.image(path: "/v0/bots/b1/avatar", thumbhash: "th"), round: false))
        XCTAssertEqual(faces.subject(Self.item("task", id: "t1")), .mark(.placeholder(seed: "t1"), round: false), "no face of its own: its placeholder")
        XCTAssertEqual(faces.subject(Self.item("bot", id: "gone")), .mark(.placeholder(seed: "gone"), round: false))
        XCTAssertEqual(faces.subject(Self.item("artifact", artifactType: "html")), .tile(.artifact, artifactType: "html"))
        XCTAssertEqual(faces.subject(Self.item("surface", surfaceType: "todo")), .tile(.todoList, artifactType: nil))
    }

    func testAnActorIsAnAgentsFaceOrAPersonsRoundOne() {
        let faces = faces(photo: "mine", people: ["u2": TeamUser(id: "u2", name: "Bo", photo: nil)])
        XCTAssertEqual(faces.actor(FeedActor(agentId: "agent-b1")), .mark(.image(path: "/v0/bots/b1/avatar", thumbhash: "th"), round: false))
        XCTAssertEqual(faces.actor(FeedActor(agentId: "agent-x")), .mark(.placeholder(seed: "agent-x"), round: false))
        XCTAssertEqual(faces.actor(FeedActor(userId: "me")), .mark(.image(path: TeamUser.photoPath("me"), thumbhash: "mine"), round: true))
        XCTAssertEqual(faces.actor(FeedActor(userId: "u2")), .mark(.placeholder(seed: "u2"), round: true))
        XCTAssertEqual(faces.name(FeedActor(userId: "u2"), words: .english), "Bo")
        XCTAssertEqual(faces.name(FeedActor(userId: "me"), words: .english), "You")
        XCTAssertEqual(faces.name(FeedActor(agentId: "agent-b1"), words: .english), "Research")
        XCTAssertEqual(faces.name(FeedActor(agentId: "agent-x"), words: .english), "An agent")
        // Standalone: the one person, as their profile has them.
        let alone = self.faces(userId: nil)
        XCTAssertEqual(alone.actor(FeedActor()), .mark(.placeholder(seed: "person:seed"), round: true))
    }

    func testAPlaceWearsItsFaceOrItsKindsGlyph() {
        let faces = faces()
        XCTAssertEqual(faces.cluster(FeedCluster(cluster: "bot:b1", kind: "bot", name: "Research")), .mark(.image(path: "/v0/bots/b1/avatar", thumbhash: "th"), round: false))
        XCTAssertEqual(faces.cluster(FeedCluster(cluster: "*", kind: "everything", name: "Everything")), .clusterTile("everything"))
        XCTAssertEqual(faces.cluster(FeedCluster(cluster: "team", kind: "team", name: "Team")), .clusterTile("team"))
    }

    /// The item `@slopus/happy-agent-client`'s protocol test holds to its
    /// schema, read as the daemon sends it; a subject or snapshot field
    /// this phone doesn't know yet is read past.
    func testTheClientsProtocolItemDecodes() throws {
        let json = #"""
        {"id":"01991f3a-5c1e-7000-8000-2f9a1b3c4d5e","version":"01991f3b-0a1c-7000-8000-1b2c3d4e5f60",
         "cursor":"01991f3b-09f2-7000-8000-7a6b5c4d3e2f","subject":{"type":"artifact","id":"r7k2m9q4w1e5t8y3u6i0o2p5"},
         "cluster":"task:t4k8m2q9w1e5r7y3u6i0o2p4","created":true,"updates":49,
         "actors":[{"userId":null,"agentId":"a9b8c7d6e5f4g3h2i1j0k9l8"},{"userId":"u1x2y3z4a5b6c7d8e9f0g1h2","agentId":null}],
         "actorCount":2,"snapshot":{"title":"Q3 revenue report","agentId":"a9b8c7d6e5f4g3h2i1j0k9l8","artifactType":"markdown","artifactVersion":50,"color":"red"},
         "firstAt":1755300000000,"lastAt":1755400000000,"seenAt":null}
        """#
        let item = try JSONDecoder().decode(FeedItem.self, from: Data(json.utf8))
        XCTAssertEqual(item.subject, FeedSubject(type: "artifact", id: "r7k2m9q4w1e5t8y3u6i0o2p5"))
        XCTAssertEqual(item.actors, [FeedActor(agentId: "a9b8c7d6e5f4g3h2i1j0k9l8"), FeedActor(userId: "u1x2y3z4a5b6c7d8e9f0g1h2")])
        XCTAssertEqual(item.snapshot.artifactVersion, 50)
        XCTAssertTrue(item.open)
        XCTAssertEqual(FeedWords.english.summary(item), "Created · 49 new versions")
        let page = try JSONDecoder().decode(FeedPage.self, from: Data(#"{"items":[\#(json)],"unread":1,"hasMore":false,"cursor":"c9"}"#.utf8))
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.cursor, "c9")
        let peek = try JSONDecoder().decode(FeedPeek.self, from: Data(#"""
        {"cluster":{"cluster":"bot:b1","kind":"bot","name":"Research","state":null,"lastAt":1},
         "entries":[{"cursor":"c1","subject":{"type":"bot","id":"b1"},"cluster":"bot:b1","created":false,"updates":2,"actors":[],"actorCount":0,
                     "snapshot":{"title":"Research"},"firstAt":1,"lastAt":2}]}
        """#.utf8))
        XCTAssertEqual(peek.entries.first?.id, "bot:b1", "a peek's entry is known by its subject")
        XCTAssertEqual(peek.cluster.placeId, "b1")
    }
}
