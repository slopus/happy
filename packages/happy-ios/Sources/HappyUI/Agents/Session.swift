#if canImport(UIKit)
import HappyCore
import UIKit

/// One paired computer's V2, shared by every screen that shows it:
/// the store, the client its conversations use, and the pictures it has
/// read. The store's snapshots arrive here off the main thread's work and
/// are handed to whoever watches.
@MainActor
final class Session {
    let accountID: String
    let engine: SyncEngine
    let client: AgentClient
    let store: Store
    let images: Images
    /// The models the composer's pickers offer, and the dock's pick.
    let models: ModelState
    /// What this computer last showed, for opening on it offline.
    let offline: OfflineFile?
    /// The composers' drafts, kept on this phone beside the computer's copy.
    let drafts: Drafts
    /// Colours the code blocks its conversations show.
    let syntax = CodeSyntaxService()
    /// The conversations read ahead and kept, so they open drawn.
    let warm: WarmChats
    /// The person's settings for this phone, the transcript's renderer
    /// among them (`LocalSettings.chatListRenderer`).
    let localSettings: LocalSettings
    /// The person's own name and picture on this computer.
    private(set) lazy var profile = ProfileSource(client: client, engine: engine)
    private(set) var snapshot = Snapshot()
    private var watchers: [UUID: (Snapshot) -> Void] = [:]
    /// Readable, not settable, so a test can say the follow was let go of
    /// rather than take `stop`'s word for it.
    private(set) var following: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var connectionObservation: AccountsObservation?
    private var connectionFollowing: Task<Void, Never>?
    private var connectionSnapshot = HomeSnapshot()
    private var connectionStatus: ConnectionStatus = .connecting
    private var headerWatchers: [UUID: (Strings.HeaderStatus.State) -> Void] = [:]
    private(set) var headerState: Strings.HeaderStatus.State = .connecting

    /// The notifications this session watches for, for the same reason.
    /// Nothing adds to it today; it is emptied by `stop` all the same, so
    /// that anything added later is covered by the same teardown.
    var watchedCount: Int { observers.count }

    private static var sessions: [String: Session] = [:]

    /// The session for a paired computer, made once and kept while the app runs.
    static func session(for accountID: String, context: AppContext) -> Session? {
        guard let engine = context.account.agentConnections.syncEngine(for: accountID) else { return nil }
        if let existing = sessions[accountID] {
            if existing.engine === engine { return existing }
            // The same computer on a new engine. The old session's engine
            // is gone, so nothing it watches can say anything again: it is
            // stopped here rather than left to whenever the last screen
            // holding it is freed.
            existing.stop()
        }
        let session = Session(accountID: accountID, engine: engine, account: context.account)
        sessions[accountID] = session
        return session
    }

    /// Forgets a computer that was unpaired, and what was kept of it — that
    /// computer's and nobody else's, since another may still be paired.
    ///
    /// A document previewed from it is not among them: preview files are
    /// not filed by computer, so there is no telling them apart. An open
    /// preview removes its own file when it closes, and what a crash left
    /// behind goes before the first preview of the next launch
    /// (`FilePreview`), so until then such leftovers stay in this app's
    /// caches.
    static func forget(_ accountID: String) {
        OfflineFile.remove(accountID)
        StoriesSession.forget(accountID)
        guard let session = sessions.removeValue(forKey: accountID) else { return }
        session.stop()
        // The store belongs to the engine, not to the session, so only an
        // unpairing stops it.
        let store = session.store
        Task { await store.stop() }
    }

    /// What this session set going, stopped: the snapshots followed and
    /// the conversations read ahead, with the path monitor and the
    /// notifications `WarmChats` watches. Twice does nothing the second
    /// time, and a screen still holding the session simply stops hearing.
    func stop() {
        following?.cancel()
        following = nil
        connectionFollowing?.cancel()
        connectionFollowing = nil
        connectionObservation?.cancel()
        connectionObservation = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        warm.stop()
    }

