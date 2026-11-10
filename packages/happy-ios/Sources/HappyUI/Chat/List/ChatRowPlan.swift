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
    /// V2 sidebar proposals, which the screen keeps as live views
    /// over the row: each laid out, at its frame in row coordinates.
    let proposals: [(artifactId: String, layout: SidebarProposalLayout, frame: CGRect)]
    /// What its tap toggles (Show full, Show less), as a VoiceOver action.
    let toggles: String?
    /// The person's own message: what its send transition flies in.
    let flight: ChatRowFlight?
    /// The person's own message, on its way, waiting or taken, whether or
    /// not it flies in: the newest of them, last, stays on the composer
    /// while what is above it grows.
    let mine: Bool
    /// An agent's words, which may still be arriving: shown a character at
    /// a time as they grow (`ChatRevealDriver`).
    let revealable: Bool
    private let reveal = ChatRevealMapBox()
    /// The words a person can select once the message is lifted, and the
    /// whole message as Copy copies it; nil where there are none.
    let selection: ChatSelectable?
    /// Drawn controls VoiceOver reads and presses one by one, after the
    /// row's words.
    let controls: [ChatControl]

    init(id: String, size: CGSize, items: [ChatDrawItem], hits: [ChatHit] = [], alpha: CGFloat = 1, accessibilityLabel: String? = nil, proposals: [(artifactId: String, layout: SidebarProposalLayout, frame: CGRect)] = [], toggles: String? = nil, flight: ChatRowFlight? = nil, mine: Bool = false, revealable: Bool = false, selection: ChatSelectable? = nil, controls: [ChatControl] = []) {
        self.id = id
        self.size = size
        self.items = items
        self.hits = hits
        self.alpha = alpha
        self.accessibilityLabel = accessibilityLabel
        self.proposals = proposals
        self.toggles = toggles
        self.flight = flight
        self.mine = mine
        self.revealable = revealable
        self.selection = selection
        self.controls = controls
    }

    /// Where its words are, in reading order, for a revealable plan. Worked
    /// out once, on whichever thread asks first: the planners ask off the
    /// main thread for the rows that may stream (`warmReveal`).
    var revealMap: RevealMap? {
        revealable ? reveal.value { ChatRevealMapping.map(self) } : nil
    }

    /// The map if it has been worked out already: never works it out.
    var preparedRevealMap: RevealMap? { revealable ? reveal.prepared : nil }

    func warmReveal() { _ = revealMap }
}

/// A value worked out once, on any thread.
private final class ChatRevealMapBox: @unchecked Sendable {
    private let lock = NSLock()
    private var map: RevealMap?

    func value(_ make: () -> RevealMap) -> RevealMap {
        lock.lock()
        defer { lock.unlock() }
        if let map { return map }
        let made = make()
        map = made
        return made
    }

    var prepared: RevealMap? {
        lock.lock()
        defer { lock.unlock() }
        return map
    }
}

/// A message's selectable words (`MessageTextSelectionView`): the texts it
/// draws, in reading order, each the very layout drawn in the row at its
/// frame there, so a selection's highlight lies on its glyphs; what
/// copying puts back between them; and the message whole, as Copy copies it.
struct ChatSelectable {
    struct Text {
        let layout: ChatTextLayout
        /// Where it is drawn, in row coordinates.
        var frame: CGRect
        /// Copied before it when its start is (a list item's marker).
        var lead = ""
        /// Copied between the text before it and this one.
        var joiner = "\n\n"
        /// The strip it shows through (a code block, a table), which a
        /// highlight never runs past.
        var clip: CGRect? = nil
    }

    var texts: [Text]
    /// What Copy copies: the message as written.
    var whole: String
    /// The message's own shape in its row (a bubble, or what its marks
    /// cover), which is what lifts.
    var frame: CGRect
    /// No bubble of its own (an agent's words): it lifts on a card.
    var card: Bool

    var run: SelectionText {
        SelectionText(texts.map { SelectionText.Piece($0.layout.string.string, lead: $0.lead, joiner: $0.joiner) })
    }

