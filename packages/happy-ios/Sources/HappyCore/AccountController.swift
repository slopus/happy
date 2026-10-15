import Foundation
import GRDB
import HappyCrypto
import HappyStore
import HappyWire

/// Only this controller opens sessions. Account transitions are serialized
/// across suspension points, and only the active session runs sync.
@MainActor
public final class AccountController {
    public enum State {
        case signedOut
        case signedIn(AccountSession)
    }

    public private(set) var state: State = .signedOut {
        didSet { onChange?(state) }
    }
    public var onChange: ((State) -> Void)?
    /// Candidate server for onboarding/add-account; sessions use the registry.
    public let serverConfig: ServerConfig
    public let clientID: String
    /// Settings of the active account. This instance is replaced on a
    /// switch; read it again after account observations rather than retaining
    /// it across account transitions.
    public private(set) var localSettings: LocalSettings
    public private(set) var isAddingAccount = false

    private let accountCredentialStore: AccountCredentialStore
    private let rnServerImport: @Sendable () -> ImportedAccountServer
    private let configuredStoreDirectory: URL?
    /// Frozen after the one background bootstrap. A failed setup keeps this
    /// controller in memory, matching the composition root's former nil URL.
    private var storageDirectory: URL?
    private var storagePreparation: Task<URL?, Never>?
    private let transport: HTTPTransport
    private let connector: WebSocketConnector
    private let appState: @Sendable () async -> String
    private let deliveryActivity: @Sendable (Bool) async -> Void
    private let settingsFactory: ((String) -> KeyValueStore)?
    private var settingsStores: [String: LocalSettings] = [:]
    private var memoryStores: [String: LocalStore] = [:]
    private var registry = AccountRegistry()
    private var registryLoaded = false
    private var busy = false
    private var observers: [UUID: AccountsObserver] = [:]
    private var cancelProfileObservation: (() -> Void)?
    // Internal injection seams exercise the actual suspension and I/O paths.
    var registryWriter = AccountRegistryWriter()
    var prepareAccountStorage: @Sendable (URL?) throws -> Void = AccountStorageDirectory.prepare
    var readRegistryDisplays: @Sendable ([AccountRegistryEntry], [String: LocalStore], URL?) throws -> [String: AccountDisplay?] = AccountController.readDisplays
    var prepareSessionDirectory: @Sendable (URL, String) throws -> Void = AccountSession.prepareDirectory
    /// How every account's pictures are fetched.
    var pictureFetch: AccountPictures.Fetch = { [downloader = PictureDownloader()] url, limit in
        await downloader.data(url, limit: limit)
    }
    private var pictureCaches: [AccountSummary.ID: AccountPictures] = [:]
    private var registryRevision: UInt64 = 0
    private var profileGeneration: UInt64 = 0
    private var profileGenerations: [String: UInt64] = [:]
    private var profileObservationGeneration: UInt64 = 0
    private var profileDirty = false
    private var profilePersistenceTask: Task<Void, Never>?

    public init(
        serverConfig: ServerConfig,
        clientID: String,
        credentialStore: CredentialStore,
        storeDirectory: URL?,
        localSettings: KeyValueStore = InMemoryKeyValueStore(),
        accountCredentialStore: AccountCredentialStore? = nil,
        rnServerImport: @escaping @Sendable () -> ImportedAccountServer = { RNServerConfigImporter.readFromDocuments() },
        localSettingsFactory: ((String) -> KeyValueStore)? = nil,
        transport: HTTPTransport = URLSessionTransport(),
        connector: WebSocketConnector = URLSessionWebSocketConnector(),
        appState: @escaping @Sendable () async -> String = AccountSession.Dependencies.alwaysActive,
        deliveryActivity: @escaping @Sendable (Bool) async -> Void = AccountSession.Dependencies.noDeliveryActivity
    ) {
        self.serverConfig = serverConfig
        self.clientID = clientID
        self.accountCredentialStore = accountCredentialStore ?? InMemoryAccountCredentialStore(sharedStore: credentialStore)
        self.rnServerImport = rnServerImport
        self.configuredStoreDirectory = storeDirectory
        self.localSettings = LocalSettings(storage: localSettings)
        self.settingsFactory = localSettingsFactory
        self.transport = transport
        self.connector = connector
        self.appState = appState
        self.deliveryActivity = deliveryActivity
    }

