import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The rows of the home list grouped by project (components/
/// ProjectHomeList.tsx). Every row shares two leading columns:
///
///     |16| avatar lane 28 |12| name ………………… |8| trailing |16|
///
/// The trailing column is a row of items 8 apart, flush right. A tree line
/// twice the hairline wide runs down the avatar lane from a project's
/// avatar through its worktrees; each worktree branches off it with an
/// elbow from the lane's centre to its edge.
public enum ProjectListMetrics {
    public static let paddingX: CGFloat = 16
    public static let avatarSize: CGFloat = 28
    public static let avatarGap: CGFloat = 12
    public static let projectRowHeight: CGFloat = 52
    public static let projectMarginTop: CGFloat = 8
    public static let worktreeRowHeight: CGFloat = 48
    public static let botRowHeight: CGFloat = 48
    public static let trailingGap: CGFloat = 8
    public static let trailingMarginLeft: CGFloat = 8
    /// The `+` that creates a workspace.
    public static let addButton = CGSize(width: 28, height: 32)
    public static let dotSize: CGFloat = 7
    /// A bot's or an archived chat's corner dot.
    public static let chatDotSize: CGFloat = 10
    public static let toggleIconGap: CGFloat = 5
    public static let changesGap: CGFloat = 4

    /// Where every row's name starts.
    public static var nameX: CGFloat { paddingX + avatarSize + avatarGap }

    /// `TREE_LINE_WIDTH`: twice the hairline.
    public static func treeLineWidth(hairline: CGFloat) -> CGFloat { hairline * 2 }
}

/// Lays out the trailing items of a row, right to left from `right`, each
/// centred on `midY`; returns their frames in the order given and the
/// column's left edge.
func trailingFrames(_ sizes: [CGSize], right: CGFloat, midY: CGFloat, gap: CGFloat) -> (frames: [CGRect], minX: CGFloat) {
    var x = right
    var frames = [CGRect](repeating: .zero, count: sizes.count)
    for index in sizes.indices.reversed() {
        let size = sizes[index]
        x -= size.width
        frames[index] = CGRect(x: x, y: midY - size.height / 2, width: size.width, height: size.height)
        if index > 0 { x -= gap }
    }
    return (frames, x)
}

/// A project's card: avatar, name, then an activity dot, its line changes
/// and the `+`. The card sits 8 below the row above it, inside its own
/// cell, and the tree stem drops from under the avatar to the cell's foot.
public struct ProjectCardLayout: Equatable, Sendable {
    public struct Input {
        public var width: CGFloat
        public var hairline: CGFloat
        public var name: Measurable
        /// The blocked or unread dot.
        public var showsDot: Bool
        public var changes: Measurable?
        public var showsAdd: Bool
        public var showsTree: Bool

        public init(width: CGFloat, hairline: CGFloat, name: Measurable, showsDot: Bool, changes: Measurable?, showsAdd: Bool, showsTree: Bool) {
            self.width = width
            self.hairline = hairline
            self.name = name
            self.showsDot = showsDot
            self.changes = changes
            self.showsAdd = showsAdd
            self.showsTree = showsTree
        }
    }

    public var size: CGSize
    public var avatar: CGRect
    public var stem: CGRect?
    public var name: CGRect
    public var dot: CGRect?
    public var changes: CGRect?
    public var add: CGRect?

    public init(_ input: Input) {
        typealias M = ProjectListMetrics
        let width = max(0, input.width)
        let top = M.projectMarginTop
        let height = top + M.projectRowHeight
        let midY = top + M.projectRowHeight / 2
        size = CGSize(width: width, height: height)
        avatar = CGRect(x: M.paddingX, y: midY - M.avatarSize / 2, width: M.avatarSize, height: M.avatarSize)
        let line = M.treeLineWidth(hairline: input.hairline)
        let stemTop = top + (M.projectRowHeight + M.avatarSize) / 2
        stem = input.showsTree
            ? CGRect(x: M.paddingX + (M.avatarSize - line) / 2, y: stemTop, width: line, height: height - stemTop)
            : nil

        var sizes: [CGSize] = []
        if input.showsDot { sizes.append(CGSize(width: M.dotSize, height: M.dotSize)) }
        let changesSize = input.changes?.size(fitting: .greatestFiniteMagnitude)
        if let changesSize { sizes.append(changesSize) }
        if input.showsAdd { sizes.append(M.addButton) }
        let trailing = trailingFrames(sizes, right: width - M.paddingX, midY: midY, gap: M.trailingGap)
        var frames = trailing.frames[...]
        dot = input.showsDot ? frames.popFirst() : nil
        changes = changesSize != nil ? frames.popFirst() : nil
        add = input.showsAdd ? frames.popFirst() : nil

        let nameRight = sizes.isEmpty ? width - M.paddingX : trailing.minX - M.trailingMarginLeft
        let nameWidth = max(0, nameRight - M.nameX)
        let nameHeight = input.name.height(fitting: nameWidth)
        name = CGRect(x: M.nameX, y: midY - nameHeight / 2, width: nameWidth, height: nameHeight)
    }
}

/// A worktree hanging off its project's tree line, or the toggle row that
/// ends the line. The last one stops the trunk at its elbow.
public struct WorktreeRowLayout: Equatable, Sendable {
    public struct Input {
        public var width: CGFloat
        public var hairline: CGFloat
        /// The name, or the toggle's label.
        public var label: Measurable
        /// The toggle's chevron box, ahead of its label.
        public var chevron: CGSize?
        public var showsDot: Bool
        public var changes: Measurable?
        public var last: Bool

        public init(width: CGFloat, hairline: CGFloat, label: Measurable, chevron: CGSize? = nil, showsDot: Bool, changes: Measurable?, last: Bool) {
            self.width = width
            self.hairline = hairline
            self.label = label
            self.chevron = chevron
            self.showsDot = showsDot
            self.changes = changes
            self.last = last
        }
    }

    public var size: CGSize
    public var trunk: CGRect
    public var elbow: CGRect
    public var chevron: CGRect?
    public var label: CGRect
    public var dot: CGRect?
    public var changes: CGRect?

    public init(_ input: Input) {
        typealias M = ProjectListMetrics
        let width = max(0, input.width)
        let height = M.worktreeRowHeight
        let midY = height / 2
        size = CGSize(width: width, height: height)
        let line = M.treeLineWidth(hairline: input.hairline)
        trunk = CGRect(x: M.paddingX + (M.avatarSize - line) / 2, y: 0, width: line, height: input.last ? height / 2 : height)
        elbow = CGRect(x: M.paddingX + M.avatarSize / 2, y: midY - line / 2, width: M.avatarSize / 2, height: line)

        var sizes: [CGSize] = []
        if input.showsDot { sizes.append(CGSize(width: M.dotSize, height: M.dotSize)) }
        let changesSize = input.changes?.size(fitting: .greatestFiniteMagnitude)
        if let changesSize { sizes.append(changesSize) }
        let trailing = trailingFrames(sizes, right: width - M.paddingX, midY: midY, gap: M.trailingGap)
        var frames = trailing.frames[...]
        dot = input.showsDot ? frames.popFirst() : nil
        changes = changesSize != nil ? frames.popFirst() : nil
        // An empty trailing column still takes its margin.
        let laneRight = trailing.minX - M.trailingMarginLeft
        var x = M.nameX
        if let box = input.chevron {
            chevron = CGRect(x: x, y: midY - box.height / 2, width: box.width, height: box.height)
            x += box.width + M.toggleIconGap
        } else {
            chevron = nil
        }
        let lane = max(0, laneRight - x)
        let text = input.label.size(fitting: lane)
        label = CGRect(
            x: x,
            y: midY - text.height / 2,
            width: input.chevron == nil ? lane : min(text.width, lane),
            height: text.height
        )
    }
}

/// A bot's standing chat, or a chat in the archive: avatar, name, and the
/// time or a status dot.
public struct ProjectChatRowLayout: Equatable, Sendable {
    public var size: CGSize
    public var avatar: CGRect
    public var name: CGRect
    /// The timestamp, or the dot's box when it shows one.
    public var corner: CGRect

    public init(width: CGFloat, name: Measurable, corner: Measurable) {
        typealias M = ProjectListMetrics
        let width = max(0, width)
        let height = M.botRowHeight
        let midY = height / 2
        size = CGSize(width: width, height: height)
        avatar = CGRect(x: M.paddingX, y: midY - M.avatarSize / 2, width: M.avatarSize, height: M.avatarSize)
        let cornerMax = max(0, width - M.nameX - M.paddingX - M.trailingMarginLeft)
        let cornerSize = corner.size(fitting: cornerMax)
        let cornerWidth = min(cornerSize.width, cornerMax)
        self.corner = CGRect(x: width - M.paddingX - cornerWidth, y: midY - cornerSize.height / 2, width: cornerWidth, height: cornerSize.height)
        let nameWidth = max(0, self.corner.minX - M.trailingMarginLeft - M.nameX)
        let nameHeight = name.height(fitting: nameWidth)
        self.name = CGRect(x: M.nameX, y: midY - nameHeight / 2, width: nameWidth, height: nameHeight)
    }
}

/// "BOTS", "PROJECTS", or a day over the archive (ProjectHomeList.tsx
/// `section`).
public struct ProjectSectionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingLeft: CGFloat = 16
        public static let paddingRight: CGFloat = 12
        public static let paddingTop: CGFloat = 18
        public static let paddingBottom: CGFloat = 6
    }

    public var size: CGSize
    public var label: CGRect

    public init(width: CGFloat, label: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let labelWidth = max(0, width - M.paddingLeft - M.paddingRight)
        let height = label.height(fitting: labelWidth)
        self.label = CGRect(x: M.paddingLeft, y: M.paddingTop, width: labelWidth, height: height)
        size = CGSize(width: width, height: M.paddingTop + height + M.paddingBottom)
    }
}

