import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// MakeStuffView.tsx's intro, the first row of new work's conversation: the
/// 64px mark centred over one line, 16 apart and 16 inside the row
/// (`.happy-make-stuff__empty`, `__lead`). Once the conversation has begun
/// (`settled`) the line keeps its place, hidden, and the row ends right
/// under it (`[data-settled] { padding-bottom: 0 }`), where the first
/// message lands.
public struct MakeStuffIntroLayout: Equatable, Sendable {
    public enum Metrics {
        public static let inset: CGFloat = 16
        public static let mark: CGFloat = 64
        public static let gap: CGFloat = 16
    }

    public var size: CGSize
    public var mark: CGRect
    public var line: CGRect

    /// `line` is centred text wrapping inside the row.
    public init(width: CGFloat, line: Measurable, settled: Bool = false) {
        typealias M = Metrics
        let measure = max(0, width - 2 * M.inset)
        let lineSize = line.size(fitting: measure)
        mark = CGRect(x: (width - M.mark) / 2, y: M.inset, width: M.mark, height: M.mark)
        self.line = CGRect(x: M.inset, y: mark.maxY + M.gap, width: measure, height: lineSize.height)
        size = CGSize(width: max(0, width), height: self.line.maxY + (settled ? 0 : M.inset))
    }
}

/// The conversation screen: the transcript under the bar, and the composer
/// card 8 in from the sides and 8 above the keyboard, or above the safe
/// area while the keyboard is down.
public struct StemCellChatScreenLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 8
        public static let paddingBottom: CGFloat = 8
        /// Room between the newest row and the card.
        public static let listGap: CGFloat = 8
    }

    public var card: CGRect
    /// The transcript's insets inside the whole screen.
    public var listTop: CGFloat
    public var listBottom: CGFloat
    /// The height between those insets, which short content rests at the foot of.
    public var viewport: CGFloat

    /// `keyboardTop` is the keyboard guide's top in the screen.
    public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat, cardHeight: (CGFloat) -> CGFloat) {
        typealias M = Metrics
        let width = max(0, size.width - 2 * M.paddingH)
        let height = cardHeight(width)
        let foot = min(keyboardTop, size.height - safeArea.bottom)
        card = CGRect(x: M.paddingH, y: foot - M.paddingBottom - height, width: width, height: height)
        listTop = safeArea.top
        listBottom = max(0, size.height - card.minY + M.listGap)
        viewport = max(0, size.height - listTop - listBottom)
    }
}

/// The conversation's rows stacked in a scroll view: newest last, resting
/// on the composer while they are shorter than the screen, as a chat does.
/// A conversation that opens on its intro (desktop's leading header) keeps
/// it pinned under the bar instead, and its rows fill in under it.
///
/// A lifted send (`StemCellSendLift`) stands on its line from the
/// viewport's top while the reply has not filled the room under it: the
/// content reaches a viewport below the line, so following the end keeps
/// it there whatever the viewport does (the keyboard, the composer
/// growing). Once the rows below it fill that room the lift is spent, and
/// the stack is as it would be without it, at the same place.
public struct StemCellChatStackLayout: Equatable, Sendable {
    /// Row `row` held `line` down from the viewport's top.
    public struct Lift: Equatable, Sendable {
        public var row: Int
        public var line: CGFloat

        public init(row: Int, line: CGFloat) {
            self.row = row
            self.line = line
        }
    }

    public var frames: [CGRect]
    public var contentHeight: CGFloat
    /// The lift still holds room for the reply.
    public var holding: Bool

    /// `heights` top to bottom; `viewport` is the height between the top
    /// inset and the composer, which short content rests at the foot of.
    /// `pinsFirst`: the first row is the intro, at the top whatever follows.
    public init(heights: [CGFloat], width: CGFloat, viewport: CGFloat, pinsFirst: Bool = false, lift: Lift? = nil) {
        let total = heights.reduce(0, +)
        var starts: [CGFloat] = []
        starts.reserveCapacity(heights.count)
        var end: CGFloat = 0
        for height in heights {
            starts.append(end)
            end += height
        }
        var lead = pinsFirst ? 0 : max(0, viewport - total)
        contentHeight = max(viewport, total)
        holding = false
        if let lift, starts.indices.contains(lift.row) {
            let start = starts[lift.row]
            // Shorter below it than the room under its line: held. At the
            // moment the room fills, the natural rest is this same place.
            if total - start < viewport - lift.line {
                holding = true
                if !pinsFirst { lead = max(0, lift.line - start) }
                contentHeight = lead + start - lift.line + viewport
            }
        }
        frames = zip(starts, heights).map { CGRect(x: 0, y: lead + $0, width: width, height: $1) }
        if !holding { contentHeight = max(viewport, lead + total) }
    }
}

