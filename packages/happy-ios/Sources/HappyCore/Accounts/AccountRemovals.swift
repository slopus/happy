import Foundation

/// An account signed out here, or an agent disconnected, whose cleanup
/// hasn't finished: its Keychain item, its folder, its device settings.
/// Secret-free.
public struct AccountRemoval: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case legacy, agent }
    public var id: String
    public var kind: Kind
    /// A Happy account's Keychain item; nil for an agent.
    public var location: CredentialLocation?
    /// A Happy account's confirmed server, where its push token is removed
    /// from; nil for an agent or a server never confirmed.
    public var serverURL: URL?

    public init(id: String, kind: Kind, location: CredentialLocation? = nil, serverURL: URL? = nil) {
        self.id = id
        self.kind = kind
        self.location = location
        self.serverURL = serverURL
    }
}

/// `Happy/removals.json`: written before an account's cleanup begins and
/// cleared once it is done, so a kill in between resumes it at the next
/// launch, and the account, whose Keychain item may still be there, is
/// never listed again.
///
/// `add` is the one write on the main thread in a sign-out, and on
/// purpose: a few hundred bytes written atomically, well under a
/// millisecond, so that the account is gone for good the moment it leaves
/// the screen, even if the app is killed in the very next frame.
///
/// One serial queue does every read and write in order: `add` waits on it,
/// so a `finish` still on its way never strikes a newer `add`.
final class AccountRemovalJournal: @unchecked Sendable {
    private let queue = DispatchQueue(label: "happy.account-removals")
    private var file: URL? // on `queue`
    private var entries: [AccountRemoval] = [] // on `queue`
    private var loaded = false // on `queue`

    func configure(directory: URL?) {
        queue.sync {
            guard !loaded else { return }
            file = directory?.appendingPathComponent("removals.json")
        }
    }

    /// What was left unfinished, read once.
    func pending() -> [AccountRemoval] {
        queue.sync { loadIfNeeded() }
    }

    func add(_ removal: AccountRemoval) throws {
        try queue.sync {
            _ = loadIfNeeded()
            entries.removeAll { $0.id == removal.id }
            entries.append(removal)
            try persist()
        }
    }

    /// Struck off the main thread; a failed write leaves it to be finished
    /// again, harmlessly, at the next launch.
    func finish(_ id: String) {
        queue.async { [self] in
            _ = loadIfNeeded()
            guard entries.contains(where: { $0.id == id }) else { return }
            entries.removeAll { $0.id == id }
            try? persist()
        }
    }

    private func loadIfNeeded() -> [AccountRemoval] {
        guard !loaded else { return entries }
        loaded = true
        if let file, let data = try? Data(contentsOf: file),
           let saved = try? JSONDecoder().decode([AccountRemoval].self, from: data) {
            entries = saved
        }
        return entries
    }

    private func persist() throws {
        guard let file else { return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: file, options: .atomic)
    }
}

/// Waits for `work` no longer than `limit`; `work` goes on regardless.
/// For a removal's teardown: a socket or request stuck on the network,
/// deaf even to cancellation, holds back what comes after it only so long.
func waitAtMost(_ limit: Duration, for work: @escaping @Sendable () async -> Void) async {
    let gate = ResumeOnce()
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let resume = { @Sendable in
            if gate.claim() { continuation.resume() }
        }
        Task {
            await work()
            resume()
        }
        Task {
            try? await Task.sleep(for: limit)
            resume()
        }
    }
}

private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false // under `lock`
    func claim() -> Bool {
        lock.withLock {
            defer { done = true }
            return !done
        }
    }
}