/// The computer heading everything under it: a desktop glyph, its name (at
/// most 60% of the row) and a rule to the edge.
public struct MachineHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingX: CGFloat = 16
        public static let paddingTop: CGFloat = 14
        public static let paddingBottom: CGFloat = 2
        public static let gap: CGFloat = 6
        public static let nameMaxFraction: CGFloat = 0.6
    }

    public var size: CGSize
    public var icon: CGRect
    public var name: CGRect
    public var rule: CGRect

    public init(width: CGFloat, hairline: CGFloat, icon: CGSize, name: Measurable) {
        typealias M = Metrics
        let width = max(0, width)
        let inner = max(0, width - 2 * M.paddingX)
        let nameMax = inner * M.nameMaxFraction
        let fitted = name.size(fitting: nameMax)
        let text = CGSize(width: min(fitted.width, nameMax), height: fitted.height)
        let line = ProjectListMetrics.treeLineWidth(hairline: hairline)
        let rowHeight = max(icon.height, text.height, line)
        let midY = M.paddingTop + rowHeight / 2
        self.icon = CGRect(x: M.paddingX, y: midY - icon.height / 2, width: icon.width, height: icon.height)
        self.name = CGRect(x: self.icon.maxX + M.gap, y: midY - text.height / 2, width: text.width, height: text.height)
        let ruleX = self.name.maxX + M.gap
        rule = CGRect(x: ruleX, y: midY - line / 2, width: max(0, width - M.paddingX - ruleX), height: line)
        size = CGSize(width: width, height: M.paddingTop + rowHeight + M.paddingBottom)
    }
}

