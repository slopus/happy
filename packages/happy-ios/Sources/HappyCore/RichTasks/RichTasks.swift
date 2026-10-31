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
        /// What it made that was chosen not to show, for "+k show".
        public var hiddenCount: Int
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
        return model
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
            subRows: shown + linked.map { SubRow(ref: $0.ref, reason: .linked) }, hiddenCount: derived.count - shown.count
        )
    }
}
