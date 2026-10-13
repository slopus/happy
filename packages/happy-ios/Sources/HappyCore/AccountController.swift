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
    private let storeDirectory: URL?
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
        appState: @escaping @Sendable () async -> String = { "active" },
        deliveryActivity: @escaping @Sendable (Bool) async -> Void = { _ in }
    ) {
        self.serverConfig = serverConfig
        self.clientID = clientID
        self.accountCredentialStore = accountCredentialStore ?? InMemoryAccountCredentialStore(sharedStore: credentialStore)
        self.rnServerImport = rnServerImport
        self.storeDirectory = storeDirectory
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

    /// Presents onboarding without logging out. Cancel leaves the current
    /// account and session intact. signIn adds and activates the result.
    public func beginAddingAccount() { isAddingAccount = true }
    public func cancelAddingAccount() { isAddingAccount = false }

    public func switchAccount(to id: AccountSummary.ID) async throws {
        guard !busy else { throw AccountSwitchError.operationInProgress }
        busy = true
        defer { busy = false }
        let values = try reconcile()
        guard let entry = registry.entries.first(where: { $0.id == id }), let value = values[id] else {
            throw AccountSwitchError.unknownAccount
        }
        guard session?.keys.anonID != id else { return }
        let next = entry.serverConfirmed ? try makeSession(value.credentials, entry: entry) : nil
        var updated = registry
        updated.activeID = id
        try updated.save(directory: storeDirectory)
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
        defer { busy = false }
        let url = try ServerConfig.validate(url.absoluteString)
        let values = try reconcile()
        guard let index = registry.entries.firstIndex(where: { $0.id == id }),
              let value = values[id] else { throw AccountSwitchError.unknownAccount }
        var updated = registry
        updated.entries[index].serverURL = url
        updated.entries[index].serverConfirmed = true
        updated.activeID = id
        try updated.save(directory: storeDirectory)
        registry = updated
        let next = try makeSession(value.credentials, entry: updated.entries[index])
        await activate(next, registry: updated)
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
        defer { busy = false }
        do {
            let values = try reconcile()
            guard let id = registry.activeID,
                  let entry = registry.entries.first(where: { $0.id == id }), let value = values[id] else { return }
            if entry.serverConfirmed {
                let next = try makeSession(value.credentials, entry: entry)
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
        defer { busy = false }
        let id = try accountID(credentials)
        _ = try reconcile()
        let existing = registry.entries.first { $0.id == id }
        guard existing?.serverConfirmed != false else { throw AccountSwitchError.serverNeedsConfirmation }
        let location = try existing?.location ?? (accountCredentialStore.sharedIsEmpty() ? .shared : .own)
        let entry = AccountRegistryEntry(id: id, serverURL: authenticationServerURL, location: location,
                                         addedOrder: existing?.addedOrder ?? nextOrder)
        let next = try makeSession(credentials, entry: entry)
        try accountCredentialStore.save(StoredAccountCredentials(credentials: credentials, serverURL: entry.serverURL), id: id, location: location)
        var updated = registry
        updated.entries.removeAll { $0.id == id }
        updated.entries.append(entry)
        updated.activeID = id
        try updated.save(directory: storeDirectory)
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
        defer { busy = false }
        let values = try reconcile()
        guard let entry = registry.entries.first(where: { $0.id == id }) else { throw AccountSwitchError.unknownAccount }
        var updated = registry
        updated.entries.removeAll { $0.id == id }
        let wasActive = session.map { $0.keys.anonID == id } ?? (registry.activeID == id)
        let oldSession = wasActive ? session : nil
        let following = updated.entries.sorted { $0.addedOrder < $1.addedOrder }.first
        let next: AccountSession?
        if wasActive, let following, following.serverConfirmed, let value = values[following.id] {
            next = try makeSession(value.credentials, entry: following)
        } else {
            next = nil
        }
        if wasActive { updated.activeID = following?.id }
        try updated.save(directory: storeDirectory)
        do {
            try accountCredentialStore.remove(id: id, location: entry.location)
        } catch {
            try? registry.save(directory: storeDirectory)
            throw error
        }
        if wasActive {
            cancelProfileObservation?()
            cancelProfileObservation = nil
            await oldSession?.stop()
        }
        registry = updated
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
        // readers retaining its pool then see empty data, not a live account.
        notifyAccounts()
        var cleanupError: Error?
        do {
            let removedStore = oldSession?.store ?? memoryStores[id]
            if let removedStore {
                try removedStore.eraseAll()
            } else if let directory = storeDirectory {
                let file = AccountSession.accountDirectory(directory: directory, id: id).appendingPathComponent("store.sqlite")
                if FileManager.default.fileExists(atPath: file.path) {
                    let store = try LocalStore.open(at: file)
                    try store.eraseAll()
                }
            }
            if let directory = storeDirectory {
                let accountDirectory = AccountSession.accountDirectory(directory: directory, id: id)
                if FileManager.default.fileExists(atPath: accountDirectory.path) {
                    try FileManager.default.removeItem(at: accountDirectory)
                }
            }
        } catch {
            // Never unlink a database whose erase failed. The account is
            // already signed out, and the next account must still start.
            cleanupError = error
        }
        settings(for: id).clear()
        memoryStores.removeValue(forKey: id)
        if wasActive { await next?.start() }
        if let cleanupError { throw cleanupError }
    }

    private var nextOrder: Int { (registry.entries.map(\.addedOrder).max() ?? -1) + 1 }

    /// Reconciles only after every credential read succeeds. A missing item
    /// is different from a temporary Keychain access error.
    private func reconcile() throws -> [String: StoredAccountCredentials] {
        var updated = registryLoaded ? registry : try AccountRegistry.load(directory: storeDirectory)
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
            if known == nil { importedServer = rnServerImport() }
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
        for index in updated.entries.indices {
            let entry = updated.entries[index]
            if let store = memoryStores[entry.id] {
                updated.entries[index].display = try store.profile().map(AccountDisplay.init)
            } else if let directory = storeDirectory {
                do {
                    updated.entries[index].display = try AccountDisplay.read(directory: directory, id: entry.id)
                } catch {
                    // A temporary read failure keeps previously cached display
                    // fields; it never prevents credential/server recovery.
                }
            }
        }
        if !updated.entries.contains(where: { $0.id == updated.activeID }) {
            updated.activeID = updated.entries.min { $0.addedOrder < $1.addedOrder }?.id
        }
        try updated.save(directory: storeDirectory)
        let changed = registry != updated
        registry = updated
        registryLoaded = true
        if changed { notifyAccounts() }
        return values
    }

    private func settings(for id: String) -> LocalSettings {
        if let value = settingsStores[id] { return value }
        let value = LocalSettings(storage: settingsFactory?(id) ?? InMemoryKeyValueStore())
        settingsStores[id] = value
        return value
    }

    private func makeSession(_ credentials: Credentials, entry: AccountRegistryEntry) throws -> AccountSession {
        guard entry.serverConfirmed else { throw AccountSwitchError.serverNeedsConfirmation }
        let store: LocalStore
        var files: URL?
        if let directory = storeDirectory {
            try AccountSession.prepareDirectory(directory: directory, id: entry.id)
            store = try LocalStore.open(at: AccountSession.accountDirectory(directory: directory, id: entry.id).appendingPathComponent("store.sqlite"))
            files = AccountSession.accountDirectory(directory: directory, id: entry.id).appendingPathComponent("files", isDirectory: true)
        } else if let existing = memoryStores[entry.id] { store = existing }
        else {
            store = try LocalStore.inMemory()
            memoryStores[entry.id] = store
        }
        return try AccountSession(credentials: credentials, store: store, dependencies: .init(
            serverURL: entry.serverURL, clientID: clientID, transport: transport,
            connector: connector, appState: appState, deliveryActivity: deliveryActivity), filesDirectory: files)
    }

    private func activate(_ next: AccountSession, registry: AccountRegistry) async {
        cancelProfileObservation?()
        cancelProfileObservation = nil
        await session?.stop()
        self.registry = registry
        localSettings = settings(for: next.keys.anonID)
        state = .signedIn(next)
        observeProfile(of: next)
        notifyAccounts()
        await next.start()
    }

    private func selectUnconfirmed(registry: AccountRegistry) async {
        cancelProfileObservation?()
        cancelProfileObservation = nil
        await session?.stop()
        self.registry = registry
        localSettings = LocalSettings(storage: InMemoryKeyValueStore())
        state = .signedOut
        notifyAccounts()
    }

    private func observeProfile(of session: AccountSession) {
        let id = session.keys.anonID
        let observation = session.store.observe({ db in
            try AccountProfileRecord.fetchOne(db, key: 1)?.profile
        }, onChange: { [weak self] profile in
            guard let self, self.session?.keys.anonID == id,
                  let index = self.registry.entries.firstIndex(where: { $0.id == id }) else { return }
            let display = profile.map(AccountDisplay.init)
            guard self.registry.entries[index].display != display else { return }
            self.registry.entries[index].display = display
            try? self.registry.save(directory: self.storeDirectory)
            self.notifyAccounts()
        })
        cancelProfileObservation = { observation.cancel() }
    }
}
