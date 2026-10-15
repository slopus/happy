import Foundation
import GRDB

public enum LocalStoreError: Error, Equatable, Sendable {
    /// The store was closed: its account signed out, and its files are
    /// gone or about to go.
    case closed
}

/// Whether a store is still open. Checked before every read and write, so
/// a reader that outlives its account gets `LocalStoreError.closed`.
final class StoreLifecycle: @unchecked Sendable {
    private let lock = NSLock()
    private var closed = false

    var isClosed: Bool { lock.withLock { closed } }

    func markClosed() { lock.withLock { closed = true } }

    func checkOpen() throws {
        if isClosed { throw LocalStoreError.closed }
    }
}

extension LocalStore {
    public var isClosed: Bool { lifecycle.isClosed }

    /// Closes every connection to the store, after a sign-out erased it and
    /// before its files are removed. Darwin's SQLite fails every read on a
    /// connection whose file was unlinked (`SQLITE_IOERR_VNODE`) where
    /// Linux's keeps reading the open file, so a store is closed first and
    /// whatever still holds it reads `LocalStoreError.closed` on any
    /// platform. Waits for reads and writes under way. Throws if a
    /// connection can't be closed, and the files must then stay.
    public func close() throws {
        ThreadRules.assertOffMain()
        lifecycle.markClosed()
        try writer.close()
    }
}
