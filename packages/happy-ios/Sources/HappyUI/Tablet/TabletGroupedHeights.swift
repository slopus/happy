#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the sidebar works out off the main thread: the account's feeds,
/// and the grouped list's width and text environment, which the screen
/// sets.
struct TabletSidebarViewInput: Sendable {
    var feeds = TabletSidebarInput()
    /// The grouped list's width.
    var width: CGFloat = 0
    /// The person's text size and the screen's scale; nil until the screen
    /// has read its traits.
    var text: TextEnvironment?
}

/// What the sidebar shows now: the rows, and the grouped list's headings'
/// and bots' heights with what they were measured at.
struct TabletSidebarViewState: Sendable {
    var feeds = TabletSidebarDerivation.Applied()
    var text: TextEnvironment?
    var headings = TabletHeadingHeights<TabletGroupedRow.ID>()
}

/// One step for the main thread: new rows, new heading heights, or both.
struct TabletSidebarViewUpdate: Sendable {
    /// Nil when the rows are as they were (a new text size or width).
    var rows: TabletSidebarUpdate?
    /// The grouped list's heading and bot heights, for its rows as of this
    /// update.
    var headings: TabletHeadingHeights<TabletGroupedRow.ID>
    /// Rows the list held already whose height moved.
    var moved: Set<TabletGroupedRow.ID>
}

/// The grouped list's headings and bots measured without cells, off the
/// main thread: SessionsList.tsx's and ProjectGroup.tsx's one-line headings
/// and the bots' FlatSessionRow at the person's text size, as RN draws them
/// (docs/DYNAMIC-TYPE.md). The chats and archived cards are fixed heights
/// and are not here.
enum TabletGroupedHeights {
    /// The sidebar's rows (`TabletSidebarDerivation`), then the grouped
    /// list's heading and bot heights for them: measured again only for a
    /// row whose heading changed, or every one for a new width or text
    /// environment. Nil when neither changed.
    nonisolated static func derive(
        _ input: TabletSidebarViewInput,
        applied: TabletSidebarViewState,
        wake: ClockWake
    ) -> (output: TabletSidebarViewUpdate, state: TabletSidebarViewState)? {
        let rows = TabletSidebarDerivation.derive(input.feeds, applied: applied.feeds, wake: wake)
        var state = applied
        if let rows { state.feeds = rows.state }
        var moved: Set<TabletGroupedRow.ID> = []
        if let text = input.text {
            let metrics = (text == applied.text ? applied.headings.metrics : nil) ?? metrics(text)
            state.text = text
            let list = state.feeds.grouped ?? .empty
            moved = state.headings.update(
                zip(list.ids, list.rows).map { ($0, heading($1)) },
                width: input.width,
                metrics: metrics
            )
        }
        guard rows != nil || state.headings != applied.headings || state.text != applied.text else { return nil }
        return (TabletSidebarViewUpdate(rows: rows?.output, headings: state.headings, moved: moved), state)
    }

    /// The headings' and bots' metrics at `environment`'s text size and
    /// scale. Safe off main: fonts come from `ScaledFonts`, the glyph boxes
    /// from the generated tables.
    nonisolated static func metrics(_ environment: TextEnvironment) -> TabletHeadingMetrics {
        let scale = environment.displayScale
        let iconSize = TabletMachineRuleLayout.Metrics.iconSize
        let branchIconSize = FlatSessionRowLayout.Metrics.branchIconSize
        // One line as a one-line label measures it: the style's line
        // height, or the font's own unrounded, up to the screen's next
        // pixel. Each label is ceiled alone, before a layout adds or
        // compares them.
        func line(_ style: TextStyle) -> CGFloat {
            let height = style.scaled(environment.scale).lineHeight ?? style.font(in: environment).lineHeight
            return scale > 0 ? (height * scale).rounded(.up) / scale : height
        }
        return TabletHeadingMetrics(
            sectionLine: line(TextStyles.sessionDayHeader),
            machineLine: line(TextStyles.tabletMachineName),
            // IconView's fitting size: RN's box for the glyph, unscaled.
            machineIcon: Icon.ionicons("desktop-outline").layout(size: iconSize, scale: scale)?.size
                ?? CGSize(width: iconSize, height: iconSize),
            workspaceTitleLine: line(TextStyles.tabletWorkspaceTitle),
            workspaceBranchLine: line(TextStyles.tabletWorkspaceBranch),
            changesApproximateLine: line(TextStyles.gitApproximate),
            changesCountLine: line(TextStyles.gitLineCount),
            archiveToggleLine: line(TextStyles.archiveToggle),
            // The lines home's flat rows take (`HomeTextEnvironment`).
            sessionLines: FlatSessionRowLayout.Lines(
                title: TextStyles.sessionTitle.oneLine(in: environment),
                project: TextStyles.sessionProject.oneLine(in: environment),
                workspace: TextStyles.sessionWorkspace.oneLine(in: environment),
                changes: TextStyles.sessionLineChanges.oneLine(in: environment)
            ),
            branchIcon: Icon.ionicons("git-branch-outline").layout(size: branchIconSize, scale: scale)?.size.height
                ?? branchIconSize,
            hairline: 1 / max(scale, 1)
        )
    }

    /// What a row's height is made of when it is a heading or a bot. The
    /// app's own words are one line whatever they say, so none is read here:
    /// `Strings` speak the screens' language and are for the main thread,
    /// where `TabletGroupedListViewController.configure` sets them.
    nonisolated static func heading(_ row: TabletGroupedRow) -> TabletHeading? {
        switch row {
        case .botsHeader, .archiveHeader:
            .section
        case .machine(_, let name):
            .machine(name: name)
        case .workspace(let header):
            .workspace(title: header.projectName, branch: header.branch, changes: changes(header.changes))
        case .archiveToggle:
            .archiveToggle
        case .bot(let session):
            .bot(workspace: session.workspaceName != nil, changes: session.changes != nil)
        case .chat, .archived:
            nil
        }
    }

    /// Which of GitChangesView's parts show.
    nonisolated static func changes(_ changes: GitLineChanges?) -> TabletHeadingChanges {
        guard let changes else { return .none }
        return TabletHeadingChanges(
            approximate: changes.approximate,
            added: changes.insertions > 0,
            removed: changes.deletions > 0
        )
    }
}
#endif
