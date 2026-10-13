import Foundation
import XCTest
@testable import HappyCore

/// happy-app's ten catalogs (sources/text) as scripts/generate-translations.mjs
/// compiles them. The vectors are what each catalog's own functions return,
/// run under node.
final class TranslationCatalogTests: XCTestCase {
    private struct Vector: Decodable {
        var key: String
        var args: [String: Argument]
        var output: String
    }

    private enum Argument: Decodable {
        case text(String)
        case number(Int)
        case flag(Bool)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let flag = try? container.decode(Bool.self) { self = .flag(flag) }
            else if let number = try? container.decode(Int.self) { self = .number(number) }
            else { self = .text(try container.decode(String.self)) }
        }

        var value: TranslationValue {
            switch self {
            case .text(let text): .text(text)
            case .number(let number): .number(number)
            case .flag(let flag): .flag(flag)
            }
        }
    }

    private func vectors() throws -> [String: [Vector]] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "translation-vectors", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([String: [Vector]].self, from: Data(contentsOf: url))
    }

    func testEveryFunctionOfEveryCatalogAnswersAsHappyAppDoes() throws {
        let all = try vectors()
        XCTAssertEqual(Set(all.keys), Set(AppLanguage.supported.map(\.code)))
        var checked = 0
        for (language, list) in all {
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(catalog.language, language)
            for vector in list {
                let rendered = catalog(vector.key, vector.args.mapValues(\.value))
                XCTAssertEqual(rendered, vector.output, "\(language) \(vector.key) \(vector.args)")
                checked += 1
            }
        }
        XCTAssertEqual(checked, 8210)
    }

    func testEveryCatalogHasEnglishsKeys() {
        let english = Set(TranslationCatalog.english.keys)
        XCTAssertEqual(english.count, 899)
        for language in AppLanguage.supported.map(\.code) {
            XCTAssertEqual(Set(TranslationCatalog.catalog(for: language).keys), english, language)
        }
    }

    func testStringsAreTheCatalogsOwn() {
        XCTAssertEqual(TranslationCatalog.english("common.cancel"), "Cancel")
        XCTAssertEqual(TranslationCatalog.catalog(for: "ru")("common.cancel"), "Отмена")
        XCTAssertEqual(TranslationCatalog.catalog(for: "ja")("settingsLanguage.title"), "言語")
        XCTAssertEqual(TranslationCatalog.catalog(for: "zh-Hant")("settingsLanguage.automatic"), "自動")
        // English is _default.ts, which index.ts serves, not translations/en.ts.
        XCTAssertEqual(TranslationCatalog.english("markdown.copyFailed"), "Copy failed")
    }

    func testAnUnknownLanguageIsEnglishAndAnUnknownKeyIsItself() {
        XCTAssertEqual(TranslationCatalog.catalog(for: "fr").language, "en")
        XCTAssertEqual(TranslationCatalog.catalog(for: "ru")("no.such.key"), "no.such.key")
        XCTAssertTrue(TranslationCatalog.catalog(for: "en") === TranslationCatalog.english, "decoded once")
    }

    func testRussianCountsBeyondItsRule() {
        let ru = TranslationCatalog.catalog(for: "ru")
        // `count === 1 ? … : count < 5 ? … : …`, not the plural helper.
        XCTAssertEqual(ru("files.changedFiles", ["count": 1]), "1 изменённый файл")
        XCTAssertEqual(ru("files.changedFiles", ["count": 3]), "3 изменённых файла")
        XCTAssertEqual(ru("files.changedFiles", ["count": 21]), "21 изменённых файлов")
        XCTAssertEqual(ru("files.changedFiles", ["count": 123_456]), "123456 изменённых файлов")
        // The helper itself.
        XCTAssertEqual(ru("time.minutesAgo", ["count": 21]), "21 минуту назад")
        XCTAssertEqual(ru("time.minutesAgo", ["count": 1_000_022]), "1000022 минуты назад")
    }

    func testPluralRules() {
        let russian = [0, 1, 2, 5, 11, 12, 21, 22, 25, 111, 112, 121].map(TranslationCatalog.PluralRule.russian.category)
        XCTAssertEqual(russian, ["many", "one", "few", "many", "many", "many", "one", "few", "many", "many", "many", "one"])
        let polish = [0, 1, 2, 5, 11, 12, 21, 22, 25, 112, 122].map(TranslationCatalog.PluralRule.polish.category)
        XCTAssertEqual(polish, ["many", "one", "few", "many", "many", "many", "many", "few", "many", "many", "few"])
    }

    func testChoicesByFlagAndName() {
        let en = TranslationCatalog.english
        XCTAssertEqual(en("settings.featureToggled", ["feature": "Voice", "enabled": false]), "Voice disabled")
        XCTAssertEqual(en("settings.machineStatus", ["name": "mini", "status": "online"]), "mini is online")
        XCTAssertEqual(en("errors.validationError", ["field": "Port", "min": 1, "max": 65535]), "Port must be between 1 and 65535")
        XCTAssertEqual(en("status.lastSeen", [:]), "last seen undefined", "as JavaScript interpolates a missing parameter")
    }

    /// text/index.ts: the preferred language, then the device's, Chinese by
    /// script, then English.
    func testTheLanguageTheAppSpeaks() {
        XCTAssertEqual(AppLanguage.resolve(preferred: "ru", deviceLanguages: ["ja-JP"]), "ru")
        XCTAssertEqual(AppLanguage.resolve(preferred: "fr", deviceLanguages: ["ja-JP"]), "ja", "an unknown preference is Automatic")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["fr-FR", "pt-BR", "en-US"]), "pt")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["zh-Hant-TW"]), "zh-Hant")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["zh-Hans-CN"]), "zh-Hans")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["zh-TW"]), "zh-Hans", "no script subtag falls back to Simplified")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["fr-FR", "zh-Hant-HK", "ru"]), "zh-Hant", "Chinese ends the search")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: ["fr-FR", "de"]), "en")
        XCTAssertEqual(AppLanguage.resolve(preferred: nil, deviceLanguages: []), "en")
        XCTAssertEqual(AppLanguage.resolve(preferred: "zh-Hant", deviceLanguages: ["en"]), "zh-Hant")
    }

    func testCatalogsAreReadFromAnyThread() async {
        let languages = AppLanguage.supported.map(\.code)
        let answers = await withTaskGroup(of: String.self) { group in
            for index in 0..<64 {
                group.addTask {
                    TranslationCatalog.catalog(for: languages[index % languages.count])("common.cancel")
                }
            }
            var answers: Set<String> = []
            for await answer in group { answers.insert(answer) }
            return answers
        }
        XCTAssertEqual(answers.count, Set(languages.map { TranslationCatalog.catalog(for: $0)("common.cancel") }).count)
    }
}
