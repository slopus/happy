import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// One function per chat row, after MessageView.tsx and its neighbours.
// Every row is laid out in a column at most `maxContentWidth` wide, centred
// in the list (MessageView's messageContent, `layout.maxWidth`). Frames are
// relative to the row.

/// The centred column every row draws in.
public struct ChatColumn: Equatable, Sendable {
    public var x: CGFloat
    public var width: CGFloat

    public init(rowWidth: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude) {
        let rowWidth = max(0, rowWidth)
        width = min(rowWidth, max(0, maxContentWidth))
        x = (rowWidth - width) / 2
    }
}

/// UserMessageFrame and UserTextBlock:
///
///     6
///     [author 20, 4]                      (another participant's message)
///     ┌ bubble: 12 ─ markdown ─ 12 ┐      right-aligned, 16 from the edge,
///     └ 4 above and below           ┘     hugs its text up to the column
///     4 (6 under a goal or a command's arguments)
///     [/command chip, 4]  or  [◎ Sent as a goal, 4]
///     2, status line 14, 4                always there, so a status that
///                                         appears or clears never moves rows
public struct UserMessageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 16
        public static let paddingTop: CGFloat = 6
        public static let authorMarginBottom: CGFloat = 4
        public static let authorPaddingH: CGFloat = 12
        public static let bubblePaddingH: CGFloat = 12
        public static let bubblePaddingV: CGFloat = 4
        public static let bubbleRadius: CGFloat = 12
        public static let bubbleMarginBottom: CGFloat = 4
        public static let bubbleBeforeChipMarginBottom: CGFloat = 6
        public static let chipPaddingH: CGFloat = 10
        public static let chipPaddingV: CGFloat = 2
        public static let chipRadius: CGFloat = 10
        public static let chipBorder: CGFloat = 1
        public static let chipMarginBottom: CGFloat = 4
        public static let goalIconSize: CGFloat = 16
        public static let goalGap: CGFloat = 8
        public static let goalMarginBottom: CGFloat = 4
        public static let statusMarginTop: CGFloat = 2
        public static let statusHeight: CGFloat = 14
        public static let statusMarginBottom: CGFloat = 4
        /// The dimmed bubble of a message the agent hasn't taken yet.
        public static let pendingOpacity: CGFloat = 0.45
    }

    public enum Content {
        /// A plain message.
        case text([MarkdownLayout.Block])
        /// A slash command: its chip, under its arguments when it has any.
        case command(chip: Measurable, arguments: [MarkdownLayout.Block]?)
        /// `/goal …`: the goal in a bubble, "Sent as a goal" under it.
        case goal([MarkdownLayout.Block], sentLabel: Measurable)
    }

    public struct Input {
        public var width: CGFloat
        public var maxContentWidth: CGFloat
        /// Another participant's name; their messages sit on the left.
        public var author: Measurable?
        public var content: Content

        public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, author: Measurable? = nil, content: Content) {
            self.width = width
            self.maxContentWidth = maxContentWidth
            self.author = author
            self.content = content
        }
    }

    public var size: CGSize
    public var author: CGRect?
    public var bubble: CGRect?
    /// The bubble's markdown, placed at `markdownOrigin`.
    public var markdown: MarkdownLayout?
    public var markdownOrigin: CGPoint
    public var chip: CGRect?
    public var chipLabel: CGRect?
    public var goalIcon: CGRect?
    public var goalLabel: CGRect?
    /// The status line, as wide as the column; its text aligns to the
    /// bubble's side.
    public var status: CGRect
    public var alignsLeft: Bool

    public init(_ input: Input) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: input.width, maxContentWidth: input.maxContentWidth)
        let left = column.x + M.paddingH
        let right = column.x + column.width - M.paddingH
        let inner = max(0, right - left)
        let fromOther = input.author != nil
        alignsLeft = fromOther

        func place(width: CGFloat) -> CGFloat {
            fromOther ? left : right - width
        }

        var y = M.paddingTop
        if let name = input.author {
            let available = max(0, inner - 2 * M.authorPaddingH)
            let size = name.size(fitting: available)
            author = CGRect(x: left + M.authorPaddingH, y: y, width: size.width, height: size.height)
            y += size.height + M.authorMarginBottom
        } else {
            author = nil
        }

        func makeBubble(_ blocks: [MarkdownLayout.Block], marginBottom: CGFloat) -> (frame: CGRect, markdown: MarkdownLayout, origin: CGPoint) {
            let available = max(0, inner - 2 * M.bubblePaddingH)
            let natural = MarkdownLayout.naturalWidth(of: blocks, available: available)
            let markdown = MarkdownLayout(width: natural, blocks: blocks)
            let width = natural + 2 * M.bubblePaddingH
            let frame = CGRect(x: place(width: width), y: y, width: width, height: markdown.size.height + 2 * M.bubblePaddingV)
            y += frame.height + marginBottom
            return (frame, markdown, CGPoint(x: frame.minX + M.bubblePaddingH, y: frame.minY + M.bubblePaddingV))
        }

        var bubble: (frame: CGRect, markdown: MarkdownLayout, origin: CGPoint)?
        chip = nil
        chipLabel = nil
        goalIcon = nil
        goalLabel = nil
        switch input.content {
        case .text(let blocks):
            bubble = makeBubble(blocks, marginBottom: M.bubbleMarginBottom)
        case .command(let label, let arguments):
            if let arguments {
                bubble = makeBubble(arguments, marginBottom: M.bubbleBeforeChipMarginBottom)
            }
            let labelSize = label.size(fitting: max(0, inner - 2 * (M.chipPaddingH + M.chipBorder)))
            let width = labelSize.width + 2 * (M.chipPaddingH + M.chipBorder)
            let frame = CGRect(x: place(width: width), y: y, width: width, height: labelSize.height + 2 * (M.chipPaddingV + M.chipBorder))
            chip = frame
            chipLabel = CGRect(x: frame.minX + M.chipPaddingH + M.chipBorder, y: frame.minY + M.chipPaddingV + M.chipBorder, width: labelSize.width, height: labelSize.height)
            y += frame.height + M.chipMarginBottom
        case .goal(let blocks, let sent):
            bubble = makeBubble(blocks, marginBottom: M.bubbleBeforeChipMarginBottom)
            let labelSize = sent.size(fitting: max(0, inner - M.goalIconSize - M.goalGap))
            let rowHeight = max(M.goalIconSize, labelSize.height)
            let width = M.goalIconSize + M.goalGap + labelSize.width
            let x = place(width: width)
            goalIcon = CGRect(x: x, y: y + (rowHeight - M.goalIconSize) / 2, width: M.goalIconSize, height: M.goalIconSize)
            goalLabel = CGRect(x: x + M.goalIconSize + M.goalGap, y: y + (rowHeight - labelSize.height) / 2, width: labelSize.width, height: labelSize.height)
            y += rowHeight + M.goalMarginBottom
        }
        self.bubble = bubble?.frame
        markdown = bubble?.markdown
        markdownOrigin = bubble?.origin ?? .zero

        y += M.statusMarginTop
        status = CGRect(x: left, y: y, width: inner, height: M.statusHeight)
        y += M.statusHeight + M.statusMarginBottom
        size = CGSize(width: max(0, input.width), height: y)
    }
}

