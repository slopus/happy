import Foundation
import HappyWire

/// The Happy Agent API's Stories and Stickers shapes (happy-agent `API.md`
/// "Stories" and "Stickers"), ported field for field from
/// `@slopus/happy-agent-client`'s `protocol/stories.ts` and
/// `protocol/stickers.ts`. Fields the TypeScript marks `Nullable` are always
/// written, as `null` when empty; optional ones are left out. An overlay of a
/// type this app does not know is kept as sent, so an edit sends it back.
/// `StoriesWireTests` pins the round trip against the TypeScript schemas.
public enum StoryCanvas {
    public static let width: Double = 1080
    public static let height: Double = 1920
    public static let maxFrames = 10
    public static let maxOverlays = 32
    public static let maxCaption = 1_024
    public static let imageDurationMs = 5_000
    /// An artifact frame's untouched time.
    public static let artifactDurationMs = 10_000
    /// An artifact page's own viewport, in CSS pixels: a frame's is 360 ×
    /// 640, an overlay window's 360 wide.
    public static let pageWidth: Double = 360
    public static let pageHeight: Double = 640
    /// An artifact window's corners, as a fraction of the canvas's width.
    public static let windowRadius: Double = 1.0 / 27
    /// The left and right tenth of an artifact frame still move between frames.
    public static let artifactEdge: Double = 0.1
    public static let maxRoundVideoBytes = 64 * 1024 * 1024
    public static let maxVideoDurationMs = 60_000
    public static let lifetimeMs: Int64 = 24 * 60 * 60 * 1000
}

public enum StoryStatus: String, Codable, Sendable, Equatable {
    case draft, posted, deleted
}

/// The media a frame shows, by identity.
public enum StoryAsset: Equatable, Hashable, Sendable, Codable {
    case chatMedia(agentId: String, toolCallId: String, index: Int)
    case artifactFile(artifactId: String, version: Int, path: String)
    /// An artifact itself, shown live (an `artifact` frame); no version
    /// always shows its latest.
    case artifact(artifactId: String, version: Int?)

    enum CodingKeys: String, CodingKey { case type, agentId, toolCallId, index, artifactId, version, path }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "chat_media":
            self = .chatMedia(agentId: try c.decode(String.self, forKey: .agentId), toolCallId: try c.decode(String.self, forKey: .toolCallId), index: try c.decode(Int.self, forKey: .index))
        case "artifact_file":
            self = .artifactFile(artifactId: try c.decode(String.self, forKey: .artifactId), version: try c.decode(Int.self, forKey: .version), path: try c.decode(String.self, forKey: .path))
        case "artifact":
            self = .artifact(artifactId: try c.decode(String.self, forKey: .artifactId), version: try c.decodeIfPresent(Int.self, forKey: .version))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown asset")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .chatMedia(let agentId, let toolCallId, let index):
            try c.encode("chat_media", forKey: .type); try c.encode(agentId, forKey: .agentId)
            try c.encode(toolCallId, forKey: .toolCallId); try c.encode(index, forKey: .index)
        case .artifactFile(let artifactId, let version, let path):
            try c.encode("artifact_file", forKey: .type); try c.encode(artifactId, forKey: .artifactId)
            try c.encode(version, forKey: .version); try c.encode(path, forKey: .path)
        case .artifact(let artifactId, let version):
            try c.encode("artifact", forKey: .type); try c.encode(artifactId, forKey: .artifactId)
            try c.encodeIfPresent(version, forKey: .version)
        }
    }
}

/// A round video's recording: as read, a file of the story's own artifact;
/// on a write, a new upload instead.
public enum StoryRoundVideoMedia: Equatable, Hashable, Sendable, Codable {
    case file(StoryAsset)
    case upload(uploadId: String, name: String)

    enum CodingKeys: String, CodingKey { case type, uploadId, name }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(String.self, forKey: .type) == "upload" {
            self = .upload(uploadId: try c.decode(String.self, forKey: .uploadId), name: try c.decode(String.self, forKey: .name))
        } else {
            self = .file(try StoryAsset(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .file(let asset): try asset.encode(to: encoder)
        case .upload(let uploadId, let name):
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode("upload", forKey: .type); try c.encode(uploadId, forKey: .uploadId); try c.encode(name, forKey: .name)
        }
    }
}

/// A centre as fractions of the canvas, a size whose meaning depends on what
/// it places, and clockwise rotation in radians.
public struct StoryTransform: Equatable, Hashable, Sendable, Codable {
    public var x: Double
    public var y: Double
    public var scale: Double
    public var rotation: Double

