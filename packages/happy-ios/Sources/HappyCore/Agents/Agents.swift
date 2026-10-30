import Foundation
import HappyWire

/// Every conversation the bots and tasks embed, normalized by ID as the API
/// asks ("Nested `subtasks` are a composed snapshot of independently
/// versioned agents"): each agent kept at its newest version, its direct
/// active subtasks by ID, and the trees composed again on read.
struct Agents: Equatable, Sendable {
    /// Each agent's own object, without `subtasks`.
    private(set) var records: [String: JSONValue] = [:]
    /// Each parent's direct active subtasks, in order.
    private(set) var children: [String: [String]] = [:]

    private static func version(_ value: JSONValue?) -> String { value?["version"]?.stringValue ?? "" }

    /// Takes a full agent object and every subtask it embeds, never letting
    /// an older copy replace a newer one.
    mutating func absorb(_ agent: JSONValue) {
        guard var object = agent.objectValue, let id = object["id"]?.stringValue else { return }
        let subtasks = object.removeValue(forKey: "subtasks")?.arrayValue
        if Self.version(records[id]) <= Self.version(agent) { records[id] = .object(object) }
        if let subtasks {
            // An archived subtask is no longer under its parent, as `update` has it.
            children[id] = subtasks.filter { $0["archivedAt"] == nil || $0["archivedAt"] == .null }.compactMap { $0["id"]?.stringValue }
            subtasks.forEach { absorb($0) }
        }
    }

    /// A new agent; a subtask joins the end of its parent's list.
    mutating func created(_ agent: JSONValue) {
        absorb(agent)
        guard let id = agent["id"]?.stringValue, let parent = agent["parentAgentId"]?.stringValue,
              agent["subtask"]?.boolValue == true, agent["archivedAt"] == nil || agent["archivedAt"] == .null,
              records[parent] != nil, !(children[parent] ?? []).contains(id) else { return }
        children[parent, default: []].append(id)
    }

    /// One `agent.updated`. False when the change does not follow the copy
    /// held, so the lists must be read again.
    mutating func update(agentId: String, previousVersion: String?, version: String?, changes: [String: JSONValue]) -> Bool {
        guard var object = records[agentId]?.objectValue else { return true }
        let held = object["version"]?.stringValue
        if let version, let held, version <= held { return true }
        guard previousVersion == held else { return false }
        var changes = changes
        if let subtasks = changes.removeValue(forKey: "subtasks")?.arrayValue {
            children[agentId] = subtasks.compactMap { $0["id"]?.stringValue }
            subtasks.forEach { absorb($0) }
        }
        for (key, value) in changes { object[key] = value }
        if let version { object["version"] = .string(version) }
        records[agentId] = .object(object)
        // An archived subtask leaves its parent's list.
        if let archived = changes["archivedAt"], archived != .null, let parent = object["parentAgentId"]?.stringValue {
            children[parent]?.removeAll { $0 == agentId }
        }
        return true
    }

    /// The agent with its active subtasks composed under it.
    func tree(_ id: String, depth: Int = 0) -> JSONValue? {
        guard var object = records[id]?.objectValue, depth < 32 else { return nil }
        object["subtasks"] = .array((children[id] ?? []).compactMap { tree($0, depth: depth + 1) })
        return .object(object)
    }
}
