import Foundation

/// A story as the editor holds it while the person makes it: its frames,
/// each with media from the device (sent once on save), from a
/// conversation, or kept from the story being edited, and their overlays.
/// Everything the editor changes goes through here, so the limits the API
/// keeps (ten frames, 32 overlays, five reaction bubbles) hold before the
/// daemon is asked.
public struct StoryDraft: Equatable, Sendable {
    public enum Media: Equatable, Sendable {
        /// The frame's media in the story being edited.
        case kept
        /// Media from a conversation, by identity.
        case asset(StoryAsset)
        /// A file from the device, uploaded on save under `name`.
        case local(file: URL, name: String)
    }

    public struct Frame: Equatable, Sendable, Identifiable {
        public var id: String
        public var kind: StoryFrame.Kind
        public var width: Int?
        public var height: Int?
        public var durationMs: Int?
        public var media: Media
        public var placement: StoryTransform
        /// Nil lets the daemon pick it from the picture.
        public var background: [String]?
        public var overlays: [StoryOverlay]

        public init(id: String = ClientID.make(), kind: StoryFrame.Kind, width: Int?, height: Int?, durationMs: Int? = nil, media: Media, placement: StoryTransform = .fitted, background: [String]? = nil, overlays: [StoryOverlay] = []) {
            self.id = id
            self.kind = kind
            self.width = width
            self.height = height
            self.durationMs = durationMs
            self.media = media
            self.placement = placement
            self.background = background
            self.overlays = overlays
        }
    }

    public static let maxReactions = 5

    /// The story's ID: chosen here for a new one, so a retried save never
    /// makes a second story.
    public let storyId: String
    /// The story being edited; nil for a new one.
    public private(set) var original: Story?
    public var caption: String
    public private(set) var frames: [Frame]
    public private(set) var selected: Int

    public init(storyId: String = ClientID.make()) {
        self.storyId = storyId
        original = nil
        caption = ""
        frames = []
        selected = 0
    }

    public init(editing story: Story) {
        storyId = story.id
        original = story
        caption = story.caption ?? ""
        frames = story.frames.map {
            Frame(id: $0.id, kind: $0.kind, width: $0.width, height: $0.height, durationMs: $0.durationMs, media: .kept, placement: $0.placement, background: $0.background, overlays: $0.overlays)
        }
        selected = 0
    }

    /// Keeps these edits over `latest`, a newer version saved elsewhere, so
    /// the next save replaces it. A kept frame the newer version no longer
    /// has is sent again by its media's identity.
    public mutating func rebase(on latest: Story) {
        guard latest.id == storyId else { return }
        let held = Set(latest.frames.map(\.id))
        let was = original
        for index in frames.indices where frames[index].media == .kept && !held.contains(frames[index].id) {
            if let asset = was?.frames.first(where: { $0.id == frames[index].id })?.asset { frames[index].media = .asset(asset) }
        }
        original = latest
    }

    public var isNew: Bool { original == nil }
    public var current: Frame? { frames.indices.contains(selected) ? frames[selected] : nil }
    public var canAddFrame: Bool { frames.count < StoryCanvas.maxFrames }

    /// Whether saving would change anything.
    public var hasChanges: Bool {
        guard let original else { return !frames.isEmpty }
        if caption != (original.caption ?? "") { return true }
        return frames != Self(editing: original).frames
    }

    // MARK: Frames

    /// Adds `frame` after the selected one and selects it; false at ten.
    @discardableResult
    public mutating func add(_ frame: Frame) -> Bool {
        guard canAddFrame else { return false }
        let index = frames.isEmpty ? 0 : selected + 1
        frames.insert(frame, at: index)
        selected = index
        return true
    }

    public mutating func removeFrame(_ id: String) {
        guard let index = frames.firstIndex(where: { $0.id == id }) else { return }
        frames.remove(at: index)
        if selected >= frames.count { selected = max(0, frames.count - 1) }
        else if index < selected { selected -= 1 }
    }

    public mutating func select(_ index: Int) {
        guard frames.indices.contains(index) else { return }
        selected = index
    }

    public mutating func place(media transform: StoryTransform) {
        guard frames.indices.contains(selected) else { return }
        frames[selected].placement = transform.clamped
    }

    // MARK: Overlays

