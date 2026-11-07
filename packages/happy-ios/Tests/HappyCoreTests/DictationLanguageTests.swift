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

    private func rank(keyboard: String? = nil, successful: String? = nil, preferred: [String] = ["en-US"], installed: [String] = []) -> [String] {
        DictationLanguage.ranked(keyboard: keyboard, successful: successful, preferred: preferred, installed: installed, supported: supported)
    }
}