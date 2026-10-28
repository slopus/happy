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
    /// The account's own `files/` directory (copied attachments). Accounts
    /// without a store directory (in-memory, tests) get a temporary one.
    public let filesDirectory: URL
    public let sync: SyncEngine
    public let archiveVisibilityWriter: ArchiveVisibilityWriter
    /// The New Session draft's last height, for reopening it in this account.
    public let newSessionDraftHeight = MeasuredDraftMemo()
    /// Private render payload belongs to this account, including work that
    /// screens finish after a switch. Screens cancel work; stop closes owners.
    public let diffDocuments = DiffDocumentCache()
    public let diffSyntax = DiffSyntaxService()
    public let codeSyntax = CodeSyntaxService()
    /// Retry keys and abandoned starts belong to this account session alone.
    public let spawnRequests = SpawnRequests()
    /// Sends chat messages through the outbox.
    public let sender: OutboxSender
    /// The chat of any session, from this account's store.
    public let chatFeed: LocalChatFeed
    public let chatHistory: ChatHistory
    public let homeFeed: HomeFeed
    public let settingsFeed: SettingsFeed
    public let machinesFeed: MachinesFeed
    public let troubleshootingFeed: TroubleshootingFeed
    public let realtime: SocketIOClient
    public let pairing: PairingService
    /// Archive, delete and mark read, for the session list.
    public let actions: SessionActions
    /// The account's machine-scoped operations, sealed with each machine key.
    public let machineActions: MachineActions
    /// Checkout status shared by this account's sessions.
    public let gitStatus: GitStatusSync
    /// The composer's `@` file lists, this account's alone: another
    /// account's session with the same id is another machine's tree.
    public let composerFileIndex = ComposerFileIndex()
    /// This account's Rig whole-draft synchronization.
    public let rigComposer: RigComposerSync
    /// Starts in flight stay within this account, including their unsent text.
    public let pendingChats = PendingChats()
    /// The session pictures the chat has decoded, this account's alone.
    public let attachmentPictures = AttachmentPictures()
    public let avatarPictures: AvatarPictures
    /// What each file looked like when last read (the store's
    /// `sessionFileCache`), this account's alone. Disk reads stay under the
    /// prepared account directory; a nil directory keeps it in memory.
    public let fileCache: SessionFileCache
    /// One session's record, computer, settings and composer, for the
    /// session's own screens.
    public let sessionDetails: SessionDetailFeed
    public let machineDetails: MachineDetailFeed
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
        /// Called with true before an upload or post and false after it, so
        /// the app can keep a send alive in the background (see
        /// `SyncEngine.Options.deliveryActivity`).
        public var deliveryActivity: @Sendable (Bool) async -> Void

        /// The defaults for `appState` and `deliveryActivity`, compiled once,
        /// here, as `InvalidateSync.taskSleep` explains.
        public static let alwaysActive: @Sendable () async -> String = { "active" }
        public static let noDeliveryActivity: @Sendable (Bool) async -> Void = { _ in }

        public init(
            serverURL: URL,
            clientID: String,
            transport: HTTPTransport,
            connector: WebSocketConnector = URLSessionWebSocketConnector(),
            appState: @escaping @Sendable () async -> String = Dependencies.alwaysActive,
            deliveryActivity: @escaping @Sendable (Bool) async -> Void = Dependencies.noDeliveryActivity
        ) {
            self.serverURL = serverURL
            self.clientID = clientID
            self.transport = transport
            self.connector = connector
            self.appState = appState
            self.deliveryActivity = deliveryActivity
        }
    }

    public init(credentials: Credentials, store: LocalStore, dependencies: Dependencies,
                filesDirectory: URL? = nil, fileCacheDirectory: URL? = nil) throws {
        guard let secret = credentials.secretData else { throw CryptoError.invalidInput("credentials secret") }
        self.credentials = credentials
        self.keys = try AccountKeys(secret: secret)
        self.store = store
        self.filesDirectory = filesDirectory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("happy-files-\(keys.anonID)", isDirectory: true)
        self.fileCache = SessionFileCache(directory: fileCacheDirectory)
        self.api = HappyAPI(serverURL: dependencies.serverURL, clientID: dependencies.clientID, transport: dependencies.transport)
            .authenticated(token: credentials.token)
        self.avatarPictures = AvatarPictures(owner: keys.anonID,
            directory: filesDirectory.map { $0.deletingLastPathComponent().appendingPathComponent("avatars", isDirectory: true) },
            api: api, keys: keys)
        var syncOptions = SyncEngine.Options()
        syncOptions.deliveryActivity = dependencies.deliveryActivity
        self.sync = SyncEngine(api: api, store: store, keys: keys, options: syncOptions)
        let settingsSync = self.sync
        self.archiveVisibilityWriter = ArchiveVisibilityWriter { hidden in
            let baseline = try store.accountSettings()?.version ?? 0
            try await settingsSync.updateSettings(["hideInactiveSessions": .bool(hidden)])
            return baseline
        }
        self.sender = OutboxSender(store: store, sync: sync, filesDirectory: self.filesDirectory, spawnRequests: spawnRequests)
        self.chatFeed = LocalChatFeed(store: store)
        self.chatHistory = ChatHistory(api: api, store: store, keys: keys)
        self.homeFeed = HomeFeed(store: store)
        self.settingsFeed = SettingsFeed(store: store)
        self.machinesFeed = MachinesFeed(store: store)
        self.sessionDetails = SessionDetailFeed(store: store)
        self.machineDetails = MachineDetailFeed(store: store)
        self.troubleshootingFeed = TroubleshootingFeed(store: store)
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
        self.machineActions = MachineActions(api: api, store: store, sync: sync, rpc: realtime, metadataTransport: realtime)
        self.gitStatus = GitStatusSync(actions: actions, store: store)
        self.rigComposer = sync.rigComposer
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
        accountDirectory(directory: directory, id: keys.anonID).appendingPathComponent("store.sqlite")
    }

    public static func accountDirectory(directory: URL, id: String) -> URL {
        directory.appendingPathComponent("accounts", isDirectory: true).appendingPathComponent(id, isDirectory: true)
    }

    /// Move sidecars before the database, which is the migration's commit
    /// marker. Retrying an interrupted migration completes the remaining moves.
    public static func prepareDirectory(directory: URL, id: String) throws {
        try AccountStorageDirectory.prepare(directory)
        let manager = FileManager.default
        let target = accountDirectory(directory: directory, id: id)
        try manager.createDirectory(at: target.appendingPathComponent("files", isDirectory: true), withIntermediateDirectories: true)
        // The viewer's optional cache must not prevent the primary store from
        // opening. An unprepared directory keeps all reads in memory only.
        try? SessionFileCache.prepare(directory: SessionFileCache.directory(inAccount: target))
        let old = directory.appendingPathComponent("happy-\(id).sqlite")
        let new = target.appendingPathComponent("store.sqlite")
        guard manager.fileExists(atPath: old.path), !manager.fileExists(atPath: new.path) else { return }
        for suffix in ["-wal", "-shm", ""] {
            let source = URL(fileURLWithPath: old.path + suffix)
            let destination = URL(fileURLWithPath: new.path + suffix)
            if manager.fileExists(atPath: source.path), !manager.fileExists(atPath: destination.path) {
                try manager.moveItem(at: source, to: destination)
            }
        }
    }

    /// Shows local data immediately; sync and the socket catch up behind it.
    public func start() async {
        await rigComposer.configure(transport: realtime)
        await sync.configureSending(filesDirectory: sender.filesDirectory)
        await sync.syncAll()
        let realtime = self.realtime
        let sync = self.sync
        let statusContinuation = self.statusContinuation
        let gitStatus = self.gitStatus
        let rigComposer = self.rigComposer
        let fileCache = self.fileCache
        pump.set(Task {
            for await event in realtime.events {
                await Self.route(event, sync: sync, status: statusContinuation, gitStatus: gitStatus, rigComposer: rigComposer, fileCache: fileCache)
            }
        })
        await realtime.connect()
    }

    public func stop() async {
        await archiveVisibilityWriter.close()
        await avatarPictures.close()
        newSessionDraftHeight.close()
        diffDocuments.close()
        diffSyntax.close()
        codeSyntax.close()
        await spawnRequests.close()
        await chatHistory.stop()
        homeFeed.stop()
        settingsFeed.stop()
        machinesFeed.stop()
        sessionDetails.stop()
        machineDetails.stop()
        await fileCache.close()
        await troubleshootingFeed.stop()
        let task = pump.cancel()
        await gitStatus.stop()
        await rigComposer.setConnected(false)
        await realtime.disconnect()
        await rigComposer.stop()
        await sync.stop()
        await store.stopSnapshotProducers()
        await task?.value
        statusContinuation.finish()
    }

    /// Tells the server whether the app is in the foreground, so it can
    /// suppress pushes while the user is looking at the app.
    public func sendAppState(_ state: String) async {
        await sync.setBackgrounded(state != "active")
        if state == "active" { await rigComposer.flushAheadSessions() }
        await sendPresence(state)
    }

    /// Desktop focus affects presence, not whether the process may deliver
    /// accepted writes. The mobile lifecycle still uses sendAppState above.
    public func sendPresence(_ state: String) async {
        try? await realtime.emit("app-state", .object(["state": .string(state)]))
    }

    static func route(_ event: RealtimeEvent, sync: SyncEngine, status: AsyncStream<RealtimeStatus>.Continuation,
                      gitStatus: GitStatusSync? = nil, rigComposer: RigComposerSync? = nil,
                      fileCache: SessionFileCache? = nil) async {
        switch event {
        case .status(let value):
            status.yield(value)
            await rigComposer?.setConnected(value == .connected)
        case .connected:
            await sync.syncAll()
            await rigComposer?.setConnected(true)
        case .event("update", let payload?):
            if let update = try? payload.decode(as: UpdateContainer.self) {
                await sync.handle(update)
                switch update.body {
                case .newMessage(let id, _): await gitStatus?.invalidate(sessionId: id)
                case .updateSession(let body): await gitStatus?.invalidate(sessionId: body.id)
                case .deleteSession(let id):
                    await gitStatus?.clearForSession(sessionId: id)
                    fileCache?.removeSession(sessionId: id)
                default: break
                }
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

    func cancel() -> Task<Void, Never>? {
        lock.lock()
        let task = self.task
        self.task = nil
        lock.unlock()
        task?.cancel()
        return task
    }
}
