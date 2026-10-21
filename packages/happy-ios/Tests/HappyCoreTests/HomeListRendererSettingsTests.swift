import HappyCore
import XCTest

final class HomeListRendererSettingsTests: XCTestCase {
    func testMissingAndUnknownPreferencesKeepTableDefault() {
        let store = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: store)
        XCTAssertEqual(settings.homeListRenderer, .tableView)
        for invalid in ["", "ultralist", "future-renderer"] {
            store.set(invalid, forKey: "homeListRenderer")
            XCTAssertEqual(settings.homeListRenderer, .tableView)
        }
    }

    func testSelectionSurvivesRecreationAndStaysAccountLocal() {
        let firstStore = InMemoryKeyValueStore()
        let secondStore = InMemoryKeyValueStore()
        let first = LocalSettings(storage: firstStore)
        let second = LocalSettings(storage: secondStore)
        first.homeListRenderer = .ultraList
        XCTAssertEqual(LocalSettings(storage: firstStore).homeListRenderer, .ultraList)
        XCTAssertEqual(second.homeListRenderer, .tableView)
        second.homeListRenderer = .tableView
        XCTAssertEqual(first.homeListRenderer, .ultraList)
        first.clear()
        XCTAssertEqual(LocalSettings(storage: firstStore).homeListRenderer, .tableView)
    }
}
