import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// The file viewer's cache kept in the account's own files: a file seen
/// once shows again after a relaunch, offline, and never in another
/// account.
final class SessionFileCacheTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("file-cache-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    /// An account's cache directory, made ready as the account starts.
    private func account(_ id: String) throws -> URL {
        let account = root.appendingPathComponent(id, isDirectory: true)
        let directory = SessionFileCache.directory(inAccount: account)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        try SessionFileCache.prepare(directory: directory)
        return directory
    }

    private func snapshot(_ text: String, diff: String? = nil) -> FileViewer.Snapshot {
        FileViewer.Snapshot(content: .init(content: text, isBinary: false), diff: diff)
    }

    private func files(_ directory: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    private let path = SessionFileCacheTests.path
    private static let path = "/repo/src/a.swift"

    func testASeenFileShowsAfterARelaunch() async throws {
        let directory = try account("one")
        let before = SessionFileCache(directory: directory)
        before.set(sessionId: "s", path: path, snapshot("let a = 1\n", diff: "+let a = 1\n"))
        await before.close()

        let after = SessionFileCache(directory: directory)
        // Opening the screen reads only memory: nothing yet.
        XCTAssertNil(after.get(sessionId: "s", path: path))
        let kept = await after.snapshot(sessionId: "s", path: path)
        XCTAssertEqual(kept, snapshot("let a = 1\n", diff: "+let a = 1\n"))
        // Kept in memory from then on.
        XCTAssertEqual(after.get(sessionId: "s", path: path), kept)
        XCTAssertNil(after.get(sessionId: "s", path: "/repo/src/b.swift"))
        let other = await after.snapshot(sessionId: "s", path: "/repo/src/b.swift")
        XCTAssertNil(other)
        // The name says nothing of the session or the path.
        XCTAssertEqual(files(directory).count, 1)
        XCTAssertFalse(files(directory)[0].contains("repo"))
    }

    func testTheNewestReadWins() async throws {
        let directory = try account("one")
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("v1"))
        cache.set(sessionId: "s", path: path, snapshot("v2", diff: "+v2"))
        await cache.close()
        let after = SessionFileCache(directory: directory)
        let kept = await after.snapshot(sessionId: "s", path: path)
        XCTAssertEqual(kept, snapshot("v2", diff: "+v2"))
        XCTAssertEqual(files(directory).count, 1)
    }

    func testAccountsNeverSeeEachOthersFiles() async throws {
        let first = SessionFileCache(directory: try account("one"))
        let second = SessionFileCache(directory: try account("two"))
        first.set(sessionId: "s", path: path, snapshot("secret"))
        await first.disk?.drain()
        // The same session id and path in another account.
        XCTAssertNil(second.get(sessionId: "s", path: path))
        let seen = await second.snapshot(sessionId: "s", path: path)
        XCTAssertNil(seen)
        // And after a relaunch.
        let reopened = SessionFileCache(directory: try account("two"))
        let again = await reopened.snapshot(sessionId: "s", path: path)
        XCTAssertNil(again)
    }

    func testAFailedReadKeepsTheKeptCopy() async throws {
        let directory = try account("one")
        let seeded = SessionFileCache(directory: directory)
        seeded.set(sessionId: "s", path: path, snapshot("kept"))
        await seeded.close()

        // Offline after a relaunch: the copy shows, the read fails.
        let cache = SessionFileCache(directory: directory)
        let kept = await cache.snapshot(sessionId: "s", path: path)
        XCTAssertEqual(kept, snapshot("kept"))
        let offline = SessionShellTransport(
            bash: { _ in throw SessionActionError.noAnswer },
            readFile: { _ in throw SessionActionError.noAnswer }
        )
        let target = FileViewer.Target(rawPath: "src/a.swift", sessionPath: "/repo")
        let failed = await FileViewer.load(target, sessionPath: "/repo", transport: offline, cache: cache, sessionId: "s")
        XCTAssertEqual(failed, .failed(.load, diff: nil))
        XCTAssertEqual(cache.get(sessionId: "s", path: path), snapshot("kept"))
        await cache.close()
        let next = await SessionFileCache(directory: directory).snapshot(sessionId: "s", path: path)
        XCTAssertEqual(next, snapshot("kept"))

        // Back online, the fresh read replaces it.
        let online = SessionShellTransport(
            bash: { _ in SessionBashResponse(success: true, stdout: "", stderr: "", exitCode: 0, error: nil) },
            readFile: { _ in SessionReadFileResponse(success: true, content: Data("fresh".utf8).base64EncodedString(), error: nil) }
        )
        let cache3 = SessionFileCache(directory: directory)
        let loaded = await FileViewer.load(target, sessionPath: "/repo", transport: online, cache: cache3, sessionId: "s")
        XCTAssertEqual(loaded, .loaded(snapshot("fresh")))
        await cache3.close()
        let fresh = await SessionFileCache(directory: directory).snapshot(sessionId: "s", path: path)
        XCTAssertEqual(fresh, snapshot("fresh"))
    }

    func testOneDiskReadHoweverManyAsk() async throws {
        let directory = try account("one")
        let seeded = SessionFileCache(directory: directory)
        seeded.set(sessionId: "s", path: path, snapshot("x"))
        await seeded.close()
        let cache = SessionFileCache(directory: directory)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        let path = Self.path
        async let first = cache.snapshot(sessionId: "s", path: path)
        async let second = cache.snapshot(sessionId: "s", path: path)
        try await Task.sleep(for: .milliseconds(50))
        release()
        let (a, b) = await (first, second)
        XCTAssertEqual(a, snapshot("x"))
        XCTAssertEqual(b, snapshot("x"))
        let reads = await disk.reads
        XCTAssertEqual(reads, 1)
        // Then from memory.
        _ = await cache.snapshot(sessionId: "s", path: path)
        let after = await disk.reads
        XCTAssertEqual(after, 1)
    }

    func testAFreshReadOvertakesADiskReadUnderWay() async throws {
        let directory = try account("one")
        let seeded = SessionFileCache(directory: directory)
        seeded.set(sessionId: "s", path: path, snapshot("old"))
        await seeded.close()
        let cache = SessionFileCache(directory: directory)
        let release = try XCTUnwrap(cache.disk).hold()
        let path = Self.path
        let reading = Task { await cache.snapshot(sessionId: "s", path: path) }
        try await Task.sleep(for: .milliseconds(50))
        cache.set(sessionId: "s", path: path, snapshot("new"))
        release()
        let seen = await reading.value
        XCTAssertEqual(seen, snapshot("new"))
        XCTAssertEqual(cache.get(sessionId: "s", path: path), snapshot("new"))
        await cache.close()
        let reopened = await SessionFileCache(directory: directory).snapshot(sessionId: "s", path: path)
        XCTAssertEqual(reopened, snapshot("new"))
    }

    func testAClosedCacheReadsAndWritesNothing() async throws {
        let directory = try account("one")
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("x"))
        cache.setRoot(sessionId: "s", SessionFileCache.Root(path: "/repo"))
        await cache.close()
        XCTAssertTrue(cache.isClosed)
        XCTAssertNil(cache.get(sessionId: "s", path: path))
        XCTAssertNil(cache.root(sessionId: "s"))
        let read = await cache.snapshot(sessionId: "s", path: path)
        XCTAssertNil(read)
        // The account directory is removed; nothing writes it back.
        try FileManager.default.removeItem(at: directory.deletingLastPathComponent())
        cache.set(sessionId: "s", path: "/repo/b.swift", snapshot("late"))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().path))
    }

    func testPreparingIsSafeEveryLaunchButNeedsTheAccount() throws {
        let account = root.appendingPathComponent("again", isDirectory: true)
        let directory = SessionFileCache.directory(inAccount: account)
        XCTAssertEqual(directory.lastPathComponent, "file-cache")
        // Without the account's directory: nothing is made.
        XCTAssertThrowsError(try SessionFileCache.prepare(directory: directory))
        XCTAssertFalse(FileManager.default.fileExists(atPath: account.path))
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        try SessionFileCache.prepare(directory: directory)
        // The next launch.
        try SessionFileCache.prepare(directory: directory)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.path))
    }

    func testAnUnpreparedDirectoryIsNeverMade() async throws {
        let account = root.appendingPathComponent("fresh", isDirectory: true)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        let directory = SessionFileCache.directory(inAccount: account)
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("x"))
        await cache.disk?.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertEqual(cache.get(sessionId: "s", path: path), snapshot("x"))
    }

    func testAGoneAccountDirectoryStaysGone() async throws {
        let directory = try account("one")
        try FileManager.default.removeItem(at: directory.deletingLastPathComponent())
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("x"))
        await cache.disk?.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().path))
        // Still shown from memory.
        XCTAssertEqual(cache.get(sessionId: "s", path: path), snapshot("x"))
    }

    func testBoundedInMemoryAndOnDisk() async throws {
        let directory = try account("one")
        let cache = SessionFileCache(directory: directory, maxCount: 2, maxCost: 1_000, maxFiles: 2, maxDiskBytes: 100_000, maxEntryBytes: 600)
        for name in ["a", "b", "c"] {
            cache.set(sessionId: "s", path: "/repo/\(name)", snapshot(name))
            await cache.disk?.drain()
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(cache.keptCount, 2)
        XCTAssertNil(cache.get(sessionId: "s", path: "/repo/a"))
        XCTAssertEqual(files(directory).count, 2)
        await cache.close()
        let reopened = SessionFileCache(directory: directory)
        let oldest = await reopened.snapshot(sessionId: "s", path: "/repo/a")
        let newest = await reopened.snapshot(sessionId: "s", path: "/repo/c")
        XCTAssertNil(oldest)
        XCTAssertEqual(newest, snapshot("c"))

        // Bigger than one entry may be: shown and kept in memory, never
        // written, and the older copy on disk goes.
        let big = String(repeating: "x", count: 700)
        let cache2 = SessionFileCache(directory: directory, maxEntryBytes: 600)
        cache2.set(sessionId: "s", path: "/repo/c", snapshot(big))
        await cache2.close()
        let gone = await SessionFileCache(directory: directory).snapshot(sessionId: "s", path: "/repo/c")
        XCTAssertNil(gone)
        // Bigger than the whole memory budget: not kept at all.
        let small = SessionFileCache(directory: nil, maxCost: 10)
        small.set(sessionId: "s", path: path, snapshot(big))
        XCTAssertNil(small.get(sessionId: "s", path: path))
    }

    func testADeletedSessionsFilesGo() async throws {
        let directory = try account("one")
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: "/repo/a", snapshot("a"))
        cache.set(sessionId: "s", path: "/repo/b", snapshot("b"))
        cache.set(sessionId: "t", path: "/repo/a", snapshot("t"))
        cache.removeSession(sessionId: "s")
        XCTAssertNil(cache.get(sessionId: "s", path: "/repo/a"))
        XCTAssertEqual(cache.get(sessionId: "t", path: "/repo/a"), snapshot("t"))
        await cache.close()
        XCTAssertEqual(files(directory).count, 1)
        let reopened = SessionFileCache(directory: directory)
        let deleted = await reopened.snapshot(sessionId: "s", path: "/repo/b")
        let kept = await reopened.snapshot(sessionId: "t", path: "/repo/a")
        XCTAssertNil(deleted)
        XCTAssertEqual(kept, snapshot("t"))
    }

    func testAnUnreadableFileIsAMiss() async throws {
        let directory = try account("one")
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("x"))
        await cache.close()
        let file = directory.appendingPathComponent(try XCTUnwrap(files(directory).first))
        try Data("not json".utf8).write(to: file)
        let reopened = SessionFileCache(directory: directory)
        let read = await reopened.snapshot(sessionId: "s", path: path)
        XCTAssertNil(read)
        XCTAssertTrue(files(directory).isEmpty)
    }
}