    public static let fitted = StoryTransform(x: 0.5, y: 0.5, scale: 1, rotation: 0)

    public init(x: Double, y: Double, scale: Double, rotation: Double) {
        self.x = x
        self.y = y
        self.scale = scale
        self.rotation = rotation
    }

    /// Inside the ranges the API keeps.
    public var clamped: StoryTransform {
        StoryTransform(x: min(1.5, max(-0.5, x)), y: min(1.5, max(-0.5, y)), scale: min(10, max(0.05, scale)), rotation: min(.pi, max(-.pi, rotation)))
    }
}

public enum StoryTextFont: String, Codable, Sendable, CaseIterable, Equatable {
    case sanFrancisco, typewriter, avenirNext, courierNew, noteworthy, georgia, papyrus, snellRoundhand
}

public enum StoryTextFill: String, Codable, Sendable, CaseIterable, Equatable {
    case regular, filled, semi, stroke, blur
}

public enum StoryTextAlign: String, Codable, Sendable, CaseIterable, Equatable {
    case left, center, right
}

public enum StoryLinkStyle: String, Codable, Sendable, CaseIterable, Equatable {
    case white, black, transparent, blur, custom
}

public struct StoryTextStyle: Equatable, Sendable, Codable {
    public var font: StoryTextFont
    public var fill: StoryTextFill
    public var color: String
    public var align: StoryTextAlign
    /// The fraction of the canvas's width the text wraps at before scaling.
    public var width: Double

    public init(font: StoryTextFont = .sanFrancisco, fill: StoryTextFill = .regular, color: String = "#FFFFFF", align: StoryTextAlign = .center, width: Double = 0.8) {
        self.font = font
        self.fill = fill
        self.color = color
        self.align = align
        self.width = width
    }
}

/// Drawn live over a frame, the last on top.
public enum StoryOverlay: Equatable, Sendable, Codable {
    case text(id: String, text: String, style: StoryTextStyle, transform: StoryTransform)
    /// `label` nil shows the URL's host; `color` only with `custom`.
    case link(id: String, url: String, label: String?, style: StoryLinkStyle, color: String?, transform: StoryTransform)
    case sticker(id: String, packId: String, stickerId: String, transform: StoryTransform)
    case emoji(id: String, emoji: String, transform: StoryTransform)
    case reaction(id: String, emoji: String, dark: Bool?, flipped: Bool?, transform: StoryTransform)
    /// A live window onto an artifact, `aspectRatio` wide over tall; the
    /// scale is the window's width over the canvas's.
    case artifact(id: String, artifactId: String, version: Int?, aspectRatio: Double, transform: StoryTransform)
    /// A round video a person recorded; the scale is its diameter over the
    /// canvas's width.
    case roundVideo(id: String, media: StoryRoundVideoMedia, durationMs: Int, mirrored: Bool?, transform: StoryTransform)
    /// A type this app does not know, kept as sent and never drawn.
    case unknown(JSONValue)

    enum CodingKeys: String, CodingKey { case id, type, text, style, transform, url, label, color, packId, stickerId, emoji, dark, flipped, artifactId, version, aspectRatio, media, durationMs, mirrored }