/// The transcript's rows that are views, as desktop's virtualised list
/// keeps only what is near the screen (Message.tsx's overscan): every
/// row's frame is planned, but a long conversation has views only for the
/// rows within a screen of the one shown. A row comes in a screen away
/// (`mount`) and goes only two screens away (`keep`), so one near the edge
/// doesn't come and go as the scroll wavers.
public struct StemCellChatMountedRows: Equatable, Sendable {
    public enum Metrics {
        /// Past each edge of what shows, in screens: where rows come in.
        public static let mount: CGFloat = 1
        /// Where rows already there go.
        public static let keep: CGFloat = 2
    }

    /// The rows to be views now.
    public var mount: Range<Int>
    /// The rows that, already views, stay.
    public var keep: Range<Int>

    /// `frames` top to bottom, as `StemCellChatStackLayout` stacks them;
    /// `top` and `height`: the band of content on screen.
    public init(frames: [CGRect], top: CGFloat, height: CGFloat) {
        typealias M = Metrics
        let bottom = top + height
        mount = Self.rows(frames, from: top - height * M.mount, to: bottom + height * M.mount)
        keep = Self.rows(frames, from: top - height * M.keep, to: bottom + height * M.keep)
    }

    /// The rows reaching into `from..<to`: those ending below `from` and
    /// starting above `to`, found by halving, as the frames only go down.
    static func rows(_ frames: [CGRect], from: CGFloat, to: CGFloat) -> Range<Int> {
        func first(_ past: (CGRect) -> Bool) -> Int {
            var low = 0
            var high = frames.count
            while low < high {
                let middle = (low + high) / 2
                if past(frames[middle]) { high = middle } else { low = middle + 1 }
            }
            return low
        }
        let start = first { $0.maxY > from }
        let end = first { $0.minY >= to }
        return start..<max(start, end)
    }
}

/// A tall row cut into chunks, each drawn by a view of its own, so that
/// only the chunks near the screen have views (`StemCellChatMountedRows`
/// within the row), as a long reply is read a screen at a time. A cut
/// falls between two of the row's marks, in drawing order, where nothing
/// drawn before it reaches below the next one's top, once a chunk is at
/// least `height` tall: no mark is ever split, and every chunk draws over
/// the ones before it as the row's marks did.
public struct StemCellChatChunks: Equatable, Sendable {
    public enum Metrics {
        /// A chunk's least height; rows up to twice it aren't cut.
        public static let height: CGFloat = 1024
    }

    public struct Chunk: Equatable, Sendable {
        /// Its marks, by their place in the row's drawing order.
        public var items: Range<Int>
        /// The band of the row they cover, the row's width wide.
        public var frame: CGRect

        public init(items: Range<Int>, frame: CGRect) {
            self.items = items
            self.frame = frame
        }
    }

    public var chunks: [Chunk]

    /// `frames`: the row's marks in drawing order, in its coordinates.
    public init(frames: [CGRect], size: CGSize, height: CGFloat = Metrics.height) {
        guard size.height > height * 2, !frames.isEmpty else {
            chunks = [Chunk(items: frames.indices, frame: CGRect(origin: .zero, size: size))]
            return
        }
        var chunks: [Chunk] = []
        var start = 0
        var top: CGFloat = 0
        var reach: CGFloat = 0
        for (index, frame) in frames.enumerated() {
            if index > start, frame.minY >= reach, reach - top >= height {
                chunks.append(Chunk(items: start..<index, frame: CGRect(x: 0, y: top, width: size.width, height: frame.minY - top)))
                start = index
                top = frame.minY
            }
            reach = max(reach, frame.maxY)
        }
        chunks.append(Chunk(items: start..<frames.count, frame: CGRect(x: 0, y: top, width: size.width, height: max(reach, size.height) - top)))
        self.chunks = chunks
    }
}

