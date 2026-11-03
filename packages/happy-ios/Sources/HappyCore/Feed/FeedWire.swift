import Foundation
import HappyWire

/// What one Feed entry is about (API.md "Feed"): a task, bot, Surface or
/// artifact by its ID. The set of types grows with the product; one this
/// phone doesn't know shows by its snapshot's title and opens nothing.
public struct FeedSubject: Codable, Equatable, Hashable, Sendable {
    public var type: String
    public var id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }

    /// One string per subject: an intent's target, a peek entry's ID.
    public var key: String { "\(type):\(id)" }
}

/// Who made a change: a person acting directly (`userId`, no agent), an
/// agent (with the person it worked for when known), or nobody (both nil;
/// in standalone mode the installation's one person).
public struct FeedActor: Codable, Equatable, Hashable, Sendable {
    public var userId: String?
    public var agentId: String?

    public init(userId: String? = nil, agentId: String? = nil) {
        self.userId = userId
        self.agentId = agentId
    }
}

/// How to show and open the subject, as of the newest change folded in.
/// Fields the daemon adds later are ignored.
public struct FeedSnapshot: Codable, Equatable, Hashable, Sendable {
    public var title: String
    /// A task's or bot's agent, which opens its chat; for an artifact the
    /// conversation the newest change came from.
    public var agentId: String?
    /// A Surface's type: `todo`, `document`, `calendar`, …
    public var surfaceType: String?
    public var artifactType: String?
    public var artifactVersion: Int?
    /// A few words about the newest change, such as a new todo's text.
    public var detail: String?

    public init(title: String, agentId: String? = nil, surfaceType: String? = nil, artifactType: String? = nil, artifactVersion: Int? = nil, detail: String? = nil) {
        self.title = title
        self.agentId = agentId
        self.surfaceType = surfaceType
        self.artifactType = artifactType
        self.artifactVersion = artifactVersion
        self.detail = detail
    }

    enum CodingKeys: String, CodingKey { case title, agentId, surfaceType, artifactType, artifactVersion, detail }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? container.decode(String.self, forKey: .title)) ?? ""
        agentId = try? container.decodeIfPresent(String.self, forKey: .agentId)
        surfaceType = try? container.decodeIfPresent(String.self, forKey: .surfaceType)
        artifactType = try? container.decodeIfPresent(String.self, forKey: .artifactType)
        artifactVersion = try? container.decodeIfPresent(Int.self, forKey: .artifactVersion)
        detail = try? container.decodeIfPresent(String.self, forKey: .detail)
    }
}

/// One entry of the person's feed (`The feed item object`), or of a peek
/// (`Peek entries`), which has no `id`, `version` or `seenAt` of its own:
/// it is then named by its subject, with an empty version, never seen.
public struct FeedItem: Codable, Equatable, Hashable, Sendable {
    /// Minted when the entry opened; stays as it takes in changes.
    public var id: String
    /// Of two copies of one entry, the greater is current (UUIDv7s sort as text).
    public var version: String
    /// The newest change folded in: the feed's order, newest first.
    public var cursor: String
    public var subject: FeedSubject
    public var cluster: String
    public var created: Bool
    public var updates: Int
    /// The first five distinct actors, in the order they first acted.
    public var actors: [FeedActor]
    public var actorCount: Int
    public var snapshot: FeedSnapshot
    public var firstAt: Double
    public var lastAt: Double
    /// Nil while the entry is open.
    public var seenAt: Double?

    public init(id: String, version: String, cursor: String, subject: FeedSubject, cluster: String = "team", created: Bool = false, updates: Int = 0, actors: [FeedActor] = [], actorCount: Int? = nil, snapshot: FeedSnapshot, firstAt: Double, lastAt: Double, seenAt: Double? = nil) {
        self.id = id
        self.version = version
        self.cursor = cursor
        self.subject = subject
        self.cluster = cluster
        self.created = created
        self.updates = updates
        self.actors = actors
        self.actorCount = actorCount ?? actors.count
        self.snapshot = snapshot
        self.firstAt = firstAt
        self.lastAt = lastAt
        self.seenAt = seenAt
    }