    /// An artifact window's shape when none is given.
    public static let defaultAspectRatio = 0.8

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        func id() throws -> String { try c.decode(String.self, forKey: .id) }
        func transform() throws -> StoryTransform { try c.decode(StoryTransform.self, forKey: .transform) }
        switch type {
        case "text":
            self = .text(id: try id(), text: try c.decode(String.self, forKey: .text), style: try c.decode(StoryTextStyle.self, forKey: .style), transform: try transform())
        case "link":
            self = .link(id: try id(), url: try c.decode(String.self, forKey: .url), label: try c.decodeIfPresent(String.self, forKey: .label), style: try c.decode(StoryLinkStyle.self, forKey: .style), color: try c.decodeIfPresent(String.self, forKey: .color), transform: try transform())
        case "sticker":
            self = .sticker(id: try id(), packId: try c.decode(String.self, forKey: .packId), stickerId: try c.decode(String.self, forKey: .stickerId), transform: try transform())
        case "emoji":
            self = .emoji(id: try id(), emoji: try c.decode(String.self, forKey: .emoji), transform: try transform())
        case "reaction":
            self = .reaction(id: try id(), emoji: try c.decode(String.self, forKey: .emoji), dark: try c.decodeIfPresent(Bool.self, forKey: .dark), flipped: try c.decodeIfPresent(Bool.self, forKey: .flipped), transform: try transform())
        case "artifact":
            self = .artifact(id: try id(), artifactId: try c.decode(String.self, forKey: .artifactId), version: try c.decodeIfPresent(Int.self, forKey: .version), aspectRatio: try c.decodeIfPresent(Double.self, forKey: .aspectRatio) ?? Self.defaultAspectRatio, transform: try transform())
        case "round_video":
            self = .roundVideo(id: try id(), media: try c.decode(StoryRoundVideoMedia.self, forKey: .media), durationMs: try c.decode(Int.self, forKey: .durationMs), mirrored: try c.decodeIfPresent(Bool.self, forKey: .mirrored), transform: try transform())
        default:
            self = .unknown(try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        if case .unknown(let raw) = self { return try raw.encode(to: encoder) }
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let id, let text, let style, let transform):
            try c.encode(id, forKey: .id); try c.encode("text", forKey: .type); try c.encode(text, forKey: .text)
            try c.encode(style, forKey: .style); try c.encode(transform, forKey: .transform)
        case .link(let id, let url, let label, let style, let color, let transform):
            try c.encode(id, forKey: .id); try c.encode("link", forKey: .type); try c.encode(url, forKey: .url)
            try c.encode(label, forKey: .label); try c.encode(style, forKey: .style)
            try c.encodeIfPresent(color, forKey: .color); try c.encode(transform, forKey: .transform)
        case .sticker(let id, let packId, let stickerId, let transform):
            try c.encode(id, forKey: .id); try c.encode("sticker", forKey: .type); try c.encode(packId, forKey: .packId)
            try c.encode(stickerId, forKey: .stickerId); try c.encode(transform, forKey: .transform)
        case .emoji(let id, let emoji, let transform):
            try c.encode(id, forKey: .id); try c.encode("emoji", forKey: .type); try c.encode(emoji, forKey: .emoji)
            try c.encode(transform, forKey: .transform)
        case .reaction(let id, let emoji, let dark, let flipped, let transform):
            try c.encode(id, forKey: .id); try c.encode("reaction", forKey: .type); try c.encode(emoji, forKey: .emoji)
            try c.encodeIfPresent(dark, forKey: .dark); try c.encodeIfPresent(flipped, forKey: .flipped)
            try c.encode(transform, forKey: .transform)
        case .artifact(let id, let artifactId, let version, let aspectRatio, let transform):
            try c.encode(id, forKey: .id); try c.encode("artifact", forKey: .type); try c.encode(artifactId, forKey: .artifactId)
            try c.encodeIfPresent(version, forKey: .version); try c.encode(aspectRatio, forKey: .aspectRatio)
            try c.encode(transform, forKey: .transform)
        case .roundVideo(let id, let media, let durationMs, let mirrored, let transform):
            try c.encode(id, forKey: .id); try c.encode("round_video", forKey: .type); try c.encode(media, forKey: .media)
            try c.encode(durationMs, forKey: .durationMs); try c.encodeIfPresent(mirrored, forKey: .mirrored)
            try c.encode(transform, forKey: .transform)
        case .unknown:
            break
        }
    }

    /// Its ID; nil for a type this app does not know.
    public var id: String? {
        switch self {
        case .text(let id, _, _, _), .link(let id, _, _, _, _, _), .sticker(let id, _, _, _), .emoji(let id, _, _), .reaction(let id, _, _, _, _),
             .artifact(let id, _, _, _, _), .roundVideo(let id, _, _, _, _): id
        case .unknown(let raw): raw["id"]?.stringValue
        }
    }

    public var transform: StoryTransform? {
        get {
            switch self {
            case .text(_, _, _, let t), .link(_, _, _, _, _, let t), .sticker(_, _, _, let t), .emoji(_, _, let t), .reaction(_, _, _, _, let t),
                 .artifact(_, _, _, _, let t), .roundVideo(_, _, _, _, let t): t
            case .unknown: nil
            }
        }
        set {
            guard let t = newValue else { return }
            switch self {
            case .text(let id, let text, let style, _): self = .text(id: id, text: text, style: style, transform: t)
            case .link(let id, let url, let label, let style, let color, _): self = .link(id: id, url: url, label: label, style: style, color: color, transform: t)
            case .sticker(let id, let packId, let stickerId, _): self = .sticker(id: id, packId: packId, stickerId: stickerId, transform: t)
            case .emoji(let id, let emoji, _): self = .emoji(id: id, emoji: emoji, transform: t)
            case .reaction(let id, let emoji, let dark, let flipped, _): self = .reaction(id: id, emoji: emoji, dark: dark, flipped: flipped, transform: t)
            case .artifact(let id, let artifactId, let version, let aspectRatio, _): self = .artifact(id: id, artifactId: artifactId, version: version, aspectRatio: aspectRatio, transform: t)
            case .roundVideo(let id, let media, let durationMs, let mirrored, _): self = .roundVideo(id: id, media: media, durationMs: durationMs, mirrored: mirrored, transform: t)
            case .unknown: break
            }
        }
    }
}