/// Desktop's send lift (Message.tsx `sendLift`, `SEND_LIFT_TOP`): a message
/// sent while the agent is idle, by a reader at the end, is lifted to 30%
/// down the viewport, the turns before it still in view above, and the
/// room under it is held for the reply until the reply fills it
/// (`StemCellChatStackLayout.Lift`). A lift only ever moves a send up: one
/// already at the line or above it stays where it landed.
///
/// Under a pinned intro still on screen (`introLine`; once it has scrolled
/// away the line is plain 30%) the line is no higher than its own line, so
/// the first send, landing right under the intro, is already there and
/// nothing moves; every later one is lifted to the same slot or lower.
public struct StemCellSendLift: Equatable, Sendable {
    public enum Metrics {
        /// `SEND_LIFT_TOP`: of the viewport's height, from its top.
        public static let share: CGFloat = 0.3
        /// No lower than this share, however tall the intro: the reply's room.
        public static let lowest: CGFloat = 0.5
        /// `SEND_FOLLOW_THRESHOLD`: a send made mid-turn this close to the
        /// end carries the reader to it.
        public static let follow: CGFloat = 80
    }

    /// From the viewport's top, where the send's top edge sits.
    public var line: CGFloat

    /// `introLine`: where a pinned intro's line ends.
    public init(viewport: CGFloat, introLine: CGFloat? = nil) {
        typealias M = Metrics
        line = min(max((viewport * M.share).rounded(), introLine ?? 0), (viewport * M.lowest).rounded())
    }

    /// A send whose top is `shownAt` from the viewport's top, as it landed.
    public func lifts(shownAt: CGFloat) -> Bool { shownAt > line }

    /// What a send does to the reader (ConversationView's `liftKey` and
    /// `followKey`, MessageList's commit). Sent while the agent is idle,
    /// it is lifted, but only for a reader following the newest row; one
    /// reading further up stays where they are. Sent mid-turn, it waits
    /// at the end, and a reader within `Metrics.follow` of the end is
    /// carried there and follows it, with no room held.
    public struct Send: Equatable, Sendable {
        public var lifts: Bool
        public var follows: Bool

        public init(working: Bool, following: Bool, distanceFromEnd: CGFloat) {
            if working {
                lifts = false
                follows = following || distanceFromEnd <= Metrics.follow
            } else {
                lifts = following
                follows = following
            }
        }
    }

    /// The room a lift holds stays while the reader scrolls away and back
    /// (`geometryExtent`), until the rows below the send fill it. Only
    /// once the viewport has changed height under it (the keyboard, the
    /// composer) does it go early: as soon as the reader is far enough up
    /// that none of it shows (`geometryExtentOffscreenRelease`).
    public static func releases(resized: Bool, viewportBottom: CGFloat, rowsEnd: CGFloat?) -> Bool {
        guard resized, let rowsEnd else { return false }
        return viewportBottom <= rowsEnd
    }
}

/// The transcript's scroll while a finger drives it, or it bounces past an
/// end on its own: nothing the screen lays out moves it then. A new content
/// height that would take the scroll past an end, or bring it back inside
/// one, waits; following the newest row waits too. Both are given once the
/// finger lets go, the bounce is back inside, or the scroll is at rest. A
/// height or an offset written mid-pull moves the content under the finger,
/// and a reply streaming in lays the screen out many times a second.
public struct StemCellChatScrollHold: Equatable, Sendable {
    /// The scroll view as it stands, in its own coordinates.
    public struct Scroll: Equatable, Sendable {
        public var offset: CGFloat
        public var insetTop: CGFloat
        public var insetBottom: CGFloat
        public var contentHeight: CGFloat
        public var viewport: CGFloat
        /// A finger is on it.
        public var tracking: Bool
        /// It moves on its own: momentum, or a bounce back from an end.
        public var decelerating: Bool

        public init(offset: CGFloat, insetTop: CGFloat, insetBottom: CGFloat, contentHeight: CGFloat, viewport: CGFloat, tracking: Bool, decelerating: Bool) {
            self.offset = offset
            self.insetTop = insetTop
            self.insetBottom = insetBottom
            self.contentHeight = contentHeight
            self.viewport = viewport
            self.tracking = tracking
            self.decelerating = decelerating
        }

        /// The offset that shows the end, at `contentHeight` or its own.
        public func end(contentHeight: CGFloat? = nil) -> CGFloat {
            max(-insetTop, (contentHeight ?? self.contentHeight) + insetBottom - viewport)
        }

