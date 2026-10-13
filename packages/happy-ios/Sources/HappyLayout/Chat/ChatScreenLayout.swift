import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The session screen (SessionView.tsx with AgentContentView's floating
/// dock, the phone layout):
///
///   - the list fills the screen and runs under the navigation bar and the
///     dock; its insets keep the newest message just above the dock and the
///     oldest just below the bar (+12);
///   - the dock is docked to the keyboard: its bottom is the keyboard's top,
///     or the safe area's bottom while the keyboard is down. During an
///     interactive dismiss the keyboard top follows the finger, and so does
///     the dock, because this one function places both;
///   - inside the dock, the bars above the composer (question banner, goal,
///     rig activity…) stack top to bottom, 8 in from the sides
///     (CenteredInputWidth), then the composer, full width;
///   - the scroll-to-bottom button floats 16 above the dock, centred.
public struct ChatScreenLayout: Equatable, Sendable {
    public enum Metrics {
        /// sessionInputHorizontalPadding on a phone.
        public static let accessoryPaddingH: CGFloat = 8
        /// chatListTopContentInset's 12 under the header.
        public static let olderEdgeExtra: CGFloat = 12
        /// The list content's paddingTop (inverted: above the dock).
        public static let newerEdgeExtra: CGFloat = 8
        public static let scrollButtonSize: CGFloat = 32
        public static let scrollButtonGap: CGFloat = 16
        /// The reader is "away" from the newest message past this.
        public static let scrollButtonThreshold: CGFloat = 300
        /// The bars above the composer hide past 48 and come back within 16.
        public static let dockDetailsHideOffset: CGFloat = 48
        public static let dockDetailsShowOffset: CGFloat = 16
        /// The fade behind the dock reaches 28 above it.
        public static let scrimExtra: CGFloat = 28
    }

    public struct Input {
        public var size: CGSize
        /// Safe area, with the navigation bar in `top`.
        public var safeArea: LayoutInsets
        /// The keyboard's top in this view, or nil while it is down or
        /// undocked.
        public var keyboardTop: CGFloat?
        /// Bars above the composer, top to bottom.
        public var accessories: [Measurable]
        public var composerHeight: CGFloat
        public var maxContentWidth: CGFloat

        public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat?, accessories: [Measurable] = [], composerHeight: CGFloat, maxContentWidth: CGFloat = .greatestFiniteMagnitude) {
            self.size = size
            self.safeArea = safeArea
            self.keyboardTop = keyboardTop
            self.accessories = accessories
            self.composerHeight = composerHeight
            self.maxContentWidth = maxContentWidth
        }
    }

    public var list: CGRect
    /// Inset at the newest edge (the bottom of the screen; the flipped
    /// list's top inset).
    public var newestEdgeInset: CGFloat
    /// Inset at the oldest edge (under the navigation bar).
    public var oldestEdgeInset: CGFloat
    public var dock: CGRect
    /// Accessory frames, in the dock.
    public var accessories: [CGRect]
    /// The composer, in the dock.
    public var composer: CGRect
    public var scrollButton: CGRect
    /// The fade behind the dock, from 28 above it to the screen's bottom.
    public var scrim: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)
        list = CGRect(x: 0, y: 0, width: width, height: height)

        let column = ChatColumn(rowWidth: width, maxContentWidth: input.maxContentWidth)
        let accessoryX = column.x + M.accessoryPaddingH
        let accessoryWidth = max(0, column.width - 2 * M.accessoryPaddingH)
        var y: CGFloat = 0
        var frames: [CGRect] = []
        for accessory in input.accessories {
            let size = accessory.height(fitting: accessoryWidth)
            frames.append(CGRect(x: accessoryX, y: y, width: accessoryWidth, height: size))
            y += size
        }
        accessories = frames
        composer = CGRect(x: 0, y: y, width: width, height: max(0, input.composerHeight))
        let dockHeight = y + max(0, input.composerHeight)

        let restingBottom = height - input.safeArea.bottom
        let bottom = min(restingBottom, input.keyboardTop ?? restingBottom)
        dock = CGRect(x: 0, y: bottom - dockHeight, width: width, height: dockHeight)
        newestEdgeInset = max(0, height - dock.minY) + M.newerEdgeExtra
        oldestEdgeInset = input.safeArea.top + M.olderEdgeExtra
        scrollButton = CGRect(
            x: (width - M.scrollButtonSize) / 2,
            y: dock.minY - M.scrollButtonGap - M.scrollButtonSize,
            width: M.scrollButtonSize,
            height: M.scrollButtonSize
        )
        scrim = CGRect(x: 0, y: dock.minY - M.scrimExtra, width: width, height: max(0, height - dock.minY + M.scrimExtra))
    }

    /// ChatList's hysteresis for the bars above the composer: shown at the
    /// newest message, hidden once the reader is 48 back, shown again only
    /// within 16.
    public static func dockDetailsVisible(distanceFromNewest: CGFloat, currentlyVisible: Bool) -> Bool {
        currentlyVisible
            ? distanceFromNewest <= Metrics.dockDetailsHideOffset
            : distanceFromNewest <= Metrics.dockDetailsShowOffset
    }

    public static func showsScrollButton(distanceFromNewest: CGFloat) -> Bool {
        distanceFromNewest > Metrics.scrollButtonThreshold
    }
}

