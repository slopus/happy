import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// The iPad sidebar's list grouped by project: SessionsList.tsx's own rows
// (iOS values), which the sidebar shows instead of home's project cards.
// The bots' rows are home's `FlatSessionRowLayout` and the archive toggle
// is `ArchiveToggleLayout.unbanded`.

/// "Bots", or a day over the archive (SessionsList.tsx `headerSection`): a
/// label 24 in, 20 below the row above and 8 above the next.
public struct TabletSectionHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 24
        public static let paddingTop: CGFloat = 20
        public static let paddingBottom: CGFloat = 8
    }

    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, label: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let labelWidth = max(0, width - 2 * M.paddingHorizontal)
        let height = label.height(fitting: labelWidth)
        self.label = CGRect(x: M.paddingHorizontal, y: M.paddingTop, width: labelWidth, height: height)
        size = CGSize(width: width, height: M.paddingTop + height + M.paddingBottom)
    }
}

/// SessionsList.tsx `MachineHeader`: a hairline, the desktop glyph, the
/// computer's name (at most 60% of the row) and a second hairline, the two
/// lines sharing what is left.
///
///     |32| ───────── |6| 🖥 |6| name |4| ───────── |32|
public struct TabletMachineRuleLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 32
        public static let paddingTop: CGFloat = 8
        public static let iconMargin: CGFloat = 6
        public static let iconSize: CGFloat = 11
        public static let nameMarginRight: CGFloat = 4
        public static let nameMaxFraction: CGFloat = 0.6
        /// `hitSlop={{ top: 8, bottom: 8 }}`.
        public static let hitSlop: CGFloat = 8
    }

    public var size: CGSize
    public var leadingLine: CGRect
    public var icon: CGRect
    public var name: CGRect
    public var trailingLine: CGRect

    /// `icon` is desktop-outline's box at 11 (`Icon.layout`).
    public init(width: CGFloat, hairline: CGFloat, icon: CGSize, name: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - 2 * M.paddingHorizontal)
        let nameMax = inner * M.nameMaxFraction
        let fitted = name.size(fitting: nameMax)
        let text = CGSize(width: min(fitted.width, nameMax), height: fitted.height)
        let fixed = M.iconMargin + icon.width + M.iconMargin + text.width + M.nameMarginRight
        let lineWidth = max(0, (inner - fixed) / 2)
        let rowHeight = max(icon.height, text.height, hairline)
        let midY = M.paddingTop + rowHeight / 2
        leadingLine = CGRect(x: M.paddingHorizontal, y: midY - hairline / 2, width: lineWidth, height: hairline)
        self.icon = CGRect(x: leadingLine.maxX + M.iconMargin, y: midY - icon.height / 2, width: icon.width, height: icon.height)
        self.name = CGRect(x: self.icon.maxX + M.iconMargin, y: midY - text.height / 2, width: text.width, height: text.height)
        trailingLine = CGRect(x: self.name.maxX + M.nameMarginRight, y: leadingLine.minY, width: lineWidth, height: hairline)
        size = CGSize(width: width, height: M.paddingTop + rowHeight)
    }
}

