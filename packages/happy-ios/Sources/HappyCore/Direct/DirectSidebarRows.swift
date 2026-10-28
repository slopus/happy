import Foundation
import HappyWire

/// Desktop's happyAgentSidebarTree and happyAgentSections, projected once
/// off-main for Home and search. A subtask-owned worktree is never listed twice.
public enum DirectSidebarRows {
    public static func make(_ desktop: DirectDesktopSnapshot, settings: [String: JSONValue], collapsed: Set<String> = []) -> [StemCellsRow] {
        var rows: [StemCellsRow] = []
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
        func heading(_ id: String, _ title: String, depth: Int = 0, mark: StemCellsRow.Mark = .none) {
            rows.append(StemCellsRow(id: id, nodeId: id, kind: .section, depth: depth, label: title, mark: mark, collapsed: collapsed.contains(id)))
        }
        func folder(_ id: String, _ title: String, depth: Int, kind: String) {
            rows.append(StemCellsRow(id: id, nodeId: id, kind: .space, depth: depth, label: title, mark: .glyph("folder"), collapsed: collapsed.contains(id), targetKind: kind))
        }
        func status(_ agent: AgentWire.Agent) -> StemCellsRow.Status {
            if agent.pendingQuestionId != nil { return .awaitingInput }
            if agent.wait != nil { return .waiting }
            return agent.isWorking ? .working : .none
        }
        func agentRow(_ agent: AgentWire.Agent, depth: Int, label: String? = nil, owner: DirectDesktopSnapshot.Owner? = nil, kind: String? = nil, muted: Bool = false) {
            guard agent.archivedAt == nil else { return }
            let id = owner.map { "\(kind ?? "agent"):\($0.id)" } ?? "session:\(agent.id)"
            let children = (agent.subtasks ?? []).filter { $0.archivedAt == nil }
            var row = StemCellsRow(id: id, nodeId: id, kind: owner == nil ? .session : .space, depth: depth,
                label: label ?? agent.title ?? "Untitled", mark: owner?.systemKey == "chief_of_staff" ? .happy : .glyph(kind == "bot" ? "agents" : "tasks"),
                status: muted ? .none : status(agent), unread: !muted && agent.unread != nil, collapsed: children.isEmpty ? nil : collapsed.contains(id),
                isHappy: owner?.systemKey == "chief_of_staff", agentId: agent.id, workspaceId: agent.workspaceId, targetKind: kind)
            row.targetId = owner?.id
            row.canArchive = owner?.canArchive ?? false
            if kind == "bot", let owner, let avatar = owner.avatar {
                row.mark = .image(path: "/v0/bots/\(DirectAgentClient.escape(owner.id))/avatar", thumbhash: avatar.thumbhash)
            }
            rows.append(row)
            for child in children { agentRow(child, depth: depth + 1, muted: muted) }
        }
        rows.append(StemCellsRow(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc"), targetKind: "artifacts"))
        let joined = (desktop.surfaces ?? []).compactMap { surface -> (DirectDesktopSnapshot.Surface, String)? in
            guard let member = surface.members.first(where: { $0.userId == desktop.profile?.userId }) else { return nil }
            return (surface, member.orderKey)
        }.sorted { ($0.1, $0.0.id) < ($1.1, $1.0.id) }
        for (surface, _) in joined {
            var row = StemCellsRow(id: "surface:\(surface.id)", nodeId: "surface:\(surface.id)", kind: .space,
                label: surface.name, mark: .glyph(surface.type == "calendar" ? "calendar" : "doc"), agentId: surface.chatAgentId, targetKind: "surface")
            row.targetId = surface.id
            row.surfaceType = surface.type
            rows.append(row)
        }
        heading("direct:bots", "Bots")
        for bot in bots {
            guard let agent = bot.agent else { continue }
            let attention = settings["happy-desktop.bot.\(bot.id)"]
            guard attention?["hidden"] != .bool(true) else { continue }
            agentRow(agent, depth: 0, label: bot.name, owner: bot, kind: "bot", muted: attention?["muted"] == .bool(true))
        }
        if desktop.tasks != nil {
            heading("direct:tasks", "Tasks")
            for task in tasks {
                guard let agent = task.agent else { continue }
                agentRow(agent, depth: 0, label: task.name, owner: task, kind: "task")
            }
        }
        if !DirectSettings.projectsHidden(settings) {
            heading("direct:projects", "Projects")
            let projects = desktop.projects.filter { $0.status != "archived" }.sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) }
            for project in projects {
                folder("project:\(project.id)", project.name, depth: 0, kind: "project")
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
}