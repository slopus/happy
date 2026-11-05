import Foundation
import HappyWire

/// One folder of a vault as a screen shows it: its live children, the
/// uploads into it, and whether it is in the Trash.
public struct VaultFolderState: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        /// Nothing kept and the computer not read yet.
        case loading
        case ready
        /// No such vault or folder (`404`).
        case missing
    }

    public var status = Status.loading
    /// Unsorted; `VaultSort` orders them.
    public var entries: [VaultEntry] = []
    /// Entries with a change on its way.
    public var waiting: Set<String> = []
    public var uploads: [VaultUploadState] = []
    /// The folder or one above it is in the Trash: shown, not changed.
    public var inTrash = false
    /// Shown from the phone: the computer hasn't been read this time.
    public var kept = true

    public init() {}
}

/// A file on its way into a vault.
public struct VaultUploadState: Equatable, Sendable, Identifiable {
    public enum Phase: Equatable, Sendable {
        case sending
        /// The bytes are there; the entry is being made.
        case placing
        case failed(String)
    }

    public var id: String
    public var name: String
    public var parentId: String?
    public var kind: VaultEntry.Kind
    /// The file it makes a new version of; nil for a new entry.
    public var replacing: String?
    public var total: Int
    public var sent: Int
    public var phase: Phase

    public var fraction: Double { total > 0 ? min(1, Double(sent) / Double(total)) : 1 }
}

/// A vault's Trash as its screen shows it.
public struct VaultTrashState: Equatable, Sendable {
    public var loaded = false
    /// Most recently deleted first.
    public var items: [VaultTrashItem] = []
    public var waiting: Set<String> = []

    public init() {}
}

/// What happens to an entry a screen shows.
public enum VaultEntryEvent: Equatable, Sendable {
    case entry(VaultEntry)
    /// Gone for good from the Trash.
    case removed
    /// A version was pinned or unpinned.
    case pinned(number: Int, pinned: Bool)
}

/// Where the library keeps folders between launches: the account's checkpoints.
public typealias VaultKeep = TodoKeep

