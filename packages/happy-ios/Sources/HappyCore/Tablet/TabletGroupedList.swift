import Foundation
import HappyStore
import HappyWire

/// The iPad sidebar's list grouped by project. MainView.tsx's sidebar
/// variant mounts SessionsList.tsx itself, never SessionsListWrapper's
/// ProjectHomeList, so with `sessionListGrouping: 'project'` the sidebar
/// shows SessionsList's own hierarchy (its `data` memo), not home's
/// project cards:
///   - the bots under "Bots", as flat rows;
///   - each computer's rule (`MachineHeader`), then its projects by name,
///     each checkout a heading (ProjectGroup.tsx `WorkspaceSection`) over
///     a card of its chats (`CompactSessionRow`);
///   - the archive toggle, then the archive by day as SessionItem cards.
///
/// The flat grouping is home's own flat list (`HomeListModel`). Only values
/// a cell renders are here, so a new activity redraws nothing it doesn't
/// show.
public struct TabletGroupedList: Equatable, Sendable {
    public var ids: [TabletGroupedRow.ID]
    public var rows: [TabletGroupedRow]
    public var avatarStyle: AvatarStyle
    public var avatarMonochrome: Bool
    /// Every computer, when all are offline, for the plaque above the rows.
    public var offline: [MachineChoice]?

    public static let empty = TabletGroupedList(ids: [], rows: [], avatarStyle: .gradient, avatarMonochrome: false, offline: nil)

    /// The checkouts its headings show the status of.
    public var checkouts: Set<GitCheckoutKey> {
        Set(rows.compactMap { row in
            if case .workspace(let header) = row { return header.checkout }
            return nil
        })
    }

    public init(ids: [TabletGroupedRow.ID], rows: [TabletGroupedRow], avatarStyle: AvatarStyle, avatarMonochrome: Bool, offline: [MachineChoice]?) {
        self.ids = ids
        self.rows = rows
        self.avatarStyle = avatarStyle
        self.avatarMonochrome = avatarMonochrome
        self.offline = offline
    }

