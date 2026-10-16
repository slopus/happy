import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A heading in the sidebar's grouped list, or a bot, as much as its height
/// needs. Every label is one line (`numberOfLines={1}` in SessionsList.tsx and
/// ProjectGroup.tsx) in a style with a fixed line height or the font's, so
/// its height is that line, or nothing when it is empty. The app's own
/// words ("Bots", the days, "Show archived") are never empty in any
/// language, so those headings carry no text at all, and whatever derives
/// them never reads the screens' language. Names and branches are the
/// person's, and empty ones show nothing.
public enum TabletHeading: Hashable, Sendable {
    /// "Bots", or a day over the archive.
    case section
    /// ── 🖥 name ──.
    case machine(name: String)
    /// A checkout's heading: the project over its branch and line changes.
    case workspace(title: String, branch: String, changes: TabletHeadingChanges)
    /// "── Show archived ──" or "Hide archived", dividing the page.
    case archiveToggle
    /// A bot: home's flat session row (FlatSessionRow), which has the
    /// workspace's line or line counts or neither. Its lines grow with the
    /// text size as the headings' do, so its height is measured with them.
    case bot(workspace: Bool, changes: Bool)
}

/// Which parts of GitLineChanges show: "≈", "+12", "-3".
public struct TabletHeadingChanges: Hashable, Sendable {
    public var approximate: Bool
    public var added: Bool
    public var removed: Bool

    public static let none = TabletHeadingChanges(approximate: false, added: false, removed: false)

    public init(approximate: Bool, added: Bool, removed: Bool) {
        self.approximate = approximate
        self.added = added
        self.removed = removed
    }
}

/// What the headings' heights are made of at the text size they are drawn
/// at: one line of each style, the computer's glyph box and the hairline.
/// Equal metrics give equal heights; a new text size or screen scale is new
/// metrics.
public struct TabletHeadingMetrics: Hashable, Sendable {
    /// One line of `TextStyles.sessionDayHeader`.
    public var sectionLine: CGFloat
    /// One line of `TextStyles.tabletMachineName`.
    public var machineLine: CGFloat
    /// desktop-outline's box at 11 (`Icon.layout`), which never scales.
    public var machineIcon: CGSize
    /// One line of `TextStyles.tabletWorkspaceTitle`.
    public var workspaceTitleLine: CGFloat
    /// One line of `TextStyles.tabletWorkspaceBranch`.
    public var workspaceBranchLine: CGFloat
    /// One line of `TextStyles.gitApproximate`, the "≈".
    public var changesApproximateLine: CGFloat
    /// One line of `TextStyles.gitLineCount`, "+12" and "-3".
    public var changesCountLine: CGFloat
    /// One line of `TextStyles.archiveToggle`.
    public var archiveToggleLine: CGFloat
    /// A bot's lines, as home's flat rows have them at this text size.
    public var sessionLines: FlatSessionRowLayout.Lines
    /// git-branch-outline's box beside a bot's workspace, which never
    /// scales.
    public var branchIcon: CGFloat
    /// One device pixel.
    public var hairline: CGFloat

    public init(
        sectionLine: CGFloat,
        machineLine: CGFloat,
        machineIcon: CGSize,
        workspaceTitleLine: CGFloat,
        workspaceBranchLine: CGFloat,
        changesApproximateLine: CGFloat,
        changesCountLine: CGFloat,
        archiveToggleLine: CGFloat,
        sessionLines: FlatSessionRowLayout.Lines = .designed,
        branchIcon: CGFloat = FlatSessionRowLayout.Metrics.branchIconSize,
        hairline: CGFloat
    ) {
        self.sectionLine = sectionLine
        self.machineLine = machineLine
        self.machineIcon = machineIcon
        self.workspaceTitleLine = workspaceTitleLine
        self.workspaceBranchLine = workspaceBranchLine
        self.changesApproximateLine = changesApproximateLine
        self.changesCountLine = changesCountLine
        self.archiveToggleLine = archiveToggleLine
        self.sessionLines = sessionLines
        self.branchIcon = branchIcon
        self.hairline = hairline
    }
}