    private init(accountID: String, engine: SyncEngine, account: AccountController) {
        self.accountID = accountID
        self.engine = engine
        self.localSettings = account.localSettings
        let client = engine.client
        self.client = client
        let offline = engine.offline
        self.offline = offline
        Task.detached(priority: .utility) { OfflineFile.removeLegacy(accountID) }
        store = engine.spaces
        images = Images(client: client, offline: offline)
        warm = WarmChats(client: client, store: store, syntax: syntax, persistence: engine)
        models = ModelState(client: client, offline: offline)
        drafts = Drafts(offline: offline)
        models.load()
        // The rows' drafts: what this phone keeps, then every change, here
        // or (through the store's events) on another device.
        let drafts = drafts
        let spaces = store
        Task {
            await drafts.observe { agentId, draft in
                Task { await spaces.noteDraft(agentId, text: draft?.text, updatedAt: draft?.updatedAt ?? Date().timeIntervalSince1970 * 1000) }
            }
            for (agentId, draft) in await drafts.all() {
                await spaces.noteDraft(agentId, text: draft.text, updatedAt: draft.updatedAt)
            }
        }
        let updates = store.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                self.snapshot = snapshot
                for watcher in self.watchers.values { watcher(snapshot) }
            }
        }
        connectionObservation = account.observeAccounts { [weak self, weak account] _ in
            guard let self, let account else { return }
            connectionStatus = account.agentConnections.accounts.first { $0.id == accountID }?.status ?? .paused
            updateHeaderState()
        }
        connectionFollowing = Task { [weak self, engine] in
            for await snapshot in await engine.snapshots() {
                guard !Task.isCancelled, let self else { return }
                connectionSnapshot = snapshot
                updateHeaderState()
            }
        }
        // AgentConnections owns foreground/background and account switching.
        // Opening an offscreen account's settings never starts another stream.
    }

    /// Calls `watch` with every snapshot from now on, starting with the current one.
    func watch(_ watch: @escaping (Snapshot) -> Void) -> Watch {
        let id = UUID()
        watchers[id] = watch
        watch(snapshot)
        return Watch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }

    static func headerState(status: ConnectionStatus, snapshot: HomeSnapshot) -> Strings.HeaderStatus.State {
        switch status {
        case .paused, .revoked: return .offline
        case .retrying: return .connecting
        case .connecting: return .connecting
        case .connected:
            if snapshot.error != nil && !snapshot.live { return .offline }
            return snapshot.live && snapshot.loaded && !snapshot.syncing ? .online : .syncing
        }
    }

    private func updateHeaderState() {
        let next = Self.headerState(status: connectionStatus, snapshot: connectionSnapshot)
        guard next != headerState else { return }
        headerState = next
        for watch in headerWatchers.values { watch(next) }
    }

    func watchHeader(_ watch: @escaping (Strings.HeaderStatus.State) -> Void) -> Watch {
        let id = UUID()
        headerWatchers[id] = watch
        watch(headerState)
        return Watch { [weak self] in self?.headerWatchers.removeValue(forKey: id) }
    }
}

/// Stops watching at `invalidate`, or when it is let go of, whichever comes
/// first, and exactly once. The cancel always runs on the main actor.
///
/// Not `isolated deinit`. That aborts on the iOS 26.3 simulator runtime
/// whenever a screen holding one is freed: libmalloc's "pointer being freed
/// was not allocated", in `TaskLocal::StopLookupScope::~StopLookupScope`
/// under `swift_task_deinitOnExecutor`. It is the runtime's hop to the
/// actor that fails, not this code: clean main (829dab29f) aborts the same
/// way, and the same build is fine on 26.5. Whether a 26.3 device does it
/// too is untested; this avoids the hop either way.
///
/// A `@MainActor` class does not promise its deinit runs on the main actor:
/// the last reference can go anywhere, so the deinit says where it is.
@MainActor
final class Watch {
    private var cancel: (@MainActor @Sendable () -> Void)?

    init(_ cancel: @escaping @MainActor @Sendable () -> Void) { self.cancel = cancel }

    func invalidate() {
        // Taken before it is called, so a cancel that lets this watch go
        // (`deinit` below) finds nothing left to call.
        let cancel = cancel
        self.cancel = nil
        cancel?()
    }

    /// Nonisolated, and the only thing left holding the object, so reading
    /// the cancel races with nothing. The cancel itself is `Sendable` and
    /// main-actor, and it never names the watch, so handing it on is safe.
    deinit {
        guard let cancel else { return }
        if Thread.isMainThread {
            MainActor.assumeIsolated { cancel() }
        } else {
            DispatchQueue.main.async { cancel() }
        }
    }
}
#endif
