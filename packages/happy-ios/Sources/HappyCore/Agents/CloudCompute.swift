import Foundation

/// Monitoring snapshots from `/v0/compute`. These types expose no node
/// management operations. Slots are configured capacity, not free resources.
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

public struct ComputePool: Decodable, Equatable, Sendable {
    public struct Counts: Decodable, Equatable, Sendable {
        public let total: Int
        public let online: Int
        public let offline: Int
        public let draining: Int
        public let enrolling: Int
        public let revoked: Int
    }

    public let id: String
    public let name: String
    public let kind: String
    public let isDefault: Bool
    public let nodeCounts: Counts
    public let sandboxCapacity: ComputeCapacity

    enum CodingKeys: String, CodingKey {
        case id, name, kind, nodeCounts, sandboxCapacity
        case isDefault = "default"
    }
}

public struct ComputeNode: Decodable, Equatable, Sendable {
    /// Startup host totals. Missing facts remain unknown, including on B
    /// servers, which omit `host` altogether.
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
    public let pool: String
    public let name: String?
    public let hostname: String?
    public let os: String?
    public let arch: String?
    public let version: String?
    public let osVersion: String?
    public let shell: String?
    public let sandboxError: String?
    public let status: String
    public let since: Double?
    public let enrolledAt: Double?
    public let lastSeenAt: Double?
    public let backend: String?
    public let capabilities: [String: String]?
    public let features: [String: Bool]?
    public let sandboxCapacity: ComputeCapacity
    public let host: Host?
    public let activeSandboxes: [Placement]

    public var displayName: String {
        [name, hostname].compactMap { $0 }.first { !$0.isEmpty } ?? id
    }
}

public struct ComputePoolDetail: Decodable, Equatable, Sendable {
    public let pool: ComputePool
    public let nodes: [ComputeNode]
}

extension AgentClient {
    public func computePools() async throws -> [ComputePool] {
        struct Response: Decodable { let pools: [ComputePool] }
        return try await decode(Response.self, "GET", "/v0/compute/pools").pools
    }

    public func computePool(_ id: String) async throws -> ComputePoolDetail {
        try await decode(ComputePoolDetail.self, "GET", "/v0/compute/pools/\(Self.escape(id))")
    }

    public func computeNode(_ id: String) async throws -> ComputeNode {
        struct Response: Decodable { let node: ComputeNode }
        return try await decode(Response.self, "GET", "/v0/compute/nodes/\(Self.escape(id))").node
    }
}