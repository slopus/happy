import Foundation
import GRDB
import XCTest
@testable import HappyStore
import HappyWire

/// A store closed before its files go: whatever still holds it reads
/// `LocalStoreError.closed` on every platform, never Darwin's
/// `SQLITE_IOERR_VNODE` for a file unlinked under an open connection.
final class StoreClosingTests: XCTestCase {
    private func onDisk() throws -> (LocalStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("happy-close-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return (try LocalStore.open(at: directory.appendingPathComponent("store.sqlite")), directory)
    }

    func testAClosedStoreRefusesReadsAndWrites() throws {
        let (store, _) = try onDisk()
        try store.upsertSessions([makeSession("s")])
        XCTAssertFalse(store.isClosed)
        try store.close()
        XCTAssertTrue(store.isClosed)
        XCTAssertThrowsError(try store.sessions()) { XCTAssertEqual($0 as? LocalStoreError, .closed) }
        XCTAssertThrowsError(try store.profile()) { XCTAssertEqual($0 as? LocalStoreError, .closed) }
        XCTAssertThrowsError(try store.setCursor(.sessionsChangedSince, 1)) { XCTAssertEqual($0 as? LocalStoreError, .closed) }
        // Connections opened behind the store's back are closed too.
        XCTAssertThrowsError(try store.writer.read { try Int.fetchOne($0, sql: "SELECT 1") }) {
            XCTAssertEqual(($0 as? DatabaseError)?.resultCode, .SQLITE_MISUSE)
        }
    }

    /// Erase, close, remove, as signing out does: the files go and a
    /// retained store keeps answering `closed`.
    func testErasedClosedThenRemoved() throws {
        let (store, directory) = try onDisk()
        try store.applyProfile(AccountProfile(id: "A", timestamp: 1, firstName: "Private Name"))
        try store.eraseAll()
        XCTAssertNil(try store.profile())
        try store.close()
        try FileManager.default.removeItem(at: directory)
        for _ in 0..<2 {
            XCTAssertThrowsError(try store.profile()) { XCTAssertEqual($0 as? LocalStoreError, .closed) }
        }
    }

    func testClosingTwiceIsFine() throws {
        let (store, _) = try onDisk()
        try store.close()
        try store.close()
        XCTAssertTrue(store.isClosed)
    }
}
