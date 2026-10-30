import HappyCore
import XCTest

final class ChatListRendererSettingsTests: XCTestCase {
    /// Chats draw on UltraList with nothing stored, as an installation that
    /// has never opened Appearance has. An unreadable value is not a reason
    /// to fall back to the old renderer either: it is the same default.
    func testMissingAndUnknownValuesUseUltraList() {
        let store = InMemoryKeyValueStore()
        let settings = LocalSettings(storage: store)
        XCTAssertEqual(settings.chatListRenderer, .ultraList)
        for invalid in ["", "ultralist", "UIcollectionView", "future-renderer"] {
            store.set(invalid, forKey: "chatListRenderer")
            XCTAssertEqual(settings.chatListRenderer, .ultraList)
        }
    }

    /// The collection renderer is still reachable, and a stored choice of it
    /// is honoured: an installation that picked it before the default moved
    /// keeps it until it picks again.
    func testAStoredCollectionChoiceIsKept() {
        let store = InMemoryKeyValueStore()
        store.set("UICollectionView", forKey: "chatListRenderer")
        XCTAssertEqual(LocalSettings(storage: store).chatListRenderer, .collectionView)
        XCTAssertEqual(ChatListRenderer.allCases, [.collectionView, .ultraList])
    }

    func testSelectionPersistsIndependentlyOfHomeAndOtherAccountsAndClears() {
        let firstStore = InMemoryKeyValueStore()
        let second = LocalSettings(storage: InMemoryKeyValueStore())
        let first = LocalSettings(storage: firstStore)
        first.chatListRenderer = .collectionView
        XCTAssertEqual(LocalSettings(storage: firstStore).chatListRenderer, .collectionView)
        XCTAssertEqual(first.homeListRenderer, .tableView, "Home's renderer is its own")
        XCTAssertEqual(second.chatListRenderer, .ultraList, "another account is untouched")
        first.homeListRenderer = .ultraList
        first.chatListRenderer = .ultraList
        XCTAssertEqual(first.homeListRenderer, .ultraList)
        first.chatListRenderer = .collectionView
        first.clear()
        XCTAssertEqual(LocalSettings(storage: firstStore).chatListRenderer, .ultraList, "logout leaves the default")
    }
}
