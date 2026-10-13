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
///   - inside the dock, the bars above the composer (goal, question banner,
///     rig activity) stack top to bottom, 8 in from the sides
///     (CenteredInputWidth) unless they run full width as the rig activity
///     bar does, then the composer, full width;
///   - the scroll-to-bottom button floats 16 above the composer's card,
///     centred (SessionView's scrollButtonInset). The bars above the card fade
///     out but keep their space while the reader is scrolled back, so the
///     button floats over an empty band;
///   - the header's scrim covers the bar and 8 past it (ChatHeaderView's
///     headerBackdrop), and an empty chat's placeholder is centred between
///     the bar and the dock (AgentContentView).
///
/// On a tablet (`docked`) nothing floats: the list starts under the bar and
/// stops at the dock (SessionView's `contentRunsUnderHeader` and
/// `usesFloatingMobileDock` are false), the newest message sits 8 above
/// the dock, the oldest end leaves ChatList's fallback spacer (the bar, the
/// status bar and 32 more, on top of starting under the bar), the scroll
/// button floats 4 above the list's bottom, there is no fade behind the
/// dock, and the bars above the composer sit 12 in.
///
/// A phone on its side (`hidesHeader`, SessionView's
/// `hidesLandscapeHeader`) is docked the same way with no header at all:
/// the list starts under the status bar with 12 before its oldest end, a
/// 44pt round back button floats 16 in and 8 under the status bar, and
/// the status bar gets a shadowed strip of its own.
///
/// Something under the header (`headerAccessory`, the worktree tab strip)
/// rides with it: on a phone the oldest end clears it too
/// (`chatListTopContentInset`'s `headerAccessoryHeight`); on a tablet the
/// list starts under it and the oldest end's spacer stays as it was. With
/// no header there is nothing for it to hang from.
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
        /// Docked: ChatList's SCROLL_BUTTON_DOCK_GAP above the list's bottom.
        public static let dockedScrollButtonGap: CGFloat = 4
        /// Docked: OlderEnd's `headerHeight + safeArea.top + 32`.
        public static let dockedOlderEdgeExtra: CGFloat = 32
        /// The header's scrim runs 8 past the bar (headerBackdrop bottom -8).
        public static let headerScrimOverhang: CGFloat = 8
        /// Without the header: `chatListTopContentInset`'s 12.
        public static let headerlessOlderEdgeExtra: CGFloat = 12
        /// The floating back button that stands in for the header.
        public static let backButtonSize: CGFloat = 44
        public static let backButtonLeft: CGFloat = 16
        public static let backButtonTop: CGFloat = 8
        /// layout.maxWidth off a phone (tablet and web: 800; a phone is never
        /// limited).
        public static let regularMaxContentWidth: CGFloat = 800
    }

    /// A bar above the composer.
    public struct Accessory {
        public var content: Measurable
        /// In the composer's column, 8 in from its sides; otherwise the
        /// full width of the screen.
        public var inset: Bool

        public static func inset(_ content: Measurable) -> Accessory { Accessory(content: content, inset: true) }
        public static func fullWidth(_ content: Measurable) -> Accessory { Accessory(content: content, inset: false) }
    }

    public struct Input {
        public var size: CGSize
        /// Safe area, with the navigation bar in `top`.
        public var safeArea: LayoutInsets
        /// The keyboard's top in this view, or nil while it is down or
        /// undocked.
        public var keyboardTop: CGFloat?
        /// Bars above the composer, top to bottom.
        public var accessories: [Accessory]
        public var composerHeight: CGFloat
        /// Where the composer's card starts below the composer's top (its
        /// status rows sit above the card).
        public var composerCardOffset: CGFloat
        public var maxContentWidth: CGFloat
        /// The tablet layout: the list stops at the dock instead of
        /// running under it and the bar.
        public var docked: Bool
        /// `sessionInputHorizontalPadding`: 8 on a phone, 12 on a tablet.
        public var accessoryPaddingH: CGFloat
        /// A phone on its side: no header, docked. `safeArea.top` is then
        /// the status bar's alone.
        public var hidesHeader: Bool
        /// The height of what hangs under the header, margins included.
        public var headerAccessory: CGFloat

        public init(
            size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat?, accessories: [Accessory] = [], composerHeight: CGFloat,
            composerCardOffset: CGFloat = 0, maxContentWidth: CGFloat = .greatestFiniteMagnitude,
            docked: Bool = false, accessoryPaddingH: CGFloat = Metrics.accessoryPaddingH, hidesHeader: Bool = false,
            headerAccessory: CGFloat = 0
        ) {
            self.size = size
            self.safeArea = safeArea
            self.keyboardTop = keyboardTop
            self.accessories = accessories
            self.composerHeight = composerHeight
            self.composerCardOffset = composerCardOffset
            self.maxContentWidth = maxContentWidth
            self.docked = docked
            self.accessoryPaddingH = accessoryPaddingH
            self.hidesHeader = hidesHeader
            self.headerAccessory = headerAccessory
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
    /// The scrim behind the navigation bar.
    public var headerScrim: CGRect
    /// Where an empty chat's placeholder is centred: under the bar, above
    /// the dock.
    public var placeholder: CGRect
    /// Without the header: the back button that stands in for it, and the
    /// status bar's strip.
    public var backButton: CGRect?
    public var statusBarShadow: CGRect?
    /// What hangs under the header, full width; nil without a header.
    public var headerAccessory: CGRect?
    /// The header's bottom, past what hangs under it: where the CLI pill
    /// goes.
    public var headerBottom: CGFloat

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.size.width)
        let height = max(0, input.size.height)
        list = CGRect(x: 0, y: 0, width: width, height: height)

        let column = ChatColumn(rowWidth: width, maxContentWidth: input.maxContentWidth)
        let accessoryX = column.x + input.accessoryPaddingH
        let accessoryWidth = max(0, column.width - 2 * input.accessoryPaddingH)
        var y: CGFloat = 0
        var frames: [CGRect] = []
        for accessory in input.accessories {
            let x = accessory.inset ? accessoryX : 0
            let accessoryWidth = accessory.inset ? accessoryWidth : width
            let size = accessory.content.height(fitting: accessoryWidth)
            frames.append(CGRect(x: x, y: y, width: accessoryWidth, height: size))
            y += size
        }
        accessories = frames
        composer = CGRect(x: 0, y: y, width: width, height: max(0, input.composerHeight))
        let dockHeight = y + max(0, input.composerHeight)

        let restingBottom = height - input.safeArea.bottom
        let bottom = min(restingBottom, input.keyboardTop ?? restingBottom)
        dock = CGRect(x: 0, y: bottom - dockHeight, width: width, height: dockHeight)
        let accessory = input.hidesHeader ? 0 : max(0, input.headerAccessory)
        headerAccessory = input.hidesHeader ? nil : CGRect(x: 0, y: input.safeArea.top, width: width, height: accessory)
        headerBottom = input.safeArea.top + accessory
        newestEdgeInset = max(0, height - dock.minY) + M.newerEdgeExtra
        oldestEdgeInset = headerBottom + M.olderEdgeExtra
        scrollButton = CGRect(
            x: (width - M.scrollButtonSize) / 2,
            y: dock.minY + composer.minY + min(max(0, input.composerCardOffset), composer.height) - M.scrollButtonGap - M.scrollButtonSize,
            width: M.scrollButtonSize,
            height: M.scrollButtonSize
        )
        scrim = CGRect(x: 0, y: dock.minY - M.scrimExtra, width: width, height: max(0, height - dock.minY + M.scrimExtra))
        headerScrim = CGRect(x: 0, y: 0, width: width, height: max(0, input.safeArea.top) + M.headerScrimOverhang)
        placeholder = CGRect(x: 0, y: headerBottom, width: width, height: max(0, dock.minY - headerBottom))

        backButton = nil
        statusBarShadow = nil
        if input.docked || input.hidesHeader {
            let top = max(0, input.safeArea.top)
            list = CGRect(x: 0, y: top + accessory, width: width, height: max(0, dock.minY - top - accessory))
            newestEdgeInset = M.newerEdgeExtra
            oldestEdgeInset = input.hidesHeader ? M.headerlessOlderEdgeExtra : top + M.dockedOlderEdgeExtra
            scrollButton.origin.y = list.maxY - M.dockedScrollButtonGap - M.scrollButtonSize
            scrim = CGRect(x: 0, y: dock.minY, width: width, height: 0)
            headerScrim = CGRect(x: 0, y: 0, width: width, height: 0)
        }
        if input.hidesHeader {
            let top = max(0, input.safeArea.top)
            backButton = CGRect(x: M.backButtonLeft, y: top + M.backButtonTop, width: M.backButtonSize, height: M.backButtonSize)
            statusBarShadow = CGRect(x: 0, y: 0, width: width, height: top)
        }
    }

    /// ChatList's header backdrop: stronger once anything is scrolled under
    /// the header, which in the inverted list means the reader is short of
    /// the oldest end. Half a point absorbs a resting offset's rounding.
    public static func headerBackdropVisible(distanceFromOldest: CGFloat) -> Bool {
        distanceFromOldest > 0.5
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

/// SessionView's CLI version warning: a pill centred 8 under the header,
/// 14 and 7 inside, the warning glyph, the label 6 after it and the close
/// glyph 8 after that, all on one middle line.
public struct CliWarningPillLayout: Equatable, Sendable {
    public enum Metrics {
        public static let top: CGFloat = 8
        public static let paddingH: CGFloat = 14
        public static let paddingV: CGFloat = 7
        public static let iconSize: CGFloat = 14
        public static let iconGap: CGFloat = 6
        public static let closeGap: CGFloat = 8
        public static let shadowOpacity: Float = 0.15
        public static let shadowRadius: CGFloat = 4
        public static let shadowOffsetY: CGFloat = 2
    }

    public var pill: CGRect
    public var icon: CGRect
    public var label: CGRect
    public var close: CGRect

    /// `top` is the header's bottom.
    public init(width: CGFloat, top: CGFloat, label: Measurable) {
        typealias M = Metrics
        let chrome = 2 * M.paddingH + 2 * M.iconSize + M.iconGap + M.closeGap
        let labelSize = label.size(fitting: max(0, width - chrome))
        let line = max(M.iconSize, labelSize.height)
        let size = CGSize(width: chrome + labelSize.width, height: line + 2 * M.paddingV)
        pill = CGRect(x: (max(0, width) - size.width) / 2, y: top + M.top, width: size.width, height: size.height)
        let mid = pill.minY + M.paddingV + line / 2
        icon = CGRect(x: pill.minX + M.paddingH, y: mid - M.iconSize / 2, width: M.iconSize, height: M.iconSize)
        self.label = CGRect(x: icon.maxX + M.iconGap, y: mid - labelSize.height / 2, width: labelSize.width, height: labelSize.height)
        close = CGRect(x: self.label.maxX + M.closeGap, y: icon.minY, width: M.iconSize, height: M.iconSize)
    }
}

/// InactiveArchivedHint: the notice (and, without Resume, "To resume it
/// from the terminal:") 8 in, then 10 below it either the Resume button, 8
/// in and 44 tall with its label in the middle, or the command block, edge
/// to edge, 16 and 12 inside, the commands on the left and the copy glyph on
/// the right. 12 above, 10 below.
public struct InactiveHintLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 12
        public static let paddingBottom: CGFloat = 10
        public static let gap: CGFloat = 10
        public static let textInset: CGFloat = 8
        public static let textGap: CGFloat = 4
        public static let buttonHeight: CGFloat = 44
        public static let buttonInset: CGFloat = 8
        public static let radius: CGFloat = 18
        public static let commandMinHeight: CGFloat = 48
        public static let commandPaddingH: CGFloat = 16
        public static let commandPaddingV: CGFloat = 12
        public static let commandGap: CGFloat = 8
        public static let iconSize: CGFloat = 16
        public static let iconTop: CGFloat = 1
        /// The busy button.
        public static let resumingOpacity: CGFloat = 0.6
    }

    public enum Action {
        case none
        case resume(label: Measurable)
        case command(Measurable)
    }

    public var size: CGSize
    public var notice: CGRect
    public var terminalNotice: CGRect?
    public var button: CGRect?
    public var buttonLabel: CGRect?
    public var command: CGRect?
    public var commandText: CGRect?
    public var commandIcon: CGRect?

    public init(width: CGFloat, notice: Measurable, terminalNotice: Measurable?, action: Action) {
        typealias M = Metrics
        let width = max(0, width)
        let textWidth = max(0, width - 2 * M.textInset)
        var y = M.paddingTop
        let noticeHeight = notice.height(fitting: textWidth)
        self.notice = CGRect(x: M.textInset, y: y, width: textWidth, height: noticeHeight)
        y += noticeHeight
        if let terminalNotice {
            y += M.textGap
            let height = terminalNotice.height(fitting: textWidth)
            self.terminalNotice = CGRect(x: M.textInset, y: y, width: textWidth, height: height)
            y += height
        }
        switch action {
        case .none:
            break
        case .resume(let label):
            y += M.gap
            let button = CGRect(x: M.buttonInset, y: y, width: max(0, width - 2 * M.buttonInset), height: M.buttonHeight)
            let labelSize = label.size(fitting: button.width)
            self.button = button
            buttonLabel = CGRect(
                x: button.midX - labelSize.width / 2, y: button.midY - labelSize.height / 2,
                width: labelSize.width, height: labelSize.height
            )
            y += M.buttonHeight
        case .command(let text):
            y += M.gap
            let innerWidth = max(0, width - 2 * M.commandPaddingH - M.commandGap - M.iconSize)
            let textHeight = text.height(fitting: innerWidth)
            let height = max(M.commandMinHeight, textHeight + 2 * M.commandPaddingV)
            command = CGRect(x: 0, y: y, width: width, height: height)
            commandText = CGRect(x: M.commandPaddingH, y: y + M.commandPaddingV, width: innerWidth, height: textHeight)
            commandIcon = CGRect(x: width - M.commandPaddingH - M.iconSize, y: y + M.commandPaddingV + M.iconTop, width: M.iconSize, height: M.iconSize)
            y += height
        }
        size = CGSize(width: width, height: y + M.paddingBottom)
    }
}
