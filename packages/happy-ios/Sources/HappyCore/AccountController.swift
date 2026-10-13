import Foundation
import HappyCrypto
import HappyStore

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
    public private(set) var localSettings: LocalSettings
    public private(set) var isAddingAccount = false

    private let credentialStore: CredentialStore
    private let accountCredentialStore: AccountCredentialStore
    private let storeDirectory: URL?
    private let transport: HTTPTransport
    private let connector: WebSocketConnector
    private let appState: @Sendable () async -> String
    private let settingsFactory: ((String) -> KeyValueStore)?
    private var settingsStores: [String: LocalSettings] = [:]
    private var memoryStores: [String: LocalStore] = [:]
    private var registry = AccountRegistry()
    private var registryLoaded = false
    private var busy = false

    public init(
        serverConfig: ServerConfig,
        clientID: String,
        credentialStore: CredentialStore,
        storeDirectory: URL?,
        localSettings: KeyValueStore = InMemoryKeyValueStore(),
        accountCredentialStore: AccountCredentialStore? = nil,
        localSettingsFactory: ((String) -> KeyValueStore)? = nil,
        transport: HTTPTransport = URLSessionTransport(),
        connector: WebSocketConnector = URLSessionWebSocketConnector(),
        appState: @escaping @Sendable () async -> String = { "active" }
    ) {
        self.serverConfig = serverConfig
        self.clientID = clientID
        self.credentialStore = credentialStore
        self.accountCredentialStore = accountCredentialStore ?? InMemoryAccountCredentialStore(sharedStore: credentialStore)
        self.storeDirectory = storeDirectory
        self.localSettings = LocalSettings(storage: localSettings)
        self.settingsFactory = localSettingsFactory
        self.transport = transport
        self.connector = connector
        self.appState = appState
    }

    public var session: AccountSession? {
        if case .signedIn(let session) = state { return session }
        return nil
    }

    public var accounts: [AccountSummary] {
        registry.entries.sorted { $0.addedOrder < $1.addedOrder }.map { entry in
            AccountSummary(id: entry.id, serverURL: entry.serverURL,
                           isActive: session?.keys.anonID == entry.id,
                           usesSharedItem: entry.location == .shared)
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
        let next = try makeSession(value.credentials, entry: entry)
        var updated = registry
        updated.activeID = id
        try updated.save(directory: storeDirectory)
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
            let next = try makeSession(value.credentials, entry: entry)
            await activate(next, registry: registry)
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
            // Preserve the legacy explicit logout of malformed credentials.
            if !busy, let value = try? accountCredentialStore.shared(), (try? accountID(value)) == nil {
                try? credentialStore.clear()
            }
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
        let wasActive = session?.keys.anonID == id
        let following = updated.entries.sorted { $0.addedOrder < $1.addedOrder }.first
        let next: AccountSession?
        if wasActive, let following, let value = values[following.id] {
            next = try makeSession(value.credentials, entry: following)
        } else { next = nil }
        if wasActive { updated.activeID = following?.id }
        try updated.save(directory: storeDirectory)
        do {
            try accountCredentialStore.remove(id: id, location: entry.location)
        } catch {
            try? registry.save(directory: storeDirectory)
            throw error
        }
        if wasActive { await session?.stop() }
        settings(for: id).clear()
        memoryStores.removeValue(forKey: id)
        if let directory = storeDirectory {
            try? FileManager.default.removeItem(at: AccountSession.accountDirectory(directory: directory, id: id))
        }
        registry = updated
        if wasActive {
            if let next {
                localSettings = settings(for: next.keys.anonID)
                state = .signedIn(next)
                await next.start()
            } else {
                localSettings = LocalSettings(storage: InMemoryKeyValueStore())
                state = .signedOut
            }
        } else { onChange?(state) }
    }

    private var nextOrder: Int { (registry.entries.map(\.addedOrder).max() ?? -1) + 1 }

    /// Reconciles only after every credential read succeeds. A missing item
    /// is different from a temporary Keychain access error.
    private func reconcile() throws -> [String: StoredAccountCredentials] {
        var updated = registryLoaded ? registry : try AccountRegistry.load(directory: storeDirectory)
        let shared = try accountCredentialStore.shared()
        let own = try accountCredentialStore.ownAccounts()
        let sharedID = shared.flatMap { try? accountID($0) }
        updated.entries.removeAll { entry in
            entry.location == .shared ? entry.id != sharedID : own[entry.id] == nil || entry.id == sharedID
        }
        var values = own
        if let shared, let sharedID {
            let url = updated.entries.first { $0.id == sharedID }?.serverURL ?? serverConfig.serverURL
            values[sharedID] = StoredAccountCredentials(credentials: shared, serverURL: url)
        }
        for id in values.keys.sorted() where !updated.entries.contains(where: { $0.id == id }) {
            let value = values[id]!
            updated.entries.append(AccountRegistryEntry(id: id, serverURL: value.serverURL,
                location: id == sharedID ? .shared : .own,
                addedOrder: (updated.entries.map(\.addedOrder).max() ?? -1) + 1))
        }
        if !updated.entries.contains(where: { $0.id == updated.activeID }) {
            updated.activeID = updated.entries.min { $0.addedOrder < $1.addedOrder }?.id
        }
        try updated.save(directory: storeDirectory)
        registry = updated
        registryLoaded = true
        return values
    }

    private func settings(for id: String) -> LocalSettings {
        if let value = settingsStores[id] { return value }
        let value = LocalSettings(storage: settingsFactory?(id) ?? InMemoryKeyValueStore())
        settingsStores[id] = value
        return value
    }

    private func makeSession(_ credentials: Credentials, entry: AccountRegistryEntry) throws -> AccountSession {
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
            connector: connector, appState: appState), filesDirectory: files)
    }

    private func activate(_ next: AccountSession, registry: AccountRegistry) async {
        await session?.stop()
        self.registry = registry
        localSettings = settings(for: next.keys.anonID)
        state = .signedIn(next)
        await next.start()
    }
}