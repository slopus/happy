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
        defaults.set("direct-1", forKey: Preference.agentConnectionKey)
        let production = Preference(variant: .production, storage: defaults)
        XCTAssertFalse(production.isAvailable)
        XCTAssertFalse(production.takeFilterChoice())
        XCTAssertNil(production.agentConnectionID)
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
            preference.agentConnectionID = "direct-2"
            XCTAssertEqual(preference.agentConnectionID, "direct-2")
        }
    }

    func testTheShippedBundleIdentifierIsProduction() {
        XCTAssertEqual(AppVariant.production.bundleIdentifier, "com.ex3ndr.happy")
        XCTAssertFalse(Preference(variant: .production).isAvailable)
    }
}