    enum CodingKeys: String, CodingKey { case id, version, cursor, subject, cluster, created, updates, actors, actorCount, snapshot, firstAt, lastAt, seenAt }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        subject = try container.decode(FeedSubject.self, forKey: .subject)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? subject.key
        version = try container.decodeIfPresent(String.self, forKey: .version) ?? ""
        cursor = try container.decode(String.self, forKey: .cursor)
        cluster = (try? container.decode(String.self, forKey: .cluster)) ?? "team"
        created = (try? container.decode(Bool.self, forKey: .created)) ?? false
        updates = max(0, (try? container.decode(Int.self, forKey: .updates)) ?? 0)
        actors = ((try? container.decode([Lossy<FeedActor>].self, forKey: .actors)) ?? []).compactMap(\.value)
        actorCount = max(actors.count, (try? container.decode(Int.self, forKey: .actorCount)) ?? 0)
        snapshot = (try? container.decode(FeedSnapshot.self, forKey: .snapshot)) ?? FeedSnapshot(title: "")
        firstAt = (try? container.decode(Double.self, forKey: .firstAt)) ?? 0
        lastAt = (try? container.decode(Double.self, forKey: .lastAt)) ?? firstAt
        seenAt = try? container.decodeIfPresent(Double.self, forKey: .seenAt)
    }

    /// The daemon hasn't closed it.
    public var open: Bool { seenAt == nil }
}

/// One place the feed gathers from (`The cluster object`): everything
/// (`*`), the team, or one task, bot, Surface, project or workspace.
public struct FeedCluster: Codable, Equatable, Hashable, Sendable {
    public var cluster: String
    public var kind: String
    public var name: String
    /// The person's own choice: `subscribed`, `muted`, or nil to follow `*`.
    public var state: String?
    public var lastAt: Double?

    public init(cluster: String, kind: String, name: String, state: String? = nil, lastAt: Double? = nil) {
        self.cluster = cluster
        self.kind = kind
        self.name = name
        self.state = state
        self.lastAt = lastAt
    }

    /// The ID of the thing a place's cluster (`<kind>:<id>`) names.
    public var placeId: String? {
        let prefix = kind + ":"
        guard cluster.hasPrefix(prefix) else { return nil }
        return String(cluster.dropFirst(prefix.count))
    }
}

/// `GET /v0/feed`.
public struct FeedPage: Decodable, Equatable, Sendable {
    public var items: [FeedItem]
    public var unread: Int
    public var hasMore: Bool
    /// The event cursor captured before the read.
    public var cursor: String?

    public init(items: [FeedItem], unread: Int, hasMore: Bool, cursor: String? = nil) {
        self.items = items
        self.unread = unread
        self.hasMore = hasMore
        self.cursor = cursor
    }

    enum CodingKeys: String, CodingKey { case items, unread, hasMore, cursor }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([Lossy<FeedItem>].self, forKey: .items).compactMap(\.value)
        unread = max(0, (try? container.decode(Int.self, forKey: .unread)) ?? 0)
        hasMore = (try? container.decode(Bool.self, forKey: .hasMore)) ?? false
        cursor = try? container.decodeIfPresent(String.self, forKey: .cursor)
    }
}

/// `POST /v0/feed/seen`'s answer: the entries it closed, and what is open.
public struct FeedSeenAnswer: Decodable, Equatable, Sendable {
    public var items: [FeedItem]
    public var unread: Int

    public init(items: [FeedItem], unread: Int) {
        self.items = items
        self.unread = unread
    }

    enum CodingKeys: String, CodingKey { case items, unread }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = ((try? container.decode([Lossy<FeedItem>].self, forKey: .items)) ?? []).compactMap(\.value)
        unread = max(0, (try? container.decode(Int.self, forKey: .unread)) ?? 0)
    }
}

