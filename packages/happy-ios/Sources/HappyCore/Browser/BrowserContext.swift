import Foundation
import HappyWire

extension AgentClient {
    public func browserWorkspace(agentID: String? = nil, artifactID: String? = nil) async throws -> String {
        if let artifactID {
            let object = try await artifact(artifactID)
            let source = object["updatedSource"] ?? object["source"]
            if let id = source?["workspaceId"]?.stringValue ?? source?["projectId"]?.stringValue, BrowserPolicy.validID(id) { return id }
            if let id = source?["agentId"]?.stringValue { return try await agent(id).workspaceId }
            for (key, resource, field) in [("botId", "bots", "bot"), ("taskId", "tasks", "task")] {
                if let id = source?[key]?.stringValue, BrowserPolicy.validID(id) {
                    let object = try await decode(JSONValue.self, "GET", "/v0/\(resource)/\(id)")
                    if let workspaceID = object[field]?["workspaceId"]?.stringValue, BrowserPolicy.validID(workspaceID) { return workspaceID }
                    throw BrowserError.unavailable
                }
            }
        }
        if let agentID, !agentID.isEmpty { return try await agent(agentID).workspaceId }
        // The API has no unscoped host CONNECT route. A confirmed local host
        // workspace provides exactly that network context; never pick a runner.
        struct Listing: Decodable {
            struct Workspace: Decodable {
                struct Compute: Decodable { let type: String; let runnerId: String? }
                let id: String; let status: String; let compute: Compute
            }
            let workspaces: [Workspace]
        }
        let listing = try await decode(Listing.self, "GET", "/v0/workspaces")
        guard let workspace = listing.workspaces.first(where: { $0.status == "active" && $0.compute.type == "host" && $0.compute.runnerId == nil }) else { throw BrowserError.unavailable }
        return workspace.id
    }

}