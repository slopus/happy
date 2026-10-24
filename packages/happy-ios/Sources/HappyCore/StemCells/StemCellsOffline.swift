import Foundation
import HappyWire

/// What one paired computer last showed, kept on this phone so the app
/// opens on it with the computer asleep or out of reach: the sidebar as
/// last read (its document, spaces, bots, tasks, Surfaces, Prioritizing
/// and what new work offers), the computer's model configuration for the
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
        public var surfacesServed: Bool?
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
public actor StemCellsOfflineFile {
    public nonisolated let directory: URL
    private var contents: StemCellsOfflineSnapshot?
    private var saving: Task<Void, Never>?

    public init(directory: URL) {
        self.directory = directory
    }

    /// The folder for a computer; nil where the system gives none.
    public nonisolated static func directory(for accountID: String) -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("StemCells", isDirectory: true)
            .appendingPathComponent(accountID, isDirectory: true)
    }

    /// Forgets everything kept for a computer.
    public nonisolated static func remove(_ accountID: String) {
        if let directory = directory(for: accountID) { try? FileManager.default.removeItem(at: directory) }
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
        guard let data = try? Data(contentsOf: snapshotURL),
              let kept = try? JSONDecoder().decode(StemCellsOfflineSnapshot.self, from: data),
              kept.format == StemCellsOfflineSnapshot.format else { return nil }
        contents = kept
        return kept
    }

    /// Changes what is kept and writes it, after any write before it.
    public func update(_ change: @Sendable (inout StemCellsOfflineSnapshot) -> Void) {
        var next = read() ?? StemCellsOfflineSnapshot()
        change(&next)
        guard next != contents else { return }
        contents = next
        let previous = saving
        let url = snapshotURL
        saving = Task.detached(priority: .utility) {
            await previous?.value
            guard let data = try? JSONEncoder().encode(next) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Waits for the writes already asked for.
    public func flush() async {
        await saving?.value
    }

    // MARK: Pictures

    /// A picture's bytes as last read, by where it is served and its hash.
    public nonisolated func picture(_ path: String, thumbhash: String?) -> Data? {
        try? Data(contentsOf: pictureURL(path, thumbhash: thumbhash))
    }

    public nonisolated func keepPicture(_ data: Data, path: String, thumbhash: String?) {
        let url = pictureURL(path, thumbhash: thumbhash)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }

    /// A name safe on disk: the path and hash, letters and digits only.
    nonisolated func pictureURL(_ path: String, thumbhash: String?) -> URL {
        let key = "\(path)#\(thumbhash ?? "")".unicodeScalars.map { scalar in
            CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII ? String(scalar) : String(format: "_%02x", scalar.value)
        }.joined()
        return picturesURL.appendingPathComponent(key)
    }
}