public struct StoryFrame: Equatable, Sendable, Codable, Identifiable {
    /// `artifact`: a live page filling the canvas (`StoryAsset.artifact`).
    public enum Kind: String, Codable, Sendable, Equatable { case image, video, artifact }

    public var id: String
    public var kind: Kind
    /// Pixels after EXIF orientation; nil for a video not yet measured.
    public var width: Int?
    public var height: Int?
    /// Pixels per point; absent means 1.
    public var scale: Double?
    public var thumbhash: String?
    public var durationMs: Int?
    public var asset: StoryAsset
    public var available: Bool
    public var placement: StoryTransform
    /// Two `#RRGGBB` colours, top to bottom.
    public var background: [String]
    public var overlays: [StoryOverlay]

    public init(id: String, kind: Kind, width: Int?, height: Int?, scale: Double? = nil, thumbhash: String?, durationMs: Int?, asset: StoryAsset, available: Bool, placement: StoryTransform = .fitted, background: [String] = ["#000000", "#000000"], overlays: [StoryOverlay] = []) {
        self.id = id
        self.kind = kind
        self.width = width
        self.height = height
        self.scale = scale
        self.thumbhash = thumbhash
        self.durationMs = durationMs
        self.asset = asset
        self.available = available
        self.placement = placement
        self.background = background
        self.overlays = overlays
    }

    enum CodingKeys: String, CodingKey { case id, kind, width, height, scale, thumbhash, durationMs, asset, available, placement, background, overlays }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        height = try c.decodeIfPresent(Int.self, forKey: .height)
        scale = try c.decodeIfPresent(Double.self, forKey: .scale)
        thumbhash = try c.decodeIfPresent(String.self, forKey: .thumbhash)
        durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
        asset = try c.decode(StoryAsset.self, forKey: .asset)
        available = try c.decode(Bool.self, forKey: .available)
        placement = try c.decode(StoryTransform.self, forKey: .placement)
        background = try c.decode([String].self, forKey: .background)
        overlays = try c.decode([StoryOverlay].self, forKey: .overlays)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(kind, forKey: .kind)
        try c.encode(width, forKey: .width); try c.encode(height, forKey: .height)
        try c.encodeIfPresent(scale, forKey: .scale); try c.encode(thumbhash, forKey: .thumbhash)
        try c.encode(durationMs, forKey: .durationMs); try c.encode(asset, forKey: .asset)
        try c.encode(available, forKey: .available); try c.encode(placement, forKey: .placement)
        try c.encode(background, forKey: .background); try c.encode(overlays, forKey: .overlays)
    }

    /// How long the viewer shows it: five seconds for an image, ten of
    /// untouched time for a live page, a video's length up to a minute
    /// (five seconds while that is unknown), and never less than its round
    /// video plays.
    public var showMs: Int {
        max(ownShowMs, roundVideoMs ?? 0)
    }

    /// Its round video's length, when it has one.
    public var roundVideoMs: Int? {
        overlays.lazy.compactMap { overlay -> Int? in
            if case .roundVideo(_, _, let durationMs, _, _) = overlay { return min(durationMs, StoryCanvas.maxVideoDurationMs) }
            return nil
        }.first
    }

    private var ownShowMs: Int {
        if kind == .artifact { return StoryCanvas.artifactDurationMs }
        guard kind == .video, let durationMs, durationMs > 0 else { return StoryCanvas.imageDurationMs }
        return min(durationMs, StoryCanvas.maxVideoDurationMs)
    }
}

public enum StoryCreator: Equatable, Sendable, Codable {
    case user(userId: String?)
    case agent(agentId: String)

    enum CodingKeys: String, CodingKey { case kind, userId, agentId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "agent": self = .agent(agentId: try c.decode(String.self, forKey: .agentId))
        default: self = .user(userId: try c.decodeIfPresent(String.self, forKey: .userId))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let userId): try c.encode("user", forKey: .kind); try c.encode(userId, forKey: .userId)
        case .agent(let agentId): try c.encode("agent", forKey: .kind); try c.encode(agentId, forKey: .agentId)
        }
    }
}

