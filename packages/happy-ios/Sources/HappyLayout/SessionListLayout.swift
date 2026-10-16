import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One session in the flat home list (components/FlatSessionRow.tsx):
///
///     |16| avatar 60 |12| title ……………………………… |8| 12:55 PM |16|
///     |          (centred) | project
///     |                    | workspace ⑂ ……………………… ✎ |8| ≈ +12 -3 |16|
///     ──────────── hairline from x 88 to the right edge ────────────
///
/// At the designed text size the row is 10 + 22 + 20 + 1 + 18 + 10 = 81
/// tall. RN sizes it from its text: the title's row is its line, but never
/// less than the corner's 22; the project is its line; the workspace's row
/// is its line, but never less than 18. Larger text makes a taller row,
/// and a row with a workspace taller than one without. Happy Agent's line
/// counts end the workspace's row (RigGitLineChanges: 8 before them, at
/// its right edge); the workspace yields them the width, and their line
/// holds the row up as the workspace's does. A draft's 13 glyph
/// (`create-outline`) comes first in that meta, right against the counts'
/// 8; it keeps its size at every text size, so its box (13.33 tall at most)
/// never reaches the row's 18 and never changes a height. The avatar is
/// centred in the row, and the text column too when the avatar is the
/// taller. The corner slot is at least 56 wide and sized by the timestamp,
/// which stays measured while a dot covers it, so the title never jumps.
public struct FlatSessionRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingLeft: CGFloat = 16
        public static let paddingRight: CGFloat = 16
        public static let paddingVertical: CGFloat = 10
        public static let avatarSize: CGFloat = 60
        public static let avatarGap: CGFloat = 12
        public static let titleRowHeight: CGFloat = 22
        public static let cornerMinWidth: CGFloat = 56
        public static let cornerMarginLeft: CGFloat = 8
        public static let dotSize: CGFloat = 20
        public static let projectHeight: CGFloat = 20
        public static let workspaceMarginTop: CGFloat = 1
        public static let workspaceMinHeight: CGFloat = 18
        public static let workspaceIconGap: CGFloat = 4
        public static let branchIconSize: CGFloat = 13
        /// `workspaceMeta`'s draft glyph.
        public static let draftIconSize: CGFloat = 13
        /// RigGitLineChanges' `paddingLeft`.
        public static let changesPaddingLeft: CGFloat = 8
        /// One line of GitLineChanges' 11s, which set no line height: Plex's
        /// own, 1.3 em (ascender 1025 and descender 275 per 1000). A screen
        /// draws it up to its next pixel (14⅓, 14.5), short of the 18 the
        /// workspace's row keeps.
        public static let changesLine: CGFloat = 14.3
        public static let dividerHeight: CGFloat = 0.33

        /// Where the text column and the hairline start.
        public static var contentX: CGFloat { paddingLeft + avatarSize + avatarGap }
    }

    /// One line of each of the texts, as a one-line label draws it at the
    /// screen's text size. The rows are these lines, whatever the text
    /// says, so a row's height never needs its text measured.
    public struct Lines: Hashable, Sendable {
        public var title: CGFloat
        public var project: CGFloat
        public var workspace: CGFloat
        /// The line counts' line.
        public var changes: CGFloat

        public init(title: CGFloat, project: CGFloat, workspace: CGFloat, changes: CGFloat = Metrics.changesLine) {
            self.title = title
            self.project = project
            self.workspace = workspace
            self.changes = changes
        }

        /// The styles' own lines, at the designed text size: 22, 20, 18,
        /// and the counts' 14.3.
        public static let designed = Lines(
            title: Metrics.titleRowHeight,
            project: Metrics.projectHeight,
            workspace: Metrics.workspaceMinHeight,
            changes: Metrics.changesLine
        )
    }

    public struct Input {
        public var width: CGFloat
        public var title: Measurable
        public var timestamp: Measurable
        public var project: Measurable
        /// nil in a project's primary checkout.
        public var workspace: Measurable?
        /// The 13pt branch glyph's RN box (`Icon.layout`): one line of the
        /// icon font tall, 13 x 13.33 on a 3x screen.
        public var branchIcon: CGSize
        /// The line counts as drawn ("≈ +12 -3", which never wraps); nil
        /// without any.
        public var changes: CGSize?
        /// The 13pt draft glyph's RN box, as `branchIcon`'s; nil without a
        /// draft.
        public var draftIcon: CGSize?
        public var showsDivider: Bool
        public var lines: Lines

        public init(
            width: CGFloat,
            title: Measurable,
            timestamp: Measurable,
            project: Measurable,
            workspace: Measurable?,
            branchIcon: CGSize = CGSize(width: Metrics.branchIconSize, height: Metrics.branchIconSize),
            changes: CGSize? = nil,
            draftIcon: CGSize? = nil,
            showsDivider: Bool,
            lines: Lines = .designed
        ) {
            self.width = width
            self.title = title
            self.timestamp = timestamp
            self.project = project
            self.workspace = workspace
            self.branchIcon = branchIcon
            self.changes = changes
            self.draftIcon = draftIcon
            self.showsDivider = showsDivider
            self.lines = lines
        }
    }

    /// The row's height for these lines, with or without a workspace line
    /// under a glyph `branchIcon` tall, line counts and a draft glyph
    /// `draftIcon` tall (0 without one): what `init` makes `size.height`.
    /// The draft glyph is fixed and under the row's 18, so home's row
    /// heights leave it out (`HomeRowKind` doesn't carry it).
    public static func height(lines: Lines, workspace: Bool, changes: Bool = false, branchIcon: CGFloat = Metrics.branchIconSize, draftIcon: CGFloat = 0) -> CGFloat {
        typealias M = Metrics
        return M.paddingVertical * 2 + max(M.avatarSize, contentHeight(lines: lines, workspace: workspace, changes: changes, branchIcon: branchIcon, draftIcon: draftIcon))
    }

    /// The text column: the title's row, the project, 1, the workspace's
    /// row.
    private static func contentHeight(lines: Lines, workspace: Bool, changes: Bool, branchIcon: CGFloat, draftIcon: CGFloat) -> CGFloat {
        typealias M = Metrics
        return max(M.titleRowHeight, lines.title) + lines.project + M.workspaceMarginTop
            + workspaceRowHeight(lines: lines, workspace: workspace, changes: changes, branchIcon: branchIcon, draftIcon: draftIcon)
    }

    /// At least 18, the workspace and its glyph, the counts and the draft
    /// glyph.
    private static func workspaceRowHeight(lines: Lines, workspace: Bool, changes: Bool, branchIcon: CGFloat, draftIcon: CGFloat) -> CGFloat {
        max(Metrics.workspaceMinHeight, workspace ? max(lines.workspace, branchIcon) : 0, changes ? lines.changes : 0, draftIcon)
    }

    public var size: CGSize
    public var avatar: CGRect
    public var title: CGRect
    public var timestamp: CGRect
    /// The dot shares the timestamp's right edge and is centred on its line.
    public var dot: CGRect
    public var project: CGRect
    public var workspace: CGRect?
    public var branchIcon: CGRect?
    public var changes: CGRect?
    public var draftIcon: CGRect?
    public var divider: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let x = M.contentX
        let right = max(x, width - M.paddingRight)
        let contentWidth = right - x
        let lines = input.lines
        let hasWorkspace = input.workspace != nil
        let hasChanges = input.changes != nil
        let draftHeight = input.draftIcon?.height ?? 0
        let height = Self.height(lines: lines, workspace: hasWorkspace, changes: hasChanges, branchIcon: input.branchIcon.height, draftIcon: draftHeight)
        let content = Self.contentHeight(lines: lines, workspace: hasWorkspace, changes: hasChanges, branchIcon: input.branchIcon.height, draftIcon: draftHeight)
        let titleRowHeight = max(M.titleRowHeight, lines.title)

        let stamp = input.timestamp.size(fitting: max(0, contentWidth - M.cornerMarginLeft))
        let cornerWidth = max(M.cornerMinWidth, stamp.width)
        // The text column is centred on the row, as the avatar is.
        let top = (height - content) / 2
        // The corner's 22 box is centred on the title's row, and the
        // stamp and the dot in it.
        timestamp = CGRect(
            x: right - stamp.width,
            y: top + (titleRowHeight - stamp.height) / 2,
            width: stamp.width,
            height: stamp.height
        )
        dot = CGRect(x: right - M.dotSize, y: top + (titleRowHeight - M.dotSize) / 2, width: M.dotSize, height: M.dotSize)
        let titleWidth = max(0, contentWidth - cornerWidth - M.cornerMarginLeft)
        let titleHeight = input.title.height(fitting: titleWidth)
        title = CGRect(x: x, y: top + (titleRowHeight - titleHeight) / 2, width: titleWidth, height: titleHeight)

        let projectY = top + titleRowHeight
        let projectHeight = input.project.height(fitting: contentWidth)
        project = CGRect(x: x, y: projectY + (lines.project - projectHeight) / 2, width: contentWidth, height: projectHeight)

        let workspaceY = projectY + lines.project + M.workspaceMarginTop
        let workspaceRowHeight = Self.workspaceRowHeight(lines: lines, workspace: hasWorkspace, changes: hasChanges, branchIcon: input.branchIcon.height, draftIcon: draftHeight)
        // The meta (the draft glyph, then the counts) keeps its width at
        // the row's right edge (`marginLeft: 'auto'`, no shrinking); the
        // workspace has what is left. Too wide for the row, it starts
        // where the column does and runs past it, as Yoga places it.
        let draftWidth = input.draftIcon?.width ?? 0
        let metaWidth = draftWidth + (input.changes.map { M.changesPaddingLeft + $0.width } ?? 0)
        let metaX = max(x, right - metaWidth)
        draftIcon = input.draftIcon.map { size in
            CGRect(x: metaX, y: workspaceY + (workspaceRowHeight - size.height) / 2, width: size.width, height: size.height)
        }
        changes = input.changes.map { size in
            CGRect(
                x: metaX + draftWidth + M.changesPaddingLeft,
                y: workspaceY + (workspaceRowHeight - size.height) / 2,
                width: size.width,
                height: size.height
            )
        }
        let locationWidth = max(0, contentWidth - metaWidth)
        if let workspace = input.workspace {
            let icon = input.branchIcon
            let textSize = workspace.size(fitting: max(0, locationWidth - M.workspaceIconGap - icon.width))
            self.workspace = CGRect(
                x: x,
                y: workspaceY + (workspaceRowHeight - textSize.height) / 2,
                width: textSize.width,
                height: textSize.height
            )
            branchIcon = CGRect(
                x: x + textSize.width + M.workspaceIconGap,
                y: workspaceY + (workspaceRowHeight - icon.height) / 2,
                width: icon.width,
                height: icon.height
            )
        } else {
            self.workspace = nil
            branchIcon = nil
        }

        avatar = CGRect(x: M.paddingLeft, y: (height - M.avatarSize) / 2, width: M.avatarSize, height: M.avatarSize)
        divider = input.showsDivider
            ? CGRect(x: x, y: height - M.dividerHeight, width: max(0, width - x), height: M.dividerHeight)
            : nil
        size = CGSize(width: width, height: height)
    }
}

