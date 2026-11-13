import Foundation
import HappyWire

/// Desktop's happyAgentSidebarTree and happyAgentSections, projected once
/// off-main for Home and search. A subtask-owned worktree is never listed twice.
/// Sections have no titles and nothing folds: each section is parted from
/// the one before by a separator, and every nested row is shown.
public enum SidebarRows {
    /// Desktop's fixed Feed row under Artifacts, shown while the computer
    /// keeps a feed for the person: how many entries they haven't seen.
    public struct FeedRow: Equatable, Sendable {
        public var unread: Int
        public init(unread: Int) { self.unread = unread }
    }

    /// `users`: the team members the tasks belong to, as last read, by ID.
    /// `feed`: the Feed's row, nil for none. `plugins`: a Happy Cloud
    /// server's Plugins row under Artifacts.
    public static func make(_ desktop: DesktopSnapshot, settings: [String: JSONValue], users: [String: TeamUser] = [:], feed: FeedRow? = nil, plugins: Bool = false) -> [Row] {
        var rows: [Row] = []
        var descendants = Set<String>()
        let tasksByID = Dictionary((desktop.tasks ?? []).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let tasks = (desktop.taskMemberships ?? []).compactMap { tasksByID[$0.taskId] }.filter { $0.status != "archived" }
        let bots = (desktop.bots ?? []).filter { $0.status != "archived" }
        func collect(_ agent: AgentWire.Agent) {
            for child in agent.subtasks ?? [] {
                descendants.insert(child.workspaceId)
                collect(child)
            }
        }
        for owner in bots + tasks { if let agent = owner.agent { collect(agent) } }
        func separator(_ id: String) {
            rows.append(Row(id: id, nodeId: id, kind: .separator, label: ""))
        }
        // As desktop draws them: a repo wears its own picture when it has one
        // (a cloned repo), and a project without one or a worktree nothing.
        func folder(_ id: String, _ title: String, workspaceId: String, depth: Int, kind: String, mark: Row.Mark = .none) {
            rows.append(Row(id: id, nodeId: id, kind: .space, depth: depth, label: title, mark: mark, workspaceId: workspaceId, targetKind: kind))
        }
        func status(_ agent: AgentWire.Agent) -> Row.Status { Rows.activity(agent) }
        func agentRow(_ agent: AgentWire.Agent, depth: Int, label: String? = nil, owner: DesktopSnapshot.Owner? = nil, kind: String? = nil, muted: Bool = false) {
            guard agent.archivedAt == nil else { return }
            let id = owner.map { "\(kind ?? "agent"):\($0.id)" } ?? "session:\(agent.id)"
            let children = (agent.subtasks ?? []).filter { $0.archivedAt == nil }
            // A subtask or a project's session has no mark, as on desktop.
            var row = Row(id: id, nodeId: id, kind: owner == nil ? .session : .space, depth: depth,
                label: label ?? agent.title ?? "Untitled", mark: owner.map { ownerMark(kind: kind ?? "", $0, profile: desktop.profile, users: users) } ?? .none,
                status: muted ? .none : status(agent), unread: !muted && agent.unread != nil,
                isHappy: owner?.systemKey == "chief_of_staff", agentId: agent.id, workspaceId: agent.workspaceId, targetKind: kind)
            row.targetId = owner?.id
            // The Chief of Staff never, whatever an older server says.
            row.canArchive = owner?.systemKey != "chief_of_staff" && owner?.canArchive == true
            row.activityTime = agent.activityAt.map(Rows.minute)
            row.muted = muted
            rows.append(row)
            for child in children { agentRow(child, depth: depth + 1, muted: muted) }
        }
        rows.append(Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc"), targetKind: "artifacts"))
        if plugins {
            rows.append(Row(id: "direct:plugins", nodeId: "direct:plugins", kind: .space, label: "Plugins", mark: .glyph("plugin"), targetKind: "plugins"))
        }
        if let feed {
            // Bold while something is unread, with how many beside it.
            var row = Row(id: "direct:feed", nodeId: "direct:feed", kind: .space, label: "Activity", mark: .glyph("feed"), unread: feed.unread > 0, targetKind: "feed")
            row.count = feed.unread > 0 ? feed.unread : nil
            rows.append(row)
        }
        rows.append(Row(id: "direct:todos", nodeId: "direct:todos", kind: .space, label: "Todos", mark: .glyph(Rows.surfaceGlyph("todo")), targetKind: "todos"))
        let joined = (desktop.surfaces ?? []).compactMap { surface -> (DesktopSnapshot.Surface, String)? in
            guard let member = surface.members.first(where: { $0.userId == desktop.profile?.userId }) else { return nil }
            return (surface, member.orderKey)
        }.sorted { ($0.1, $0.0.id) < ($1.1, $1.0.id) }
        for (surface, _) in joined {
            var row = Row(id: "surface:\(surface.id)", nodeId: "surface:\(surface.id)", kind: .space,
                label: surface.name, mark: .glyph(Rows.surfaceGlyph(surface.type, access: surface.access, policyVault: surface.policyVault)), agentId: surface.chatAgentId, targetKind: "surface")
            row.targetId = surface.id
            row.surfaceType = surface.type
            rows.append(row)
        }
        separator("direct:bots")
        for bot in bots {
            guard let agent = bot.agent else { continue }
            let attention = settings["happy-desktop.bot.\(bot.id)"]
            guard attention?["hidden"] != .bool(true) else { continue }
            agentRow(agent, depth: 0, label: bot.name, owner: bot, kind: "bot", muted: attention?["muted"] == .bool(true))
        }
        if desktop.tasks != nil {
            separator("direct:tasks")
            for task in tasks {
                guard let agent = task.agent else { continue }
                agentRow(agent, depth: 0, label: task.name, owner: task, kind: "task")
            }
        }
        if !DesktopSettingKeys.projectsHidden(settings) {
            separator("direct:projects")
            let projects = desktop.projects.filter { $0.status != "archived" }.sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) }
            for project in projects {
                folder("project:\(project.id)", project.name, workspaceId: project.id, depth: 0, kind: "project", mark: projectMark(project))
                for agent in project.agents where agent.parentAgentId == nil { agentRow(agent, depth: 1) }
                let workspaces = desktop.workspaces.filter {
                    $0.projectId == project.id && $0.id != project.id && $0.status != "archived" && $0.status != "archiving" && !descendants.contains($0.id)
                }.sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) }
                for workspace in workspaces {
                    folder("workspace:\(workspace.id)", workspace.name, workspaceId: workspace.id, depth: 1, kind: "workspace")
                    for agent in workspace.agents where agent.parentAgentId == nil { agentRow(agent, depth: 2) }
                }
            }
        }
        return rows
    }

    /// What of an agent's row its agent draws (`make`): its status, its
    /// dot, a session's name, its time to the minute. An update that moves
    /// none of these draws nothing.
    struct Drawn: Equatable {
        var status: Row.Status
        var unread: Bool
        var title: String?
        var minute: Double?
        var archived: Bool

        init(_ agent: AgentWire.Agent) {
            status = Rows.activity(agent)
            unread = agent.unread != nil
            title = agent.title
            minute = agent.activityAt.map(Rows.minute)
            archived = agent.archivedAt != nil
        }
    }

    /// `row`, an agent's as `make` drew it, drawn again for `agent` as it
    /// is now: what `Drawn` names, the rest as it was.
    static func redraw(_ row: inout Row, for agent: AgentWire.Agent) {
        row.status = row.muted ? .none : Rows.activity(agent)
        row.unread = !row.muted && agent.unread != nil
        if row.kind == .session { row.label = agent.title ?? "Untitled" }
        row.activityTime = agent.activityAt.map(Rows.minute)
    }

    /// Whether `make` drew the row for an agent (a session, a bot's or a
    /// task's), so `redraw` may draw it again.
    static func drawsAgent(_ row: Row) -> Bool {
        row.agentId != nil && (row.kind == .session || row.targetKind == "bot" || row.targetKind == "task")
    }

    /// A project's face, as desktop's sidebar shows it: its picture (the
    /// person's or the one the daemon made for it), the house for the home
    /// project, and while it has neither yet, the placeholder its id seeds.
    static func projectMark(_ project: DesktopSnapshot.Project) -> Row.Mark {
        projectMark(id: project.id, avatar: project.avatar)
    }

    static func projectMark(id: String, avatar: DesktopSnapshot.Project.Avatar?) -> Row.Mark {
        guard let avatar else { return .placeholder(seed: id) }
        if avatar.kind == "home" { return .glyph("home") }
        if let url = avatar.url, url.hasPrefix("/v0/") { return .image(path: url, thumbhash: avatar.thumbhash) }
        if avatar.kind == "image" { return .image(path: "/v0/projects/\(AgentClient.escape(id))/avatar", thumbhash: avatar.thumbhash) }
        return .placeholder(seed: id)
    }

    /// A bot's or task's face, as its home row wears it: Happy's own logo,
    /// a bot's picture, a team task's author, else the placeholder its ID
    /// picks.
    static func ownerMark(kind: String, _ owner: DesktopSnapshot.Owner, profile: DesktopSnapshot.Profile?, users: [String: TeamUser]) -> Row.Mark {
        if kind == "bot", let avatar = owner.avatar {
            return .image(path: "/v0/bots/\(AgentClient.escape(owner.id))/avatar", thumbhash: avatar.thumbhash)
        }
        if kind == "task", let author = authorMark(owner, profile: profile, users: users) { return author }
        return owner.systemKey == "chief_of_staff" ? .happy : .placeholder(seed: owner.id)
    }

    /// The row a chat's profile speaks for, as home lists it: its space's
    /// row, else its conversation's.
    public static func row(agentId: String, spaceId: String?, in rows: [Row]) -> Row? {
        spaceId.flatMap { id in rows.first { $0.spaceId == id && $0.kind == .space } }
            ?? rows.first { $0.agentId == agentId && ($0.kind == .space || $0.kind == .session) }
    }

    /// The avatar a chat's profile wears: its home row's, so the two are
    /// the same picture or placeholder. A row drawn without one (a
    /// project's session, a subtask), or no row at all, the placeholder
    /// its agent's ID picks.
    public static func profileMark(_ row: Row?, agentId: String) -> Row.Mark {
        guard let mark = row?.mark, mark != .none else { return .placeholder(seed: agentId) }
        return mark
    }

    /// A team task's face, in place of its own placeholder: the member it
    /// belongs to, who made it (the signed-in person for their own tasks).
    /// Their picture over its ThumbHash; while they have none, or before
    /// they are read, their own placeholder, picked by their user ID as
    /// the Profile page picks it (`PersonSeed`), so they look the
    /// same on every phone. Nil outside a
    /// team (no signed-in team user) or for a task nobody owns: it keeps its
    /// own placeholder.
    static func authorMark(_ task: DesktopSnapshot.Owner, profile: DesktopSnapshot.Profile?, users: [String: TeamUser]) -> Row.Mark? {
        guard let me = profile?.userId, let author = task.ownerUserId else { return nil }
        let photo = author == me ? profile?.photo : users[author]?.photo
        guard let photo else { return .placeholder(seed: author) }
        return .image(path: TeamUser.photoPath(author), thumbhash: photo.thumbhash)
    }

    /// The active tasks the person isn't in, as rows that open their
    /// conversations: what desktop's palette finds among its task
    /// directory, which home doesn't list.
    public static func unjoinedTasks(_ desktop: DesktopSnapshot) -> [Row] {
        let joined = Set((desktop.taskMemberships ?? []).map(\.taskId))
        return (desktop.tasks ?? []).compactMap { task in
            guard !joined.contains(task.id), task.status != "archived", let agent = task.agent, agent.archivedAt == nil else { return nil }
            var row = Row(id: "unjoined:\(task.id)", nodeId: "unjoined:\(task.id)", kind: .space, label: task.name ?? agent.title ?? "",
                          agentId: agent.id, workspaceId: agent.workspaceId, targetKind: "task")
            row.targetId = task.id
            row.activityTime = agent.activityAt
            return row
        }
    }

    /// The members whose faces the listed tasks wear, other than the
    /// signed-in person, whose own is the profile's; none outside a team.
    public static func authors(_ desktop: DesktopSnapshot) -> Set<String> {
        guard let me = desktop.profile?.userId else { return [] }
        let joined = Set((desktop.taskMemberships ?? []).map(\.taskId))
        let listed = (desktop.tasks ?? []).filter { joined.contains($0.id) && $0.status != "archived" }
        return Set(listed.compactMap(\.ownerUserId)).subtracting([me])
    }
}