/// AgentQuestionBanner: a rounded card above the composer.
///
///     12 ┌ 1 border, 12 ─ [icon 24] 10 title / subtitle ─ 10 [› or Dismiss] 12 ┐ 12
///        └ 10 above and below the text ────────────────────────────────────────┘
///     8
public struct QuestionBannerLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginH: CGFloat = 12
        public static let marginBottom: CGFloat = 8
        public static let paddingH: CGFloat = 12
        public static let paddingV: CGFloat = 10
        public static let border: CGFloat = 1
        public static let radius: CGFloat = 14
        public static let iconWidth: CGFloat = 24
        public static let iconSize: CGFloat = 20
        public static let gap: CGFloat = 10
    }

    public var size: CGSize
    public var card: CGRect
    public var icon: CGRect
    public var title: CGRect
    public var subtitle: CGRect
    public var trailing: CGRect

    public init(width: CGFloat, title: Measurable, subtitle: Measurable, trailing: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let cardWidth = max(0, width - 2 * M.marginH)
        let inset = M.border + M.paddingH
        let trailingSize = trailing.size(fitting: cardWidth)
        let bodyX = inset + M.iconWidth + M.gap
        let bodyWidth = max(0, cardWidth - bodyX - M.gap - trailingSize.width - inset)
        let titleHeight = title.height(fitting: bodyWidth)
        let subtitleHeight = subtitle.height(fitting: bodyWidth)
        let bodyHeight = titleHeight + subtitleHeight
        let contentHeight = max(M.iconSize, bodyHeight, trailingSize.height)
        let top = M.border + M.paddingV
        func centred(_ height: CGFloat) -> CGFloat { top + (contentHeight - height) / 2 }
        card = CGRect(x: M.marginH, y: 0, width: cardWidth, height: contentHeight + 2 * top)
        icon = CGRect(x: card.minX + inset + (M.iconWidth - M.iconSize) / 2, y: centred(M.iconSize), width: M.iconSize, height: M.iconSize)
        let bodyTop = centred(bodyHeight)
        self.title = CGRect(x: card.minX + bodyX, y: bodyTop, width: bodyWidth, height: titleHeight)
        self.subtitle = CGRect(x: card.minX + bodyX, y: bodyTop + titleHeight, width: bodyWidth, height: subtitleHeight)
        self.trailing = CGRect(x: card.maxX - inset - trailingSize.width, y: centred(trailingSize.height), width: trailingSize.width, height: trailingSize.height)
        size = CGSize(width: width, height: card.height + M.marginBottom)
    }
}

