import Foundation
import HappyWire

/// A story as a protocol-34 daemon serves it (API.md "Stories"), only what
/// is read here: one frame, posted by an agent or reposted by a person.
/// `StoryArtifacts` maps it onto what the Stories screens already draw.
public struct StoryArtifact: Equatable, Sendable, Decodable {
    public struct Poster: Equatable, Sendable, Decodable {
        public var kind: String
        /// `name` from daemons that send it.
        public var agentId, botId, userId, name: String?
    }
    public struct Media: Equatable, Sendable, Decodable {
        public var artifactId, path: String?
        public var version: Int?
    }
    public struct File: Equatable, Sendable, Decodable { public var path: String }
    public struct Seen: Equatable, Sendable, Decodable { public var userId: String? }
    public var artifactId: String
    public var artifactVersion: Int
    public var poster: Poster
    public var replyAgentId, caption: String?
    public var media: Media
    /// A repost's round video, a file of the story's own.
    public var round: File?
    /// The reposted story's `artifactId`.
    @Lenient public var repostOf: String?
    public var postedAt: Int64
    public var expiresAt, endedAt: Int64?
    /// `live`, or ended (`replaced`, `taken_down`, `expired`).
    public var state: String
    public var seenBy: [Seen]
}

public enum StoryArtifacts {
    /// Every story artifact's version: one copy is as new as another, so the latest read wins.
    public static let version = "story-artifact"

    public static func story(_ story: StoryArtifact, me: String?) -> Story {
        let agentId = story.poster.kind == "agent" ? story.poster.agentId : nil
        let path = story.media.path ?? "", own = { StoryAsset.storyFile(artifactId: story.artifactId, version: story.artifactVersion, path: $0, own: true) }
        // Another artifact's entry is shown as the page it is; a file, as a picture or a recording.
        let asset: StoryAsset = if let id = story.media.artifactId, let version = story.media.version {
            story.media.path == nil ? .artifact(artifactId: id, version: version) : .storyFile(artifactId: id, version: version, path: path, own: false)
        } else { own(path) }
        let video = ["mp4", "mov", "m4v", "webm"].contains((path as NSString).pathExtension.lowercased())
        let kind: StoryFrame.Kind = if case .artifact = asset { .artifact } else { video ? .video : .image }
        let round = story.round.map { StoryOverlay.roundVideo(id: "round", media: .file(own($0.path)), durationMs: 0, mirrored: nil, transform: StoryTransform(x: 0.27, y: 0.72, scale: 0.42, rotation: 0)) }
        let frame = StoryFrame(id: "media", kind: kind, width: nil, height: nil, thumbhash: nil, durationMs: nil, asset: asset, available: true, overlays: round.map { [$0] } ?? [])
        let creator: StoryCreator = agentId.map { .agent(agentId: $0) } ?? .user(userId: story.poster.userId)
        return Story(
            id: story.artifactId, status: story.state == "taken_down" ? .deleted : .posted, authorUserId: agentId == nil ? story.poster.userId : nil, createdBy: creator,
            source: story.replyAgentId.map { StorySource(agentId: $0, toolCallId: "") }, caption: story.caption, frames: [frame],
            artifactVersion: story.artifactVersion, createdAt: story.postedAt, updatedAt: story.endedAt ?? story.postedAt, postedAt: story.postedAt,
            expiresAt: story.expiresAt, seen: story.seenBy.contains { $0.userId == me }, viewCount: nil, myReaction: nil, reactions: [],
            version: version, author: agentId.map { .agent(agentId: $0) } ?? .user(userId: story.poster.userId), ringAgentId: agentId, endedAt: story.state == "live" ? nil : story.endedAt ?? story.postedAt, repostOf: nil
        )
    }

