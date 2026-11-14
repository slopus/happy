import Foundation
import HappyWire

/// Who a computer takes agents from, chosen when it is added: the team's,
/// or one member's own computer for their own agents, each approved.
public enum ComputeAccess: String, CaseIterable, Codable, Sendable {
    case shared, `private`

    /// How many agents a new computer runs at once unless asked otherwise.
    public var defaultConcurrency: Int {
        switch self {
        case .shared: 8
        case .private: 1
        }
    }
}

public enum ComputePlatform: String, CaseIterable, Equatable, Sendable {
    case macOS = "macos", linux, windows

    /// The system of a published supervisor build, `<os>-<arch>`.
    public init?(build: String) {
        self.init(rawValue: String(build.prefix { $0 != "-" }))
    }
}

/// What the reader may do with compute: add a computer of either access and
/// manage every one (`pools.manage`), use computers and add a private one of
/// their own (`compute.use`), or nothing at all.
public enum ComputeRole: Equatable, Sendable {
    case none, use, manage

    public init(_ gate: RoleGate) {
        // Every compute read and write needs `compute.use`, managing included.
        guard gate.allows(.computeUse) else { self = .none; return }
        self = gate.allows(.poolsManage) ? .manage : .use
    }

    /// The access it may add a computer with.
    public var accesses: [ComputeAccess] {
        switch self {
        case .none: []
        case .use: [.private]
        case .manage: ComputeAccess.allCases
        }
    }
}

/// The most agents any computer runs at once.
public enum ComputeConcurrency {
    public static let limit = 64
    public static let range = 1...limit
}

/// One computer from `/v0/computers`: who it takes agents from, how many it
/// runs at once and which are on it now. Host facts and the backend come
/// only to `pools.manage`, so they stay nil for everyone else.
public struct Computer: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case online, offline, draining, enrolling, revoked }

    /// Startup host totals. Missing facts remain unknown.
    public struct Host: Decodable, Equatable, Sendable {
        public let cpuCores: Double?
        public let totalMemoryBytes: Double?
        public let totalDiskBytes: Double?
    }

    /// An agent placed on it; its title is nil when the reader may not read
    /// that agent's conversation.
    public struct Agent: Decodable, Equatable, Sendable {
        public let id: String
        public let title: String?
    }

    /// Whether it can run an agent's restricted commands. Where it can't,
    /// only full-access commands run there.
    public struct Boundary: Decodable, Equatable, Sendable {
        public let available: Bool
        public let reason: String?
    }

    public let id: String
    public let name: String?
    public let hostname: String?
    public let os: String?
    public let arch: String?
    public let version: String?
    public let osVersion: String?
    public let shell: String?
    public let status: Status
    public let since: Double?
    public let lastSeenAt: Double?
    /// What agents read about it in `list_compute`.
    public let description: String?
    public let access: ComputeAccess
    /// The member a private computer belongs to.
    public let owner: String?
    /// How many agents it runs at once.
    public let concurrency: Int
    /// The most it can be set to, where the computer says.
    public let maxConcurrency: Int?
    public let agents: [Agent]
    public let boundary: Boundary
    public let backend: String?
    public let host: Host?

    public var displayName: String {
        [name, hostname].compactMap { $0 }.first { !$0.isEmpty } ?? id
    }

    /// It takes no more agents until one leaves; it is still listed.
    public var full: Bool { agents.count >= concurrency }

    /// What its concurrency may be set to.
    public var concurrencyRange: ClosedRange<Int> {
        1...max(1, min(ComputeConcurrency.limit, maxConcurrency ?? ComputeConcurrency.limit))
    }

    public func ownedBy(_ userId: String?) -> Bool {
        guard access == .private, let owner, let userId else { return false }
        return owner == userId
    }

    /// Whether the reader may change its concurrency and remove its agents:
    /// a manager, or the owner of a private computer.
    public func manageable(by role: ComputeRole, userId: String?) -> Bool {
        role == .manage || role == .use && ownedBy(userId)
    }

    enum CodingKeys: String, CodingKey {
        case id, name, hostname, os, arch, version, osVersion, shell, status, since, lastSeenAt, description
        case access, owner, concurrency, maxConcurrency, agents, boundary, backend, host
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
        shell = try c.decodeIfPresent(String.self, forKey: .shell)
        status = try c.decode(Status.self, forKey: .status)
        since = try c.decodeIfPresent(Double.self, forKey: .since)
        lastSeenAt = try c.decodeIfPresent(Double.self, forKey: .lastSeenAt)
        description = try c.decodeIfPresent(String.self, forKey: .description).flatMap { $0.isEmpty ? nil : $0 }
        access = try c.decode(ComputeAccess.self, forKey: .access)
        owner = try c.decodeIfPresent(String.self, forKey: .owner)
        concurrency = try c.decode(Int.self, forKey: .concurrency)
        maxConcurrency = try c.decodeIfPresent(Int.self, forKey: .maxConcurrency)
        guard concurrency >= 1, maxConcurrency.map({ $0 >= 1 }) ?? true else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Concurrency below 1"))
        }
        agents = try c.decode([Agent].self, forKey: .agents)
        boundary = try c.decode(Boundary.self, forKey: .boundary)
        backend = try c.decodeIfPresent(String.self, forKey: .backend)
        host = try c.decodeIfPresent(Host.self, forKey: .host)
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

    public let access: ComputeAccess
    public let concurrency: Int
    public let token: String
    /// Milliseconds.
    public let expiresAt: Double
    public let clusterUrl: String
    /// Nil where the server publishes no installer.
    public let commands: Commands?
    /// The published supervisor builds, `<os>-<arch>`.
    public let platforms: [String]
    /// What the server says about running it, where it says something.
    public let notice: String?

    /// The commands the published builds' systems run: the shell one for
    /// macOS and Linux, and PowerShell for Windows.
    public var shown: [Command] {
        guard let commands else { return [] }
        let systems = ComputePlatform.allCases.filter { system in platforms.contains { ComputePlatform(build: $0) == system } }
        var shown: [Command] = []
        let unix = systems.filter { $0 != .windows }
        if !unix.isEmpty { shown.append(Command(platforms: unix, text: commands.unix)) }
        if systems.contains(.windows) { shown.append(Command(platforms: [.windows], text: commands.windows)) }
        return shown
    }

    enum CodingKeys: String, CodingKey { case access, concurrency, token, expiresAt, clusterUrl, commands, platforms, notice }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        access = try c.decode(ComputeAccess.self, forKey: .access)
        concurrency = try c.decode(Int.self, forKey: .concurrency)
        token = try c.decode(String.self, forKey: .token)
        expiresAt = try c.decode(Double.self, forKey: .expiresAt)
        clusterUrl = try c.decode(String.self, forKey: .clusterUrl)
        commands = try c.decodeIfPresent(Commands.self, forKey: .commands)
        platforms = try c.decode([String].self, forKey: .platforms)
        notice = try c.decodeIfPresent(String.self, forKey: .notice).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// What a new computer will be: who it takes agents from and how many at
