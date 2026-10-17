import Foundation
import HappyStore
import HappyWire

/// sync/sessionState.ts: one precedence for every place that shows a
/// session's state.
public enum SessionState: Equatable, Sendable {
    case disconnected
    case thinking
    case waiting
    case permissionRequired
    case inputRequired

    public init(_ session: SessionRecord) {
        if !session.active {
            self = .disconnected
        } else if session.hasPendingPermissionRequests {
            self = .permissionRequired
        } else if session.hasPendingCommunications {
            self = .inputRequired
        } else {
            self = session.thinking ? .thinking : .waiting
        }
    }
}

/// What a generated avatar is seeded with, and what draws over it.
public struct SessionAvatar: Equatable, Sendable {
    /// sessionUtils.ts `getSessionAvatarId`.
    public var seed: String
    public var isBot: Bool
    /// The harness badge, when the setting asks for it.
    public var harness: Harness?
    public var image: AvatarImageSource?

    public enum Harness: String, Equatable, Sendable {
        case claude
        case codex
        case agy
        case rig
    }

    public init(seed: String, isBot: Bool = false, harness: Harness? = nil, image: AvatarImageSource? = nil) {
        self.seed = seed
        self.isBot = isBot
        self.harness = harness
        self.image = image
    }

    /// utils/avatarHarness.ts: Happy Agent wins over the provider it runs;
    /// retired and unknown flavors get no badge.
    public static func harness(flavor: String?, clientId: String?) -> Harness? {
        if clientId == "rig" { return .rig }
        switch flavor {
        case "claude": return .claude
        case "codex": return .codex
        case "agy": return .agy
        default: return nil
        }
    }
}

/// One row of the flat session list (components/FlatSessionRow.tsx).
public struct SessionRow: Equatable, Sendable {
    /// The top-right corner: the time, or a dot that replaces it.
    public enum Corner: Equatable, Sendable {
        case timestamp
        /// The agent waits on the person (#FF9500).
        case blockedDot
        /// A finished turn nobody has seen (#007AFF).
        case unreadDot
    }

    public var id: String
    /// nil until the agent names the chat: "New chat".
    public var title: String?
    public var projectName: String
    /// Null in a project's primary checkout.
    public var workspaceName: String?
    /// The line counts Happy Agent publishes for the session's checkout,
    /// drawn at the end of the workspace's row (RigGitLineChanges); nil
    /// for a clean comparison and for every other agent.
    public var changes: GitLineChanges?
    public var avatar: SessionAvatar
    public var timestamp: String
    public var lastActivityAt: Int64
    public var state: SessionState
    public var corner: Corner
    /// The title shimmers while the agent works.
    public var shimmersTitle: Bool
    /// Archived, or on a computer known to be offline.
    public var faded: Bool
    public var archived: Bool
    public var isBot: Bool
    public var showsDivider: Bool
    /// Unsent text exists in this account's draft store.
    public var hasDraft: Bool = false
}

/// The home session list in happy-app's default flat layout
/// (SessionsList.tsx with `sessionListGrouping: 'flat'`): every live
/// session by activity, then the archive behind a toggle, grouped by day.
public struct SessionList: Equatable, Sendable {
    public enum Item: Equatable, Sendable {
        case session(SessionRow)
        /// "Show archived" / "Hide archived".
        case archiveToggle(hidden: Bool)
        /// "Today", "Yesterday", "N days ago" above archived rows.
        case dayHeader(DayAge)

        public var sessionId: String? {
            if case .session(let row) = self { return row.id }
            return nil
        }
    }

    /// Time, calendar and locale the timestamps are written in.
    public struct Clock: Sendable {
        public var now: Date
        public var calendar: Calendar
        public var locale: Locale

        public init(now: Date = Date(), calendar: Calendar = .autoupdatingCurrent, locale: Locale = .autoupdatingCurrent) {
            self.now = now
            self.calendar = calendar
            self.locale = locale
        }
    }

    /// How many calendar days back an archived row was last worked on.
    public enum DayAge: Equatable, Sendable {
        case today
        case yesterday
        case daysAgo(Int)
    }

    public var items: [Item]
    /// Rows that are on screen: live ones, plus archived ones when shown.
    public var visibleCount: Int
    public var hasArchived: Bool
    /// How the avatars are drawn (Settings › Appearance).
    public var avatarStyle: AvatarStyle
    public var avatarMonochrome: Bool
    /// The home filter's choice (`sessionListGrouping`).
    public var grouping: SessionListGrouping
    /// The list grouped by project, built only while that layout is chosen
    /// (SessionsListWrapper.tsx hands it to ProjectHomeList).
    public var projects: ProjectHomeData?

