import Foundation
import HappyCrypto
import HappyStore
import HappyWire

/// Everything that exists while an account is signed in: its keys, the
/// signed-in API, its local store, the sync engine and the live socket.
public final class AccountSession: Sendable {
    public let credentials: Credentials
    public let keys: AccountKeys
    public let api: HappyAPI
    public let store: LocalStore
    public let sync: SyncEngine
    public let sender: OutboxSender
    public let realtime: SocketIOClient
    public let pairing: PairingService
    /// Archive, delete and mark read, for the session list.
    public let actions: SessionActions
    /// Socket status for the UI (connection dot in settings).
    public let statusUpdates: AsyncStream<RealtimeStatus>

    private let statusContinuation: AsyncStream<RealtimeStatus>.Continuation
    private let pump = PumpHolder()

    public struct Dependencies: Sendable {
        public var serverURL: URL
        public var clientID: String
        public var transport: HTTPTransport
        public var connector: WebSocketConnector
        public var appState: @Sendable () async -> String
        public var deliveryActivity: @Sendable (Bool) async -> Void = { _ in }

        public init(
            serverURL: URL,
            clientID: String,
            transport: HTTPTransport,
            connector: WebSocketConnector = URLSessionWebSocketConnector(),
            appState: @escaping @Sendable () async -> String = { "active" }
        ) {
            self.serverURL = serverURL
            self.clientID = clientID
            self.transport = transport
            self.connector = connector
            self.appState = appState
        }
    }

    public init(credentials: Credentials, store: LocalStore, dependencies: Dependencies, filesDirectory: URL? = nil) throws {
        guard let secret = credentials.secretData else { throw CryptoError.invalidInput("credentials secret") }
        self.credentials = credentials
        self.keys = try AccountKeys(secret: secret)
        self.store = store
        self.api = HappyAPI(serverURL: dependencies.serverURL, clientID: dependencies.clientID, transport: dependencies.transport)
            .authenticated(token: credentials.token)
        var syncOptions = SyncEngine.Options()
        syncOptions.deliveryActivity = dependencies.deliveryActivity
        self.sync = SyncEngine(api: api, store: store, keys: keys, options: syncOptions)
        let accountFiles = filesDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Happy/accounts/\(keys.anonID)/files", isDirectory: true)
        self.sender = OutboxSender(store: store, sync: sync, filesDirectory: accountFiles)
        self.pairing = PairingService(api: api, keys: keys)

        guard let socketURL = SocketIOURL.make(serverURL: dependencies.serverURL) else {
            throw ServerURLError.invalid
        }
        let token = credentials.token
        let clientID = dependencies.clientID
        let appState = dependencies.appState
        self.realtime = SocketIOClient(url: socketURL, connector: dependencies.connector) {
            .object([
                "token": .string(token),
                "clientType": .string("user-scoped"),
                "happyClient": .string(clientID),
                "appState": .string(await appState()),
            ])
        }
        (statusUpdates, statusContinuation) = AsyncStream.makeStream(of: RealtimeStatus.self, bufferingPolicy: .bufferingNewest(1))
        self.actions = SessionActions(api: api, store: store, sync: sync, rpc: realtime)
    }

    /// Changes synced account settings (sync.ts `applySettings`).
    public func updateSettings(_ delta: [String: JSONValue]) {
        let sync = self.sync
        Task { try? await sync.updateSettings(delta) }
    }

    /// The account's id on the server: the token's `sub` claim, which
    /// happy-app shows as the Public ID.
    public var serverID: String? {
        Self.subject(ofToken: credentials.token)
    }

    /// A JWT's `sub` claim, read without verifying the signature.
    static func subject(ofToken token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload), let claims = try? JSONValue.decode(data) else { return nil }
        return claims["sub"]?.stringValue
    }

    /// The store file for an account. Named by the account's analytics id so
    /// two accounts on one device can never read each other's data.
    public static func storeURL(directory: URL, keys: AccountKeys) -> URL {
        directory.appendingPathComponent("happy-\(keys.anonID).sqlite")
    }

    /// Shows local data immediately; sync and the socket catch up behind it.
    public func start() async {
        await sync.configureSending(filesDirectory: sender.filesDirectory)
        await sync.syncAll()
        let realtime = self.realtime
        let sync = self.sync
        let statusContinuation = self.statusContinuation
        pump.set(Task {
            for await event in realtime.events {
                await Self.route(event, sync: sync, status: statusContinuation)
            }
        })
        await realtime.connect()
    }

    public func stop() async {
        pump.cancel()
        await realtime.disconnect()
        await sync.stop()
        statusContinuation.finish()
    }

    /// Tells the server whether the app is in the foreground, so it can
    /// suppress pushes while the user is looking at the app.
    public func sendAppState(_ state: String) async {
        await sync.setBackgrounded(state != "active")
        try? await realtime.emit("app-state", .object(["state": .string(state)]))
    }

    static func route(_ event: RealtimeEvent, sync: SyncEngine, status: AsyncStream<RealtimeStatus>.Continuation) async {
        switch event {
        case .status(let value):
            status.yield(value)
        case .connected:
            await sync.syncAll()
        case .event("update", let payload?):
            if let update = try? payload.decode(as: UpdateContainer.self) {
                await sync.handle(update)
            }
        case .event("ephemeral", let payload?):
            if let ephemeral = try? payload.decode(as: EphemeralEvent.self) {
                await sync.handle(ephemeral)
            }
        case .event:
            break
        }
    }
}

private final class PumpHolder: @unchecked Sendable {
    private var task: Task<Void, Never>?
    private let lock = NSLock()

    func set(_ task: Task<Void, Never>) {
        lock.lock()
        let previous = self.task
        self.task = task
        lock.unlock()
        previous?.cancel()
    }

    func cancel() {
        lock.lock()
        let task = self.task
        self.task = nil
        lock.unlock()
        task?.cancel()
    }
}
