import Foundation
import HappyWire

/// What a person can be looking at: an agent's conversation or a Surface
/// (happy-agent `API.md`, Viewers).
public enum ViewerTarget: Hashable, Sendable, Codable {
    case agent(String)
    case surface(String)

    private enum CodingKeys: String, CodingKey { case type, id }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        switch try container.decode(String.self, forKey: .type) {
        case "agent": self = .agent(id)
        case "surface": self = .surface(id)
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown viewer target")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .agent(let id): try container.encode("agent", forKey: .type); try container.encode(id, forKey: .id)
        case .surface(let id): try container.encode("surface", forKey: .type); try container.encode(id, forKey: .id)
        }
    }
}

/// Another person who looks, or looked, at a target. `lastSeenAt` is
/// Unix milliseconds; for someone here now it is the server's now.
public struct Viewer: Equatable, Sendable, Codable {
    public var userId: String
    public var here: Bool
    public var lastSeenAt: Double

    public init(userId: String, here: Bool, lastSeenAt: Double) {
        self.userId = userId
        self.here = here
        self.lastSeenAt = lastSeenAt
    }
}

/// How present someone is: here now, gone within ten minutes, or seen
/// some time before.
public enum ViewerTier: Equatable, Sendable {
    case here
    /// Left `minutes` ago, at least 1.
    case recent(minutes: Int)
    case seen
}

public enum ViewerTiers {
    public static let recentWindow: Double = 10 * 60_000
    public static let most = 50

    public static func tier(_ viewer: Viewer, now: Double) -> ViewerTier {
        if viewer.here { return .here }
        let gone = max(0, now - viewer.lastSeenAt)
        guard gone <= recentWindow else { return .seen }
        return .recent(minutes: max(1, Int(gone / 60_000)))
    }

    /// When the next tier or minute badge among `viewers` changes, so a
    /// header recomputes then and not on every frame; nil while nothing
    /// will change without news.
    public static func nextChange(_ viewers: [Viewer], now: Double) -> Double? {
        viewers.compactMap { viewer -> Double? in
            guard case .recent = tier(viewer, now: now) else { return nil }
            let gone = max(0, now - viewer.lastSeenAt)
            let nextMinute = viewer.lastSeenAt + (floor(gone / 60_000) + 1) * 60_000
            return min(nextMinute, viewer.lastSeenAt + recentWindow + 1)
        }.min()
    }

    /// When someone was last here, as their row in the list says it.
    public enum When: Equatable, Sendable {
        case now
        case minutes(Int)
        case hours(Int)
        /// A day before today's last 24 hours.
        case day(Date)
    }

    public static func when(_ viewer: Viewer, now: Double) -> When {
        if viewer.here { return .now }
        let minutes = max(1, Int(max(0, now - viewer.lastSeenAt) / 60_000))
        if minutes < 60 { return .minutes(minutes) }
        if minutes < 24 * 60 { return .hours(minutes / 60) }
        return .day(Date(timeIntervalSince1970: viewer.lastSeenAt / 1000))
    }

    /// The server's order: here first, then the newest.
    public static func ordered(_ viewers: [Viewer]) -> [Viewer] {
        viewers.sorted { a, b in a.here != b.here ? a.here : a.lastSeenAt > b.lastSeenAt }
    }

    /// One `viewers.updated` frame over the list it updates.
    public static func applying(_ viewer: Viewer, to viewers: [Viewer]) -> [Viewer] {
        Array(ordered(viewers.filter { $0.userId != viewer.userId } + [viewer]).prefix(most))
    }
}

/// A `viewers.updated` frame.
public struct ViewersFrame: Equatable, Sendable, Decodable {
    public var target: ViewerTarget
    public var viewer: Viewer
}

extension AgentClient {
    /// Says everything this stream looks at now, replacing what it said
    /// before; answers who else looks at each, in the order asked.
    public func putViewers(streamId: String, targets: [ViewerTarget]) async throws -> [(target: ViewerTarget, viewers: [Viewer])] {
        struct Entry: Decodable { let target: ViewerTarget; let viewers: [Viewer] }
        struct Response: Decodable { let targets: [Entry] }
        let body = JSONValue.object(["targets": .array(targets.map { target in
            switch target {
            case .agent(let id): .object(["type": .string("agent"), "id": .string(id)])
            case .surface(let id): .object(["type": .string("surface"), "id": .string(id)])
            }
        })])
        let response = try await decode(Response.self, "PUT", "/v0/viewers/streams/\(Self.escape(streamId))", json: body)
        return response.targets.map { ($0.target, $0.viewers) }
    }
}