/// A day heading over archived rows ("Today", "3 days ago"): a label on
/// the list's own background (SessionsList.tsx `headerSectionFlat`).
public struct SessionDayHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 16
        public static let paddingTop: CGFloat = 20
        public static let paddingBottom: CGFloat = 8
    }

    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, label: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let labelWidth = max(0, width - M.paddingHorizontal * 2)
        let labelHeight = label.height(fitting: labelWidth)
        self.label = CGRect(x: M.paddingHorizontal, y: M.paddingTop, width: labelWidth, height: labelHeight)
        size = CGSize(width: width, height: M.paddingTop + labelHeight + M.paddingBottom)
    }
}

/// "── Show archived ──": a centred label between two hairlines that
/// heads the archive (SessionsList.tsx `archiveToggle`, banded).
public struct ArchiveToggleLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 24
        public static let paddingTop: CGFloat = 24
        public static let paddingBottom: CGFloat = 8
        public static let gap: CGFloat = 12
        public static let lineHeight: CGFloat = 0.33
    }

    public var size: CGSize
    public var label: CGRect
    public var leadingLine: CGRect
    public var trailingLine: CGRect

    /// The project list's toggle divides the page rather than heading a
    /// band: 20 above and 12 below (ProjectHomeList.tsx `archiveToggle`).
    public static let unbanded = (top: CGFloat(20), bottom: CGFloat(12))

    public init(
        width: CGFloat,
        label: Measurable,
        paddingTop: CGFloat = Metrics.paddingTop,
        paddingBottom: CGFloat = Metrics.paddingBottom
    ) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - M.paddingHorizontal * 2)
        let text = label.size(fitting: max(0, inner - M.gap * 2))
        let lineWidth = max(0, (inner - text.width - M.gap * 2) / 2)
        let midY = paddingTop + text.height / 2
        leadingLine = CGRect(x: M.paddingHorizontal, y: midY - M.lineHeight / 2, width: lineWidth, height: M.lineHeight)
        self.label = CGRect(x: leadingLine.maxX + M.gap, y: paddingTop, width: text.width, height: text.height)
        trailingLine = CGRect(x: self.label.maxX + M.gap, y: leadingLine.minY, width: lineWidth, height: M.lineHeight)
        size = CGSize(width: width, height: paddingTop + text.height + paddingBottom)
    }
}

