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

    /// Everything said in English, as the catalogs' English has it.
    private static func sayings(_ words: FeedWords) -> [String] {
        [
            words.activity, words.following, words.markAllRead, words.open, words.peek, words.empty, words.loading,
            words.unavailable, words.unsupported, words.everywhere, words.places, words.noClusters, words.loadingClusters,
            words.clustersUnavailable, words.peekEmpty, words.unreadMark, words.you, words.everything, words.team,
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
        XCTAssertEqual(written[17...18], ["Everything", "Team"])
        XCTAssertEqual(written[23...27], ["Created", "Created · 2 new versions", "1 new todo", "3 edits", "Changed"])
        XCTAssertEqual(written[28...30], ["Ann", "Ann and Bo", "Ann and 3 others"])
        XCTAssertEqual(written[31...], ["Muted", "Mute Research"])
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

    func testKinds() {
        XCTAssertEqual(FeedSubjectKind(subject: "task"), .task)
        XCTAssertEqual(FeedSubjectKind(subject: "bot"), .bot)
        XCTAssertEqual(FeedSubjectKind(subject: "artifact"), .artifact)
        XCTAssertEqual(FeedSubjectKind(subject: "surface", surfaceType: "document"), .document)
        XCTAssertEqual(FeedSubjectKind(subject: "surface", surfaceType: "todo"), .todoList)
        XCTAssertEqual(FeedSubjectKind(subject: "surface", surfaceType: "calendar"), .calendar)
        XCTAssertEqual(FeedSubjectKind(subject: "surface", surfaceType: "chat"), .surface)
        XCTAssertEqual(FeedSubjectKind(subject: "story"), .unknown)
    }

    func testActorsAreNamedAsTheyAreKnown() {
        let words = FeedWords.english
        XCTAssertEqual(words.actors(named: [.you], count: 1), "You")
        XCTAssertEqual(words.actors(named: [.named("Ann"), .you], count: 2), "Ann and You")
        // Those not known by name yet are counted, never given a stand-in.
        XCTAssertEqual(words.actors(named: [.named("Ann")], count: 3), "Ann and 2 others")
        XCTAssertEqual(words.actors(named: [], count: 2), "")
        XCTAssertEqual(words.name(FeedPlace.Name.everything), "Everything")
        XCTAssertEqual(words.name(FeedPlace.Name.named("Groceries")), "Groceries")
    }
}