    /// Whether the selected frame has room for `overlay`.
    public func fits(_ overlay: StoryOverlay) -> Bool {
        guard let frame = current else { return false }
        guard frame.overlays.count < StoryCanvas.maxOverlays else { return false }
        if case .reaction = overlay {
            return frame.overlays.filter { if case .reaction = $0 { true } else { false } }.count < Self.maxReactions
        }
        return true
    }

    /// Puts `overlay` on top of the selected frame; false when it has no room.
    @discardableResult
    public mutating func add(_ overlay: StoryOverlay) -> Bool {
        guard fits(overlay) else { return false }
        frames[selected].overlays.append(overlay)
        return true
    }

    public func overlay(_ id: String) -> StoryOverlay? {
        current?.overlays.first { $0.id == id }
    }

    /// Changes an overlay in place, keeping its spot in the drawing order.
    public mutating func replace(_ overlay: StoryOverlay) {
        guard let id = overlay.id, frames.indices.contains(selected),
              let index = frames[selected].overlays.firstIndex(where: { $0.id == id }) else { return }
        frames[selected].overlays[index] = overlay
    }

    public mutating func move(_ id: String, to transform: StoryTransform) {
        guard var overlay = overlay(id) else { return }
        overlay.transform = transform.clamped
        replace(overlay)
    }

    /// Lifts an overlay above the others, as touching it does.
    public mutating func bringToFront(_ id: String) {
        guard frames.indices.contains(selected), let index = frames[selected].overlays.firstIndex(where: { $0.id == id }) else { return }
        let overlay = frames[selected].overlays.remove(at: index)
        frames[selected].overlays.append(overlay)
    }

    public mutating func remove(_ id: String) {
        guard frames.indices.contains(selected) else { return }
        frames[selected].overlays.removeAll { $0.id == id }
    }

    // MARK: Saving

    /// The device files to upload before saving, by frame.
    public var uploads: [(frameId: String, file: URL, name: String)] {
        frames.compactMap { frame in
            if case .local(let file, let name) = frame.media { return (frame.id, file, name) }
            return nil
        }
    }

    /// The frames as the create or edit sends them, with each device file's
    /// upload ID from `uploaded`.
    public func inputs(uploaded: [String: String]) throws -> [StoryFrameInput] {
        try frames.map { frame in
            let media: StoryFrameInput.Media
            switch frame.media {
            case .kept: media = .keep
            case .asset(let asset): media = .asset(asset)
            case .local(_, let name):
                guard let upload = uploaded[frame.id] else { throw StoryDraftError.notUploaded(frame.id) }
                media = .upload(uploadId: upload, name: name)
            }
            return StoryFrameInput(id: frame.id, media: media, placement: frame.placement, background: frame.background, overlays: frame.overlays)
        }
    }

    /// The caption to send: nil for none.
    public var sentCaption: String? {
        let trimmed = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(StoryCanvas.maxCaption))
    }

    /// The selected frame as a story the canvas draws, before it is saved.
    public func preview(_ frame: Frame) -> (Story, StoryFrame) {
        let asset: StoryAsset = switch frame.media {
        case .asset(let asset): asset
        case .kept: original?.frames.first { $0.id == frame.id }?.asset ?? .artifactFile(artifactId: storyId, version: 0, path: "")
        case .local(_, let name): .artifactFile(artifactId: storyId, version: 0, path: "media/\(name)")
        }
        let shown = StoryFrame(
            id: frame.id, kind: frame.kind, width: frame.width, height: frame.height, thumbhash: original?.frames.first { $0.id == frame.id }?.thumbhash,
            durationMs: frame.durationMs, asset: asset, available: true, placement: frame.placement,
            background: frame.background ?? ["#000000", "#000000"], overlays: frame.overlays
        )
        let story = Story(
            id: storyId, status: .draft, authorUserId: original?.authorUserId, createdBy: original?.createdBy ?? .user(userId: nil),
            caption: sentCaption, frames: [shown], artifactVersion: original?.artifactVersion ?? 0,
            createdAt: original?.createdAt ?? 0, updatedAt: original?.updatedAt ?? 0, postedAt: nil, expiresAt: nil,
            seen: false, viewCount: nil, myReaction: nil, reactions: [], version: original?.version ?? ""
        )
        return (story, shown)
    }
}

public enum StoryDraftError: Error, Equatable {
    case notUploaded(String)
}
