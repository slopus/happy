import HappyCore
import XCTest

final class RetiredLocalSettingsTests: XCTestCase {
    /// The renderer picks Appearance once offered are gone: a stored pick,
    /// whatever it was, is deleted as the account's settings are read, and
    /// the rest of what is stored stays.
    func testRendererPicksAreDeletedOnRead() {
        let store = InMemoryKeyValueStore([
            "chatListRenderer": "UICollectionView",
            "homeListRenderer": "UltraList",
            "themePreference": "dark",
        ])
        let settings = LocalSettings(storage: store)
        XCTAssertNil(store.string(forKey: "chatListRenderer"))
        XCTAssertNil(store.string(forKey: "homeListRenderer"))
        XCTAssertEqual(settings.themePreference, .dark)
        XCTAssertEqual(store.string(forKey: "themePreference"), "dark")
    }

    /// Nothing stored, nothing written.
    func testNothingStoredWritesNothing() {
        let store = RecordingStore()
        _ = LocalSettings(storage: store)
        XCTAssertEqual(store.writes, 0)
    }
}

private final class RecordingStore: KeyValueStore, @unchecked Sendable {
    private(set) var writes = 0
    func string(forKey key: String) -> String? { nil }
    func set(_ value: String?, forKey key: String) { writes += 1 }
}
