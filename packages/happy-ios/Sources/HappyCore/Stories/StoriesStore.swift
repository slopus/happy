import Foundation
import HappyWire

/// What the Stories screens draw from, for one paired computer.
public struct StoriesSnapshot: Equatable, Sendable {
    public enum Availability: Equatable, Sendable, Codable {
        /// Not read yet, and nothing kept.
        case unknown
        /// The computer serves no Stories.
        case unsupported
        /// Served, and the person's setting is not `true`.
        case off
        case on
    }

    public var availability: Availability = .unknown
    /// The row, as last read and changed by events since.
    public var feed: StoryFeed?
    /// Every story known: the feed's, and those read for a conversation.
    public var stories: [String: Story] = [:]
    /// Stories read and not found: deleted for everyone but their author.
    public var gone: Set<String> = []
    public var recents: [StickerRef] = []
    public var live = false
    /// The computer serves agents' stories: rings, round videos, reposts.
    public var agentStories = false

    public init() {}

    public var isOn: Bool { availability == .on }
}

/// One computer's Stories: the feed, every story the screens show, the
/// person's recent stickers, and the setting that turns it all on. Events
/// arrive off the V2 store's one stream; reads and writes run here,
/// off the main thread, and every change is one snapshot.
///
/// The row's order is the daemon's. While the viewer is open (`hold`), a
/// fresh read of the feed waits, so circles don't move under the person;
/// what they see marks rings at once.
public actor StoriesStore {
    static let offlineName = "stories.json"

    private struct Kept: Codable {
        static let format = 1
        var format = Kept.format
        var availability: StoriesSnapshot.Availability
        var feed: StoryFeed?
        var recents: [StickerRef]
    }

    private let client: AgentClient
    public typealias Events = @Sendable () async -> AsyncStream<Store.ConversationEvent>
    private let events: Events
    private let offline: OfflineFile?
    private let now: @Sendable () -> Int64
    private let firstReadDelay: Duration
    private let continuation: AsyncStream<StoriesSnapshot>.Continuation
    public nonisolated let updates: AsyncStream<StoriesSnapshot>

    private var snapshot = StoriesSnapshot()
    private var following: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    /// Asked to read again while a read was under way.
    private var loadAgain = false
    /// The first read, waiting a moment for the stream's first `resync`.
    private var firstLoad: Task<Void, Never>?
    private var heldEvents: [JSONValue]?
    private var holds = 0
    private var reloadWanted = false
    private var reloading: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var reading: [String: Task<Void, Never>] = [:]
    private var settingWrite: Task<Void, Never>?
    private var settingWrites = 0
    /// Each story's latest reaction write; older answers are dropped.
    private var reactionWrites: [String: Int] = [:]
    private var reactedMeanwhile: Set<String> = []
    /// Whether `stories.json` exists for this computer.
    private var keptOnDisk = false

    public init(client: AgentClient, events: @escaping Events, offline: OfflineFile?, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }, firstReadDelay: Duration = .seconds(1)) {
        self.client = client
        self.events = events
        self.offline = offline
        self.now = now
        self.firstReadDelay = firstReadDelay
        (updates, continuation) = AsyncStream.makeStream(of: StoriesSnapshot.self, bufferingPolicy: .bufferingNewest(1))
    }

    /// Events off the V2 store's one stream.
    public init(client: AgentClient, v2: Store, offline: OfflineFile?) {
        self.init(client: client, events: { await v2.events(matching: Self.eventPrefixes) }, offline: offline)
    }

    public static let eventPrefixes = ["story.", "sticker_recents.", "user_settings."]

    // MARK: Life

    public func start() {
        guard following == nil else { return }
        restoreOffline()
        following = Task { [weak self] in
            guard let self else { return }
            let stream = await events()
            await loadFirst()
            for await event in stream {
                switch event {
                case .resync: await resynced()
                case .event(let envelope): await receive(envelope)
                }
            }
        }
    }

    public func stop() {
        following?.cancel(); following = nil
        firstLoad?.cancel(); firstLoad = nil
        loading?.cancel(); loading = nil
        reloading?.cancel(); reloading = nil
        expiry?.cancel(); expiry = nil
        keeping?.cancel(); keeping = nil
        settingWrite?.cancel(); settingWrite = nil
        for task in reading.values { task.cancel() }
        reading = [:]
        continuation.finish()
    }

    /// A stream that has just connected says `resync` first; the first read
    /// waits a moment for it so it doesn't read twice.
    private func loadFirst() {
        firstLoad = Task {
            try? await Task.sleep(for: self.firstReadDelay)
            guard !Task.isCancelled else { return }
            self.firstLoad = nil
            self.startLoad()
        }
    }

    private func resynced() {
        firstLoad?.cancel(); firstLoad = nil
        startLoad()
    }

    /// Everything read whole. Events that arrive meanwhile apply after it;
    /// asked again meanwhile, it reads again before they do.
    public func load() async {
        startLoad()
        await loading?.value
    }

    private func startLoad() {
        guard loading == nil else { loadAgain = true; return }
        if heldEvents == nil { heldEvents = [] }
        loading = Task { await self.readUntilSettled() }
    }

    private func readUntilSettled() async {
        repeat {
            loadAgain = false
            await read()
        } while loadAgain && !Task.isCancelled
        loading = nil
        let pending = heldEvents ?? []
        heldEvents = nil
        for event in pending { receive(event) }
        publish()
        saveOffline()
    }

    private func read() async {
        // Out of reach, what was kept stays on screen.
        guard let health = try? await client.health() else { return }
        guard health.capabilities?.stories == true else { return turnedOff(.unsupported) }
        snapshot.agentStories = health.capabilities?.agentStories == true
        let setting: JSONValue?
        do { setting = try await client.userSetting(AgentClient.storiesSettingKey) }
        catch { return }
        guard setting == .bool(true) else { return turnedOff(.off) }
        do {
            async let feed = client.storyFeed()
            async let recents = client.stickerRecents()
            let answer = try await feed
            snapshot.availability = .on
            if holds > 0, snapshot.feed != nil {
                // The viewer is open: its stories change, the row waits.
                for (id, story) in answer.stories { adopt(story, id: id) }
                reloadWanted = true
            } else {
                adoptFeed(answer)
            }
            if let recents = try? await recents { snapshot.recents = recents.recents }
            snapshot.live = true
        } catch AgentClientError.status(404, _, _) {
            turnedOff(.off)
        } catch {}
    }

    private func turnedOff(_ availability: StoriesSnapshot.Availability) {
        snapshot.availability = availability
        snapshot.feed = nil
        snapshot.stories = [:]
        snapshot.gone = []
        snapshot.recents = []
        reloading?.cancel(); reloading = nil
        expiry?.cancel(); expiry = nil
    }

    /// A read of the feed, after events that may have reordered it. It
    /// waits while the viewer is open.
    private func reloadFeedSoon() {
        guard holds == 0 else { reloadWanted = true; return }
        reloading?.cancel()
        reloading = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let feed = try? await client.storyFeed() else { return }
            adoptReloaded(feed)
        }
    }

    private func adoptReloaded(_ feed: StoryFeed) {
        guard holds == 0 else { reloadWanted = true; return }
        adoptFeed(feed)
        publish()
        saveOffline()
    }

    private func adoptFeed(_ feed: StoryFeed) {
        for (id, story) in feed.stories { adopt(story, id: id) }
        var feed = feed
        feed.stories = [:]
        for index in feed.authors.indices {
            // A read from before a deletion still lists it.
            feed.authors[index].storyIds.removeAll { snapshot.stories[$0]?.status == .deleted || snapshot.gone.contains($0) }
            feed.authors[index].unseenCount = unseen(feed.authors[index])
        }
        feed.authors.removeAll { !$0.isSelf && $0.storyIds.isEmpty }
        if let rings = feed.rings {
            feed.rings = rings.compactMap { ring in
                var ring = ring
                ring.storyIds.removeAll { !live($0) }
                ring.unseenCount = unseen(ring)
                return ring.storyIds.isEmpty ? nil : ring
            }
        }
        snapshot.feed = feed
    }

    /// Still in its ring: not deleted, gone or ended.
    private func live(_ storyId: String) -> Bool {
        guard !snapshot.gone.contains(storyId) else { return false }
        guard let story = snapshot.stories[storyId] else { return true }
        return story.status != .deleted && story.endedAt == nil
    }

    /// Keeps the newer copy of a story (versions are UUIDv7s, so they sort
    /// by time). A deleted story stays deleted, and one seen here stays
    /// seen: seeing doesn't change a version, so an answer read before the
    /// person saw it looks as new. A reaction being written stays as shown.
    private func adopt(_ story: Story, id: String? = nil) {
        let id = id ?? story.id
        guard !snapshot.gone.contains(id) else { return }
        var story = story
        if let held = snapshot.stories[id] {
            if held.version > story.version || held.status == .deleted { return }
            if held.seen, story.status == .posted { story.seen = true }
            if reactionWrites[id] != nil {
                story.myReaction = held.myReaction
                story.reactions = held.reactions
            }
        }
        snapshot.stories[id] = story
    }

    // MARK: Holding still

    /// The viewer opens (`true`) or closes: the row keeps its order meanwhile.
    public func hold(_ on: Bool) {
        holds = max(0, holds + (on ? 1 : -1))
        if holds == 0, reloadWanted {
            reloadWanted = false
            reloadFeedSoon()
        }
    }

    // MARK: Events

    private func receive(_ event: JSONValue) {
        if heldEvents != nil { heldEvents?.append(event); return }
        guard let type = event["type"]?.stringValue else { return }
        let payload = event["payload"] ?? .null
        switch type {
        case "user_settings.updated":
            guard payload["setting"]?["key"]?.stringValue == AgentClient.storiesSettingKey else { return }
            let on = payload["setting"]?["value"] == .bool(true)
            guard on != snapshot.isOn else { return }
            Task { await load() }
            return
        case "story.created", "story.posted", "story.updated":
            guard let story = payload["story"].flatMap({ Self.decode(Story.self, $0) }) else { return }
            adopt(story)
            // The feed counts drafts it doesn't list, so only it can say
            // how many there are now.
            if type == "story.created", story.status == .draft { reloadFeedSoon() }
            if type == "story.posted" {
                place(story)
                // A ring's order is its own; nothing else moves.
                if !story.isAgents { reloadFeedSoon() }
            }
        case "story.ended":
            guard let id = payload["storyId"]?.stringValue else { return }
            if let story = payload["story"].flatMap({ Self.decode(Story.self, $0) }) { adopt(story) }
            unring(id)
        case "story.deleted":
            guard let id = payload["storyId"]?.stringValue else { return }
            removed(id, version: payload["version"]?.stringValue)
            reloadFeedSoon()
        case "story.seen":
            guard let id = payload["storyId"]?.stringValue else { return }
            if !markSeen(through: id) { reloadFeedSoon() }
        case "story.reacted":
            guard let id = payload["storyId"]?.stringValue else { return }
            // Mid-write, the counts may be from before it: read once it's done.
            if reactionWrites[id] != nil { reactedMeanwhile.insert(id); return }
            guard var story = snapshot.stories[id],
                  let reactions = payload["reactions"].flatMap({ Self.decode([StoryReactionCount].self, $0) }) else { return }
            story.reactions = reactions
            if let mine = payload["myReaction"] { story.myReaction = mine.stringValue }
            snapshot.stories[id] = story
        case "sticker_recents.updated":
            guard let recents = payload["recents"].flatMap({ Self.decode([StickerRef].self, $0) }) else { return }
            snapshot.recents = recents
        default:
            return
        }
        publish()
        keepSoon()
    }

    /// A posted story goes last in its author's circle, which exists once
    /// the feed is read again if it doesn't yet; an agent's, last in its
    /// ring, unseen, the ring going first.
    private func place(_ story: Story) {
        guard var feed = snapshot.feed else { return }
        if story.isAgents {
            guard let agentId = story.ringAgentId, story.endedAt == nil, story.status == .posted, feed.rings != nil else { return }
            var ring = feed.rings?.first { $0.agentId == agentId } ?? StoryRing(agentId: agentId, storyIds: [], unseenCount: 0, latestPostedAt: nil)
            guard !ring.storyIds.contains(story.id) else { return }
            ring.storyIds.append(story.id)
            ring.unseenCount = unseen(ring)
            ring.latestPostedAt = story.postedAt ?? ring.latestPostedAt
            feed.rings?.removeAll { $0.agentId == agentId }
            feed.rings?.insert(ring, at: 0)
            snapshot.feed = feed
            return
        }
        let index = feed.authors.firstIndex { author in
            author.isSelf ? (story.authorUserId == author.userId || story.authorUserId == nil) : author.userId == story.authorUserId
        }
        guard let index, !feed.authors[index].storyIds.contains(story.id) else { return }
        feed.authors[index].storyIds.append(story.id)
        if !story.seen { feed.authors[index].unseenCount += 1 }
        feed.authors[index].latestPostedAt = story.postedAt ?? feed.authors[index].latestPostedAt
        snapshot.feed = feed
    }

    private func removed(_ id: String, version: String?) {
        if var story = snapshot.stories[id] {
            story.status = .deleted
            if let version, version > story.version { story.version = version }
            snapshot.stories[id] = story
        } else {
            snapshot.gone.insert(id)
        }
        guard var feed = snapshot.feed else { return }
        for index in feed.authors.indices where feed.authors[index].storyIds.contains(id) {
            feed.authors[index].storyIds.removeAll { $0 == id }
            feed.authors[index].unseenCount = unseen(feed.authors[index])
        }
        feed.authors.removeAll { !$0.isSelf && $0.storyIds.isEmpty }
        snapshot.feed = feed
        unring(id)
    }

    /// An agent's story left its ring: ended or deleted.
    private func unring(_ id: String) {
        guard var feed = snapshot.feed, let rings = feed.rings, rings.contains(where: { $0.storyIds.contains(id) }) else { return }
        feed.rings = rings.compactMap { ring in
            var ring = ring
            ring.storyIds.removeAll { $0 == id }
            ring.unseenCount = unseen(ring)
            return ring.storyIds.isEmpty ? nil : ring
        }
        snapshot.feed = feed
    }

    /// Marks `storyId` and every earlier story of its author seen, or of
    /// its ring for an agent's. False when the story isn't known here.
    @discardableResult
    private func markSeen(through storyId: String) -> Bool {
        guard let story = snapshot.stories[storyId], story.status == .posted, let mark = story.postedAt else { return false }
        func together(_ other: Story) -> Bool {
            if let ring = story.ringAgentId { return other.ringAgentId == ring }
            return other.ringAgentId == nil && !other.isAgents && other.authorUserId == story.authorUserId
        }
        for (id, other) in snapshot.stories where together(other) && other.status == .posted && !other.seen && (other.postedAt ?? .max) <= mark {
            snapshot.stories[id]?.seen = true
        }
        if var feed = snapshot.feed {
            for index in feed.authors.indices { feed.authors[index].unseenCount = unseen(feed.authors[index]) }
            if let rings = feed.rings { feed.rings = rings.map { var ring = $0; ring.unseenCount = unseen(ring); return ring } }
            snapshot.feed = feed
        }
        return true
    }

    private func unseen(_ author: StoryFeedAuthor) -> Int {
        author.isSelf ? 0 : author.storyIds.filter { snapshot.stories[$0]?.seen == false }.count
    }

    private func unseen(_ ring: StoryRing) -> Int {
        ring.storyIds.filter { snapshot.stories[$0]?.seen == false }.count
    }

    // MARK: Publishing

    private func publish() {
        dropExpired()
        continuation.yield(snapshot)
    }

    /// Stories past `expiresAt` leave the row, without an event; the next
    /// one to expire wakes this again.
    private func dropExpired() {
        // While the viewer is open, circles leave once it closes.
        guard holds == 0, var feed = snapshot.feed else { return }
        let now = now()
        var next: Int64?
        var changed = false
        for index in feed.authors.indices {
            let kept = feed.authors[index].storyIds.filter { id in
                guard let expires = snapshot.stories[id]?.expiresAt else { return true }
                if expires <= now { return false }
                next = min(next ?? expires, expires)
                return true
            }
            if kept != feed.authors[index].storyIds {
                feed.authors[index].storyIds = kept
                feed.authors[index].unseenCount = unseen(feed.authors[index])
                changed = true
            }
        }
        if changed {
            feed.authors.removeAll { !$0.isSelf && $0.storyIds.isEmpty }
            snapshot.feed = feed
        }
        expiry?.cancel()
        if let next {
            expiry = Task {
                try? await Task.sleep(for: .milliseconds(max(0, next - now) + 50))
                guard !Task.isCancelled else { return }
                self.publish()
            }
        }
    }

    // MARK: Offline

    private func restoreOffline() {
        guard snapshot.availability == .unknown, let data = offline?.readExtra(Self.offlineName),
              let kept = try? JSONDecoder().decode(Kept.self, from: data), kept.format == Kept.format else { return }
        keptOnDisk = true
        snapshot.availability = kept.availability
        snapshot.recents = kept.recents
        if let feed = kept.feed { adoptFeed(feed) }
        publish()
    }

    private var keeping: Task<Void, Never>?

    private func keepSoon() {
        keeping?.cancel()
        keeping = Task {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            saveOffline()
        }
    }

    /// Saves what is waiting to be kept, before the app is suspended.
    public func flush() {
        guard keeping != nil else { return }
        keeping?.cancel(); keeping = nil
        saveOffline()
    }

    /// Kept once Stories have been on here: off and never on, nothing is
    /// written; turned off, what was kept becomes just "off".
    private func saveOffline() {
        guard let offline, snapshot.availability == .on || keptOnDisk else { return }
        keptOnDisk = true
        var feed = snapshot.feed
        if let shown = feed {
            let ids = Set(shown.authors.flatMap(\.storyIds) + (shown.rings ?? []).flatMap(\.storyIds))
            feed?.stories = snapshot.stories.filter { ids.contains($0.key) }
        }
        let kept = Kept(availability: snapshot.availability, feed: feed, recents: snapshot.recents)
        guard let data = try? JSONEncoder().encode(kept) else { return }
        offline.writeExtra(Self.offlineName, data: data)
    }

    // MARK: Acts

    /// Turns Stories on or off for the person; the screens follow at once,
    /// and a refusal puts back what the daemon has.
    public func setEnabled(_ on: Bool) {
        guard snapshot.availability == .on || snapshot.availability == .off else { return }
        if on { snapshot.availability = .on } else { turnedOff(.off) }
        publish()
        saveOffline()
        settingWrites += 1
        let write = settingWrites
        let previous = settingWrite
        settingWrite = Task {
            await previous?.value
            try? await client.setUserSetting(AgentClient.storiesSettingKey, .bool(on))
            // Only the last of quick toggles reads back what the daemon has.
            guard write == self.settingWrites else { return }
            await self.load()
        }
    }

    /// Reads a story the screens need and the store doesn't hold (a
    /// conversation's draft), once at a time.
    public func want(_ storyId: String) {
        guard snapshot.stories[storyId] == nil, !snapshot.gone.contains(storyId), reading[storyId] == nil else { return }
        reading[storyId] = Task {
            let story: Story?
            do { story = try await client.story(storyId) }
            catch AgentClientError.status(404, _, _) { notFound(storyId); return }
            catch { story = nil }
            read(storyId, story)
        }
    }

    /// Reads it again: the author's view count moves without an event.
    public func refresh(_ storyId: String) {
        Task {
            do { read(storyId, try await client.story(storyId)) }
            catch AgentClientError.status(404, _, _) { gone(storyId) }
            catch {}
        }
    }

    /// Deleted, or no longer the person's to see.
    private func gone(_ storyId: String) {
        removed(storyId, version: nil)
        snapshot.gone.insert(storyId)
        publish()
    }

    private func read(_ storyId: String, _ story: Story?) {
        reading.removeValue(forKey: storyId)
        guard let story else { return }
        adopt(story)
        publish()
    }

    private func notFound(_ storyId: String) {
        reading.removeValue(forKey: storyId)
        snapshot.gone.insert(storyId)
        publish()
    }

    /// The viewer showed `storyId`: its ring turns at once.
    public func seen(_ storyId: String) {
        guard let story = snapshot.stories[storyId], story.status == .posted, !story.seen else { return }
        markSeen(through: storyId)
        publish()
        keepSoon()
        Task {
            if let story = try? await client.markStorySeen(storyId) { adoptAndPublish(story) }
        }
    }

    /// Sets or, with nil, removes the person's reaction; shown at once.
    public func react(_ storyId: String, emoji: String?) {
        guard var story = snapshot.stories[storyId], story.status == .posted else { return }
        let before = (story.myReaction, story.reactions)
        story.reactions = Self.counts(story.reactions, from: story.myReaction, to: emoji)
        story.myReaction = emoji
        snapshot.stories[storyId] = story
        markSeen(through: storyId)
        publish()
        // Only the last write's answer is shown; a refusal of it puts back
        // what was there before.
        let write = (reactionWrites[storyId] ?? 0) + 1
        reactionWrites[storyId] = write
        Task {
            do {
                let answer = try await client.reactToStory(storyId, emoji: emoji)
                guard reactionWrites[storyId] == write else { return }
                reactionWrites[storyId] = nil
                adoptAndPublish(answer)
                if reactedMeanwhile.remove(storyId) != nil { refresh(storyId) }
            } catch {
                guard reactionWrites[storyId] == write else { return }
                reactionWrites[storyId] = nil
                reactedMeanwhile.remove(storyId)
                snapshot.stories[storyId]?.myReaction = before.0
                snapshot.stories[storyId]?.reactions = before.1
                publish()
            }
        }
    }

    /// The counts after one person's reaction moves from `old` to `new`,
    /// most first, then in their earlier order.
    public static func counts(_ counts: [StoryReactionCount], from old: String?, to new: String?) -> [StoryReactionCount] {
        guard old != new else { return counts }
        var next = counts
        if let old, let index = next.firstIndex(where: { $0.emoji == old }) {
            next[index].count -= 1
            if next[index].count <= 0 { next.remove(at: index) }
        }
        if let new {
            if let index = next.firstIndex(where: { $0.emoji == new }) { next[index].count += 1 }
            else { next.append(StoryReactionCount(emoji: new, count: 1)) }
        }
        return next.enumerated().sorted { $0.element.count != $1.element.count ? $0.element.count > $1.element.count : $0.offset < $1.offset }.map(\.element)
    }

    private func adoptAndPublish(_ story: Story) {
        adopt(story)
        publish()
    }

    /// Posts the version shown. Throws the refusal; a stale version brings
    /// the latest in its place.
    public func post(_ storyId: String, artifactVersion: Int) async throws -> Story {
        do {
            let story = try await client.postStory(storyId, artifactVersion: artifactVersion)
            adopt(story)
            place(story)
            publish()
            reloadFeedSoon()
            return story
        } catch {
            if StoryRefusal(error)?.isConflict == true { refresh(storyId) }
            throw error
        }
    }

    public func delete(_ storyId: String) async throws {
        guard let story = snapshot.stories[storyId] else { return }
        let deleted = try await client.deleteStory(storyId, version: story.version)
        removed(storyId, version: deleted.version)
        publish()
        reloadFeedSoon()
    }

    /// The person's own draft from an agent's story, to edit and post.
    public func repost(_ storyId: String) async throws -> Story {
        let story = try await client.repostStory(storyId, id: ClientID.make())
        adopt(story)
        publish()
        return story
    }

    /// Sends what the person typed to the agent that posted the story.
    public func feedback(_ storyId: String, frameId: String?, text: String) async throws {
        try await client.storyFeedback(storyId, frameId: frameId, text: text, id: ClientID.make())
    }

    /// A new draft by hand.
    public func create(id: String, caption: String?, frames: [StoryFrameInput]) async throws -> Story {
        let story = try await client.createStory(id: id, caption: caption, frames: frames)
        adopt(story)
        publish()
        reloadFeedSoon()
        return story
    }

    /// An edit of `version` (the editor's), or of the version held; `caption`
    /// nil leaves it as it is.
    public func update(_ storyId: String, version: String? = nil, caption: String??, frames: [StoryFrameInput]?) async throws -> Story {
        guard let base = version ?? snapshot.stories[storyId]?.version else { throw AgentClientError.invalidResponse }
        do {
            let story = try await client.updateStory(storyId, version: base, caption: caption, frames: frames)
            adopt(story)
            publish()
            return story
        } catch {
            if StoryRefusal(error)?.isConflict == true { refresh(storyId) }
            throw error
        }
    }

    public func useSticker(_ ref: StickerRef) {
        snapshot.recents.removeAll { $0 == ref }
        snapshot.recents.insert(ref, at: 0)
        snapshot.recents = Array(snapshot.recents.prefix(20))
        publish()
        Task { if let recents = try? await client.useSticker(ref) { adoptRecents(recents.recents) } }
    }

    public func clearRecents() {
        snapshot.recents = []
        publish()
        Task { _ = try? await client.clearStickerRecents() }
    }

    private func adoptRecents(_ recents: [StickerRef]) {
        snapshot.recents = recents
        publish()
    }

    /// The person's drafts, newest first.
    public func drafts() async throws -> [Story] {
        let page = try await client.ownStories(status: [.draft])
        for story in page.stories { adopt(story) }
        publish()
        return page.stories
    }

    static func decode<T: Decodable>(_ type: T.Type, _ value: JSONValue) -> T? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