public struct StoryReactionCount: Equatable, Hashable, Sendable, Codable {
    public var emoji: String
    public var count: Int
    public init(emoji: String, count: Int) { self.emoji = emoji; self.count = count }
}

public struct StorySource: Equatable, Sendable, Codable {
    public var agentId: String
    public var toolCallId: String

    public init(agentId: String, toolCallId: String) {
        self.agentId = agentId
        self.toolCallId = toolCallId
    }
}

/// Whose story it is to its viewers: a person's, or an agent's, which lives
/// in that agent's ring and never in the people row.
public enum StoryAuthor: Equatable, Sendable, Codable {
    case user(userId: String?)
    case agent(agentId: String)

    enum CodingKeys: String, CodingKey { case kind, userId, agentId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "agent": self = .agent(agentId: try c.decode(String.self, forKey: .agentId))
        default: self = .user(userId: try c.decodeIfPresent(String.self, forKey: .userId))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let userId): try c.encode("user", forKey: .kind); try c.encode(userId, forKey: .userId)
        case .agent(let agentId): try c.encode("agent", forKey: .kind); try c.encode(agentId, forKey: .agentId)
        }
    }

    public var agentId: String? { if case .agent(let id) = self { id } else { nil } }
}

/// The agent's story a repost was made from: the chip that reads
/// "Reposted from <title>", which opens it when `canOpen`.
public struct StoryRepostOf: Equatable, Sendable, Codable {
    public var storyId: String
    public var agentId: String
    public var title: String?
    public var canOpen: Bool

    public init(storyId: String, agentId: String, title: String?, canOpen: Bool) {
        self.storyId = storyId
        self.agentId = agentId
        self.title = title
        self.canOpen = canOpen
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(storyId, forKey: .storyId); try c.encode(agentId, forKey: .agentId)
        try c.encode(title, forKey: .title); try c.encode(canOpen, forKey: .canOpen)
    }
}

