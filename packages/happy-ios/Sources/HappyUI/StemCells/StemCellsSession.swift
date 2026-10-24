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
    let client: DirectAgentClient
    let store: StemCellsStore
    let images: StemCellsImages
    /// Colours the code blocks its conversations show.
    let syntax = CodeSyntaxService()
    private(set) var snapshot = StemCellsSnapshot()
    /// The row whose conversation was opened last; it stays selected.
    var selectedRowId: String?
    private var watchers: [UUID: (StemCellsSnapshot) -> Void] = [:]
    private var following: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    private static var sessions: [String: StemCellsSession] = [:]

    /// The session for a paired computer, made once and kept while the app runs.
    static func session(for accountID: String, context: AppContext) -> StemCellsSession? {
        if let existing = sessions[accountID] { return existing }
        guard let client = context.account.direct.agentClient(for: accountID) else { return nil }
        let session = StemCellsSession(accountID: accountID, client: client)
        sessions[accountID] = session
        return session
    }

    /// Forgets a computer that was unpaired.
    static func forget(_ accountID: String) {
        guard let session = sessions.removeValue(forKey: accountID) else { return }
        session.following?.cancel()
        let store = session.store
        Task { await store.stop() }
    }

    private init(accountID: String, client: DirectAgentClient) {
        self.accountID = accountID
        self.client = client
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        let cache = caches?.appendingPathComponent("StemCells", isDirectory: true).appendingPathComponent("\(accountID).json")
        store = StemCellsStore(client: client, cache: cache, labels: StemCellsRows.Labels(
            search: Strings.StemCells.search, create: Strings.StemCells.create, untitled: Strings.StemCells.untitled,
            untitledSession: Strings.StemCells.untitledSession, widget: Strings.StemCells.prioritizing
        ))
        images = StemCellsImages(client: client)
        let updates = store.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                self.snapshot = snapshot
                for watcher in self.watchers.values { watcher(snapshot) }
            }
        }
        let store = store
        Task { await store.start() }
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { await store.attentionVisibleUpdate(false); await store.pause() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            Task { await store.start() }
        })
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
