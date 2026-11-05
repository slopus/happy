import Foundation
import HappyWire

// A vault Surface's records as the computer sends them (happy-agent
// API.md, "Vault Surfaces"). Optional fields the contract makes `null`
// are encoded as `null`, so a kept copy reads back the same.

/// Who made a change: the person, the agent, both or neither.
public struct VaultActor: Codable, Equatable, Hashable, Sendable {
    public var userId: String?
    public var agentId: String?

    public init(userId: String? = nil, agentId: String? = nil) {
        self.userId = userId
        self.agentId = agentId
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(userId, forKey: .userId)
        try container.encode(agentId, forKey: .agentId)
    }
}

/// An artifact entry's app: `html` or `markdown`, its entry file, and
/// on a single-version read its whole manifest.
public struct VaultArtifact: Codable, Equatable, Hashable, Sendable {
    public struct File: Codable, Equatable, Hashable, Sendable {
        public var path: String
        public var mimeType: String
        public var size: Int
        public var sha256: String?

        public init(path: String, mimeType: String, size: Int, sha256: String? = nil) {
            self.path = path
            self.mimeType = mimeType
            self.size = size
            self.sha256 = sha256
        }
    }

    public var type: String
    public var entry: String
    public var fileCount: Int
    public var files: [File]?

    public init(type: String, entry: String, fileCount: Int, files: [File]? = nil) {
        self.type = type
        self.entry = entry
        self.fileCount = fileCount
        self.files = files
    }
}

/// One node of a vault's tree. Paths come from names; the ID is the identity.
public struct VaultEntry: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case folder
        case file
        case artifact
    }

    public var id: String
    public var surfaceId: String
    /// Nil at the vault's root, which is not an entry.
    public var parentId: String?
    public var name: String
    public var kind: Kind
    public var latestVersion: Int?
    public var size: Int?
    public var sha256: String?
    public var mediaType: String?
    public var artifact: VaultArtifact?
    /// Epoch milliseconds.
    public var createdAt: Double
    public var createdBy: VaultActor
    public var updatedAt: Double
    public var updatedBy: VaultActor
    /// When the entry itself went to the Trash.
    public var deletedAt: Double?
    /// The UUIDv7 resource version; empty for one made here and not taken yet.
    public var version: String

    public init(id: String, surfaceId: String, parentId: String?, name: String, kind: Kind, latestVersion: Int? = nil, size: Int? = nil,
                sha256: String? = nil, mediaType: String? = nil, artifact: VaultArtifact? = nil, createdAt: Double = 0, createdBy: VaultActor = VaultActor(),
                updatedAt: Double = 0, updatedBy: VaultActor = VaultActor(), deletedAt: Double? = nil, version: String = "") {
        self.id = id
        self.surfaceId = surfaceId
        self.parentId = parentId
        self.name = name
        self.kind = kind
        self.latestVersion = latestVersion
        self.size = size
        self.sha256 = sha256
        self.mediaType = mediaType
        self.artifact = artifact
        self.createdAt = createdAt
        self.createdBy = createdBy
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
        self.deletedAt = deletedAt
        self.version = version
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(surfaceId, forKey: .surfaceId)
        try container.encode(parentId, forKey: .parentId)
        try container.encode(name, forKey: .name)
        try container.encode(kind, forKey: .kind)
        try container.encode(latestVersion, forKey: .latestVersion)
        try container.encode(size, forKey: .size)
        try container.encode(sha256, forKey: .sha256)
        try container.encode(mediaType, forKey: .mediaType)
        try container.encode(artifact, forKey: .artifact)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(createdBy, forKey: .createdBy)
        try container.encode(updatedAt, forKey: .updatedAt)
        try container.encode(updatedBy, forKey: .updatedBy)
        try container.encode(deletedAt, forKey: .deletedAt)
        try container.encode(version, forKey: .version)
    }

    /// An entry as the computer sends it; nil for one this app can't read.
    public init?(json: JSONValue) {
        guard let data = try? JSONEncoder().encode(json), let entry = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
        self = entry
    }

    public var json: JSONValue {
        (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(self))) ?? .null
    }

    public var isFolder: Bool { kind == .folder }

    /// Every app's stored name ends in this, and nothing else's.
    public static let artifactSuffix = ".artifact"

    /// The name people see: an app's without its `.artifact`, which its
    /// icon and live preview already tell apart.
    public var shownName: String { Self.shownName(name) }

    public static func shownName(_ name: String) -> String {
        kind(named: name) == .artifact ? String(name.dropLast(artifactSuffix.count)) : name
    }

    /// An app's stored name from the one a person typed, `.artifact` kept.
    public static func appName(_ typed: String) -> String {
        kind(named: typed) == .artifact ? typed : typed + artifactSuffix
    }

    /// What an upload named `name` becomes: an app when it ends in
    /// `.artifact`, whatever the case, else a file.
    public static func kind(named name: String) -> Kind {
        name.lowercased().hasSuffix(artifactSuffix) && name.count > artifactSuffix.count ? .artifact : .file
    }
}

