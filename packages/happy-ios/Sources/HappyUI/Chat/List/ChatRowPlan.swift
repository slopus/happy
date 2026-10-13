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
    var alpha: CGFloat = 1
    /// Which corners `radius` rounds.
    var corners: CACornerMask = .all
}

extension CACornerMask {
    static let all: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    static let top: CACornerMask = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
}

enum ChatDrawItem {
    case box(ChatBox)
    case text(ChatTextLayout, CGRect)
    case icon(Icon, size: CGFloat, frame: CGRect, tint: ColorToken)
    /// ActivityIndicator size="small", scaled.
    case spinner(CGRect, tint: ColorToken, scale: CGFloat)
    /// A running tool's timer: whole seconds since `since` (ms), as "12.0s".
    case elapsed(since: Int64, frame: CGRect)
    /// A ring whose opacity breathes while a reply is on its way
    /// (PermissionFooter's loading ring).
    case pulse(ChatBox)
}

/// What a tap on part of a row does.
enum ChatRowAction: Equatable, Sendable {
    case copy(String)
    case toggleGroup(String)
    /// Open or close a tool's body, by message id.
    case toggleTool(String)
    case openMessage(String)
    case openFile(String)
    case option(String)
    case retry(localId: String)
    case permission(ChatPermissionTap)
    /// An option in a tool's question form, by tool message id.
    case questionOption(toolId: String, questionId: String, option: Int)
    case questionSubmit(toolId: String)
}

/// A permission button, with what its reply needs.
struct ChatPermissionTap: Equatable, Sendable {
    var permissionId: String
    var kind: PermissionButton.Kind
    var reply: PermissionReply
}

struct ChatHit {
    var frame: CGRect
    var action: ChatRowAction
}
#endif