/// A computer is reachable but nothing has run on it yet
/// (components/EmptyMainScreen.tsx, the "No sessions yet" branch): an icon,
/// a title and a line of text, centred, with an optional text action.
///
/// RN's is a plain centred View. Taller than the safe area, at the larger
/// text sizes, RN would push the title under the header and the button
/// under the dock; here the content starts at the top of the safe area
/// instead and scrolls (`contentHeight`), so everything can be reached.
public struct NoSessionsLayout: Equatable, Sendable {
    public enum Metrics {
        public static let iconSize: CGFloat = 56
        public static let iconMarginBottom: CGFloat = 20
        public static let paddingHorizontal: CGFloat = 24
        public static let titleMarginBottom: CGFloat = 8
        public static let descriptionMaxWidth: CGFloat = 360
        public static let descriptionMarginBottom: CGFloat = 24
        public static let actionMarginTop: CGFloat = 4
        /// The container's own bottom margin, which lifts the centre.
        public static let marginBottom: CGFloat = 32
    }

    public struct Input {
        public var size: CGSize
        public var safeArea: LayoutInsets
        /// The 56pt terminal glyph's RN box (`Icon.layout`): one line of the
        /// icon font tall, 56 x 57.67 on a 3x screen.
        public var icon: CGSize
        public var title: Measurable
        public var description: Measurable
        /// "Start New Session": a RoundButton this tall, stretched across
        /// the screen (`alignSelf: 'stretch'`).
        public var buttonHeight: CGFloat?
        public var action: Measurable?

