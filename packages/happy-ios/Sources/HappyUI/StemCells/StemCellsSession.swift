#if canImport(UIKit)
import HappyCore
import UIKit

/// One paired computer's Stem Cells, shared by every screen that shows it:
/// the store, the client its conversations use, the pictures it has read,
/// and which row is open. The store's snapshots arrive here off the main
/// thread's work and are handed to whoever watches.
@MainActor
final class StemCellsSession {
    let accountID: String
    let engine: DirectSyncEngine
    let client: DirectAgentClient
    let store: StemCellsStore
    let images: StemCellsImages
    /// The models the composer's pickers offer, and the dock's pick.
    let models: StemCellModelState
    /// What this computer last showed, for opening on it offline.
    let offline: StemCellsOfflineFile?
    /// The composers' drafts, kept on this phone beside the computer's copy.
    let drafts: StemCellDrafts
    /// Colours the code blocks its conversations show.
    let syntax = CodeSyntaxService()
    /// The conversations read ahead and kept, so they open drawn.
    let warm: StemCellsWarmChats
    private(set) var snapshot = StemCellsSnapshot()
    /// The row whose conversation was opened last; it stays selected.
    var selectedRowId: String?
    private var watchers: [UUID: (StemCellsSnapshot) -> Void] = [:]
    private var following: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    private static var sessions: [String: StemCellsSession] = [:]

    /// The session for a paired computer, made once and kept while the app runs.
    static func session(for accountID: String, context: AppContext) -> StemCellsSession? {
        guard let engine = context.account.direct.syncEngine(for: accountID) else { return nil }
        if let existing = sessions[accountID], existing.engine === engine { return existing }
        let session = StemCellsSession(accountID: accountID, engine: engine)
        sessions[accountID] = session
        return session
    }

    /// Forgets a computer that was unpaired, and what was kept of it.
    static func forget(_ accountID: String) {
        StemCellsOfflineFile.remove(accountID)
        StoriesSession.forget(accountID)
        StemCellFilePreview.removeAll()
        guard let session = sessions.removeValue(forKey: accountID) else { return }
        session.following?.cancel()
        session.warm.stopAll()
        let store = session.store
        Task { await store.stop() }
    }

    private init(accountID: String, engine: DirectSyncEngine) {
        self.accountID = accountID
        self.engine = engine
        let client = engine.client
        self.client = client
        let offline = engine.offline
        self.offline = offline
        Task.detached(priority: .utility) { StemCellsOfflineFile.removeLegacy(accountID) }
        store = engine.spaces
        images = StemCellsImages(client: client, offline: offline)
        warm = StemCellsWarmChats(client: client, store: store, syntax: syntax, persistence: engine)
        models = StemCellModelState(client: client, offline: offline)
        drafts = StemCellDrafts(offline: offline)
        models.load()
        let updates = store.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                self.snapshot = snapshot
                for watcher in self.watchers.values { watcher(snapshot) }
            }
        }
        // DirectAccounts owns foreground/background and account switching.
        // Opening an offscreen account's settings never starts another stream.
    }

    /// Calls `watch` with every snapshot from now on, starting with the current one.
    func watch(_ watch: @escaping (StemCellsSnapshot) -> Void) -> StemCellsWatch {
        let id = UUID()
        watchers[id] = watch
        watch(snapshot)
        return StemCellsWatch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }
}

/// Stops watching when released.
@MainActor
final class StemCellsWatch {
    private var cancel: (() -> Void)?
    init(_ cancel: @escaping () -> Void) { self.cancel = cancel }
    func invalidate() { cancel?(); cancel = nil }
    isolated deinit { cancel?() }
}
#endif