        /// Past either end, at `contentHeight` or its own.
        public func stretched(contentHeight: CGFloat? = nil) -> Bool {
            offset < -insetTop - 0.5 || offset > end(contentHeight: contentHeight) + 0.5
        }

        /// Driven by a finger or by its own motion.
        public var moving: Bool { tracking || decelerating }
    }

    /// A height laid out and not yet given.
    public private(set) var held: CGFloat?

    public init() {}

    /// Laid out at `height`: the height to give the scroll view now, or nil
    /// to keep what it has (holding `height` when it would move the content).
    public mutating func laidOut(_ height: CGFloat, scroll: Scroll) -> CGFloat? {
        if height == scroll.contentHeight {
            held = nil
            return nil
        }
        if scroll.moving, scroll.stretched() || scroll.stretched(contentHeight: height) {
            held = height
            return nil
        }
        held = nil
        return height
    }

    /// The held height, once nothing holds it: the finger is off and the
    /// scroll isn't bouncing past an end with it.
    public mutating func release(scroll: Scroll) -> CGFloat? {
        guard let height = held, !scroll.tracking else { return nil }
        if scroll.decelerating, scroll.stretched() || scroll.stretched(contentHeight: height) { return nil }
        held = nil
        return height == scroll.contentHeight ? nil : height
    }

    /// Following the newest row moves the offset only while nothing else does.
    public static func follows(_ scroll: Scroll) -> Bool { !scroll.moving }
}