/// once. It joins under its hostname.
public struct ComputerDraft: Equatable, Sendable {
    public var access: ComputeAccess
    /// Nil for the access's default.
    public var concurrency: Int?

    public init(access: ComputeAccess, concurrency: Int? = nil) {
        self.access = access
        self.concurrency = concurrency
    }

    /// What it will run at once.
    public var shownConcurrency: Int { concurrency ?? access.defaultConcurrency }
}

/// Adding a computer: choose its access and concurrency, then mint the token
/// and show its install commands. Changes that don't belong to the current
/// step are ignored.
public enum ComputerAdd: Equatable, Sendable {
    case choosing(ComputerDraft)
    case creating(ComputerDraft)
    case failed(ComputerDraft, message: String)
    /// Shown once; closing the flow forgets it.
    case shown(ComputeInstall)

    /// Nil when the reader may add nothing. A manager starts on shared, a
    /// member on private, the only access they have.
    public static func start(_ role: ComputeRole) -> ComputerAdd? {
        role.accesses.first.map { .choosing(ComputerDraft(access: $0)) }
    }

    public var draft: ComputerDraft? {
        switch self {
        case .choosing(let draft), .creating(let draft), .failed(let draft, _): draft
        case .shown: nil
        }
    }

    /// An access the reader may add, which takes back a refusal the earlier
    /// draft got. A concurrency left at the default follows the new access.
    public mutating func choose(_ access: ComputeAccess, role: ComputeRole) {
        guard role.accesses.contains(access) else { return }
        edit { $0.access = access }
    }

    /// A concurrency in 1…64; nil goes back to the access's default.
    public mutating func setConcurrency(_ concurrency: Int?) {
        guard concurrency.map(ComputeConcurrency.range.contains) ?? true else { return }
        edit { $0.concurrency = concurrency }
    }

    private mutating func edit(_ change: (inout ComputerDraft) -> Void) {
        switch self {
        case .choosing(var draft), .failed(var draft, _):
            change(&draft)
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

/// `POST /v0/computers/join-tokens`: the access, and the concurrency only
/// where it isn't the default; the computer joins under its hostname.
public struct ComputeJoinTokenRequest: Equatable, Sendable {
    public let access: ComputeAccess
    public let concurrency: Int?

    public init(_ draft: ComputerDraft) {
        access = draft.access
        concurrency = draft.concurrency
    }

    var json: JSONValue {
        var body: [String: JSONValue] = ["access": .string(access.rawValue)]
        if let concurrency { body["concurrency"] = .number(Double(concurrency)) }
        return .object(body)
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

    /// Sets how many agents it runs at once; the computer as it is now.
    public func setComputerConcurrency(_ id: String, _ concurrency: Int) async throws -> Computer {
        struct Response: Decodable { let computer: Computer }
        return try await decode(Response.self, "PATCH", "/v0/computers/\(Self.escape(id))", json: .object(["concurrency": .number(Double(concurrency))])).computer
    }

    /// Takes an agent off it, freeing its place.
    public func removeComputerAgent(_ id: String, agent: String) async throws {
        _ = try await send("DELETE", "/v0/computers/\(Self.escape(id))/agents/\(Self.escape(agent))")
    }

    public func answerComputerApproval(_ approval: ComputeApproval, approve: Bool) async throws {
        _ = try await send("POST", "/v0/computers/approvals/\(Self.escape(approval.computerId))/\(Self.escape(approval.agentId))", json: .object(["approve": .bool(approve)]))
    }
}
