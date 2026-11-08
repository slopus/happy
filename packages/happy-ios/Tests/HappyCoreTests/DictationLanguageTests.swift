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

    /// Settled stretches as DictationTranscriber gave them for the Russian
    /// clip, read as Russian (0) and English (1).
    func testProbeChoosesOnceBothHaveSettledEnough() {
        var probe = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertEqual(probe.shown, 0)
        XCTAssertNil(probe.settle(1, confidence: 0.09, characters: 26))
        XCTAssertNil(probe.winner, "Russian hasn't settled anything yet")
        XCTAssertEqual(probe.settle(0, confidence: 0.90, characters: 62), 0)
        XCTAssertEqual(probe.shown, 0)
        XCTAssertFalse(probe.listens(to: 1))
        XCTAssertNil(probe.settle(1, confidence: 0.99, characters: 100), "a decided probe stays decided")
        XCTAssertEqual(probe.finish(texts: ["а", "b"]), 0)
    }

    func testProbeSwitchesToTheSecondLanguage() {
        var probe = DictationLanguage.Probe(locales: ["de-DE", "en-US"])
        XCTAssertNil(probe.settle(0, confidence: 0.37, characters: 51))
        XCTAssertEqual(probe.settle(1, confidence: 0.97, characters: 67), 1)
        XCTAssertEqual(probe.shown, 1)
        XCTAssertTrue(probe.listens(to: 1))
        XCTAssertFalse(probe.listens(to: 0))
    }

    func testProbeWaitsOnACloseCallAndTooLittle() {
        var probe = DictationLanguage.Probe(locales: ["de-DE", "en-US"])
        XCTAssertNil(probe.settle(0, confidence: 0.83, characters: 72))
        XCTAssertNil(probe.settle(1, confidence: 0.93, characters: 68), "0.10 apart is not clear")
        var short = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertNil(short.settle(0, confidence: 0.2, characters: 3))
        XCTAssertNil(short.settle(1, confidence: 0.9, characters: 5))
        XCTAssertEqual(short.finish(texts: ["да", "Yes."]), 1, "at the end a clear lead still wins")
    }

    func testProbeMeansAreWeightedByCharacters() {
        var probe = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        _ = probe.settle(0, confidence: 1.0, characters: 30)
        _ = probe.settle(0, confidence: 0.4, characters: 10)
        XCTAssertEqual(probe.confidence(of: 0), 0.85, accuracy: 0.0001)
        XCTAssertEqual(probe.confidence(of: 1), 0)
    }

    func testProbeFinishKeepsTheFirstOnACloseCallOrSilence() {
        var close = DictationLanguage.Probe(locales: ["de-DE", "en-US"])
        _ = close.settle(0, confidence: 0.83, characters: 72)
        _ = close.settle(1, confidence: 0.93, characters: 68)
        XCTAssertEqual(close.finish(texts: ["Please open", "Please open"]), 0)
        var silent = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertEqual(silent.finish(texts: ["", ""]), 0)
        var onlySecond = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertEqual(onlySecond.finish(texts: ["", "Hi"]), 1)
    }

    /// The first pause of the Russian `say` recording, read as English (1)
    /// and Russian (0): English heard only "At grand".
    func testProbeLeaderNeedsEnoughTheOtherOnlyToHaveSettled() {
        var probe = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertNil(probe.settle(1, confidence: 0.03, characters: 8))
        XCTAssertEqual(probe.settle(0, confidence: 0.73, characters: 55), 0)
        var silent = DictationLanguage.Probe(locales: ["ru-RU", "en-US"])
        XCTAssertNil(silent.settle(1, confidence: 0, characters: 0))
        XCTAssertEqual(silent.settle(0, confidence: 0.73, characters: 55), 0)
    }

    func testProbeWaitsForEveryCandidateToSettle() {
        var probe = DictationLanguage.Probe(locales: ["en-US", "ru-RU"])
        XCTAssertNil(probe.settle(0, confidence: 0.22, characters: 42), "the right one's reading hasn't come")
        XCTAssertEqual(probe.settle(1, confidence: 0.93, characters: 70), 1)
    }

    func testPausesSettleALittleIntoTheFirstLongQuiet() {
        var pauses = DictationLanguage.Pauses()
        var found: [Double] = []
        func hear(_ level: Float, seconds: Double) {
            for _ in 0..<Int((seconds / 0.05).rounded()) {
                if let time = pauses.hear(level: level, duration: 0.05) { found.append(time) }
            }
        }
        hear(0.001, seconds: 0.5)   // the room before speaking: no pause
        hear(0.2, seconds: 0.6)
        hear(0.002, seconds: 0.5)   // too little speech yet
        hear(0.2, seconds: 0.6)
        hear(0.002, seconds: 0.2)   // a gap between words
        hear(0.15, seconds: 0.5)
        XCTAssertEqual(found, [])
        hear(0.002, seconds: 1.0)
        XCTAssertEqual(found.count, 1, "once per pause")
        XCTAssertEqual(found[0], 2.9 + 0.1, accuracy: 0.001)
        hear(0.1, seconds: 0.3)
        hear(0.005, seconds: 0.4)    // quiet relative to the speech
        XCTAssertEqual(found.count, 2)
        XCTAssertEqual(found[1], 4.2 + 0.1, accuracy: 0.001)
    }

    func testProbeOfOneHasItsWinner() {
        let probe = DictationLanguage.Probe(locales: ["en-US"])
        XCTAssertEqual(probe.winner, 0)
        XCTAssertTrue(probe.listens(to: 0))
    }

    private func reading(_ locale: String, _ text: String, _ confidence: Double) -> DictationLanguage.Reading {
        .init(locale: locale, text: text, confidence: confidence)
    }

    private func rank(keyboard: String? = nil, successful: String? = nil, preferred: [String] = ["en-US"], installed: [String] = []) -> [String] {
        DictationLanguage.ranked(keyboard: keyboard, successful: successful, preferred: preferred, installed: installed, supported: supported)
    }
}