/// One message of a Stem Cells conversation, as desktop's `Message` sets
/// it on a phone's width: 16 in from the sides and 8 above and below
/// (desktop's 20 and 16, scaled), the agent's markdown with its blocks 8
/// apart, the person's text in a bubble at the right, 10 above and below
/// its text and 12 beside it. The bubble reaches to 36 from the column's
/// left, as far as Telegram lets one on a phone; past desktop's ten lines
/// its text is cut there, "Show full" under it.
public struct StemCellMessageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginH: CGFloat = 16
        public static let marginV: CGFloat = 8
        public static let blockGap: CGFloat = 8
        /// The least room left of a person's bubble, and of their pictures.
        public static let bubbleLeading: CGFloat = 36
        public static let bubblePaddingH: CGFloat = 12
        public static let bubblePaddingV: CGFloat = 10
        public static let bubbleRadius: CGFloat = 10
        /// Desktop's `MESSAGE_PREVIEW_HEIGHT`: a person's message past this
        /// many lines shows only them until opened.
        public static let previewLines = 10
        /// Between the text and its Show full / Show less line.
        public static let foldGap: CGFloat = 8
        /// The status line under a person's message while it is on its way.
        public static let statusGap: CGFloat = 2
        public static let statusHeight: CGFloat = 14
    }

    /// One run of an agent's message: Markdown, or pictures and videos.
    public enum Part {
        case markdown([MarkdownLayout.Block])
        /// A tool call's pictures and recordings; `columns` 0 is justified rows.
        case media([StemCellMediaLayout.Item], columns: Int)
        /// A layout the agent wrote for media it showed.
        case tree([StemCellMediaTreeLayout.Box])
        /// A document, file or artifact: one card across the column.
        case card
        /// A story drawn inline (`StoryCardLayout`).
        case story
        /// An HTML artifact shown inline, across the column at the height its page measured.
        case page(height: CGFloat)
        /// A sidebar Prioritizing proposed, at the column's left.
        case proposal(StemCellSidebarProposalLayout.Input)
    }

    public enum Placed: Equatable, Sendable {
        case markdown(MarkdownLayout, origin: CGPoint)
        /// One frame per item, in the items' order.
        case media([CGRect])
        case tree(StemCellMediaTreeLayout, origin: CGPoint)
        case card(CGRect)
        case story(CGRect)
        case page(CGRect)
        /// The card's frame; its insides are `layout`'s, from the frame's origin.
        case proposal(StemCellSidebarProposalLayout, frame: CGRect)
    }

    public var size: CGSize
    public var parts: [Placed]
    public var bubble: CGRect?
    /// The person's text, drawn as written.
    public var text: CGRect?
    /// The text is its first `previewLines`, cut (`Fold.preview`).
    public var cut = false
    /// Show full, or Show less, under a long message's text.
    public var foldControl: CGRect?
    /// The pictures the person sent, under the bubble at the right.
    public var pictures: [CGRect]
    public var status: CGRect?

    /// The first Markdown run, for an agent message that is only text.
    public var markdown: MarkdownLayout? {
        for part in parts { if case .markdown(let layout, _) = part { return layout } }
        return nil
    }

    public var markdownOrigin: CGPoint {
        for part in parts { if case .markdown(_, let origin) = part { return origin } }
        return .zero
    }

    public static func agent(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, blocks: [MarkdownLayout.Block]) -> StemCellMessageLayout {
        agent(width: width, maxContentWidth: maxContentWidth, parts: [.markdown(blocks)])
    }

    /// The runs one under another, 8 apart, in the reading column.
    public static func agent(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, parts: [Part]) -> StemCellMessageLayout {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let inner = max(0, column.width - 2 * M.marginH)
        let left = column.x + M.marginH
        var y = M.marginV
        var placed: [Placed] = []
        for part in parts {
            if !placed.isEmpty { y += M.blockGap }
            switch part {
            case .markdown(let blocks):
                let markdown = MarkdownLayout(width: inner, blocks: blocks, gap: M.blockGap)
                placed.append(.markdown(markdown, origin: CGPoint(x: left, y: y)))
                y += markdown.size.height
            case .media(let items, let columns):
                let media = StemCellMediaLayout(width: inner, items: items, columns: columns)
                placed.append(.media(media.frames.map { $0.offsetBy(dx: left, dy: y) }))
                y += media.size.height
            case .tree(let boxes):
                let tree = StemCellMediaTreeLayout(width: inner, root: boxes)
                placed.append(.tree(tree, origin: CGPoint(x: left, y: y)))
                y += tree.size.height
            case .card:
                placed.append(.card(CGRect(x: left, y: y, width: inner, height: StemCellResultCardLayout.height)))
                y += StemCellResultCardLayout.height
            case .story:
                let size = StoryCardLayout.size(width: inner)
                placed.append(.story(CGRect(origin: CGPoint(x: left, y: y), size: size)))
                y += size.height
            case .page(let height):
                placed.append(.page(CGRect(x: left, y: y, width: inner, height: height)))
                y += height
            case .proposal(let input):
                let proposal = StemCellSidebarProposalLayout(width: inner, input: input)
                placed.append(.proposal(proposal, frame: CGRect(origin: CGPoint(x: left, y: y), size: proposal.size)))
                y += proposal.size.height
            }
        }
        return StemCellMessageLayout(size: CGSize(width: max(0, width), height: y + M.marginV), parts: placed, bubble: nil, text: nil, pictures: [], status: nil)
    }

    /// A person's message that may be longer than `previewLines`.
    public struct Fold {
        /// The text cut to `previewLines`; shorter than the whole, it folds.
        public var preview: Measurable
        /// Show full, or, opened, Show less.
        public var control: Measurable
        public var opened: Bool
        /// The text's line height: no taller than `previewLines` of it, the
        /// preview is never measured.
        public var lineHeight: CGFloat

        public init(preview: Measurable, control: Measurable, opened: Bool, lineHeight: CGFloat) {
            self.preview = preview
            self.control = control
            self.opened = opened
            self.lineHeight = lineHeight
        }
    }

    /// `showsStatus` keeps a line under the bubble for a refusal. `text` is
    /// nil for pictures sent alone; `pictures` are drawn as desktop draws a
    /// message's photos: justified, against the right, at most four.
    public static func user(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, text: Measurable?, fold: Fold? = nil, pictures: [StemCellMediaFlow.Image] = [], showsStatus: Bool) -> StemCellMessageLayout {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let inner = max(0, column.width - 2 * M.marginH)
        let maxBubble = max(0, column.width - M.marginH - M.bubbleLeading)
        let right = column.x + column.width - M.marginH
        var bottom = M.marginV
        var bubble: CGRect?
        var textFrame: CGRect?
        var cut = false
        var foldControl: CGRect?
        if let text {
            let measure = max(0, maxBubble - 2 * M.bubblePaddingH)
            var textSize = text.size(fitting: measure)
            var contentWidth = textSize.width
            var controlSize: CGSize?
            if let fold, textSize.height > CGFloat(M.previewLines) * fold.lineHeight + 0.5 {
                let preview = fold.preview.size(fitting: measure)
                if preview.height < textSize.height {
                    // As wide cut as whole, as desktop clips it: opening
                    // it only grows it down. The cut line's ellipsis can
                    // be the widest.
                    textSize.width = max(textSize.width, preview.width)
                    if !fold.opened { textSize.height = preview.height; cut = true }
                    let control = fold.control.size(fitting: measure)
                    controlSize = control
                    contentWidth = max(textSize.width, control.width)
                }
            }
            let contentHeight = textSize.height + (controlSize.map { M.foldGap + $0.height } ?? 0)
            let bubbleWidth = contentWidth + 2 * M.bubblePaddingH
            let frame = CGRect(x: right - bubbleWidth, y: bottom, width: bubbleWidth, height: contentHeight + 2 * M.bubblePaddingV)
            bubble = frame
            let placed = CGRect(x: frame.minX + M.bubblePaddingH, y: frame.minY + M.bubblePaddingV, width: textSize.width, height: textSize.height)
            textFrame = placed
            if let controlSize {
                foldControl = CGRect(x: placed.minX, y: placed.maxY + M.foldGap, width: controlSize.width, height: controlSize.height)
            }
            bottom = frame.maxY
        }
        var pictureFrames: [CGRect] = []
        if !pictures.isEmpty {
            if bubble != nil { bottom += M.blockGap }
            let measure = min(maxBubble, StemCellMediaFlow.messageMaxWidth)
            let items = pictures.prefix(StemCellMediaFlow.messageMax).map { StemCellMediaLayout.Item(isVideo: false, image: $0) }
            let media = StemCellMediaLayout(width: measure, items: items, columns: 0, limits: StemCellMediaFlow.message, alignEnd: true)
            // The photos hug the right edge as the bubble does.
            pictureFrames = media.frames.map { $0.offsetBy(dx: right - measure, dy: bottom) }
            bottom += media.size.height
        }
        var status: CGRect?
        if showsStatus {
            status = CGRect(x: column.x + M.marginH, y: bottom + M.statusGap, width: inner, height: M.statusHeight)
            bottom += M.statusGap + M.statusHeight
        }
        return StemCellMessageLayout(
            size: CGSize(width: max(0, width), height: bottom + M.marginV),
            parts: [], bubble: bubble, text: textFrame, cut: cut, foldControl: foldControl, pictures: pictureFrames, status: status
        )
    }
}