/// AgentTextBlock: markdown 16 in from each side, 10 above and below, and
/// the copy glyph on a 20 pt line under it, flush with the text.
public struct AgentTextLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginH: CGFloat = 16
        public static let marginV: CGFloat = 10
        public static let copyHeight: CGFloat = 20
        public static let copyIconSize: CGFloat = 16
        /// COPY_HIT_SLOP: the glyph is small, its touch target is not.
        public static let copyHitSlop = LayoutInsets(top: 14, left: 14, bottom: 14, right: 20)
    }

    public var size: CGSize
    public var markdown: MarkdownLayout
    public var markdownOrigin: CGPoint
    public var copyButton: CGRect
    public var copyIcon: CGRect

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, blocks: [MarkdownLayout.Block]) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let x = column.x + M.marginH
        markdown = MarkdownLayout(width: max(0, column.width - 2 * M.marginH), blocks: blocks)
        markdownOrigin = CGPoint(x: x, y: M.marginV)
        let copyY = M.marginV + markdown.size.height
        copyButton = CGRect(x: x, y: copyY, width: M.copyIconSize, height: M.copyHeight)
        copyIcon = CGRect(x: x, y: copyY + (M.copyHeight - M.copyIconSize) / 2, width: M.copyIconSize, height: M.copyIconSize)
        size = CGSize(width: max(0, width), height: copyY + M.copyHeight + M.marginV)
    }
}