    /// One circle per poster (an agent's is also its ring), its live stories oldest first: people,
    /// bots, then tasks, each something new first, then newest. Unnamed, whoever draws it names it.
    public static func feed(_ stories: [StoryArtifact], me: String?, cursor: String) -> StoryFeed {
        var feed = StoryFeed(authors: [], rings: [], stories: [:], cursor: cursor)
        var circles: [String: [(poster: StoryArtifact.Poster, story: Story)]] = [:]
        for wire in stories.sorted(by: { $0.postedAt < $1.postedAt }) where wire.state == "live" {
            var story = Self.story(wire, me: me)
            // A repost names the story it reposts, by its poster, when that is here to read.
            if let original = stories.first(where: { $0.artifactId == wire.repostOf }) {
                story.repostOf = StoryRepostOf(storyId: original.artifactId, agentId: original.poster.agentId ?? "", title: original.poster.name, canOpen: original.poster.agentId != nil)
            }
            feed.stories[story.id] = story
            circles[story.ringAgentId.map { StoriesRow.ringPrefix + $0 } ?? wire.poster.userId ?? "", default: []].append((wire.poster, story))
        }
        func rank(_ circle: [(poster: StoryArtifact.Poster, story: Story)]) -> (Int, Int, Int64) {
            let poster = circle[0].poster
            return (poster.kind != "agent" ? 0 : poster.botId != nil ? 1 : 2, circle.allSatisfy(\.story.seen) ? 1 : 0, -(circle.last?.story.postedAt ?? 0))
        }
        let order = circles.sorted { a, b in rank(a.value) != rank(b.value) ? rank(a.value) < rank(b.value) : a.key < b.key }
        for (_, circle) in order {
            let list = circle.map(\.story), poster = circle[circle.count - 1].poster
            let ids = list.map(\.id), unseen = list.filter { !$0.seen }.count, latest = list.last?.postedAt
            if let agentId = list[0].ringAgentId {
                let ring = StoryRing(agentId: agentId, storyIds: ids, unseenCount: unseen, latestPostedAt: latest)
                feed.rings?.append(ring)
                var author = StoriesRow.ringAuthor(ring, name: poster.name ?? "")
                // A bot wears its avatar, as its row does.
                author.photo = poster.botId.map { "/v0/bots/\(AgentClient.escape($0))/avatar" }
                feed.authors.append(author)
            } else {
                let mine = list[0].authorUserId == me
                feed.authors.append(StoryFeedAuthor(userId: list[0].authorUserId, name: poster.name ?? "", photo: nil, thumbhash: nil, isSelf: mine, storyIds: ids,
                                                    unseenCount: mine ? 0 : unseen, draftCount: nil, latestPostedAt: latest))
            }
        }
        return feed
    }
}

extension Story {
    /// Read from `/v0/stories`: no reactions, views or reposts from here.
    public var isArtifact: Bool { version == StoryArtifacts.version }
}

/// One reply to a story: a person's message to the agent replies go to.
public struct StoryReply: Equatable, Sendable {
    public var userId: String?
    public var text: String
    public var createdAt: Int64
}

/// The `/v0/stories` routes of a daemon with `capabilities.storyArtifacts`.
extension AgentClient {
    public func storyArtifacts() async throws -> (stories: [StoryArtifact], cursor: String) {
        struct Response: Decodable { let stories: [StoryArtifact]; let cursor: String? }
        let response = try await decode(Response.self, "GET", "/v0/stories?scope=feed")
        return (response.stories, response.cursor ?? "")
    }

    public func markStoryArtifactSeen(_ artifactId: String) async throws {
        _ = try await send("POST", "/v0/stories/\(Self.escape(artifactId))/seen", json: .object(["mutationId": .string(ClientID.make())]))
    }

    public func takeDownStory(_ artifactId: String) async throws {
        _ = try await send("POST", "/v0/stories/\(Self.escape(artifactId))/take-down", json: .object(["mutationId": .string(ClientID.make())]))
    }

    /// A story's replies, newest first; a message without words is left out.
    public func storyReplies(_ artifactId: String) async throws -> [StoryReply] {
        let read = try await decode(JSONValue.self, "GET", "/v0/stories/\(Self.escape(artifactId))/replies")
        return (read["messages"]?.arrayValue ?? []).compactMap { message in
            let text = (message["content"]?.arrayValue ?? []).compactMap { $0["type"] == .string("text") ? $0["text"]?.stringValue : nil }.joined(separator: "\n")
            return text.isEmpty ? nil : StoryReply(userId: message["metadata"]?["userId"]?.stringValue, text: text, createdAt: Int64(message["createdAt"]?.numberValue ?? 0))
        }
    }

    /// The person's own message to the agent replies go to, quoting the story, in that conversation's
    /// mode: one that can't be read fails the reply, and one with no mode takes the default.
    public func replyToStory(_ artifactId: String, agentId: String, text: String, id: String) async throws {
        var mode = try await decode(JSONValue.self, "GET", "/v0/agents/\(Self.escape(agentId))/bootstrap")["mode"] ?? .null
        if mode == .null { mode = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(try await defaultMode())) }
        _ = try await send("POST", "/v0/agents/\(Self.escape(agentId))/send", json: .object([
            "id": .string(id), "text": .string(text), "clientMetadata": .object(["composer": .string("mobile")]), "mode": mode,
            "replyTo": .object(["kind": .string("story"), "artifactId": .string(artifactId)]),
        ]))
    }
}