    public var session: AccountSession? {
        if case .signedIn(let session) = state { return session }
        return nil
    }

    public var accounts: [AccountSummary] {
        registry.entries.sorted { $0.addedOrder < $1.addedOrder }.map { entry in
            let display = entry.display
            return AccountSummary(id: entry.id, serverURL: entry.serverURL,
                           name: display?.name, username: display?.username,
                           avatarURL: display?.avatarURL, avatarThumbhash: display?.avatarThumbhash,
                           isActive: session?.keys.anonID == entry.id,
                           usesSharedItem: entry.location == .shared,
                           serverConfirmed: entry.serverConfirmed)
        }
    }

    /// The selected account whose RN server file needs manual confirmation.
    /// It has no AccountSession and never uses its credentials on the network.
    public var pendingServerConfirmation: AccountSummary? {
        guard session == nil else { return nil }
        return accounts.first { $0.id == registry.activeID && !$0.serverConfirmed }
    }

    /// The pictures of a signed-in account, active or not, kept in its own
    /// directory; nil for an account that isn't signed in here.
    public func pictures(for id: AccountSummary.ID) -> AccountPictures? {
        guard registry.entries.contains(where: { $0.id == id }) else { return nil }
        if let pictures = pictureCaches[id] { return pictures }
        // Registry entries are published only after bootstrap has resolved.
        let directory = storageDirectory.map {
            AccountSession.accountDirectory(directory: $0, id: id).appendingPathComponent("pictures", isDirectory: true)
        }
        let pictures = AccountPictures(owner: id, directory: directory, fetch: pictureFetch)
        pictureCaches[id] = pictures
        return pictures
    }

    /// Delivers a snapshot now and on inventory, active-account or profile
    /// changes. Retain the token for as long as the switcher needs updates.
    public func observeAccounts(_ handler: @escaping ([AccountSummary]) -> Void) -> AccountsObservation {
        let id = UUID()
        let observation = AccountsObservation { [weak self] in
            Task { @MainActor [weak self] in self?.observers.removeValue(forKey: id) }
        }
        observers[id] = AccountsObserver(observation: observation, handler: handler)
        handler(accounts)
        return observation
    }

    private func notifyAccounts() {
        let snapshot = accounts
        for observer in Array(observers.values) {
            guard let token = observer.observation, !token.isCancelled else { continue }
            observer.handler(snapshot)
        }
    }

    /// The signed-in account whose store holds `sessionId`, so a tapped
    /// notification opens in the account it came from: the active account
    /// first, then the others in added order. Inactive stores are read with
    /// GRDB's read-only configuration, like `AccountDisplay.read`. Accounts
    /// waiting for server confirmation have no session to open and are
    /// skipped. Nil when no store holds it.
    public func accountHoldingSession(_ sessionId: String) async throws -> AccountSummary.ID? {
        let activeStore = session?.store
        let activeID = session?.keys.anonID
        let others = registry.entries
            .filter { $0.serverConfirmed && $0.id != activeID }
            .sorted { $0.addedOrder < $1.addedOrder }
        let memoryStores = self.memoryStores
        let directory = storageDirectory
        return try await Task.detached {
            var lookupError: (any Error)?
            if let activeStore {
                do { if try activeStore.session(id: sessionId) != nil { return activeID } }
                catch { lookupError = error }
            }
            for entry in others {
                if let store = memoryStores[entry.id] {
                    do { if try store.session(id: sessionId) != nil { return entry.id } }
                    catch { lookupError = lookupError ?? error }
                    continue
                }
                guard let directory else { continue }
                let url = AccountSession.accountDirectory(directory: directory, id: entry.id).appendingPathComponent("store.sqlite")
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                do {
                    if try await Self.readSession(id: sessionId, at: url) { return entry.id }
                } catch {
                    lookupError = lookupError ?? error
                }
            }
            if let lookupError { throw lookupError }
            return nil
        }.value
    }

