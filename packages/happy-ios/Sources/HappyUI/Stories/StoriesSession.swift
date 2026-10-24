#if canImport(UIKit)
import HappyCore
import UIKit

/// One paired computer's Stories, shared by the row, the viewer, the editor
/// and every inline story: the store and the snapshots it hands out. Made
/// once per computer beside its Stem Cells session.
@MainActor
final class StoriesSession {
    let stemCells: StemCellsSession
    let store: StoriesStore
    let media: StoriesMedia
    var client: DirectAgentClient { stemCells.client }
    var images: StemCellsImages { stemCells.images }
    private(set) var snapshot = StoriesSnapshot()
    private var watchers: [UUID: (StoriesSnapshot) -> Void] = [:]
    private var following: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []

    private static var sessions: [String: StoriesSession] = [:]

    static func session(for stemCells: StemCellsSession) -> StoriesSession {
        if let existing = sessions[stemCells.accountID] { return existing }
        let session = StoriesSession(stemCells: stemCells)
        sessions[stemCells.accountID] = session
        return session
    }

    static func forget(_ accountID: String) {
        guard let session = sessions.removeValue(forKey: accountID) else { return }
        session.following?.cancel()
        for observer in session.observers { NotificationCenter.default.removeObserver(observer) }
        session.observers = []
        let store = session.store
        Task { await store.stop() }
    }

    private init(stemCells: StemCellsSession) {
        self.stemCells = stemCells
        store = StoriesStore(client: stemCells.client, stemCells: stemCells.store, offline: stemCells.offline)
        media = StoriesMedia(client: stemCells.client)
        let updates = store.updates
        following = Task { [weak self] in
            for await snapshot in updates {
                guard let self else { return }
                guard snapshot != self.snapshot else { continue }
                self.snapshot = snapshot
                for watcher in self.watchers.values { watcher(snapshot) }
            }
        }
        let store = store
        Task { await store.start() }
        // Back in the foreground, the Stem Cells stream resumes and replays
        // what was missed, or says `resync`. What waits to be kept is saved
        // on the way out.
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak store] _ in
            Task { await store?.flush() }
        })
    }

    /// Calls `watch` with every snapshot from now on, starting with the current one.
    func watch(_ watch: @escaping (StoriesSnapshot) -> Void) -> StemCellsWatch {
        let id = UUID()
        watchers[id] = watch
        watch(snapshot)
        return StemCellsWatch { [weak self] in self?.watchers.removeValue(forKey: id) }
    }
}
#endif