/// Desktop's ResultCard: one thing an agent produced, as a 64-tall card
/// across its container. A 40 chip 12 in carries the kind's glyph, the
/// title (20 tall) over a detail line (18) beside it, and a chevron at the
/// right when it opens.
public struct StemCellResultCardLayout: Equatable, Sendable {
    public static let height: CGFloat = 64
    public static let radius: CGFloat = 8
    public static let chip: CGFloat = 40
    public static let chipRadius: CGFloat = 6
    public static let glyph: CGFloat = 20
    public static let chevron: CGFloat = 20
    public static let padding: CGFloat = 12
    public static let gap: CGFloat = 12
    public static let titleHeight: CGFloat = 20
    public static let detailHeight: CGFloat = 18

    public var chip: CGRect
    public var glyph: CGRect
    public var title: CGRect
    public var detail: CGRect
    public var chevron: CGRect?

    public init(frame: CGRect, opens: Bool) {
        typealias C = StemCellResultCardLayout
        chip = CGRect(x: frame.minX + C.padding, y: frame.minY + (frame.height - C.chip) / 2, width: C.chip, height: C.chip)
        glyph = CGRect(x: chip.midX - C.glyph / 2, y: chip.midY - C.glyph / 2, width: C.glyph, height: C.glyph)
        let textX = chip.maxX + C.gap
        var right = frame.maxX - C.padding
        if opens {
            chevron = CGRect(x: right - C.chevron, y: frame.minY + (frame.height - C.chevron) / 2, width: C.chevron, height: C.chevron)
            right -= C.chevron + C.gap
        }
        let top = frame.minY + (frame.height - C.titleHeight - C.detailHeight) / 2
        title = CGRect(x: textX, y: top, width: max(0, right - textX), height: C.titleHeight)
        detail = CGRect(x: textX, y: top + C.titleHeight, width: max(0, right - textX), height: C.detailHeight)
    }
}
