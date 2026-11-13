import Foundation
import HappyWire

/// How a computer takes agents, fixed by the config on the computer itself:
/// isolated sandboxes, the host shared by every agent, the host held by one
/// agent at a time, or a member's own computer for their own agents. A
/// computer's mode carries what only that mode has.
public enum ComputeMode: Equatable, Sendable {
    case sandbox
    case shared
    /// `holder` is nil while no agent has joined it.
    case exclusive(holder: ComputeHolder?)
    /// `owner` is the member's user ID; nil for a computer that joined
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

/// The agent holding an exclusive computer; its title is nil when the reader
/// may not read that agent's conversation.
public struct ComputeHolder: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String?
}

/// What the reader may do with compute: add a computer in any mode and free
/// a held one (`pools.manage`), use computers and add a private one of their
/// own (`compute.use`), or nothing at all.
public enum ComputeAccess: Equatable, Sendable {
    case none, use, manage

    public init(_ gate: RoleGate) {
        // Every compute read and write needs `compute.use`, managing included.
        guard gate.allows(.computeUse) else { self = .none; return }
        self = gate.allows(.poolsManage) ? .manage : .use
    }

    /// The modes it may add a computer in.
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

/// One computer from `/v0/computers`. A member reads its identity, mode
/// and description; host facts, capacity and placements come only to
/// `pools.manage`, so they stay nil for everyone else.
public struct Computer: Decodable, Equatable, Sendable {
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
/// computers (`GET /v0/computers/approvals`).
public struct ComputeApproval: Decodable, Equatable, Sendable {
    public let computerId: String
    public let computerName: String?
    /// Nil when the reader may not read that agent's conversation.
    public let agentTitle: String?
    public let agentId: String
    /// Milliseconds.
    public let createdAt: Double

    /// The one request it is.
    public var id: String { "\(computerId)/\(agentId)" }
}

/// The one-time join token a new computer installs with, shown once.
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
    /// it supports, and PowerShell only for a private computer, the one mode
    /// Windows has.
    public var shown: [Command] {
        guard let commands else { return [] }
        let platforms = mode.platforms
        var shown = [Command(platforms: platforms.filter { $0 != .windows }, text: commands.unix)]
        if platforms.contains(.windows) { shown.append(Command(platforms: [.windows], text: commands.windows)) }
        return shown
    }
}

/// What a new computer will be: its mode. It joins under its hostname.
public struct ComputerDraft: Equatable, Sendable {
    public var mode: ComputeMode.Kind

    public init(mode: ComputeMode.Kind) {
        self.mode = mode
    }
}

/// Adding a computer: choose its mode, then mint the token and show its
/// install commands. Changes that don't belong to the current step are
/// ignored.
public enum ComputerAdd: Equatable, Sendable {
    case choosing(ComputerDraft)
    case creating(ComputerDraft)
    case failed(ComputerDraft, message: String)
    /// Shown once; closing the flow forgets it.
    case shown(ComputeInstall)

    /// Nil when the reader may add nothing. A member starts on private,
    /// the only mode they have.
    public static func start(_ access: ComputeAccess) -> ComputerAdd? {
        access.modes.first.map { .choosing(ComputerDraft(mode: $0)) }
    }

    public var draft: ComputerDraft? {
        switch self {
        case .choosing(let draft), .creating(let draft), .failed(let draft, _): draft
        case .shown: nil
        }
    }

    /// A mode the reader may add, which takes back a refusal the earlier
    /// draft got.
    public mutating func choose(_ mode: ComputeMode.Kind, access: ComputeAccess) {
        switch self {
        case .choosing(var draft), .failed(var draft, _):
            guard access.modes.contains(mode) else { return }
            draft.mode = mode
            self = .choosing(draft)
        default: break
        }
    }

    /// The token request to send, or nil when this step doesn't send one.
    public mutating func create() -> ComputeJoinTokenRequest? {
        switch self {
        case .choosing(let draft), .failed(let draft, _):
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

/// `POST /v0/computers/join-tokens`: only the mode; the computer joins
/// under its hostname.
public struct ComputeJoinTokenRequest: Equatable, Sendable {
    public let mode: ComputeMode.Kind

    public init(_ draft: ComputerDraft) {
        mode = draft.mode
    }

    var json: JSONValue {
        .object(["mode": .string(mode.rawValue)])
    }
}

extension AgentClient {
    /// Every computer the reader may see, revoked ones left out; one the
    /// phone can't read is skipped, never the whole list.
    public func computers() async throws -> [Computer] {
        struct Response: Decodable { let computers: [Lossy<Computer>] }
        return try await decode(Response.self, "GET", "/v0/computers").computers.compactMap(\.value).filter { $0.status != .revoked }
    }

    public func computer(_ id: String) async throws -> Computer {
        struct Response: Decodable { let computer: Computer }
        return try await decode(Response.self, "GET", "/v0/computers/\(Self.escape(id))").computer
    }

    /// The requests to join the reader's private computers, oldest first.
    public func computerApprovals() async throws -> [ComputeApproval] {
        struct Response: Decodable { let approvals: [Lossy<ComputeApproval>] }
        return try await decode(Response.self, "GET", "/v0/computers/approvals").approvals.compactMap(\.value).sorted { $0.createdAt < $1.createdAt }
    }

    public func createComputerJoinToken(_ request: ComputeJoinTokenRequest) async throws -> ComputeInstall {
        try await decode(ComputeInstall.self, "POST", "/v0/computers/join-tokens", json: request.json)
    }

    /// Frees an exclusive computer; the agent that held it, if any.
    @discardableResult
    public func releaseComputerLock(_ id: String) async throws -> String? {
        struct Response: Decodable { let previousHolder: String? }
        return try await decode(Response.self, "POST", "/v0/computers/\(Self.escape(id))/release-lock", json: .object([:])).previousHolder
    }

    public func answerComputerApproval(_ approval: ComputeApproval, approve: Bool) async throws {
        _ = try await send("POST", "/v0/computers/approvals/\(Self.escape(approval.computerId))/\(Self.escape(approval.agentId))", json: .object(["approve": .bool(approve)]))
    }
}
