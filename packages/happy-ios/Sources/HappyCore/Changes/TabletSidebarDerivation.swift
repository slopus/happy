import Foundation
import HappyStore

/// The iPad sidebar (`TabletSidebarState`) with its list reduced to what
/// it draws.
public struct TabletSidebarFrame: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case loading
        case empty(TabletEmptySessions)
        /// The flat grouping: home's own flat list.
        case list(HomeListModel)
        /// Grouped by project: SessionsList.tsx's machine and checkout
        /// hierarchy (`TabletGroupedList`), not home's project cards.
        case grouped(TabletGroupedList)

        /// Which view fills the sidebar.
        public var kind: Int {
            switch self {
            case .loading: 0
            case .empty: 1
            case .list: 2
            case .grouped: 3
            }
        }
    }

    public var content: Content
    public var hasArchived: Bool
    public var hidesArchived: Bool
    public var showsInstallStep: Bool

    public init(
        _ state: TabletSidebarState,
        snapshot: HomeSnapshot,
        clock: SessionList.Clock = SessionList.Clock(),
        git: [GitCheckoutKey: GitHeadingStatus] = [:],
        draftSessionIds: Set<String> = [],
        unknownMachine: String = ProjectHomeData.unknownMachineText
    ) {
        switch state.content {
        case .loading: content = .loading
        case .empty(let variant): content = .empty(variant)
        case .list(let list, let offline) where list.grouping == .project:
            content = .grouped(TabletGroupedList(
                snapshot,
                offline: offline,
                clock: clock,
                git: git,
                draftSessionIds: draftSessionIds,
                unknownMachine: unknownMachine
            ))
        case .list(let list, let offline):
            content = .list(HomeListModel(list, offline: offline, expandedProjects: [], draftSessionIds: draftSessionIds))
        }
        hasArchived = state.hasArchived
        hidesArchived = state.hidesArchived
        showsInstallStep = state.showsInstallStep
    }

    public var list: HomeListModel? {
        if case .list(let model) = content { return model }
        return nil
    }

    public var grouped: TabletGroupedList? {
        if case .grouped(let model) = content { return model }
        return nil
    }
}

/// What the sidebar is worked out from: home's snapshot and each
/// checkout's status as far as it is known.
public struct TabletSidebarInput: Sendable {
    public var snapshot: HomeSnapshot?
    public var git: [GitCheckoutKey: GitHeadingStatus]
    public var draftSessionIds: Set<String>
    /// `status.unknown` in the screens' language, read on the main thread
    /// when the sidebar is built; a new language builds it again.
    public var unknownMachine: String

    public init(
        snapshot: HomeSnapshot? = nil,
        git: [GitCheckoutKey: GitHeadingStatus] = [:],
        draftSessionIds: Set<String> = [],
        unknownMachine: String = ProjectHomeData.unknownMachineText
    ) {
        self.snapshot = snapshot
        self.git = git
        self.draftSessionIds = draftSessionIds
        self.unknownMachine = unknownMachine
    }
}

/// One sidebar update: the frame, and the shown list's changes against the
/// rows that list last showed.
public struct TabletSidebarUpdate: Sendable {
    public var frame: TabletSidebarFrame
    /// For the flat list on `.list`, the grouped one on `.grouped`; nil
    /// when neither shows, and both keep their rows.
    public var changeset: RowChangeset?
    /// The checkouts whose headings now show, when that changed: the ones
    /// a new message refreshes (`GitStatusSync.interest()`).
    public var checkouts: Set<GitCheckoutKey>?
}

public enum TabletSidebarDerivation {
    /// The frame on screen, and the rows each list holds: a list stays
    /// (hidden) while the sidebar shows the other grouping, a spinner or
    /// the empty state.
    public struct Applied: Equatable, Sendable {
        public var frame: TabletSidebarFrame?
        public var list: HomeListModel?
        public var grouped: TabletGroupedList?
        /// The checkouts whose headings show.
        public var checkouts: Set<GitCheckoutKey>

        public init(
            frame: TabletSidebarFrame? = nil,
            list: HomeListModel? = nil,
            grouped: TabletGroupedList? = nil,
            checkouts: Set<GitCheckoutKey> = []
        ) {
            self.frame = frame
            self.list = list
            self.grouped = grouped
            self.checkouts = checkouts
        }
    }

    public static func derive(_ input: TabletSidebarInput, applied: Applied, clock: SessionList.Clock? = nil) -> (output: TabletSidebarUpdate, state: Applied)? {
        derive(input.snapshot, git: input.git, applied: applied, clock: clock, draftSessionIds: input.draftSessionIds, unknownMachine: input.unknownMachine)
    }

    /// `derive` at one instant (`clock`, or now), with `wake` set for the
    /// next instant a stamp or a day heading can change, so the sidebar is
    /// derived again then even if the store never changes. The result is
    /// nil, and the main thread hears nothing, if nothing did.
    public static func derive(
        _ input: TabletSidebarInput,
        applied: Applied,
        wake: ClockWake,
        clock: SessionList.Clock? = nil
    ) -> (output: TabletSidebarUpdate, state: Applied)? {
        let clock = clock ?? SessionList.Clock()
        if let snapshot = input.snapshot {
            wake.schedule(HomeClockBoundary.next(after: clock, snapshot: snapshot))
        }
        return derive(input, applied: applied, clock: clock)
    }

    public static func derive(
        _ snapshot: HomeSnapshot?,
        git: [GitCheckoutKey: GitHeadingStatus] = [:],
        applied: Applied,
        clock: SessionList.Clock? = nil,
        draftSessionIds: Set<String> = [],
        unknownMachine: String = ProjectHomeData.unknownMachineText
    ) -> (output: TabletSidebarUpdate, state: Applied)? {
        guard let snapshot else { return nil }
        let clock = clock ?? SessionList.Clock()
        let frame = TabletSidebarFrame(
            TabletSidebarState(snapshot, clock: clock),
            snapshot: snapshot,
            clock: clock,
            git: git,
            draftSessionIds: draftSessionIds,
            unknownMachine: unknownMachine
        )
        guard frame != applied.frame else { return nil }
        var state = applied
        state.frame = frame
        let changeset: RowChangeset?
        switch frame.content {
        case .list(let after):
            let before = applied.list ?? .empty
            changeset = RowChangeset(oldIds: before.ids, newIds: after.ids) { before.rows[$0] != after.rows[$1] }
            state.list = after
        case .grouped(let after):
            let before = applied.grouped ?? .empty
            changeset = RowChangeset(oldIds: before.ids, newIds: after.ids) { before.rows[$0] != after.rows[$1] }
            state.grouped = after
        case .loading, .empty:
            changeset = nil
        }
        let checkouts = frame.grouped?.checkouts ?? []
        state.checkouts = checkouts
        return (TabletSidebarUpdate(frame: frame, changeset: changeset, checkouts: checkouts == applied.checkouts ? nil : checkouts), state)
    }
}
