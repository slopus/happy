import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A home list row, as much as its height needs: the one line of text the
/// headings carry, whether a session has a workspace line or line counts,
/// or nothing for the rows whose height never depends on content.
public enum HomeRowKind: Hashable, Sendable {
    /// A session in the flat list; with a workspace it has the third line,
    /// and with line counts their line ends it.
    case flatSession(workspace: Bool, changes: Bool)
    /// A day over the flat archive ("Today", "3 days ago").
    case dayHeader(label: String)
    /// "── Show archived ──": banded in the flat list, dividing the page in
    /// the project list.
    case archiveToggle(label: String, banded: Bool)
    /// The computer heading its bots and projects.
    case machineHeader(name: String)
    /// "BOTS", "PROJECTS", or a day over the project list's archive.
    case section(label: String)
    case projectCard
    /// A worktree under its project, or the toggle that ends the list.
    case worktree
    /// A bot's standing chat, or an archived chat.
    case chat
}

/// What the rows' heights are made of, as the screen renders them: one
/// line of each heading's style, a flat session's three lines, the
/// computer's glyph box and the hairline. Read from the text styles and
/// the screen, so a different font, text size or scale gives different
/// heights.
public struct HomeRowMetrics: Hashable, Sendable {
    /// One line of `TextStyles.sessionDayHeader`.
    public var dayHeaderLine: CGFloat
    /// One line of `TextStyles.archiveToggle`.
    public var archiveToggleLine: CGFloat
    /// One line of `TextStyles.projectMachine`.
    public var machineLine: CGFloat
    /// One line of `TextStyles.projectSection`.
    public var sectionLine: CGFloat
    /// The desktop glyph's box beside a computer's name.
    public var machineIcon: CGSize
    /// One device pixel.
    public var hairline: CGFloat
    /// A flat session's title, project, workspace and line counts' lines.
    public var sessionLines: FlatSessionRowLayout.Lines
    /// The branch glyph's box beside a workspace.
    public var branchIcon: CGSize

    public init(
        dayHeaderLine: CGFloat,
        archiveToggleLine: CGFloat,
        machineLine: CGFloat,
        sectionLine: CGFloat,
        machineIcon: CGSize,
        hairline: CGFloat,
        sessionLines: FlatSessionRowLayout.Lines = .designed,
        branchIcon: CGSize = CGSize(width: FlatSessionRowLayout.Metrics.branchIconSize, height: FlatSessionRowLayout.Metrics.branchIconSize)
    ) {
        self.dayHeaderLine = dayHeaderLine
        self.archiveToggleLine = archiveToggleLine
        self.machineLine = machineLine
        self.sectionLine = sectionLine
        self.machineIcon = machineIcon
        self.hairline = hairline
        self.sessionLines = sessionLines
        self.branchIcon = branchIcon
    }
}

extension HomeRowHeights {
    /// A row's height from its own layout, without a cell. Each heading is
    /// one line, so its label is that line's height, or nothing when the
    /// text is empty, as a label measures it. A flat session is its lines,
    /// whatever they say.
    public static func height(_ kind: HomeRowKind, width: CGFloat, metrics: HomeRowMetrics) -> CGFloat {
        func line(_ text: String, _ height: CGFloat) -> Measurable {
            .fixed(width: 0, height: text.isEmpty ? 0 : height)
        }
        switch kind {
        case .flatSession(let workspace, let changes):
            return FlatSessionRowLayout.height(
                lines: metrics.sessionLines,
                workspace: workspace,
                changes: changes,
                branchIcon: metrics.branchIcon.height
            )
        case .dayHeader(let label):
            return SessionDayHeaderLayout(width: width, label: line(label, metrics.dayHeaderLine)).size.height
        case .archiveToggle(let label, let banded):
            let text = line(label, metrics.archiveToggleLine)
            return banded
                ? ArchiveToggleLayout(width: width, label: text).size.height
                : ArchiveToggleLayout(
                    width: width,
                    label: text,
                    paddingTop: ArchiveToggleLayout.unbanded.top,
                    paddingBottom: ArchiveToggleLayout.unbanded.bottom
                ).size.height
        case .machineHeader(let name):
            return MachineHeaderLayout(
                width: width,
                hairline: metrics.hairline,
                icon: metrics.machineIcon,
                name: line(name, metrics.machineLine)
            ).size.height
        case .section(let label):
            return ProjectSectionLayout(width: width, label: line(label, metrics.sectionLine)).size.height
        case .projectCard:
            return projectCard(width: width)
        case .worktree:
            return worktree(width: width)
        case .chat:
            return projectChat(width: width)
        }
    }
}

/// HomeListHeader.tsx's notices, sized without views: each is an ItemGroup
/// (4 above, 16 below) around one Item with an icon, a one-line title, a
/// subtitle and the chevron.
public enum HomeBannerHeights {
    public enum Metrics {
        /// HomeListHeaderView's `untitledPaddingTop` and `paddingBottom`.
        public static let groupPaddingTop: CGFloat = 4
        public static let groupPaddingBottom: CGFloat = 16
    }

    /// One notice's text, measured however the caller measures it.
    public struct Banner {
        public var title: Measurable
        public var subtitle: Measurable

        public init(title: Measurable, subtitle: Measurable) {
            self.title = title
            self.subtitle = subtitle
        }
    }

    /// One notice, group padding included.
    public static func banner(_ banner: Banner, width: CGFloat, maxWidth: CGFloat?, chevron: CGSize) -> CGFloat {
        let row = Measurable { rowWidth in
            ItemRowLayout(.init(
                width: rowWidth,
                hasIcon: true,
                title: banner.title,
                subtitle: banner.subtitle,
                accessory: chevron
            )).size
        }
        return ItemGroupLayout(.init(
            width: width,
            rows: [row],
            maxWidth: maxWidth,
            untitledPaddingTop: Metrics.groupPaddingTop,
            paddingBottom: Metrics.groupPaddingBottom
        )).size.height
    }

    /// The notices stacked; 0 for none.
    public static func header(_ banners: [Banner], width: CGFloat, maxWidth: CGFloat?, chevron: CGSize) -> CGFloat {
        HomeListHeaderLayout(
            width: width,
            banners: banners.map { banner in
                Measurable { width in
                    CGSize(width: width, height: Self.banner(banner, width: width, maxWidth: maxWidth, chevron: chevron))
                }
            }
        ).size.height
    }
}
