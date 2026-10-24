import Foundation
import HappyWire

/// The Stories and Stickers routes (happy-agent `API.md` "Stories",
/// "Stickers"), over the same paired device's tunnel as Stem Cells. Each
/// write carries a fresh `mutationId`, so the store knows its own echo.
extension DirectAgentClient {
    /// The user setting that turns Stories on; only the JSON `true` does.
    public static let storiesSettingKey = "happy-desktop.experiments.stories"

    private func encoded<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    private struct StoryResponse: Decodable { let story: Story }

    // MARK: Reading

    public func storyFeed() async throws -> StoryFeed {
        try await decode(StoryFeed.self, "GET", "/v0/stories/feed")
    }

    public func story(_ storyId: String) async throws -> Story {
        try await decode(StoryResponse.self, "GET", "/v0/stories/\(Self.escape(storyId))").story
    }

    /// The person's own stories, newest first.
    public func ownStories(status: [StoryStatus] = [.draft, .posted], cursor: String? = nil, limit: Int = 50) async throws -> StoriesPage {
        var query = "status=\(status.map(\.rawValue).joined(separator: ","))&limit=\(limit)"
        if let cursor { query += "&cursor=\(Self.escape(cursor))" }
        return try await decode(StoriesPage.self, "GET", "/v0/stories?\(query)")
    }

    /// What one conversation offers to put in a story.
    public func storyMedia(agentId: String, cursor: String? = nil, limit: Int = 30) async throws -> StoryMediaPage {
        var query = "agentId=\(Self.escape(agentId))&limit=\(limit)"
        if let cursor { query += "&cursor=\(Self.escape(cursor))" }
        return try await decode(StoryMediaPage.self, "GET", "/v0/stories/media?\(query)")
    }

    public func storyViewers(_ storyId: String, cursor: String? = nil) async throws -> StoryViewersPage {
        var path = "/v0/stories/\(Self.escape(storyId))/viewers?limit=50"
        if let cursor { path += "&cursor=\(Self.escape(cursor))" }
        return try await decode(StoryViewersPage.self, "GET", path)
    }

    /// A frame's bytes, whole or one range of them.
    public func storyFrame(_ storyId: String, frameId: String, range: ClosedRange<Int>? = nil) async throws -> DirectHTTPResponse {
        let headers = range.map { ["Range": "bytes=\($0.lowerBound)-\($0.upperBound)"] } ?? [:]
        return try await send("GET", "/v0/stories/\(Self.escape(storyId))/frames/\(Self.escape(frameId))", headers: headers)
    }

    // MARK: Writing

    /// Raw bytes for a later story; its ID is used once.
    public func upload(_ data: Data) async throws -> String {
        struct Response: Decodable { struct Upload: Decodable { let id: String }; let upload: Upload }
        let response = try await send("POST", "/v0/artifact-uploads", raw: data)
        guard let upload = try? JSONDecoder().decode(Response.self, from: response.body) else { throw DirectAgentError.invalidResponse }
        return upload.upload.id
    }

    /// A draft by hand; `id` is the retry key.
    public func createStory(id: String, caption: String?, frames: [StoryFrameInput]) async throws -> Story {
        var body: [String: JSONValue] = ["id": .string(id), "frames": try encoded(frames), "mutationId": .string(ClientID.make())]
        if let caption, !caption.isEmpty { body["caption"] = .string(caption) }
        return try await decode(StoryResponse.self, "POST", "/v0/stories", json: .object(body)).story
    }

    /// An edit of the version `version`; `frames` replaces the whole list.
    public func updateStory(_ storyId: String, version: String, caption: String??, frames: [StoryFrameInput]?) async throws -> Story {
        var body: [String: JSONValue] = ["mutationId": .string(ClientID.make())]
        if case .some(let caption) = caption { body["caption"] = caption.flatMap { $0.isEmpty ? nil : JSONValue.string($0) } ?? .null }
        if let frames { body["frames"] = try encoded(frames) }
        let response = try await send("PATCH", "/v0/stories/\(Self.escape(storyId))", json: .object(body), headers: ["If-Match": version])
        guard let story = try? JSONDecoder().decode(StoryResponse.self, from: response.body).story else { throw DirectAgentError.invalidResponse }
        return story
    }

