import Foundation
import HappyWire

/// How a machine takes agents, fixed by the config on the machine itself:
/// isolated sandboxes, the host shared by every agent, the host held by one
/// agent at a time, or a member's own machine for their own agents. A
/// machine's mode carries what only that mode has.
public enum ComputeMode: Equatable, Sendable {
    case sandbox
    case shared
    /// `holder` is nil while no agent has joined it.
    case exclusive(holder: ComputeHolder?)
    /// `owner` is the member's user ID; nil for a machine that joined
    /// before owners were kept.
    case `private`(owner: String?)

    public enum Kind: String, CaseIterable, Codable, Sendable {
        case sandbox, shared, exclusive, `private`

        /// Where its supervisor installs: sandbox and shared on Linux only,
        /// exclusive on Linux and macOS, private on all three.
        public var platforms: [ComputePlatform] {
            switch self {
            case .sandbox, .shared: [.linux]
            case .exclusive: [.macOS, .linux]
            case .private: [.macOS, .linux, .windows]
            }
        }
    }

    public var kind: Kind {
        switch self {
        case .sandbox: .sandbox
        case .shared: .shared
        case .exclusive: .exclusive
        case .private: .private
        }
    }
}

public enum ComputePlatform: String, Equatable, Sendable { case macOS, linux, windows }

/// The agent holding an exclusive machine; its title is nil when the reader
/// may not read that agent's conversation.
public struct ComputeHolder: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String?
}

/// What the reader may do with compute: add a machine in any mode and free
/// a held one (`pools.manage`), use machines and add a private one of their
/// own (`compute.use`), or nothing at all.
public enum ComputeAccess: Equatable, Sendable {
    case none, use, manage

    public init(_ gate: RoleGate) {
        // Every compute read and write needs `compute.use`, managing included.
        guard gate.allows(.computeUse) else { self = .none; return }
        self = gate.allows(.poolsManage) ? .manage : .use
    }

    /// The modes it may add a machine in.
    public var modes: [ComputeMode.Kind] {
        switch self {
        case .none: []
        case .use: [.private]
        case .manage: ComputeMode.Kind.allCases
        }
    }
}

public struct ComputeCapacity: Decodable, Equatable, Sendable {
    public let used: Int
    public let total: Int?

    enum CodingKeys: String, CodingKey { case used, total }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        used = try c.decode(Int.self, forKey: .used)
        total = try c.decode(Int?.self, forKey: .total)
        guard used >= 0, total.map({ $0 >= 0 }) ?? true else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Negative sandbox capacity"))
        }
    }
}

/// One machine from `/v0/compute/nodes`. A member reads its identity, mode
/// and description; host facts, capacity and placements come only to
/// `pools.manage`, so they stay nil for everyone else.
public struct ComputeNode: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case online, offline, draining, enrolling, revoked }

    /// Startup host totals. Missing facts remain unknown.
    public struct Host: Decodable, Equatable, Sendable {
        public let cpuCores: Double?
        public let totalMemoryBytes: Double?
        public let totalDiskBytes: Double?
    }

    /// Durable placements, including idle/reserved sandboxes; not processes.
    public struct Placement: Decodable, Equatable, Sendable {
        public let sandboxId: String
        public let agentId: String
        public let agentTitle: String?
    }

    public let id: String
    public let name: String?
    public let hostname: String?
    public let os: String?
    public let arch: String?
    public let version: String?
    public let osVersion: String?
    public let status: Status
    public let since: Double?
    public let lastSeenAt: Double?
    public let mode: ComputeMode
    /// What agents read about it in `list_compute`.
    public let description: String?
    public let backend: String?
    public let sandboxError: String?
    public let sandboxCapacity: ComputeCapacity?
    public let host: Host?
    public let activeSandboxes: [Placement]?

    public var displayName: String {
        [name, hostname].compactMap { $0 }.first { !$0.isEmpty } ?? id
    }

    /// Whether `access` may rename it and change its description: a
    /// manager, or the owner of a private machine.
    public func editable(by access: ComputeAccess, userId: String?) -> Bool {
        access == .manage || ownedBy(userId)
    }

    /// Whether `access` may free it from the agent holding it.
    public func releasable(by access: ComputeAccess) -> Bool {
        guard case .exclusive(.some) = mode else { return false }
        return access == .manage
    }

    public func ownedBy(_ userId: String?) -> Bool {
        guard case .private(let owner?) = mode, let userId else { return false }
        return owner == userId
    }

    enum CodingKeys: String, CodingKey {
        case id, name, hostname, os, arch, version, osVersion, status, since, lastSeenAt, mode, description
        case owner, exclusiveAgent, backend, sandboxError, sandboxCapacity, host, activeSandboxes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        hostname = try c.decodeIfPresent(String.self, forKey: .hostname)
        os = try c.decodeIfPresent(String.self, forKey: .os)
        arch = try c.decodeIfPresent(String.self, forKey: .arch)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        osVersion = try c.decodeIfPresent(String.self, forKey: .osVersion)
        status = try c.decode(Status.self, forKey: .status)
        since = try c.decodeIfPresent(Double.self, forKey: .since)
        lastSeenAt = try c.decodeIfPresent(Double.self, forKey: .lastSeenAt)
        description = try c.decodeIfPresent(String.self, forKey: .description).flatMap { $0.isEmpty ? nil : $0 }
        switch try c.decode(ComputeMode.Kind.self, forKey: .mode) {
        case .sandbox: mode = .sandbox
        case .shared: mode = .shared
        case .exclusive: mode = .exclusive(holder: try c.decodeIfPresent(ComputeHolder.self, forKey: .exclusiveAgent))
        case .private: mode = .private(owner: try c.decodeIfPresent(String.self, forKey: .owner))
        }
        backend = try c.decodeIfPresent(String.self, forKey: .backend)
        sandboxError = try c.decodeIfPresent(String.self, forKey: .sandboxError)
        sandboxCapacity = try c.decodeIfPresent(ComputeCapacity.self, forKey: .sandboxCapacity)
        host = try c.decodeIfPresent(Host.self, forKey: .host)
        activeSandboxes = try c.decodeIfPresent([Placement].self, forKey: .activeSandboxes)
    }
}

