import Foundation
import HappyWire

/// What one Feed entry is about (API.md "Feed"): a task, bot, Surface or
/// artifact by its ID. The set of types grows with the product; one this
/// phone doesn't know can't be shown, so its entry is left out.
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

/// The newest change folded into an entry, by reference (API.md "Feed",
/// `latest`): what it was, and the todo, document change or artifact
/// version it made. An entry never carries its subject's data; the phone
/// reads that from what it syncs. The first Feed daemons send none.
public struct FeedLatest: Codable, Equatable, Hashable, Sendable {
    /// `task.created`, `bot.created`, `surface.created`, `todo.created`,
    /// `document.edited`, `artifact.created`, `artifact.updated`; one this
    /// phone doesn't know is a change with nothing more to say.
    public var type: String
    /// `todo.created`'s new todo, in the entry's Surface.
    public var todoId: String?
    /// `document.edited`'s document change that began the edit session.
    public var seq: Int?
    /// The version an artifact's change made.
    public var artifactVersion: Int?

    public init(type: String, todoId: String? = nil, seq: Int? = nil, artifactVersion: Int? = nil) {
        self.type = type
        self.todoId = todoId
        self.seq = seq
        self.artifactVersion = artifactVersion
    }

    enum CodingKeys: String, CodingKey { case type, todoId, seq, artifactVersion }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        todoId = try? container.decodeIfPresent(String.self, forKey: .todoId)
        seq = try? container.decodeIfPresent(Int.self, forKey: .seq)
        artifactVersion = try? container.decodeIfPresent(Int.self, forKey: .artifactVersion)
    }
}

/// One entry of the person's feed (`The feed item object`), or of a peek
/// (`Peek entries`), which has no `id`, `version` or `seenAt` of its own:
/// it is then named by its subject, with an empty version, never seen.
///
/// References and counts only. The first Feed daemons also sent a
/// `snapshot` of the subject as it was then (its title, its type); it is
/// never read, so a rename shows at once, and a daemon that sends none
/// reads the same.
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
    /// Nil from the first Feed daemons, and from one whose `latest` this
    /// phone can't read.
    public var latest: FeedLatest?
    public var firstAt: Double
    public var lastAt: Double
    /// Nil while the entry is open.
    public var seenAt: Double?

    public init(id: String, version: String, cursor: String, subject: FeedSubject, cluster: String = "team", created: Bool = false, updates: Int = 0, actors: [FeedActor] = [], actorCount: Int? = nil, latest: FeedLatest? = nil, firstAt: Double, lastAt: Double, seenAt: Double? = nil) {
        self.id = id
        self.version = version
        self.cursor = cursor
        self.subject = subject
        self.cluster = cluster
        self.created = created
        self.updates = updates
        self.actors = actors
        self.actorCount = actorCount ?? actors.count
        self.latest = latest
        self.firstAt = firstAt
        self.lastAt = lastAt
        self.seenAt = seenAt
    }

    enum CodingKeys: String, CodingKey { case id, version, cursor, subject, cluster, created, updates, actors, actorCount, latest, firstAt, lastAt, seenAt }

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
        latest = try? container.decodeIfPresent(FeedLatest.self, forKey: .latest)
        firstAt = (try? container.decode(Double.self, forKey: .firstAt)) ?? 0
        lastAt = (try? container.decode(Double.self, forKey: .lastAt)) ?? firstAt
        seenAt = try? container.decodeIfPresent(Double.self, forKey: .seenAt)
    }

    /// The daemon hasn't closed it.
    public var open: Bool { seenAt == nil }
}

/// One place the feed gathers from (`The cluster object`): everything
/// (`*`), the team, or one task, bot, Surface, project or workspace, by
/// reference only. What it is called comes from what the phone syncs
/// (`FeedDirectory`); the `name` the first Feed daemons sent is never read.
public struct FeedCluster: Codable, Equatable, Hashable, Sendable {
    public var cluster: String
    /// `everything`, `team`, `task`, `bot`, `surface`, `project`,
    /// `workspace`; the set grows, and an unknown one names nothing here.
    public var kind: String
    /// The person's own choice: `subscribed`, `muted`, or nil to follow `*`.
    public var state: String?
    public var lastAt: Double?

    public init(cluster: String, kind: String, state: String? = nil, lastAt: Double? = nil) {
        self.cluster = cluster
        self.kind = kind
        self.state = state
        self.lastAt = lastAt
    }

    enum CodingKeys: String, CodingKey { case cluster, kind, state, lastAt }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cluster = try container.decode(String.self, forKey: .cluster)
        kind = (try? container.decode(String.self, forKey: .kind)) ?? Self.kind(of: cluster)
        state = try? container.decodeIfPresent(String.self, forKey: .state)
        lastAt = try? container.decodeIfPresent(Double.self, forKey: .lastAt)
    }

    /// The kind a cluster's name says: `*`, `team`, or what comes before `:`.
    static func kind(of cluster: String) -> String {
        if cluster == "*" { return "everything" }
        guard let colon = cluster.firstIndex(of: ":") else { return cluster }
        return String(cluster[..<colon])
    }

    /// The ID of the thing a place's cluster (`<kind>:<id>`) names.
    public var placeId: String? {
        let prefix = kind + ":"
        guard cluster.hasPrefix(prefix) else { return nil }
        return String(cluster.dropFirst(prefix.count))
    }
}

/// Which entries the Feed shows (desktop's feed filter): all of them, or
/// its Highlights, the entries about artifacts and tasks.
public enum FeedFilter: String, Equatable, Hashable, Sendable, CaseIterable {
    case all
    case highlights

