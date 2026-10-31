import Foundation
import HappyWire

/// Home's tasks as rich cards, made off the main thread beside the classic
/// rows. Only while the daemon serves rich tasks (`capabilities.taskSections`)
/// and the person turned them on (`tasks.rich`); otherwise there is none and
/// Home shows exactly the classic list.
public struct RichTasks: Equatable, Sendable {
    public static let richKey = "tasks.rich"
    public static let sectionsKey = "tasks.sections"
    public static let focusKey = "tasks.focus"

    public struct Section: Equatable, Sendable {
        public var id: String
        public var name: String
        public var collapsed: Bool
        public var cards: [Card]
    }

    public struct Card: Equatable, Sendable {
        public var taskId: String
        public var name: String
        public var iconSlug: String?
        public var canArchive: Bool
        public var agent: AgentWire.Agent
        /// Who wrote to its agent since the person last read it, newest first.
        public var faces: [String]
        /// What shows under it, most urgent first.
        public var subRows: [SubRow]
        /// What it made that was chosen not to show, counted in "+N more" and drawn faded once opened out.
        public var hidden: [SubRow] = []
        /// As drawn, and every row it can show (the hidden ones dimmed), projected off the main thread (`projected`).
        public var drawn: TaskList.Card?
        public var rows: [TaskList.SubRow] = []
    }

    /// What a sub-row draws for its ref: its name, and the kind of thing it is.
    public struct Child: Equatable, Sendable {
        public var title: String
        /// An artifact's type.
        public var type: String?
        /// A workspace's project picture, daemon-relative.
        public var picture: String?
        /// A subtask at work, or the one living in a workspace.
        public var working = false
        /// After the title, muted (a question's words); the lines a workspace changed, none merged.
        /// The daemon sends neither yet: only fixtures fill them.
        public var detail: String?
        public var changes: Row.LineChanges?
        public init(title: String, type: String? = nil, picture: String? = nil, working: Bool = false, detail: String? = nil, changes: Row.LineChanges? = nil) {
            self.title = title; self.type = type; self.picture = picture; self.working = working; self.detail = detail; self.changes = changes
        }
    }

    public struct SubRow: Equatable, Sendable {
        public enum Reason: Equatable, Sendable {
            /// A subtask waiting on the person, a subtask at work, something
            /// the task's agents made, and something linked under it on purpose.
            case question, working, made, linked
        }
        public var ref: TaskChild.Ref
        public var reason: Reason
    }

    /// Cards above the first header, which belong to no section.
    public var unsectioned: [Card] = []
    public var sections: [Section] = []
    /// What every card's sub-rows, shown or hidden, point at.
    public var children: [TaskChild.Ref: Child] = [:]
    /// Whether Focus arranges this list.
    public var focus = false

    public static func isOn(_ capabilities: AgentWire.Health.Capabilities?, settings: [String: JSONValue]) -> Bool {
        capabilities?.taskSections == true && settings[richKey] == .bool(true)
    }

    public static func showsSections(_ capabilities: AgentWire.Health.Capabilities?, settings: [String: JSONValue]) -> Bool {
        isOn(capabilities, settings: settings) && settings[sectionsKey] == .bool(true)
    }

    public static func make(_ desktop: DesktopSnapshot, capabilities: AgentWire.Health.Capabilities?, settings: [String: JSONValue]) -> RichTasks? {
        guard isOn(capabilities, settings: settings), let tasks = desktop.tasks else { return nil }
        let tasksByID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let headers = showsSections(capabilities, settings: settings) ? (desktop.taskSections ?? []).sorted { ($0.orderKey, $0.id) < ($1.orderKey, $1.id) } : []
        var model = RichTasks(sections: headers.map { Section(id: $0.id, name: $0.name, collapsed: $0.collapsed ?? false, cards: []) })
        model.focus = settings[focusKey] == .bool(true)
        // The memberships come in the person's order, the same keys as the headers'.
        for membership in desktop.taskMemberships ?? [] where membership.hidden != true {
            guard let task = tasksByID[membership.taskId], task.status != "archived", let agent = task.agent, agent.archivedAt == nil else { continue }
            let card = self.card(task, agent: agent, workspaces: desktop.workspaces, artifacts: desktop.taskArtifacts ?? [])
            if let key = membership.orderKey, let index = headers.lastIndex(where: { $0.orderKey < key }) {
                model.sections[index].cards.append(card)
            } else {
                model.unsectioned.append(card)
            }
        }
        model.children = children(model, desktop)
        return model.projected()
    }