/// An agent waiting for the reader to let it join one of their private
/// machines (`GET /v0/compute/approvals`).
public struct ComputeApproval: Decodable, Equatable, Sendable {
    public let nodeId: String
    public let nodeName: String?
    /// Nil when the reader may not read that agent's conversation.
    public let agentTitle: String?
    public let agentId: String
    /// Milliseconds.
    public let createdAt: Double

    /// The one request it is.
    public var id: String { "\(nodeId)/\(agentId)" }
}

/// The one-time join token a new machine installs with, shown once.
public struct ComputeInstall: Decodable, Equatable, Sendable {
    public struct Commands: Decodable, Equatable, Sendable {
        public let unix: String
        public let windows: String
    }

    /// One command to show and the systems it runs on.
    public struct Command: Equatable, Sendable {
        public let platforms: [ComputePlatform]
        public let text: String
    }

    public let mode: ComputeMode.Kind
    public let token: String
    /// Milliseconds.
    public let expiresAt: Double
    public let clusterUrl: String
    /// Nil where the server publishes no installer.
    public let commands: Commands?

    /// The commands this mode can run: the shell one for the Unix systems
    /// it supports, and PowerShell only for a private machine, the one mode
    /// Windows has.
    public var shown: [Command] {
        guard let commands else { return [] }
        let platforms = mode.platforms
        var shown = [Command(platforms: platforms.filter { $0 != .windows }, text: commands.unix)]
        if platforms.contains(.windows) { shown.append(Command(platforms: [.windows], text: commands.windows)) }
        return shown
    }
}

/// What a new machine will be: its mode, and the name and description it
/// joins with.
public struct ComputeMachineDraft: Equatable, Sendable {
    public var mode: ComputeMode.Kind
    public var name = ""
    public var description = ""

    public init(mode: ComputeMode.Kind, name: String = "", description: String = "") {
        self.mode = mode
        self.name = name
        self.description = description
    }
}

/// Adding a machine: choose its mode, then name and describe it, then mint
/// the token and show its install commands. Changes that don't belong to
/// the current step are ignored.
public enum ComputeMachineAdd: Equatable, Sendable {
    case choosing(ComputeMachineDraft)
    case describing(ComputeMachineDraft)
    case creating(ComputeMachineDraft)
    case failed(ComputeMachineDraft, message: String)
    /// Shown once; closing the flow forgets it.
    case shown(ComputeInstall)

    /// Nil when the reader may add nothing. A member starts on private,
    /// the only mode they have.
    public static func start(_ access: ComputeAccess) -> ComputeMachineAdd? {
        access.modes.first.map { .choosing(ComputeMachineDraft(mode: $0)) }
    }

    public var draft: ComputeMachineDraft? {
        switch self {
        case .choosing(let draft), .describing(let draft), .creating(let draft), .failed(let draft, _): draft
        case .shown: nil
        }
    }

    public mutating func choose(_ mode: ComputeMode.Kind, access: ComputeAccess) {
        guard case .choosing(var draft) = self, access.modes.contains(mode) else { return }
        draft.mode = mode
        self = .choosing(draft)
    }

    public mutating func next() {
        guard case .choosing(let draft) = self else { return }
        self = .describing(draft)
    }