    /// `clock` is the time now (rows' dates and the day headings), never
    /// the presence clock, which can stand still for hours. `git` is each
    /// checkout's status as far as it is known (`useSessionGitStatus`).
    public init(
        _ snapshot: HomeSnapshot,
        offline: [MachineChoice]?,
        clock: SessionList.Clock = SessionList.Clock(),
        git: [GitCheckoutKey: GitHeadingStatus] = [:],
        draftSessionIds: Set<String> = [],
        unknownMachine: String = ProjectHomeData.unknownMachineText
    ) {
        let settings = AccountSettings(snapshot.settings)
        let machines = Dictionary(snapshot.machines.machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let projects = Dictionary(snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let formatter = SessionTimestampFormatter(clock: clock)
        // "Last seen" is written at the presence clock, which moves only
        // when that text would; dates and day headings at `clock`.
        let lastSeenNow = snapshot.presenceNow ?? Int64(clock.now.timeIntervalSince1970 * 1000)

        func row(_ session: SessionRecord, archived: Bool, divider: Bool) -> SessionRow {
            var row = SessionList.row(
                session,
                archived: archived,
                showsDivider: divider,
                machines: machines,
                projects: projects,
                showFlavorIcons: settings.showFlavorIcons,
                formatter: formatter
            )
            // It orders the list; the row draws `timestamp`.
            row.lastActivityAt = 0
            row.hasDraft = draftSessionIds.contains(row.id)
            return row
        }

        var records: [String: SessionRecord] = [:]
        var rigProjectSessions: [SessionRecord] = []
        var rigPathSessions: [SessionRecord] = []
        var happySessions: [SessionRecord] = []
        var botSessions: [SessionRecord] = []
        var archivedSessions: [SessionRecord] = []
        // storage.ts `buildSessionListViewData`.
        for session in snapshot.sessions where session.metadata?["isSideChat"]?.boolValue != true {
            records[session.id] = session
            if session.isArchived {
                archivedSessions.append(session)
            } else if session.isBot {
                botSessions.append(session)
            } else if session.isRig {
                if session.metadata?["project"]?["id"]?.stringValue?.isEmpty == false {
                    rigProjectSessions.append(session)
                } else {
                    rigPathSessions.append(session)
                }
            } else {
                happySessions.append(session)
            }
        }
        func sortLive(_ sessions: inout [SessionRecord]) {
            sessions.sort { a, b in
                if a.active != b.active { return a.active }
                if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
                return a.id < b.id
            }
        }
        sortLive(&rigProjectSessions)
        sortLive(&rigPathSessions)
        sortLive(&happySessions)
        botSessions.sort { a, b in
            let machineA = a.metadata?["machineId"]?.stringValue ?? ""
            let machineB = b.metadata?["machineId"]?.stringValue ?? ""
            if machineA != machineB { return Collation.precedes(machineA, machineB) }
            let keyA = a.metadata?["bot"]?["orderKey"]?.stringValue ?? ""
            let keyB = b.metadata?["bot"]?["orderKey"]?.stringValue ?? ""
            if keyA != keyB { return keyA < keyB }
            return Collation.precedes(a.id, b.id)
        }
        archivedSessions.sort { a, b in
            if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
            return a.id < b.id
        }

        func member(_ session: SessionRecord) -> ProjectHomeData.Member {
            let metadata = session.metadata
            let machineId = metadata?["machineId"]?.stringValue
            let shown = row(session, archived: false, divider: false)
            return ProjectHomeData.Member(
                row: shown,
                createdAt: session.createdAt,
                active: session.active,
                machineOffline: machineId.flatMap { machines[$0] }.map { !$0.active } ?? false,
                unread: session.unread,
                machineId: machineId,
                path: metadata?["path"]?.stringValue,
                projectId: session.projectReference,
                git: shown.changes,
                projectAvatar: session.isRig ? session.projectReference.flatMap { projects[$0] }.flatMap(AvatarImageSource.project).map {
                    SessionAvatar(seed: shown.avatar.seed, image: $0)
                } : nil
            )
        }
        let allProjects = ProjectHomeData.catalogProjects(rigProjectSessions, member: member)
            + ProjectHomeData.pathProjects(rigPathSessions, prefix: "rig", member: member)
            + ProjectHomeData.pathProjects(happySessions, prefix: "happy", member: member)
        let groups = Self.machineGroups(allProjects, machines: machines, unknownMachine: unknownMachine)

        var ids: [TabletGroupedRow.ID] = []
        var rows: [TabletGroupedRow] = []
        func append(_ id: TabletGroupedRow.ID, _ row: TabletGroupedRow) {
            ids.append(id)
            rows.append(row)
        }

        // SessionsList.tsx: `legacyItems` (the bots), the hierarchy, the
        // toggle, the archive.
        if !botSessions.isEmpty {
            append(.botsHeader, .botsHeader)
            for (index, session) in botSessions.enumerated() {
                append(.bot(session.id), .bot(row(session, archived: false, divider: index < botSessions.count - 1)))
            }
        }
        for group in groups {
            append(.machine(group.machineId), .machine(id: group.machineId, name: group.name))
            for project in group.projects {
                let checkouts = project.checkouts.filter { !$0.sessions.isEmpty }
                for (checkoutIndex, checkout) in checkouts.enumerated() {
                    let header = Self.header(project, checkout, record: records[checkout.sessions[0].row.id], git: git)
                    append(.workspace(header.id), .workspace(header))
                    for (index, chat) in checkout.sessions.enumerated() {
                        let last = index == checkout.sessions.count - 1
                        append(.chat(chat.row.id), .chat(TabletChatRow(
                            chat,
                            first: index == 0,
                            last: last,
                            projectEnd: last && checkoutIndex == checkouts.count - 1
                        )))
                    }
                }
            }
        }
        let hidden = settings.hideArchivedSessions
        if !archivedSessions.isEmpty {
            append(.archiveToggle, .archiveToggle(hidden: hidden))
        }
        if !hidden {
            var day: Date?
            var dayIndex = 0
            var start = rows.count
            for session in archivedSessions {
                let sessionDay = clock.calendar.startOfDay(for: Date(timeIntervalSince1970: Double(session.lastActivityAt) / 1000))
                if sessionDay != day {
                    day = sessionDay
                    append(.archiveHeader(dayIndex), .archiveHeader(formatter.dayAge(sessionDay)))
                    dayIndex += 1
                    start = rows.count
                }
                append(.archived(session.id), .archived(TabletArchivedRow(
                    session,
                    row: row(session, archived: true, divider: false),
                    now: lastSeenNow,
                    first: rows.count == start
                )))
            }
            // `isLast`: the next item is a heading, or there is none.
            for index in rows.indices {
                guard case .archived(var item) = rows[index] else { continue }
                let next = index + 1 < rows.count ? rows[index + 1] : nil
                if case .archived = next { continue }
                item.last = true
                rows[index] = .archived(item)
            }
        }

        self.init(
            ids: ids,
            rows: rows,
            avatarStyle: settings.avatarStyle,
            avatarMonochrome: settings.avatarMonochrome,
            offline: offline
        )
    }

    /// sessionDisplayOrder.ts `buildSessionProjectDisplayGroups`: projects
    /// by computer, each computer's by name; computers by name, the
    /// projects that name none last. SessionsList.tsx reads the names from
    /// `useAllMachines()`, which lists only computers that are online, so an
    /// offline computer goes by its id there and here.
    static func machineGroups(
        _ projects: [ProjectHomeData.Project],
        machines: [String: MachineRecord],
        unknownMachine: String = ProjectHomeData.unknownMachineText
    ) -> [(machineId: String?, name: String, projects: [ProjectHomeData.Project])] {
        var groups: [(machineId: String?, name: String, projects: [ProjectHomeData.Project])] = []
        var index: [String?: Int] = [:]
        for project in projects {
            if let position = index[project.machineId] {
                groups[position].projects.append(project)
                continue
            }
            let machine = project.machineId.flatMap { machines[$0] }.flatMap { $0.active ? $0 : nil }
            let name = nonBlank(machine?.metadata?["displayName"]?.stringValue)
                ?? nonBlank(machine?.metadata?["host"]?.stringValue)
                ?? project.machineId
                ?? "<\(unknownMachine)>"
            index[project.machineId] = groups.count
            groups.append((project.machineId, name, [project]))
        }
        // JavaScript's sort is stable: ties keep the order they came in.
        for position in groups.indices {
            groups[position].projects = groups[position].projects.enumerated().sorted { a, b in
                let byName = Collation.compare(a.element.name, b.element.name)
                if byName != .orderedSame { return byName == .orderedAscending }
                let byId = Collation.compare(a.element.id, b.element.id)
                if byId != .orderedSame { return byId == .orderedAscending }
                return a.offset < b.offset
            }.map(\.element)
        }
        return groups.enumerated().sorted { a, b in
            let unknownA = a.element.machineId == nil
            let unknownB = b.element.machineId == nil
            if unknownA != unknownB { return unknownB }
            let byName = Collation.compare(a.element.name, b.element.name)
            if byName != .orderedSame { return byName == .orderedAscending }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// ProjectGroup.tsx `WorkspaceSection`'s heading, from the checkout's
    /// first chat and that chat's checkout status (`useSessionGitStatus`).
    static func header(
        _ project: ProjectHomeData.Project,
        _ checkout: ProjectHomeData.Checkout,
        record: SessionRecord?,
        git: [GitCheckoutKey: GitHeadingStatus]
    ) -> TabletWorkspaceHeader {
        let first = checkout.sessions[0]
        let path = first.path ?? ""
        let marker = path.range(of: SessionPlace.worktreeMarker)
        let repoPath = marker.map { String(path[..<$0.lowerBound]) } ?? path
        let homeDir = record?.metadata?["homeDir"]?.stringValue
        // `getSessionPathKey`: none without a computer or a path.
        let key = nonBlank(first.machineId).flatMap { machineId in
            path.isEmpty ? nil : GitCheckoutKey(machineId: machineId, path: path)
        }
        let status = key.flatMap { git[$0] }
        let added = status?.unstagedLinesAdded ?? 0
        let removed = status?.unstagedLinesRemoved ?? 0
        return TabletWorkspaceHeader(
            id: "\(project.id)\u{0}\(checkout.id)",
            projectName: project.name,
            // `flavor={null}` and no `bot`: a plain face, never badged.
            avatar: first.projectAvatar ?? SessionAvatar(seed: first.row.avatar.seed),
            // `workspace.name ?? (workspace.id || null)`, then the live
            // branch, then "main".
            branch: checkout.name ?? (checkout.id.isEmpty ? nil : checkout.id) ?? status?.branch ?? "main",
            // The live unstaged lines when there are any, else the first
            // chat's own counts.
            changes: added > 0 || removed > 0
                ? GitLineChanges(approximate: false, insertions: added, deletions: removed)
                : first.git,
            checkout: key,
            place: TabletNewSessionPlace(
                machineId: nonBlank(first.machineId),
                path: repoPath.isEmpty ? nil : NewSessionChoices.relativeToHome(repoPath, homeDir: homeDir),
                worktreeKey: marker == nil ? nil : path
            )
        )
    }
}

/// One row of the grouped sidebar list.
public enum TabletGroupedRow: Equatable, Sendable {
    /// "Bots" over the bots (SessionsList.tsx `headerSection`).
    case botsHeader
    /// A bot as home's flat row; every one but the last keeps its hairline.
    case bot(SessionRow)
    /// ── 🖥 name ── (`MachineHeader`). With an id a tap opens the computer.
    case machine(id: String?, name: String)
    case workspace(TabletWorkspaceHeader)
    case chat(TabletChatRow)
    /// "── Show archived ──" dividing the page.
    case archiveToggle(hidden: Bool)
    /// "Today", "Yesterday", "3 days ago" over the archive.
    case archiveHeader(SessionList.DayAge)
    case archived(TabletArchivedRow)

    /// Who the row is across updates. Every id keeps one cell class: a chat
    /// that is archived is a delete and an insert.
    public enum ID: Hashable, Sendable {
        case botsHeader
        case bot(String)
        case machine(String?)
        /// `TabletWorkspaceHeader.id`.
        case workspace(String)
        case chat(String)
        case archiveToggle
        /// Counted, so the third heading stays the third heading.
        case archiveHeader(Int)
        case archived(String)
    }

    /// The chat a tap on the row opens, if any.
    public var sessionId: String? {
        switch self {
        case .bot(let row): row.id
        case .chat(let row): row.id
        case .archived(let row): row.id
        default: nil
        }
    }
}

/// STATUS_CONFIG's colours in SessionsList.tsx and
/// ActiveSessionsGroupCompact.tsx, and the compact row's idle grey.
public enum TabletStatusTone: Equatable, Sendable {
    /// #999: disconnected.
    case offline
    /// #007AFF: thinking, or unread.
    case working
    /// #34C759: waiting for a message.
    case online
    /// #FF9500: waiting on the person.
    case attention
    /// The theme's `textSecondary`: an idle chat's dot.
    case idle
}

/// A checkout's heading: the first chat's face, the project, the branch
/// with its line changes, and `+`.
public struct TabletWorkspaceHeader: Equatable, Sendable {
    /// The project's id and the checkout's, NUL-separated.
    public var id: String
    public var projectName: String
    public var avatar: SessionAvatar
    public var branch: String
    public var changes: GitLineChanges?
    /// The checkout whose status it shows, if it has one.
    public var checkout: GitCheckoutKey?
    /// Where `+` points the new-session draft.
    public var place: TabletNewSessionPlace
}

/// ProjectGroup.tsx `handleNewSession`: the checkout's computer, its main
/// checkout's path relative to home, and the worktree when it is one.
public struct TabletNewSessionPlace: Equatable, Sendable {
    public var machineId: String?
    public var path: String?
    /// The worktree's path; nil starts a plain session.
    public var worktreeKey: String?
}

/// ActiveSessionsGroupCompact.tsx `CompactSessionRow`: one chat in its
/// checkout's card.
public struct TabletChatRow: Equatable, Sendable {
    public enum Indicator: Equatable, Sendable {
        case none
        case dot(TabletStatusTone, pulsing: Bool)
    }

    public var id: String
    /// Nil reads "New chat".
    public var title: String?
    /// The title in the text colour; the secondary colour when disconnected.
    public var connected: Bool
    /// `renderTrailingIndicator`.
    public var indicator: Indicator
    /// The hairline under every row but the card's last.
    public var showsBorder: Bool
    /// The card's top edge and corners.
    public var first: Bool
    /// The card's bottom edge and corners, and the 8 under it.
    public var last: Bool
    /// The project's last card: ProjectGroup.tsx's 4 below it.
    public var projectEnd: Bool
    /// The compact row draws a draft indicator only while waiting and read.
    public var hasDraft: Bool = false

    public init(id: String, title: String?, connected: Bool, indicator: Indicator, showsBorder: Bool, first: Bool, last: Bool, projectEnd: Bool) {
        self.id = id
        self.title = title
        self.connected = connected
        self.indicator = indicator
        self.showsBorder = showsBorder
        self.first = first
        self.last = last
        self.projectEnd = projectEnd
    }

    init(_ member: ProjectHomeData.Member, first: Bool, last: Bool, projectEnd: Bool) {
        let state = member.row.state
        let indicator: Indicator
        if state == .permissionRequired || state == .inputRequired {
            indicator = .dot(.attention, pulsing: true)
        } else if member.unread {
            indicator = .dot(.working, pulsing: false)
        } else if state == .thinking {
            indicator = .dot(.working, pulsing: true)
        } else if state == .waiting {
            indicator = .dot(.idle, pulsing: false)
        } else {
            indicator = .none
        }
        self.init(
            id: member.row.id,
            title: member.row.title,
            connected: state != .disconnected,
            indicator: indicator,
            showsBorder: !last,
            first: first,
            last: last,
            projectEnd: projectEnd
        )
        hasDraft = member.row.hasDraft && state == .waiting && !member.unread
    }
}

/// SessionsList.tsx `SessionItem`: an archived chat as a card of its own.
public struct TabletArchivedRow: Equatable, Sendable {
    public enum Subtitle: Equatable, Sendable {
        /// A Happy Agent session: the provider's glyph and "<client> ·
        /// <provider>", in a row with 4 under it.
        case identity(String, ProviderIconKind)
        /// The folder the chat ran in, in the same row.
        case folder(String)
        /// A bot's "@name", or the path from home: a bare line.
        case text(String)
        /// `status.unknown`, bare: no metadata to name a place.
        case unknown

        /// The line sits in a row, with 4 under it.
        public var inRow: Bool {
            switch self {
            case .identity, .folder: true
            case .text, .unknown: false
            }
        }

        /// ProviderIcon leads the line.
        public var hasProviderIcon: Bool {
            if case .identity = self { return true }
            return false
        }
    }

    /// The status line's middle part.
    public enum Status: Equatable, Sendable {
        case inputRequired
        case permissionRequired
        case unread
        /// A vibing word, drawn by the cell when the state changes.
        case thinking
        case lastSeen(ComposerStatus.LastSeen)
        case online
    }

    public var id: String
    /// Nil reads "New chat".
    public var title: String?
    public var avatar: SessionAvatar
    /// `isConnected`: the title in the text colour and the avatar in colour.
    public var connected: Bool
    public var subtitle: Subtitle
    public var status: Status
    public var tone: TabletStatusTone
    public var pulsing: Bool
    /// Ahead of the status: "<model> · ".
    public var modelName: String?
    /// After it: " · 2+1 subagents · 3 tasks".
    public var activity: String?
    /// The top corners, after a day heading.
    public var first: Bool
    /// The bottom corners and the 12 under it, before a heading or the end.
    public var last: Bool
    /// The archive card's avatar overlay.
    public var hasDraft: Bool = false

    init(_ session: SessionRecord, row: SessionRow, now: Int64, first: Bool) {
        let state = row.state
        let needsAction = state == .permissionRequired || state == .inputRequired
        var tone: TabletStatusTone
        var pulsing: Bool
        switch state {
        case .disconnected: (tone, pulsing) = (.offline, false)
        case .thinking: (tone, pulsing) = (.working, true)
        case .waiting: (tone, pulsing) = (.online, false)
        case .permissionRequired, .inputRequired: (tone, pulsing) = (.attention, true)
        }
        // An unread turn is blue and still, unless the person is needed.
        if session.unread && !needsAction {
            tone = .working
            pulsing = false
        }
        let status: Status
        if state == .inputRequired {
            status = .inputRequired
        } else if state == .permissionRequired {
            status = .permissionRequired
        } else if session.unread {
            status = .unread
        } else if state == .thinking {
            status = .thinking
        } else if state == .disconnected {
            status = .lastSeen(ComposerStatus.lastSeen(activeAt: session.activeAt, now: now))
        } else {
            status = .online
        }

        let metadata = session.metadata
        let identity = RigIdentity(metadata)
        let subtitle: Subtitle
        if let identity {
            subtitle = .identity("\(identity.clientName) · \(identity.providerName)", identity.providerKind)
        } else if let path = metadata?["path"]?.stringValue, !path.isEmpty {
            subtitle = .folder(path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "")
        } else if session.isBot {
            subtitle = .text(row.projectName)
        } else if metadata != nil {
            subtitle = .text(NewSessionChoices.relativeToHome(metadata?["path"]?.stringValue ?? "", homeDir: metadata?["homeDir"]?.stringValue))
        } else {
            subtitle = .unknown
        }

        self.id = session.id
        self.hasDraft = row.hasDraft
        self.title = row.title
        self.avatar = row.avatar
        self.connected = state != .disconnected
        self.subtitle = subtitle
        self.status = status
        self.tone = tone
        self.pulsing = pulsing
        self.modelName = identity?.modelName
        self.activity = Self.activitySummary(metadata)
        self.first = first
        self.last = false
    }

    /// rig.ts `getRigActivityIndicators`, as SessionsList.tsx writes them:
    /// "<running>[+<queued>] <kind>", joined by " · ".
    static func activitySummary(_ metadata: JSONValue?) -> String? {
        guard let metadata, metadata["client"]?["id"]?.stringValue == "rig",
              let activity = metadata["activity"], activity.objectValue != nil
        else { return nil }
        func count(_ group: String, _ field: String) -> Int {
            Int(activity[group]?[field]?.numberValue ?? 0)
        }
        var items: [(key: String, count: Int, queued: Int)] = []
        if count("subagents", "running") > 0 || count("subagents", "queued") > 0 {
            items.append(("subagents", count("subagents", "running"), count("subagents", "queued")))
        }
        if count("workflows", "running") > 0 {
            items.append(("workflows", count("workflows", "running"), 0))
        }
        if count("processes", "running") > 0 {
            items.append(("processes", count("processes", "running"), 0))
        }
        if count("tasks", "pending") + count("tasks", "inProgress") > 0 {
            items.append(("tasks", count("tasks", "inProgress"), count("tasks", "pending")))
        }
        guard !items.isEmpty else { return nil }
        return items.map { "\($0.count)\($0.queued != 0 ? "+\($0.queued)" : "") \($0.key)" }.joined(separator: " · ")
    }
}

private func nonBlank(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