/// The story object, from the caller's view.
public struct Story: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var status: StoryStatus
    public var authorUserId: String?
    public var createdBy: StoryCreator
    public var source: StorySource?
    public var caption: String?
    public var frames: [StoryFrame]
    public var audience: String
    public var artifactVersion: Int
    public var createdAt: Int64
    public var updatedAt: Int64
    public var postedAt: Int64?
    public var expiresAt: Int64?
    public var seen: Bool
    public var viewCount: Int?
    public var myReaction: String?
    public var reactions: [StoryReactionCount]
    public var version: String
    /// From daemons with agent stories: whose story it is (nil from older ones).
    public var author: StoryAuthor?
    /// An agent's story: the agent whose row wears it.
    public var ringAgentId: String?
    public var supersedes: [String]?
    /// When an agent's story left its ring, and why.
    public var endedAt: Int64?
    public var endReason: String?
    public var repostOf: StoryRepostOf?

    public init(id: String, status: StoryStatus, authorUserId: String?, createdBy: StoryCreator, source: StorySource? = nil, caption: String?, frames: [StoryFrame], audience: String = "self", artifactVersion: Int, createdAt: Int64, updatedAt: Int64, postedAt: Int64?, expiresAt: Int64?, seen: Bool, viewCount: Int?, myReaction: String?, reactions: [StoryReactionCount], version: String, author: StoryAuthor? = nil, ringAgentId: String? = nil, supersedes: [String]? = nil, endedAt: Int64? = nil, endReason: String? = nil, repostOf: StoryRepostOf? = nil) {
        self.id = id
        self.status = status
        self.authorUserId = authorUserId
        self.createdBy = createdBy
        self.source = source
        self.caption = caption
        self.frames = frames
        self.audience = audience
        self.artifactVersion = artifactVersion
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.postedAt = postedAt
        self.expiresAt = expiresAt
        self.seen = seen
        self.viewCount = viewCount
        self.myReaction = myReaction
        self.reactions = reactions
        self.version = version
        self.author = author
        self.ringAgentId = ringAgentId
        self.supersedes = supersedes
        self.endedAt = endedAt
        self.endReason = endReason
        self.repostOf = repostOf
    }

    enum CodingKeys: String, CodingKey { case id, status, authorUserId, createdBy, source, caption, frames, audience, artifactVersion, createdAt, updatedAt, postedAt, expiresAt, seen, viewCount, myReaction, reactions, version, author, ringAgentId, supersedes, endedAt, endReason, repostOf }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decode(StoryStatus.self, forKey: .status)
        authorUserId = try c.decodeIfPresent(String.self, forKey: .authorUserId)
        createdBy = try c.decode(StoryCreator.self, forKey: .createdBy)
        source = try c.decodeIfPresent(StorySource.self, forKey: .source)
        caption = try c.decodeIfPresent(String.self, forKey: .caption)
        frames = try c.decode([StoryFrame].self, forKey: .frames)
        audience = try c.decode(String.self, forKey: .audience)
        artifactVersion = try c.decode(Int.self, forKey: .artifactVersion)
        createdAt = try c.decode(Int64.self, forKey: .createdAt)
        updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        postedAt = try c.decodeIfPresent(Int64.self, forKey: .postedAt)
        expiresAt = try c.decodeIfPresent(Int64.self, forKey: .expiresAt)
        seen = try c.decode(Bool.self, forKey: .seen)
        viewCount = try c.decodeIfPresent(Int.self, forKey: .viewCount)
        myReaction = try c.decodeIfPresent(String.self, forKey: .myReaction)
        reactions = try c.decode([StoryReactionCount].self, forKey: .reactions)
        version = try c.decode(String.self, forKey: .version)
        author = try c.decodeIfPresent(StoryAuthor.self, forKey: .author)
        ringAgentId = try c.decodeIfPresent(String.self, forKey: .ringAgentId)
        supersedes = try c.decodeIfPresent([String].self, forKey: .supersedes)
        endedAt = try c.decodeIfPresent(Int64.self, forKey: .endedAt)
        endReason = try c.decodeIfPresent(String.self, forKey: .endReason)
        repostOf = try c.decodeIfPresent(StoryRepostOf.self, forKey: .repostOf)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(status, forKey: .status)
        try c.encode(authorUserId, forKey: .authorUserId); try c.encode(createdBy, forKey: .createdBy)
        try c.encode(source, forKey: .source); try c.encode(caption, forKey: .caption)
        try c.encode(frames, forKey: .frames); try c.encode(audience, forKey: .audience)
        try c.encode(artifactVersion, forKey: .artifactVersion); try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt); try c.encode(postedAt, forKey: .postedAt)
        try c.encode(expiresAt, forKey: .expiresAt); try c.encode(seen, forKey: .seen)
        try c.encode(viewCount, forKey: .viewCount); try c.encode(myReaction, forKey: .myReaction)
        try c.encode(reactions, forKey: .reactions); try c.encode(version, forKey: .version)
        // Written as an agent-stories daemon writes them, left out as an older one does.
        if author != nil || ringAgentId != nil || supersedes != nil || endedAt != nil || endReason != nil || repostOf != nil {
            try c.encode(author, forKey: .author); try c.encode(ringAgentId, forKey: .ringAgentId)
            try c.encode(supersedes ?? [], forKey: .supersedes); try c.encode(endedAt, forKey: .endedAt)
            try c.encode(endReason, forKey: .endReason); try c.encode(repostOf, forKey: .repostOf)
        }
    }

    /// An agent's story: in a ring, never the people row.
    public var isAgents: Bool { author?.agentId != nil }

    /// Whether the person may react: a posted story of someone else's.
    public func reactable(isOwn: Bool) -> Bool { status == .posted && !isOwn }
}

/// One circle of the stories row.
public struct StoryFeedAuthor: Equatable, Sendable, Codable {
    public var userId: String?
    public var name: String
    public var photo: String?
    public var thumbhash: String?
    public var isSelf: Bool
    /// Posted, unexpired stories, oldest first.
    public var storyIds: [String]
    public var unseenCount: Int
    public var draftCount: Int?
    public var latestPostedAt: Int64?

    public init(userId: String?, name: String, photo: String?, thumbhash: String?, isSelf: Bool, storyIds: [String], unseenCount: Int, draftCount: Int?, latestPostedAt: Int64?) {
        self.userId = userId
        self.name = name
        self.photo = photo
        self.thumbhash = thumbhash
        self.isSelf = isSelf
        self.storyIds = storyIds
        self.unseenCount = unseenCount
        self.draftCount = draftCount
        self.latestPostedAt = latestPostedAt
    }

    enum CodingKeys: String, CodingKey { case userId, name, photo, thumbhash, isSelf, storyIds, unseenCount, draftCount, latestPostedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        name = try c.decode(String.self, forKey: .name)
        photo = try c.decodeIfPresent(String.self, forKey: .photo)
        thumbhash = try c.decodeIfPresent(String.self, forKey: .thumbhash)
        isSelf = try c.decode(Bool.self, forKey: .isSelf)
        storyIds = try c.decode([String].self, forKey: .storyIds)
        unseenCount = try c.decode(Int.self, forKey: .unseenCount)
        draftCount = try c.decodeIfPresent(Int.self, forKey: .draftCount)
        latestPostedAt = try c.decodeIfPresent(Int64.self, forKey: .latestPostedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(userId, forKey: .userId); try c.encode(name, forKey: .name)
        try c.encode(photo, forKey: .photo); try c.encode(thumbhash, forKey: .thumbhash)
        try c.encode(isSelf, forKey: .isSelf); try c.encode(storyIds, forKey: .storyIds)
        try c.encode(unseenCount, forKey: .unseenCount); try c.encode(draftCount, forKey: .draftCount)
        try c.encode(latestPostedAt, forKey: .latestPostedAt)
    }

