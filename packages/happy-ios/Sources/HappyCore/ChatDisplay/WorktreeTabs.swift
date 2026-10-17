import Foundation
import HappyStore
import HappyWire

/// One chat as a tab of its checkout (WorktreeTabStrip.tsx's WorktreeTab):
/// its name, shimmering while the agent works, an orange pulsing dot while
/// it waits on the person, a blue dot for a reply nobody has read.
public struct WorktreeTab: Equatable, Sendable {
    public var id: String
    /// Nil until the agent names the chat: "New chat".
    public var title: String?
    public var state: SessionState
    public var unread: Bool
    public var createdAt: Int64

    public init(id: String, title: String?, state: SessionState, unread: Bool, createdAt: Int64) {
        self.id = id
        self.title = title
        self.state = state
        self.unread = unread
        self.createdAt = createdAt
    }

    public var working: Bool { state == .thinking }
    public var blocked: Bool { state == .permissionRequired || state == .inputRequired }
}

/// The checkout a chat runs in while the home list is grouped by project
/// (`useProjectWorktreeSummary`, `findProjectWorktree`): the session
/// screen's header names it, and the strip under the header holds its
/// chats as tabs.
///
/// Found the way `ProjectHomeData` groups the list (projectGroups.ts): Happy
/// Agent's catalog projects by project and workspace id, everything else by
/// machine and repository path, a Happy worktree under its repository. Bots,
/// side chats and archived chats are in no checkout.
public struct WorktreeCheckout: Equatable, Sendable {
    /// `worktreePlaceId`: the project's id and the checkout's.
    public var id: String
    public var projectName: String
    /// Nil for the project's own checkout, which goes by its branch.
    public var workspaceName: String?
    /// `tabOrder`: oldest first, so a new chat joins at the end and activity
    /// never reshuffles the strip under a finger.
    public var tabs: [WorktreeTab]

    public init(id: String, projectName: String, workspaceName: String?, tabs: [WorktreeTab]) {
        self.id = id
        self.projectName = projectName
        self.workspaceName = workspaceName
        self.tabs = tabs
    }

    /// The checkout `sessionId` is a tab of, or nil when it is in none (or
    /// isn't in the snapshot).
    public static func locate(_ sessionId: String, in snapshot: HomeSnapshot) -> WorktreeCheckout? {
        guard let session = snapshot.sessions.first(where: { $0.id == sessionId }),
              let key = Place.Key(session),
              let place = Place(session)
        else { return nil }
        // Every chat is compared by its key, named only when it names the
        // checkout: the screen asks this as it opens, on the main thread.
        // Names come from the first chat in the list's own order, as
        // `ProjectHomeData` takes them: live first, then by activity.
        let project = snapshot.sessions
            .compactMap { record in Place.Key(record).flatMap { $0.project == key.project ? (record, $0) : nil } }
            .sorted { listOrder($0.0, $1.0) }
        let checkout = project.filter { $0.1.checkoutId == key.checkoutId }.map(\.0)
        guard let first = project.first.flatMap({ Place($0.0) }), let named = checkout.first.flatMap(Place.init) else { return nil }
        let tabs = checkout.map { record in
            WorktreeTab(id: record.id, title: record.title, state: SessionState(record), unread: record.unread, createdAt: record.createdAt)
        }
        return WorktreeCheckout(
            id: "\(place.projectId)\u{0}\(place.checkoutId)",
            projectName: first.projectName,
            workspaceName: place.checkoutId.isEmpty ? nil : named.checkoutName ?? place.checkoutId,
            tabs: WorktreeTabs.tabOrder(tabs)
        )
    }

    /// `sortLive`: live first, then by the last meaningful message.
    private static func listOrder(_ a: SessionRecord, _ b: SessionRecord) -> Bool {
        if a.active != b.active { return a.active }
        if a.lastActivityAt != b.lastActivityAt { return a.lastActivityAt > b.lastActivityAt }
        return a.id < b.id
    }

    /// Where one chat sits in the grouped list.
    private struct Place {
        var projectId: String
        var projectName: String
        var checkoutId: String
        var checkoutName: String?

        /// Which project and checkout, compared without naming either.
        struct Key {
            enum Project: Equatable {
                /// `buildProjectGroups`: Happy Agent's catalog id.
                case catalog(String)
                /// `buildPathProjectGroups`: the machine and the repository.
                case path(rig: Bool, machineId: String?, projectPath: Substring)
            }