/// "≈ +12 -3": a checkout's line changes, 4 apart, on one centre line.
public struct GitChangesLayout: Equatable, Sendable {
    public var size: CGSize
    public var approximate: CGRect?
    public var added: CGRect?
    public var removed: CGRect?

    public init(approximate approximateSize: CGSize?, added addedSize: CGSize?, removed removedSize: CGSize?) {
        let parts = [approximateSize, addedSize, removedSize]
        let height = parts.compactMap { $0?.height }.max() ?? 0
        var x: CGFloat = 0
        var frames: [CGRect?] = []
        for part in parts {
            guard let part else {
                frames.append(nil)
                continue
            }
            if x > 0 { x += ProjectListMetrics.changesGap }
            frames.append(CGRect(x: x, y: (height - part.height) / 2, width: part.width, height: part.height))
            x += part.width
        }
        self.approximate = frames[0]
        added = frames[1]
        removed = frames[2]
        size = CGSize(width: x, height: height)
    }
}

/// HomeListHeader.tsx: the notices above the rows, stacked full width,
/// each its own group (the offline plaque first, then the update banner).
public struct HomeListHeaderLayout: Equatable, Sendable {
    public var size: CGSize
    public var banners: [CGRect]

    public init(width: CGFloat, banners: [Measurable]) {
        let width = max(0, width)
        var y: CGFloat = 0
        self.banners = banners.map { banner in
            let height = banner.height(fitting: width)
            defer { y += height }
            return CGRect(x: 0, y: y, width: width, height: height)
        }
        size = CGSize(width: width, height: y)
    }
}