/// ProjectGroup.tsx `WorkspaceSection`'s heading: the first chat's face,
/// the project's name over its branch and line changes, and a round `+`.
///
///     |20| face 30 |8| name …………………… |8| (+) |26|
///     |            |  branch |6| +12 -3 |
///
/// Everything is centred on one line, 12 below the card above and 6 above
/// its own card.
public struct TabletWorkspaceHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingTop: CGFloat = 12
        public static let paddingBottom: CGFloat = 6
        public static let paddingLeft: CGFloat = 20
        public static let paddingRight: CGFloat = 26
        public static let gap: CGFloat = 8
        public static let avatarSize: CGFloat = 30
        public static let addButtonSize: CGFloat = 30
        public static let addIconSize: CGFloat = 18
        public static let branchGap: CGFloat = 6
        /// `hitSlop={12}` on the `+`.
        public static let addHitSlop: CGFloat = 12
    }

    public struct Input {
        public var width: CGFloat
        public var title: Measurable
        public var branch: Measurable
        /// GitLineChanges' size; nil when nothing changed.
        public var changes: CGSize?

        public init(width: CGFloat, title: Measurable, branch: Measurable, changes: CGSize?) {
            self.width = width
            self.title = title
            self.branch = branch
            self.changes = changes
        }
    }

    public var size: CGSize
    public var avatar: CGRect
    public var title: CGRect
    public var branch: CGRect
    public var changes: CGRect?
    public var addButton: CGRect
    public var addIcon: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let textX = M.paddingLeft + M.avatarSize + M.gap
        let addX = max(textX, width - M.paddingRight - M.addButtonSize)
        let textWidth = max(0, addX - M.gap - textX)

        let titleHeight = input.title.height(fitting: textWidth)
        let changesWidth = input.changes.map { $0.width + M.branchGap } ?? 0
        let branchSize = input.branch.size(fitting: max(0, textWidth - changesWidth))
        let branchWidth = min(branchSize.width, max(0, textWidth - changesWidth))
        let lineHeight = max(branchSize.height, input.changes?.height ?? 0)
        let textHeight = titleHeight + lineHeight
        let rowHeight = max(M.avatarSize, textHeight, M.addButtonSize)
        let midY = M.paddingTop + rowHeight / 2

        avatar = CGRect(x: M.paddingLeft, y: midY - M.avatarSize / 2, width: M.avatarSize, height: M.avatarSize)
        let textY = midY - textHeight / 2
        title = CGRect(x: textX, y: textY, width: textWidth, height: titleHeight)
        let lineMid = textY + titleHeight + lineHeight / 2
        branch = CGRect(x: textX, y: lineMid - branchSize.height / 2, width: branchWidth, height: branchSize.height)
        changes = input.changes.map {
            CGRect(x: textX + branchWidth + M.branchGap, y: lineMid - $0.height / 2, width: $0.width, height: $0.height)
        }
        addButton = CGRect(x: addX, y: midY - M.addButtonSize / 2, width: M.addButtonSize, height: M.addButtonSize)
        addIcon = CGRect(
            x: addButton.midX - M.addIconSize / 2,
            y: addButton.midY - M.addIconSize / 2,
            width: M.addIconSize,
            height: M.addIconSize
        )
        size = CGSize(width: width, height: M.paddingTop + rowHeight + M.paddingBottom)
    }
}

/// One chat in its checkout's card (ActiveSessionsGroupCompact.tsx
/// `CompactSessionRow` inside ProjectGroup.tsx's `workspaceCard`). The card
/// is one rounded, hairline-framed surface across its rows' cells: each
/// cell draws the card taller than itself where the card goes on, so only
/// its own edge and corners show.
///
///     |16| ┌ |16| title, up to two lines …… |8| ● |16| ┐ |16|
///
/// A row is 56 tall inside the card's border; the last one is followed by
/// the card's 8 and, closing its project, the group's 4.
public struct TabletChatRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let cardMarginHorizontal: CGFloat = 16
        public static let cardMarginBottom: CGFloat = 8
        public static let cardRadius: CGFloat = 18
        public static let projectMarginBottom: CGFloat = 4
        public static let rowHeight: CGFloat = 56
        public static let paddingHorizontal: CGFloat = 16
        public static let indicatorSlot: CGFloat = 18
        public static let indicatorMarginLeft: CGFloat = 8
        /// StatusDot's default size.
        public static let dotSize: CGFloat = 6
        /// Swipeable's archive action.
        public static let swipeActionWidth: CGFloat = 112
    }

    public struct Input {
        public var width: CGFloat
        public var hairline: CGFloat
        public var title: Measurable
        public var first: Bool
        public var last: Bool
        public var projectEnd: Bool
        public var showsBorder: Bool

        public init(width: CGFloat, hairline: CGFloat, title: Measurable, first: Bool, last: Bool, projectEnd: Bool, showsBorder: Bool) {
            self.width = width
            self.hairline = hairline
            self.title = title
            self.first = first
            self.last = last
            self.projectEnd = projectEnd
            self.showsBorder = showsBorder
        }
    }

    public var size: CGSize
    /// The card as drawn, past the cell where it goes on; the cell clips it.
    public var card: CGRect
    /// The pressable row inside the card's border: the selected fill.
    public var row: CGRect
    public var title: CGRect
    /// `trailingIndicatorSlot`, 18 square: what centres the dot, or the
    /// draft's 14 glyph (an `IconView` given this frame centres it as
    /// Yoga does).
    public var indicator: CGRect
    public var dot: CGRect
    public var divider: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let line = input.hairline
        let top: CGFloat = input.first ? line : 0
        let rowWidth = max(0, width - 2 * M.cardMarginHorizontal - 2 * line)
        row = CGRect(x: M.cardMarginHorizontal + line, y: top, width: rowWidth, height: M.rowHeight)
        let cardBottom = input.last ? row.maxY + line : row.maxY + M.cardRadius + line
        let cardTop = input.first ? 0 : -(M.cardRadius + line)
        card = CGRect(
            x: M.cardMarginHorizontal,
            y: cardTop,
            width: max(0, width - 2 * M.cardMarginHorizontal),
            height: cardBottom - cardTop
        )
        let slotX = row.maxX - M.paddingHorizontal - M.indicatorSlot
        indicator = CGRect(x: slotX, y: row.midY - M.indicatorSlot / 2, width: M.indicatorSlot, height: M.indicatorSlot)
        dot = CGRect(x: indicator.midX - M.dotSize / 2, y: indicator.midY - M.dotSize / 2, width: M.dotSize, height: M.dotSize)
        let titleX = row.minX + M.paddingHorizontal
        let titleWidth = max(0, slotX - M.indicatorMarginLeft - titleX)
        let titleHeight = input.title.height(fitting: titleWidth)
        title = CGRect(x: titleX, y: row.midY - titleHeight / 2, width: titleWidth, height: titleHeight)
        divider = input.showsBorder ? CGRect(x: row.minX, y: row.maxY - line, width: row.width, height: line) : nil
        var height = row.maxY
        if input.last { height += line + M.cardMarginBottom }
        if input.projectEnd { height += M.projectMarginBottom }
        size = CGSize(width: width, height: height)
    }
}