/// AgentGoalBar: the current goal above the composer.
///
///     ┌ 1 border, 12 ─ [◎ 18] 10 "Current goal" / goal text ─ 10 [actions 30, 4 apart] 12 ┐
///     └ 10 above and below ─────────────────────────────────────────────────────────────────┘
///     8
public struct GoalBarLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 12
        public static let paddingV: CGFloat = 10
        public static let border: CGFloat = 1
        public static let radius: CGFloat = 14
        public static let iconSize: CGFloat = 18
        public static let gap: CGFloat = 10
        public static let actionSize: CGFloat = 30
        public static let actionGap: CGFloat = 4
        public static let actionIconSize: CGFloat = 16
        public static let marginBottom: CGFloat = 8
    }

    public var size: CGSize
    public var card: CGRect
    public var icon: CGRect
    public var label: CGRect
    public var text: CGRect
    public var actions: [CGRect]

    public init(width: CGFloat, label: Measurable, text: Measurable, actionCount: Int) {
        typealias M = Metrics
        let width = max(0, width)
        let inset = M.border + M.paddingH
        let actionsWidth = actionCount > 0 ? CGFloat(actionCount) * M.actionSize + CGFloat(actionCount - 1) * M.actionGap : 0
        let bodyX = inset + M.iconSize + M.gap
        let bodyRight = width - inset - (actionCount > 0 ? actionsWidth + M.gap : 0)
        let bodyWidth = max(0, bodyRight - bodyX)
        let labelHeight = label.height(fitting: bodyWidth)
        let textHeight = text.height(fitting: bodyWidth)
        let bodyHeight = labelHeight + textHeight
        let contentHeight = max(M.iconSize, bodyHeight, actionCount > 0 ? M.actionSize : 0)
        let top = M.border + M.paddingV
        func centred(_ height: CGFloat) -> CGFloat { top + (contentHeight - height) / 2 }
        card = CGRect(x: 0, y: 0, width: width, height: contentHeight + 2 * top)
        icon = CGRect(x: inset, y: centred(M.iconSize), width: M.iconSize, height: M.iconSize)
        let bodyTop = centred(bodyHeight)
        self.label = CGRect(x: bodyX, y: bodyTop, width: bodyWidth, height: labelHeight)
        self.text = CGRect(x: bodyX, y: bodyTop + labelHeight, width: bodyWidth, height: textHeight)
        var x = width - inset - actionsWidth
        actions = (0..<max(0, actionCount)).map { _ in
            defer { x += M.actionSize + M.actionGap }
            return CGRect(x: x, y: centred(M.actionSize), width: M.actionSize, height: M.actionSize)
        }
        size = CGSize(width: width, height: card.height + M.marginBottom)
    }
}

/// RigActivityBar: "2 agents · 1 processes", wrapping, 16 in, 5 above and
/// below, 10 between indicators, a 12 pt glyph 4 before each count.
public struct RigActivityLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingH: CGFloat = 16
        public static let paddingV: CGFloat = 5
        public static let gap: CGFloat = 10
        public static let iconSize: CGFloat = 12
        public static let iconGap: CGFloat = 4
    }

    public var size: CGSize
    public var icons: [CGRect]
    public var labels: [CGRect]

    public init(width: CGFloat, labels input: [Measurable]) {
        typealias M = Metrics
        let width = max(0, width)
        let right = width - M.paddingH
        var x = M.paddingH
        var y = M.paddingV
        var lineHeight: CGFloat = 0
        var icons: [CGRect] = []
        var labels: [CGRect] = []
        var placed: [(icon: CGRect, label: CGRect)] = []
        var line: [Int] = []
        func closeLine() {
            // Items on a line are centred on it.
            for index in line {
                let item = placed[index]
                icons.append(CGRect(x: item.icon.minX, y: y + (lineHeight - M.iconSize) / 2, width: M.iconSize, height: M.iconSize))
                labels.append(CGRect(x: item.label.minX, y: y + (lineHeight - item.label.height) / 2, width: item.label.width, height: item.label.height))
            }
            line = []
        }
        for label in input {
            let text = label.size(fitting: max(0, right - M.paddingH - M.iconSize - M.iconGap))
            let itemWidth = M.iconSize + M.iconGap + text.width
            if !line.isEmpty, x + itemWidth > right {
                closeLine()
                y += lineHeight + M.gap
                x = M.paddingH
                lineHeight = 0
            }
            placed.append((CGRect(x: x, y: 0, width: M.iconSize, height: M.iconSize), CGRect(x: x + M.iconSize + M.iconGap, y: 0, width: text.width, height: text.height)))
            line.append(placed.count - 1)
            lineHeight = max(lineHeight, M.iconSize, text.height)
            x += itemWidth + M.gap
        }
        closeLine()
        self.icons = icons
        self.labels = labels
        size = CGSize(width: width, height: input.isEmpty ? 0 : y + lineHeight + M.paddingV)
    }
}