/// AgentEventBlock, and the compact placeholder for a record this build
/// can't show: one centred line, 8 in from the sides, 8 above and below.
public struct ChatEventLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginH: CGFloat = 8
        public static let paddingV: CGFloat = 8
    }

    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, label: Measurable) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let inner = max(0, column.width - 2 * M.marginH)
        let text = label.size(fitting: inner)
        self.label = CGRect(x: column.x + M.marginH + (inner - text.width) / 2, y: M.paddingV, width: text.width, height: text.height)
        size = CGSize(width: max(0, width), height: text.height + 2 * M.paddingV)
    }
}

/// AgentWorkGroupHeader: "Worked for 2m3s ›", one line, always 44 tall so
/// the trailing copy of an expanded group lands where the leading one was.
public struct WorkGroupHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginV: CGFloat = 8
        public static let marginH: CGFloat = 16
        public static let minHeight: CGFloat = 28
        public static let paddingV: CGFloat = 4
        public static let gap: CGFloat = 6
        public static let chevronSize: CGFloat = 13
        public static let pressedOpacity: CGFloat = 0.6
    }

    public var size: CGSize
    /// The tap target.
    public var header: CGRect
    public var label: CGRect
    public var chevron: CGRect

    public init(width: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude, label: Measurable) {
        typealias M = Metrics
        let column = ChatColumn(rowWidth: width, maxContentWidth: maxContentWidth)
        let x = column.x + M.marginH
        let inner = max(0, column.width - 2 * M.marginH)
        let text = label.size(fitting: max(0, inner - M.gap - M.chevronSize))
        let height = max(M.minHeight, text.height + 2 * M.paddingV)
        header = CGRect(x: x, y: M.marginV, width: inner, height: height)
        self.label = CGRect(x: x, y: M.marginV + (height - text.height) / 2, width: text.width, height: text.height)
        chevron = CGRect(x: x + text.width + M.gap, y: M.marginV + (height - M.chevronSize) / 2, width: M.chevronSize, height: M.chevronSize)
        size = CGSize(width: max(0, width), height: height + 2 * M.marginV)
    }
}

/// ChatFooter, just past the newest message: 4 above, 2 below, and the
/// "permissions shown in terminal only" box when the terminal has control.
public struct ChatFooterLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 4
        public static let paddingBottom: CGFloat = 2
        public static let warningMarginTop: CGFloat = 4
        public static let warningMarginH: CGFloat = 32
        public static let warningPaddingH: CGFloat = 12
        public static let warningPaddingV: CGFloat = 4
        public static let warningRadius: CGFloat = 8
        public static let iconSize: CGFloat = 16
        public static let iconGap: CGFloat = 6
    }

    public var size: CGSize
    public var warning: CGRect?
    public var icon: CGRect?
    public var label: CGRect?

    public init(width: CGFloat, warning text: Measurable?) {
        typealias M = Metrics
        let width = max(0, width)
        guard let text else {
            size = CGSize(width: width, height: M.paddingTop + M.paddingBottom)
            return
        }
        let maxBox = max(0, width - 2 * M.warningMarginH)
        let textSize = text.size(fitting: max(0, maxBox - 2 * M.warningPaddingH - M.iconSize - M.iconGap))
        let rowHeight = max(M.iconSize, textSize.height)
        let boxWidth = textSize.width + M.iconSize + M.iconGap + 2 * M.warningPaddingH
        let box = CGRect(x: (width - boxWidth) / 2, y: M.paddingTop + M.warningMarginTop, width: boxWidth, height: rowHeight + 2 * M.warningPaddingV)
        warning = box
        icon = CGRect(x: box.minX + M.warningPaddingH, y: box.minY + M.warningPaddingV + (rowHeight - M.iconSize) / 2, width: M.iconSize, height: M.iconSize)
        label = CGRect(x: box.minX + M.warningPaddingH + M.iconSize + M.iconGap, y: box.minY + M.warningPaddingV + (rowHeight - textSize.height) / 2, width: textSize.width, height: textSize.height)
        size = CGSize(width: width, height: box.maxY + M.paddingBottom)
    }
}

