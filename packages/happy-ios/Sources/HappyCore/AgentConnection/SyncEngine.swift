import Foundation
import HappyWire

public struct HomeSnapshot: Equatable, Sendable {
    public var loaded = false
    public var live = false
    /// Bootstrap/sidebar reconciliation is still running. An open stream
    /// alone does not mean the phone has caught up.
    public var syncing = true
    public var rows: [Row] = []
    public var allRows: [Row] = []
    /// The active tasks the person isn't in, which search finds too.
    public var unjoinedTasks: [Row] = []
    public var settings: [String: JSONValue] = [:]
    /// The person signed in as a team user; nil outside a team.
    public var userId: String?
    /// The person's own picture's ThumbHash, for the faces that are theirs.
    public var profilePhoto: String?
    public var error: String?
    /// The stream is down and being opened again, however it failed: it is
    /// asked again with backoff for as long as the engine runs, so it is on
    /// its way back, "connecting…", as a Happy account's socket is, never
    /// an `error` home says. Android's `AgentSession.reconnecting`.
    public var reconnecting = false
    /// An action the computer refused, said for a moment while it rolls back.
    public var notice: String?
    public init() {}
}

/// One direct account, one tailcat client, one durable checkpoint and one
/// event stream. UIKit only observes projections. Relay SyncEngine is not
/// involved in this account's identity, persistence, settings or transport.
public actor SyncEngine {
    public nonisolated let client: AgentClient
    public nonisolated let spaces: Store
    public nonisolated let offline: OfflineFile?
    public nonisolated let attachmentDirectory: URL
    /// The person's actions on their way: chats read, tasks archived, names
    /// given (docs/offline-first.md). Shown at once over what the computer
    /// last said, kept in `direct.sqlite`, sent once the account is live.
    public nonisolated let intents: IntentOutbox
    /// The documents open on this account and those with changes still to
    /// send; the stream's live document frames go to them.
    public nonisolated let documents: DocumentLibrary
    /// The todo lists open on this account or with changes on their way.
    public nonisolated let todos: TodoLibrary
    /// The vaults' folders, Trash and settings open on this account, and
    /// the uploads into them.
    public nonisolated let vaults: VaultLibrary
    /// The person's Feed on this computer (`FeedLibrary`), followed for as
    /// long as the account is.
    public nonisolated let feed: FeedLibrary
    /// The artifact catalog, tombstones included, kept on the phone and
    /// followed for as long as the account is: the Artifacts list shows
    /// it, and the Feed names its artifacts from it.
    public nonisolated let artifacts: ArtifactCatalogFeed
    /// What only the Feed names, read by ID and kept (`FeedLookups`).
    public nonisolated let lookups: FeedLookups
    /// The Feed's row as home lists it: nil while there is no feed.
    private var feedRow: SidebarRows.FeedRow?
    private var feedFollowing: Task<Void, Never>?
    /// Everything a Feed row can name (`FeedDirectory`), as last made, and
    /// what it is made from beside the bootstrap.
    private var directory = FeedDirectory()
    private var directoryListeners: [UUID: AsyncStream<FeedDirectory>.Continuation] = [:]
    private var directoryFollowing: [Task<Void, Never>] = []
    private var artifactItems: [ArtifactSummary] = []
    private var found = FeedLookups.Found()
    /// What the Feed names now: its entries, a place peeked at, Following's places.
    private var feedItems: [FeedItem] = []
    private var feedLoaded = false
    private var feedPeeked: [FeedItem] = []
    private var feedClusters: [FeedCluster] = []
    private var overlay = IntentOverlay()
    /// What waits in `intents`, as last published.
    private var waiting: [Intent] = []
    /// Taken by the computer but laid over what it last said until a read
    /// of it that began after it took them, so nothing flickers back in
    /// between: each with the number of the read last begun then.
    private var settling: [(intent: Intent, read: Int)] = []
    /// Refused before the list said they were gone: not settling.
    private var refusedIds: Set<String> = []
    /// Reads of the computer begun (`reconcile`).
    private var reads = 0
    /// The newest read home has taken: one begun before it is older in
    /// every part and is dropped.
    private var adopted = 0
    /// News home couldn't apply (`scheduleReconcile`), counted, and how
    /// much of it the newest read taken began after: home is stale while
    /// they differ, a read cancelled on its way included.
    private var signalled = 0
    private var covered = 0
    /// The newest journal event taken in, and the daemon process a read
    /// verified: back on that process with nothing stale, the stream picks
    /// up from there and nothing is read again.
    private var streamCursor: String?
    private var verifiedDaemon: String?
    private var intentsFollowing: Task<Void, Never>?
    private var noticeClearing: Task<Void, Never>?
    private let url: URL?
    private var storage: SyncStorage?
    private var desktop: DesktopSnapshot?
    /// What `spaces` was last given of the bootstrap's bots, tasks and
    /// Surfaces, in order.
    private var shared: (owners: [DesktopSnapshot.Owner], surfaces: [DesktopSnapshot.Surface])?
    private var sharing: Task<Void, Never>?
    /// Where each agent of `desktop` stands (`AgentIndex`), made on the
    /// first update after each read; nil until then.
    private var agentIndex: AgentIndex?
    /// Each agent's row among `snapshot.allRows`, and each row's place
    /// among `snapshot.rows`, as `derive` last drew them: an update redraws
    /// only its agent's row.
    private var agentRows: [String: Int] = [:]
    private var shownRows: [String: Int] = [:]
    private var snapshot = HomeSnapshot()
    private var listeners: [UUID: AsyncStream<HomeSnapshot>.Continuation] = [:]
    private var runner: Task<Void, Never>?
    private var refresh: Task<Void, Never>?
    private var delivery: Task<Void, Never>?
    private var messageDelivery: Task<Void, Never>?
    private var messageListeners: [UUID: (agentID: String, continuation: AsyncStream<DeliveryEvent>.Continuation)] = [:]
    private var profileListeners: [UUID: AsyncStream<Void>.Continuation] = [:]
    private var verified = false
    private var settingsDeliveryDirty = false
    private var messageDeliveryDirty = false
    /// The queued message being delivered now, and those being changed,
    /// which delivery leaves until they are written again.
    private var deliveringMessage: String?
    private var holding: Set<String> = []
    private var generation = 0
    private var stopped = false
    private var cursor: String?
    private var dirty = false
    private var sidebarSyncing = false
    /// The team members the listed tasks belong to, as last read, kept
    /// beside the bootstrap (`TeamUser`); those asked for and not named,
    /// left until the stream comes back; and those to read again.
    private var users: [String: TeamUser] = [:]
    private var usersMissing: Set<String> = []
    private var usersAgain: Set<String> = []
    private var usersDirty = false
    private var usersRead: Task<Void, Never>?
    private var gitWatcher: Task<Void, Never>?
    /// Rows drawn again soon, after agents' updates (`deriveSoon`).
    private var deriving: Task<Void, Never>?
    private var gitInterest: Set<String> = []
    private var gitSnapshots: [String: WorkspaceLineChanges] = [:]

    public init(client: AgentClient, directory: URL?) {
        self.client = client
        url = directory?.appendingPathComponent("direct.sqlite")
        offline = directory.map(OfflineFile.init(directory:))
        attachmentDirectory = (directory ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
            .appendingPathComponent("outbox-files", isDirectory: true)
        let forward = EngineIntentStorage()
        let todoDelivery = TodoDelivery()
        let feedDelivery = FeedDelivery()
        let intents = IntentOutbox(storage: forward, deliver: { intent in
            if intent.kind.isTodo { try await todoDelivery.deliver(intent) }
            else if intent.kind.isFeed { try await feedDelivery.deliver(intent) }
            else { try await SyncEngine.deliver(intent, client: client) }
        })
        self.intents = intents
        documents = DocumentLibrary(client: client, directory: directory)
        let spaces = Store(client: client, offline: offline, intents: intents)
        self.spaces = spaces
        let keep = EngineResources()
        todos = TodoLibrary(routes: client, outbox: intents, keep: keep, events: { await spaces.events(matching: ["todo."]) })
        todoDelivery.library = todos
        vaults = VaultLibrary(routes: client, keep: keep, events: { await spaces.events(matching: ["vault."]) })
        feed = FeedLibrary(routes: client, outbox: intents, keep: keep)
        feedDelivery.library = feed
        artifacts = ArtifactCatalogFeed(
            fetch: { cursor in try await client.artifacts(pageCursor: cursor, limit: 100) },
            fetchOne: { id in try await client.artifact(id) },
            keep: { value in await keep.write(ArtifactCatalogFeed.resource, value) },
            kept: { await keep.read(ArtifactCatalogFeed.resource) },
            events: { await spaces.events(matching: ["artifact."]) }
        )
        lookups = FeedLookups(routes: client, keep: keep)
        forward.engine = self
        keep.engine = self
    }

    public func snapshots() -> AsyncStream<HomeSnapshot> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: HomeSnapshot.self, bufferingPolicy: .bufferingNewest(1))
        listeners[id] = continuation
        continuation.yield(snapshot)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeListener(id) } }
        return stream
    }

    /// A beat whenever the person's profile may have changed elsewhere: a
    /// `profile.updated`, or the stream coming back after missing some.
    /// Whoever shows the profile reads it again.
    public func profileUpdates() -> AsyncStream<Void> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        profileListeners[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeProfileListener(id) } }
        return stream
    }

    private func removeProfileListener(_ id: UUID) { profileListeners.removeValue(forKey: id) }

    private func profileChanged() {
        for listener in profileListeners.values { listener.yield() }
    }

    public var deliveryAllowed: Bool { !stopped && runner != nil && verified }

    /// Started and not paused since: its tunnels are up, or on their way.
    var running: Bool { !stopped && runner != nil }

    private func removeListener(_ id: UUID) { listeners.removeValue(forKey: id) }

    public func start() {
        guard !stopped, runner == nil else { return }
        generation += 1
        verified = false
        let generation = generation
        runner = Task {
            await self.run(generation)
            if self.generation == generation { runner = nil }
        }
    }

    /// Whether this pause still owns the engine when done: no other pause
    /// or start came while it wound down.
    @discardableResult
    public func pause() async -> Bool {
        generation += 1
        verified = false
        let pausedGeneration = generation
        let tasks = [runner, refresh, delivery, messageDelivery, usersRead, gitWatcher].compactMap { $0 }
        await feed.disconnected()
        await lookups.disconnected()
        gitWatcher = nil; gitInterest = []
        runner = nil; refresh = nil; delivery = nil; messageDelivery = nil; usersRead = nil
        deriving?.cancel(); deriving = nil
        tasks.forEach { $0.cancel() }
        for task in tasks { await task.value }
        // A start while the tasks wound down owns the outbox now: taking it
        // offline here held every intent back while home said live.
        guard generation == pausedGeneration else { return false }
        await intents.setOnline(false)
        guard generation == pausedGeneration else { return false }
        await documents.closed()
        await spaces.pause()
        guard generation == pausedGeneration else { return false }
        snapshot.live = false
        publish()
        return true
    }

    /// The phone has a way out again: try now, not when the backoff says.
    /// Does nothing while the engine is paused or already live.
    public func reconnect() async {
        guard !stopped, runner != nil, !snapshot.live else { return }
        // What failed while there was no network says nothing of the
        // computer: the header says "connecting…" until this try answers.
        // Cleared in the same turn as the pause, which publishes it.
        snapshot.error = nil
        // Started again only if nothing paused it meanwhile (the app went to
        // the background, another account opened) or restarted it first.
        if await pause() { start() }
    }

    /// The phone's way out moved (Wi-Fi to cellular): the stream went out
    /// the old way, where it can hang with nothing said until its
    /// 40-second silence while home says online. It is opened again at
    /// once on a new tunnel, every other tunnel woken (`resumed`), and the
    /// header says "connecting…" until the stream answers. Does nothing
    /// while the engine is paused, or once it was paused meanwhile.
    public func moved() async {
        guard !stopped, runner != nil else { return }
        await client.transport.reset(.realtime)
        guard !stopped, runner != nil else { return }
        snapshot.error = nil
        snapshot.reconnecting = true
        let client = client
        Task { await client.resumed() }
        if await pause() { start() }
    }

    public func stop() async {
        stopped = true
        await pause()
        await spaces.stop()
        await documents.stop()
        await todos.stop()
        await vaults.stop()
        await feed.stop()
        await artifacts.stop()
        await lookups.stop()
        feedFollowing?.cancel()
        directoryFollowing.forEach { $0.cancel() }
        directoryFollowing = []
        for listener in directoryListeners.values { listener.finish() }
        directoryListeners.removeAll()
        intentsFollowing?.cancel()
        await intents.close()
        try? await storage?.close()
        for listener in listeners.values { listener.finish() }
        listeners.removeAll()
        for listener in messageListeners.values { listener.continuation.finish() }
        messageListeners.removeAll()
        for listener in profileListeners.values { listener.finish() }
        profileListeners.removeAll()
    }

    private func database() throws -> SyncStorage {
        if let storage { return storage }
        let opened = try SyncStorage(url: url)
        storage = opened
        return opened
    }

    private func run(_ generation: Int) async {
        // Nothing goes out before this run has read the computer, even when
        // the pause before it was overtaken and left the outbox as it was.
        await intents.setOnline(false)
        do {
            let database = try database()
            if desktop == nil, let cached = try await database.checkpoint("desktop") {
                desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: JSONEncoder().encode(cached.value))
                agentIndex = nil
                cursor = cached.cursor
            }
            if users.isEmpty, let kept = try await database.checkpoint("users"),
               let list = try? JSONDecoder().decode([Lossy<TeamUser>].self, from: JSONEncoder().encode(kept.value)) {
                users = Dictionary(list.compactMap(\.value).map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            }
            snapshot.settings = try await database.settings()
            // What the person did last time, over what was kept, from the
            // first frame: nothing flickers back while it waits.
            waiting = await intents.pending()
            overlay = IntentOverlay(settling.map(\.intent) + waiting)
            followIntents()
            derive()
            deriveDirectory()
            await followFeed()
            await followDirectory()
            guard current(generation) else { return }
            await spaces.startExternal()
            await artifacts.start()
        } catch {
            // What this phone keeps could not be read: nothing to do with the link.
            snapshot.error = "Could not open this connection on this device."
            publish()
            return
        }
        var attempt = 0
        while current(generation) {
            do {
                sidebarSyncing = false
                snapshot.syncing = true
                publish()
                // Back on the process a read verified, with nothing stale:
                // the stream picks up after the last event taken in, and
                // neither home nor any conversation is read again. A flapping
                // network read the whole bootstrap, and every warm chat, on
                // every reconnect (Proofs/: `Refresh.resume_is_current`).
                let resuming = desktop != nil && verifiedDaemon != nil && streamCursor != nil && covered == signalled
                if !resuming {
                    try await reconcile(generation)
                    // The server answered: what is left is catching up.
                    if snapshot.reconnecting { snapshot.reconnecting = false; publish() }
                    streamCursor = cursor
                    beginDelivery(generation)
                    beginMessageDelivery(generation)
                    await intents.setOnline(deliveryAllowed)
                }
                let stream = try await client.events(after: resuming ? streamCursor : cursor)
                for try await frame in stream {
                    guard current(generation) else { return }
                    if frame.event == "hello" {
                        sidebarSyncing = true
                        snapshot.syncing = true
                        snapshot.live = true; snapshot.error = nil; snapshot.reconnecting = false; attempt = 0
                        watchGit()
                        publish()
                        // The bootstrap cursor precedes its reads. Opening from
                        // it is safe even after a crash, replay or daemon replacement.
                        let hello = try JSONValue.decode(Data(frame.data.utf8))
                        let gap = hello["gap"] == .bool(true)
                        let daemon = hello["daemonId"]?.stringValue
                        // Everything since the cursor follows, from the same process.
                        let continued = resuming && !gap && hello["resumed"] == .bool(true) && daemon != nil && daemon == verifiedDaemon
                        if resuming {
                            // Something was missed, or another process answered:
                            // it is read, and its owner checked, before anything
                            // is delivered.
                            if continued { verified = true } else { verified = false; try await reconcile(generation) }
                            beginDelivery(generation)
                            beginMessageDelivery(generation)
                            await intents.setOnline(deliveryAllowed)
                        }
                        verifiedDaemon = verified ? daemon : nil
                        if gap || hello["resumed"] != .bool(true) { streamCursor = hello["cursor"]?.stringValue ?? streamCursor }
                        await documents.opened(hello)
                        // Resuming, the read above already came after the gap.
                        if gap, !resuming { scheduleReconcile(generation) }
                        profileChanged()
                        // Reads the newest page each time, so a gap loses nothing.
                        await feed.connected()
                        await lookups.connected(gap: gap)
                        await wantReferences()
                        // Faces may have changed while away; picked up where
                        // it left off, their `profile.updated` follows instead.
                        usersMissing = []
                        if !continued { readAuthors(generation, again: Set(users.keys)) }
                        // Conversations and lists read again only for what they missed.
                        try await resyncSidebar(generation, resync: !continued)
                        continue
                    }
                    if DocumentStreams.isDocumentFrame(frame.event) {
                        await documents.frame(frame.event, data: frame.data)
                        continue
                    }
                    guard let event = try? JSONValue.decode(Data(frame.data.utf8)) else { continue }
                    await spaces.externalEvent(event)
                    guard current(generation) else { return }
                    if event["type"]?.stringValue?.hasPrefix("feed.") == true { await feed.receive(event) }
                    if FeedLookups.reads(event) { await lookups.receive(event) }
                    if event["type"] == .string("git.updated"),
                       let id = event["payload"]?["workspaceId"]?.stringValue,
                       gitInterest.contains(id), let value = event["payload"]?["git"],
                       let state = try? JSONDecoder().decode(WorkspaceLineChanges.self, from: JSONEncoder().encode(value)) {
                        receiveGit([id: state])
                    }
                    if event["type"] == .string("profile.updated") {
                        profileChanged()
                        authorChanged(event["payload"]?["userId"]?.stringValue, generation)
                    }
                    if event["type"] == .string("user_settings.updated"), let value = event["payload"]?["setting"],
                       let setting = try? JSONDecoder().decode(UserSetting.self, from: JSONEncoder().encode(value)) {
                        try await database().receiveSetting(setting.key, value: setting.value, version: setting.version)
                        snapshot.settings = try await database().settings()
                        derive()
                    }
                    // Events are delivery hints, never a durable checkpoint.
                    // Coalesce catalog invalidations; message token events go
                    // straight to the open conversation without rereading Home.
                    // A working agent's `agent.updated` comes with every word:
                    // laid over the held bootstrap, it is read again only when a
                    // version was missed (`AgentUpdate`).
                    if event["type"] == .string("agent.updated"), desktop != nil {
                        if agentIndex == nil, let desktop { agentIndex = AgentIndex(desktop) }
                        // Changed where it is held: nothing else of it is copied.
                        if let index = agentIndex {
                            switch AgentUpdate.apply(event["payload"] ?? .null, to: &desktop!, index: index) {
                            case .applied(let patches): agentsMoved(patches)
                            case .unchanged: break
                            case .reread: scheduleReconcile(generation)
                            }
                        }
                    } else if let type = event["type"]?.stringValue,
                       ["project.", "workspace.", "bot.", "task.", "agent.", "surface.", "user_settings."].contains(where: type.hasPrefix),
                       type != "agent.draft.updated" { scheduleReconcile(generation) }
                    // Taken in: applied, or home marked stale for it.
                    if let id = frame.id { streamCursor = id }
                }
            } catch AgentClientError.revoked {
                snapshot.live = false; snapshot.reconnecting = false
                snapshot.error = client.signsIn ? "Your sign-in to this server has ended. Sign in again." : "This device was disconnected. Pair it again."
                publish()
                return
            } catch {
                guard current(generation) else { return }
                snapshot.live = false
                snapshot.reconnecting = true
                publish()
            }
            await documents.closed()
            guard current(generation) else { return }
            snapshot.live = false
            snapshot.reconnecting = true
            publish()
            // A signed-in server's edge closes idle connections; come back
            // quickly (edge SSO contract §5: 0.1 s doubling to 10 s).
            let delay: Duration = client.signsIn ? .milliseconds(min(10_000, 100 << min(attempt, 7))) : .seconds(min(30, 1 << min(attempt, 5)))
            do { try await Task.sleep(for: delay) } catch { return }
            attempt += 1
        }
    }

    private func current(_ generation: Int) -> Bool { !stopped && !Task.isCancelled && self.generation == generation }

    private func resyncSidebar(_ generation: Int, resync: Bool) async throws {
        sidebarSyncing = true
        if !snapshot.syncing { snapshot.syncing = true; publish() }
        let ready = await spaces.externalResync(loadSidebar: false, resync: resync)
        guard current(generation) else { throw CancellationError() }
        guard ready else { throw AgentClientError.invalidResponse }
        sidebarSyncing = false
        snapshot.syncing = !snapshot.live || refresh != nil
        publish()
    }

    private func scheduleReconcile(_ generation: Int) {
        dirty = true
        signalled += 1
        guard refresh == nil else { return }
        refresh = Task {
            var failures = 0
            while dirty && current(generation) {
                do {
                    try await Task.sleep(for: .milliseconds(200))
                    dirty = false
                    try await reconcile(generation)
                    failures = 0
                } catch {
                    guard current(generation) else { break }
                    dirty = true
                    do { try await Task.sleep(for: .seconds(min(30, 1 << min(failures, 5)))) } catch { break }
                    failures += 1
                }
            }
            if self.generation == generation {
                refresh = nil
                if snapshot.live && !sidebarSyncing && snapshot.syncing {
                    snapshot.syncing = false
                    publish()
                }
            }
        }
    }

    private func reconcile(_ generation: Int) async throws {
        let asOf = signalled
        reads += 1
        let read = reads
        let database = try database()
        let settingRevision = await database.confirmedSettingsRevision()
        let value = try await client.decode(JSONValue.self, "GET", "/v0/bootstrap/desktop")
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: JSONEncoder().encode(value))
        guard current(generation) else { throw CancellationError() }
        // A device token is paired to one owner. A replacement daemon must
        // never receive the previous owner's pending writes or cached state.
        if let owner = value["profile"]?["userId"], owner == .null || owner.stringValue != nil {
            let bound = try await database.checkpoint("owner")?.value
            if let bound, bound != owner {
                let message = "This connection belongs to a different person. Pair it again."
                stopped = true; verified = false; self.generation += 1
                [runner, refresh, delivery, messageDelivery].forEach { $0?.cancel() }
                snapshot.live = false; snapshot.error = message; publish()
                await client.close()
                throw AgentClientError.status(409, code: "account_identity_changed", message: message)
            }
            if bound == nil { try await database.commit(.init(value: owner, cursor: nil), named: "owner") }
        } else if desktop.userSettings != nil {
            throw AgentClientError.invalidResponse
        }
        // A read is taken even when news came while it was on its way: what
        // of home is newer here (an agent laid over it by `AgentUpdate`)
        // stays, and that news already marked home stale, so the next read
        // follows. Dropping it instead, as this did, kept home at what it
        // held before agents began working for as long as they worked:
        // news came with every word. Only a read begun before the one
        // last taken is older in every part (Proofs/: `Refresh`).
        guard read > adopted else { return }
        try await database.commit(.init(value: value, cursor: desktop.cursor), named: "desktop", settings: desktop.userSettings ?? [], expectedSettingsRevision: settingRevision)
        guard current(generation), read > adopted else { return }
        adopted = read
        covered = max(covered, asOf)
        self.desktop = self.desktop.map { AgentUpdate.keepingNewer(desktop, than: $0) } ?? desktop
        agentIndex = nil
        verified = true
        cursor = desktop.cursor
        await feed.bootstrap(unread: desktop.feedUnread, cursor: desktop.cursor)
        snapshot.settings = try await database.settings()
        // This read began after these were taken, so it has them.
        if settling.contains(where: { $0.read < read }) {
            settling.removeAll { $0.read < read }
            await layIntents()
        }
        derive()
        deriveDirectory()
        readAuthors(generation)
    }

    // MARK: Authors

    /// A member's name or picture changed (`profile.updated` names them in
    /// a team): theirs is read again. The signed-in person's own comes with
    /// the bootstrap.
    private func authorChanged(_ id: String?, _ generation: Int) {
        guard let id, let desktop, let me = desktop.profile?.userId else { return }
        if id == me { return scheduleReconcile(generation) }
        guard SidebarRows.authors(desktop).contains(id) else { return }
        usersMissing.remove(id)
        readAuthors(generation, again: [id])
    }

    /// Reads the members the listed tasks belong to that this phone doesn't
    /// know yet, and `again` those that changed: one read at a time, an ask
    /// made meanwhile read when it lands. None outside a team.
    private func readAuthors(_ generation: Int, again: Set<String> = []) {
        usersAgain.formUnion(again)
        usersDirty = true
        guard usersRead == nil else { return }
        usersRead = Task {
            while usersDirty && current(generation) {
                usersDirty = false
                guard let desktop else { break }
                let authors = SidebarRows.authors(desktop)
                let wanted = authors.filter { (users[$0] == nil && !usersMissing.contains($0)) || usersAgain.contains($0) }.sorted()
                usersAgain.subtract(wanted)
                guard !wanted.isEmpty else { continue }
                var read: [TeamUser] = []
                do {
                    for start in stride(from: 0, to: wanted.count, by: 100) {
                        read += try await client.teamUsers(Array(wanted[start..<min(start + 100, wanted.count)]))
                    }
                } catch {
                    // Asked again when the stream comes back; meanwhile
                    // they wear their placeholders.
                    usersMissing.formUnion(wanted)
                    continue
                }
                guard current(generation) else { break }
                usersMissing.formUnion(Set(wanted).subtracting(read.map(\.id)))
                // Members no listed task belongs to any more are let go.
                var next = users.filter { authors.contains($0.key) }
                for user in read { next[user.id] = user }
                // A read that changed nothing redraws and writes nothing.
                guard next != users else { continue }
                users = next
                let kept = try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(next.values.sorted { $0.id < $1.id }))
                if let kept { try? await database().commit(.init(value: kept, cursor: nil), named: "users") }
                guard current(generation) else { break }
                derive()
                deriveDirectory()
            }
            if self.generation == generation { usersRead = nil }
        }
    }

    public func setProjectsHidden(_ hidden: Bool) async throws {
        try await setSetting(DesktopSettingKeys.projectsVisibility, value: .object(["projectsHidden": .bool(hidden)]))
    }

    /// The person's settings on this computer: edits on their way over the
    /// computer's copy.
    public func userSettings() -> [String: JSONValue] { snapshot.settings }

    /// Changes what new sessions start on, writing only the keys it changed.
    public func updateModelPreferences(_ change: @Sendable (inout ModelPreferences) -> Void) async throws {
        let settings = snapshot.settings
        var preferences = ModelPreferences(settings)
        change(&preferences)
        for write in preferences.writes(over: settings) { try await setSetting(write.key, value: write.value) }
    }

    /// The person started a session on `mode` (`ModelPreferences.started`).
    public func sessionStarted(_ mode: AgentWire.Mode) async throws {
        try await updateModelPreferences { $0 = $0.started(mode) }
    }

    public func cachedResource(_ key: String) async throws -> JSONValue? { try await database().checkpoint(key)?.value }

    public func keepResource(_ key: String, value: JSONValue) async throws {
        guard !stopped else { throw CancellationError() }
        try await database().commit(.init(value: value, cursor: nil), named: key)
    }

    func claimConversation(_ key: String, owner: SyncStorage.ConversationOwner) async throws {
        guard !stopped else { throw CancellationError() }
        try await database().claimConversation(key, owner: owner)
    }

    func keepConversation(_ key: String, value: Data, owner: SyncStorage.ConversationOwner) async throws -> Bool {
        guard !stopped else { throw CancellationError() }
        return try await database().commitConversation(value, named: key, owner: owner)
    }

    func keptConversation(_ key: String) async throws -> Data? { try await database().checkpointData(key) }

    public func setSetting(_ key: String, value: JSONValue) async throws {
        guard !stopped else { throw CancellationError() }
        let database = try database()
        try await database.enqueueSetting(key, value: value)
        snapshot.settings = try await database.settings()
        derive()
        if deliveryAllowed { beginDelivery(generation) }
    }

    private func beginDelivery(_ generation: Int) {
        settingsDeliveryDirty = true
        guard deliveryAllowed, delivery == nil else { return }
        delivery = Task {
            repeat {
                settingsDeliveryDirty = false
                await deliver(generation)
            } while current(generation) && settingsDeliveryDirty
            if self.generation == generation { delivery = nil }
        }
    }

    private func deliver(_ generation: Int) async {
        guard let database = try? database() else { return }
        var attempt = 0
        while let change = try? await database.pendingSettings().first {
            guard current(generation), deliveryAllowed else { return }
            do {
                struct Response: Decodable { var setting: UserSetting }
                let response = try await client.decode(Response.self, "PUT", "/v0/user-settings/\(AgentClient.escape(change.key))", json: .object([
                    "mutationId": .string(change.mutationID), "value": change.value, "updatedAt": .number(change.updatedAt)
                ]))
                guard current(generation), deliveryAllowed else { return }
                // Invalidate a bootstrap that began before this response.
                // Its full settings snapshot must not erase this newer winner.
                scheduleReconcile(generation)
                try await database.acknowledge(change, authoritative: response.setting)
                attempt = 0
                snapshot.settings = try await database.settings()
                derive()
            } catch {
                // Retain the original timestamp and ID, including across
                // suspension and relaunch. Reconnect retries the same intent.
                // A refusal is said; one that only didn't reach the computer
                // is the link's, which the title says.
                if let error = error as? AgentClientError, error == .revoked || (error.status.map { (400..<500).contains($0) } ?? false) {
                    snapshot.error = Store.describe(error)
                    publish()
                    return
                }
                do { try await Task.sleep(for: .seconds(min(30, 1 << min(attempt, 5)))) } catch { return }
                attempt += 1
            }
        }
    }

    /// Home drawn whole a moment on, for an agent's update that takes its
    /// row away or brings it back (`agentsMoved`); several drawn together,
    /// and nothing reaches home when the rows came out the same.
    private func deriveSoon() {
        guard deriving == nil else { return }
        deriving = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            deriving = nil
            let before = snapshot
            derive(publishing: false)
            deriveDirectory()
            if snapshot != before { publish() }
        }
    }

    private func derive(publishing: Bool = true) {
        snapshot.loaded = desktop != nil
        if let desktop {
            snapshot.allRows = overlay.apply(SidebarRows.make(desktop, settings: snapshot.settings, users: users, feed: feedRow))
            agentRows = [:]
            for index in snapshot.allRows.indices {
                snapshot.allRows[index].lineChanges = snapshot.allRows[index].workspaceId.flatMap { gitSnapshots[$0]?.visible }
                if SidebarRows.drawsAgent(snapshot.allRows[index]), let agentId = snapshot.allRows[index].agentId { agentRows[agentId] = index }
            }
            snapshot.rows = Rows.visible(snapshot.allRows)
            snapshot.unjoinedTasks = SidebarRows.unjoinedTasks(desktop)
            shownRows = Dictionary(snapshot.rows.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
            snapshot.userId = desktop.profile?.userId
            snapshot.profilePhoto = desktop.profile?.photo?.thumbhash
        }
        shareDirectory()
        if publishing { publish() }
    }

    /// The bots, tasks and Surfaces to `spaces`, which names and opens
    /// what messages refer to: on a daemon without the sidebar document
    /// it reads none of them itself.
    private func shareDirectory() {
        guard let desktop else { return }
        let owners = (desktop.bots ?? []) + (desktop.tasks ?? [])
        let surfaces = desktop.surfaces ?? []
        guard shared?.owners != owners || shared?.surfaces != surfaces else { return }
        shared = (owners, surfaces)
        let encoder = JSONEncoder()
        let json = owners.compactMap { owner in (try? encoder.encode(owner)).flatMap { try? JSONValue.decode($0) } }
        let listed = surfaces.map { AgentWire.Surface(id: $0.id, type: $0.type, name: $0.name, access: $0.access, policyVault: $0.policyVault) }
        let previous = sharing
        let spaces = spaces
        sharing = Task {
            await previous?.value
            await spaces.externalDirectory(owners: json, surfaces: listed)
        }
    }

    /// Agents' updates laid over the bootstrap (`AgentUpdate.Patch`): only
    /// what their rows draw moving redraws anything, and then only their
    /// rows and the rows above them, at once. A working agent's come with
    /// every word, and drew home whole a few times a second for a time
    /// that moves once a minute. A row coming or going draws it whole.
    private func agentsMoved(_ patches: [AgentUpdate.Patch]) {
        var titled = false
        var moved: [AgentWire.Agent] = []
        for patch in patches {
            for (before, after) in zip(patch.before, patch.after) {
                let was = SidebarRows.Drawn(before), now = SidebarRows.Drawn(after)
                guard was != now else { continue }
                if was.archived != now.archived { return deriveSoon() }
                if was.title != now.title { titled = true }
                moved.append(after)
            }
        }
        // Titles are what the Feed's directory reads of agents, and what references name.
        if titled { deriveDirectory(); shareDirectory() }
        guard !moved.isEmpty else { return }
        var redrawn = false
        for agent in moved {
            guard let index = agentRows[agent.id], snapshot.allRows.indices.contains(index), snapshot.allRows[index].agentId == agent.id else { continue }
            var row = snapshot.allRows[index]
            SidebarRows.redraw(&row, for: agent)
            // What the person did that the computer hasn't heard yet stays over it.
            if overlay.read.contains(agent.id) { row.unread = false; row.isNew = false }
            guard row != snapshot.allRows[index] else { continue }
            snapshot.allRows[index] = row
            if let shown = shownRows[row.id], snapshot.rows.indices.contains(shown), snapshot.rows[shown].id == row.id { snapshot.rows[shown] = row }
            redrawn = true
        }
        if redrawn { publish(rowsMoved: false) }
    }

    /// `rowsMoved`: rows may have come or gone, so the workspaces whose
    /// line counts are followed are looked at again.
    private func publish(rowsMoved: Bool = true) {
        if !snapshot.live { gitWatcher?.cancel(); gitWatcher = nil; gitInterest = [] }
        for listener in listeners.values { listener.yield(snapshot) }
        if rowsMoved { watchGit() }
    }

    /// One subscription set per open account, never one request per row.
    /// Renewing keeps the daemon's bounded watcher interest alive; changes
    /// themselves arrive on the existing event stream.
    private func watchGit() {
        guard snapshot.live, !stopped else { return }
        let ids = Set(snapshot.rows.compactMap(\.workspaceId))
        guard gitWatcher == nil || ids != gitInterest else { return }
        gitWatcher?.cancel()
        gitInterest = ids
        gitSnapshots = gitSnapshots.filter { ids.contains($0.key) }
        let generation = generation
        gitWatcher = Task {
            while current(generation), snapshot.live {
                do {
                    struct Response: Decodable { var snapshots: [String: WorkspaceLineChanges] }
                    let response = try await client.decode(Response.self, "POST", "/v0/git/watch", json: .object([
                        "workspaceIds": .array(ids.sorted().map(JSONValue.string)),
                    ]))
                    guard current(generation), gitInterest == ids else { return }
                    receiveGit(response.snapshots)
                } catch { if Task.isCancelled { return } }
                // Renewed within 30 seconds as before, but from 20 on with the
                // computer's heartbeat, while the radio is up for it anyway.
                do { try await RadioWake.shared.next(after: .seconds(20), by: .seconds(30)) } catch { return }
            }
        }
    }

    private func receiveGit(_ states: [String: WorkspaceLineChanges]) {
        var changed = false
        for (id, state) in states where gitInterest.contains(id) {
            guard state.scannedAt >= (gitSnapshots[id]?.scannedAt ?? 0), state != gitSnapshots[id] else { continue }
            gitSnapshots[id] = state
            changed = true
        }
        if changed { derive() }
    }

    // MARK: Feed

    /// The Feed's row follows its library: shown while there is a feed,
    /// with its count; a state that changes neither redraws nothing.
    private func followFeed() async {
        guard feedFollowing == nil else { return }
        await feed.start()
        let states = await feed.states()
        feedFollowing = Task { [weak self] in
            for await state in states {
                guard let self else { return }
                await self.feedChanged(state.available == true ? SidebarRows.FeedRow(unread: state.unread) : nil, items: state.items, loaded: state.loaded)
            }
        }
    }

    private func feedChanged(_ row: SidebarRows.FeedRow?, items: [FeedItem], loaded: Bool) async {
        if items != feedItems || loaded != feedLoaded {
            feedItems = items
            feedLoaded = loaded
            await wantReferences()
        }
        guard row != feedRow else { return }
        feedRow = row
        if desktop != nil { derive() }
    }

    // MARK: Feed directory

    /// Everything a Feed row can name, now and after every change that
    /// changes it: one per account, made here, off the main thread, and
    /// shared by every screen that joins rows with it.
    public func feedDirectories() -> AsyncStream<FeedDirectory> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: FeedDirectory.self, bufferingPolicy: .bufferingNewest(1))
        directoryListeners[id] = continuation
        continuation.yield(directory)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeDirectoryListener(id) } }
        return stream
    }

    private func removeDirectoryListener(_ id: UUID) { directoryListeners.removeValue(forKey: id) }

    /// A place's entries peeked at are on screen: what they name is
    /// looked up too, until another peek. Empty when it closes.
    public func feedPeeking(_ entries: [FeedItem]) async {
        guard entries != feedPeeked else { return }
        feedPeeked = entries
        await wantReferences()
    }

    /// Following's places are on screen: those it names are looked up too.
    public func feedPlacesShown(_ clusters: [FeedCluster]) async {
        guard clusters != feedClusters else { return }
        feedClusters = clusters
        await wantReferences()
    }

    private func followDirectory() async {
        guard directoryFollowing.isEmpty else { return }
        await lookups.start()
        let found = await lookups.states()
        let catalog = await artifacts.states()
        directoryFollowing = [
            Task { [weak self] in
                for await value in found { await self?.foundChanged(value) }
            },
            Task { [weak self] in
                for await state in catalog { await self?.artifactsChanged(state.items) }
            },
        ]
    }

    private func foundChanged(_ value: FeedLookups.Found) async {
        guard value != found else { return }
        found = value
        if deriveDirectory() { await wantReferences() }
    }

    private func artifactsChanged(_ items: [ArtifactSummary]) async {
        guard items != artifactItems else { return }
        artifactItems = items
        if deriveDirectory() { await wantReferences() }
    }

    /// Makes the directory again from what it is made of; whether it
    /// changed, which only then reaches anyone.
    @discardableResult
    private func deriveDirectory() -> Bool {
        let next = FeedDirectory.make(desktop: desktop, users: users, artifacts: artifactItems, found: found, titles: overlay.titles)
        guard next != directory else { return false }
        directory = next
        for listener in directoryListeners.values { listener.yield(next) }
        return true
    }

    /// Asks the lookups for what the Feed names and the directory lacks,
    /// once there is a bootstrap to know the rest by; and lets go of what
    /// nothing names any more, once the feed itself has been read.
    private func wantReferences() async {
        guard desktop != nil else { return }
        let named = feedItems + feedPeeked
        let wanted = directory.missing(named, clusters: feedClusters)
        let referenced = directory.references(named, clusters: feedClusters)
        await lookups.want(wanted, referenced: feedLoaded ? referenced : nil)
    }

    // MARK: Intents

    /// Opening a chat reads it: its dot goes at once, here and through any
    /// read of the computer that still calls it unread, until the computer
    /// has heard.
    public func markRead(_ agentId: String) async {
        guard !stopped, !waiting.contains(where: { $0.kind == .read && $0.target == agentId }) else { return }
        _ = try? await intents.enqueue(.read, target: agentId)
    }

    /// Archives a task, bot (`kind`) or subtask (`agent`): its row goes at
    /// once, with what nests under it, and comes back only if the computer
    /// refuses. Nil when it could not be kept.
    @discardableResult
    public func archive(kind: String, id: String) async -> Intent? {
        guard !stopped else { return nil }
        return try? await intents.enqueue(.archive, target: id, value: .object(["kind": .string(kind)]))
    }

    /// Leaves a task or Surface (`kind`): out of this person's list at once.
    @discardableResult
    public func leave(kind: String, id: String) async -> Intent? {
        guard !stopped else { return nil }
        return try? await intents.enqueue(.leave, target: id, value: .object(["kind": .string(kind)]))
    }

    /// Joins a Surface the person opened without being in it (desktop
    /// de78af49's `happyAgentRouterSurfaceOpen`): its row comes once the
    /// computer has it, as the `surface.updated` that says so reads home
    /// again. One already in their list, or one home doesn't know, sends
    /// nothing.
    public func join(surfaceId: String) async {
        guard !stopped, let desktop, let surface = desktop.surfaces?.first(where: { $0.id == surfaceId }),
              !surface.members.contains(where: { $0.userId == desktop.profile?.userId }),
              !waiting.contains(where: { $0.kind == .join && $0.target == surfaceId }) else { return }
        _ = try? await intents.enqueue(.join, target: surfaceId, value: .object(["kind": .string("surface")]))
    }

    /// Names a task or bot (`kind`): the row wears it at once.
    @discardableResult
    public func rename(kind: String, id: String, title: String) async -> Intent? {
        guard !stopped else { return nil }
        return try? await intents.enqueue(.rename, target: id, value: .object(["kind": .string(kind), "title": .string(title)]))
    }

    /// An answer to `questionId`, asked by `agentId`, kept and sent as one;
    /// whether the computer took it.
    public func answer(_ questionId: String, agentId: String, answers: [String: [String]]) async -> Intent? {
        guard !stopped else { return nil }
        let value: JSONValue = .object(["agentId": .string(agentId), "answers": .object(answers.mapValues { .array($0.map(JSONValue.string)) })])
        return try? await intents.enqueue(.answer, target: questionId, value: value)
    }

    /// The answer this phone has on its way to `questionId`, if any.
    public func pendingAnswer(_ questionId: String) -> [String: [String]]? {
        overlay.answers[questionId].flatMap(Self.answers)
    }

    nonisolated static func answers(_ value: JSONValue) -> [String: [String]]? {
        value["answers"]?.objectValue?.mapValues { $0.arrayValue?.compactMap(\.stringValue) ?? [] }
    }

    private func followIntents() {
        guard intentsFollowing == nil else { return }
        let intents = intents
        intentsFollowing = Task { [weak self] in
            let rejections = await intents.rejections()
            Task { [weak self] in
                for await rejection in rejections { await self?.refused(rejection) }
            }
            for await list in await intents.changes() {
                guard let self else { return }
                await self.intentsChanged(list)
            }
        }
    }

    private func intentsChanged(_ list: [Intent]) async {
        let ids = Set(list.map(\.id)), slots = Set(list.map(\.slot))
        var taken = false
        for intent in waiting where !intent.kind.isTodo && !intent.kind.isFeed && !ids.contains(intent.id) && !slots.contains(intent.slot) {
            if refusedIds.remove(intent.id) != nil { continue }
            settling.append((intent, reads))
            taken = true
        }
        settling.removeAll { slots.contains($0.intent.slot) }
        waiting = list
        // Read the computer again soon, so what it took stops leaning on
        // the overlay.
        if taken, deliveryAllowed { scheduleReconcile(generation) }
        await layIntents()
    }

    private func layIntents() async {
        let next = IntentOverlay((settling.map(\.intent) + waiting).filter { !refusedIds.contains($0.id) })
        guard next != overlay else { return }
        overlay = next
        await spaces.setOverlay(next)
        derive()
        deriveDirectory()
    }

    /// The computer said no: off the overlay, so what it holds shows
    /// again; the list says why for a moment.
    private func refused(_ rejection: IntentOutbox.Rejection) async {
        let id = rejection.intent.id
        if settling.contains(where: { $0.intent.id == id }) {
            settling.removeAll { $0.intent.id == id }
        } else if waiting.contains(where: { $0.id == id }) {
            refusedIds.insert(id)
        }
        await layIntents()
        // A refused read or seen entry is nothing to tell; a todo list tells its own.
        guard rejection.intent.kind != .read, !rejection.intent.kind.isTodo, !rejection.intent.kind.isFeed else { return }
        snapshot.notice = rejection.reason
        publish()
        noticeClearing?.cancel()
        noticeClearing = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self.clearNotice()
        }
    }

    private func clearNotice() {
        guard snapshot.notice != nil else { return }
        snapshot.notice = nil
        publish()
    }

    /// One intent, to the route that does it. Gone already counts as done;
    /// any other 4xx but 408 and 429 is a refusal.
    static func deliver(_ intent: Intent, client: AgentClient) async throws {
        let kind = intent.value["kind"]?.stringValue
        do {
            switch intent.kind {
            case .read:
                try await client.markRead(intent.target)
            case .rename:
                guard let title = intent.value["title"]?.stringValue else { return }
                switch kind {
                case "task": try await client.renameTask(intent.target, name: title, mutationId: intent.id)
                case "bot": try await client.renameBot(intent.target, name: title, mutationId: intent.id)
                case "surface": try await client.renameSurface(intent.target, name: title, mutationId: intent.id)
                default: return
                }
            case .archive:
                switch kind {
                case "bot": try await client.archiveBot(intent.target)
                case "agent": try await client.archiveAgent(intent.target, mutationId: intent.id)
                default: try await client.archiveTask(intent.target)
                }
            case .leave:
                if kind == "surface" { try await client.leaveSurface(intent.target, mutationId: intent.id) } else { try await client.leaveTask(intent.target, mutationId: intent.id) }
            case .join:
                try await client.joinSurface(intent.target, mutationId: intent.id)
            case .answer:
                guard let agentId = intent.value["agentId"]?.stringValue, let answers = answers(intent.value) else { return }
                _ = try await client.answerQuestion(agentId, questionId: intent.target, answers: answers, mutationId: intent.id)
            case .unarchive, .delete:
                throw IntentRefusal("")
            case .todoCreate, .todoText, .todoStatus, .todoMove, .feedSeen, .feedReadAll:
                // `TodoLibrary.deliver` and `FeedLibrary.deliver` send these.
                throw IntentRefusal("")
            }
        } catch AgentClientError.status(let status, _, _) where status == 404 || (status == 409 && intent.kind == .answer) {
            // Gone, or answered or abandoned already: nothing left to do.
        } catch let error as AgentClientError {
            if let status = error.status, (400..<500).contains(status), status != 408, status != 429 {
                throw IntentRefusal(Store.describe(error))
            }
            throw error
        }
    }

    public func deliveryEvents(for agentID: String) -> AsyncStream<DeliveryEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: DeliveryEvent.self)
        messageListeners[id] = (agentID, continuation)
        continuation.onTermination = { [weak self] _ in Task { await self?.removeMessageListener(id) } }
        return stream
    }

    private func removeMessageListener(_ id: UUID) { messageListeners.removeValue(forKey: id) }

    public func enqueueMessage(_ message: QueuedMessage) async throws {
        guard !stopped else { throw CancellationError() }
        try await database().enqueueMessage(message)
        beginMessageDelivery(generation)
    }

    public func retryMessage(_ id: String) async throws {
        guard var message = try await database().queuedMessages().first(where: { $0.id == id }) else { return }
        message.failure = nil
        try await database().updateMessage(message)
        beginMessageDelivery(generation)
    }

    /// Takes one picture or file out of a queued message the computer
    /// hasn't taken, stopping its delivery first so nothing writes the old
    /// one back; one left with nothing goes whole. The message as it is
    /// now (nil: gone), or nil, false when it was already sent.
    public func removeAttachment(_ id: String, _ piece: UploadProgressBoard.Piece) async throws -> (message: QueuedMessage?, removed: Bool) {
        holding.insert(id)
        defer {
            holding.remove(id)
            beginMessageDelivery(generation)
        }
        if deliveringMessage == id, let task = messageDelivery {
            task.cancel()
            await task.value
        }
        let database = try database()
        guard var message = try await database.queuedMessages().first(where: { $0.id == id }) else { return (nil, false) }
        switch piece {
        case .picture(let index):
            guard message.pictures.indices.contains(index) else { return (message, false) }
            message.pictures.remove(at: index)
        case .file(let index):
            guard let files = message.files, files.indices.contains(index) else { return (message, false) }
            message.files?.remove(at: index)
        }
        if message.text.isEmpty, message.pictures.isEmpty, (message.files ?? []).isEmpty {
            try await database.acknowledgeMessage(id)
            return (nil, true)
        }
        try await database.updateMessage(message)
        return (message, true)
    }

    public func queuedMessages(for agentID: String) async throws -> [QueuedMessage] {
        try await database().queuedMessages().filter { $0.agentID == agentID }
    }

    private func beginMessageDelivery(_ generation: Int) {
        messageDeliveryDirty = true
        guard deliveryAllowed, messageDelivery == nil else { return }
        messageDelivery = Task {
            repeat {
                messageDeliveryDirty = false
                await drainMessages(generation)
            } while current(generation) && messageDeliveryDirty
            if self.generation == generation { messageDelivery = nil }
        }
    }

    private func drainMessages(_ generation: Int) async {
        guard let database = try? database() else { return }
        var attempt = 0
        while current(generation) && deliveryAllowed {
            guard let queued = try? await database.queuedMessages() else { return }
            var blocked = Set<String>()
            var candidate: QueuedMessage?
            for message in queued {
                // One being changed holds its conversation's later ones, in order.
                if message.failure != nil || holding.contains(message.id) { blocked.insert(message.agentID) }
                else if !blocked.contains(message.agentID) { candidate = message; break }
            }
            guard var message = candidate else { return }
            deliveringMessage = message.id
            defer { deliveringMessage = nil }
            do {
                let migrated = try AttachmentRules.migratePictures(message, directory: attachmentDirectory)
                if migrated != message {
                    message = migrated
                    try await database.updateMessage(message)
                }
                if message.mode == nil {
                    message.mode = try await client.defaultMode(ModelPreferences(snapshot.settings))
                    guard current(generation) else { return }
                    try await database.updateMessage(message)
                }
                guard current(generation), message.mode != nil else { return }
                try await client.deliverMessage(message) { updated in try await database.updateMessage(updated) }
                guard current(generation) else { return }
                try await database.acknowledgeMessage(message.id)
                // A conversation checkpoint may still restore this send as
                // unaccepted. Its owned bytes live until an echoed-message
                // checkpoint durably removes the outgoing ID.
                for listener in messageListeners.values where listener.agentID == message.agentID { listener.continuation.yield(.accepted(message.id)) }
                attempt = 0
            } catch {
                guard current(generation) else { return }
                if let error = error as? AgentClientError, error == .revoked || (error.status.map { (400..<500).contains($0) } ?? false) {
                    // A later file may have failed after earlier progress was
                    // persisted. Mark that latest record, preserving its paths.
                    message = (try? await database.queuedMessages().first { $0.id == message.id }) ?? message
                    message.failure = Store.describe(error)
                    try? await database.updateMessage(message)
                    for listener in messageListeners.values where listener.agentID == message.agentID { listener.continuation.yield(.failed(message.id, message.failure ?? "")) }
                    continue
                }
                do { try await Task.sleep(for: .seconds(min(30, 1 << min(attempt, 5)))) } catch { return }
                attempt += 1
            }
        }
    }
}