    /// Read-only connections can meet the previous pool's final checkpoint
    /// while it removes WAL sidecars. Busy handling covers SQL locks; one
    /// bounded reopen also covers the sidecar-open race.
    private nonisolated static func readSession(id: String, at url: URL) async throws -> Bool {
        var configuration = Configuration()
        configuration.readonly = true
        configuration.busyMode = .timeout(2)
        for attempt in 0..<2 {
            do {
                return try await DatabaseQueue(path: url.path, configuration: configuration).read { db in
                    try SessionRecord.exists(db, key: id)
                }
            } catch {
                guard attempt == 0, let error = error as? DatabaseError,
                      [.SQLITE_BUSY, .SQLITE_LOCKED, .SQLITE_CANTOPEN].contains(error.resultCode) else { throw error }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        return false
    }

    /// Presents onboarding without logging out. Cancel leaves the current
    /// account and session intact. signIn adds and activates the result.
    public func beginAddingAccount() { isAddingAccount = true }
    public func cancelAddingAccount() { isAddingAccount = false }

    public func switchAccount(to id: AccountSummary.ID) async throws {
        guard !busy else { throw AccountSwitchError.operationInProgress }
        busy = true
        defer { finishOperation() }
        let values = try await reconcile()
        guard let entry = registry.entries.first(where: { $0.id == id }), let value = values[id] else {
            throw AccountSwitchError.unknownAccount
        }
        guard session?.keys.anonID != id else { return }
        let next = entry.serverConfirmed ? try await makeSession(value.credentials, entry: entry) : nil
        var updated = registry
        updated.activeID = id
        updated = try await persistRegistry(updated, preservingProfilesSince: profileGeneration)
        if let next {
            await activate(next, registry: updated)
        } else {
            await selectUnconfirmed(registry: updated)
        }
    }

    /// Settles a pending imported server without probing or sending a token
    /// first. Session creation is gated on the validated, persisted choice.
    public func confirmServer(_ url: URL, for id: AccountSummary.ID) async throws {
        guard !busy else { throw AccountSwitchError.operationInProgress }
        busy = true
        defer { finishOperation() }
        let url = try ServerConfig.validate(url.absoluteString)
        let values = try await reconcile()
        guard let index = registry.entries.firstIndex(where: { $0.id == id }),
              let value = values[id] else { throw AccountSwitchError.unknownAccount }
        var updated = registry
        updated.entries[index].serverURL = url
        updated.entries[index].serverConfirmed = true
        updated.activeID = id
        updated = try await persistRegistry(updated, preservingProfilesSince: profileGeneration)
        registry = updated
        let next = try await makeSession(value.credentials, entry: updated.entries[index])
        await activate(next, registry: registry)
    }

    public var authService: AuthService {
        AuthService(api: HappyAPI(serverURL: authenticationServerURL, clientID: clientID, transport: transport))
    }

    private var authenticationServerURL: URL {
        isAddingAccount ? serverConfig.serverURL : (session?.api.serverURL ?? serverConfig.serverURL)
    }

    public func checkServer(_ url: URL) async -> ServerCheckResult {
        await ServerProbe(transport: transport).check(url)
    }

    public func restore() async {
        guard session == nil, !busy else { return }
        busy = true
        defer { finishOperation() }
        do {
            let values = try await reconcile()
            guard let id = registry.activeID,
                  let entry = registry.entries.first(where: { $0.id == id }), let value = values[id] else { return }
            if entry.serverConfirmed {
                let next = try await makeSession(value.credentials, entry: entry)
                await activate(next, registry: registry)
            } else {
                await selectUnconfirmed(registry: registry)
            }
        } catch {
            // A locked Keychain or an unreadable cache never deletes credentials.
        }
    }

    /// Adds/reauthenticates and activates; other signed-in accounts survive.
    public func signIn(_ credentials: Credentials) async throws {
        guard !busy else { throw AccountSwitchError.operationInProgress }
        busy = true
        defer { finishOperation() }
        let id = try accountID(credentials)
        _ = try await reconcile()
        let generation = profileGeneration
        let existing = registry.entries.first { $0.id == id }
        guard existing?.serverConfirmed != false else { throw AccountSwitchError.serverNeedsConfirmation }
        let location = try existing?.location ?? (accountCredentialStore.sharedIsEmpty() ? .shared : .own)
        let entry = AccountRegistryEntry(id: id, serverURL: authenticationServerURL, location: location,
                                         addedOrder: existing?.addedOrder ?? nextOrder, display: existing?.display)
        let next = try await makeSession(credentials, entry: entry)
        try accountCredentialStore.save(StoredAccountCredentials(credentials: credentials, serverURL: entry.serverURL), id: id, location: location)
        var updated = registry
        updated.entries.removeAll { $0.id == id }
        updated.entries.append(entry)
        updated.activeID = id
        updated = try await persistRegistry(updated, preservingProfilesSince: generation)
        isAddingAccount = false
        await activate(next, registry: updated)
    }

    /// Signs out the active account only. The next account by added order
    /// becomes active. Failures leave credentials and the active UI intact.
    public func signOut() async {
        guard let id = session?.keys.anonID else {
            if !busy { localSettings.clear() }
            return
        }
        try? await signOut(accountID: id)
    }

    public func signOut(accountID id: AccountSummary.ID) async throws {
        guard !busy else { throw AccountSwitchError.operationInProgress }
        busy = true
        defer { finishOperation() }
        let values = try await reconcile()
        guard let entry = registry.entries.first(where: { $0.id == id }) else { throw AccountSwitchError.unknownAccount }
        await unregisterPushToken(of: entry, credentials: values[id]?.credentials)
        var updated = registry
        let generation = profileGeneration
        updated.entries.removeAll { $0.id == id }
        let wasActive = session.map { $0.keys.anonID == id } ?? (registry.activeID == id)
        let oldSession = wasActive ? session : nil
        let following = updated.entries.sorted { $0.addedOrder < $1.addedOrder }.first
        let next: AccountSession?
        if wasActive, let following, following.serverConfirmed, let value = values[following.id] {
            next = try await makeSession(value.credentials, entry: following)
        } else {
            next = nil
        }
        if wasActive { updated.activeID = following?.id }
        updated = try await persistRegistry(updated, preservingProfilesSince: generation)
        do {
            try accountCredentialStore.remove(id: id, location: entry.location)
        } catch {
            _ = try? await persistRegistry(registry, preservingProfilesSince: profileGeneration)
            throw error
        }
        if wasActive {
            stopProfileObservation()
            await oldSession?.stop()
        }
        registry = updated
        profileGenerations.removeValue(forKey: id)
        let closingPictures = pictureCaches.removeValue(forKey: id)
        if wasActive {
            if let next {
                localSettings = settings(for: next.keys.anonID)
                state = .signedIn(next)
                observeProfile(of: next)
            } else {
                localSettings = LocalSettings(storage: InMemoryKeyValueStore())
                state = .signedOut
            }
        }
        // Publish the new root before erasing/removing the old cache. Even
        // readers retaining its pool then see empty data, then a closed
        // store, never a live account.
        notifyAccounts()
        // No picture is written once this returns, so none lands in the
        // directory being removed.
        await closingPictures?.close()
        var cleanupError: Error?
        do {
            let removedStore = oldSession?.store ?? memoryStores[id]
            let directory = storageDirectory
            try await Task.detached {
                // Erased, then closed before its files go: a reader still
                // holding the store reads `LocalStoreError.closed`, never a
                // file unlinked under it.
                if let removedStore {
                    try removedStore.eraseAll()
                    try removedStore.close()
                } else if let directory {
                    let file = AccountSession.accountDirectory(directory: directory, id: id).appendingPathComponent("store.sqlite")
                    if FileManager.default.fileExists(atPath: file.path) {
                        let store = try LocalStore.open(at: file)
                        try store.eraseAll()
                        try store.close()
                    }
                }
                if let directory {
                    let accountDirectory = AccountSession.accountDirectory(directory: directory, id: id)
                    if FileManager.default.fileExists(atPath: accountDirectory.path) {
                        try FileManager.default.removeItem(at: accountDirectory)
                    }
                }
            }.value
        } catch {
            // Never unlink a database whose erase or close failed. The
            // account is already signed out, and the next account must
            // still start.
            cleanupError = error
        }
        settings(for: id).clear()
        memoryStores.removeValue(forKey: id)
        if wasActive { await next?.start() }
        if let cleanupError { throw cleanupError }
    }

    /// How long sign-out waits for the push token's removal.
    static let pushUnregisterTimeout: Duration = .seconds(5)

    /// AuthContext.tsx `logout`: the token this device registered for the
    /// account is removed from that account's own server before its
    /// credentials go, and a failure is ignored. One attempt, bounded, where
    /// happy-app's backoff retries forever and holds logout until the
    /// server answers. Never sent for an unconfirmed server.
    private func unregisterPushToken(of entry: AccountRegistryEntry, credentials: Credentials?) async {
        guard entry.serverConfirmed, let credentials, let token = settings(for: entry.id).registeredPushToken else { return }
        let api = HappyAPI(serverURL: entry.serverURL, clientID: clientID, transport: transport, token: credentials.token)
        let timeout = Self.pushUnregisterTimeout
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await api.unregisterPushToken(token) }
            group.addTask { try? await Task.sleep(for: timeout) }
            await group.next()
            group.cancelAll()
        }
    }