/// ChatList's OlderEnd: the 32 pt slot past the oldest message holding the
/// spinner, Retry or Load more. Always there, so a status change never
/// moves the conversation.
public struct ChatOlderEndLayout: Equatable, Sendable {
    public static let height: CGFloat = 32

    public var size: CGSize
    public var control: CGRect

    public init(width: CGFloat, control: CGSize) {
        let width = max(0, width)
        size = CGSize(width: width, height: Self.height)
        self.control = CGRect(x: (width - control.width) / 2, y: (Self.height - control.height) / 2, width: control.width, height: control.height)
    }
}

/// LongPressCopyable's menu, in window coordinates: 152 by 44, 8 above the
/// message, or 8 below it when above would come within 12 of the top (and
/// never within 12 of the bottom). Its right edge lines up with the
/// message's, as a user's bubble hugs the right, kept 12 from either side.
/// Inside it: the copy glyph 14 in, then the label 10 after it.
public struct CopyMenuLayout: Equatable, Sendable {
    public enum Metrics {
        public static let width: CGFloat = 152
        public static let height: CGFloat = 44
        public static let gap: CGFloat = 8
        public static let screenMargin: CGFloat = 12
        public static let radius: CGFloat = 14
        public static let paddingH: CGFloat = 14
        public static let iconSize: CGFloat = 17
        public static let iconGap: CGFloat = 10
        /// theme.colors.shadow, radius 16, 6 down.
        public static let shadowOpacity: Float = 0.1
        public static let shadowRadius: CGFloat = 16
        public static let shadowOffsetY: CGFloat = 6
        /// AnimatedPopup: in over 190 ms (ease-out cubic) from 0.96 and 8
        /// lower, out over 140 ms (ease-in cubic), fading.
        public static let enterDuration: TimeInterval = 0.19
        public static let enterScale: CGFloat = 0.96
        public static let enterOffsetY: CGFloat = 8
        public static let exitDuration: TimeInterval = 0.14
        /// The long press that opens it.
        public static let pressDuration: TimeInterval = 0.4
    }

    public var menu: CGRect
    /// In the menu's own coordinates.
    public var icon: CGRect
    public var label: CGRect

    public init(anchor: CGRect, window: CGSize, label: Measurable) {
        typealias M = Metrics
        let above = anchor.minY - M.height - M.gap
        let top = above >= M.screenMargin ? above : min(anchor.maxY + M.gap, window.height - M.height - M.screenMargin)
        let left = max(M.screenMargin, min(window.width - M.width - M.screenMargin, anchor.maxX - M.width))
        menu = CGRect(x: left, y: top, width: M.width, height: M.height)
        icon = CGRect(x: M.paddingH, y: (M.height - M.iconSize) / 2, width: M.iconSize, height: M.iconSize)
        let labelX = icon.maxX + M.iconGap
        let size = label.size(fitting: max(0, M.width - labelX - M.paddingH))
        self.label = CGRect(x: labelX, y: (M.height - size.height) / 2, width: size.width, height: size.height)
    }
}
