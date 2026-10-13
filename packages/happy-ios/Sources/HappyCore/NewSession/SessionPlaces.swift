import Foundation
import HappyStore
import HappyWire

/// A directory or catalog project offered by the new-session path picker.
public struct NewSessionPlace: Equatable, Sendable {
    public var key: String
    public var name: String
    public var path: String?
    public var projectId: String?
}

/// A named workspace offered inside a selected catalog project.
public struct SessionWorkspace: Equatable, Sendable {
    public var id: String
    public var key: String
    public var name: String
    public var path: String
    public var projectId: String?
}

/// Ports agentSessionPlaces.ts; reads sessions on both daemons of the selected computer.
public enum SessionPlaces {
    /// Ports projectPlaceKey, for projects whose root path only the daemon knows.
    public static func projectKey(_ projectId: String) -> String {
        "project:\(projectId)"
    }

    /// Ports readProjectPlaceKey.
    public static func projectId(from key: String) -> String? {
        guard key.hasPrefix("project:") else { return nil }
        let id = String(key.dropFirst(8))
        return id.isEmpty ? nil : id
    }

    /// Ports collectSessionPlaces. Caller passes newest sessions first.
    public static func collect(machineIds: [String], sessions: [SessionRecord], selectedPath: String? = nil) -> [NewSessionPlace] {
        let machines = Set(machineIds.filter { !$0.isEmpty })
        var places: [NewSessionPlace] = []
        var projects: [(id: String, name: String)] = []
        var withPath: Set<String> = []
        func remember(_ place: NewSessionPlace, named: Bool) {
            if let index = places.firstIndex(where: { $0.path == place.path }) {
                if named, places[index].projectId == nil { places[index] = place }
            } else {
                places.append(place)
            }
        }
        if let selected = nonempty(selectedPath) { remember(NewSessionPlace(key: selected, name: selected, path: selected), named: false) }
        for session in sessions {
            guard let metadata = session.metadata, metadata["bot"] == nil || metadata["bot"] == .null,
                  metadata["lifecycleState"]?.stringValue != "archived",
                  let path = nonempty(metadata["path"]?.stringValue) else { continue }
            if let machine = metadata["machineId"]?.stringValue, !machines.contains(machine) { continue }
            let projectId = nonempty(metadata["project"]?["id"]?.stringValue)
            let projectName = metadata["project"]?["name"]?.stringValue ?? ""
            if metadata["workspace"] != nil && metadata["workspace"] != .null {
                if let projectId {
                    if let index = projects.firstIndex(where: { $0.id == projectId }) { projects[index].name = projectName }
                    else { projects.append((projectId, projectName)) }
                }
            } else if let projectId {
                withPath.insert(projectId)
                remember(NewSessionPlace(key: path, name: projectName, path: path, projectId: projectId), named: true)
            } else {
                remember(NewSessionPlace(key: path, name: path, path: path), named: false)
            }
        }
        for project in projects where !withPath.contains(project.id) {
            places.append(NewSessionPlace(key: projectKey(project.id), name: project.name, projectId: project.id))
        }
        return places
    }

    /// Ports collectSessionWorkspaces; archived and bot checkouts are excluded.
    public static func workspaces(machineIds: [String], projectId: String?, sessions: [SessionRecord]) -> [SessionWorkspace] {
        guard let projectId = nonempty(projectId) else { return [] }
        let machines = Set(machineIds.filter { !$0.isEmpty })
        var result: [SessionWorkspace] = []
        for session in sessions {
            guard let metadata = session.metadata, metadata["bot"] == nil || metadata["bot"] == .null,
                  metadata["lifecycleState"]?.stringValue != "archived", metadata["project"]?["id"]?.stringValue == projectId,
                  let id = metadata["workspace"]?["id"]?.stringValue, let name = metadata["workspace"]?["name"]?.stringValue,
                  let path = nonempty(metadata["path"]?.stringValue), !result.contains(where: { $0.id == id }) else { continue }
            if let machine = metadata["machineId"]?.stringValue, !machines.contains(machine) { continue }
            result.append(SessionWorkspace(id: id, key: path, name: name, path: path, projectId: projectId))
        }
        return result
    }

    private static func nonempty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
