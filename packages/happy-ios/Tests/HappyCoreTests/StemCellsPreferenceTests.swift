import Foundation
import XCTest
@testable import HappyCore

/// Stem Cells is a preview feature: no production build can show it.
final class StemCellsPreferenceTests: XCTestCase {
    private func storage() -> UserDefaults {
        let name = "StemCellsPreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testProductionNeverShowsStemCells() {
        let defaults = storage()
        // Even a stored choice from a preview install on the same phone.
        defaults.set(true, forKey: StemCellsPreference.enabledKey)
        defaults.set("direct-1", forKey: StemCellsPreference.computerKey)
        let production = StemCellsPreference(variant: .production, storage: defaults)
        XCTAssertFalse(production.isAvailable)
        XCTAssertFalse(production.takeFilterChoice())
        XCTAssertNil(production.computerID)
    }

    /// The filter's old choice is carried over once.
    func testPreviewAndDevelopmentOfferIt() {
        for variant in [AppVariant.preview, .development] {
            let defaults = storage()
            let preference = StemCellsPreference(variant: variant, storage: defaults)
            XCTAssertTrue(preference.isAvailable)
            XCTAssertFalse(preference.takeFilterChoice(), "not the default")
            defaults.set(true, forKey: StemCellsPreference.enabledKey)
            XCTAssertTrue(preference.takeFilterChoice())
            XCTAssertFalse(preference.takeFilterChoice(), "carried over twice")
            preference.computerID = "direct-2"
            XCTAssertEqual(preference.computerID, "direct-2")
        }
    }

    /// Direct connection is an experiment, off until turned on; production
    /// keeps its computer page and can never turn it on.
    func testDirectConnectionIsOffUntilTurnedOn() {
        for variant in [AppVariant.preview, .development] {
            let preference = StemCellsPreference(variant: variant, storage: storage())
            XCTAssertFalse(preference.directConnection)
            XCTAssertFalse(preference.showsComputers)
            preference.directConnection = true
            XCTAssertTrue(preference.directConnection)
            XCTAssertTrue(preference.showsComputers)
        }
        let defaults = storage()
        defaults.set(true, forKey: StemCellsPreference.directKey)
        let production = StemCellsPreference(variant: .production, storage: defaults)
        XCTAssertFalse(production.directConnection)
        XCTAssertTrue(production.showsComputers)
    }

    func testTheShippedBundleIdentifierIsProduction() {
        XCTAssertEqual(AppVariant.production.bundleIdentifier, "com.ex3ndr.happy")
        XCTAssertFalse(StemCellsPreference(variant: .production).isAvailable)
    }
}
