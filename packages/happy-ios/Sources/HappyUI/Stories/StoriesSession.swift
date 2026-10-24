#if canImport(UIKit)
import HappyCore
import UIKit

/// One paired computer's Stories, shared by the row, the viewer, the editor
/// and every inline story: the store and the snapshots it hands out. Made
/// once per computer beside its Stem Cells session.
@MainActor
final class StoriesSession {
    /// The computer's Stem Cells; nil in the harness, which has none.
    private(set) weak var stemCells: StemCellsSession?
    let accountID: String
    let client: DirectAgentClient
    let images: StemCellsImages
    let store: StoriesStore
    let media: StoriesMedia
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

    private convenience init(stemCells: StemCellsSession) {
        let events = stemCells.store
        self.init(accountID: stemCells.accountID, client: stemCells.client, images: stemCells.images, offline: stemCells.offline) {
            await events.events(matching: StoriesStore.eventPrefixes)
        }
        self.stemCells = stemCells
    }

    /// Stories from parts: the harness draws the viewer and editor over a
    /// computer of its own this way.
    init(accountID: String, client: DirectAgentClient, images: StemCellsImages, offline: StemCellsOfflineFile?, events: @escaping StoriesStore.Events) {
        self.accountID = accountID
        self.client = client
        self.images = images
        store = StoriesStore(client: client, events: events, offline: offline)
        media = StoriesMedia(client: client)
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
