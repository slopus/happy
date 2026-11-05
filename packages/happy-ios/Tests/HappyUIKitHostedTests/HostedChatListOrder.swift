#if canImport(UIKit)
@testable import HappyUI
import UIKit
import UltraView

/// The chats' lists stand the natural way up: the newest row is the last.
@MainActor
extension UltraListView {
    /// The newest row's view, if the list has it loaded.
    var newestLoadedView: ListRowView? { items.indices.last.flatMap(loadedItemView(at:)) }
}
#endif