    private var nextOrder: Int { (registry.entries.map(\.addedOrder).max() ?? -1) + 1 }

    /// Reconciles only after every credential read succeeds. A missing item
    /// is different from a temporary Keychain access error.
    private func reconcile() async throws -> [String: StoredAccountCredentials] {
        let directory = await prepareStorageDirectory()
        let generation = profileGeneration
        var updated = registryLoaded ? registry : try await registryWriter.load(directory: directory)
        let shared = try accountCredentialStore.shared()
        let own = try accountCredentialStore.ownAccounts()
        let sharedID = shared.flatMap { try? accountID($0) }
        // A rollback can authenticate an account that already had an own
        // item. Keep only its shared credentials after a successful read.
        if let sharedID, own[sharedID] != nil {
            try accountCredentialStore.remove(id: sharedID, location: .own)
        }
        updated.entries.removeAll { entry in
            entry.location == .shared ? entry.id != sharedID : own[entry.id] == nil || entry.id == sharedID
        }
        // Preserve relative added order while keeping its persisted integers
        // bounded, including after recovery from a hand-edited registry.
        updated.entries.sort { $0.addedOrder < $1.addedOrder }
        for index in updated.entries.indices { updated.entries[index].addedOrder = index }
        var values = own
        var importedServer: ImportedAccountServer?
        if let shared, let sharedID {
            let known = updated.entries.first { $0.id == sharedID }
            if known == nil {
                // MMKV reads, replay and CRC validation belong off main. Busy
                // keeps account transitions serialized; the generation captured
                // above still merges profiles delivered during this await.
                let importServer = rnServerImport
                importedServer = await Task.detached(priority: .userInitiated) { importServer() }.value
            }
            let url: URL
            if let known {
                url = known.serverURL
            } else if case .confirmed(let importedURL) = importedServer {
                url = importedURL
            } else {
                // Placeholder only; serverConfirmed gates every session.
                url = ServerConfig.defaultServerURL
            }
            values[sharedID] = StoredAccountCredentials(credentials: shared, serverURL: url)
        }
        for id in values.keys.sorted() where !updated.entries.contains(where: { $0.id == id }) {
            let value = values[id]!
            updated.entries.append(AccountRegistryEntry(id: id, serverURL: value.serverURL,
                location: id == sharedID ? .shared : .own,
                addedOrder: (updated.entries.map(\.addedOrder).max() ?? -1) + 1,
                serverConfirmed: id != sharedID || importedServer != .needsConfirmation))
        }
        let entries = updated.entries
        let memoryStores = self.memoryStores
        let readDisplays = readRegistryDisplays
        let displays = try await Task.detached { try readDisplays(entries, memoryStores, directory) }.value
        for index in updated.entries.indices {
            if let display = displays[updated.entries[index].id] { updated.entries[index].display = display }
        }
        if !updated.entries.contains(where: { $0.id == updated.activeID }) {
            updated.activeID = updated.entries.min { $0.addedOrder < $1.addedOrder }?.id
        }
        updated = try await persistRegistry(updated, preservingProfilesSince: generation)
        let changed = registry != updated
        registry = updated
        registryLoaded = true
        if changed { notifyAccounts() }
        return values
    }

