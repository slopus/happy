import Foundation
import HappyWire

/// An `agent.updated` applied to the held catalog in place, as desktop's
/// `connectHappyAgent` does: the agent's own changes merged over the copy
/// the phone holds, when that copy is the version the change follows.
///
/// The daemon sends one with every streamed token while an agent works
/// (`status` and `updatedAt`), so reading the whole catalog again for each
/// one kept the phone busy and the radio up for as long as anything worked.
/// A change the held copy already has is skipped. One this can't place (an
/// agent not held, a version gap, or a key that moves rows between owners)
/// is left to a full read.
enum AgentPatch {
    struct Update: Equatable, Sendable {
        var agentId: String
        var previousVersion: String
        var version: String
        var changes: [String: JSONValue]
    }

    /// What an agent's change may carry and still be applied in place: its
    /// own state. Archival, order, subtasks and its workspace move rows
    /// between owners. `unread` stays with the full read, which is what
    /// settles a read the person made (`SyncEngine.settling`).
    static let inPlace: Set<String> = [
        "status", "updatedAt", "lastActivityAt", "statusLine", "wait", "retrying", "subagents",
        "pendingQuestionId", "title", "titleStatus", "canSendMessages", "processes",
        "composerPlaceholder", "lastCursor",
    ]

    /// The change an `agent.updated` event carries, if it can be applied in place.
    static func update(_ event: JSONValue) -> Update? {
        guard event["type"] == .string("agent.updated"), let payload = event["payload"],
              let agentId = payload["agentId"]?.stringValue,
              let previous = payload["previousVersion"]?.stringValue,
              let version = payload["version"]?.stringValue,
              let changes = payload["changes"]?.objectValue,
              changes.keys.allSatisfy(inPlace.contains) else { return nil }
        return Update(agentId: agentId, previousVersion: previous, version: version, changes: changes)
    }

    /// Where a change lands in the held catalog.
    enum Placement: Equatable {
        /// The catalog with the change applied to every copy of its agent.
        case applied(DesktopSnapshot)
        /// Every copy is already at the change's version or past it (a
        /// redelivery, or a read that was made after it): nothing to do.
        case held
        /// No copy is held, or one isn't the version the change follows.
        case unplaced

        var applied: DesktopSnapshot? {
            if case .applied(let desktop) = self { return desktop }
            return nil
        }
    }

    /// The change over `desktop`. Versions are time-ordered (UUIDv7), and
    /// compared as desktop's `refetchAgent` compares them.
    static func place(_ update: Update, in desktop: DesktopSnapshot) -> Placement {
        var walk = Walk(update: update)
        var next = desktop
        for index in next.projects.indices { next.projects[index].agents = next.projects[index].agents.map { walk.visit($0) } }
        for index in next.workspaces.indices { next.workspaces[index].agents = next.workspaces[index].agents.map { walk.visit($0) } }
        if var bots = next.bots {
            for index in bots.indices { bots[index].agent = bots[index].agent.map { walk.visit($0) } }
            next.bots = bots
        }
        if var tasks = next.tasks {
            for index in tasks.indices { tasks[index].agent = tasks[index].agent.map { walk.visit($0) } }
            next.tasks = tasks
        }
        guard walk.found, !walk.stale else { return .unplaced }
        return walk.patched == nil ? .held : .applied(next)
    }

    /// The bootstrap as the computer sent it, with the change merged into
    /// every copy of its agent: what is kept for the next launch. Versions
    /// were checked against the typed copy.
    static func apply(_ update: Update, to value: JSONValue) -> JSONValue {
        guard var root = value.objectValue else { return value }
        func agents(_ list: JSONValue?) -> JSONValue? { list?.arrayValue.map { .array($0.map { merge($0, update) }) } }
        func owners(_ list: JSONValue?, key: String) -> JSONValue? {
            list?.arrayValue.map { owners in
                .array(owners.map { owner in
                    guard var object = owner.objectValue, let held = object[key] else { return owner }
                    object[key] = key == "agent" ? merge(held, update) : agents(held)
                    return .object(object)
                })
            }
        }
        root["projects"] = owners(root["projects"], key: "agents") ?? root["projects"]
        root["workspaces"] = owners(root["workspaces"], key: "agents") ?? root["workspaces"]
        root["bots"] = owners(root["bots"], key: "agent") ?? root["bots"]
        root["tasks"] = owners(root["tasks"], key: "agent") ?? root["tasks"]
        return .object(root)
    }

