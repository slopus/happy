import Foundation
import XCTest
@testable import HappyCore

/// V2 is a preview feature: no production build can show it.
final class PreferenceTests: XCTestCase {
    private func storage() -> UserDefaults {
        let name = "V2PreferenceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testProductionNeverShowsV2() {
        let defaults = storage()
        // Even a stored choice from a preview install on the same phone.
        defaults.set(true, forKey: Preference.enabledKey)
        defaults.set("direct-1", forKey: Preference.computerKey)
        let production = Preference(variant: .production, storage: defaults)
        XCTAssertFalse(production.isAvailable)
        XCTAssertFalse(production.takeFilterChoice())
        XCTAssertNil(production.computerID)
    }

    /// The filter's old choice is carried over once.
    func testPreviewAndDevelopmentOfferIt() {
        for variant in [AppVariant.preview, .development] {
            let defaults = storage()
            let preference = Preference(variant: variant, storage: defaults)
            XCTAssertTrue(preference.isAvailable)
            XCTAssertFalse(preference.takeFilterChoice(), "not the default")
            defaults.set(true, forKey: Preference.enabledKey)
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
            let preference = Preference(variant: variant, storage: storage())
            XCTAssertFalse(preference.directConnection)
            XCTAssertFalse(preference.showsComputers)
            preference.directConnection = true
            XCTAssertTrue(preference.directConnection)
            XCTAssertTrue(preference.showsComputers)
        }
        let defaults = storage()
        defaults.set(true, forKey: Preference.directKey)
        let production = Preference(variant: .production, storage: defaults)
        XCTAssertFalse(production.directConnection)
        XCTAssertTrue(production.showsComputers)
    }

    func testTheShippedBundleIdentifierIsProduction() {
        XCTAssertEqual(AppVariant.production.bundleIdentifier, "com.ex3ndr.happy")
        XCTAssertFalse(Preference(variant: .production).isAvailable)
    }
}
