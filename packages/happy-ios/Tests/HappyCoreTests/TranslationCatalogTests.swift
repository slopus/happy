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

    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread, where these tests run.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
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

    /// `Math.abs(count)` first, as ru.ts and pl.ts do, down to `Int.min`,
    /// whose `abs` would trap; JavaScript's 2^63 ends in 8 as well.
    func testPluralRulesTakeTheMagnitude() {
        let values = [-1, -2, -21, -112, Int.min, Int.max]
        XCTAssertEqual(values.map(TranslationCatalog.PluralRule.russian.category), ["one", "few", "one", "many", "many", "many"])
        XCTAssertEqual(values.map(TranslationCatalog.PluralRule.polish.category), ["one", "few", "many", "many", "many", "many"])
        XCTAssertEqual(values.map(TranslationCatalog.PluralRule.oneOther.category), ["other", "other", "other", "other", "other", "other"])
        let days = TranslationCatalog.catalog(for: "ru")("sessionHistory.daysAgo", ["count": .number(.min)])
        XCTAssertTrue(days.contains(String(Int.min)), days)
    }

    func testChoicesByFlagAndName() {
        let en = TranslationCatalog.english
        XCTAssertEqual(en("settings.featureToggled", ["feature": "Voice", "enabled": false]), "Voice disabled")
        XCTAssertEqual(en("settings.machineStatus", ["name": "mini", "status": "online"]), "mini is online")
        XCTAssertEqual(en("errors.validationError", ["field": "Port", "min": 1, "max": 65535]), "Port must be between 1 and 65535")
        XCTAssertEqual(en("status.lastSeen", [:]), "last seen undefined", "as JavaScript interpolates a missing parameter")
    }

    /// text/index.ts answers a key its language lacks with the key, not
    /// with English's words.
    func testAMissingKeyIsTheKey() {
        let partial = TranslationCatalog(language: "ja", json: #"{"common.ok":"OK"}"#)
        XCTAssertEqual(partial("common.ok"), "OK")
        XCTAssertEqual(partial("common.cancel"), "common.cancel")
        XCTAssertEqual(TranslationCatalog.english("no.such.key"), "no.such.key")
        XCTAssertEqual(TranslationCatalog.catalog(for: "ja")("no.such.key"), "no.such.key")
        XCTAssertEqual(TranslationCatalog.english("sessionHistory.daysAgo"), "sessionHistory.daysAgo", "a choosing parameter missing")
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

    @MainActor
    func testTheScreensLanguageChangesOnlyWhenItDiffers() async {
        defer { AppLocalization.use(nil) }
        AppLocalization.use(nil)
        XCTAssertNil(AppLocalization.screens, "English is the screens' own words")
        XCTAssertEqual(AppLocalization.language, "en")
        let polish = await TranslationCatalog.load("pl")
        XCTAssertTrue(AppLocalization.use(polish))
        XCTAssertFalse(AppLocalization.use(polish))
        XCTAssertEqual(AppLocalization.language, "pl")
        let english = await TranslationCatalog.load("en")
        XCTAssertTrue(AppLocalization.use(english), "English catalog: back to the screens' own words")
        XCTAssertNil(AppLocalization.screens)
        XCTAssertFalse(AppLocalization.use(nil))
    }

    /// The screens' strings that read the catalog name a key whose English
    /// is the string they keep beside it, so English stays exactly what it
    /// was. Read from HappyUI's sources, which don't build here. Every
    /// Strings file is checked; the counts pin the files Home converted,
    /// and another area's file gets a line here when it wants one.
    func testEveryLocalizedStringKeepsItsKeysEnglish() throws {
        let ui = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/HappyUI")
        let files = [ui.appendingPathComponent("Strings.swift")]
            + (try FileManager.default.contentsOfDirectory(at: ui.appendingPathComponent("Strings"), includingPropertiesForKeys: nil))
        let call = try NSRegularExpression(pattern: #"localized\("([A-Za-z0-9_.]+)""#)
        let plain = try NSRegularExpression(pattern: #"localized\("([A-Za-z0-9_.]+)", "((?:[^"\\]|\\.)*)"\)"#)
        // A key that isn't a literal can't be checked.
        let unnamed = try NSRegularExpression(pattern: #"localized\((?!")"#)
        // A string's English is a literal on the call's line, or it can't
        // be checked; a function's values come second, as a dictionary.
        let english = try NSRegularExpression(pattern: #"localized\("[A-Za-z0-9_.]+",\s*""#)
        let valued = try NSRegularExpression(pattern: #"localized\("[A-Za-z0-9_.]+",\s*\["#)
        var counts: [String: (strings: Int, functions: Int)] = [:]
        for file in files where file.pathExtension == "swift" && file.lastPathComponent != "Localized.swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            let range = NSRange(source.startIndex..., in: source)
            XCTAssertEqual(unnamed.numberOfMatches(in: source, range: range), 0, file.lastPathComponent)
            var strings = 0
            for match in plain.matches(in: source, range: range) {
                let key = String(source[Range(match.range(at: 1), in: source)!])
                let literal = String(source[Range(match.range(at: 2), in: source)!])
                XCTAssertEqual(TranslationCatalog.english(key), Self.unescaped(literal), key)
                strings += 1
            }
            var calls = 0
            for match in call.matches(in: source, range: range) {
                let key = String(source[Range(match.range(at: 1), in: source)!])
                XCTAssertTrue(TranslationCatalog.english.contains(key), key)
                calls += 1
            }
            let name = file.lastPathComponent
            XCTAssertEqual(english.numberOfMatches(in: source, range: range), strings, "\(name): an English literal that isn't checked")
            XCTAssertEqual(valued.numberOfMatches(in: source, range: range), calls - strings, "\(name): a call that is neither a string nor a function")
            counts[name] = (strings, calls - strings)
        }
        // Home's: Strings.swift, Strings/Home.swift, Strings/SettingsPages.swift.
        XCTAssertEqual(counts["Strings.swift"]?.strings, 231)
        XCTAssertEqual(counts["Strings.swift"]?.functions, 10)
        XCTAssertEqual(counts["Home.swift"]?.strings, 36)
        XCTAssertEqual(counts["Home.swift"]?.functions, 1)
        XCTAssertEqual(counts["SettingsPages.swift"]?.strings, 1)
        XCTAssertEqual(counts["SettingsPages.swift"]?.functions, 0)
        // The secondary screens': Strings/SecondaryStrings.swift, Strings/Tablet.swift.
        XCTAssertEqual(counts["SecondaryStrings.swift"]?.strings, 115)
        XCTAssertEqual(counts["SecondaryStrings.swift"]?.functions, 8)
        XCTAssertEqual(counts["Tablet.swift"]?.strings, 3)
        XCTAssertEqual(counts["Tablet.swift"]?.functions, 0)
    }

    /// A string happy-app spells out in a component (no `t()` key) keeps its
    /// English here and names the component and line that spell it out:
    /// `// account.tsx:49, spelled out`. The component is found in happy-app's
    /// sources and still holds the string, so one happy-app has since moved to
    /// the catalog or dropped is noticed. The line is not compared, as
    /// happy-app's own edits move it. Home's three files, as above, and the pages
    /// HappyCore writes English for.
    func testEverySpelledOutStringIsStillSpelledOutByHappyApp() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let sources = root.deletingLastPathComponent().appendingPathComponent("happy-app/sources")
        guard let walk = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil) else {
            throw XCTSkip("happy-app's sources are not beside this package")
        }
        let components = (walk.allObjects as! [URL]).filter { ["ts", "tsx"].contains($0.pathExtension) }
        var contents: [String: String] = [:]
        let marker = try NSRegularExpression(pattern: #"//\s*([A-Za-z0-9_()/.\-]+\.tsx?):(\d+)(?: "([^"]*)")?, spelled out"#)
        let literal = try NSRegularExpression(pattern: #"(?:=|\{|return)\s*"((?:[^"\\]|\\.)*)""#)
        var counts: [String: Int] = [:]
        // Home's three files, and the settings pages HappyCore writes English for.
        let files = ["HappyUI/Strings.swift", "HappyUI/Strings/Home.swift", "HappyUI/Strings/SettingsPages.swift",
                     "HappyCore/Settings/SettingsPages.swift", "HappyCore/Settings/AgentsPage.swift"]
        for name in files {
            let source = try String(contentsOf: root.appendingPathComponent("Sources").appendingPathComponent(name), encoding: .utf8)
            for (offset, line) in source.components(separatedBy: "\n").enumerated() {
                let range = NSRange(line.startIndex..., in: line)
                guard let found = marker.firstMatch(in: line, range: range) else { continue }
                let cited = String(line[Range(found.range(at: 1), in: line)!])
                let at = "\(name):\(offset + 1) cites \(cited)"
                let matches = components.filter { $0.path.hasSuffix("/" + cited) }
                XCTAssertEqual(matches.count, 1, "\(at): one component of happy-app's")
                guard let component = matches.first else { continue }
                counts[name, default: 0] += 1
                // The component may assemble the string (`Connect {props.name}`):
                // the comment then quotes the part to look for. A multi-line
                // function has its English on the lines below, unchecked.
                let english: String
                if found.range(at: 3).location != NSNotFound {
                    english = String(line[Range(found.range(at: 3), in: line)!])
                } else if let text = literal.firstMatch(in: line, range: range).flatMap({ Range($0.range(at: 1), in: line) }) {
                    var raw = String(line[text])
                    if let interpolation = raw.range(of: "\\(") { raw = String(raw[..<interpolation.lowerBound]) }
                    // A long string may be split across lines in the component.
                    english = String(Self.unescaped(raw).prefix(30))
                } else {
                    continue
                }
                let body = try contents[component.path] ?? String(contentsOf: component, encoding: .utf8)
                contents[component.path] = body
                XCTAssertTrue(body.contains(english), "\(at): \(english.debugDescription) is not in it any more")
            }
        }
        XCTAssertEqual(counts["HappyUI/Strings.swift"], 40)
        XCTAssertEqual(counts["HappyUI/Strings/Home.swift"], 43)
        XCTAssertEqual(counts["HappyUI/Strings/SettingsPages.swift"], 7)
        XCTAssertEqual(counts["HappyCore/Settings/SettingsPages.swift"], 15)
        XCTAssertEqual(counts["HappyCore/Settings/AgentsPage.swift"], 4)
    }

    /// A Swift string literal's text.
    private static func unescaped(_ literal: String) -> String {
        var text = ""
        var characters = literal[...]
        while let character = characters.popFirst() {
            guard character == "\\", let next = characters.popFirst() else {
                text.append(character)
                continue
            }
            switch next {
            case "n": text.append("\n")
            case "t": text.append("\t")
            case "u":
                guard characters.first == "{", let close = characters.firstIndex(of: "}"),
                      let scalar = UInt32(characters[characters.index(after: characters.startIndex)..<close], radix: 16).flatMap(Unicode.Scalar.init) else { continue }
                text.unicodeScalars.append(scalar)
                characters = characters[characters.index(after: close)...]
            default: text.append(next)
            }
        }
        return text
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