    /// Every card as Home draws it, so the main thread only picks what shows.
    public func projected() -> RichTasks {
        func project(_ card: Card) -> Card {
            var card = card
            card.drawn = TaskList.card(card)
            card.rows = card.subRows.map { TaskList.subRow(card.taskId, $0, dimmed: false, children) } + card.hidden.map { TaskList.subRow(card.taskId, $0, dimmed: true, children) }
            return card
        }
        var model = self
        model.unsectioned = unsectioned.map(project)
        for index in sections.indices { model.sections[index].cards = sections[index].cards.map(project) }
        return model
    }

    /// Names the sub-rows' refs from the agents, workspaces and artifacts at hand.
    static func children(_ model: RichTasks, _ desktop: DesktopSnapshot) -> [TaskChild.Ref: Child] {
        var agents: [String: AgentWire.Agent] = [:]
        func index(_ agent: AgentWire.Agent) { agents[agent.id] = agent; (agent.subtasks ?? []).forEach(index) }
        let cards = model.unsectioned + model.sections.flatMap(\.cards)
        cards.forEach { index($0.agent) }
        let workspaces = Dictionary(desktop.workspaces.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let projects = Dictionary(desktop.projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let artifacts = Dictionary((desktop.taskArtifacts ?? []).map { ($0.artifactId, $0) }, uniquingKeysWith: { first, _ in first })
        var children: [TaskChild.Ref: Child] = [:]
        for ref in cards.flatMap({ ($0.subRows + $0.hidden).map(\.ref) }) where children[ref] == nil {
            switch ref.kind {
            case "agent":
                let agent = agents[ref.id]
                children[ref] = Child(title: agent?.title ?? "Untitled", working: agent?.isWorking == true && agent?.pendingQuestionId == nil)
            case "workspace":
                let workspace = workspaces[ref.id]
                let avatar = workspace?.projectId.flatMap { projects[$0]?.avatar?.url }.flatMap { $0.hasPrefix("/v0/") ? $0 : nil }
                children[ref] = Child(title: workspace?.name ?? ref.id, picture: avatar, working: workspace?.subtaskAgentId.flatMap { agents[$0]?.isWorking } == true)
            default:
                let artifact = artifacts[ref.id]
                children[ref] = Child(title: artifact?.title ?? "Untitled", type: artifact?.type)
            }
        }
        return children
    }

    /// Data model's "a task's sub-rows": its subtasks waiting or at work, the
    /// workspaces and artifacts its agents made, and its links, less what was hidden.
    static func card(_ task: DesktopSnapshot.Owner, agent: AgentWire.Agent, workspaces: [DesktopSnapshot.Workspace], artifacts: [TaskArtifact]) -> Card {
        var family: [AgentWire.Agent] = []
        func collect(_ agent: AgentWire.Agent) {
            family.append(agent)
            for child in agent.subtasks ?? [] where child.archivedAt == nil { collect(child) }
        }
        collect(agent)
        let ids = Set(family.map(\.id))
        let subtasks = family.dropFirst()
        var derived = subtasks.filter { $0.pendingQuestionId != nil }.map { SubRow(ref: .init(kind: "agent", id: $0.id), reason: .question) }
        derived += subtasks.filter { $0.pendingQuestionId == nil && $0.status == "working" }.map { SubRow(ref: .init(kind: "agent", id: $0.id), reason: .working) }
        let listed = Set(derived.map(\.ref.id))
        derived += workspaces.filter { workspace in
            guard workspace.status != "archived", workspace.id != agent.workspaceId else { return false }
            // A subtask already listed stands for the workspace it lives in.
            if let resident = workspace.subtaskAgentId, listed.contains(resident) { return false }
            return [workspace.creatorAgentId, workspace.subtaskAgentId].contains { $0.map(ids.contains) == true }
        }.map { SubRow(ref: .init(kind: "workspace", id: $0.id), reason: .made) }
        derived += artifacts.filter { $0.taskId == task.id || $0.agentId.map(ids.contains) == true }
            .map { SubRow(ref: .init(kind: "artifact", id: $0.artifactId), reason: .made) }
        var choices: [TaskChild.Ref: String] = [:]
        for child in task.children ?? [] { choices[child.ref] = child.visibility }
        let shown = derived.filter { choices[$0.ref] != "hidden" }
        let derivedRefs = Set(derived.map(\.ref))
        let linked = (task.children ?? []).filter { $0.visibility == "shown" && !derivedRefs.contains($0.ref) }
        return Card(
            taskId: task.id, name: task.name ?? agent.title ?? "Untitled", iconSlug: task.icon?.librarySlug,
            canArchive: task.canArchive ?? false, agent: agent, faces: agent.unread?.from ?? [],
            subRows: shown + linked.map { SubRow(ref: $0.ref, reason: .linked) }, hidden: derived.filter { choices[$0.ref] == "hidden" }
        )
    }
}