    private nonisolated static func readDisplays(
        entries: [AccountRegistryEntry], stores: [String: LocalStore], directory: URL?
    ) throws -> [String: AccountDisplay?] {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        var displays: [String: AccountDisplay?] = [:]
        for entry in entries {
            if let store = stores[entry.id] {
                displays[entry.id] = .some(try store.profile().map(AccountDisplay.init))
            } else if let directory {
                // A temporary read failure keeps the cached presentation.
                do { displays[entry.id] = .some(try AccountDisplay.read(directory: directory, id: entry.id)) }
                catch { }
            }
        }
        return displays
    }

    private func mergingProfiles(into value: AccountRegistry, since generation: UInt64) -> AccountRegistry {
        var result = value
        for index in result.entries.indices {
            let id = result.entries[index].id
            guard (profileGenerations[id] ?? 0) > generation,
                  let live = registry.entries.first(where: { $0.id == id }) else { continue }
            result.entries[index].display = live.display
        }
        return result
    }

    /// Critical operations publish only the value successfully persisted. A
    /// profile arriving during I/O is merged and saved again before returning.
    /// Only main allocates revisions, and busy defers routine requests. Thus a
    /// critical request cannot be rejected by a newer request; the rejection
    /// branch is defensive, while generation changes are the normal retry case.
    private func persistRegistry(_ value: AccountRegistry, preservingProfilesSince generation: UInt64) async throws -> AccountRegistry {
        let directory = await prepareStorageDirectory()
        while true {
            let updated = mergingProfiles(into: value, since: generation)
            let currentGeneration = profileGeneration
            registryRevision += 1
            let revision = registryRevision
            let written = try await registryWriter.save(updated, directory: directory, revision: revision)
            guard written, currentGeneration == profileGeneration else { continue }
            profileDirty = false
            return updated
        }
    }

