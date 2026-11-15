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

    /// The network `agentID`'s commands run in, as desktop finds it:
    /// `GET /v0/workspaces/:ws/agents/:id/proxy` names it, on a computer
    /// and on Happy Cloud alike. A workspace whose agents run in containers
    /// has no network of its own, so its proxy can't reach them. A paired
    /// computer too old to name one (404) has only the workspace's; a server
    /// signed in to (Happy Cloud, a team server) has no workspace proxy, so
    /// there a 404 is no network at all.
    public func agentNetwork(_ agentID: String) async throws -> BrowserNetwork {
        try await agentRoute(agentID).network
    }

    /// The agent's network and which destinations its tunnels carry
    /// (`destinations`; every one where the answer doesn't say).
    public func agentRoute(_ agentID: String) async throws -> (network: BrowserNetwork, destinations: BrowserDestinations) {
        let workspaceID = try await agent(agentID).workspaceId
        guard BrowserPolicy.validID(workspaceID) else { throw BrowserError.unavailable }
        do {
            let answer = try await decode(JSONValue.self, "GET", "/v0/workspaces/\(Self.escape(workspaceID))/agents/\(Self.escape(agentID))/proxy")
            guard let id = answer["networkId"]?.stringValue, BrowserPolicy.validNetworkID(id) else { throw BrowserError.unavailable }
            return (.network(id), BrowserDestinations(answer["destinations"]?.stringValue))
        } catch AgentClientError.status(404, _, _) {
            if signsIn { throw BrowserError.unavailable }
            return (.workspace(workspaceID), .all)
        } catch AgentClientError.status(let status, let code, _) {
            if BrowserCompute.gone(status: status, code: code) { throw BrowserError.computeGone }
            throw BrowserError.upstream(status)
        }
    }
}

/// An agent's network for one page: read when the page opens, and read
/// again when the computer stops serving it (404), as when the agent's
/// container environment changed (happy-agent API.md,
/// `CONNECT /v0/networks/:networkId/proxy`).
public actor BrowserAgentNetwork {
    public nonisolated let agentID: String
    private let client: AgentClient
    private var known: BrowserNetwork?
    private var destinations = BrowserDestinations.all
    /// The network refused a destination outside its loopback
    /// (`403 destination_not_allowed`) though its lookup didn't say so.
    private var refusedOutside = false

    public init(client: AgentClient, agentID: String) {
        self.client = client; self.agentID = agentID
    }

    public func current() async throws -> BrowserNetwork {
        if let known { return known }
        let route = try await client.agentRoute(agentID)
        known = route.network
        destinations = route.destinations
        return route.network
    }

    /// Whether `authority` goes through the network's tunnel; false means
    /// the phone dials it (`BrowserDestinations`).
    public func tunnels(_ authority: BrowserPolicy.Authority) async throws -> Bool {
        _ = try await current()
        return (refusedOutside ? .loopback : destinations).tunnels(authority)
    }

    /// A tunnel to `authority` was refused as a destination the network
    /// doesn't carry: past its loopback, the phone dials from now on.
    /// True when that is what a dial would change.
    public func refused(_ authority: BrowserPolicy.Authority) -> Bool {
        guard !BrowserDestinations.loopback.tunnels(authority) else { return false }
        refusedOutside = true
        return true
    }

    /// Forgets `network` if it is still the one known, so the next tunnel reads it again.
    public func forget(_ network: BrowserNetwork) {
        if known == network { known = nil }
    }

    /// Whether the agent's compute answers a tunnel to `url`'s server now:
    /// it opens, or something other than the compute refuses it. A
    /// compute back within its grace says nothing of having gone, so a
    /// page closed for it asks this.
    public func answers(_ url: URL) async -> Bool {
        guard let authority = BrowserPolicy.Authority(url: url) else { return false }
        do {
            let network = try await current()
            do {
                let stream = try await client.browserTunnel(network, target: BrowserPolicy.Loopback.target(authority) ?? authority)
                await stream.abort()
                return true
            } catch BrowserError.upstream(let status) {
                if status == 404 { forget(network) }
                return status != 429
            }
        } catch { return false }
    }
}