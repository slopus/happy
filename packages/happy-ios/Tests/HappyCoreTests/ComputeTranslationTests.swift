import Foundation
import XCTest
@testable import HappyCore

/// Settings › Compute's words (`TranslationCatalog.computeSources`) in every
/// language the app speaks.
final class ComputeTranslationTests: XCTestCase {
    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    private static func parameters(_ text: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: #"\$\{(\w+)\}"#)
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }.sorted()
    }

    /// Every language has every word with English's parameters, the
    /// products and systems keep their names, and only English is English.
    func testEveryLanguageHasTheWords() {
        let english = TranslationCatalog.computeSources["en"] ?? [:]
        XCTAssertEqual(Set(TranslationCatalog.computeSources.keys), Set(AppLanguage.supported.map(\.code)))
        XCTAssertEqual(english.count, 77)
        for language in AppLanguage.supported.map(\.code) {
            let words = TranslationCatalog.computeSources[language] ?? [:]
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(Set(words.keys), Set(english.keys), language)
            for (key, text) in words {
                XCTAssertTrue(key.hasPrefix("native.compute."), key)
                XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(language) \(key)")
                XCTAssertEqual(Self.parameters(text), Self.parameters(english[key] ?? ""), "\(language) \(key)")
                for name in ["Happy Cloud", "macOS", "Linux"] {
                    XCTAssertEqual(text.components(separatedBy: name).count, (english[key] ?? "").components(separatedBy: name).count, "\(language) \(key) says \(name) differently")
                }
                if Self.parameters(text).isEmpty { XCTAssertEqual(catalog(key), text, "\(language) \(key)") }
            }
            if language != "en" {
                for key in ["title", "computersNoteManage", "sharedDescription", "boundaryMissing", "concurrency", "installPrivate", "noAgents"] {
                    XCTAssertNotEqual(words["native.compute.\(key)"], english["native.compute.\(key)"], "\(language) \(key) is English")
                }
            }
        }
    }

    /// "N of C agents" takes the form `C` asks for in the language.
    func testAgentCountsAgreeWithTheConcurrency() {
        func agents(_ language: String, _ count: Int, of total: Int) -> String {
            TranslationCatalog.catalog(for: language)("native.compute.agents.\(TranslationCatalog.pluralCategory(language: language, count: total))",
                                                       ["count": .number(count), "total": .number(total)])
        }
        XCTAssertEqual(agents("en", 0, of: 1), "0 of 1 agent")
        XCTAssertEqual(agents("en", 2, of: 8), "2 of 8 agents")
        XCTAssertEqual(agents("ru", 1, of: 1), "1 из 1 агента")
        XCTAssertEqual(agents("ru", 2, of: 3), "2 из 3 агентов")
        XCTAssertEqual(agents("ru", 3, of: 21), "3 из 21 агента")
        XCTAssertEqual(agents("pl", 2, of: 8), "2 z 8 agentów")
        XCTAssertEqual(agents("ja", 2, of: 8), "2 / 8 エージェント")
        XCTAssertEqual(agents("zh-Hans", 1, of: 1), "1 / 1 个智能体")
        XCTAssertEqual(TranslationCatalog.catalog(for: "es")("native.compute.removeTitle", ["name": "Fix login"]), "¿Quitar «Fix login»?")
    }
}