    private func finishOperation() {
        busy = false
        scheduleProfilePersistence()
    }

    /// Profile publication is immediate; failures keep that cached display.
    /// During a transition the critical writer merges it into the candidate,
    /// rather than allowing an old inventory to supersede that transition.
    private func scheduleProfilePersistence() {
        guard profileDirty, !busy, profilePersistenceTask == nil else { return }
        let value = registry
        let generation = profileGeneration
        registryRevision += 1
        let revision = registryRevision
        let writer = registryWriter
        let directory = storageDirectory
        profilePersistenceTask = Task { [weak self] in
            let written = (try? await writer.save(value, directory: directory, revision: revision)) == true
            guard let self else { return }
            self.profilePersistenceTask = nil
            if written, generation == self.profileGeneration { self.profileDirty = false }
            // Retry only for a newer profile, not indefinitely on an I/O error.
            if generation != self.profileGeneration { self.scheduleProfilePersistence() }
        }
    }

    /// Waits for currently scheduled routine writes, useful at lifecycle/test
    /// boundaries. Critical operations already await their own persistence.
    func flushProfilePersistence() async {
        scheduleProfilePersistence()
        while let task = profilePersistenceTask { await task.value }
    }

    private func settings(for id: String) -> LocalSettings {
        if let value = settingsStores[id] { return value }
        let value = LocalSettings(storage: settingsFactory?(id) ?? InMemoryKeyValueStore())
        settingsStores[id] = value
        return value
    }