    private static func merge(_ agent: JSONValue, _ update: Update) -> JSONValue {
        guard var object = agent.objectValue else { return agent }
        if object["id"] == .string(update.agentId) {
            for (key, value) in update.changes { object[key] = value }
            object["version"] = .string(update.version)
        }
        if let subtasks = object["subtasks"]?.arrayValue {
            object["subtasks"] = .array(subtasks.map { merge($0, update) })
        }
        return .object(object)
    }

    private struct Walk {
        let update: Update
        var found = false
        var stale = false
        /// The patched agent, made once and shared by every copy.
        var patched: AgentWire.Agent?

        mutating func visit(_ agent: AgentWire.Agent) -> AgentWire.Agent {
            if agent.id == update.agentId {
                found = true
                guard agent.version == update.previousVersion else {
                    if let version = agent.version, version >= update.version { return agent }
                    stale = true; return agent
                }
                if patched == nil { patched = AgentPatch.streamed(agent, update) ?? AgentPatch.patch(agent, update) }
                guard let patched else { stale = true; return agent }
                return patched
            }
            guard let subtasks = agent.subtasks, subtasks.contains(where: { Self.holds($0, update.agentId) }) else { return agent }
            return agent.with(subtasks: subtasks.map { visit($0) })
        }

        private static func holds(_ agent: AgentWire.Agent, _ id: String) -> Bool {
            agent.id == id || (agent.subtasks ?? []).contains { holds($0, id) }
        }
    }

    /// What a streamed token changes (its status and times), set without the
    /// JSON round trip `patch` makes; nil for any other change.
    private static func streamed(_ agent: AgentWire.Agent, _ update: Update) -> AgentWire.Agent? {
        var status = agent.status, updatedAt = agent.updatedAt, lastActivityAt = agent.lastActivityAt
        for (key, value) in update.changes {
            switch (key, value) {
            case ("status", .string(let next)): status = next
            case ("updatedAt", .number(let next)): updatedAt = next
            case ("lastActivityAt", .number(let next)): lastActivityAt = next
            default: return nil
            }
        }
        return agent.with(subtasks: agent.subtasks, status: status, version: update.version, lastActivityAt: lastActivityAt, updatedAt: updatedAt)
    }

    /// One agent with the change merged over it: its own JSON, a few hundred bytes.
    private static func patch(_ agent: AgentWire.Agent, _ update: Update) -> AgentWire.Agent? {
        guard let data = try? JSONEncoder().encode(agent),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              let merged = try? JSONEncoder().encode(merge(value, update)) else { return nil }
        return try? JSONDecoder().decode(AgentWire.Agent.self, from: merged)
    }
}

extension AgentWire.Agent {
    /// The same agent over another list of subtasks.
    func with(subtasks: [AgentWire.Agent]?) -> AgentWire.Agent {
        with(subtasks: subtasks, status: status, version: version, lastActivityAt: lastActivityAt, updatedAt: updatedAt)
    }

    /// The same agent over these subtasks, status, version and times.
    func with(subtasks: [AgentWire.Agent]?, status: String, version: String?, lastActivityAt: Double?, updatedAt: Double?) -> AgentWire.Agent {
        AgentWire.Agent(
            id: id, workspaceId: workspaceId, parentAgentId: parentAgentId, title: title, status: status, wait: wait,
            subtasks: subtasks, pendingQuestionId: pendingQuestionId, unread: unread, canSendMessages: canSendMessages,
            archivedAt: archivedAt, version: version, retrying: retrying, subagents: subagents, statusLine: statusLine,
            lastActivityAt: lastActivityAt, updatedAt: updatedAt
        )
    }
}