/// `GET /v0/feed/clusters/:cluster`: what happened in one place, its
/// last 30 days, without following it.
public struct FeedPeek: Decodable, Equatable, Sendable {
    public var cluster: FeedCluster
    public var entries: [FeedItem]

    public init(cluster: FeedCluster, entries: [FeedItem]) {
        self.cluster = cluster
        self.entries = entries
    }

    enum CodingKeys: String, CodingKey { case cluster, entries }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cluster = try container.decode(FeedCluster.self, forKey: .cluster)
        entries = ((try? container.decode([Lossy<FeedItem>].self, forKey: .entries)) ?? []).compactMap(\.value)
    }
}

/// The Feed's routes (API.md "Feed"), as the library uses them: the
/// computer's client, or a test's fake.
public protocol FeedRoutes: Sendable {
    /// Whether the daemon serves the Feed (`capabilities.feed`).
    func feedCapable() async throws -> Bool
    func feed(before: String?, limit: Int) async throws -> FeedPage
    func markFeedSeen(_ subject: FeedSubject, through: String?, mutationId: String) async throws -> FeedSeenAnswer
    /// What stays open.
    func markFeedReadAll(through: String?, mutationId: String) async throws -> Int
    func feedClusters() async throws -> [FeedCluster]
    /// Follows `cluster`, or mutes it.
    func followFeedCluster(_ cluster: String, follow: Bool, mutationId: String) async throws -> FeedCluster
    func peekFeedCluster(_ cluster: String, limit: Int) async throws -> FeedPeek
    func teamUsers(_ ids: [String]) async throws -> [TeamUser]
}

extension AgentClient: FeedRoutes {
    public func feedCapable() async throws -> Bool {
        try await decode(JSONValue.self, "GET", "/v0/health")["capabilities"]?["feed"]?.boolValue == true
    }

    public func feed(before: String?, limit: Int) async throws -> FeedPage {
        var query = ["limit=\(max(1, min(200, limit)))"]
        if let before { query.append("before=\(Self.escape(before))") }
        return try await decode(FeedPage.self, "GET", "/v0/feed?" + query.joined(separator: "&"))
    }

    public func markFeedSeen(_ subject: FeedSubject, through: String?, mutationId: String) async throws -> FeedSeenAnswer {
        var entry: [String: JSONValue] = ["type": .string(subject.type), "id": .string(subject.id)]
        if let through { entry["through"] = .string(through) }
        return try await decode(FeedSeenAnswer.self, "POST", "/v0/feed/seen", json: .object([
            "subjects": .array([.object(entry)]), "mutationId": .string(mutationId),
        ]))
    }

    public func markFeedReadAll(through: String?, mutationId: String) async throws -> Int {
        struct Answer: Decodable { var unread: Int? }
        var body: [String: JSONValue] = ["mutationId": .string(mutationId)]
        if let through { body["through"] = .string(through) }
        return max(0, try await decode(Answer.self, "POST", "/v0/feed/read-all", json: .object(body)).unread ?? 0)
    }

    public func feedClusters() async throws -> [FeedCluster] {
        struct Answer: Decodable { var clusters: [Lossy<FeedCluster>] }
        return try await decode(Answer.self, "GET", "/v0/feed/clusters").clusters.compactMap(\.value)
    }

    public func followFeedCluster(_ cluster: String, follow: Bool, mutationId: String) async throws -> FeedCluster {
        struct Answer: Decodable { var cluster: FeedCluster }
        return try await decode(Answer.self, follow ? "PUT" : "DELETE", "/v0/feed/subscriptions/\(Self.escape(cluster))", json: .object(["mutationId": .string(mutationId)])).cluster
    }

    public func peekFeedCluster(_ cluster: String, limit: Int) async throws -> FeedPeek {
        try await decode(FeedPeek.self, "GET", "/v0/feed/clusters/\(Self.escape(cluster))?limit=\(max(1, min(200, limit)))")
    }
}