    /// All async storage entry points await this same immutable decision. Only
    /// initial setup failure falls back; subsequent registry I/O still throws.
    /// Internal so tests can hold the real bootstrap across concurrent callers.
    func prepareStorageDirectory() async -> URL? {
        let task: Task<URL?, Never>
        if let existing = storagePreparation {
            task = existing
        } else {
            let directory = configuredStoreDirectory
            let prepare = prepareAccountStorage
            task = Task.detached {
                do {
                    try prepare(directory)
                    return directory
                } catch {
                    return nil
                }
            }
            storagePreparation = task
        }
        let directory = await task.value
        storageDirectory = directory
        return directory
    }

    private func makeSession(_ credentials: Credentials, entry: AccountRegistryEntry) async throws -> AccountSession {
        guard entry.serverConfirmed else { throw AccountSwitchError.serverNeedsConfirmation }
        let directory = await prepareStorageDirectory()
        let existing = memoryStores[entry.id]
        let prepareDirectory = prepareSessionDirectory
        let dependencies = AccountSession.Dependencies(
            serverURL: entry.serverURL, clientID: clientID, transport: transport,
            connector: connector, appState: appState, deliveryActivity: deliveryActivity)
        let next = try await Task.detached {
            let store: LocalStore
            var files: URL?
            var cacheDirectory: URL?
            if let directory {
                try prepareDirectory(directory, entry.id)
                store = try LocalStore.open(at: AccountSession.accountDirectory(directory: directory, id: entry.id).appendingPathComponent("store.sqlite"))
                files = AccountSession.accountDirectory(directory: directory, id: entry.id).appendingPathComponent("files", isDirectory: true)
                cacheDirectory = SessionFileCache.directory(inAccount: AccountSession.accountDirectory(directory: directory, id: entry.id))
            } else {
                store = try existing ?? LocalStore.inMemory()
            }
            return try AccountSession(credentials: credentials, store: store, dependencies: dependencies,
                                      filesDirectory: files, fileCacheDirectory: cacheDirectory)
        }.value
        if directory == nil { memoryStores[entry.id] = next.store }
        return next
    }

    private func activate(_ next: AccountSession, registry: AccountRegistry) async {
        stopProfileObservation()
        await session?.stop()
        self.registry = registry
        localSettings = settings(for: next.keys.anonID)
        state = .signedIn(next)
        observeProfile(of: next)
        notifyAccounts()
        await next.start()
    }

    private func selectUnconfirmed(registry: AccountRegistry) async {
        stopProfileObservation()
        await session?.stop()
        self.registry = registry
        localSettings = LocalSettings(storage: InMemoryKeyValueStore())
        state = .signedOut
        notifyAccounts()
    }

    private func observeProfile(of session: AccountSession) {
        profileObservationGeneration += 1
        let generation = profileObservationGeneration
        let task = Task.detached { [weak self] in
            var previous: AccountDisplay??
            for await snapshot in session.settingsFeed.snapshots() {
                guard !Task.isCancelled else { break }
                let display = snapshot.profile.map(AccountDisplay.init)
                guard previous != .some(display) else { continue }
                previous = .some(display)
                await self?.applyProfileDisplay(display, session: session, generation: generation)
            }
        }
        cancelProfileObservation = { task.cancel() }
    }

    private func stopProfileObservation() {
        profileObservationGeneration += 1
        cancelProfileObservation?()
        cancelProfileObservation = nil
    }

    private func applyProfileDisplay(_ display: AccountDisplay?, session source: AccountSession, generation: UInt64) {
        guard !Task.isCancelled, generation == profileObservationGeneration, session === source,
              let index = registry.entries.firstIndex(where: { $0.id == source.keys.anonID }),
              registry.entries[index].display != display else { return }
        registry.entries[index].display = display
        profileGeneration += 1
        profileGenerations[source.keys.anonID] = profileGeneration
        profileDirty = true
        notifyAccounts()
        scheduleProfilePersistence()
    }
}
