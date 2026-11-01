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
    public var settings: [String: JSONValue] = [:]
    /// The person signed in as a team user; nil outside a team.
    public var userId: String?
    public var error: String?
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
    private var intentsFollowing: Task<Void, Never>?
    private var noticeClearing: Task<Void, Never>?
    private let url: URL?
    private var storage: SyncStorage?
    private var desktop: DesktopSnapshot?
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
    private var revision = 0
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
    private var gitInterest: Set<String> = []
    private var gitSnapshots: [String: WorkspaceLineChanges] = [:]

    public init(client: AgentClient, directory: URL?) {
        self.client = client
        url = directory?.appendingPathComponent("direct.sqlite")
        offline = directory.map(OfflineFile.init(directory:))
        attachmentDirectory = (directory ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
            .appendingPathComponent("outbox-files", isDirectory: true)
        let forward = EngineIntentStorage()
        let intents = IntentOutbox(storage: forward, deliver: { try await SyncEngine.deliver($0, client: client) })
        self.intents = intents
        documents = DocumentLibrary(client: client, directory: directory)
        spaces = Store(client: client, offline: offline, intents: intents)
        forward.engine = self
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

    public func pause() async {
        generation += 1
        verified = false
        let pausedGeneration = generation
        let tasks = [runner, refresh, delivery, messageDelivery, usersRead, gitWatcher].compactMap { $0 }
        gitWatcher = nil; gitInterest = []
        runner = nil; refresh = nil; delivery = nil; messageDelivery = nil; usersRead = nil
        tasks.forEach { $0.cancel() }
        for task in tasks { await task.value }
        await intents.setOnline(false)
        guard generation == pausedGeneration else { return }
        await documents.closed()
        await spaces.pause()
        guard generation == pausedGeneration else { return }
        snapshot.live = false
        publish()
    }

    /// The phone has a way out again: try now, not when the backoff says.
    /// Does nothing while the engine is paused or already live.
    public func reconnect() async {
        guard !stopped, runner != nil, !snapshot.live else { return }
        // What failed while there was no network says nothing of the
        // computer: the header says "connecting…" until this try answers.
        // Cleared in the same turn as the pause, which publishes it.
        snapshot.error = nil
        await pause()
        start()
    }

    public func stop() async {
        stopped = true
        await pause()
        await spaces.stop()
        await documents.stop()
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
        do {
            let database = try database()
            if desktop == nil, let cached = try await database.checkpoint("desktop") {
                desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: JSONEncoder().encode(cached.value))
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
            guard current(generation) else { return }
            derive()
            await spaces.startExternal()
        } catch {
            snapshot.error = Store.describe(error)
            publish()
            return
        }
        var attempt = 0
        while current(generation) {
            do {
                sidebarSyncing = false
                snapshot.syncing = true
                publish()
                try await reconcile(generation)
                beginDelivery(generation)
                beginMessageDelivery(generation)
                await intents.setOnline(deliveryAllowed)
                let stream = try await client.events(after: cursor)
                for try await frame in stream {
                    guard current(generation) else { return }
                    if frame.event == "hello" {
                        sidebarSyncing = true
                        snapshot.syncing = true
                        snapshot.live = true; snapshot.error = nil; attempt = 0
                        watchGit()
                        publish()
                        // The bootstrap cursor precedes its reads. Opening from
                        // it is safe even after a crash, replay or daemon replacement.
                        let hello = try JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8))
                        await documents.opened(hello)
                        if hello["gap"] == .bool(true) { scheduleReconcile(generation) }
                        profileChanged()
                        // Faces may have changed while away.
                        usersMissing = []
                        readAuthors(generation, again: Set(users.keys))
                        try await resyncSidebar(generation)
                        continue
                    }
                    if DocumentStreams.isDocumentFrame(frame.event) {
                        await documents.frame(frame.event, data: frame.data)
                        continue
                    }
                    guard let event = try? JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8)) else { continue }
                    await spaces.externalEvent(event)
                    guard current(generation) else { return }
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
                    if let type = event["type"]?.stringValue,
                       ["project.", "workspace.", "bot.", "task.", "agent.", "surface.", "user_settings."].contains(where: type.hasPrefix),
                       type != "agent.draft.updated" { scheduleReconcile(generation) }
                }
            } catch AgentClientError.revoked {
                snapshot.live = false; snapshot.error = "This device was disconnected. Pair it again."
                publish()
                return
            } catch {
                guard current(generation) else { return }
                snapshot.live = false; snapshot.error = Store.describe(error)
                publish()
            }
            await documents.closed()
            guard current(generation) else { return }
            snapshot.live = false; publish()
            do { try await Task.sleep(for: .seconds(min(30, 1 << min(attempt, 5)))) } catch { return }
            attempt += 1
        }
    }

    private func current(_ generation: Int) -> Bool { !stopped && !Task.isCancelled && self.generation == generation }

    private func resyncSidebar(_ generation: Int) async throws {
        sidebarSyncing = true
        if !snapshot.syncing { snapshot.syncing = true; publish() }
        let ready = await spaces.externalResync(loadSidebar: false)
        guard current(generation) else { throw CancellationError() }
        guard ready else { throw AgentClientError.invalidResponse }
        sidebarSyncing = false
        snapshot.syncing = !snapshot.live || refresh != nil
        publish()
    }

    private func scheduleReconcile(_ generation: Int) {
        dirty = true
        revision += 1
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
        let revision = revision
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
        // An event during the read may be newer than part of this composed
        // snapshot. The coalesced next read owns that invalidation.
        guard self.revision == revision else { return }
        try await database.commit(.init(value: value, cursor: desktop.cursor), named: "desktop", settings: desktop.userSettings ?? [], expectedSettingsRevision: settingRevision)
        guard current(generation) else { return }
        self.desktop = desktop
        verified = true
        cursor = desktop.cursor
        snapshot.settings = try await database.settings()
        // This read began after these were taken, so it has them.
        if settling.contains(where: { $0.read < read }) {
            settling.removeAll { $0.read < read }
            await layIntents()
        }
        derive()
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
            }
            if self.generation == generation { usersRead = nil }
        }
    }

    public func setProjectsHidden(_ hidden: Bool) async throws {
        try await setSetting(DesktopSettingKeys.projectsVisibility, value: .object(["projectsHidden": .bool(hidden)]))
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

    func keepConversation(_ key: String, value: JSONValue, owner: SyncStorage.ConversationOwner) async throws -> Bool {
        guard !stopped else { throw CancellationError() }
        return try await database().commitConversation(.init(value: value, cursor: nil), named: key, owner: owner)
    }

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
                snapshot.error = Store.describe(error)
                publish()
                if let error = error as? AgentClientError, error == .revoked || (error.status.map { (400..<500).contains($0) } ?? false) { return }
                do { try await Task.sleep(for: .seconds(min(30, 1 << min(attempt, 5)))) } catch { return }
                attempt += 1
            }
        }
    }

    private func derive() {
        snapshot.loaded = desktop != nil
        if let desktop {
            snapshot.allRows = overlay.apply(SidebarRows.make(desktop, settings: snapshot.settings, users: users))
            for index in snapshot.allRows.indices {
                snapshot.allRows[index].lineChanges = snapshot.allRows[index].workspaceId.flatMap { gitSnapshots[$0]?.visible }
            }
            snapshot.rows = Rows.visible(snapshot.allRows)
            snapshot.userId = desktop.profile?.userId
        }
        publish()
    }

    private func publish() {
        if !snapshot.live { gitWatcher?.cancel(); gitWatcher = nil; gitInterest = [] }
        for listener in listeners.values { listener.yield(snapshot) }
        watchGit()
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
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
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
        for intent in waiting where !ids.contains(intent.id) && !slots.contains(intent.slot) {
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
        let next = IntentOverlay(settling.map(\.intent) + waiting)
        guard next != overlay else { return }
        overlay = next
        await spaces.setOverlay(next)
        derive()
    }

    /// The computer said no: off the overlay, so what it holds shows
    /// again; the list says why for a moment.
    private func refused(_ rejection: IntentOutbox.Rejection) async {
        let id = rejection.intent.id
        if settling.contains(where: { $0.intent.id == id }) {
            settling.removeAll { $0.intent.id == id }
            await layIntents()
        } else if waiting.contains(where: { $0.id == id }) {
            refusedIds.insert(id)
        }
        // A refused read is nothing to tell.
        guard rejection.intent.kind != .read else { return }
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
            case .answer:
                guard let agentId = intent.value["agentId"]?.stringValue, let answers = answers(intent.value) else { return }
                _ = try await client.answerQuestion(agentId, questionId: intent.target, answers: answers, mutationId: intent.id)
            case .unarchive, .delete:
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
                    message.mode = try await client.defaultMode()
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