    /// Its circle's key in the row: the user, or the one person.
    public var key: String { isSelf ? "self" : (userId ?? "self") }

    /// An agent's ring played as an author (`StoriesRow.ringAuthor`): its agent.
    public var ringAgentId: String? {
        guard let userId, userId.hasPrefix(StoriesRow.ringPrefix) else { return nil }
        return String(userId.dropFirst(StoriesRow.ringPrefix.count))
    }
}

/// One sidebar row's ring: an agent's live stories, oldest first, and
/// those its subtasks posted.
public struct StoryRing: Equatable, Sendable, Codable {
    /// The row's agent: a task's or bot's own, matched to its `target.agentId`.
    public var agentId: String
    public var storyIds: [String]
    public var unseenCount: Int
    public var latestPostedAt: Int64?

    public init(agentId: String, storyIds: [String], unseenCount: Int, latestPostedAt: Int64?) {
        self.agentId = agentId
        self.storyIds = storyIds
        self.unseenCount = unseenCount
        self.latestPostedAt = latestPostedAt
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(agentId, forKey: .agentId); try c.encode(storyIds, forKey: .storyIds)
        try c.encode(unseenCount, forKey: .unseenCount); try c.encode(latestPostedAt, forKey: .latestPostedAt)
    }
}

/// `GET /v0/stories/feed`: the row in the order it is shown.
public struct StoryFeed: Equatable, Sendable, Codable {
    public var authors: [StoryFeedAuthor]
    /// Agents' rings, newest first; nil from a daemon without agent stories.
    public var rings: [StoryRing]?
    public var stories: [String: Story]
    public var cursor: String

    public init(authors: [StoryFeedAuthor], rings: [StoryRing]? = nil, stories: [String: Story], cursor: String) {
        self.authors = authors
        self.rings = rings
        self.stories = stories
        self.cursor = cursor
    }

    enum CodingKeys: String, CodingKey { case authors, rings, stories, cursor }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(authors, forKey: .authors)
        try c.encodeIfPresent(rings, forKey: .rings)
        try c.encode(stories, forKey: .stories)
        try c.encode(cursor, forKey: .cursor)
    }
}

public struct StoriesPage: Equatable, Sendable, Codable {
    public var stories: [Story]
    public var nextCursor: String?
    public var cursor: String

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(stories, forKey: .stories); try c.encode(nextCursor, forKey: .nextCursor); try c.encode(cursor, forKey: .cursor)
    }
}

/// One image or video a conversation presented.
public struct StoryMediaItem: Equatable, Sendable, Codable {
    public enum Kind: String, Codable, Sendable, Equatable { case image, video }
    public var asset: StoryAsset
    public var kind: Kind
    public var name: String
    public var width: Int?
    public var height: Int?
    public var scale: Double?
    public var thumbhash: String?
    public var createdAt: Int64

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(asset, forKey: .asset); try c.encode(kind, forKey: .kind); try c.encode(name, forKey: .name)
        try c.encode(width, forKey: .width); try c.encode(height, forKey: .height)
        try c.encodeIfPresent(scale, forKey: .scale); try c.encode(thumbhash, forKey: .thumbhash)
        try c.encode(createdAt, forKey: .createdAt)
    }
}

public struct StoryMediaPage: Equatable, Sendable, Codable {
    public var items: [StoryMediaItem]
    public var nextCursor: String?

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(items, forKey: .items); try c.encode(nextCursor, forKey: .nextCursor)
    }
}

/// One person who saw the author's story.
public struct StoryViewer: Equatable, Sendable, Codable {
    public var userId: String
    public var name: String
    public var photo: String?
    public var thumbhash: String?
    public var reaction: String?
    public var reactedAt: Int64?

