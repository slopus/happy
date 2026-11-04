import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// What the Happy CLI home's migration card needs from the store and the
/// catalogs: whether a Happy Agent reaches the account through the Happy
/// server, and its words in every language.
final class DesktopMigrationTests: XCTestCase {
    private func machine(_ id: String, _ metadata: [String: JSONValue]) -> MachineRecord {
        MachineRecord(
            id: id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            metadataVersion: 1, metadataCipher: "c", metadata: .object(metadata),
            daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "k", decryptable: true
        )
    }

    private func list(_ machines: [MachineRecord]) -> SessionList {
        SessionList(
            LegacyHomeSnapshot(
                machines: MachinesSnapshot(synced: true, machines: machines),
                sessions: [],
                projects: [],
                settings: SettingsSnapshot(pending: [:])
            ),
            clock: SessionList.Clock(now: Date(timeIntervalSince1970: 0), calendar: Calendar(identifier: .gregorian), locale: Locale(identifier: "en_GB"))
        )
    }

    /// Any of the marks Happy Agent leaves on a machine (`isRigMachine`).
    func testAHappyAgentMachineIsAServerAgent() {
        XCTAssertFalse(list([]).hasServerAgent)
        XCTAssertFalse(list([machine("cli", ["host": "mac"])]).hasServerAgent)
        XCTAssertTrue(list([machine("cli", ["host": "mac"]), machine("agent", ["machineKind": "rig"])]).hasServerAgent)
        XCTAssertTrue(list([machine("agent", ["cliAvailability": .object(["rig": .bool(true)])])]).hasServerAgent)
        XCTAssertTrue(HomeListModel(list([machine("agent", ["rigOnly": .bool(true)])]), offline: nil, expandedProjects: []).hasServerAgent)
    }

    override func setUp() async throws {
        // Decoding is off-main work; Debug builds stop if it happens on the
        // main thread.
        for language in AppLanguage.supported.map(\.code) { _ = await TranslationCatalog.load(language) }
    }

    /// Every language has every word, the products keep their names as
    /// often as English says them, and only English is English.
    func testEveryLanguageHasTheWords() {
        let english = TranslationCatalog.desktopMigrationSources["en"] ?? [:]
        XCTAssertEqual(Set(TranslationCatalog.desktopMigrationSources.keys), Set(AppLanguage.supported.map(\.code)))
        XCTAssertEqual(english.count, 13)
        for language in AppLanguage.supported.map(\.code) {
            let words = TranslationCatalog.desktopMigrationSources[language] ?? [:]
            let catalog = TranslationCatalog.catalog(for: language)
            XCTAssertEqual(Set(words.keys), Set(english.keys), language)
            for (key, text) in words {
                XCTAssertEqual(catalog(key), text, "\(language) \(key)")
                XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "\(language) \(key)")
                for product in ["Happy Agent", "Happy Desktop", "Chief of Staff", "Settings\u{00A0}›\u{00A0}Mobile\u{00A0}Access"] {
                    XCTAssertEqual(text.components(separatedBy: product).count, (english[key] ?? "").components(separatedBy: product).count, "\(language) \(key) says \(product) differently")
                }
            }
            if language != "en" {
                for key in ["native.desktopMigration.desktopTitle", "native.desktopMigration.agentConnectionBody", "native.desktopMigration.serverStep", "native.desktopMigration.serverStepDetail", "native.desktopMigration.updateStep", "native.desktopMigration.relayCodeTitle", "native.desktopMigration.relayCodeBody", "native.desktopMigration.relayCodeLink"] {
                    XCTAssertNotEqual(words[key], english[key], "\(language) \(key) is English")
                }
            }
        }
    }
}
