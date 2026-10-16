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
    /// Tap and long-press targets, in row coordinates, front to back.
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
    static let bottom: CACornerMask = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
}

enum ChatDrawItem {
    case box(ChatBox)
    case text(ChatTextLayout, CGRect)
    case icon(Icon, size: CGFloat, frame: CGRect, tint: ColorToken)
    /// ActivityIndicator size="small", scaled.
    case spinner(CGRect, tint: ColorToken, scale: CGFloat)
    /// A running tool's timer: whole seconds since `since` (ms), as "12.0s",
    /// at the row's text size (nil: the designed size).
    case elapsed(since: Int64, frame: CGRect, text: TextEnvironment?)
    /// A ring whose opacity breathes while a reply is on its way
    /// (PermissionFooter's loading ring).
    case pulse(ChatBox)
    /// A DiffChunk, planned at the frame's width. Its "Show N more lines"
    /// asks for `diffShowMore(toolId:chunk:file:)`. A card it ends clips
    /// `corners` to `radius` (`overflow: hidden`).
    case diff(DiffChunkPlan, frame: CGRect, toolId: String, chunk: Int, radius: CGFloat = 0, corners: CACornerMask = .all)
    /// A DiffFileHeader, planned at the frame's width, naming `path`.
    case diffHeader(DiffHeaderPlan, path: String, frame: CGRect)
    /// A strip that scrolls sideways (HorizontalScrollView: a code block, a
    /// table), or up and down with `vertical` (a long permission list),
    /// showing `content` through `frame`, its corners rounded by `radius`.
    /// The content's items and hits are in its own coordinates.
    case scroller(ChatRowPlan, frame: CGRect, radius: CGFloat = 0, vertical: Bool = false)
    /// FileView's picture, loaded once it is on screen.
    case attachment(ChatAttachment, frame: CGRect)
    /// A markdown image block's picture, loaded once it is on screen;
    /// `label` is what VoiceOver reads.
    case webImage(URL, frame: CGRect, label: String)
    /// A mermaid diagram, drawn by its own page; the page reports how tall
    /// it is with `mermaidHeight`.
    case mermaid(ChatMermaid, frame: CGRect)
}

/// A diagram in a row: `index` is its place among the row's diagrams, so
/// it keeps its height while the message streams (MermaidRenderer's state,
/// kept by MarkdownView's `key={index}`).
struct ChatMermaid: Equatable, Sendable {
    var row: String
    var index: Int
    var content: String
}

/// The row a markdown text is in, and the heights its diagrams reported.
struct ChatMermaidHeights: Equatable, Sendable {
    var row = ""
    var heights: [Int: CGFloat] = [:]
}

/// A picture the person attached: `ref` under the session's attachments,
/// and its thumbhash, shown until the picture arrives.
struct ChatAttachment: Equatable, Sendable {
    var ref: String
    var thumbhash: String?
}

/// What a tap on part of a row does.
enum ChatRowAction: Equatable, Sendable {
    /// An agent's copy button.
    case copyMessage(id: String, text: String)
    case toggleGroup(String)
    /// Open or close a tool's body, by message id.
    case toggleTool(String)
    case openMessage(String)
    /// One file of a patch, on the message's screen.
    case openMessageFile(id: String, file: String)
    case openFile(String)
    case option(String)
    case retry(localId: String)
    case permission(ChatPermissionTap)
    /// An option in a tool's question form, by tool message id.
    case questionOption(toolId: String, questionId: String, option: Int)
    case questionSubmit(toolId: String)
    /// "Show N more lines" on file `file` of a tool's diff `chunk`.
    case diffShowMore(toolId: String, chunk: Int, file: Int)
    /// A diagram's page says how tall it is, in points.
    case mermaidHeight(row: String, index: Int, height: CGFloat)

    // Long presses

    /// LongPressCopyable: a "Copy" menu over the whole message.
    case copyMenu(String)
    /// React Native's `selectable` Text: the edit menu's Copy, for all of
    /// this text.
    case selectable(String)
    /// Selectable markdown: like `selectable` for its paragraph, or with
    /// Markdown Copy v2 the text selection screen for the whole markdown.
    case markdownSelectable(paragraph: String, markdown: String)
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
    /// Answers a long press rather than a tap.
    var hold = false
}
#endif