    /// `unknownMachine` names the project list's section of chats that name
    /// no computer (`ProjectHomeData`).
    public init(_ snapshot: HomeSnapshot, clock: Clock = Clock(), unknownMachine: String = ProjectHomeData.unknownMachineText) {
        let settings = AccountSettings(snapshot.settings)
        let machines = Dictionary(snapshot.machines.machines.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let projects = Dictionary(snapshot.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let formatter = SessionTimestampFormatter(clock: clock)

        var live: [SessionRecord] = []
        var archived: [SessionRecord] = []
        for session in snapshot.sessions where session.metadata?["isSideChat"]?.boolValue != true {
            if session.isArchived {
                archived.append(session)
            } else {
                live.append(session)
            }
        }
        live.sort { a, b in
            if a.active != b.active { return a.active }
            return Self.precedes(a, b)
        }
        archived.sort(by: Self.precedes)

        func row(_ session: SessionRecord, archived: Bool, divider: Bool) -> SessionRow {
            Self.row(
                session,
                archived: archived,
                showsDivider: divider,
                machines: machines,
                projects: projects,
                showFlavorIcons: settings.showFlavorIcons,
                formatter: formatter
            )
        }

        var items: [Item] = live.enumerated().map { index, session in
            .session(row(session, archived: false, divider: index < live.count - 1))
        }
        let hidden = settings.hideArchivedSessions
        if !archived.isEmpty {
            items.append(.archiveToggle(hidden: hidden))
            if !hidden {
                var tail: [Item] = []
                var currentDay: Date?
                for session in archived {
                    let date = Date(timeIntervalSince1970: Double(session.lastActivityAt) / 1000)
                    let day = clock.calendar.startOfDay(for: date)
                    if day != currentDay {
                        currentDay = day
                        tail.append(.dayHeader(formatter.dayAge(day)))
                    }
                    tail.append(.session(row(session, archived: true, divider: true)))
                }
                // Only the very last archived row drops its hairline.
                if case .session(var last)? = tail.last {
                    last.showsDivider = false
                    tail[tail.count - 1] = .session(last)
                }
                items.append(contentsOf: tail)
            }
        }

        self.items = items
        self.visibleCount = live.count + (hidden ? 0 : archived.count)
        self.hasArchived = !archived.isEmpty
        self.avatarStyle = settings.avatarStyle
        self.avatarMonochrome = settings.avatarMonochrome
        self.grouping = settings.sessionListGrouping
        self.projects = settings.sessionListGrouping == .project ? ProjectHomeData(snapshot, clock: clock, unknownMachine: unknownMachine) : nil
    }

    /// Newest activity first; ties in id order so the list never shuffles.
    private static func precedes(_ a: SessionRecord, _ b: SessionRecord) -> Bool {
        if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
        return a.id < b.id
    }

    static func row(
        _ session: SessionRecord,
        archived: Bool,
        showsDivider: Bool,
        machines: [String: MachineRecord],
        projects: [String: ProjectRecord],
        showFlavorIcons: Bool,
        formatter: SessionTimestampFormatter
    ) -> SessionRow {
        let metadata = session.metadata
        let state = SessionState(session)
        let machineOffline = metadata?["machineId"]?.stringValue
            .flatMap { machines[$0] }
            .map { !$0.active } ?? false
        let faded = archived || machineOffline
        let place = SessionPlace(session, projects: projects)

        // flatSessionRowPresentation.ts
        let corner: SessionRow.Corner
        var shimmers = false
        if faded {
            corner = .timestamp
        } else if state == .permissionRequired || state == .inputRequired {
            corner = .blockedDot
        } else if state == .thinking {
            corner = .timestamp
            shimmers = true
        } else if session.unread {
            corner = .unreadDot
        } else {
            corner = .timestamp
        }

        return SessionRow(
            id: session.id,
            title: session.title,
            projectName: place.projectName,
            workspaceName: place.workspaceName,
            changes: session.isRig ? GitLineChanges(rigSummary: metadata?["git"]) : nil,
            avatar: SessionAvatar(
                seed: session.avatarSeed,
                isBot: session.isBot,
                harness: showFlavorIcons
                    ? SessionAvatar.harness(flavor: metadata?["flavor"]?.stringValue, clientId: metadata?["client"]?["id"]?.stringValue)
                    : nil,
                image: AvatarImageSource.resolve(session, project: session.projectReference.flatMap { projects[$0] })
            ),
            timestamp: formatter.timestamp(session.lastActivityAt),
            lastActivityAt: session.lastActivityAt,
            state: state,
            corner: corner,
            shimmersTitle: shimmers,
            faded: faded,
            archived: archived,
            isBot: session.isBot,
            showsDivider: showsDivider
        )
    }
}

/// Where a session runs, as the flat row names it (utils/flatSessionList.ts
/// `toFlatSessionRow`).
struct SessionPlace: Equatable {
    /// utils/worktreePaths.ts: Happy creates worktrees under this.
    static let worktreeMarker = "/.dev/worktree/"

    var projectName: String
    var workspaceName: String?

    init(_ session: SessionRecord, projects: [String: ProjectRecord]) {
        let metadata = session.metadata
        if session.isBot {
            projectName = "@" + (metadata?["bot"]?["username"]?.stringValue ?? "")
            workspaceName = nil
            return
        }
        let path = (metadata?["path"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let marker = path.range(of: Self.worktreeMarker)
        let projectPath = marker.map { String(path[..<$0.lowerBound]) } ?? path
        let linked = session.projectReference.flatMap { projects[$0]?.name }
        projectName = linked
            ?? metadata?["project"]?["name"]?.stringValue
            ?? projectPath.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
            ?? ""
        workspaceName = metadata?["workspace"]?["name"]?.stringValue
            ?? marker.map { String(path[$0.upperBound...]) }
    }
}

/// utils/sessionListTimestamp.ts and storage.ts `relativeDayTitle`.
struct SessionTimestampFormatter {
    private static let dayMs: Int64 = 24 * 60 * 60 * 1000

    let clock: SessionList.Clock
    private let time: DateFormatter
    private let weekday: DateFormatter

    init(clock: SessionList.Clock) {
        self.clock = clock
        time = Self.formatter(template: "jmm", clock: clock)
        weekday = Self.formatter(template: "EEE", clock: clock)
    }

    private static func formatter(template: String, clock: SessionList.Clock) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = clock.locale
        formatter.calendar = clock.calendar
        formatter.timeZone = clock.calendar.timeZone
        formatter.dateFormat = DateFormatter.dateFormat(fromTemplate: template, options: 0, locale: clock.locale) ?? template
        return formatter
    }

    /// The clock for the last 24 hours, the weekday for the week before,
    /// then MM/DD, with the year once it is not this year's.
    func timestamp(_ milliseconds: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        let age = Int64(clock.now.timeIntervalSince1970 * 1000) - milliseconds
        if age < Self.dayMs { return time.string(from: date) }
        if age < 7 * Self.dayMs { return weekday.string(from: date) }
        let parts = clock.calendar.dateComponents([.year, .month, .day], from: date)
        let month = String(format: "%02d", parts.month ?? 0)
        let day = String(format: "%02d", parts.day ?? 0)
        if parts.year == clock.calendar.component(.year, from: clock.now) {
            return "\(month)/\(day)"
        }
        return "\(month)/\(day)/" + String(format: "%02d", (parts.year ?? 0) % 100)
    }

    /// Counted in calendar days, so a DST change can't shift a heading.
    func dayAge(_ day: Date) -> SessionList.DayAge {
        let today = clock.calendar.startOfDay(for: clock.now)
        let days = clock.calendar.dateComponents([.day], from: day, to: today).day ?? 0
        if days <= 0 { return .today }
        if days == 1 { return .yesterday }
        return .daysAgo(days)
    }
}

extension SessionRecord {
    /// sessionUtils.ts `getSessionName`; nil reads "New chat".
    public var title: String? {
        if let name = metadata?["bot"]?["name"]?.stringValue { return name }
        if let summary = metadata?["summary"]?["text"]?.stringValue { return summary }
        return nil
    }

    /// sessionActivity.ts `getSessionActivityAt`: the last meaningful
    /// message, not `updatedAt`, which moves on every background write.
    public var lastActivityAt: Int64 {
        if let at = metadata?["lastMeaningfulMessageAt"]?.numberValue { return Int64(at) }
        if let at = lastMessageSentAt { return at }
        return createdAt
    }

    /// sessionUtils.ts `getSessionAvatarId`: one machine and path, one face.
    public var avatarSeed: String {
        let machineId = metadata?["machineId"]?.stringValue
        if let botId = metadata?["bot"]?["id"]?.stringValue {
            return "\(machineId ?? ""):bot:\(botId)"
        }
        if let machineId, let path = metadata?["path"]?.stringValue {
            return "\(machineId):\(path)"
        }
        return id
    }

    /// projectTypes.ts `getSessionProjectId`.
    public var projectReference: String? {
        if let id = projectId?.trimmingCharacters(in: .whitespaces), !id.isEmpty { return id }
        if let id = metadata?["project"]?["id"]?.stringValue?.trimmingCharacters(in: .whitespaces), !id.isEmpty { return id }
        return nil
    }

    /// agentCommunications.ts `selectPendingCommunications` is not empty:
    /// the agent asked something and waits for the answer.
    public var hasPendingCommunications: Bool {
        guard let communications = agentState?["communications"]?.objectValue else { return false }
        let completed = agentState?["completedCommunications"]?.objectValue ?? [:]
        for (id, communication) in communications where completed[id] == nil || completed[id] == .null {
            guard communication["kind"]?.stringValue == "form" else { return true }
            let questions = communication["form"]?["questions"]?.arrayValue ?? []
            let answerable = questions.contains { question in
                !(question["options"]?.arrayValue ?? []).isEmpty || question["allowCustom"]?.boolValue != false
            }
            if answerable { return true }
        }
        return false
    }
}