    /// The subject types it keeps, as `GET /v0/feed?subjects=` names
    /// them; nil for every one.
    public var subjects: [String]? {
        switch self {
        case .all: nil
        case .highlights: ["artifact", "task"]
        }
    }

    public func includes(_ item: FeedItem) -> Bool {
        subjects.map { $0.contains(item.subject.type) } ?? true
    }
}

/// What a computer's health says of its Feed (`capabilities`): whether it
/// keeps one, whether it filters it by subject (`feedSubjectFilter`), and
/// whether its artifacts carry covers (`artifactCovers`).
public struct FeedCapabilities: Equatable, Sendable {
    public var feed: Bool
    public var subjectFilter: Bool
    public var covers: Bool

    public init(feed: Bool, subjectFilter: Bool = false, covers: Bool = false) {
        self.feed = feed
        self.subjectFilter = subjectFilter
        self.covers = covers
    }

    public init(health: JSONValue) {
        let capabilities = health["capabilities"]
        feed = capabilities?["feed"]?.boolValue == true
        subjectFilter = capabilities?["feedSubjectFilter"]?.boolValue == true
        covers = capabilities?["artifactCovers"]?.boolValue == true
    }
}

/// `GET /v0/feed`.
public struct FeedPage: Decodable, Equatable, Sendable {
    public var items: [FeedItem]
    public var unread: Int
    /// How many of the filtered list are open, when the read was filtered
    /// (`subjects`); `unread` stays the person's whole count.
    public var filteredUnread: Int?
    public var hasMore: Bool
    /// The event cursor captured before the read.
    public var cursor: String?

    public init(items: [FeedItem], unread: Int, filteredUnread: Int? = nil, hasMore: Bool, cursor: String? = nil) {
        self.items = items
        self.unread = unread
        self.filteredUnread = filteredUnread
        self.hasMore = hasMore
        self.cursor = cursor
    }

    enum CodingKeys: String, CodingKey { case items, unread, filteredUnread, hasMore, cursor }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decode([Lossy<FeedItem>].self, forKey: .items).compactMap(\.value)
        unread = max(0, (try? container.decode(Int.self, forKey: .unread)) ?? 0)
        filteredUnread = (try? container.decodeIfPresent(Int.self, forKey: .filteredUnread)).flatMap { $0.map { max(0, $0) } }
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
    /// Nil when the computer's can't be read: the screen already knows
    /// which place it peeked at.
    public var cluster: FeedCluster?
    public var entries: [FeedItem]

    public init(cluster: FeedCluster?, entries: [FeedItem]) {
        self.cluster = cluster
        self.entries = entries
    }

    enum CodingKeys: String, CodingKey { case cluster, entries }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cluster = try? container.decode(FeedCluster.self, forKey: .cluster)
        entries = ((try? container.decode([Lossy<FeedItem>].self, forKey: .entries)) ?? []).compactMap(\.value)
    }
}

/// The Feed's routes (API.md "Feed"), as the library uses them: the
/// computer's client, or a test's fake.
public protocol FeedRoutes: Sendable {
    /// Whether the daemon serves the Feed, filters it and covers artifacts.
    func feedCapabilities() async throws -> FeedCapabilities
    /// A page of the entries about `subjects`, or of every entry for nil.
    func feed(before: String?, limit: Int, subjects: [String]?) async throws -> FeedPage
    func markFeedSeen(_ subject: FeedSubject, through: String?, mutationId: String) async throws -> FeedSeenAnswer
    /// What stays open. `subjects` closes only the entries about those.
    func markFeedReadAll(through: String?, subjects: [String]?, mutationId: String) async throws -> Int
    func feedClusters() async throws -> [FeedCluster]
    /// Follows `cluster`, or mutes it.
    func followFeedCluster(_ cluster: String, follow: Bool, mutationId: String) async throws -> FeedCluster
    func peekFeedCluster(_ cluster: String, limit: Int) async throws -> FeedPeek
}

extension AgentClient: FeedRoutes {
    public func feedCapabilities() async throws -> FeedCapabilities {
        FeedCapabilities(health: try await decode(JSONValue.self, "GET", "/v0/health"))
    }

    public func feed(before: String?, limit: Int, subjects: [String]?) async throws -> FeedPage {
        var query = ["limit=\(max(1, min(200, limit)))"]
        if let before { query.append("before=\(Self.escape(before))") }
        if let subjects { query.append("subjects=\(subjects.map(Self.escape).joined(separator: ","))") }
        return try await decode(FeedPage.self, "GET", "/v0/feed?" + query.joined(separator: "&"))
    }

    public func markFeedSeen(_ subject: FeedSubject, through: String?, mutationId: String) async throws -> FeedSeenAnswer {
        var entry: [String: JSONValue] = ["type": .string(subject.type), "id": .string(subject.id)]
        if let through { entry["through"] = .string(through) }
        return try await decode(FeedSeenAnswer.self, "POST", "/v0/feed/seen", json: .object([
            "subjects": .array([.object(entry)]), "mutationId": .string(mutationId),
        ]))
    }

    public func markFeedReadAll(through: String?, subjects: [String]?, mutationId: String) async throws -> Int {
        struct Answer: Decodable { var unread: Int? }
        var body: [String: JSONValue] = ["mutationId": .string(mutationId)]
        if let through { body["through"] = .string(through) }
        if let subjects { body["subjects"] = .array(subjects.map(JSONValue.string)) }
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