/// SessionsList.tsx `SessionItem`: an archived chat as a hairline-framed
/// card of its own, rounded 12 at the top after a day heading and at the
/// bottom before the next one.
///
///     |16| ┌ |16| avatar 48 |16| title ………………………… |16| ┐ |16|
///     |    |               | (provider |4|) subtitle
///     |    |               | ● status · …
///
/// The card is 88 inside its border; 1 separates cards, 12 follows a day's
/// last one. The three lines are centred together.
public struct TabletArchivedRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginHorizontal: CGFloat = 16
        public static let marginBottom: CGFloat = 1
        public static let lastMarginBottom: CGFloat = 12
        public static let radius: CGFloat = 12
        public static let rowHeight: CGFloat = 88
        public static let paddingHorizontal: CGFloat = 16
        public static let avatarSize: CGFloat = 48
        public static let contentMarginLeft: CGFloat = 16
        public static let titleMarginBottom: CGFloat = 2
        /// Only the identity and path lines are a row with this under them.
        public static let subtitleMarginBottom: CGFloat = 4
        /// ProviderIcon's size ahead of the identity, and the row's gap.
        public static let providerIconSize: CGFloat = 13
        public static let subtitleIconGap: CGFloat = 4
        public static let dotSlotHeight: CGFloat = 16
        public static let dotSlotMarginTop: CGFloat = 2
        public static let dotSlotMarginRight: CGFloat = 4
        /// StatusDot's default size.
        public static let dotSize: CGFloat = 6
        /// `draftIconContainer`: 18 square, 2 past the avatar's bottom
        /// right corner, the 12 glyph centred in it.
        public static let draftOverlaySize: CGFloat = 18
        public static let draftOverlayOutset: CGFloat = 2
    }

    public struct Input {
        public var width: CGFloat
        public var hairline: CGFloat
        public var title: Measurable
        public var subtitle: Measurable
        /// The subtitle sits in its row, with the 4 under it.
        public var subtitleRow: Bool
        /// The provider glyph's box ahead of the identity line; nil without
        /// one.
        public var subtitleIcon: CGSize?
        public var status: Measurable
        public var last: Bool

        public init(width: CGFloat, hairline: CGFloat, title: Measurable, subtitle: Measurable, subtitleRow: Bool, subtitleIcon: CGSize? = nil, status: Measurable, last: Bool) {
            self.width = width
            self.hairline = hairline
            self.title = title
            self.subtitle = subtitle
            self.subtitleRow = subtitleRow
            self.subtitleIcon = subtitleIcon
            self.status = status
            self.last = last
        }
    }

    public var size: CGSize
    public var card: CGRect
    /// The pressable inside the border: the selected fill.
    public var row: CGRect
    public var avatar: CGRect
    /// The draft glyph's container over the avatar's corner; an `IconView`
    /// given this frame centres the glyph in it.
    public var draftOverlay: CGRect
    public var title: CGRect
    public var subtitle: CGRect
    public var subtitleIcon: CGRect?
    public var dot: CGRect
    public var status: CGRect

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let line = input.hairline
        card = CGRect(
            x: M.marginHorizontal,
            y: 0,
            width: max(0, width - 2 * M.marginHorizontal),
            height: M.rowHeight + 2 * line
        )
        row = card.insetBy(dx: line, dy: line)
        avatar = CGRect(
            x: row.minX + M.paddingHorizontal,
            y: row.midY - M.avatarSize / 2,
            width: M.avatarSize,
            height: M.avatarSize
        )
        draftOverlay = CGRect(
            x: avatar.maxX + M.draftOverlayOutset - M.draftOverlaySize,
            y: avatar.maxY + M.draftOverlayOutset - M.draftOverlaySize,
            width: M.draftOverlaySize,
            height: M.draftOverlaySize
        )
        let x = avatar.maxX + M.contentMarginLeft
        let contentWidth = max(0, row.maxX - M.paddingHorizontal - x)

        let titleHeight = input.title.height(fitting: contentWidth)
        let iconWidth = input.subtitleIcon.map { $0.width + M.subtitleIconGap } ?? 0
        let subtitleWidth = max(0, contentWidth - iconWidth)
        let subtitleSize = input.subtitle.size(fitting: subtitleWidth)
        let subtitleLine = max(subtitleSize.height, input.subtitleIcon?.height ?? 0)
        let subtitleGap = input.subtitleRow ? M.subtitleMarginBottom : 0
        let slotHeight = M.dotSlotMarginTop + M.dotSlotHeight
        let statusX = x + M.dotSize + M.dotSlotMarginRight
        let statusHeight = input.status.height(fitting: max(0, contentWidth - M.dotSize - M.dotSlotMarginRight))
        let statusRow = max(slotHeight, statusHeight)
        let total = titleHeight + M.titleMarginBottom + subtitleLine + subtitleGap + statusRow

        var y = row.midY - total / 2
        title = CGRect(x: x, y: y, width: contentWidth, height: titleHeight)
        y += titleHeight + M.titleMarginBottom
        subtitleIcon = input.subtitleIcon.map {
            CGRect(x: x, y: y + (subtitleLine - $0.height) / 2, width: $0.width, height: $0.height)
        }
        subtitle = CGRect(
            x: x + iconWidth,
            y: y + (subtitleLine - subtitleSize.height) / 2,
            width: min(subtitleSize.width, subtitleWidth),
            height: subtitleSize.height
        )
        y += subtitleLine + subtitleGap
        let slotY = y + (statusRow - slotHeight) / 2 + M.dotSlotMarginTop
        dot = CGRect(x: x, y: slotY + (M.dotSlotHeight - M.dotSize) / 2, width: M.dotSize, height: M.dotSize)
        status = CGRect(
            x: statusX,
            y: y + (statusRow - statusHeight) / 2,
            width: max(0, row.maxX - M.paddingHorizontal - statusX),
            height: statusHeight
        )
        size = CGSize(width: width, height: card.maxY + (input.last ? M.lastMarginBottom : M.marginBottom))
    }
}

/// The grouped list's rows whose height never depends on their text, from
/// their layouts fed empty content (as `HomeRowHeights`), so a changed row
/// costs no text measurement on the main thread.
public enum TabletGroupedRowHeights {
    private static var empty: Measurable { .fixed(.zero) }

    public static func chat(width: CGFloat, hairline: CGFloat, first: Bool, last: Bool, projectEnd: Bool) -> CGFloat {
        TabletChatRowLayout(.init(
            width: width, hairline: hairline, title: empty, first: first, last: last, projectEnd: projectEnd, showsBorder: false
        )).size.height
    }

    public static func archived(width: CGFloat, hairline: CGFloat, last: Bool) -> CGFloat {
        TabletArchivedRowLayout(.init(
            width: width, hairline: hairline, title: empty, subtitle: empty, subtitleRow: false, status: empty, last: last
        )).size.height
    }
}
