import Foundation
import XCTest
@testable import HappyCore

/// The two kinds of account are Happy Agent and Happy CLI wherever the
/// person reads them, in every language; the code's `legacy` never shows.
final class AccountKindNamingTests: XCTestCase {
    /// The words around the kinds' names that `Strings.AccountKind` reads.
    private static let kindKeys = [
        "native.accountKind.addCLIAccount",
        "native.accountKind.connectAgent",
        "native.accountKind.restoreCLIAccount",
        "native.accountKind.cliServer",
        "native.accountKind.disconnectAgentTitle",
        "native.accountKind.signOutCLITitle",
        "native.accountKind.deviceNeedsCLIAccount",
        "native.accountKind.accountNotShareable",
        "native.accountKind.enterLinkMessage",
        "native.accountKind.agentUnreachable",
        "native.accountKind.restoreAnotherCLIAccount",
        "native.accountKind.restoreAnotherFooter",
    ]

    /// The app's other own words: the home card that leads a Happy CLI
    /// account to Happy Agent, and where a phone keeps its secret key.
    private static let otherKeys = [
        "native.home.migrationTitle",
        "native.home.migrationSubtitle",
        "native.onboarding.secretKeyBody",
    ]

    /// "Legacy" as each language would put it before "account": the word
    /// itself, which several keep, and each one's own.
    private static let legacyWords: [String: String] = [
        "en": #"(?i)legacy"#,
        "ru": #"(?i)legacy|легаси|устаревш\w* (аккаунт|учётн)"#,
        "pl": #"(?i)legacy|(starsze|przestarzałe) konto|konto (starsze|przestarzałe)"#,
        "es": #"(?i)legacy|cuenta (heredada|antigua|legada)|\blegad[oa]\b"#,
        "it": #"(?i)legacy|account (obsoleto|ereditato)"#,
        "pt": #"(?i)legacy|conta (legada|antiga)|\blegad[oa]\b"#,
        "ca": #"(?i)legacy|compte (heretat|antic)|llegat"#,
        "zh-Hans": #"(?i)legacy|旧版账户|传统账户|遗留"#,
        "zh-Hant": #"(?i)legacy|舊版帳戶|傳統帳戶|遺留"#,
        "ja": #"(?i)legacy|レガシー|旧アカウント|従来のアカウント"#,
    ]

    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    func testEveryLanguageHasTheKindsWords() {
        let languages = AppLanguage.supported.map(\.code)
        XCTAssertEqual(Set(TranslationCatalog.nativeSources.keys), Set(languages))
        let english = TranslationCatalog.nativeSources["en"] ?? [:]
        XCTAssertEqual(Set(english.keys), Set(Self.kindKeys + Self.otherKeys))
        for language in languages {
            let words = TranslationCatalog.nativeSources[language] ?? [:]
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(Set(words.keys), Set(english.keys), language)
            for key in Self.kindKeys + Self.otherKeys {
                let text = catalog(key, ["name": "Studio Mac"])
                XCTAssertNotEqual(text, key, "\(language) lacks \(key)")
                XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(language) \(key)")
                // The products keep their names, as often as English says them.
                for product in ["Happy Agent", "Happy CLI"] {
                    XCTAssertEqual(Self.count(product, in: words[key] ?? ""), Self.count(product, in: english[key] ?? ""), "\(language) \(key) says \(product) differently")
                }
                XCTAssertEqual(Self.parameters(words[key] ?? ""), Self.parameters(english[key] ?? ""), "\(language) \(key)")
            }
            XCTAssertTrue(catalog("native.accountKind.agentUnreachable", ["name": "Studio Mac"]).contains("Studio Mac"), language)
            if language != "en" {
                XCTAssertNotEqual(words["native.accountKind.addCLIAccount"], english["native.accountKind.addCLIAccount"], "\(language) is English")
            }
        }
    }

    /// happy-app's catalogs and this app's own words, in every language.
    func testNoLanguageCallsAKindLegacy() throws {
        for (code, json) in TranslationCatalog.sources {
            let pattern = try NSRegularExpression(pattern: try XCTUnwrap(Self.legacyWords[code], code))
            let texts = [json] + (TranslationCatalog.nativeSources[code] ?? [:]).values
            for text in texts {
                let found = pattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
                XCTAssertNil(found, "\(code): \(found.flatMap { Range($0.range, in: text) }.map { String(text[$0]) } ?? "")")
            }
        }
    }

    /// Every string literal in the app's sources, comments left out. The
    /// only "legacy" a literal may hold is a storage name nobody reads.
    func testNoStringTheAppShowsSaysLegacy() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let storageNames: Set<String> = [#"legacy/\(accountID)"#]
        let walk = try XCTUnwrap(FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil))
        var checked = 0
        for case let file as URL in walk where file.pathExtension == "swift" && file.lastPathComponent != "TranslationCatalogs.swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            for (offset, line) in source.components(separatedBy: "\n").enumerated() {
                for literal in Self.literals(in: line) {
                    checked += 1
                    guard literal.range(of: "legacy", options: .caseInsensitive) != nil, !storageNames.contains(literal) else { continue }
                    XCTFail("\(file.lastPathComponent):\(offset + 1) shows \(literal.debugDescription)")
                }
            }
        }
        XCTAssertGreaterThan(checked, 1000, "the walk found the sources")
    }

    private static func count(_ needle: String, in text: String) -> Int {
        text.components(separatedBy: needle).count - 1
    }

    private static func parameters(_ text: String) -> [String] {
        var found: [String] = []
        var rest = Substring(text)
        while let open = rest.range(of: "${"), let close = rest[open.upperBound...].firstIndex(of: "}") {
            found.append(String(rest[open.upperBound..<close]))
            rest = rest[rest.index(after: close)...]
        }
        return found
    }

    /// The `"…"` literals on a line, up to a `//` outside them.
    private static func literals(in line: String) -> [String] {
        var literals: [String] = []
        var current: String?
        var escaped = false
        var previous: Character?
        for character in line {
            if var text = current {
                if escaped {
                    text.append(character)
                    escaped = false
                } else if character == "\\" {
                    text.append(character)
                    escaped = true
                } else if character == "\"" {
                    literals.append(text)
                    current = nil
                    previous = character
                    continue
                } else {
                    text.append(character)
                }
                current = text
            } else if character == "\"" {
                current = ""
            } else if character == "/" && previous == "/" {
                break
            }
            previous = character
        }
        return literals
    }
}
