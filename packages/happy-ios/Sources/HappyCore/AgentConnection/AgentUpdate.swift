import Foundation
import HappyWire

/// An `agent.updated` event laid over the bootstrap the phone holds, as
/// desktop lays it over its own: the agent's `changes` applied when its
/// `previousVersion` is the version held. A working agent sends one with
/// every streamed word (its `updatedAt` and status), so reading the whole
/// bootstrap again for each held the radio and the CPU busy while any
/// agent worked; a read is left for what can't be applied here.
enum AgentUpdate {
    enum Outcome: Equatable {
        /// Applied: the bootstrap with the agent changed.
        case applied(DesktopSnapshot)
        /// The held copy is this version or newer, or the bootstrap doesn't
        /// list the agent (a subagent no row shows): nothing to do.
        case unchanged
        /// A version was missed, or a change this can't apply alone: read
        /// the bootstrap again.
        case reread
    }

    /// What moves an agent between rows or changes the rows under it. Keys
    /// `AgentWire.Agent` doesn't hold aren't drawn by the rows either.
    static let structural: Set<String> = ["workspaceId", "parentAgentId", "subtasks"]

    static func apply(_ payload: JSONValue, to desktop: DesktopSnapshot) -> Outcome {
        guard let id = payload["agentId"]?.stringValue, let version = payload["version"]?.stringValue,
              let changes = payload["changes"]?.objectValue else { return .reread }
        if changes.keys.contains(where: structural.contains) { return .reread }
        var next = desktop
        var changed = false, gap = false
        func patch(_ agent: AgentWire.Agent) -> AgentWire.Agent {
            if agent.id == id {
                guard let held = agent.version else { gap = true; return agent }
                if version <= held { return agent }
                guard payload["previousVersion"]?.stringValue == held, let patched = agent.applying(changes, version: version) else {
                    gap = true
                    return agent
                }
                changed = true
                return patched
            }
            guard let subtasks = agent.subtasks, !subtasks.isEmpty else { return agent }
            let patched = subtasks.map(patch)
            guard zip(patched, subtasks).contains(where: { $0 !== $1 }) else { return agent }
            return agent.with(subtasks: patched)
        }
        for index in next.projects.indices { next.projects[index].agents = next.projects[index].agents.map(patch) }
        for index in next.workspaces.indices { next.workspaces[index].agents = next.workspaces[index].agents.map(patch) }
        next.bots = next.bots?.map { owner in var owner = owner; owner.agent = owner.agent.map(patch); return owner }
        next.tasks = next.tasks?.map { owner in var owner = owner; owner.agent = owner.agent.map(patch); return owner }
        next.archivedAgents = next.archivedAgents?.map(patch)
        if gap { return .reread }
        return changed ? .applied(next) : .unchanged
    }

    /// What applying an update found, by `index`: the agents from each
    /// place it is listed down to it, before and after (`Patch`).
    enum Found {
        case applied([Patch])
        case unchanged
        case reread
    }

    /// One place an updated agent is listed at: the agents from the one
    /// its list holds down to it, as they were and as they are.
    struct Patch {
        var place: AgentIndex.Place
        var before: [AgentWire.Agent]
        var after: [AgentWire.Agent]
    }

    /// `apply`, finding the agent by `index` and changing `desktop` in
    /// place: only the agents from it up to its list are made again, and
    /// nothing else in the bootstrap is looked at. Agrees with `apply` on
    /// every update (`AgentUpdateTests`).
    static func apply(_ payload: JSONValue, to desktop: inout DesktopSnapshot, index: AgentIndex) -> Found {
        guard let id = payload["agentId"]?.stringValue, let version = payload["version"]?.stringValue,
              let changes = payload["changes"]?.objectValue else { return .reread }
        if changes.keys.contains(where: structural.contains) { return .reread }
        let places = index[id]
        guard !places.isEmpty else { return .unchanged }
        var chains: [(AgentIndex.Place, [AgentWire.Agent])] = []
        for place in places {
            guard let chain = index.chain(place, in: desktop), let held = chain.last, let heldVersion = held.version else { return .reread }
            if version <= heldVersion { continue }
            guard payload["previousVersion"]?.stringValue == heldVersion else { return .reread }
            chains.append((place, chain))
        }
        guard !chains.isEmpty else { return .unchanged }
        var patches: [Patch] = []
        for (place, chain) in chains {
            guard let patched = chain[chain.count - 1].applying(changes, version: version) else { return .reread }
            var after = chain
            after[after.count - 1] = patched
            // Each agent above it, with the one below it in its place.
            for level in stride(from: chain.count - 2, through: 0, by: -1) {
                var subtasks = chain[level].subtasks ?? []
                subtasks[place.path[level + 1]] = after[level + 1]
                after[level] = chain[level].with(subtasks: subtasks)
            }
            patches.append(Patch(place: place, before: chain, after: after))
        }
        for patch in patches { AgentIndex.put(patch.after[0], at: patch.place, in: &desktop) }
        return .applied(patches)
    }