        public init(
            size: CGSize,
            safeArea: LayoutInsets,
            icon: CGSize = CGSize(width: Metrics.iconSize, height: Metrics.iconSize),
            title: Measurable,
            description: Measurable,
            buttonHeight: CGFloat? = nil,
            action: Measurable?
        ) {
            self.size = size
            self.safeArea = safeArea
            self.icon = icon
            self.title = title
            self.description = description
            self.buttonHeight = buttonHeight
            self.action = action
        }
    }

    public var icon: CGRect
    public var title: CGRect
    public var description: CGRect
    public var button: CGRect?
    public var action: CGRect?
    /// How tall the scrolling content is: the screen's height while the
    /// content fits, more when it doesn't.
    public var contentHeight: CGFloat

    public init(_ input: Input) {
        typealias M = Metrics
        let insets = input.safeArea
        let width = max(0, input.size.width - insets.horizontal)
        let textWidth = max(0, width - M.paddingHorizontal * 2)
        let descriptionWidth = min(M.descriptionMaxWidth, width) - M.paddingHorizontal * 2
        let titleSize = input.title.size(fitting: textWidth)
        let descriptionSize = input.description.size(fitting: max(0, descriptionWidth))
        let actionSize = input.action?.size(fitting: textWidth)

        var height = input.icon.height + M.iconMarginBottom + titleSize.height + M.titleMarginBottom
            + descriptionSize.height + M.descriptionMarginBottom
        if let buttonHeight = input.buttonHeight { height += buttonHeight }
        if let actionSize { height += M.actionMarginTop + actionSize.height }

        let available = max(0, input.size.height - insets.vertical - M.marginBottom)
        // Centred while it fits; from the top of the safe area when not.
        var y = insets.top + max(0, available - height) / 2
        func centred(_ size: CGSize, _ y: CGFloat) -> CGRect {
            CGRect(x: insets.left + (width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        icon = centred(input.icon, y)
        y = icon.maxY + M.iconMarginBottom
        title = centred(titleSize, y)
        y = title.maxY + M.titleMarginBottom
        description = centred(descriptionSize, y)
        y = description.maxY + M.descriptionMarginBottom
        button = input.buttonHeight.map { CGRect(x: insets.left, y: y, width: width, height: $0) }
        y = button?.maxY ?? y
        action = actionSize.map { centred($0, y + M.actionMarginTop) }
        y = action?.maxY ?? y
        contentHeight = max(input.size.height, y + M.marginBottom + insets.bottom)
    }
}

/// A text-only button padded to a 40pt target (EmptyMainScreen.tsx
/// `secondaryAction`).
public struct TextActionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let minHeight: CGFloat = 40
        public static let paddingHorizontal: CGFloat = 14
        public static let cornerRadius: CGFloat = 20
    }

    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, label: Measurable) {
        typealias M = Metrics
        let text = label.size(fitting: max(0, width - M.paddingHorizontal * 2))
        let height = max(M.minHeight, text.height)
        self.label = CGRect(x: M.paddingHorizontal, y: (height - text.height) / 2, width: text.width, height: text.height)
        size = CGSize(width: text.width + M.paddingHorizontal * 2, height: height)
    }
}
