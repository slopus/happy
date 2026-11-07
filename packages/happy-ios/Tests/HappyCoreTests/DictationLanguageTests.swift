import XCTest
@testable import HappyCore

final class DictationLanguageTests: XCTestCase {
    private let supported = ["en-US", "en-GB", "ru-RU", "de-DE"]

    func testKeyboardWinsOverEnglishSystemAndPreviousSuccess() {
        XCTAssertEqual(rank(keyboard: "ru", successful: "de-DE"), ["ru-RU", "de-DE", "en-US"])
    }

    func testSuccessWinsWithoutKeyboard() {
        XCTAssertEqual(rank(successful: "ru-RU"), ["ru-RU", "en-US"])
    }

    func testUnsupportedKeyboardFallsThroughToSystemOrder() {
        XCTAssertEqual(rank(keyboard: "xx", preferred: ["de-DE", "ru-RU"]), ["de-DE", "ru-RU", "en-US"])
    }

    func testBareKeyboardUsesPreferredRegion() {
        XCTAssertEqual(rank(keyboard: "en", preferred: ["en-GB"]), ["en-GB", "en-US"])
    }

    func testInstalledKeyboardsAndEmoji() {
        XCTAssertEqual(rank(keyboard: "emoji", installed: ["emoji", "ru-RU", "de-DE"]), ["en-US", "ru-RU", "de-DE"])
    }

    func testCanonicalIdentifiersDeduplicate() {
        XCTAssertEqual(rank(keyboard: "ru_RU", successful: "ru-RU", preferred: ["ru"]), ["ru-RU", "en-US"])
    }

    func testNoArbitraryUnsupportedFallback() {
        XCTAssertEqual(DictationLanguage.ranked(keyboard: "ru", successful: nil, preferred: [], installed: [], supported: ["de-DE"]), [])
    }

    func testExplicitChineseScriptsDoNotCross() {
        XCTAssertEqual(DictationLanguage.ranked(keyboard: "zh-Hant", successful: nil, preferred: [], installed: [], supported: ["zh-Hans-CN", "zh-Hant-TW"]), ["zh-Hant-TW"])
    }

    func testProbesTakeTheNextDifferentLanguage() {
        XCTAssertEqual(DictationLanguage.probes(["en-GB", "en-US", "ru-RU", "de-DE"]), ["en-GB", "ru-RU"])
        XCTAssertEqual(DictationLanguage.probes(["ru_RU", "en_US"]), ["ru_RU", "en_US"])
        XCTAssertEqual(DictationLanguage.probes(["en-US", "en-GB"]), ["en-US"])
        XCTAssertEqual(DictationLanguage.probes([]), [])
    }

    /// Readings measured on macOS 27 from `say` clips (Milena, Samantha).
    func testChooseFollowsTheSpokenLanguage() {
        let russian = [reading("en-US", "Previous pagoda", 0.29), reading("ru-RU", "Привет как дела сегодня хорошая погода", 0.98)]
        XCTAssertEqual(DictationLanguage.choose(russian)?.locale, "ru-RU")
        let english = [reading("ru-RU", "Hello how are you to where is nice today", 0.40), reading("en-US", "Hello, how are you? The weather is nice today.", 0.98)]
        XCTAssertEqual(DictationLanguage.choose(english)?.locale, "en-US")
    }

    func testChooseKeepsThePreferredLanguageWhenClose() {
        XCTAssertEqual(DictationLanguage.choose([reading("ru-RU", "да", 0.70), reading("en-US", "da", 0.80)])?.locale, "ru-RU")
    }

    func testChooseIgnoresEmptyReadings() {
        XCTAssertEqual(DictationLanguage.choose([reading("ru-RU", " ", 0.99), reading("en-US", "hi", 0.30)])?.locale, "en-US")
        XCTAssertNil(DictationLanguage.choose([reading("ru-RU", "", 0)]))
        XCTAssertNil(DictationLanguage.choose([]))
    }

    private func reading(_ locale: String, _ text: String, _ confidence: Double) -> DictationLanguage.Reading {
        .init(locale: locale, text: text, confidence: confidence)
    }

    private func rank(keyboard: String? = nil, successful: String? = nil, preferred: [String] = ["en-US"], installed: [String] = []) -> [String] {
        DictationLanguage.ranked(keyboard: keyboard, successful: successful, preferred: preferred, installed: installed, supported: supported)
    }
}