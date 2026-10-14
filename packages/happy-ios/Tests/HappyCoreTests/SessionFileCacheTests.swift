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

    /// An account's cache directory, made ready as the account starts: off
    /// the main thread, as `prepare` requires.
    private func account(_ id: String) async throws -> URL {
        let account = root.appendingPathComponent(id, isDirectory: true)
        let directory = SessionFileCache.directory(inAccount: account)
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        try await Self.prepare(directory)
        return directory
    }

    private static func prepare(_ directory: URL) async throws {
        try await Task.detached { try SessionFileCache.prepare(directory: directory) }.value
    }

    private func snapshot(_ text: String, diff: String? = nil) -> FileViewer.Snapshot {
        FileViewer.Snapshot(content: .init(content: text, isBinary: false), diff: diff)
    }

    private func files(_ directory: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    private let path = SessionFileCacheTests.path
    private static let path = "/repo/src/a.swift"

    /// Waits until `condition` holds: a state the code under test reaches
    /// on another task, polled rather than slept for.
    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("never happened", file: file, line: line)
                return
            }
            try await Task.sleep(for: .milliseconds(1))
        }
    }

    func testASeenFileShowsAfterARelaunch() async throws {
        let directory = try await account("one")
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
        let directory = try await account("one")
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
        let first = SessionFileCache(directory: try await account("one"))
        let second = SessionFileCache(directory: try await account("two"))
        first.set(sessionId: "s", path: path, snapshot("secret"))
        await first.disk?.drain()
        // The same session id and path in another account.
        XCTAssertNil(second.get(sessionId: "s", path: path))
        let seen = await second.snapshot(sessionId: "s", path: path)
        XCTAssertNil(seen)
        // And after a relaunch.
        let reopened = SessionFileCache(directory: try await account("two"))
        let again = await reopened.snapshot(sessionId: "s", path: path)
        XCTAssertNil(again)
    }

    func testAFailedReadKeepsTheKeptCopy() async throws {
        let directory = try await account("one")
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
        let directory = try await account("one")
        let seeded = SessionFileCache(directory: directory)
        seeded.set(sessionId: "s", path: path, snapshot("x"))
        await seeded.close()
        let cache = SessionFileCache(directory: directory)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        let path = Self.path
        async let first = cache.snapshot(sessionId: "s", path: path)
        async let second = cache.snapshot(sessionId: "s", path: path)
        // Both wait on the held disk before it goes on.
        try await until { cache.diskWaitCount == 2 }
        XCTAssertEqual(cache.pendingReadCount, 1)
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
        let directory = try await account("one")
        let seeded = SessionFileCache(directory: directory)
        seeded.set(sessionId: "s", path: path, snapshot("old"))
        await seeded.close()
        let cache = SessionFileCache(directory: directory)
        let release = try XCTUnwrap(cache.disk).hold()
        let path = Self.path
        let reading = Task { await cache.snapshot(sessionId: "s", path: path) }
        try await until { cache.pendingReadCount == 1 }
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
        let directory = try await account("one")
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
        // Whatever the queue was asked for has been done.
        await cache.disk?.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().path))
    }

    func testPreparingIsSafeEveryLaunchButNeedsTheAccount() async throws {
        let account = root.appendingPathComponent("again", isDirectory: true)
        let directory = SessionFileCache.directory(inAccount: account)
        XCTAssertEqual(directory.lastPathComponent, "file-cache")
        // Without the account's directory: nothing is made.
        do {
            try await Self.prepare(directory)
            XCTFail("prepared without the account's directory")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: account.path))
        try FileManager.default.createDirectory(at: account, withIntermediateDirectories: true)
        try await Self.prepare(directory)
        // The next launch.
        try await Self.prepare(directory)
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
        let directory = try await account("one")
        try FileManager.default.removeItem(at: directory.deletingLastPathComponent())
        let cache = SessionFileCache(directory: directory)
        cache.set(sessionId: "s", path: path, snapshot("x"))
        await cache.disk?.drain()
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.deletingLastPathComponent().path))
        // Still shown from memory.
        XCTAssertEqual(cache.get(sessionId: "s", path: path), snapshot("x"))
    }

    func testBoundedInMemoryAndOnDisk() async throws {
        let directory = try await account("one")
        let cache = SessionFileCache(directory: directory, maxCount: 2, maxCost: 1_000, maxFiles: 2, maxDiskBytes: 100_000, maxEntryBytes: 600)
        for (index, name) in ["a", "b", "c"].enumerated() {
            cache.set(sessionId: "s", path: "/repo/\(name)", snapshot(name))
            await cache.disk?.drain()
            // Used in this order, whatever the clock's resolution.
            let file = directory.appendingPathComponent(FileCacheDisk.name(.init(sessionId: "s", path: "/repo/\(name)")))
            try? FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(index + 1))], ofItemAtPath: file.path)
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
        let directory = try await account("one")
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

    // MARK: What waits for the disk

    private func cost(_ snapshot: FileViewer.Snapshot) -> Int {
        FileCacheDisk.cost(snapshot)
    }

    /// Writes a copy of each path, as an earlier launch did.
    private func seed(_ directory: URL, _ keys: [(String, String)], text: String = "old") async {
        let seeded = SessionFileCache(directory: directory)
        for (sessionId, path) in keys { seeded.set(sessionId: sessionId, path: path, snapshot(text)) }
        await seeded.close()
    }

    func testAHeldWriterKeepsOneWriteAFileTheNewest() async throws {
        let directory = try await account("one")
        let cache = SessionFileCache(directory: directory)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        for version in 1...50 {
            cache.set(sessionId: "s", path: path, snapshot("v\(version)"))
        }
        XCTAssertEqual(disk.waiting.count, 1)
        XCTAssertEqual(disk.waiting.bytes, cost(snapshot("v50")))
        release()
        await disk.drain()
        XCTAssertEqual(disk.waiting.count, 0)
        XCTAssertEqual(disk.waiting.bytes, 0)
        let writes = await disk.writes
        XCTAssertEqual(writes, 1)
        await cache.close()
        let kept = await SessionFileCache(directory: directory).snapshot(sessionId: "s", path: path)
        XCTAssertEqual(kept, snapshot("v50"))
    }

    func testAHeldWriterHoldsNoMoreTextThanItsBudgetAndNothingComesBackStale() async throws {
        let directory = try await account("one")
        let names = ["a", "b", "c", "d"]
        await seed(directory, names.map { ("s", "/repo/\($0)") })
        let cache = SessionFileCache(directory: directory, maxPendingBytes: 2_500)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        for name in names {
            cache.set(sessionId: "s", path: "/repo/\(name)", snapshot(String(repeating: name, count: 1_000)))
            XCTAssertLessThanOrEqual(disk.waiting.bytes, 2_500)
        }
        // Two writes wait; the two older gave way to removals.
        XCTAssertEqual(disk.waiting.count, 4)
        XCTAssertEqual(disk.waiting.bytes, 2_000)
        // Every read still shows from memory.
        for name in names {
            XCTAssertEqual(cache.get(sessionId: "s", path: "/repo/\(name)"), snapshot(String(repeating: name, count: 1_000)))
        }
        release()
        await disk.drain()
        let writes = await disk.writes
        XCTAssertEqual(writes, 2)
        await cache.close()
        let reopened = SessionFileCache(directory: directory)
        for name in ["a", "b"] {
            // The old copy went with the write that gave way.
            let read = await reopened.snapshot(sessionId: "s", path: "/repo/\(name)")
            XCTAssertNil(read)
        }
        for name in ["c", "d"] {
            let read = await reopened.snapshot(sessionId: "s", path: "/repo/\(name)")
            XCTAssertEqual(read, snapshot(String(repeating: name, count: 1_000)))
        }
    }

    func testTooManyWaitingChangesEmptyTheDirectoryFirst() async throws {
        let directory = try await account("one")
        await seed(directory, [("z", "/repo/z")])
        let cache = SessionFileCache(directory: directory, maxPendingChanges: 3)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        for index in 1...5 {
            cache.set(sessionId: "s", path: "/repo/\(index)", snapshot("\(index)"))
            XCTAssertLessThanOrEqual(disk.waiting.count, 3)
        }
        cache.removeSession(sessionId: "z")
        XCTAssertEqual(disk.waiting.count, 2)
        release()
        await disk.drain()
        await cache.close()
        XCTAssertEqual(files(directory).count, 2)
        let reopened = SessionFileCache(directory: directory)
        for index in 1...3 {
            let read = await reopened.snapshot(sessionId: "s", path: "/repo/\(index)")
            XCTAssertNil(read)
        }
        for index in 4...5 {
            let read = await reopened.snapshot(sessionId: "s", path: "/repo/\(index)")
            XCTAssertEqual(read, snapshot("\(index)"))
        }
        let gone = await reopened.snapshot(sessionId: "z", path: "/repo/z")
        XCTAssertNil(gone)
    }

    func testASessionDeletedWhileTheWriterIsHeldDropsItsWaitingWrites() async throws {
        let directory = try await account("one")
        await seed(directory, [("s", "/repo/old")])
        let cache = SessionFileCache(directory: directory)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        cache.set(sessionId: "s", path: "/repo/a", snapshot("sa"))
        cache.set(sessionId: "t", path: "/repo/a", snapshot("ta"))
        cache.set(sessionId: "s", path: "/repo/b", snapshot("sb"))
        cache.removeSession(sessionId: "s")
        // t's write and s's removal; s's writes are let go at once.
        XCTAssertEqual(disk.waiting.count, 2)
        XCTAssertEqual(disk.waiting.bytes, cost(snapshot("ta")))
        // Read again after the deletion: kept.
        cache.set(sessionId: "s", path: "/repo/c", snapshot("sc"))
        release()
        await disk.drain()
        await cache.close()
        let reopened = SessionFileCache(directory: directory)
        for path in ["/repo/old", "/repo/a", "/repo/b"] {
            let read = await reopened.snapshot(sessionId: "s", path: path)
            XCTAssertNil(read)
        }
        let kept = await reopened.snapshot(sessionId: "s", path: "/repo/c")
        let other = await reopened.snapshot(sessionId: "t", path: "/repo/a")
        XCTAssertEqual(kept, snapshot("sc"))
        XCTAssertEqual(other, snapshot("ta"))
    }

    func testClosingWritesWhatWaitsThenNothing() async throws {
        let directory = try await account("one")
        let cache = SessionFileCache(directory: directory)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        cache.set(sessionId: "s", path: "/repo/a", snapshot("a"))
        let closing = Task { await cache.close() }
        try await until { !disk.isAccepting }
        // Asked for after closing began.
        cache.set(sessionId: "s", path: "/repo/b", snapshot("b"))
        disk.write(SessionFileCache.Key(sessionId: "s", path: "/repo/c"), snapshot("c"))
        XCTAssertEqual(disk.waiting.count, 1)
        release()
        await closing.value
        XCTAssertEqual(disk.waiting.count, 0)
        XCTAssertEqual(files(directory).count, 1)
        let reopened = SessionFileCache(directory: directory)
        let written = await reopened.snapshot(sessionId: "s", path: "/repo/a")
        XCTAssertEqual(written, snapshot("a"))
    }

    func testWaitingWorkIsDoneInTheOrderAsked() {
        let a = SessionFileCache.Key(sessionId: "s", path: "/a")
        let b = SessionFileCache.Key(sessionId: "s", path: "/b")
        let t = SessionFileCache.Key(sessionId: "t", path: "/a")
        var work = PendingDiskWork(maxBytes: 100, maxChanges: 8)
        work.set(a, .write(snapshot("1"), cost: 1))
        work.set(t, .write(snapshot("2"), cost: 1))
        work.removeSession("s")
        work.set(b, .write(snapshot("3"), cost: 1))
        work.set(t, .write(snapshot("4"), cost: 1))
        XCTAssertEqual(work.bytes, 2)
        var done: [PendingDiskWork.Work] = []
        while let next = work.next() { done.append(next) }
        XCTAssertEqual(done, [
            .removeSession("s"),
            .change(b, .write(snapshot("3"), cost: 1)),
            .change(t, .write(snapshot("4"), cost: 1)),
        ])
        XCTAssertTrue(work.isEmpty)
        XCTAssertEqual(work.bytes, 0)
    }

    func testRootsKeepTheMostRecentlyUsed() {
        let cache = SessionFileCache(directory: nil, maxRoots: 2)
        cache.setRoot(sessionId: "one", SessionFileCache.Root(path: "/1"))
        cache.setRoot(sessionId: "two", SessionFileCache.Root(path: "/2"))
        // Asking counts as a use.
        XCTAssertEqual(cache.root(sessionId: "one"), SessionFileCache.Root(path: "/1"))
        cache.setRoot(sessionId: "three", SessionFileCache.Root(path: "/3"))
        XCTAssertEqual(cache.rootCount, 2)
        XCTAssertNil(cache.root(sessionId: "two"))
        XCTAssertEqual(cache.root(sessionId: "one"), SessionFileCache.Root(path: "/1"))
        XCTAssertEqual(cache.root(sessionId: "three"), SessionFileCache.Root(path: "/3"))
        cache.removeSession(sessionId: "three")
        XCTAssertNil(cache.root(sessionId: "three"))
        XCTAssertEqual(cache.rootCount, 1)
    }

    func testHeldReadsAreAdmittedUpToTheirLimit() async throws {
        let directory = try await account("one")
        await seed(directory, ["a", "b", "c"].map { ("s", "/repo/\($0)") })
        let cache = SessionFileCache(directory: directory, maxPendingReads: 2)
        let disk = try XCTUnwrap(cache.disk)
        let release = disk.hold()
        let first = Task { await cache.snapshot(sessionId: "s", path: "/repo/a") }
        let second = Task { await cache.snapshot(sessionId: "s", path: "/repo/b") }
        try await until { cache.diskWaitCount == 2 }
        XCTAssertEqual(cache.pendingReadCount, 2)
        // The same file again joins its read.
        let again = Task { await cache.snapshot(sessionId: "s", path: "/repo/a") }
        try await until { cache.diskWaitCount == 3 }
        XCTAssertEqual(cache.pendingReadCount, 2)
        // A third file is a miss at once, with the disk still held.
        let third = await cache.snapshot(sessionId: "s", path: "/repo/c")
        XCTAssertNil(third)
        XCTAssertEqual(cache.pendingReadCount, 2)
        release()
        let a = await first.value
        let b = await second.value
        let a2 = await again.value
        XCTAssertEqual(a, snapshot("old"))
        XCTAssertEqual(b, snapshot("old"))
        XCTAssertEqual(a2, snapshot("old"))
        XCTAssertEqual(cache.pendingReadCount, 0)
        let reads = await disk.reads
        XCTAssertEqual(reads, 2)
        // Admitted once the others are done.
        let later = await cache.snapshot(sessionId: "s", path: "/repo/c")
        XCTAssertEqual(later, snapshot("old"))
        let after = await disk.reads
        XCTAssertEqual(after, 3)
    }

    func testAFileOnDiskBiggerThanAnEntryIsNeverRead() async throws {
        let directory = try await account("one")
        await seed(directory, [("s", path)])
        let file = directory.appendingPathComponent(try XCTUnwrap(files(directory).first))
        // As if written by something else: valid, but past the entry cap.
        let big = SessionFileCache(directory: directory, maxEntryBytes: 10_000)
        big.set(sessionId: "s", path: path, snapshot(String(repeating: "x", count: 2_000)))
        await big.close()
        XCTAssertGreaterThan(try XCTUnwrap(file.resourceValues(forKeys: [.fileSizeKey]).fileSize), 1_000)
        let cache = SessionFileCache(directory: directory, maxEntryBytes: 1_000)
        let read = await cache.snapshot(sessionId: "s", path: path)
        XCTAssertNil(read)
        XCTAssertTrue(files(directory).isEmpty)
    }

    func testAnUnreadableFileIsAMiss() async throws {
        let directory = try await account("one")
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
