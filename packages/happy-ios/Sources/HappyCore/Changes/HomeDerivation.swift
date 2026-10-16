import Foundation
import HappyStore

/// A row of home's session list, in either layout, as the table draws it.
public enum HomeListRow: Equatable, Sendable {
    case flat(SessionList.Item)
    case project(ProjectHomeRow)

    /// Who the row is across updates. Day headings are counted, so the
    /// third heading stays the third heading when its title changes.
    ///
    /// The two layouts never share an id, and every id keeps one cell
    /// class, so switching layouts is a delete and an insert and a
    /// reconfigured row never needs another kind of cell.
    public enum ID: Hashable, Sendable {
        case session(String)
        case archiveToggle
        case day(Int)
        /// `ProjectHomeRow.key`, which names its kind ("bot-", "worktree-").
        case project(String)
        case projectArchiveToggle
        case projectDay(Int)
    }

    /// The chat a tap on the row opens, if any.
    public var sessionId: String? {
        switch self {
        case .flat(.session(let row)), .project(.bot(let row)), .project(.archived(let row)): row.id
        case .project(.project(let entry)): entry.sessionId
        case .project(.worktree(let worktree, _)): worktree.sessionId
        default: nil
        }
    }
}

/// What home's session list shows: the rows, each with its identity, and
/// what draws all of them. Only values a cell renders are here: a row's
/// `lastActivityAt` orders the list but is drawn as `timestamp`, so it is
/// cleared and a new activity in the same minute redraws nothing.
public struct HomeListModel: Equatable, Sendable {
    public var ids: [HomeListRow.ID]
    public var rows: [HomeListRow]
    public var avatarStyle: AvatarStyle
    public var avatarMonochrome: Bool
    /// Grouped by project rather than flat.
    public var grouped: Bool
    /// Every computer, when all are offline, for the plaque above the rows.
    public var offline: [MachineChoice]?

    public static let empty = HomeListModel(ids: [], rows: [], avatarStyle: .gradient, avatarMonochrome: false, grouped: false, offline: nil)

    public init(ids: [HomeListRow.ID], rows: [HomeListRow], avatarStyle: AvatarStyle, avatarMonochrome: Bool, grouped: Bool, offline: [MachineChoice]?) {
        self.ids = ids
        self.rows = rows
        self.avatarStyle = avatarStyle
        self.avatarMonochrome = avatarMonochrome
        self.grouped = grouped
        self.offline = offline
    }

    /// `expandedProjects` are the projects whose worktrees are all shown
    /// (a device setting, read on the main thread and passed in).
    public init(_ list: SessionList, offline: [MachineChoice]?, expandedProjects: Set<String>, draftSessionIds: Set<String> = []) {
        var ids: [HomeListRow.ID] = []
        var rows: [HomeListRow] = []
        var dayIndex = 0
        if let projects = list.projects {
            for row in projects.rows(expanded: expandedProjects) {
                switch row {
                case .archiveToggle: ids.append(.projectArchiveToggle)
                case .archiveHeader:
                    ids.append(.projectDay(dayIndex))
                    dayIndex += 1
                default: ids.append(.project(row.key))
                }
                rows.append(.project(Self.rendered(row)))
            }
        } else {
            ids.reserveCapacity(list.items.count)
            rows.reserveCapacity(list.items.count)
            for item in list.items {
                switch item {
                case .session(var row):
                    ids.append(.session(row.id))
                    row.lastActivityAt = 0
                    row.hasDraft = draftSessionIds.contains(row.id)
                    rows.append(.flat(.session(row)))
                case .archiveToggle:
                    ids.append(.archiveToggle)
                    rows.append(.flat(item))
                case .dayHeader:
                    ids.append(.day(dayIndex))
                    dayIndex += 1
                    rows.append(.flat(item))
                }
            }
        }
        self.init(
            ids: ids,
            rows: rows,
            avatarStyle: list.avatarStyle,
            avatarMonochrome: list.avatarMonochrome,
            grouped: list.projects != nil,
            offline: offline
        )
    }

    /// A bot's or an archived chat's row (ProjectHomeList.tsx `ChatRow`)
    /// draws no line changes either.
    private static func rendered(_ row: ProjectHomeRow) -> ProjectHomeRow {
        switch row {
        case .bot(var session):
            session.lastActivityAt = 0
            session.changes = nil
            session.hasDraft = false
            return .bot(session)
        case .archived(var session):
            session.lastActivityAt = 0
            session.changes = nil
            session.hasDraft = false
            return .archived(session)
        default:
            return row
        }
    }

    /// The row that opens chat `id`, for keeping it selected.
    public func index(ofSession id: String) -> Int? {
        rows.firstIndex { $0.sessionId == id }
    }
}

/// What home shows (`HomeState`), with the list reduced to what it draws.
public enum HomeContent: Equatable, Sendable {
    case loading
    case link
    case offline([MachineChoice], hasArchived: Bool)
    case noSessions
    case list(HomeListModel)

    public init(_ state: HomeState, expandedProjects: Set<String>, draftSessionIds: Set<String> = []) {
        switch state {
        case .loading: self = .loading
        case .link: self = .link
        case .offline(let choices, let hasArchived): self = .offline(choices, hasArchived: hasArchived)
        case .noSessions: self = .noSessions
        case .list(let list, let offline): self = .list(HomeListModel(list, offline: offline, expandedProjects: expandedProjects, draftSessionIds: draftSessionIds))
        }
    }

    /// Which screen home embeds; a change of kind swaps the content.
    public enum Kind: Equatable, Sendable {
        case loading, link, offline, noSessions, list
    }

    public var kind: Kind {
        switch self {
        case .loading: .loading
        case .link: .link
        case .offline: .offline
        case .noSessions: .noSessions
        case .list: .list
        }
    }