    /// `fetched`, a bootstrap read again, with each agent `held` has at a
    /// newer version kept as held: an update applied while the read was on
    /// its way is never rolled back by it.
    static func keepingNewer(_ fetched: DesktopSnapshot, than held: DesktopSnapshot) -> DesktopSnapshot {
        var newer: [String: AgentWire.Agent] = [:]
        func index(_ agent: AgentWire.Agent) {
            if let version = agent.version, version > (newer[agent.id]?.version ?? "") { newer[agent.id] = agent }
            agent.subtasks?.forEach(index)
        }
        held.projects.forEach { $0.agents.forEach(index) }
        held.workspaces.forEach { $0.agents.forEach(index) }
        held.bots?.forEach { $0.agent.map(index) }
        held.tasks?.forEach { $0.agent.map(index) }
        guard !newer.isEmpty else { return fetched }
        func keep(_ agent: AgentWire.Agent) -> AgentWire.Agent {
            let subtasks = agent.subtasks.map { $0.map(keep) }
            if let mine = newer[agent.id], let version = agent.version, let held = mine.version, held > version {
                // Its subtasks are the read's: only its own fields are newer here.
                return mine.with(subtasks: subtasks)
            }
            guard let subtasks, let read = agent.subtasks, zip(subtasks, read).contains(where: { $0 !== $1 }) else { return agent }
            return agent.with(subtasks: subtasks)
        }
        var next = fetched
        for index in next.projects.indices { next.projects[index].agents = next.projects[index].agents.map(keep) }
        for index in next.workspaces.indices { next.workspaces[index].agents = next.workspaces[index].agents.map(keep) }
        next.bots = next.bots?.map { owner in var owner = owner; owner.agent = owner.agent.map(keep); return owner }
        next.tasks = next.tasks?.map { owner in var owner = owner; owner.agent = owner.agent.map(keep); return owner }
        return next
    }
}

extension AgentWire.Agent {
    /// This agent with `changes` written over it at `version`; nil when a
    /// value can't be read, so the bootstrap is read instead. A key that is
    /// present and null clears its field.
    func applying(_ changes: [String: JSONValue], version: String) -> AgentWire.Agent? {
        func value<T: Decodable>(_ key: String, _ current: T?) -> T?? {
            guard let raw = changes[key] else { return .some(current) }
            if raw == .null { return .some(nil) }
            guard let data = try? JSONEncoder().encode(raw), let decoded = try? JSONDecoder().decode(T.self, from: data) else { return nil }
            return .some(decoded)
        }
        var status = self.status
        if let raw = changes["status"] {
            guard let next = raw.stringValue else { return nil }
            status = next
        }
        guard let title = value("title", title), let wait = value("wait", wait),
              let pendingQuestionId = value("pendingQuestionId", pendingQuestionId), let unread = value("unread", unread),
              let canSendMessages = value("canSendMessages", canSendMessages), let archivedAt = value("archivedAt", archivedAt),
              let retrying = value("retrying", retrying), let subagents = value("subagents", subagents),
              let statusLine = value("statusLine", statusLine), let lastActivityAt = value("lastActivityAt", lastActivityAt),
              let updatedAt = value("updatedAt", updatedAt) else { return nil }
        return AgentWire.Agent(id: id, workspaceId: workspaceId, parentAgentId: parentAgentId, title: title, status: status, wait: wait,
                               subtasks: subtasks, pendingQuestionId: pendingQuestionId, unread: unread, canSendMessages: canSendMessages,
                               archivedAt: archivedAt, version: version, retrying: retrying, subagents: subagents, statusLine: statusLine,
                               lastActivityAt: lastActivityAt, updatedAt: updatedAt)
    }

    func with(subtasks: [AgentWire.Agent]?) -> AgentWire.Agent {
        AgentWire.Agent(id: id, workspaceId: workspaceId, parentAgentId: parentAgentId, title: title, status: status, wait: wait,
                        subtasks: subtasks, pendingQuestionId: pendingQuestionId, unread: unread, canSendMessages: canSendMessages,
                        archivedAt: archivedAt, version: version, retrying: retrying, subagents: subagents, statusLine: statusLine,
                        lastActivityAt: lastActivityAt, updatedAt: updatedAt)
    }
}
