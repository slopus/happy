import Foundation

/// One document as this phone keeps it, under the account's offline folder
/// (`Agents/<account>/documents/<surfaceId>/`):
///
/// - `state.yjs`: the whole replica as one update, rewritten now and then;
/// - `local.log`: every local change since, appended as it is made, so a
///   kill a moment after a keystroke keeps it;
/// - `sending.json`: the change on its way, with its mutation ID, so a
///   retry after a relaunch sends the same bytes under the same ID;
/// - `meta.json`: what the computer is known to have and whether anything
///   made here is still unsent.
///
/// Every file but the log is written whole and atomically. The log is
/// replayed over the state when opened: applying an update twice changes
/// nothing, so a kill between rewriting the state and emptying the log
/// loses nothing either. Not thread-safe: `DocumentSync` owns it.
public final class DocumentKeep {
    public struct Meta: Codable, Equatable, Sendable {
        /// The computer's last head this phone saw.
        public var seq = 0
        /// What the computer is known to hold, per client.
        public var serverVector: [Int: Int] = [:]
        /// The clients whose changes were made on this phone, by any open of it.
        public var localClients: Set<Int> = []
        /// Something made here the computer may not have yet.
        public var unsent = false
        public init() {}
    }

    public struct Sending: Codable, Equatable, Sendable {
        public var mutationId: String
        public var update: Data
        /// The replica's vector for local clients when it was made: what
        /// the computer holds of them once it takes it.
        public var vector: [Int: Int]
    }

    public let directory: URL
    private var log: FileHandle?
    public private(set) var logSize = 0

    public init(directory: URL) {
        self.directory = directory
    }

    public static func directory(offline: URL, surfaceId: String) -> URL {
        offline.appendingPathComponent("documents", isDirectory: true).appendingPathComponent(surfaceId, isDirectory: true)
    }

    private var stateURL: URL { directory.appendingPathComponent("state.yjs") }
    private var logURL: URL { directory.appendingPathComponent("local.log") }
    private var sendingURL: URL { directory.appendingPathComponent("sending.json") }
    private var metaURL: URL { directory.appendingPathComponent("meta.json") }

    /// What was kept: the replica state, the local changes logged after it, and the rest.
    public func read() -> (state: [UInt8]?, local: [[UInt8]], meta: Meta, sending: Sending?) {
        let state = (try? Data(contentsOf: stateURL)).map(Array.init)
        let meta = (try? Data(contentsOf: metaURL)).flatMap { try? JSONDecoder().decode(Meta.self, from: $0) } ?? Meta()
        let sending = (try? Data(contentsOf: sendingURL)).flatMap { try? JSONDecoder().decode(Sending.self, from: $0) }
        var local: [[UInt8]] = []
        if let data = try? Data(contentsOf: logURL) {
            let bytes = Array(data)
            var i = 0
            // A record cut short by a kill mid-write is dropped; the ones before it stand.
            while i + 4 <= bytes.count {
                let length = Int(bytes[i]) | Int(bytes[i + 1]) << 8 | Int(bytes[i + 2]) << 16 | Int(bytes[i + 3]) << 24
                guard i + 4 + length <= bytes.count else { break }
                local.append(Array(bytes[(i + 4)..<(i + 4 + length)]))
                i += 4 + length
            }
            logSize = i
        }
        return (state, local, meta, sending)
    }

    public var exists: Bool { FileManager.default.fileExists(atPath: stateURL.path) }

    /// Keeps one local change at once.
    public func append(_ update: [UInt8]) throws {
        if log == nil {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
            let handle = try FileHandle(forWritingTo: logURL)
            // Past whatever a kill left half-written.
            try handle.truncate(atOffset: UInt64(logSize))
            try handle.seekToEnd()
            log = handle
        }
        let n = update.count
        var record = Data([UInt8(n & 0xff), UInt8(n >> 8 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 24 & 0xff)])
        record.append(contentsOf: update)
        try log?.write(contentsOf: record)
        logSize += record.count
    }

    /// The whole replica, after which the log is empty.
    public func writeState(_ state: [UInt8]) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(state).write(to: stateURL, options: .atomic)
        if let log { try log.truncate(atOffset: 0) } else { try? FileManager.default.removeItem(at: logURL) }
        logSize = 0
    }

    public func writeMeta(_ meta: Meta) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(meta).write(to: metaURL, options: .atomic)
    }

    public func writeSending(_ sending: Sending?) throws {
        guard let sending else { try? FileManager.default.removeItem(at: sendingURL); return }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(sending).write(to: sendingURL, options: .atomic)
    }

    public func close() {
        try? log?.close()
        log = nil
    }

    /// Forgets the document: it was removed, or the computer's copy replaces this one.
    public func remove() {
        close()
        try? FileManager.default.removeItem(at: directory)
        logSize = 0
    }
}
