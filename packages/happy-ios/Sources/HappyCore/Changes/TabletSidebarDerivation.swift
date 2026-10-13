import Foundation
import HappyStore

/// The iPad sidebar (`TabletSidebarState`) with its list reduced to what
/// it draws.
public struct TabletSidebarFrame: Equatable, Sendable {
    public enum Content: Equatable, Sendable {
        case loading
        case empty(TabletEmptySessions)
        case list(HomeListModel)

        /// Which view fills the sidebar.
        public var kind: Int {
            switch self {
            case .loading: 0
            case .empty: 1
            case .list: 2
            }
        }
    }

    public var content: Content
    public var hasArchived: Bool
    public var hidesArchived: Bool
    public var showsInstallStep: Bool

    public init(_ state: TabletSidebarState) {
        switch state.content {
        case .loading: content = .loading
        case .empty(let variant): content = .empty(variant)
        case .list(let list, let offline): content = .list(HomeListModel(list, offline: offline, expandedProjects: []))
        }
        hasArchived = state.hasArchived
        hidesArchived = state.hidesArchived
        showsInstallStep = state.showsInstallStep
    }

    public var list: HomeListModel? {
        if case .list(let model) = content { return model }
        return nil
    }
}

/// One sidebar update: the frame, and the list's changes against the rows
/// its list last showed.
public struct TabletSidebarUpdate: Sendable {
    public var frame: TabletSidebarFrame
    /// Nil when the list is not shown and keeps its rows.
    public var changeset: RowChangeset?
}

public enum TabletSidebarDerivation {
    /// The frame on screen, and the rows the list holds: the list stays
    /// (hidden) while the sidebar shows a spinner or the empty state.
    public struct Applied: Equatable, Sendable {
        public var frame: TabletSidebarFrame?
        public var list: HomeListModel?

        public init(frame: TabletSidebarFrame? = nil, list: HomeListModel? = nil) {
            self.frame = frame
            self.list = list
        }
    }

    public static func derive(_ snapshot: HomeSnapshot?, applied: Applied, clock: SessionList.Clock? = nil) -> (output: TabletSidebarUpdate, state: Applied)? {
        guard let snapshot else { return nil }
        let frame = TabletSidebarFrame(TabletSidebarState(snapshot, clock: clock ?? HomeDerivation.clock(snapshot)))
        guard frame != applied.frame else { return nil }
        guard let after = frame.list else {
            return (TabletSidebarUpdate(frame: frame, changeset: nil), Applied(frame: frame, list: applied.list))
        }
        let before = applied.list ?? .empty
        let changeset = RowChangeset(oldIds: before.ids, newIds: after.ids) { before.rows[$0] != after.rows[$1] }
        return (TabletSidebarUpdate(frame: frame, changeset: changeset), Applied(frame: frame, list: after))
    }
}
