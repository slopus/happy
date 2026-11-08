import Foundation
@testable import HappyCore
import XCTest

/// Settings › Appearance › Shimmer in Low Power Mode: off unless turned
/// on, and never over Reduce Motion.
final class LowPowerShimmerTests: XCTestCase {
    func testOffUntilTurnedOn() {
        let storage = InMemoryKeyValueStore()
        let setting = LowPowerShimmer(storage: storage)
        XCTAssertFalse(setting.isEnabled)
        setting.isEnabled = true
        XCTAssertTrue(LowPowerShimmer(storage: storage).isEnabled)
        XCTAssertEqual(storage.string(forKey: LowPowerShimmer.key), "true")
        setting.isEnabled = false
        XCTAssertFalse(setting.isEnabled)
        XCTAssertNil(storage.string(forKey: LowPowerShimmer.key), "off leaves nothing stored")
    }

    func testReduceMotionAlwaysWinsAndLowPowerOnlyWithoutTheSetting() {
        for reduceMotion in [false, true] {
            for lowPower in [false, true] {
                for shimmersInLowPower in [false, true] {
                    let still = LowPowerShimmer.holdsStill(reduceMotion: reduceMotion, lowPower: lowPower, shimmersInLowPower: shimmersInLowPower)
                    XCTAssertEqual(still, reduceMotion || (lowPower && !shimmersInLowPower), "\(reduceMotion) \(lowPower) \(shimmersInLowPower)")
                }
            }
        }
        XCTAssertTrue(LowPowerShimmer.holdsStill(reduceMotion: true, lowPower: false, shimmersInLowPower: true))
        XCTAssertTrue(LowPowerShimmer.holdsStill(reduceMotion: false, lowPower: true, shimmersInLowPower: false))
        XCTAssertFalse(LowPowerShimmer.holdsStill(reduceMotion: false, lowPower: true, shimmersInLowPower: true))
    }

    override func setUp() async throws {
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    /// Every language has both words, in its own words.
    func testEveryLanguageHasTheWords() {
        let english = TranslationCatalog.lowPowerShimmerSources["en"] ?? [:]
        XCTAssertEqual(Set(TranslationCatalog.lowPowerShimmerSources.keys), Set(AppLanguage.supported.map(\.code)))
        XCTAssertEqual(english.count, 2)
        for language in AppLanguage.supported.map(\.code) {
            let words = TranslationCatalog.lowPowerShimmerSources[language] ?? [:]
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(Set(words.keys), Set(english.keys), language)
            for (key, text) in words {
                XCTAssertEqual(catalog(key), text, "\(language) \(key)")
                if language != "en" { XCTAssertNotEqual(text, english[key], "\(language) \(key) is English") }
            }
        }
    }
}