    public init(userId: String, name: String, photo: String?, thumbhash: String?, reaction: String?, reactedAt: Int64?) {
        self.userId = userId
        self.name = name
        self.photo = photo
        self.thumbhash = thumbhash
        self.reaction = reaction
        self.reactedAt = reactedAt
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(userId, forKey: .userId); try c.encode(name, forKey: .name)
        try c.encode(photo, forKey: .photo); try c.encode(thumbhash, forKey: .thumbhash)
        try c.encode(reaction, forKey: .reaction); try c.encode(reactedAt, forKey: .reactedAt)
    }
}

public struct StoryViewersPage: Equatable, Sendable, Codable {
    public var viewers: [StoryViewer]
    public var nextCursor: String?

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(viewers, forKey: .viewers); try c.encode(nextCursor, forKey: .nextCursor)
    }
}

/// A frame in a write: new media from an upload or an asset, or on `PATCH`
/// an existing frame's `id` alone, keeping its media.
public struct StoryFrameInput: Equatable, Sendable, Encodable {
    public enum Media: Equatable, Sendable {
        case upload(uploadId: String, name: String)
        case asset(StoryAsset)
        case keep
    }

    public var id: String?
    public var media: Media
    public var placement: StoryTransform?
    public var background: [String]?
    public var overlays: [StoryOverlay]?

    public init(id: String?, media: Media, placement: StoryTransform? = nil, background: [String]? = nil, overlays: [StoryOverlay]? = nil) {
        self.id = id
        self.media = media
        self.placement = placement
        self.background = background
        self.overlays = overlays
    }

    enum CodingKeys: String, CodingKey { case id, upload, asset, placement, background, overlays }
    enum UploadKeys: String, CodingKey { case uploadId, name }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(id, forKey: .id)
        switch media {
        case .upload(let uploadId, let name):
            var upload = c.nestedContainer(keyedBy: UploadKeys.self, forKey: .upload)
            try upload.encode(uploadId, forKey: .uploadId); try upload.encode(name, forKey: .name)
        case .asset(let asset):
            try c.encode(asset, forKey: .asset)
        case .keep:
            break
        }
        try c.encodeIfPresent(placement, forKey: .placement)
        try c.encodeIfPresent(background, forKey: .background)
        try c.encodeIfPresent(overlays, forKey: .overlays)
    }

    /// An existing frame as an edit sends it back: its media kept, the rest as it now is.
    public static func keeping(_ frame: StoryFrame) -> StoryFrameInput {
        StoryFrameInput(id: frame.id, media: .keep, placement: frame.placement, background: frame.background, overlays: frame.overlays)
    }
}

// MARK: Stickers

public enum StickerPackKind: String, Codable, Sendable, Equatable { case stickers, emoji }

public enum StickerFormat: String, Codable, Sendable, Equatable { case webp, tgs, webm }

/// The picker's grid: at least `minColumns`, and as many `cellSize` cells as fit.
public enum StickerGrid {
    public static func columns(_ kind: StickerPackKind, width: Double, spacing: Double) -> Int {
        let (minColumns, cell): (Int, Double) = kind == .stickers ? (5, 70) : (8, 40)
        return max(minColumns, Int(((width + spacing) / (cell + spacing)).rounded(.down)))
    }
}

public struct StickerPack: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var title: String
    public var kind: StickerPackKind
    public var thumbnail: String
    public var stickerCount: Int
    public var version: String

    public init(id: String, title: String, kind: StickerPackKind, thumbnail: String, stickerCount: Int, version: String) {
        self.id = id
        self.title = title
        self.kind = kind
        self.thumbnail = thumbnail
        self.stickerCount = stickerCount
        self.version = version
    }
}

public struct Sticker: Equatable, Hashable, Sendable, Codable {
    public var packId: String
    public var id: String
    public var emoji: [String]
    public var format: StickerFormat
    public var width: Int
    public var height: Int
    public var size: Int
    public var sha256: String

    public init(packId: String, id: String, emoji: [String], format: StickerFormat, width: Int, height: Int, size: Int, sha256: String) {
        self.packId = packId
        self.id = id
        self.emoji = emoji
        self.format = format
        self.width = width
        self.height = height
        self.size = size
        self.sha256 = sha256
    }

    public var ref: StickerRef { StickerRef(packId: packId, stickerId: id) }
}

public struct StickerRef: Equatable, Hashable, Sendable, Codable {
    public var packId: String
    public var stickerId: String
    public init(packId: String, stickerId: String) { self.packId = packId; self.stickerId = stickerId }
}

public struct StickerPackContents: Equatable, Sendable, Codable {
    public var pack: StickerPack
    public var stickers: [Sticker]
}

public struct StickerRecents: Equatable, Sendable, Codable {
    public var recents: [StickerRef]
    public var cursor: String?
}