    /// Posts the version the person was looking at.
    public func postStory(_ storyId: String, artifactVersion: Int) async throws -> Story {
        try await decode(StoryResponse.self, "POST", "/v0/stories/\(Self.escape(storyId))/post", json: .object(["artifactVersion": .number(Double(artifactVersion)), "mutationId": .string(ClientID.make())])).story
    }

    public func deleteStory(_ storyId: String, version: String) async throws -> Story {
        let response = try await send("POST", "/v0/stories/\(Self.escape(storyId))/delete", json: .object(["mutationId": .string(ClientID.make())]), headers: ["If-Match": version])
        guard let story = try? JSONDecoder().decode(StoryResponse.self, from: response.body).story else { throw DirectAgentError.invalidResponse }
        return story
    }

    public func markStorySeen(_ storyId: String) async throws -> Story {
        try await decode(StoryResponse.self, "POST", "/v0/stories/\(Self.escape(storyId))/seen", json: .object([:])).story
    }

    /// Sets the person's one reaction, or removes it with nil.
    public func reactToStory(_ storyId: String, emoji: String?) async throws -> Story {
        let path = "/v0/stories/\(Self.escape(storyId))/reaction"
        if let emoji {
            return try await decode(StoryResponse.self, "PUT", path, json: .object(["emoji": .string(emoji), "mutationId": .string(ClientID.make())])).story
        }
        return try await decode(StoryResponse.self, "DELETE", path, json: .object(["mutationId": .string(ClientID.make())])).story
    }

    // MARK: Stickers

    public func stickerPacks() async throws -> [StickerPack] {
        struct Response: Decodable { let packs: [StickerPack] }
        return try await decode(Response.self, "GET", "/v0/stickers/packs").packs
    }

    public func stickerPack(_ packId: String) async throws -> StickerPackContents {
        try await decode(StickerPackContents.self, "GET", "/v0/stickers/packs/\(Self.escape(packId))")
    }

    /// A sticker's file; a `tgs` one as its Lottie JSON with `lottie`.
    public func stickerFile(_ ref: StickerRef, lottie: Bool = false) async throws -> Data {
        try await send("GET", "/v0/stickers/packs/\(Self.escape(ref.packId))/stickers/\(Self.escape(ref.stickerId))/file" + (lottie ? "?as=lottie" : "")).body
    }

    public func searchStickers(query: String? = nil, emoji: String? = nil, kind: StickerPackKind = .stickers) async throws -> [Sticker] {
        struct Response: Decodable { let stickers: [Sticker] }
        var parts = ["kind=\(kind.rawValue)"]
        if let query { parts.append("q=\(Self.escape(query))") }
        if let emoji { parts.append("emoji=\(Self.escape(emoji))") }
        return try await decode(Response.self, "GET", "/v0/stickers/search?" + parts.joined(separator: "&")).stickers
    }

    public func stickerRecents() async throws -> StickerRecents {
        try await decode(StickerRecents.self, "GET", "/v0/stickers/recents")
    }

    public func useSticker(_ ref: StickerRef) async throws -> StickerRecents {
        try await decode(StickerRecents.self, "POST", "/v0/stickers/recents", json: .object(["packId": .string(ref.packId), "stickerId": .string(ref.stickerId), "mutationId": .string(ClientID.make())]))
    }

    public func clearStickerRecents() async throws -> StickerRecents {
        try await decode(StickerRecents.self, "DELETE", "/v0/stickers/recents", json: .object(["mutationId": .string(ClientID.make())]))
    }
}

/// A refusal's details, as the daemon writes them: `{ error, code, story? }`.
public struct StoryRefusal: Equatable, Sendable {
    public var status: Int
    public var code: String?
    public var message: String?

    public init?(_ error: Error) {
        guard case DirectAgentError.status(let status, let code, let message) = error else { return nil }
        self.status = status
        self.code = code
        self.message = message
    }

    /// A stale version: the latest must be shown before trying again.
    public var isConflict: Bool { status == 409 }
}