/// Where an entry is: its path, the folders from the root down, and
/// whether it or one of them is in the Trash.
public struct VaultLocation: Equatable, Sendable {
    public struct Ancestor: Codable, Equatable, Sendable {
        public var id: String
        public var name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    public var entry: VaultEntry
    public var path: String
    public var ancestors: [Ancestor]
    public var inTrash: Bool

    public init(entry: VaultEntry, path: String, ancestors: [Ancestor], inTrash: Bool) {
        self.entry = entry
        self.path = path
        self.ancestors = ancestors
        self.inTrash = inTrash
    }
}

/// One numbered content version of a file or artifact.
public struct VaultVersion: Codable, Equatable, Hashable, Sendable, Identifiable {
    public var entryId: String
    public var surfaceId: String
    public var number: Int
    public var size: Int
    public var sha256: String?
    public var artifact: VaultArtifact?
    public var pinned: Bool
    public var restoredFrom: Int?
    public var createdAt: Double
    public var actor: VaultActor
    /// `api` or `tool`.
    public var source: String

    public var id: Int { number }

    private enum CodingKeys: String, CodingKey {
        case entryId = "fileId"
        case surfaceId, number, size, sha256, artifact, pinned, restoredFrom, createdAt, actor, source
    }

    public init(entryId: String, surfaceId: String, number: Int, size: Int, sha256: String? = nil, artifact: VaultArtifact? = nil, pinned: Bool = false,
                restoredFrom: Int? = nil, createdAt: Double = 0, actor: VaultActor = VaultActor(), source: String = "api") {
        self.entryId = entryId
        self.surfaceId = surfaceId
        self.number = number
        self.size = size
        self.sha256 = sha256
        self.artifact = artifact
        self.pinned = pinned
        self.restoredFrom = restoredFrom
        self.createdAt = createdAt
        self.actor = actor
        self.source = source
    }
}

/// One record of an entry's append-only history. Kinds may grow; one
/// not known here is shown as a change.
public struct VaultActivity: Codable, Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: Equatable, Hashable, Sendable {
        case created(parentId: String?, name: String, copiedFrom: String?)
        case moved(fromParentId: String?, toParentId: String?, fromName: String, toName: String)
        case deleted
        case restored(parentId: String?, name: String)
        case versionCreated(number: Int, restoredFrom: Int?)
        case pinned(number: Int)
        case unpinned(number: Int)
        case other(String)
    }

    public var id: String
    public var entryId: String
    public var kind: Kind
    public var at: Double
    public var actor: VaultActor
    public var source: String

