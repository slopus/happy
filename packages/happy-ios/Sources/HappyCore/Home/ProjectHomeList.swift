import Foundation
import HappyStore
import HappyWire

/// The home list grouped by project (`sessionListGrouping: 'project'`):
/// storage.ts `buildSessionListViewData`, sync/projectGroups.ts and
/// utils/projectHomeList.ts.
///
/// Under each computer come its bots, then one card per project with that
/// project's worktrees on a tree line beneath it. The project's own checkout
/// is the card. Chats are not rows: a checkout opens its newest chat. The
/// archive trails as the flat list's day-grouped tail.
///
/// `ProjectHomeData` is everything but the expansion, which is a device
/// setting; `rows(expanded:)` lays it out.
public struct ProjectHomeData: Equatable, Sendable {
    /// `WORKTREE_PREVIEW_COUNT`: worktrees drawn before the rest fold away.
    public static let worktreePreviewCount = 3

    /// One checkout of a project and its chats.
    public struct Checkout: Equatable, Sendable {
        /// Empty for the project's own checkout.
        public var id: String
        /// Nil for the project's own checkout.
        public var name: String?
        /// Live first, then by activity: the first one is what a tap opens.
        public var sessions: [Member]
    }

    /// What the project list needs to know about one chat.
    public struct Member: Equatable, Sendable {
        public var row: SessionRow
        public var createdAt: Int64
        public var active: Bool
        public var machineOffline: Bool
        public var unread: Bool
        public var machineId: String?
        public var path: String?
        /// A Happy Agent catalog project.
        public var projectId: String?
        /// Happy Agent's whole-checkout line counts (rig.ts `getRigGitSummary`).
        public var git: GitLineChanges?
        public var projectAvatar: SessionAvatar? = nil
    }

    public struct Project: Equatable, Sendable {
        public var id: String
        public var name: String
        public var machineId: String?
        /// The primary checkout first, the rest newest first.
        public var checkouts: [Checkout]
    }

    public struct MachineSection: Equatable, Sendable {
        public var machineId: String?
        public var name: String
        public var rig: Bool
        public var bots: [SessionRow]
        /// By name, as `buildSessionProjectDisplayGroups` sorts them.
        public var projects: [Project]
        public var lastActivityAt: Int64
    }

    public enum ArchivedItem: Equatable, Sendable {
        case dayHeader(SessionList.DayAge)
        case session(SessionRow)
    }

    /// Ordered: Happy Agent computers, then Happy CLI ones, then chats that
    /// name no computer; most recently worked on first within each.
    public var sections: [MachineSection]
    public var hasArchived: Bool
    public var archiveHidden: Bool
    /// The archive, newest first, when it is shown.
    public var archived: [ArchivedItem]

