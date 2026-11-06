import Foundation
import HappyWire

/// Where each agent a bootstrap lists stands in it, by ID: which list holds
/// it and the way down to it through subtasks. Made once per bootstrap
/// read; an update then finds its agent in one step, where walking every
/// agent of every project, workspace, bot and task for each word an agent
/// wrote cost the whole home's size again per word (`AgentUpdate`).
struct AgentIndex {
    enum List: Hashable, Sendable {
        case project(Int), workspace(Int), bot(Int), task(Int), archived
    }

    /// `path[0]` is the agent's place in its list's agents (always 0 for
    /// a bot's or task's own agent); each later step, a place in the
    /// subtasks of the agent above.
    struct Place: Hashable, Sendable {
        var list: List
        var path: [Int]
    }

    private var places: [String: [Place]] = [:]

    init(_ desktop: DesktopSnapshot) {
        func walk(_ agent: AgentWire.Agent, _ place: Place) {
            places[agent.id, default: []].append(place)
            for (offset, child) in (agent.subtasks ?? []).enumerated() {
                walk(child, Place(list: place.list, path: place.path + [offset]))
            }
        }
        for (index, project) in desktop.projects.enumerated() {
            for (offset, agent) in project.agents.enumerated() { walk(agent, Place(list: .project(index), path: [offset])) }
        }
        for (index, workspace) in desktop.workspaces.enumerated() {
            for (offset, agent) in workspace.agents.enumerated() { walk(agent, Place(list: .workspace(index), path: [offset])) }
        }
        for (index, owner) in (desktop.bots ?? []).enumerated() {
            if let agent = owner.agent { walk(agent, Place(list: .bot(index), path: [0])) }
        }
        for (index, owner) in (desktop.tasks ?? []).enumerated() {
            if let agent = owner.agent { walk(agent, Place(list: .task(index), path: [0])) }
        }
        for (offset, agent) in (desktop.archivedAgents ?? []).enumerated() { walk(agent, Place(list: .archived, path: [offset])) }
    }

    /// Every place the agent is listed at; none for one no list holds.
    subscript(id: String) -> [Place] { places[id] ?? [] }

    /// The agents from the one `place`'s list holds down to the one at it;
    /// nil where the bootstrap no longer has that shape.
    func chain(_ place: Place, in desktop: DesktopSnapshot) -> [AgentWire.Agent]? {
        guard let first = place.path.first, var agent = Self.root(place.list, first, in: desktop) else { return nil }
        var chain = [agent]
        for step in place.path.dropFirst() {
            guard let subtasks = agent.subtasks, subtasks.indices.contains(step) else { return nil }
            agent = subtasks[step]
            chain.append(agent)
        }
        return chain
    }

    /// `agent` in place of the one `place`'s list holds there.
    static func put(_ agent: AgentWire.Agent, at place: Place, in desktop: inout DesktopSnapshot) {
        guard let first = place.path.first else { return }
        switch place.list {
        case .project(let index):
            guard desktop.projects.indices.contains(index), desktop.projects[index].agents.indices.contains(first) else { return }
            desktop.projects[index].agents[first] = agent
        case .workspace(let index):
            guard desktop.workspaces.indices.contains(index), desktop.workspaces[index].agents.indices.contains(first) else { return }
            desktop.workspaces[index].agents[first] = agent
        case .bot(let index):
            guard desktop.bots?.indices.contains(index) == true else { return }
            desktop.bots?[index].agent = agent
        case .task(let index):
            guard desktop.tasks?.indices.contains(index) == true else { return }
            desktop.tasks?[index].agent = agent
        case .archived:
            guard desktop.archivedAgents?.indices.contains(first) == true else { return }
            desktop.archivedAgents?[first] = agent
        }
    }

    private static func root(_ list: List, _ first: Int, in desktop: DesktopSnapshot) -> AgentWire.Agent? {
        switch list {
        case .project(let index):
            guard desktop.projects.indices.contains(index), desktop.projects[index].agents.indices.contains(first) else { return nil }
            return desktop.projects[index].agents[first]
        case .workspace(let index):
            guard desktop.workspaces.indices.contains(index), desktop.workspaces[index].agents.indices.contains(first) else { return nil }
            return desktop.workspaces[index].agents[first]
        case .bot(let index):
            guard let bots = desktop.bots, bots.indices.contains(index) else { return nil }
            return bots[index].agent
        case .task(let index):
            guard let tasks = desktop.tasks, tasks.indices.contains(index) else { return nil }
            return tasks[index].agent
        case .archived:
            guard let archived = desktop.archivedAgents, archived.indices.contains(first) else { return nil }
            return archived[first]
        }
    }
}
