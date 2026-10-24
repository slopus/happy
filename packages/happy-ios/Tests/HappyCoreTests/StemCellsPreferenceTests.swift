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
        XCTAssertFalse(production.isEnabled)
        XCTAssertNil(production.computerID)
        production.isEnabled = true
        XCTAssertFalse(production.isEnabled)
    }

    func testPreviewAndDevelopmentOfferItOffByDefault() {
        for variant in [AppVariant.preview, .development] {
            let preference = StemCellsPreference(variant: variant, storage: storage())
            XCTAssertTrue(preference.isAvailable)
            XCTAssertFalse(preference.isEnabled, "not the default")
            preference.isEnabled = true
            XCTAssertTrue(preference.isEnabled)
            preference.computerID = "direct-2"
            XCTAssertEqual(preference.computerID, "direct-2")
        }
    }

    func testTheShippedBundleIdentifierIsProduction() {
        XCTAssertEqual(AppVariant.production.bundleIdentifier, "com.ex3ndr.happy")
        XCTAssertFalse(StemCellsPreference(variant: .production).isAvailable)
    }
}