    /// `unknownMachine` is `status.unknown` in the screens' language, read
    /// on the main thread: the section of chats that name no computer is
    /// `<unknown>` (ProjectHomeList.tsx 128).
    public init(_ snapshot: HomeSnapshot, clock: SessionList.Clock = SessionList.Clock(), unknownMachine: String = ProjectHomeData.unknownMachineText) {
        let settings = AccountSettings(snapshot.settings)
        let machines = Dictionary(snapshot.machines.machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let projects = Dictionary(snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let formatter = SessionTimestampFormatter(clock: clock)

        func member(_ session: SessionRecord, archived: Bool) -> Member {
            let row = SessionList.row(
                session,
                archived: archived,
                showsDivider: false,
                machines: machines,
                projects: projects,
                showFlavorIcons: settings.showFlavorIcons,
                formatter: formatter
            )
            let metadata = session.metadata
            let machineId = metadata?["machineId"]?.stringValue
            return Member(
                row: row,
                createdAt: session.createdAt,
                active: session.active,
                machineOffline: machineId.flatMap { machines[$0] }.map { !$0.active } ?? false,
                unread: session.unread,
                machineId: machineId,
                path: metadata?["path"]?.stringValue,
                projectId: session.projectReference,
                git: row.changes,
                projectAvatar: session.isRig ? session.projectReference.flatMap { projects[$0] }.flatMap(AvatarImageSource.project).map {
                    SessionAvatar(seed: row.avatar.seed, image: $0)
                } : nil
            )
        }

        var rigProjectSessions: [SessionRecord] = []
        var rigPathSessions: [SessionRecord] = []
        var happySessions: [SessionRecord] = []
        var botSessions: [SessionRecord] = []
        var archivedSessions: [SessionRecord] = []
        for session in snapshot.sessions where session.metadata?["isSideChat"]?.boolValue != true {
            if session.isArchived {
                archivedSessions.append(session)
            } else if session.isBot {
                botSessions.append(session)
            } else if session.isRig {
                if session.metadata?["project"]?["id"]?.stringValue != nil {
                    rigProjectSessions.append(session)
                } else {
                    rigPathSessions.append(session)
                }
            } else {
                happySessions.append(session)
            }
        }
        // Live first, then by the last meaningful message.
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

        let allProjects = Self.catalogProjects(rigProjectSessions, member: { member($0, archived: false) })
            + Self.pathProjects(rigPathSessions, prefix: "rig", member: { member($0, archived: false) })
            + Self.pathProjects(happySessions, prefix: "happy", member: { member($0, archived: false) })

        // Sections, in the order a machine is first seen.
        var order: [String?] = []
        var byMachine: [String?: MachineSection] = [:]
        func section(_ machineId: String?) -> MachineSection {
            if let existing = byMachine[machineId] { return existing }
            let machine = machineId.flatMap { machines[$0] }
            let name = nonEmpty(machine?.metadata?["displayName"]?.stringValue)
                ?? nonEmpty(machine?.metadata?["host"]?.stringValue)
                ?? machineId
                ?? "<\(unknownMachine)>"
            order.append(machineId)
            return MachineSection(
                machineId: machineId,
                name: name,
                rig: machine?.metadata?["machineKind"]?.stringValue == "rig",
                bots: [],
                projects: [],
                lastActivityAt: 0
            )
        }
        for session in botSessions {
            let machineId = session.metadata?["machineId"]?.stringValue
            var entry = section(machineId)
            let built = member(session, archived: false)
            entry.bots.append(built.row)
            entry.lastActivityAt = max(entry.lastActivityAt, built.row.lastActivityAt)
            byMachine[machineId] = entry
        }
        for project in allProjects {
            var entry = section(project.machineId)
            entry.projects.append(project)
            for checkout in project.checkouts {
                for session in checkout.sessions {
                    entry.lastActivityAt = max(entry.lastActivityAt, session.row.lastActivityAt)
                }
            }
            byMachine[project.machineId] = entry
        }
        var sections = order.compactMap { byMachine[$0] }
        for index in sections.indices {
            sections[index].projects.sort { a, b in
                let byName = Collation.compare(a.name, b.name)
                if byName != .orderedSame { return byName == .orderedAscending }
                return Collation.precedes(a.id, b.id)
            }
        }
        sections.sort { a, b in
            let rankA = Self.rank(a)
            let rankB = Self.rank(b)
            if rankA != rankB { return rankA < rankB }
            if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
            return Collation.precedes(a.name, b.name)
        }
        self.sections = sections

        archivedSessions.sort { a, b in
            if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
            return a.id < b.id
        }
        hasArchived = !archivedSessions.isEmpty
        archiveHidden = settings.hideArchivedSessions
        var archived: [ArchivedItem] = []
        if !archiveHidden {
            var currentDay: Date?
            for session in archivedSessions {
                let day = clock.calendar.startOfDay(for: Date(timeIntervalSince1970: Double(session.lastActivityAt) / 1000))
                if day != currentDay {
                    currentDay = day
                    archived.append(.dayHeader(formatter.dayAge(day)))
                }
                archived.append(.session(member(session, archived: true).row))
            }
        }
        self.archived = archived
    }

    /// `status.unknown` in English, in `<unknown>` for a chat that names no
    /// computer; the screens pass their own language's.
    public static let unknownMachineText = "unknown"

    private static func rank(_ section: MachineSection) -> Int {
        if section.machineId == nil { return 2 }
        return section.rig ? 0 : 1
    }

    /// `buildProjectGroups`: Happy Agent's catalog projects and workspaces.
    static func catalogProjects(_ sessions: [SessionRecord], member: (SessionRecord) -> Member) -> [Project] {
        var projects: [Project] = []
        var index: [String: Int] = [:]
        for session in sessions {
            guard let projectId = session.metadata?["project"]?["id"]?.stringValue else { continue }
            let workspace = session.metadata?["workspace"]
            let workspaceId = workspace?["id"]?.stringValue ?? ""
            let position: Int
            if let existing = index[projectId] {
                position = existing
            } else {
                position = projects.count
                index[projectId] = position
                projects.append(Project(
                    id: projectId,
                    name: session.metadata?["project"]?["name"]?.stringValue ?? "",
                    machineId: session.metadata?["machineId"]?.stringValue,
                    checkouts: []
                ))
            }
            projects[position].add(member(session), checkoutId: workspaceId, name: workspace?["name"]?.stringValue)
        }
        return projects.map { $0.primaryFirst() }
    }

    /// `buildPathProjectGroups`: one project per machine and repository,
    /// with Happy's worktrees (`/.dev/worktree/<name>`) under their checkout.
    static func pathProjects(_ sessions: [SessionRecord], prefix: String, member: (SessionRecord) -> Member) -> [Project] {
        var projects: [Project] = []
        var index: [String: Int] = [:]
        for session in sessions {
            let machineId = session.metadata?["machineId"]?.stringValue
            let path = (session.metadata?["path"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let marker = path.range(of: SessionPlace.worktreeMarker)
            let projectPath = marker.map { String(path[..<$0.lowerBound]) } ?? path
            let checkoutId = marker == nil ? "" : path
            let checkoutName = marker.map { String(path[$0.upperBound...]) }
            let key = jsonKey(machineId, projectPath)
            let position: Int
            if let existing = index[key] {
                position = existing
            } else {
                position = projects.count
                index[key] = position
                projects.append(Project(
                    id: "\(prefix):\(key)",
                    name: pathProjectName(projectPath, homeDir: session.metadata?["homeDir"]?.stringValue),
                    machineId: machineId,
                    checkouts: []
                ))
            }
            projects[position].add(member(session), checkoutId: checkoutId, name: checkoutName)
        }
        return projects.map { $0.primaryFirst() }
    }

    /// `JSON.stringify([machineId, projectPath])`.
    static func jsonKey(_ machineId: String?, _ path: String) -> String {
        func quoted(_ value: String) -> String {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.withoutEscapingSlashes]
            let data = (try? encoder.encode(value)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
        return "[\(machineId.map(quoted) ?? "null"),\(quoted(path))]"
    }

    /// projectGroups.ts `pathProjectName`.
    static func pathProjectName(_ path: String, homeDir: String?) -> String {
        func trimmed(_ value: String) -> String {
            var value = Substring(value)
            while let last = value.last, last == "/" || last == "\\" { value = value.dropLast() }
            return String(value)
        }
        let normalized = trimmed(path)
        let home = homeDir.map(trimmed)
        if normalized.isEmpty || normalized == "~" || normalized == home {
            return "Home"
        }
        return normalized.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? normalized
    }

    // MARK: Rows

    /// `buildProjectHomeRows` with `expanded` projects showing every
    /// worktree.
    public func rows(expanded: Set<String>) -> [ProjectHomeRow] {
        var rows: [ProjectHomeRow] = []
        for section in sections {
            let projectRows = section.projects.flatMap { Self.projectRows($0, expanded: expanded.contains($0.id)) }
            guard !section.bots.isEmpty || !projectRows.isEmpty else { continue }
            let key = section.machineId ?? "unknown"
            rows.append(.machine(id: section.machineId, name: section.name))
            if !section.bots.isEmpty {
                rows.append(.section(id: "bots:\(key)", label: .bots))
                rows.append(contentsOf: section.bots.map(ProjectHomeRow.bot))
            }
            if !projectRows.isEmpty {
                rows.append(.section(id: "projects:\(key)", label: .projects))
                rows.append(contentsOf: projectRows)
            }
        }
        if hasArchived {
            rows.append(.archiveToggle(hidden: archiveHidden))
        }
        for item in archived {
            switch item {
            case .dayHeader(let age): rows.append(.archiveHeader(age))
            case .session(let row): rows.append(.archived(row))
            }
        }
        return rows
    }

    static func projectRows(_ project: Project, expanded: Bool) -> [ProjectHomeRow] {
        let checkouts = project.checkouts.filter { !$0.sessions.isEmpty }
        guard !checkouts.isEmpty else { return [] }
        let primary = checkouts.first { $0.id.isEmpty }
        let worktrees = checkouts.filter { !$0.id.isEmpty }
        let ownTabs = primary?.sessions ?? []
        let origin = (primary?.sessions.first ?? worktrees.first?.sessions.first).flatMap(WorkspaceOrigin.init)
        var rows: [ProjectHomeRow] = [.project(ProjectHomeEntry(
            id: project.id,
            name: project.name,
            sessionId: primary?.sessions.first?.row.id,
            avatar: (primary?.sessions.first ?? worktrees.first?.sessions.first).map {
                $0.projectAvatar ?? SessionAvatar(seed: $0.row.avatar.seed)
            },
            worktreeCount: worktrees.count,
            activity: HomeActivity(ownTabs),
            live: ownTabs.contains { $0.active && !$0.machineOffline },
            changes: primary?.sessions.first?.git,
            origin: origin
        ))]

        let shown = expanded ? worktrees : Array(worktrees.prefix(worktreePreviewCount))
        let hidden = Array(worktrees.dropFirst(shown.count))
        let togglable = expanded ? worktrees.count > worktreePreviewCount : !hidden.isEmpty
        for (index, checkout) in shown.enumerated() {
            guard let newest = checkout.sessions.first else { continue }
            rows.append(.worktree(ProjectWorktree(
                id: "\(project.id)\u{0}\(checkout.id)",
                title: checkout.name ?? checkout.id,
                sessionId: newest.row.id,
                activity: HomeActivity(checkout.sessions),
                changes: newest.git
            ), last: !togglable && index == shown.count - 1))
        }
        if togglable {
            rows.append(.worktreeToggle(WorktreeToggle(
                projectId: project.id,
                worktreeCount: worktrees.count,
                hiddenCount: hidden.count,
                expanded: expanded,
                activity: HomeActivity(hidden.flatMap(\.sessions))
            )))
        }
        return rows
    }
}

extension ProjectHomeData.Project {
    mutating func add(_ member: ProjectHomeData.Member, checkoutId: String, name: String?) {
        if let index = checkouts.firstIndex(where: { $0.id == checkoutId }) {
            checkouts[index].sessions.append(member)
        } else {
            checkouts.append(ProjectHomeData.Checkout(id: checkoutId, name: name, sessions: [member]))
        }
    }

    /// The primary checkout leads even when a worktree was newer.
    func primaryFirst() -> ProjectHomeData.Project {
        var copy = self
        if let index = copy.checkouts.firstIndex(where: { $0.id.isEmpty }), index > 0 {
            let primary = copy.checkouts.remove(at: index)
            copy.checkouts.insert(primary, at: 0)
        }
        return copy
    }
}

/// Unread, working and blocked across some chats (`activityState`).
public struct HomeActivity: Equatable, Sendable {
    public var unread: Bool
    public var working: Bool
    public var blocked: Bool

    public init(unread: Bool = false, working: Bool = false, blocked: Bool = false) {
        self.unread = unread
        self.working = working
        self.blocked = blocked
    }

    init(_ members: [ProjectHomeData.Member]) {
        unread = members.contains { $0.unread }
        working = members.contains { $0.row.state == .thinking }
        blocked = members.contains { $0.row.state == .permissionRequired || $0.row.state == .inputRequired }
    }
}

/// The line changes a checkout carries (rigGitLineChanges.ts).
public struct GitLineChanges: Equatable, Sendable {
    public var approximate: Bool
    public var insertions: Int
    public var deletions: Int

    public init(approximate: Bool, insertions: Int, deletions: Int) {
        self.approximate = approximate
        self.insertions = insertions
        self.deletions = deletions
    }

    /// `visibleRigGitLineChanges` over `metadata.git`; nil when nothing
    /// changed.
    init?(rigSummary git: JSONValue?) {
        guard let git, git.objectValue != nil else { return nil }
        let insertions = Int(git["insertions"]?.numberValue ?? 0)
        let deletions = Int(git["deletions"]?.numberValue ?? 0)
        guard insertions > 0 || deletions > 0 else { return nil }
        self.init(approximate: git["countsExact"]?.boolValue == false, insertions: insertions, deletions: deletions)
    }

    /// `compactCount`: 999, 1.2k, 12k.
    public static func compact(_ value: Int) -> String {
        let count = max(0, value)
        if count < 1_000 { return String(count) }
        if count < 5_000 {
            let tenths = (Double(count) / 100).rounded() / 10
            return tenths == tenths.rounded() ? "\(Int(tenths))k" : "\(tenths)k"
        }
        return "\(Int((Double(count) / 1_000).rounded()))k"
    }
}

/// Where a new workspace for a project would be created
/// (projectHomeList.ts `workspaceOrigin`).
public struct WorkspaceOrigin: Equatable, Sendable {
    public var machineId: String
    /// A Happy Agent catalog project, named instead of a directory.
    public var projectId: String?
    /// The project's main checkout; nil when named by identity.
    public var path: String?

    init(machineId: String, projectId: String?, path: String?) {
        self.machineId = machineId
        self.projectId = projectId
        self.path = path
    }

    init?(_ member: ProjectHomeData.Member) {
        guard let machineId = member.machineId else { return nil }
        if let projectId = member.projectId {
            self.machineId = machineId
            self.projectId = projectId
            self.path = nil
            return
        }
        let path = (member.path ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        self.machineId = machineId
        self.projectId = nil
        self.path = path.range(of: SessionPlace.worktreeMarker).map { String(path[..<$0.lowerBound]) } ?? path
    }
}

/// A project's card.
public struct ProjectHomeEntry: Equatable, Sendable {
    public var id: String
    public var name: String
    /// The own checkout's newest chat; nil for a project with only worktrees.
    public var sessionId: String?
    public var avatar: SessionAvatar?
    public var worktreeCount: Int
    public var activity: HomeActivity
    public var live: Bool
    public var changes: GitLineChanges?
    /// Nil when no chat says where it runs: nowhere to create a workspace.
    public var origin: WorkspaceOrigin?
}

/// One worktree on its project's tree line.
public struct ProjectWorktree: Equatable, Sendable {
    public var id: String
    public var title: String
    /// What a tap opens: the newest chat in it.
    public var sessionId: String
    public var activity: HomeActivity
    public var changes: GitLineChanges?
}

/// "Show all 7 workspaces" / "Show fewer", ending a project's worktrees.
public struct WorktreeToggle: Equatable, Sendable {
    public var projectId: String
    public var worktreeCount: Int
    public var hiddenCount: Int
    public var expanded: Bool
    /// What is held back, so a blocked worktree is not hidden by a count.
    public var activity: HomeActivity
}

public enum ProjectHomeRow: Equatable, Sendable {
    public enum SectionLabel: Equatable, Sendable {
        case bots
        case projects
    }

    case machine(id: String?, name: String)
    case section(id: String, label: SectionLabel)
    case bot(SessionRow)
    case project(ProjectHomeEntry)
    /// `last` closes the tree line.
    case worktree(ProjectWorktree, last: Bool)
    case worktreeToggle(WorktreeToggle)
    case archiveToggle(hidden: Bool)
    case archiveHeader(SessionList.DayAge)
    case archived(SessionRow)

    /// A stable identity for diffing (ProjectHomeList.tsx `keyExtractor`).
    public var key: String {
        switch self {
        case .machine(let id, _): "machine-\(id ?? "unknown")"
        case .section(let id, _): "section-\(id)"
        case .bot(let row): "bot-\(row.id)"
        case .project(let entry): "project-\(entry.id)"
        case .worktree(let worktree, _): "worktree-\(worktree.id)"
        case .worktreeToggle(let toggle): "worktree-toggle-\(toggle.projectId)"
        case .archiveToggle: "archive-toggle"
        case .archiveHeader(let age): "archive-header-\(age)"
        case .archived(let row): "archived-\(row.id)"
        }
    }
}

/// JavaScript's `localeCompare` with the default collation, near enough for
/// names: case-insensitive first, lowercase before uppercase on a tie.
enum Collation {
    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let folded = a.compare(b, options: [.caseInsensitive, .diacriticInsensitive])
        if folded != .orderedSame { return folded }
        if a == b { return .orderedSame }
        // ICU's tertiary order puts lowercase first.
        return a.swappedCase < b.swappedCase ? .orderedAscending : .orderedDescending
    }

    static func precedes(_ a: String, _ b: String) -> Bool {
        compare(a, b) == .orderedAscending
    }
}

private extension String {
    var swappedCase: String {
        String(map { $0.isUppercase ? Character($0.lowercased()) : Character($0.uppercased()) })
    }
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