            var project: Project
            var checkoutId: Substring
            /// Where the worktree's name starts in `checkoutId`.
            var marker: Range<String.Index>?

            init?(_ session: SessionRecord) {
                let metadata = session.metadata
                guard metadata?["isSideChat"]?.boolValue != true, !session.isArchived, !session.isBot else { return nil }
                if session.isRig, let projectId = metadata?["project"]?["id"]?.stringValue {
                    project = .catalog(projectId)
                    checkoutId = Substring(metadata?["workspace"]?["id"]?.stringValue ?? "")
                    return
                }
                let path = (metadata?["path"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                marker = path.range(of: SessionPlace.worktreeMarker)
                project = .path(rig: session.isRig, machineId: metadata?["machineId"]?.stringValue, projectPath: marker.map { path[..<$0.lowerBound] } ?? path[...])
                checkoutId = marker == nil ? "" : path[...]
            }
        }

        init?(_ session: SessionRecord) {
            guard let key = Key(session) else { return nil }
            let metadata = session.metadata
            checkoutId = String(key.checkoutId)
            switch key.project {
            case .catalog(let projectId):
                self.projectId = projectId
                projectName = metadata?["project"]?["name"]?.stringValue ?? ""
                checkoutName = metadata?["workspace"]?["name"]?.stringValue
            case .path(let rig, let machineId, let projectPath):
                projectId = "\(rig ? "rig" : "happy"):\(ProjectHomeData.jsonKey(machineId, String(projectPath)))"
                projectName = ProjectHomeData.pathProjectName(String(projectPath), homeDir: metadata?["homeDir"]?.stringValue)
                checkoutName = key.marker.map { String(key.checkoutId[$0.upperBound...]) }
            }
        }
    }
}

/// The strip's rules (utils/worktreeTabs.ts, projectHomeList.ts `tabOrder`).
public enum WorktreeTabs {
    /// Oldest first, ties by id.
    public static func tabOrder(_ tabs: [WorktreeTab]) -> [WorktreeTab] {
        tabs.sorted { a, b in
            if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
            return Collation.precedes(a.id, b.id)
        }
    }

    /// `neighbouringTabId`: the tab that takes over the screen when
    /// `sessionId` leaves the strip, the one to its left, or for the first
    /// tab the one to its right. Asked before the chat goes: archiving takes
    /// it out of the checkout.
    public static func neighbour(of sessionId: String, in tabs: [WorktreeTab]) -> String? {
        guard let index = tabs.firstIndex(where: { $0.id == sessionId }) else { return nil }
        if index > 0 { return tabs[index - 1].id }
        return index + 1 < tabs.count ? tabs[index + 1].id : nil
    }

    /// `usePendingChatsBeside`: every chat still being opened beside one of
    /// the checkout's tabs, oldest first.
    public static func pendingBeside(_ chats: [String: PendingChat], tabIds: [String]) -> [PendingChat] {
        chats.values
            .filter { $0.status == .starting && tabIds.contains($0.anchorSessionId) }
            .sorted { a, b in a.createdAt != b.createdAt ? a.createdAt < b.createdAt : a.id < b.id }
    }

    /// `resolveWorktreeTabs`: which tabs the strip draws while chats are
    /// being opened in it. A chat being started is briefly two things, its
    /// stand-in and, once the server announces it, a row in the list; they
    /// can't be matched by name, because the name is what is missing. A row
    /// that wasn't in the checkout when `+` was pressed is the arrival the
    /// stand-in already stands for, and waits rather than doubling it. A
    /// named stand-in is never drawn: its session is the tab from then on,
    /// and when the list stops carrying it, it was archived.
    public static func resolve(tabs: [WorktreeTab], pending: [PendingChat]) -> (tabs: [WorktreeTab], pending: [PendingChat]) {
        guard !pending.isEmpty else { return (tabs, []) }
        var spokenFor: Set<String> = []
        var visible: [PendingChat] = []
        for chat in pending where chat.sessionId == nil {
            if let arrival = tabs.first(where: { !spokenFor.contains($0.id) && !chat.knownSessionIds.contains($0.id) }) {
                spokenFor.insert(arrival.id)
            }
            visible.append(chat)
        }
        return (tabs.filter { !spokenFor.contains($0.id) }, visible)
    }
}