/// The account's vaults: each folder a screen opens is read from disk,
/// then whole from the computer, then kept current by `vault.*` events
/// along each entry's version chain, read again on a gap. A change a
/// person makes shows at once and is undone when the computer refuses it.
/// Uploads are resumable: a broken connection carries on from the bytes
/// the computer has.
public actor VaultLibrary {
    private struct Folder {
        var status = VaultFolderState.Status.loading
        var read = false
        var reading: Task<Void, Never>?
        var again = false
        /// Changed by events while a read was under way.
        var touched: Set<String> = []
        var listeners: [UUID: AsyncStream<VaultFolderState>.Continuation] = [:]
        var published: VaultFolderState?
        var keeping: Task<Void, Never>?
    }

    private struct Vault {
        var entries: [String: VaultEntry] = [:]
        /// By folder ID, "" for the root.
        var folders: [String: Folder] = [:]
        var trash = VaultTrashState()
        var trashListeners: [UUID: AsyncStream<VaultTrashState>.Continuation] = [:]
        var trashReading: Task<Void, Never>?
        /// The Trash changed while it was being read: read it once more.
        var trashAgain = false
        /// What the computer last said.
        var settings: VaultSettings?
        /// The newest policy sent and not yet answered, shown over it.
        var settingsEdit: (token: UUID, retention: VaultRetention)?
        var changeListeners: [UUID: AsyncStream<Void>.Continuation] = [:]
        var settingsListeners: [UUID: AsyncStream<VaultSettings?>.Continuation] = [:]
        var entryListeners: [String: [UUID: AsyncStream<VaultEntryEvent>.Continuation]] = [:]
        var uploads: [VaultUploadState] = []
    }

    /// A change on its way, laid over what the computer last said.
    private struct Pending {
        var surfaceId: String
        var entryId: String
        /// What shows meanwhile.
        var shown: VaultEntry
    }

    public static func resource(_ surfaceId: String, folder: String?) -> String { "vault:\(surfaceId):\(folder ?? "")" }
    /// Bytes per upload request: large enough that a request's round trip
    /// costs little, small enough that a broken one costs little.
    static let chunk = 8 * 1024 * 1024

    private let routes: VaultRoutes
    private let keep: VaultKeep
    private let events: @Sendable () async -> AsyncStream<Store.ConversationEvent>
    private let now: @Sendable () -> Double
    private var vaults: [String: Vault] = [:]
    private var pending: [UUID: Pending] = [:]
    private var uploadTasks: [String: Task<Void, Never>] = [:]
    private var uploadFiles: [String: URL] = [:]
    private var uploadPublish: Set<String> = []
    /// The file each upload makes, named once, so a retry after a lost
    /// answer finds the file it made instead of making another.
    private var placements: [String: (id: String, mutationId: String)] = [:]
    private var names: [String: String] = [:]
    private var following: Task<Void, Never>?

    public init(routes: VaultRoutes, keep: VaultKeep, events: @escaping @Sendable () async -> AsyncStream<Store.ConversationEvent>,
                now: @escaping @Sendable () -> Double = { (Date().timeIntervalSince1970 * 1000).rounded(.down) }) {
        self.routes = routes
        self.keep = keep
        self.events = events
        self.now = now
    }

    // MARK: Following

    private func start() {
        guard following == nil else { return }
        let events = events
        following = Task { [weak self] in
            for await event in await events() {
                switch event {
                case .resync: await self?.resync()
                case .event(let envelope): await self?.receive(envelope)
                }
            }
        }
    }

    public func stop() {
        following?.cancel()
        following = nil
        uploadTasks.values.forEach { $0.cancel() }
        uploadTasks = [:]
        for (id, vault) in vaults {
            vault.trashReading?.cancel()
            vault.trashListeners.values.forEach { $0.finish() }
            vault.settingsListeners.values.forEach { $0.finish() }
            vault.entryListeners.values.forEach { $0.values.forEach { $0.finish() } }
            for (key, folder) in vault.folders {
                folder.reading?.cancel()
                folder.listeners.values.forEach { $0.finish() }
                vaults[id]?.folders[key]?.listeners = [:]
            }
        }
    }

    private func resync() {
        for (surfaceId, vault) in vaults {
            for (key, folder) in vault.folders where !folder.listeners.isEmpty { refresh(surfaceId, folder: key.isEmpty ? nil : key) }
            if !vault.trashListeners.isEmpty { refreshTrash(surfaceId) }
            if !vault.settingsListeners.isEmpty { Task { await readSettings(surfaceId) } }
            // What a preview or a history shows, which may be in no open folder.
            for id in vault.entryListeners.keys {
                let folder = vault.entries[id]?.isFolder ?? false
                Task { [routes] in
                    if let location = try? await routes.vaultEntry(surfaceId, id, folder: folder) { self.take(location.entry) }
                }
            }
        }
    }

    private func receive(_ event: JSONValue) async {
        let payload = event["payload"]
        guard let surfaceId = payload?["surfaceId"]?.stringValue ?? (payload?["file"] ?? payload?["folder"])?["surfaceId"]?.stringValue, var vault = vaults[surfaceId] else { return }
        switch event["type"]?.stringValue {
        case "vault.settings.updated":
            guard let version = payload?["version"]?.stringValue, vault.settings?.version != version else { return }
            if var settings = vault.settings, settings.version == payload?["previousVersion"]?.stringValue,
               let retention = payload?["changes"]?["retention"].flatMap({ try? JSONDecoder().decode(VaultRetention.self, from: JSONEncoder().encode($0)) }) {
                settings.retention = retention
                settings.updatedAt = payload?["changes"]?["updatedAt"]?.numberValue ?? settings.updatedAt
                settings.version = version
                vaults[surfaceId]?.settings = settings
                publishSettings(surfaceId)
            } else {
                await readSettings(surfaceId)
            }
            return
        case "vault.version.updated":
            guard let entryId = payload?["fileId"]?.stringValue, let number = payload?["number"]?.numberValue, let pinned = payload?["pinned"]?.boolValue else { return }
            for listener in vault.entryListeners[entryId]?.values ?? [:].values { listener.yield(.pinned(number: Int(number), pinned: pinned)) }
            return
        default:
            break
        }
        // The Trash hears of every deletion, restore and removal, wherever it was.
        let type = event["type"]?.stringValue ?? ""
        if type.hasSuffix(".removed") || payload?["changes"]?["deletedAt"] != nil, vault.trash.loaded {
            refreshTrash(surfaceId)
        }
        let outcome = VaultReducer.receive(event, surfaceId: surfaceId, into: &vault.entries,
                                           watched: { vault.entryListeners[$0]?.isEmpty == false },
                                           open: { vault.folders[$0 ?? ""] != nil })
        switch outcome {
        case .ignored:
            return
        case .applied(let id):
            for key in vault.folders.keys where vault.folders[key]?.reading != nil { vault.folders[key]?.touched.insert(id) }
            vaults[surfaceId] = vault
            if let entry = vault.entries[id] { notify(surfaceId, id, .entry(entry)) }
            changed(surfaceId)
        case .read(let id, let folder):
            guard let location = try? await routes.vaultEntry(surfaceId, id, folder: folder) else { return }
            take(location.entry)
        case .removed(let id):
            vaults[surfaceId] = vault
            notify(surfaceId, id, .removed)
            changed(surfaceId)
        }
    }

    private func notify(_ surfaceId: String, _ entryId: String, _ event: VaultEntryEvent) {
        for listener in vaults[surfaceId]?.entryListeners[entryId]?.values ?? [:].values { listener.yield(event) }
    }

    /// Takes an entry the computer answered with, unless a newer copy is held.
    private func take(_ entry: VaultEntry) {
        guard var vault = vaults[entry.surfaceId] else { return }
        guard VaultReducer.accept(entry, into: &vault.entries) else { return }
        for key in vault.folders.keys where vault.folders[key]?.reading != nil { vault.folders[key]?.touched.insert(entry.id) }
        vaults[entry.surfaceId] = vault
        notify(entry.surfaceId, entry.id, .entry(entry))
        changed(entry.surfaceId)
    }

    // MARK: Folders

    private static func key(_ folder: String?) -> String { folder ?? "" }

    /// Folder `folder` of a vault (nil: its root) now and after every
    /// change: what was kept, then the computer.
    public func states(_ surfaceId: String, folder: String?) async -> AsyncStream<VaultFolderState> {
        start()
        await open(surfaceId, folder: folder)
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: VaultFolderState.self, bufferingPolicy: .bufferingNewest(1))
        let key = Self.key(folder)
        vaults[surfaceId]?.folders[key]?.listeners[id] = continuation
        vaults[surfaceId]?.folders[key]?.published = nil
        continuation.yield(state(surfaceId, folder: folder))
        continuation.onTermination = { [weak self] _ in Task { await self?.unlisten(surfaceId, key, id) } }
        if vaults[surfaceId]?.folders[key]?.read == false { refresh(surfaceId, folder: folder) }
        return stream
    }

    private func unlisten(_ surfaceId: String, _ key: String, _ id: UUID) { vaults[surfaceId]?.folders[key]?.listeners[id] = nil }

    private func open(_ surfaceId: String, folder: String?) async {
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        let key = Self.key(folder)
        guard vaults[surfaceId]?.folders[key] == nil else { return }
        vaults[surfaceId]?.folders[key] = Folder()
        guard let kept = await keep.read(Self.resource(surfaceId, folder: folder)) else { return }
        let entries = (kept["entries"]?.arrayValue ?? []).compactMap(VaultEntry.init(json:))
        for entry in entries { VaultReducer.accept(entry, into: &vaults[surfaceId, default: Vault()].entries) }
        if vaults[surfaceId]?.folders[key]?.status == .loading { vaults[surfaceId]?.folders[key]?.status = .ready }
        publish(surfaceId, folder: key)
    }

    /// Reads folder `folder` whole again; one under way is followed by one more.
    public func refresh(_ surfaceId: String, folder: String?) {
        let key = Self.key(folder)
        guard var item = vaults[surfaceId]?.folders[key] else { return }
        if item.reading != nil { item.again = true; vaults[surfaceId]?.folders[key] = item; return }
        item.touched = []
        item.reading = Task { await self.read(surfaceId, folder: folder) }
        vaults[surfaceId]?.folders[key] = item
    }

    private func read(_ surfaceId: String, folder: String?) async {
        let key = Self.key(folder)
        defer {
            vaults[surfaceId]?.folders[key]?.reading = nil
            if vaults[surfaceId]?.folders[key]?.again == true {
                vaults[surfaceId]?.folders[key]?.again = false
                refresh(surfaceId, folder: folder)
            }
        }
        var fetched: [VaultEntry] = []
        var cursor: String?
        do {
            repeat {
                let page = try await routes.vaultEntries(surfaceId, parentId: folder, pageCursor: cursor)
                fetched += page.items
                cursor = page.next
            } while cursor != nil && !Task.isCancelled
        } catch AgentClientError.status(404, _, _) {
            vaults[surfaceId]?.folders[key]?.status = .missing
            vaults[surfaceId]?.folders[key]?.read = true
            publish(surfaceId, folder: key)
            return
        } catch {
            return
        }
        guard var vault = vaults[surfaceId] else { return }
        let touched = vault.folders[key]?.touched ?? []
        let read = Set(fetched.map(\.id))
        // What the read no longer lists left the folder, unless an event since says otherwise.
        for entry in VaultReducer.children(folder, in: vault.entries) where !read.contains(entry.id) && !touched.contains(entry.id) && !entry.version.isEmpty {
            vault.entries[entry.id] = nil
        }
        var renewed: [VaultEntry] = []
        for entry in fetched {
            if touched.contains(entry.id), let held = vault.entries[entry.id], VaultReducer.newer(held.version, than: entry.version) { continue }
            if vault.entries[entry.id] != entry, vault.entryListeners[entry.id] != nil { renewed.append(entry) }
            vault.entries[entry.id] = entry
        }
        vault.folders[key]?.touched = []
        vault.folders[key]?.status = .ready
        vault.folders[key]?.read = true
        vaults[surfaceId] = vault
        for entry in renewed { notify(surfaceId, entry.id, .entry(entry)) }
        changed(surfaceId)
    }

    private func state(_ surfaceId: String, folder key: String) -> VaultFolderState {
        guard let vault = vaults[surfaceId], let item = vault.folders[key] else { return VaultFolderState() }
        let folder: String? = key.isEmpty ? nil : key
        let shown = shownEntries(surfaceId)
        var state = VaultFolderState()
        state.status = item.status
        state.entries = VaultReducer.children(folder, in: shown)
        let ids = Set(state.entries.map(\.id))
        state.waiting = Set(pending.values.filter { $0.surfaceId == surfaceId && ids.contains($0.entryId) }.map(\.entryId))
        state.uploads = vault.uploads.filter { $0.parentId == folder }
        state.inTrash = VaultReducer.inTrash(folder, in: shown)
        state.kept = !item.read
        // A folder made here shows at once.
        if state.status == .loading, !state.entries.isEmpty { state.status = .ready }
        return state
    }

    private func state(_ surfaceId: String, folder: String?) -> VaultFolderState { state(surfaceId, folder: Self.key(folder)) }

    private func shownEntries(_ surfaceId: String) -> [String: VaultEntry] {
        var entries = vaults[surfaceId]?.entries ?? [:]
        for change in pending.values where change.surfaceId == surfaceId { entries[change.entryId] = change.shown }
        return entries
    }

    private func publish(_ surfaceId: String, folder key: String) {
        guard let item = vaults[surfaceId]?.folders[key], !item.listeners.isEmpty else { return }
        let next = state(surfaceId, folder: key)
        guard next != item.published else { return }
        vaults[surfaceId]?.folders[key]?.published = next
        for listener in item.listeners.values { listener.yield(next) }
    }

    /// Publishes every open folder of the vault, and keeps the read ones.
    private func changed(_ surfaceId: String) {
        guard let vault = vaults[surfaceId] else { return }
        for listener in vault.changeListeners.values { listener.yield() }
        for key in vault.folders.keys {
            publish(surfaceId, folder: key)
            scheduleKeep(surfaceId, folder: key)
        }
    }

    /// Writes a read folder down once changes settle.
    private func scheduleKeep(_ surfaceId: String, folder key: String) {
        guard let item = vaults[surfaceId]?.folders[key], item.read, item.status == .ready, item.keeping == nil else { return }
        vaults[surfaceId]?.folders[key]?.keeping = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            await self?.write(surfaceId, folder: key)
        }
    }

    private func write(_ surfaceId: String, folder key: String) async {
        vaults[surfaceId]?.folders[key]?.keeping = nil
        guard let vault = vaults[surfaceId] else { return }
        let folder: String? = key.isEmpty ? nil : key
        let entries = VaultReducer.children(folder, in: vault.entries).filter { !$0.version.isEmpty }.sorted { $0.id < $1.id }
        await keep.write(Self.resource(surfaceId, folder: folder), .object(["entries": .array(entries.map(\.json))]))
    }

    // MARK: Entries

    /// An entry a screen shows, now (when known) and as it changes.
    public func entryEvents(_ surfaceId: String, _ entryId: String, known: VaultEntry? = nil) -> AsyncStream<VaultEntryEvent> {
        start()
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        if let known { VaultReducer.accept(known, into: &vaults[surfaceId, default: Vault()].entries) }
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: VaultEntryEvent.self)
        vaults[surfaceId]?.entryListeners[entryId, default: [:]][id] = continuation
        if let entry = vaults[surfaceId]?.entries[entryId] { continuation.yield(.entry(entry)) }
        continuation.onTermination = { [weak self] _ in Task { await self?.unlistenEntry(surfaceId, entryId, id) } }
        return stream
    }

    private func unlistenEntry(_ surfaceId: String, _ entryId: String, _ id: UUID) {
        vaults[surfaceId]?.entryListeners[entryId]?[id] = nil
        if vaults[surfaceId]?.entryListeners[entryId]?.isEmpty == true { vaults[surfaceId]?.entryListeners[entryId] = nil }
    }

    /// The entry as last known here, with the change on its way over it.
    public func entry(_ surfaceId: String, _ entryId: String) -> VaultEntry? { shownEntries(surfaceId)[entryId] }

    /// Reads one entry and where it is.
    public func location(_ surfaceId: String, _ entryId: String, folder: Bool) async throws -> VaultLocation {
        let location = try await routes.vaultEntry(surfaceId, entryId, folder: folder)
        if vaults[surfaceId] != nil { take(location.entry) }
        return location
    }

    /// Whether `entryId` can't go into `folder`: itself or a folder inside it.
    public func isInside(_ surfaceId: String, folder: String?, entryId: String) -> Bool {
        VaultReducer.contains(entryId, folder, in: shownEntries(surfaceId))
    }

    // MARK: Changes

    /// Shows `shown` while `request` goes to the computer with the entry's
    /// version; a conflict is read again and tried once more. What the
    /// computer answers is kept; a refusal undoes it and throws.
    @discardableResult
    private func change(_ surfaceId: String, _ entryId: String, shown: (VaultEntry) -> VaultEntry,
                        _ request: @Sendable (_ ifMatch: String, _ mutationId: String, _ folder: Bool) async throws -> VaultEntry) async throws -> VaultEntry {
        guard let held = entry(surfaceId, entryId) else { throw AgentClientError.status(404, code: "not_found", message: nil) }
        let id = UUID()
        pending[id] = Pending(surfaceId: surfaceId, entryId: entryId, shown: shown(held))
        changed(surfaceId)
        defer {
            pending[id] = nil
            changed(surfaceId)
        }
        var version = vaults[surfaceId]?.entries[entryId]?.version ?? held.version
        let mutationId = ClientID.make()
        for attempt in 0..<2 {
            do {
                let answer = try await request(version, mutationId, held.isFolder)
                take(answer)
                return answer
            } catch AgentClientError.status(409, "conflict", _) where attempt == 0 {
                let fresh = try await routes.vaultEntry(surfaceId, entryId, folder: held.isFolder)
                take(fresh.entry)
                version = fresh.entry.version
            }
        }
        throw AgentClientError.status(409, code: "conflict", message: nil)
    }

    public func rename(_ surfaceId: String, _ entryId: String, to name: String) async throws {
        let routes = routes
        try await change(surfaceId, entryId, shown: { var entry = $0; entry.name = name; return entry }) { ifMatch, mutationId, folder in
            try await routes.updateVaultEntry(surfaceId, entryId, folder: folder, name: name, parent: nil, ifMatch: ifMatch, mutationId: mutationId)
        }
    }

    public func move(_ surfaceId: String, _ entryId: String, to parent: VaultParent) async throws {
        let routes = routes
        try await change(surfaceId, entryId, shown: { var entry = $0; entry.parentId = parent.id; return entry }) { ifMatch, mutationId, folder in
            try await routes.updateVaultEntry(surfaceId, entryId, folder: folder, name: nil, parent: parent, ifMatch: ifMatch, mutationId: mutationId)
        }
    }

    /// To the Trash.
    public func delete(_ surfaceId: String, _ entryId: String) async throws {
        let routes = routes, now = now()
        try await change(surfaceId, entryId, shown: { var entry = $0; entry.deletedAt = now; return entry }) { ifMatch, mutationId, folder in
            try await routes.deleteVaultEntry(surfaceId, entryId, folder: folder, ifMatch: ifMatch, mutationId: mutationId)
        }
        if vaults[surfaceId]?.trash.loaded == true { refreshTrash(surfaceId) }
    }

    /// A new folder, shown at once.
    @discardableResult
    public func createFolder(_ surfaceId: String, parentId: String?, name: String) async throws -> VaultEntry {
        let id = TodoID.make()
        let made = VaultEntry(id: id, surfaceId: surfaceId, parentId: parentId, name: name, kind: .folder, createdAt: now(), updatedAt: now())
        let token = UUID()
        pending[token] = Pending(surfaceId: surfaceId, entryId: id, shown: made)
        changed(surfaceId)
        defer {
            pending[token] = nil
            changed(surfaceId)
        }
        let entry = try await routes.createVaultEntry(surfaceId, id: id, parentId: parentId, name: name, folder: true, uploadId: nil, mutationId: ClientID.make())
        take(entry)
        return entry
    }

    /// A version made from an earlier one: the restore of history.
    @discardableResult
    public func restoreVersion(_ surfaceId: String, _ entryId: String, number: Int) async throws -> VaultVersion? {
        let routes = routes
        let box = VersionBox()
        try await change(surfaceId, entryId, shown: { $0 }) { ifMatch, mutationId, _ in
            let answer = try await routes.createVaultVersion(surfaceId, entryId, uploadId: nil, fromVersion: number, ifMatch: ifMatch, mutationId: mutationId)
            box.set(answer.version)
            return answer.entry
        }
        return box.value
    }

    public func pin(_ surfaceId: String, _ entryId: String, number: Int, pinned: Bool) async throws -> VaultVersion {
        let version = try await routes.pinVaultVersion(surfaceId, entryId, number: number, pinned: pinned, mutationId: ClientID.make())
        notify(surfaceId, entryId, .pinned(number: number, pinned: version.pinned))
        return version
    }

    // MARK: Trash

    public func trashStates(_ surfaceId: String) -> AsyncStream<VaultTrashState> {
        start()
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: VaultTrashState.self, bufferingPolicy: .bufferingNewest(1))
        vaults[surfaceId]?.trashListeners[id] = continuation
        continuation.yield(vaults[surfaceId]?.trash ?? VaultTrashState())
        continuation.onTermination = { [weak self] _ in Task { await self?.unlistenTrash(surfaceId, id) } }
        refreshTrash(surfaceId)
        return stream
    }

    private func unlistenTrash(_ surfaceId: String, _ id: UUID) { vaults[surfaceId]?.trashListeners[id] = nil }

    private func refreshTrash(_ surfaceId: String) {
        guard vaults[surfaceId]?.trashReading == nil else { vaults[surfaceId]?.trashAgain = true; return }
        vaults[surfaceId]?.trashReading = Task {
            // Changes in a burst read once.
            try? await Task.sleep(for: .milliseconds(150))
            await self.readTrash(surfaceId)
        }
    }

    private func readTrash(_ surfaceId: String) async {
        defer {
            vaults[surfaceId]?.trashReading = nil
            if vaults[surfaceId]?.trashAgain == true {
                vaults[surfaceId]?.trashAgain = false
                refreshTrash(surfaceId)
            }
        }
        var items: [VaultTrashItem] = []
        var cursor: String?
        do {
            repeat {
                let page = try await routes.vaultTrash(surfaceId, pageCursor: cursor)
                items += page.items
                cursor = page.next
            } while cursor != nil
        } catch {
            return
        }
        vaults[surfaceId]?.trash.items = items
        vaults[surfaceId]?.trash.loaded = true
        publishTrash(surfaceId)
    }

    private func publishTrash(_ surfaceId: String) {
        guard let vault = vaults[surfaceId] else { return }
        var state = vault.trash
        let waiting = Set(pending.values.filter { $0.surfaceId == surfaceId }.map(\.entryId))
        state.waiting = waiting
        state.items = state.items.filter { !waiting.contains($0.entry.id) }
        for listener in vault.trashListeners.values { listener.yield(state) }
    }

    /// Brings a Trash item back where it was, or to `parent`.
    public func restore(_ surfaceId: String, _ item: VaultTrashItem, to parent: VaultParent? = nil, name: String? = nil) async throws {
        let id = UUID()
        var shown = item.entry
        shown.deletedAt = nil
        if let parent { shown.parentId = parent.id }
        if let name { shown.name = name }
        pending[id] = Pending(surfaceId: surfaceId, entryId: item.entry.id, shown: shown)
        publishTrash(surfaceId)
        defer {
            pending[id] = nil
            publishTrash(surfaceId)
            changed(surfaceId)
        }
        let entry = try await routes.restoreVaultEntry(surfaceId, item.entry.id, folder: item.entry.isFolder, parent: parent, name: name, ifMatch: item.entry.version, mutationId: ClientID.make())
        take(entry)
        vaults[surfaceId]?.trash.items.removeAll { $0.entry.id == entry.id }
        refreshTrash(surfaceId)
    }

    // MARK: Settings

    public func settingsStates(_ surfaceId: String) -> AsyncStream<VaultSettings?> {
        start()
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: VaultSettings?.self, bufferingPolicy: .bufferingNewest(1))
        vaults[surfaceId]?.settingsListeners[id] = continuation
        continuation.yield(vaults[surfaceId]?.settings)
        continuation.onTermination = { [weak self] _ in Task { await self?.unlistenSettings(surfaceId, id) } }
        Task { await readSettings(surfaceId) }
        return stream
    }

    private func unlistenSettings(_ surfaceId: String, _ id: UUID) { vaults[surfaceId]?.settingsListeners[id] = nil }

    private func readSettings(_ surfaceId: String) async {
        guard let settings = try? await routes.vaultSettings(surfaceId) else { return }
        settle(surfaceId, settings)
    }

    /// Takes settings the computer answered with, unless newer ones are held.
    private func settle(_ surfaceId: String, _ settings: VaultSettings) {
        guard vaults[surfaceId]?.settings.map({ !VaultReducer.newer($0.version, than: settings.version) }) ?? true else { return }
        vaults[surfaceId]?.settings = settings
        publishSettings(surfaceId)
    }

    private func publishSettings(_ surfaceId: String) {
        guard let vault = vaults[surfaceId] else { return }
        var shown = vault.settings
        if let edit = vault.settingsEdit { shown?.retention = edit.retention }
        for listener in vault.settingsListeners.values { listener.yield(shown) }
    }

    /// Replaces the policy; shown at once, undone when refused. A later
    /// edit shows over this one whatever answers first.
    public func setRetention(_ surfaceId: String, _ retention: VaultRetention) async throws {
        let token = UUID()
        vaults[surfaceId]?.settingsEdit = (token, retention)
        publishSettings(surfaceId)
        defer {
            if vaults[surfaceId]?.settingsEdit?.token == token { vaults[surfaceId]?.settingsEdit = nil }
            publishSettings(surfaceId)
        }
        let settings = try await routes.updateVaultSettings(surfaceId, retention: retention, mutationId: ClientID.make())
        settle(surfaceId, settings)
    }

    // MARK: Reads passed through

    /// What matches `query`; its items are held, so they can be changed.
    public func search(_ surfaceId: String, query: String) async throws -> (results: [VaultSearchResult], truncated: Bool) {
        let found = try await routes.vaultSearch(surfaceId, query: query)
        for result in found.results { take(result.entry) }
        return found
    }

    /// A signal each time anything in the vault changes here, for what
    /// isn't a folder's state (a search on screen).
    public func changes(_ surfaceId: String) -> AsyncStream<Void> {
        start()
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        vaults[surfaceId]?.changeListeners[id] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.unlistenChanges(surfaceId, id) } }
        return stream
    }

    private func unlistenChanges(_ surfaceId: String, _ id: UUID) { vaults[surfaceId]?.changeListeners[id] = nil }

    /// An entry's surviving versions, newest first, and its activity.
    public func history(_ surfaceId: String, _ entryId: String) async throws -> (versions: [VaultVersion], activity: [VaultActivity]) {
        let routes = routes
        async let versions = Self.all { try await routes.vaultVersions(surfaceId, entryId, pageCursor: $0) }
        async let activity = Self.all { try await routes.vaultActivity(surfaceId, entryId, folder: false, pageCursor: $0) }
        return (try await versions, try await activity)
    }

    /// Every page of a paged read.
    private static func all<Item: Sendable>(_ page: @Sendable (String?) async throws -> VaultPage<Item>) async throws -> [Item] {
        var items: [Item] = []
        var cursor: String?
        repeat {
            let next = try await page(cursor)
            items += next.items
            cursor = next.next
        } while cursor != nil && !Task.isCancelled
        return items
    }

    public func version(_ surfaceId: String, _ entryId: String, number: Int?) async throws -> VaultVersion {
        try await routes.vaultVersion(surfaceId, entryId, number: number)
    }

    /// Names for team user IDs, read where not known yet.
    public func names(_ ids: Set<String>) async -> [String: String] {
        let missing = ids.subtracting(names.keys)
        if !missing.isEmpty, let users = try? await routes.teamUsers(Array(missing)) {
            for user in users where !user.name.isEmpty { names[user.id] = user.name }
        }
        return names.filter { ids.contains($0.key) }
    }

    /// A free name for `name` in folder `parentId`, as known here.
    public func freeName(_ surfaceId: String, parentId: String?, for name: String) -> String {
        VaultReducer.free(name, among: VaultReducer.children(parentId, in: shownEntries(surfaceId)).map(\.name))
    }

    /// The live entry named `name` in folder `parentId`, compared as the computer does.
    public func sibling(_ surfaceId: String, parentId: String?, named name: String) -> VaultEntry? {
        let lowered = name.precomposedStringWithCanonicalMapping.lowercased()
        return VaultReducer.children(parentId, in: shownEntries(surfaceId)).first { $0.name.precomposedStringWithCanonicalMapping.lowercased() == lowered }
    }

    // MARK: Uploads

    /// Sends the file at `file` into folder `parentId` as `name`: a new
    /// file or artifact, or a new version of `replacing`. The library owns
    /// the file from here and removes it once the entry is made.
    @discardableResult
    public func upload(_ surfaceId: String, parentId: String?, file: URL, name: String, kind: VaultEntry.Kind = .file, replacing: String? = nil) -> String {
        start()
        if vaults[surfaceId] == nil { vaults[surfaceId] = Vault() }
        let id = UUID().uuidString
        let total = ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.intValue ?? 0
        vaults[surfaceId]?.uploads.append(VaultUploadState(id: id, name: name, parentId: parentId, kind: kind, replacing: replacing, total: total, sent: 0, phase: .sending))
        uploadFiles[id] = file
        changed(surfaceId)
        run(surfaceId, upload: id)
        return id
    }

    /// Tries a failed upload again, from what the computer already has.
    public func retryUpload(_ surfaceId: String, _ id: String) {
        guard let index = vaults[surfaceId]?.uploads.firstIndex(where: { $0.id == id }) else { return }
        vaults[surfaceId]?.uploads[index].phase = .sending
        changed(surfaceId)
        run(surfaceId, upload: id)
    }

    public func cancelUpload(_ surfaceId: String, _ id: String) {
        placements[id] = nil
        uploadTasks[id]?.cancel()
        uploadTasks[id] = nil
        vaults[surfaceId]?.uploads.removeAll { $0.id == id }
        if let file = uploadFiles.removeValue(forKey: id) { try? FileManager.default.removeItem(at: file) }
        changed(surfaceId)
    }

    private var staged: [String: VaultUpload] = [:]

    private func run(_ surfaceId: String, upload id: String) {
        guard uploadTasks[id] == nil else { return }
        uploadTasks[id] = Task { [weak self] in
            await self?.send(surfaceId, upload: id)
        }
    }

    private func send(_ surfaceId: String, upload id: String) async {
        defer { uploadTasks[id] = nil }
        guard let item = vaults[surfaceId]?.uploads.first(where: { $0.id == id }), let file = uploadFiles[id] else { return }
        do {
            let upload = try await transfer(surfaceId, item, file: file)
            setUpload(surfaceId, id) { $0.phase = .placing; $0.sent = $0.total }
            if let replacing = item.replacing {
                let routes = routes
                try await change(surfaceId, replacing, shown: { $0 }) { ifMatch, mutationId, _ in
                    try await routes.createVaultVersion(surfaceId, replacing, uploadId: upload.id, fromVersion: nil, ifMatch: ifMatch, mutationId: mutationId).entry
                }
            } else {
                let placement = placements[id] ?? (TodoID.make(), ClientID.make())
                placements[id] = placement
                let made = try await routes.createVaultEntry(surfaceId, id: placement.id, parentId: item.parentId, name: item.name, folder: false, uploadId: upload.id, mutationId: placement.mutationId)
                take(made)
            }
            staged[id] = nil
            placements[id] = nil
            vaults[surfaceId]?.uploads.removeAll { $0.id == id }
            if let file = uploadFiles.removeValue(forKey: id) { try? FileManager.default.removeItem(at: file) }
            changed(surfaceId)
        } catch is CancellationError {
        } catch {
            if case AgentClientError.status(404, _, _) = error { staged[id] = nil }
            let reason = Self.reason(error)
            setUpload(surfaceId, id) { $0.phase = .failed(reason) }
        }
    }

    /// What a failed upload says: the computer's words, else its code;
    /// empty when it couldn't be reached.
    static func reason(_ error: Error) -> String {
        if case AgentClientError.status(_, let code, let message) = error { return message ?? code ?? "" }
        return ""
    }

    private func setUpload(_ surfaceId: String, _ id: String, _ change: (inout VaultUploadState) -> Void) {
        guard let index = vaults[surfaceId]?.uploads.firstIndex(where: { $0.id == id }) else { return }
        change(&vaults[surfaceId]!.uploads[index])
        changed(surfaceId)
    }

    /// Sends the file's bytes, resuming from what the computer has; a
    /// broken request is tried again a few times before giving up.
    private func transfer(_ surfaceId: String, _ item: VaultUploadState, file: URL) async throws -> VaultUpload {
        var upload: VaultUpload
        if let held = staged[item.id] {
            upload = (try? await routes.vaultUpload(held.id)) ?? held
        } else {
            upload = try await routes.createVaultUpload(size: item.total)
            staged[item.id] = upload
        }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var failures = 0
        while !upload.complete {
            try Task.checkCancellation()
            let start = upload.received
            try handle.seek(toOffset: UInt64(start))
            let bytes = try handle.read(upToCount: min(Self.chunk, upload.size - start)) ?? Data()
            do {
                upload = try await routes.appendVaultUpload(upload.id, bytes: bytes, start: start, total: upload.size) { [weak self] sent in
                    Task { await self?.progress(surfaceId, item.id, start + sent) }
                }
                failures = 0
            } catch AgentClientError.status(409, _, _) {
                upload = try await routes.vaultUpload(upload.id)
            } catch let error as AgentClientError where error.status.map({ (400..<500).contains($0) && $0 != 408 && $0 != 429 }) == true {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failures += 1
                guard failures <= 4 else { throw error }
                try await Task.sleep(for: .seconds(Double(1 << failures)))
                upload = (try? await routes.vaultUpload(upload.id)) ?? upload
            }
            staged[item.id] = upload
            progress(surfaceId, item.id, upload.received)
        }
        return upload
    }

    /// Progress is published at most ten times a second.
    private func progress(_ surfaceId: String, _ id: String, _ sent: Int) {
        guard let index = vaults[surfaceId]?.uploads.firstIndex(where: { $0.id == id }), vaults[surfaceId]!.uploads[index].phase == .sending else { return }
        vaults[surfaceId]!.uploads[index].sent = max(vaults[surfaceId]!.uploads[index].sent, sent)
        guard uploadPublish.insert(surfaceId).inserted else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            await self?.flushProgress(surfaceId)
        }
    }

    private func flushProgress(_ surfaceId: String) {
        uploadPublish.remove(surfaceId)
        guard let vault = vaults[surfaceId] else { return }
        for key in vault.folders.keys { publish(surfaceId, folder: key) }
    }
}

/// Carries a version out of a `@Sendable` request.
private final class VersionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var held: VaultVersion?
    var value: VaultVersion? { lock.withLock { held } }
    func set(_ version: VaultVersion?) { lock.withLock { held = version } }
}
