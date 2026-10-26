import Foundation
import HappyCrypto
import HappyWire

/// What one paired computer last showed, kept on this phone so the app
/// opens on it with the computer asleep or out of reach: the sidebar as
/// last read (its document, spaces, bots, tasks, Surfaces and
/// Prioritizing), the computer's model configuration for the
/// pickers, the dock's pick, and the pictures the rows wear.
///
/// One folder per computer, `StemCells/<account>/` under Application
/// Support: `snapshot.json` and `pictures/`. Removing the computer removes
/// the folder (`DirectAccounts.remove`).
public struct StemCellsOfflineSnapshot: Codable, Equatable, Sendable {
    public struct Sidebar: Codable, Equatable, Sendable {
        public var artifactId: String
        public var version: Int
        public var html: String
        public var spaces: [AgentWire.Space]
        public var agentIcons: [String: AgentWire.LibraryIcon]
        public var bots: [JSONValue]
        public var tasks: [JSONValue]
        /// Absent in a copy written before they were kept.
        public var surfaces: [AgentWire.Surface]?
        public var capabilities: AgentWire.Health.Capabilities?
        public var prioritizing: Bool?
    }

    /// Bumped when an older copy can no longer be read as this one.
    public static let format = 1

    public var format = Self.format
    public var sidebar: Sidebar?
    /// `GET /v0/config` as the computer sent it: its order is the pickers'.
    public var config: String?
    /// What new work goes with, picked on the dock.
    public var dockMode: AgentWire.Mode?

    public init() {}
}

/// The folder, and the one writer of its snapshot: every change is merged
/// into what was last written and saved off the main thread, in order.
///
/// Every write to the folder goes through its gate, and removing the
/// computer closes the gate and deletes the folder under the same lock: a
/// write still on its way when the computer goes finds the gate shut and
/// writes nothing, so nothing of a removed computer comes back.
public actor StemCellsOfflineFile {
    public nonisolated let directory: URL
    private nonisolated let gate: Gate
    private var contents: StemCellsOfflineSnapshot?
    private var saving: Task<Void, Never>?

    public init(directory: URL) {
        self.directory = directory
        gate = Gate.open(directory)
    }

    /// The folder for a computer; nil where the system gives none.
    public nonisolated static func directory(for accountID: String) -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("StemCells", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
    }

    /// Forgets everything kept for a computer, and refuses what any file
    /// still open on it would write later.
    public nonisolated static func remove(_ accountID: String) {
        if let directory = directory(for: accountID) { Gate.close(directory) }
        removeLegacy(accountID)
    }

    /// The sidebar copy kept before this folder, in Caches.
    public nonisolated static func removeLegacy(_ accountID: String) {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        try? FileManager.default.removeItem(at: caches.appendingPathComponent("StemCells", isDirectory: true).appendingPathComponent("\(accountID).json"))
    }

    public nonisolated var snapshotURL: URL { directory.appendingPathComponent("snapshot.json") }
    public nonisolated var picturesURL: URL { directory.appendingPathComponent("pictures", isDirectory: true) }

    /// What was kept, read once; nil when nothing was or it can't be read.
    public func read() -> StemCellsOfflineSnapshot? {
        if let contents { return contents }
        guard !gate.isClosed, let data = try? Data(contentsOf: snapshotURL),
              let kept = try? JSONDecoder().decode(StemCellsOfflineSnapshot.self, from: data),
              kept.format == StemCellsOfflineSnapshot.format else { return nil }
        contents = kept
        return kept
    }

    /// Changes what is kept and writes it, after any write before it.
    public func update(_ change: @Sendable (inout StemCellsOfflineSnapshot) -> Void) {
        guard !gate.isClosed else { return }
        var next = read() ?? StemCellsOfflineSnapshot()
        change(&next)
        guard next != contents else { return }
        contents = next
        let previous = saving
        let url = snapshotURL
        let gate = gate
        saving = Task.detached(priority: .utility) {
            await previous?.value
            guard let data = try? JSONEncoder().encode(next) else { return }
            gate.write {
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    /// Waits for the writes already asked for.
    public func flush() async {
        await saving?.value
    }

    // MARK: Other files

    /// A file another feature keeps for this computer (`stories.json`),
    /// written whole through the gate, so it goes with the computer.
    public nonisolated func writeExtra(_ name: String, data: Data) {
        let url = directory.appendingPathComponent(name)
        gate.write {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    public nonisolated func readExtra(_ name: String) -> Data? {
        guard !gate.isClosed else { return nil }
        return try? Data(contentsOf: directory.appendingPathComponent(name))
    }

    // MARK: Pictures

    /// A picture's bytes as last read, by where it is served and its hash.
    public nonisolated func picture(_ path: String, thumbhash: String?) -> Data? {
        guard !gate.isClosed else { return nil }
        return try? Data(contentsOf: pictureURL(path, thumbhash: thumbhash))
    }

    /// Keeps a picture, in place of any other kept from the same path: a
    /// new avatar replaces the old one rather than piling up beside it.
    public nonisolated func keepPicture(_ data: Data, path: String, thumbhash: String?) {
        let url = pictureURL(path, thumbhash: thumbhash)
        gate.write {
            let folder = url.deletingLastPathComponent()
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// `pictures/<path's digest>/<hash's digest>`: short, safe names, one
    /// folder per path.
    nonisolated func pictureURL(_ path: String, thumbhash: String?) -> URL {
        picturesURL.appendingPathComponent(Self.digest(path), isDirectory: true).appendingPathComponent(Self.digest(thumbhash ?? ""))
    }

    nonisolated static func digest(_ text: String) -> String {
        Hashing.sha256(Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// The one lock every write to a folder takes, shared by every file
    /// open on that folder.
    final class Gate: @unchecked Sendable {
        private static let lock = NSLock()
        nonisolated(unsafe) private static var gates: [URL: Gate] = [:] // under `lock`
        private let lock = NSLock()
        private var closed = false
        private let directory: URL

        private init(directory: URL) { self.directory = directory }

        static func open(_ directory: URL) -> Gate {
            lock.lock(); defer { lock.unlock() }
            if let gate = gates[directory] { return gate }
            let gate = Gate(directory: directory)
            gates[directory] = gate
            return gate
        }

        /// Shuts the folder's gate and deletes it; a later file opens a new one.
        static func close(_ directory: URL) {
            lock.lock()
            let gate = gates.removeValue(forKey: directory) ?? Gate(directory: directory)
            lock.unlock()
            gate.lock.lock(); defer { gate.lock.unlock() }
            gate.closed = true
            try? FileManager.default.removeItem(at: directory)
        }

        var isClosed: Bool {
            lock.lock(); defer { lock.unlock() }
            return closed
        }

        func write(_ body: () -> Void) {
            lock.lock(); defer { lock.unlock() }
            guard !closed else { return }
            body()
        }
    }
}