extension TabletGroupedRowHeights {
    /// A heading's or a bot's height from its own layout, without a cell. Each label
    /// is one line of its style, or nothing when its text is empty, as a
    /// label measures it.
    public static func heading(_ heading: TabletHeading, width: CGFloat, metrics: TabletHeadingMetrics) -> CGFloat {
        func line(_ text: String, _ height: CGFloat) -> Measurable {
            .fixed(width: 0, height: text.isEmpty ? 0 : height)
        }
        func line(_ height: CGFloat) -> Measurable {
            .fixed(width: 0, height: height)
        }
        switch heading {
        case .section:
            return TabletSectionHeaderLayout(width: width, label: line(metrics.sectionLine)).size.height
        case .machine(let name):
            return TabletMachineRuleLayout(
                width: width,
                hairline: metrics.hairline,
                icon: metrics.machineIcon,
                name: line(name, metrics.machineLine)
            ).size.height
        case .workspace(let title, let branch, let changes):
            // GitChangesLayout: as tall as its tallest part.
            let parts = [
                changes.approximate ? metrics.changesApproximateLine : nil,
                changes.added ? metrics.changesCountLine : nil,
                changes.removed ? metrics.changesCountLine : nil,
            ].compactMap { $0 }
            return TabletWorkspaceHeaderLayout(.init(
                width: width,
                title: line(title, metrics.workspaceTitleLine),
                branch: line(branch, metrics.workspaceBranchLine),
                changes: parts.max().map { CGSize(width: 0, height: $0) }
            )).size.height
        case .archiveToggle:
            return ArchiveToggleLayout(
                width: width,
                label: line(metrics.archiveToggleLine),
                paddingTop: ArchiveToggleLayout.unbanded.top,
                paddingBottom: ArchiveToggleLayout.unbanded.bottom
            ).size.height
        case .bot(let workspace, let changes):
            return FlatSessionRowLayout.height(
                lines: metrics.sessionLines,
                workspace: workspace,
                changes: changes,
                branchIcon: metrics.branchIcon
            )
        }
    }
}

/// The headings' and bots' heights in one list, kept from one derivation to the
/// next and keyed by what makes them: a row is measured again only when its
/// heading, the width or the metrics changed. Rows that left the list are
/// let go, so it holds no more than the list's headings.
public struct TabletHeadingHeights<ID: Hashable & Sendable>: Equatable, Sendable {
    private struct Entry: Equatable, Sendable {
        var heading: TabletHeading
        var height: CGFloat
    }

    public private(set) var width: CGFloat = 0
    /// Nil until the first `update`.
    public private(set) var metrics: TabletHeadingMetrics?
    private var entries: [ID: Entry] = [:]
    /// How many headings the last `update` measured.
    public private(set) var measured = 0

    public init() {}

    public var count: Int { entries.count }

    public func height(_ id: ID) -> CGFloat? {
        entries[id]?.height
    }

    /// Takes the list's rows, nil for a row that is no heading, at `width`
    /// and `metrics`. Returns the rows it held already whose height moved.
    @discardableResult
    public mutating func update(_ rows: [(id: ID, heading: TabletHeading?)], width: CGFloat, metrics: TabletHeadingMetrics) -> Set<ID> {
        let measuresAll = width != self.width || metrics != self.metrics
        var next: [ID: Entry] = [:]
        var moved: Set<ID> = []
        measured = 0
        for row in rows {
            guard let heading = row.heading else { continue }
            let held = entries[row.id]
            if let held, !measuresAll, held.heading == heading {
                next[row.id] = held
                continue
            }
            let height = TabletGroupedRowHeights.heading(heading, width: width, metrics: metrics)
            measured += 1
            next[row.id] = Entry(heading: heading, height: height)
            if let held, held.height != height { moved.insert(row.id) }
        }
        entries = next
        self.width = width
        self.metrics = metrics
        return moved
    }

    /// Equal tables give every row the same height; how they were reached
    /// doesn't count.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.width == rhs.width && lhs.metrics == rhs.metrics && lhs.entries == rhs.entries
    }
}