    public var list: HomeListModel? {
        if case .list(let model) = self { return model }
        return nil
    }
}

/// One home update for the main thread: what to show and, for the list,
/// how to get there from the rows on screen.
public struct HomeUpdate: Sendable {
    public var content: HomeContent
    /// The content differs from the one on screen (otherwise only the dock
    /// changed).
    public var contentChanged: Bool
    /// Against the list home applied last; when the last content was not a
    /// list (or there was none), against no rows.
    public var changeset: RowChangeset
    /// The content's kind differs from the one on screen.
    public var kindChanged: Bool
    /// What the new-session pickers read, when it changed.
    public var dock: HomeSnapshot?
    /// The home filter's choice, for its menu.
    public var grouping: SessionListGrouping
}

/// Home's derivation: snapshot to content to changeset, off the main thread.
public enum HomeDerivation {
    /// Everything home is derived from. The snapshot comes from the feed;
    /// the rest is read on the main thread and handed over.
    public struct Input: Sendable {
        public var snapshot: HomeSnapshot?
        public var expandedProjects: Set<String>
        public var draftSessionIds: Set<String>
        /// Home's dock also wants the new-session pickers' snapshot.
        public var includesDock: Bool
        /// Nil uses the time of the derivation; tests fix it. Never the
        /// presence clock: that one stands still while nothing is
        /// disconnected, and headings and stamps would go stale with it.
        public var clock: SessionList.Clock?
        /// `status.unknown` in the screens' language, read on the main
        /// thread when the screen is built; a new language builds the
        /// screens again, and with them this.
        public var unknownMachine: String

        public init(
            snapshot: HomeSnapshot? = nil,
            expandedProjects: Set<String> = [],
            includesDock: Bool = false,
            clock: SessionList.Clock? = nil,
            draftSessionIds: Set<String> = [],
            unknownMachine: String = ProjectHomeData.unknownMachineText
        ) {
            self.unknownMachine = unknownMachine
            self.snapshot = snapshot
            self.expandedProjects = expandedProjects
            self.draftSessionIds = draftSessionIds
            self.includesDock = includesDock
            self.clock = clock
        }
    }

    /// What home shows now; empty before the first apply.
    public struct Applied: Equatable, Sendable {
        public var content: HomeContent?
        public var dock: HomeSnapshot?
        public var grouping: SessionListGrouping?

        public init(content: HomeContent? = nil, dock: HomeSnapshot? = nil, grouping: SessionListGrouping? = nil) {
            self.content = content
            self.dock = dock
            self.grouping = grouping
        }
    }

    /// Nil when the screen already shows exactly this.
    public static func derive(_ input: Input, applied: Applied) -> (output: HomeUpdate, state: Applied)? {
        guard let snapshot = input.snapshot else { return nil }
        let state = HomeState(snapshot, clock: input.clock ?? SessionList.Clock(), unknownMachine: input.unknownMachine)
        let content = HomeContent(state, expandedProjects: input.expandedProjects, draftSessionIds: input.draftSessionIds)
        let dock = input.includesDock ? NewSessionSnapshot.rendered(snapshot) : nil
        let dockChanged = dock != nil && dock != applied.dock
        let grouping = AccountSettings(snapshot.settings).sessionListGrouping
        guard content != applied.content || dockChanged || grouping != applied.grouping else { return nil }
        let before = applied.content?.list
        let after = content.list ?? .empty
        let rows = before?.rows ?? []
        let changeset = content == applied.content
            ? RowChangeset()
            : RowChangeset(oldIds: before?.ids ?? [], newIds: after.ids) { rows[$0] != after.rows[$1] }
        let update = HomeUpdate(
            content: content,
            contentChanged: content != applied.content,
            changeset: changeset,
            kindChanged: applied.content?.kind != content.kind,
            dock: dockChanged ? dock : nil,
            grouping: grouping
        )
        return (update, Applied(content: content, dock: dock ?? applied.dock, grouping: grouping))
    }
}

/// What the new-session pickers (home's dock and the new-session screen)
/// read from the store, without what changes on every heartbeat or cursor:
/// they list machines, places and projects, newest first. A session's
/// `active`, `lastMeaningfulMessageAt` and `lastMessageSentAt` order them
/// and stay; its heartbeat, thinking and agent state never show and are
/// cleared.
public enum NewSessionSnapshot {
    public static func rendered(_ snapshot: HomeSnapshot) -> HomeSnapshot {
        var snapshot = snapshot
        // The pickers show no last seen: a presence tick changes nothing.
        snapshot.presenceNow = nil
        snapshot.sessions = snapshot.sessions.map { original in
            var record = ChatSessionState.rendered(original)
            if let at = original.metadata?["lastMeaningfulMessageAt"], case .object(var fields)? = record.metadata {
                fields["lastMeaningfulMessageAt"] = at
                record.metadata = .object(fields)
            }
            // The device's own accepted send orders a session the server
            // hasn't stamped yet.
            record.lastMessageSentAt = original.lastMessageSentAt
            record.activeAt = 0
            record.agentState = nil
            record.thinking = false
            record.archiving = false
            return record
        }
        return snapshot
    }

    /// The new-session screen's derivation: the pickers' snapshot once the
    /// computers are known (synced, or on disk from before), nil until then
    /// and whenever it is what the screen has.
    public static func derive(_ snapshot: HomeSnapshot?, applied: HomeSnapshot?) -> (output: HomeSnapshot, state: HomeSnapshot?)? {
        guard let snapshot, snapshot.machines.synced || !snapshot.machines.machines.isEmpty else { return nil }
        let rendered = rendered(snapshot)
        guard rendered != applied else { return nil }
        return (rendered, rendered)
    }
}
