import Foundation
import HappyWire

/// Desktop's happyAgentSidebarTree and happyAgentSections, projected once
/// off-main for Home and search. A subtask-owned worktree is never listed twice.
/// Sections have no titles and nothing folds: each section is parted from
/// the one before by a separator, and every nested row is shown.
public enum SidebarRows {
    public static func make(_ desktop: DesktopSnapshot, settings: [String: JSONValue]) -> [Row] {
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
        func folder(_ id: String, _ title: String, depth: Int, kind: String, avatar: DesktopSnapshot.Project.Avatar? = nil) {
            let mark: Row.Mark = avatar.flatMap { $0.url.hasPrefix("/v0/") ? .image(path: $0.url, thumbhash: nil) : nil } ?? .none
            rows.append(Row(id: id, nodeId: id, kind: .space, depth: depth, label: title, mark: mark, targetKind: kind))
        }
        func status(_ agent: AgentWire.Agent) -> Row.Status { Rows.activity(agent) }
        func agentRow(_ agent: AgentWire.Agent, depth: Int, label: String? = nil, owner: DesktopSnapshot.Owner? = nil, kind: String? = nil, muted: Bool = false) {
            guard agent.archivedAt == nil else { return }
            let id = owner.map { "\(kind ?? "agent"):\($0.id)" } ?? "session:\(agent.id)"
            let children = (agent.subtasks ?? []).filter { $0.archivedAt == nil }
            // A subtask or a project's session has no mark, as on desktop.
            var row = Row(id: id, nodeId: id, kind: owner == nil ? .session : .space, depth: depth,
                label: label ?? agent.title ?? "Untitled", mark: owner == nil ? .none : owner?.systemKey == "chief_of_staff" ? .happy : .glyph(kind == "bot" ? "agents" : "tasks"),
                status: muted ? .none : status(agent), unread: !muted && agent.unread != nil,
                isHappy: owner?.systemKey == "chief_of_staff", agentId: agent.id, workspaceId: agent.workspaceId, targetKind: kind)
            row.targetId = owner?.id
            row.canArchive = owner?.canArchive ?? false
            // What a story row says under its title, as the spaces sidebar's do.
            row.hasAgent = true
            row.statusLine = agent.statusLine?.text
            row.statusTime = agent.statusLine?.updatedAt
            row.activityTime = agent.activityAt.map(Rows.minute)
            if kind == "bot", let owner, let avatar = owner.avatar {
                row.mark = .image(path: "/v0/bots/\(AgentClient.escape(owner.id))/avatar", thumbhash: avatar.thumbhash)
            }
            rows.append(row)
            for child in children { agentRow(child, depth: depth + 1, muted: muted) }
        }
        rows.append(Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc"), targetKind: "artifacts"))
        let joined = (desktop.surfaces ?? []).compactMap { surface -> (DesktopSnapshot.Surface, String)? in
            guard let member = surface.members.first(where: { $0.userId == desktop.profile?.userId }) else { return nil }
            return (surface, member.orderKey)
        }.sorted { ($0.1, $0.0.id) < ($1.1, $1.0.id) }
        for (surface, _) in joined {
            var row = Row(id: "surface:\(surface.id)", nodeId: "surface:\(surface.id)", kind: .space,
                label: surface.name, mark: .glyph(Rows.surfaceGlyph(surface.type)), agentId: surface.chatAgentId, targetKind: "surface")
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
                folder("project:\(project.id)", project.name, depth: 0, kind: "project", avatar: project.avatar)
                for agent in project.agents where agent.parentAgentId == nil { agentRow(agent, depth: 1) }
                let workspaces = desktop.workspaces.filter {
                    $0.projectId == project.id && $0.id != project.id && $0.status != "archived" && $0.status != "archiving" && !descendants.contains($0.id)
                }.sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) }
                for workspace in workspaces {
                    folder("workspace:\(workspace.id)", workspace.name, depth: 1, kind: "workspace")
                    for agent in workspace.agents where agent.parentAgentId == nil { agentRow(agent, depth: 2) }
                }
            }
        }
        return rows
    }

    /// The rows while agent stories are on (`rings` set, keyed by agent):
    /// each bot's and task's row a story row wearing its agent's ring, with
    /// its status line and time, and everything nested and the projects kept
    /// where they are. Unlike the spaces sidebar's (`Rows.withStories`) the
    /// tree stays: this list is where projects and their sessions live.
    public static func withStories(_ rows: [Row], rings: [String: StoryRing]?) -> [Row] {
        guard let rings else { return rows }
        return rows.map { row in
            var row = row
            if (row.kind == .section || row.kind == .separator) && row.depth == 0 { row.amongStories = true }
            guard row.depth == 0, row.kind == .space, let agentId = row.agentId,
                  row.targetKind == "bot" || row.targetKind == "task" else { return row }
            let ring = rings[agentId]
            row.story = Row.StoryRowState(segments: ring?.storyIds.count ?? 0, unseen: min(ring?.unseenCount ?? 0, ring?.storyIds.count ?? 0))
            return row
        }
    }
}