    /// What an agent's words lift as: the marks of `items` together.
    static func covering(_ items: [ChatDrawItem], texts: [Text], whole: String) -> ChatSelectable? {
        guard !texts.isEmpty else { return nil }
        let frame = items.map(\.markFrame).filter { !$0.isEmpty }.reduce(CGRect.null) { $0.union($1) }
        return ChatSelectable(texts: texts, whole: whole, frame: frame, card: true)
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
    /// A bundled picture (`UIImage.happy`), as a template in `tint`: a
    /// provider's mark.
    case image(String, frame: CGRect, tint: ColorToken)
    /// ActivityIndicator size="small", scaled.
    case spinner(CGRect, tint: ColorToken, scale: CGFloat)
    /// A label carrying the shimmer while its work goes (`ChatShimmerView`).
    case shimmer(ChatShimmerText, frame: CGRect)
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
    /// A picture or recording a V2 agent presented, or a photo the
    /// person sent, loaded once it is on screen.
    case media(ChatMedia, frame: CGRect)
    /// A file card's chip and detail line while its file may still be on
    /// its way: the ring or the glyph, and the size or how much is here.
    case fileStatus(ChatFileStatus, frame: CGRect)
    /// Live content of its own, drawn by a view that reads and follows it.
    case embed(ChatEmbed, frame: CGRect)
    /// A person's own message's clock or checks (`ChatDeliveryView`).
    case delivery(ChatDeliveryMark, frame: CGRect)
}

/// What an embedded view shows.
enum ChatEmbed: Equatable, Sendable {
    /// An HTML artifact's page (`InlinePageView`).
    case page(InlinePage)
}

/// An artifact's page shown inline in a V2 conversation: the
/// version and entry its web view loads through the paired computer.
struct InlinePage: Equatable, Sendable {
    var artifactId: String
    var title: String
    var page: References.Page
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

/// One picture or recording in a V2 conversation: `key` names it
/// to the screen's `ChatMediaSource`, and its thumbhash shows until it
/// arrives. A recording shows its first frame under a play button.
struct ChatMedia: Equatable, Sendable {
    var key: String
    var isVideo: Bool
    var thumbhash: String?
    /// What VoiceOver reads: its name.
    var label: String
    /// Still going to the computer: its ring.
    var upload: ChatUpload? = nil
    /// It fills its tile, cropped, as a `media` component's items do,
    /// rather than fitting inside it.
    var covers = false
}

/// A picture or video of a message on its way: how far it is lives on
/// `UploadProgressBoard` under `key`, applied to its tile a frame at a
/// time; the plan only says it is sending, or failed.
struct ChatUpload: Equatable, Sendable {
    var key: String
    var failed: Bool

    /// The ring's disc in a tile at `frame`.
    static func ring(in frame: CGRect) -> CGRect {
        UploadRingLayout.disc(in: frame.size).offsetBy(dx: frame.minX, dy: frame.minY)
    }
}

/// A file card's live part (`ChatFileStatusView`): in the card's own
/// coordinates, its chip, where the glyph or Telegram's ring goes, and its
/// detail line, which says the kind and then the size or progress.
struct ChatFileStatus: Equatable, Sendable {
    /// The media's `ChatMedia.key`.
    var key: String
    var glyph: Icon
    var glyphSize: CGFloat
    /// The kind before the size ("PDF"), nil when it has none.
    var kind: String?
    /// The size presented with it.
    var size: Int?
    var chip: CGRect
    var detail: CGRect
    var fontScale: CGFloat
}

/// A picture the person attached: `ref` under the session's attachments,
/// and its thumbhash, shown until the picture arrives.
struct ChatAttachment: Equatable, Sendable {
    var ref: String
    var thumbhash: String?
    /// Still in this device's outbox: its `localId`, whose copy is drawn
    /// rather than downloaded.
    var local: String? = nil
    /// Still going to the server: its ring.
    var upload: ChatUpload? = nil
    /// The plaintext's size, as the file event says it.
    var size: Int? = nil
    /// A recording: its first frame under the play button, streamed when tapped.
    var isVideo = false
    /// Its name and type, for the player to know what it plays.
    var name = ""
    var mimeType: String? = nil
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
    /// A web address a tool call's screen shows.
    case openURL(String)
    /// A Happy link shown as a button (API.md, "Buttons"): opens as its
    /// link would; `label` is what it says.
    case linkButton(url: String, label: String)
    case option(String)
    case retry(localId: String)
    /// A sending picture's cross: takes it out of message `messageId`. A
    /// legacy chat's picture is its own outbox item, so both are its `localId`.
    case cancelUpload(messageId: String, piece: String)
    case permission(ChatPermissionTap)
    /// An option in a tool's question form, by tool message id.
    case questionOption(toolId: String, questionId: String, option: Int)
    case questionSubmit(toolId: String)
    /// "Show N more lines" on file `file` of a tool's diff `chunk`.
    case diffShowMore(toolId: String, chunk: Int, file: Int)
    /// A diagram's page says how tall it is, in points.
    case mermaidHeight(row: String, index: Int, height: CGFloat)
    /// A V2 picture or recording, opened whole by its `ChatMedia.key`.
    case openMedia(String)
    /// A media file's ring (or a video's badge): pause its download, or
    /// start or resume it; one already here opens instead. By its
    /// `ChatMedia.key`, or a legacy attachment's ref.
    case toggleDownload(String)
    /// A legacy chat's recording, played streaming.
    case playAttachment(ChatAttachment)
    /// A V2 artifact's card.
    case openArtifact(Artifact)
    /// A finished V2 turn's "View traces" / "Hide traces", by its run.
    case toggleTurn(String)
    /// A press on a chat UI component.
    case ui(ChatUiTap)

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

/// A control drawn in a row (a quick reply, a card's button), as VoiceOver
/// has it: where it is in row coordinates, what it says, whether it is the
/// one chosen, and what pressing it does (nil: it can't be used now).
struct ChatControl {
    var frame: CGRect
    var label: String
    var selected = false
    var action: ChatRowAction?
}

struct ChatHit {
    var frame: CGRect
    var action: ChatRowAction
    /// Answers a long press rather than a tap.
    var hold = false
}
#endif
