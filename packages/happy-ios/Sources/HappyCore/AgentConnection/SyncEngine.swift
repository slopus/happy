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
    public var error: String?
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
    private var generation = 0
    private var stopped = false
    private var cursor: String?
    private var dirty = false
    private var revision = 0
    private var sidebarSyncing = false

    public init(client: AgentClient, directory: URL?) {
        self.client = client
        url = directory?.appendingPathComponent("direct.sqlite")
        offline = directory.map(OfflineFile.init(directory:))
        attachmentDirectory = (directory ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
            .appendingPathComponent("outbox-files", isDirectory: true)
        spaces = Store(client: client, offline: offline)
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
        let tasks = [runner, refresh, delivery, messageDelivery].compactMap { $0 }
        runner = nil; refresh = nil; delivery = nil; messageDelivery = nil
        tasks.forEach { $0.cancel() }
        for task in tasks { await task.value }
        guard generation == pausedGeneration else { return }
        await spaces.pause()
        guard generation == pausedGeneration else { return }
        snapshot.live = false
        publish()
    }

    public func stop() async {
        stopped = true
        await pause()
        await spaces.stop()
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
            snapshot.settings = try await database.settings()
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
                let stream = try await client.events(after: cursor)
                for try await frame in stream {
                    guard current(generation) else { return }
                    if frame.event == "hello" {
                        sidebarSyncing = true
                        snapshot.syncing = true
                        snapshot.live = true; snapshot.error = nil; attempt = 0
                        publish()
                        // The bootstrap cursor precedes its reads. Opening from
                        // it is safe even after a crash, replay or daemon replacement.
                        let hello = try JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8))
                        if hello["gap"] == .bool(true) { scheduleReconcile(generation) }
                        profileChanged()
                        try await resyncSidebar(generation)
                        continue
                    }
                    guard let event = try? JSONDecoder().decode(JSONValue.self, from: Data(frame.data.utf8)) else { continue }
                    await spaces.externalEvent(event)
                    guard current(generation) else { return }
                    if event["type"] == .string("profile.updated") { profileChanged() }
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
        derive()
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
            snapshot.allRows = SidebarRows.make(desktop, settings: snapshot.settings)
            snapshot.rows = Rows.visible(snapshot.allRows)
        }
        publish()
    }

    private func publish() { for listener in listeners.values { listener.yield(snapshot) } }

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
                if message.failure != nil { blocked.insert(message.agentID) }
                else if !blocked.contains(message.agentID) { candidate = message; break }
            }
            guard var message = candidate else { return }
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