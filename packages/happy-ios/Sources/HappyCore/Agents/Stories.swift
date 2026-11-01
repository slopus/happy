import Foundation
import HappyWire

/// A picture or short video a task's or bot's agent posted, live for a
/// day (happy-agent `API.md`, "Stories"). Read only while the daemon has
/// `storyFeed` and the person's `stories` setting is on.
public struct Story: Equatable, Sendable, Decodable {
    public struct Media: Equatable, Sendable, Decodable {
        public var kind: String
        public var mimeType: String
        public var size: Int?
    }

    public var id: String
    /// Exactly one of these is set: whose row wears the story.
    public var taskId: String?
    public var botId: String?
    public var caption: String?
    public var media: Media
    public var postedAt: Double
    public var expiresAt: Double
    public var seen: Bool

    public var isVideo: Bool { media.kind == "video" }

    /// Whether `row` (a task's or bot's) wears this story.
    public func belongs(to row: Row) -> Bool {
        switch row.targetKind {
        case "task": taskId != nil && taskId == row.targetId
        case "bot": botId != nil && botId == row.targetId
        default: false
        }
    }
}

/// The outline a row's icon wears: unseen while any of its stories is.
public enum StoryRing: Equatable, Sendable {
    case unseen, seen
}

public enum Stories {
    /// The user setting that turns stories on; only the JSON `true` does.
    public static let settingKey = "stories"

    /// A feed's stories, skipping any this app can't read rather than
    /// failing the rest.
    public static func decode(feed data: Data) -> [Story] {
        struct Lenient: Decodable { let story: Story? ; init(from decoder: Decoder) { story = try? Story(from: decoder) } }
        struct Feed: Decodable { let stories: [Lenient] }
        return (try? JSONDecoder().decode(Feed.self, from: data))?.stories.compactMap(\.story) ?? []
    }

    /// `rows` with each task's and bot's outline from `stories`.
    public static func ring(_ rows: [Row], stories: [Story]) -> [Row] {
        rows.map { row in
            guard row.kind == .space else { return row }
            let own = stories.filter { $0.belongs(to: row) }
            var row = row
            row.story = own.isEmpty ? nil : own.contains { !$0.seen } ? .unseen : .seen
            return row
        }
    }
}

extension AgentClient {
    public func stories() async throws -> [Story] {
        Stories.decode(feed: try await send("GET", "/v0/stories").body)
    }

    public func markStorySeen(_ storyId: String) async throws {
        _ = try await send("POST", "/v0/stories/\(Self.escape(storyId))/seen", json: .object([:]))
    }

    /// A story's bytes, whole or one range of them.
    public func storyMedia(_ storyId: String, range: ClosedRange<Int>? = nil) async throws -> HTTP1Response {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/stories/\(Self.escape(storyId))/media", headers: headers)
    }

    /// Where a story's bytes come from, a range at a time (`MediaDownloads`);
    /// an empty file or range asks for nothing.
    public func storySource(_ story: Story) -> MediaSource {
        MediaSource(length: story.media.size.flatMap { $0 > 0 ? $0 : nil }) { [self] range in
            guard !range.isEmpty else { return MediaPiece(offset: range.lowerBound, data: Data(), total: story.media.size) }
            let response = try await storyMedia(story.id, range: range.lowerBound...(range.upperBound - 1))
            return try MediaPiece.http(status: response.status, headers: response.headers, body: response.body)
        }
    }
}
