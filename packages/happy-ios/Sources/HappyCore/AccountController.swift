import Foundation
import HappyCrypto
import HappyStore

/// Owns the signed-in/signed-out state of the app. The UI layer observes
/// `onChange` and swaps its root screen; nothing else creates sessions.
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
    public let serverConfig: ServerConfig
    public let clientID: String

    private let credentialStore: CredentialStore
    /// Where account stores live; nil keeps them in memory (tests).
    private let storeDirectory: URL?
    private let transport: HTTPTransport
    private let connector: WebSocketConnector
    private let appState: @Sendable () async -> String

    public init(
        serverConfig: ServerConfig,
        clientID: String,
        credentialStore: CredentialStore,
        storeDirectory: URL?,
        transport: HTTPTransport = URLSessionTransport(),
        connector: WebSocketConnector = URLSessionWebSocketConnector(),
        appState: @escaping @Sendable () async -> String = { "active" }
    ) {
        self.serverConfig = serverConfig
        self.clientID = clientID
        self.credentialStore = credentialStore
        self.storeDirectory = storeDirectory
        self.transport = transport
        self.connector = connector
        self.appState = appState
    }

    public var session: AccountSession? {
        if case .signedIn(let session) = state { return session }
        return nil
    }

    /// Unauthenticated API for sign-in flows, against the configured server.
    public var authService: AuthService {
        AuthService(api: HappyAPI(serverURL: serverConfig.serverURL, clientID: clientID, transport: transport))
    }

    /// Checks a custom server URL with the app's own transport.
    public func checkServer(_ url: URL) async -> ServerCheckResult {
        await ServerProbe(transport: transport).check(url)
    }

    /// Launch: reopen the stored account, if any. The state flips to signed
    /// in before the first sync starts, so the UI shows local data at once.
    public func restore() async {
        guard case .signedOut = state, let credentials = try? credentialStore.load() else { return }
        do {
            try await open(credentials)
        } catch {
            // Stay signed out but keep the item. It is shared with the RN
            // build, and a local failure such as a store that won't open
            // must not sign that out too. Only signOut() deletes it.
        }
    }

    public func signIn(_ credentials: Credentials) async throws {
        try credentialStore.save(credentials)
        if let session { await session.stop() }
        try await open(credentials)
    }

    /// Stops sync, deletes the account's local data and forgets the account.
    public func signOut() async {
        if let session {
            await session.stop()
            try? session.store.eraseAll()
        }
        try? credentialStore.clear()
        state = .signedOut
    }

    private func open(_ credentials: Credentials) async throws {
        guard let secret = credentials.secretData else { throw CryptoError.invalidInput("credentials secret") }
        let keys = try AccountKeys(secret: secret)
        let store: LocalStore
        if let storeDirectory {
            store = try LocalStore.open(at: AccountSession.storeURL(directory: storeDirectory, keys: keys))
        } else {
            store = try LocalStore.inMemory()
        }
        let session = try AccountSession(
            credentials: credentials,
            store: store,
            dependencies: AccountSession.Dependencies(
                serverURL: serverConfig.serverURL,
                clientID: clientID,
                transport: transport,
                connector: connector,
                appState: appState
            )
        )
        state = .signedIn(session)
        await session.start()
    }
}
