#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// One row, fully measured and placed, ready to draw: a short list of
/// boxes, texts and icons at fixed frames. Built off the main thread by
/// `ChatRowRenderer` from a pure layout; a cell only applies it.
///
/// Immutable after it is built, so it crosses from the measuring actor to
/// the main thread as is.
final class ChatRowPlan: @unchecked Sendable {
    let id: String
    let size: CGSize
    let items: [ChatDrawItem]
    /// Tap targets, in row coordinates, front to back.
    let hits: [ChatHit]
    /// The whole row's opacity (a pending message is dimmed).
    let alpha: CGFloat
    /// What VoiceOver reads for the row.
    let accessibilityLabel: String?

    init(id: String, size: CGSize, items: [ChatDrawItem], hits: [ChatHit] = [], alpha: CGFloat = 1, accessibilityLabel: String? = nil) {
        self.id = id
        self.size = size
        self.items = items
        self.hits = hits
        self.alpha = alpha
        self.accessibilityLabel = accessibilityLabel
    }
}

struct ChatBox {
    var frame: CGRect
    var fill: ColorToken?
    var border: ColorToken?
    var borderWidth: CGFloat = 0
    var radius: CGFloat = 0
}

enum ChatDrawItem {
    case box(ChatBox)
    case text(ChatTextLayout, CGRect)
    case icon(Icon, size: CGFloat, frame: CGRect, tint: ColorToken)
}

/// What a tap on part of a row does.
enum ChatRowAction: Equatable, Sendable {
    case copy(String)
    case toggleGroup(String)
    case openMessage(String)
    case option(String)
    case retry(localId: String)
}

struct ChatHit {
    var frame: CGRect
    var action: ChatRowAction
}
#endif
