import HappyCore
import XCTest

final class ChatListRendererSettingsTests: XCTestCase {
    func testMissingAndUnknownValuesKeepCollectionDefault() {
        let store = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: store)
        XCTAssertEqual(settings.chatListRenderer, .collectionView)
        for invalid in ["", "ultralist", "future-renderer"] {
            store.set(invalid, forKey: "chatListRenderer")
            XCTAssertEqual(settings.chatListRenderer, .collectionView)
        }
    }

    func testSelectionPersistsIndependentlyOfHomeAndOtherAccountsAndClears() {
        let firstStore = InMemoryKeyValueStore()
        let second = LocalSettings(storage: InMemoryKeyValueStore())
        let first = LocalSettings(storage: firstStore)
        first.chatListRenderer = .ultraList
        XCTAssertEqual(LocalSettings(storage: firstStore).chatListRenderer, .ultraList)
        XCTAssertEqual(first.homeListRenderer, .tableView)
        XCTAssertEqual(second.chatListRenderer, .collectionView)
        first.homeListRenderer = .ultraList
        first.chatListRenderer = .collectionView
        XCTAssertEqual(first.homeListRenderer, .ultraList)
        first.chatListRenderer = .ultraList
        first.clear()
        XCTAssertEqual(LocalSettings(storage: firstStore).chatListRenderer, .collectionView)
    }
}