/// The engine's database as the intent outbox's storage: the outbox is
/// made with the engine, before its database opens off the main thread.
final class EngineIntentStorage: IntentStorage, @unchecked Sendable {
    /// Set once, as the engine finishes its init.
    weak var engine: SyncEngine?

    private func storage() async throws -> SyncStorage {
        guard let engine else { throw CancellationError() }
        return try await engine.intentStorage()
    }

    func intents() async throws -> [Intent] { try await storage().intents() }
    func saveIntent(_ intent: Intent) async throws { try await storage().saveIntent(intent) }
    func updateIntent(_ intent: Intent) async throws { try await storage().updateIntent(intent) }
    func removeIntent(id: String) async throws { try await storage().removeIntent(id: id) }
}

extension SyncEngine {
    func intentStorage() throws -> SyncStorage {
        try database()
    }
}

/// The engine's checkpoints as the todo lists' keep, made with the engine
/// like `EngineIntentStorage`.
final class EngineResources: TodoKeep, FeedKeep, @unchecked Sendable {
    /// Set once, as the engine finishes its init.
    weak var engine: SyncEngine?

    func read(_ key: String) async -> JSONValue? { try? await engine?.cachedResource(key) }
    func write(_ key: String, _ value: JSONValue) async { try? await engine?.keepResource(key, value: value) }
}