    public init(id: String, entryId: String, kind: Kind, at: Double, actor: VaultActor = VaultActor(), source: String = "api") {
        self.id = id
        self.entryId = entryId
        self.kind = kind
        self.at = at
        self.actor = actor
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case entryId = "itemId"
        case id, kind, at, actor, source, parentId, name, copiedFrom, fromParentId, toParentId, fromName, toName, number, restoredFrom
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        entryId = try c.decode(String.self, forKey: .entryId)
        at = try c.decode(Double.self, forKey: .at)
        actor = try c.decodeIfPresent(VaultActor.self, forKey: .actor) ?? VaultActor()
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "api"
        let raw = try c.decode(String.self, forKey: .kind)
        func string(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil }
        func int(_ key: CodingKeys) -> Int? { (try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil }
        switch raw {
        case "created": kind = .created(parentId: string(.parentId), name: string(.name) ?? "", copiedFrom: string(.copiedFrom))
        case "moved": kind = .moved(fromParentId: string(.fromParentId), toParentId: string(.toParentId), fromName: string(.fromName) ?? "", toName: string(.toName) ?? "")
        case "deleted": kind = .deleted
        case "restored": kind = .restored(parentId: string(.parentId), name: string(.name) ?? "")
        case "version_created": kind = int(.number).map { .versionCreated(number: $0, restoredFrom: int(.restoredFrom)) } ?? .other(raw)
        case "pinned": kind = int(.number).map { .pinned(number: $0) } ?? .other(raw)
        case "unpinned": kind = int(.number).map { .unpinned(number: $0) } ?? .other(raw)
        default: kind = .other(raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(entryId, forKey: .entryId)
        try c.encode(at, forKey: .at)
        try c.encode(actor, forKey: .actor)
        try c.encode(source, forKey: .source)
        switch kind {
        case .created(let parentId, let name, let copiedFrom):
            try c.encode("created", forKey: .kind); try c.encode(parentId, forKey: .parentId); try c.encode(name, forKey: .name); try c.encode(copiedFrom, forKey: .copiedFrom)
        case .moved(let fromParentId, let toParentId, let fromName, let toName):
            try c.encode("moved", forKey: .kind); try c.encode(fromParentId, forKey: .fromParentId); try c.encode(toParentId, forKey: .toParentId)
            try c.encode(fromName, forKey: .fromName); try c.encode(toName, forKey: .toName)
        case .deleted: try c.encode("deleted", forKey: .kind)
        case .restored(let parentId, let name): try c.encode("restored", forKey: .kind); try c.encode(parentId, forKey: .parentId); try c.encode(name, forKey: .name)
        case .versionCreated(let number, let restoredFrom): try c.encode("version_created", forKey: .kind); try c.encode(number, forKey: .number); try c.encode(restoredFrom, forKey: .restoredFrom)
        case .pinned(let number): try c.encode("pinned", forKey: .kind); try c.encode(number, forKey: .number)
        case .unpinned(let number): try c.encode("unpinned", forKey: .kind); try c.encode(number, forKey: .number)
        case .other(let raw): try c.encode(raw, forKey: .kind)
        }
    }
}

/// A Trash item and where it was.
public struct VaultTrashItem: Codable, Equatable, Sendable, Identifiable {
    public var entry: VaultEntry
    public var path: String
    public var id: String { entry.id }

    private enum CodingKeys: String, CodingKey {
        case entry = "item"
        case path
    }

    public init(entry: VaultEntry, path: String) {
        self.entry = entry
        self.path = path
    }
}

/// One search hit: a name match, or text found in a file (inside an
/// artifact, `innerPath`) with the line it starts on.
public struct VaultSearchResult: Codable, Equatable, Sendable {
    public enum Match: String, Codable, Sendable {
        case name
        case content
    }

    public var entry: VaultEntry
    public var path: String
    public var match: Match
    public var innerPath: String?
    public var line: Int?
    public var snippet: String?

    private enum CodingKeys: String, CodingKey {
        case entry = "item"
        case path, match, innerPath, line, snippet
    }

    public init(entry: VaultEntry, path: String, match: Match, innerPath: String? = nil, line: Int? = nil, snippet: String? = nil) {
        self.entry = entry
        self.path = path
        self.match = match
        self.innerPath = innerPath
        self.line = line
        self.snippet = snippet
    }
}

/// A staged upload: bytes received so far, from the start.
public struct VaultUpload: Codable, Equatable, Sendable {
    public var id: String
    public var size: Int
    public var received: Int
    public var sha256: String?
    /// `receiving` or `complete`.
    public var status: String

    public init(id: String, size: Int, received: Int, sha256: String? = nil, status: String) {
        self.id = id
        self.size = size
        self.received = received
        self.sha256 = sha256
        self.status = status
    }

    public var complete: Bool { status == "complete" || received >= size }
}

/// A vault's settings, a version-chained resource of their own.
public struct VaultSettings: Codable, Equatable, Sendable {
    public var surfaceId: String
    public var retention: VaultRetention
    public var updatedAt: Double
    public var version: String

    public init(surfaceId: String, retention: VaultRetention, updatedAt: Double = 0, version: String = "") {
        self.surfaceId = surfaceId
        self.retention = retention
        self.updatedAt = updatedAt
        self.version = version
    }
}
