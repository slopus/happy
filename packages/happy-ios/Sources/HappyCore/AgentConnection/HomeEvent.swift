import Foundation
import HappyWire

/// A task's events laid over the bootstrap the phone holds, as
/// `AgentUpdate` lays an agent's: `task.created` carries the whole task and
/// `task.joined` the person's membership, so a new task is on home as soon
/// as both came, where reading the whole bootstrap again for them took as
/// long as the bootstrap does to come (a megabyte, ten seconds on a poor
/// network). What can't be applied here is read again.
enum HomeEvent {
    enum Outcome: Equatable {
        case applied
        /// Nothing home holds or draws changed.
        case unchanged
        /// Read the bootstrap again.
        case reread
    }

    /// The events `apply` takes; others go on marking home stale.
    static let types: Set<String> = ["task.created", "task.updated", "task.removed", "task.joined", "task.reordered", "task.left", "task.membership.updated", "agent.created"]

    /// What of a task `task.updated` may change for it to be applied here.
    static let ownFields: Set<String> = ["name", "shortName", "status", "archivedAt", "updatedAt", "version"]

    static func apply(_ event: JSONValue, to desktop: inout DesktopSnapshot) -> Outcome {
        guard let type = event["type"]?.stringValue else { return .reread }
        let payload = event["payload"] ?? .null
        if type == "agent.created" { return created(payload["agent"] ?? .null, in: desktop) }
        // A daemon without tasks sends none of these.
        guard var tasks = desktop.tasks else { return .reread }
        var memberships = desktop.taskMemberships ?? []
        switch type {
        case "task.created":
            guard var task = decode(DesktopSnapshot.Owner.self, payload["task"]) else { return .reread }
            // Left out of the event, which every member gets: the daemon's
            // rule as far as the phone can tell it, a team's owner's own
            // right to it left to the next read.
            if task.canArchive == nil {
                let me = desktop.profile?.userId
                task.canArchive = me == nil || task.ownerUserId == me
            }
            if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task } else { tasks.append(task) }
        case "task.updated":
            guard let id = payload["taskId"]?.stringValue, let changes = payload["changes"]?.objectValue,
                  changes.keys.allSatisfy(ownFields.contains),
                  let index = tasks.firstIndex(where: { $0.id == id }) else { return .reread }
            if let name = changes["name"] {
                guard let name = name.stringValue else { return .reread }
                tasks[index].name = name
            }
            if let status = changes["status"] {
                guard let status = status.stringValue else { return .reread }
                tasks[index].status = status
            }
        case "task.removed":
            guard let id = payload["taskId"]?.stringValue else { return .reread }
            tasks.removeAll { $0.id == id }
            memberships.removeAll { $0.taskId == id }
        case "task.left":
            guard let id = payload["membership"]?["taskId"]?.stringValue else { return .reread }
            memberships.removeAll { $0.taskId == id }
        case "task.joined", "task.reordered", "task.membership.updated":
            guard let membership = decode(DesktopSnapshot.Membership.self, payload["membership"]), let key = membership.orderKey else { return .reread }
            memberships.removeAll { $0.taskId == membership.taskId }
            // The person's list is in its order keys' order.
            let index = memberships.firstIndex { ($0.orderKey ?? "") > key } ?? memberships.endIndex
            memberships.insert(membership, at: index)
        default:
            return .reread
        }
        desktop.tasks = tasks
        desktop.taskMemberships = memberships
        return .applied
    }

    /// A task's or bot's agent comes whole in its owner's event, and one in
    /// a workspace home doesn't list draws nothing; one in a project or a
    /// listed workspace, or under another agent, takes a place in an order
    /// the event doesn't carry, so home is read again.
    private static func created(_ agent: JSONValue, in desktop: DesktopSnapshot) -> Outcome {
        guard let id = agent["id"]?.stringValue, let workspaceId = agent["workspaceId"]?.stringValue else { return .reread }
        let owners = (desktop.bots ?? []) + (desktop.tasks ?? [])
        if owners.contains(where: { $0.agent?.id == id }) { return .unchanged }
        if agent["parentAgentId"]?.stringValue != nil { return .reread }
        let listed = desktop.projects.contains { $0.id == workspaceId } || desktop.workspaces.contains { $0.id == workspaceId }
        return listed ? .reread : .unchanged
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue?) -> T? {
        guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
