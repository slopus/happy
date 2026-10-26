import Foundation
import HappyWire

/// What each Happy reference in a message reads as now, and what it opens:
/// happy-desktop's `messageReferencesCreate` (`messageReferences.ts`), over
/// the bots and tasks this phone holds. An agent reads as its conversation's
/// name (a bot's or task's own as the bot's or task's), a workspace as the
/// bot, task or subtask it holds, an artifact as its current title. What
/// the lists don't hold (archived, a project, a service, a kind this build
/// doesn't know) is inert words that say what it was.
public struct StemCellReferences: Equatable, Sendable {
    /// Something a reference can open: a conversation.
    public struct Entity: Equatable, Sendable {
        public var label: String
        public var agentId: String
    }

    /// An artifact's title as read: absent until read.
    public enum Artifact: Equatable, Sendable {
        case active(title: String, type: String, latestVersion: Int)
        case deleted(title: String)
        case missing
    }

    public enum View: Equatable, Sendable {
        /// Opens: a name to tap. `reading` while an artifact's title is on its way.
        case link(String, reading: Bool = false)
        /// Opens nothing: plain words.
        case text(String)

        public var label: String {
            switch self {
            case .link(let label, _), .text(let label): label
            }
        }
    }

    public var agents: [String: Entity] = [:]
    public var workspaces: [String: Entity] = [:]
    public var artifacts: [String: Artifact] = [:]
    /// The conversation's own subagents, by ID, as titled ("" untitled):
    /// a hidden one reads as its title, and opens nothing.
    public var subagents: [String: String] = [:]

    public init(agents: [String: Entity] = [:], workspaces: [String: Entity] = [:], artifacts: [String: Artifact] = [:]) {
        self.agents = agents
        self.workspaces = workspaces
        self.artifacts = artifacts
    }

    /// `messageReferenceEntities`, from the bots and tasks with their
    /// conversations composed (each `agent` with its active `subtasks`).
    public static func entities(owners: [JSONValue]) -> StemCellReferences {
        var references = StemCellReferences()
        var subtasks: [JSONValue] = []
        func collect(_ agent: JSONValue) {
            for subtask in agent["subtasks"]?.arrayValue ?? [] {
                subtasks.append(subtask)
                collect(subtask)
            }
        }
        for owner in owners {
            guard let agent = owner["agent"], let agentId = agent["id"]?.stringValue else { continue }
            let name = owner["name"]?.stringValue ?? ""
            references.agents[agentId] = Entity(label: name, agentId: agentId)
            if let workspaceId = owner["workspaceId"]?.stringValue ?? agent["workspaceId"]?.stringValue {
                references.workspaces[workspaceId] = Entity(label: name, agentId: agentId)
            }
            collect(agent)
        }
        for subtask in subtasks {
            guard let agentId = subtask["id"]?.stringValue else { continue }
            let title = subtask["title"]?.stringValue ?? ""
            references.agents[agentId] = Entity(label: title, agentId: agentId)
            if let workspaceId = subtask["workspaceId"]?.stringValue, references.workspaces[workspaceId] == nil {
                references.workspaces[workspaceId] = Entity(label: title, agentId: agentId)
            }
        }
        return references
    }

    /// An artifact object (`GET /v0/artifacts/:id`) as a reference reads it.
    public static func artifact(_ object: JSONValue) -> Artifact {
        let title = object["title"]?.stringValue ?? ""
        if object["status"]?.stringValue == "deleted" { return .deleted(title: title) }
        return .active(title: title, type: object["type"]?.stringValue ?? "", latestVersion: Int(object["latestVersion"]?.numberValue ?? 1))
    }

    /// The artifacts `text` names whose titles haven't been read.
    public func unread(in text: String) -> [String] {
        guard text.contains("<happy-artifact") else { return [] }
        var ids: [String] = []
        for case .reference(let reference, _) in HappyReferences.parse(text) where reference.kind == "artifact" && artifacts[reference.id] == nil && !ids.contains(reference.id) {
            ids.append(reference.id)
        }
        return ids
    }

    /// What `reference` reads as now.
    public func view(_ reference: HappyReferences.Reference) -> View {
        let inert = View.text(HappyReferences.placeholder(reference))
        switch reference.kind {
        case "artifact":
            switch artifacts[reference.id] {
            case nil: return .link("artifact", reading: true)
            case .missing: return inert
            // A deleted artifact serves nothing, so it is named and not offered.
            case .deleted(let title):
                let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                return title.isEmpty ? inert : .text(title)
            case .active(let title, _, _):
                let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
                return .link(title.isEmpty ? "Untitled artifact" : title)
            }
        case "agent", "workspace":
            guard let entity = (reference.kind == "agent" ? agents : workspaces)[reference.id] else {
                // desktop's `messageReferencesCreate`: a subagent is named, as "Subagent" untitled.
                guard reference.kind == "agent", let title = subagents[reference.id] else { return inert }
                let label = title.trimmingCharacters(in: .whitespacesAndNewlines)
                return .text(label.isEmpty ? "Subagent" : label)
            }
            let label = entity.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return .link(label.isEmpty ? "Untitled \(reference.kind)" : label)
        default:
            // Projects aren't on this phone; services open nowhere yet.
            return inert
        }
    }

    /// The conversation a reference opens, for an agent or a workspace.
    public func entity(_ reference: HappyReferences.Reference) -> Entity? {
        switch reference.kind {
        case "agent": agents[reference.id]
        case "workspace": workspaces[reference.id]
        default: nil
        }
    }
}
