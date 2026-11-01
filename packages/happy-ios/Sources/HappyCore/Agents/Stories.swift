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

    public struct Round: Equatable, Sendable, Decodable { public var size: Int? }
    public struct Reply: Equatable, Sendable, Decodable {
        public var id: String, userId: String?, text: String, createdAt: Double
    }

    public var id: String
    /// The agent that posted it, or whose story a person reposted.
    public var agentId: String?
    /// Exactly one of these is set: whose row wears the story, or whose story was reposted.
    public var taskId: String?
    public var botId: String?
    /// "person" for a person's repost; an agent's own otherwise.
    public var poster: String?
    /// The reposter; nil for an agent's story, or for the person on a computer that is theirs alone.
    public var userId: String?
    /// The reposter's round video, over the reposted media.
    public var round: Round?
    public var caption: String?
    public var media: Media
    public var postedAt: Double
    public var expiresAt: Double
    public var seen: Bool
    public var replyCount: Int?
    /// The last two, oldest first.
    public var replies: [Reply]?
    public var canDelete: Bool?

    public var isVideo: Bool { media.kind == "video" }
    public var isRepost: Bool { poster == "person" }

    /// Whether `row`'s (a task's or bot's) icon wears this story: its agent's own, not a repost.
    public func belongs(to row: Row) -> Bool {
        switch row.targetKind {
        case "task": !isRepost && taskId != nil && taskId == row.targetId
        case "bot": !isRepost && botId != nil && botId == row.targetId
        default: false
        }
    }
}

/// One tile of the stories row: an agent's stories, or one person's reposts.
public struct StoryPoster: Equatable, Sendable {
    public var id: String
    public var person: Bool
    /// The person reading; their name is theirs to know.
    public var me: Bool
    public var name: String
    public var mark: Row.Mark
    /// Oldest first.
    public var stories: [Story]
    public var unseen: Bool { stories.contains { !$0.seen } }
}

/// The outline a row's icon wears: unseen while any of its stories is.
public enum StoryRing: Equatable, Sendable {
    case unseen, seen
}

public enum Stories {
    /// The user setting that turns stories on; only the JSON `true` does.
    public static let settingKey = "stories"
    public static let roundLimit = 16 << 20

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

    /// `stories` (oldest first) by poster for the row, unseen posters first:
    /// an agent named and drawn as its row is, a person by their photo.
    public static func posters(_ stories: [Story], rows: [Row], users: [String: TeamUser], profile: DesktopSnapshot.Profile?) -> [StoryPoster] {
        var posters: [StoryPoster] = []
        for story in stories {
            let person = story.isRepost ? story.userId ?? profile?.userId : nil
            let id = story.isRepost ? "person:\(person ?? "")" : "agent:\(story.agentId ?? story.taskId ?? story.botId ?? "")"
            if let index = posters.firstIndex(where: { $0.id == id }) { posters[index].stories.append(story); continue }
            var poster = StoryPoster(id: id, person: story.isRepost, me: story.isRepost && person == profile?.userId, name: "", mark: .placeholder(seed: id), stories: [story])
            if let person {
                let photo = poster.me ? profile?.photo : users[person]?.photo
                poster.name = users[person]?.name ?? ""
                if let photo { poster.mark = .image(path: TeamUser.photoPath(person), thumbhash: photo.thumbhash) }
            } else if let row = rows.first(where: story.belongs) {
                (poster.name, poster.mark) = (row.label, row.mark)
            }
            posters.append(poster)
        }
        return posters.filter(\.unseen) + posters.filter { !$0.unseen }
    }

    /// The people stories name (reposters, repliers) for `readAuthors` to read.
    static func people(_ stories: [Story]) -> Set<String> {
        Set(stories.flatMap { [$0.userId] + ($0.replies ?? []).map(\.userId) }.compactMap { $0 })
    }
}

extension AgentClient {
    public func stories() async throws -> [Story] {
        Stories.decode(feed: try await send("GET", "/v0/stories").body)
    }

    public func markStorySeen(_ storyId: String) async throws {
        _ = try await send("POST", "/v0/stories/\(Self.escape(storyId))/seen", json: .object([:]))
    }

    /// A story's bytes (`media`, or a repost's `round`), whole or one range of them.
    public func storyMedia(_ storyId: String, range: ClosedRange<Int>? = nil, part: String = "media") async throws -> HTTP1Response {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/stories/\(Self.escape(storyId))/\(part)", headers: headers)
    }

    /// Where a story's bytes come from, a range at a time (`MediaDownloads`);
    /// an empty file or range asks for nothing.
    public func storySource(_ story: Story, round: Bool = false) -> MediaSource {
        let size = round ? story.round?.size : story.media.size
        return MediaSource(length: size.flatMap { $0 > 0 ? $0 : nil }) { [self] range in
            guard !range.isEmpty else { return MediaPiece(offset: range.lowerBound, data: Data(), total: size) }
            let response = try await storyMedia(story.id, range: range.lowerBound...(range.upperBound - 1), part: round ? "round" : "media")
            return try MediaPiece.http(status: response.status, headers: response.headers, body: response.body)
        }
    }

    /// Every reply, oldest first.
    public func storyReplies(_ storyId: String) async throws -> [Story.Reply] {
        struct Answer: Decodable { let replies: [Story.Reply] }
        return try await decode(Answer.self, "GET", "/v0/stories/\(Self.escape(storyId))/replies").replies
    }

    /// Lands in the poster's agent's chat, quoting the story.
    public func replyToStory(_ storyId: String, text: String) async throws -> Story.Reply {
        struct Answer: Decodable { let reply: Story.Reply }
        return try await decode(Answer.self, "POST", "/v0/stories/\(Self.escape(storyId))/replies", json: .object(["text": .string(text)])).reply
    }

    /// `round`: an H.264 MP4 of the reposter, validated before encoding off main.
    public func repostStory(_ storyId: String, caption: String?, round: Data?) async throws {
        guard (round?.count ?? 0) <= Stories.roundLimit else { throw AgentClientError.status(413, code: "round_too_large", message: nil) }
        var body: [String: JSONValue] = [:]
        if let caption, !caption.isEmpty { body["caption"] = .string(caption) }
        if let round { body["round"] = .object(["data": .string(round.base64EncodedString())]) }
        _ = try await send("POST", "/v0/stories/\(Self.escape(storyId))/repost", json: .object(body))
    }

    public func deleteStory(_ storyId: String) async throws {
        _ = try await send("DELETE", "/v0/stories/\(Self.escape(storyId))")
    }
}