    public mutating func back() {
        switch self {
        case .describing(let draft), .failed(let draft, _): self = .choosing(draft)
        default: break
        }
    }

    /// A change to the name or description, which takes back a refusal the
    /// earlier draft got.
    public mutating func edit(_ change: (inout ComputeMachineDraft) -> Void) {
        switch self {
        case .describing(var draft), .failed(var draft, _):
            change(&draft)
            self = .describing(draft)
        default: break
        }
    }

    /// The token request to send, or nil when this step doesn't send one.
    public mutating func create() -> ComputeJoinTokenRequest? {
        switch self {
        case .describing(let draft), .failed(let draft, _):
            self = .creating(draft)
            return ComputeJoinTokenRequest(draft)
        default: return nil
        }
    }

    public mutating func finish(_ result: Result<ComputeInstall, ComputeFailure>) {
        guard case .creating(let draft) = self else { return }
        switch result {
        case .success(let install): self = .shown(install)
        case .failure(let failure): self = .failed(draft, message: failure.message)
        }
    }
}

/// What the server said when it refused, in its words where it gave some.
public struct ComputeFailure: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// `POST /v0/compute/join-tokens`: an empty name or description is left out.
public struct ComputeJoinTokenRequest: Equatable, Sendable {
    public let mode: ComputeMode.Kind
    public let name: String?
    public let description: String?

    public init(_ draft: ComputeMachineDraft) {
        mode = draft.mode
        name = Self.trimmed(draft.name)
        description = Self.trimmed(draft.description)
    }

    var json: JSONValue {
        var body: [String: JSONValue] = ["mode": .string(mode.rawValue)]
        if let name { body["name"] = .string(name) }
        if let description { body["description"] = .string(description) }
        return .object(body)
    }

    static func trimmed(_ text: String) -> String? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

/// `PATCH /v0/compute/nodes/:id`: only what changed; a cleared description
/// is sent as `null`. Nil when nothing changed or the name was emptied.
public struct ComputeNodePatch: Equatable, Sendable {
    public let name: String?
    /// `.some(nil)` clears it.
    public let description: String??

    public init?(_ node: ComputeNode, name: String, description: String) {
        guard let name = ComputeJoinTokenRequest.trimmed(name) else { return nil }
        let description = ComputeJoinTokenRequest.trimmed(description)
        self.name = name == node.displayName ? nil : name
        self.description = description == node.description ? nil : .some(description)
        if self.name == nil, self.description == nil { return nil }
    }

    var json: JSONValue {
        var body: [String: JSONValue] = [:]
        if let name { body["name"] = .string(name) }
        if let description { body["description"] = description.map(JSONValue.string) ?? .null }
        return .object(body)
    }
}

extension AgentClient {
    /// Every machine the reader may see, revoked ones left out; one the
    /// phone can't read is skipped, never the whole list.
    public func computeNodes() async throws -> [ComputeNode] {
        struct Response: Decodable { let nodes: [Lossy<ComputeNode>] }
        return try await decode(Response.self, "GET", "/v0/compute/nodes").nodes.compactMap(\.value).filter { $0.status != .revoked }
    }

    public func computeNode(_ id: String) async throws -> ComputeNode {
        struct Response: Decodable { let node: ComputeNode }
        return try await decode(Response.self, "GET", "/v0/compute/nodes/\(Self.escape(id))").node
    }

    /// The requests to join the reader's private machines, oldest first.
    public func computeApprovals() async throws -> [ComputeApproval] {
        struct Response: Decodable { let approvals: [Lossy<ComputeApproval>] }
        return try await decode(Response.self, "GET", "/v0/compute/approvals").approvals.compactMap(\.value).sorted { $0.createdAt < $1.createdAt }
    }

    public func createComputeJoinToken(_ request: ComputeJoinTokenRequest) async throws -> ComputeInstall {
        try await decode(ComputeInstall.self, "POST", "/v0/compute/join-tokens", json: request.json)
    }

    public func updateComputeNode(_ id: String, _ patch: ComputeNodePatch) async throws {
        _ = try await send("PATCH", "/v0/compute/nodes/\(Self.escape(id))", json: patch.json)
    }

    /// Frees an exclusive machine; the agent that held it, if any.
    @discardableResult
    public func releaseComputeLock(_ id: String) async throws -> String? {
        struct Response: Decodable { let previousHolder: String? }
        return try await decode(Response.self, "POST", "/v0/compute/nodes/\(Self.escape(id))/release-lock", json: .object([:])).previousHolder
    }

    public func answerComputeApproval(_ approval: ComputeApproval, approve: Bool) async throws {
        _ = try await send("POST", "/v0/compute/approvals/\(Self.escape(approval.nodeId))/\(Self.escape(approval.agentId))", json: .object(["approve": .bool(approve)]))
    }
}
