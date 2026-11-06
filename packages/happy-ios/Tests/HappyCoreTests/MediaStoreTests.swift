import Foundation
import HappyCrypto
import XCTest
@testable import HappyCore

/// A server's file, answering ranges as a daemon or S3 would, counting
/// what it was asked.
final class FakeMediaServer: @unchecked Sendable {
    let bytes: Data
    /// A server that ignores `Range` and answers the whole file.
    var ignoresRanges = false
    /// Fetches fail with this until it is cleared.
    var failing: Error?
    /// Each fetch waits for this before answering, when set.
    var gate: (@Sendable () async -> Void)?
    private let lock = NSLock()
    private var asked: [Range<Int>] = []

    init(_ bytes: Data) { self.bytes = bytes }

    var requests: [Range<Int>] { lock.withLock { asked } }
    var served: Int { lock.withLock { asked.reduce(0) { $0 + $1.count } } }

    func source(length: Int? = nil, seal: MediaSeal? = nil) -> MediaSource {
        MediaSource(length: length, seal: seal) { [self] range in
            if let gate { await gate() }
            if let failing { throw failing }
            if ignoresRanges {
                lock.withLock { asked.append(0..<bytes.count) }
                return MediaPiece(offset: 0, data: bytes, total: bytes.count)
            }
            let clamped = range.clamped(to: 0..<bytes.count)
            lock.withLock { asked.append(clamped) }
            return MediaPiece(offset: clamped.lowerBound, data: bytes.subdata(in: clamped), total: bytes.count)
        }
    }
}

func mediaBytes(_ count: Int, seed: UInt8 = 7) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ Int(seed)) })
}

final class MediaStoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("MediaStoreTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Partial file

    func testAPartialFileHoldsRangesOutOfOrderAndReadsOnlyWhatIsThere() throws {
        let file = PartialFile(dataURL: directory.appendingPathComponent("a.part"), metaURL: directory.appendingPathComponent("a.part.meta"))
        let bytes = mediaBytes(1000)
        try file.setTotal(1000)
        try file.write(bytes.subdata(in: 600..<800), at: 600)
        try file.write(bytes.subdata(in: 0..<100), at: 0)
        XCTAssertEqual(file.downloaded, 300)
        XCTAssertEqual(file.held, [0..<100, 600..<800])
        XCTAssertEqual(file.missing(in: 0..<1000), [100..<600, 800..<1000])
        XCTAssertEqual(file.read(650..<700), bytes.subdata(in: 650..<700))
        XCTAssertNil(file.read(90..<110))
        XCTAssertEqual(file.contiguous(from: 50, limit: 1000), 50)
        XCTAssertFalse(file.isComplete)
        try file.write(bytes.subdata(in: 100..<600), at: 100)
        try file.write(bytes.subdata(in: 800..<1000), at: 800)
        XCTAssertTrue(file.isComplete)
        XCTAssertEqual(file.read(0..<1000), bytes)
    }

    func testAPartialFileResumesAfterARelaunch() throws {
        let data = directory.appendingPathComponent("b.part")
        let meta = directory.appendingPathComponent("b.part.meta")
        let bytes = mediaBytes(500)
        do {
            let file = PartialFile(dataURL: data, metaURL: meta)
            try file.setTotal(500)
            try file.write(bytes.subdata(in: 0..<200), at: 0)
            file.close()
        }
        let reopened = PartialFile(dataURL: data, metaURL: meta)
        XCTAssertEqual(reopened.total, 500)
        XCTAssertEqual(reopened.held, [0..<200])
        XCTAssertEqual(reopened.read(0..<200), bytes.subdata(in: 0..<200))
    }

    func testAnUnreadableRecordStartsOverAndTakesItsDataWithIt() throws {
        let data = directory.appendingPathComponent("c.part")
        let meta = directory.appendingPathComponent("c.part.meta")
        do {
            let file = PartialFile(dataURL: data, metaURL: meta)
            try file.setTotal(10)
            try file.write(Data(repeating: 1, count: 10), at: 0)
            file.close()
        }
        try Data("not json".utf8).write(to: meta)
        let reopened = PartialFile(dataURL: data, metaURL: meta)
        XCTAssertNil(reopened.total)
        XCTAssertEqual(reopened.downloaded, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: data.path))
    }

    func testARecordNamingBytesPastTheDataIsNotBelieved() throws {
        let data = directory.appendingPathComponent("d.part")
        let meta = directory.appendingPathComponent("d.part.meta")
        do {
            let file = PartialFile(dataURL: data, metaURL: meta)
            try file.setTotal(100)
            try file.write(Data(repeating: 1, count: 50), at: 0)
            file.close()
        }
        // The data was cut short (a crash between writes).
        let handle = try FileHandle(forUpdating: data)
        try handle.truncate(atOffset: 20)
        try handle.close()
        XCTAssertEqual(PartialFile(dataURL: data, metaURL: meta).downloaded, 0)
    }

    func testANewLengthMeansANewFile() throws {
        let file = PartialFile(dataURL: directory.appendingPathComponent("e.part"), metaURL: directory.appendingPathComponent("e.part.meta"))
        try file.setTotal(100)
        try file.write(Data(repeating: 1, count: 50), at: 0)
        try file.setTotal(120)
        XCTAssertEqual(file.downloaded, 0)
        XCTAssertEqual(file.total, 120)
    }

    // MARK: Store

    func testAWholePartialFileBecomesTheCompleteOne() throws {
        let store = MediaStore(directory: directory)
        let bytes = mediaBytes(300)
        let partial = store.partial("tool/a/1/0")
        try partial.setTotal(300)
        try partial.write(bytes, at: 0)
        try store.finish("tool/a/1/0", seal: nil)
        XCTAssertTrue(store.isComplete("tool/a/1/0"))
        XCTAssertEqual(try Data(contentsOf: store.completeURL("tool/a/1/0")), bytes)
        XCTAssertFalse(store.hasPartial("tool/a/1/0"))
        XCTAssertEqual(store.read("tool/a/1/0", 10..<20, seal: nil), bytes.subdata(in: 10..<20))
    }

    func testTheStoreIsOutOfBackups() throws {
        let store = MediaStore(directory: directory)
        try store.keep("x", data: Data([1, 2, 3]))
        #if canImport(Darwin)
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        #endif
    }

    func testAFileThePersonSentIsKeptAndNeverRead() async throws {
        let store = MediaStore(directory: directory)
        let sent = directory.appendingPathComponent("outbox/photo.jpg")
        try FileManager.default.createDirectory(at: sent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try mediaBytes(64).write(to: sent)
        try store.keep("legacy/s/ref", file: sent)
        let server = FakeMediaServer(mediaBytes(64))
        let downloads = MediaDownloads(store: store, board: DownloadBoard())
        let data = try await downloads.data("legacy/s/ref", source: server.source())
        XCTAssertEqual(data, mediaBytes(64))
        XCTAssertEqual(server.requests, [])
    }

    func testUsageCountsEveryKeptByteAndClearingEmptiesIt() throws {
        let store = MediaStore(directory: directory)
        try store.keep("a", data: Data(count: 10_000))
        let partial = store.partial("b")
        try partial.setTotal(8000)
        try partial.write(Data(count: 4000), at: 0)
        XCTAssertGreaterThanOrEqual(store.usage(), 14_000)
        store.removeAll()
        XCTAssertEqual(store.usage(), 0)
        XCTAssertFalse(store.isComplete("a"))
    }

    // MARK: Sealed (legacy)

    private let key = Data((0..<32).map { UInt8($0) })

    private struct FixedRandom: RandomSource {
        func bytes(_ count: Int) -> Data { Data((0..<count).map { UInt8(200 &- $0) }) }
    }

    func testAnyRangeOfASealedBlobDecryptsOnItsOwn() throws {
        let plain = mediaBytes(5000)
        let sealed = try BlobCipher.seal(plain, key: key, random: FixedRandom())
        let nonce = sealed.prefix(24)
        for (start, end) in [(0, 1), (0, 64), (31, 33), (63, 65), (100, 4000), (4999, 5000), (1, 5000)] {
            let cipher = sealed.subdata(in: (start + 40)..<(end + 40))
            XCTAssertEqual(BlobCipher.decrypt(range: cipher, nonce: Data(nonce), key: key, offset: start), plain.subdata(in: start..<end), "\(start)..<\(end)")
        }
    }

    func testASealedFileStreamsBeforeItsMACAndIsKeptOnlyOnceTheMACChecks() async throws {
        let plain = mediaBytes(700_000)
        let sealed = try BlobCipher.seal(plain, key: key, random: FixedRandom())
        let server = FakeMediaServer(sealed)
        let store = MediaStore(directory: directory)
        let downloads = MediaDownloads(store: store, board: DownloadBoard())
        let source = server.source(length: sealed.count, seal: MediaSeal(key: key))
        // A player's read from the middle: decrypted from what is here.
        let middle = try await downloads.read("legacy/s/r", source: source, range: 400_000..<400_100)
        XCTAssertEqual(middle, plain.subdata(in: 400_000..<400_100))
        XCTAssertFalse(store.isComplete("legacy/s/r"))
        let length = try await downloads.length("legacy/s/r", source: source)
        XCTAssertEqual(length, 700_000)
        let whole = try await downloads.data("legacy/s/r", source: source)
        XCTAssertEqual(whole, plain)
        // Plaintext is what is kept.
        XCTAssertEqual(try Data(contentsOf: store.completeURL("legacy/s/r")), plain)
    }

    func testATamperedSealedFileIsThrownAwayNotKept() async throws {
        let plain = mediaBytes(3000)
        var sealed = try BlobCipher.seal(plain, key: key, random: FixedRandom())
        sealed[2000] ^= 0xFF
        let server = FakeMediaServer(sealed)
        let store = MediaStore(directory: directory)
        let board = DownloadBoard()
        let downloads = MediaDownloads(store: store, board: board)
        do {
            _ = try await downloads.data("t", source: server.source(seal: MediaSeal(key: key)))
            XCTFail("a tampered file was kept")
        } catch {
            XCTAssertEqual(error as? MediaError, .notAuthentic)
        }
        XCTAssertFalse(store.isComplete("t"))
        XCTAssertFalse(store.hasPartial("t"))
        if case .failed = board.phase("t") {} else { XCTFail("\(String(describing: board.phase("t")))") }
    }
}

final class MediaDownloadsTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("MediaDownloadsTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAWholeDownloadReadsEachByteOnceInChunks() async throws {
        let bytes = mediaBytes(2 * MediaDownloads.chunk + 300)
        let server = FakeMediaServer(bytes)
        let board = DownloadBoard()
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: board)
        let data = try await downloads.data("f", source: server.source())
        XCTAssertEqual(data, bytes)
        XCTAssertEqual(server.served, bytes.count)
        XCTAssertEqual(server.requests.first, 0..<MediaDownloads.chunk)
        XCTAssertEqual(board.phase("f"), .complete(total: bytes.count))
    }

    func testAPausedDownloadResumesAfterARelaunchFromWhereItStopped() async throws {
        let bytes = mediaBytes(3 * MediaDownloads.chunk)
        let server = FakeMediaServer(bytes)
        let store = MediaStore(directory: directory)
        // The first run reads one range, then the app ends.
        do {
            let downloads = MediaDownloads(store: store, board: DownloadBoard())
            _ = try await downloads.read("v", source: server.source(), range: 0..<1000)
            await downloads.stop()
        }
        let first = server.served
        XCTAssertEqual(first, MediaDownloads.streamChunk)
        // A new run, a new store on the same folder.
        let board = DownloadBoard()
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: board)
        let phase = await downloads.phase("v", source: server.source())
        XCTAssertEqual(phase, .paused(done: MediaDownloads.streamChunk, total: bytes.count))
        let data = try await downloads.data("v", source: server.source())
        XCTAssertEqual(data, bytes)
        // Nothing read twice.
        XCTAssertEqual(server.served, bytes.count)
        XCTAssertEqual(server.requests[1].lowerBound, MediaDownloads.streamChunk)
    }

    func testASeekAheadIsFetchedBeforeTheRestOfTheFile() async throws {
        let bytes = mediaBytes(8 * MediaDownloads.chunk)
        let server = FakeMediaServer(bytes)
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: DownloadBoard())
        let source = server.source(length: bytes.count)
        let seek = 6 * MediaDownloads.chunk + 17
        let data = try await downloads.read("v", source: source, range: seek..<(seek + 1000))
        XCTAssertEqual(data, bytes.subdata(in: seek..<(seek + 1000)))
        XCTAssertEqual(server.requests, [seek..<(seek + MediaDownloads.streamChunk)])
    }

    func testAPlayerReadsFromWhatIsAlreadyHereWithoutAsking() async throws {
        let bytes = mediaBytes(MediaDownloads.chunk)
        let server = FakeMediaServer(bytes)
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: DownloadBoard())
        _ = try await downloads.read("v", source: server.source(), range: 0..<10)
        let asked = server.requests.count
        let again = try await downloads.read("v", source: server.source(), range: 100..<2000)
        XCTAssertEqual(again, bytes.subdata(in: 100..<2000))
        XCTAssertEqual(server.requests.count, asked)
        let available = await downloads.available("v", source: server.source(), from: 100, limit: .max)
        XCTAssertEqual(available, MediaDownloads.streamChunk - 100)
    }

    func testAServerThatIgnoresRangesStillFillsTheFile() async throws {
        let bytes = mediaBytes(5000)
        let server = FakeMediaServer(bytes)
        server.ignoresRanges = true
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: DownloadBoard())
        let data = try await downloads.read("v", source: server.source(), range: 3000..<3100)
        XCTAssertEqual(data, bytes.subdata(in: 3000..<3100))
        XCTAssertEqual(server.requests.count, 1)
        let length = try await downloads.length("v", source: server.source())
        XCTAssertEqual(length, 5000)
    }

    func testPausingStopsAWholeDownloadAndKeepsWhatCame() async throws {
        let bytes = mediaBytes(4 * MediaDownloads.chunk)
        let server = FakeMediaServer(bytes)
        let release = AsyncStream<Void>.makeStream()
        let started = AsyncStream<Void>.makeStream()
        let count = Counter()
        server.gate = {
            // The first range answers; the second waits until released.
            if count.next() > 0 {
                started.continuation.yield()
                for await _ in release.stream { break }
            }
        }
        let board = DownloadBoard()
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: board)
        await downloads.download("f", source: server.source(), priority: .user)
        for await _ in started.stream { break }
        await downloads.pause("f")
        release.continuation.yield()
        XCTAssertEqual(board.phase("f"), .paused(done: MediaDownloads.chunk, total: bytes.count))
        let running = await downloads.isRunning("f")
        XCTAssertFalse(running)
    }

    func testAFailingServerIsGivenUpOnUntilATap() async throws {
        let server = FakeMediaServer(mediaBytes(100))
        server.failing = URLError(.notConnectedToInternet)
        let board = DownloadBoard()
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: board, sleep: { _ in })
        do {
            _ = try await downloads.data("f", source: server.source(length: 100))
            XCTFail("read with no network")
        } catch {}
        XCTAssertEqual(board.phase("f"), .failed(done: 0, total: 100))
        XCTAssertEqual(server.requests.count, 0)
        server.failing = nil
        let data = try await downloads.data("f", source: server.source(length: 100))
        XCTAssertEqual(data, mediaBytes(100))
    }

    func testAutomaticDownloadsWaitTheirTurn() async throws {
        let gate = MediaGate()
        let servers = (0..<3).map { _ in FakeMediaServer(mediaBytes(10)) }
        for server in servers { server.gate = { await gate.wait() } }
        let downloads = MediaDownloads(store: MediaStore(directory: directory), board: DownloadBoard())
        for (index, server) in servers.enumerated() {
            await downloads.download("f\(index)", source: server.source(), priority: .background)
        }
        let first = await downloads.isRunning("f0")
        let third = await downloads.isRunning("f2")
        XCTAssertTrue(first)
        XCTAssertFalse(third)
        // A tap lifts it past the queue.
        await downloads.download("f2", source: servers[2].source(), priority: .user)
        let lifted = await downloads.isRunning("f2")
        XCTAssertTrue(lifted)
        await gate.open()
    }
}

/// Holds fetches until opened.
actor MediaGate {
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func open() {
        opened = true
        for one in waiting { one.resume() }
        waiting = []
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { defer { value += 1 }; return value } }
}

final class MediaTextTests: XCTestCase {
    func testSizesReadAsTelegramWritesThem() {
        XCTAssertEqual(MediaSizeText.size(512), "512 B")
        XCTAssertEqual(MediaSizeText.size(860_160), "840 KB")
        XCTAssertEqual(MediaSizeText.size(8_808_038), "8.4 MB")
        XCTAssertEqual(MediaSizeText.size(10 * 1024 * 1024), "10 MB")
        XCTAssertEqual(MediaSizeText.progress(1_258_291, of: 8_808_038), "1.2 / 8.4 MB")
        XCTAssertEqual(MediaSizeText.progress(400_000, of: 8_808_038), "0.4 / 8.4 MB")
        XCTAssertEqual(MediaSizeText.progress(100, of: 860_160), "100 B / 840 KB")
        XCTAssertEqual(MediaSizeText.text(.remote(total: nil)), nil)
        XCTAssertEqual(MediaSizeText.text(.paused(done: 1_258_291, total: 8_808_038)), "1.2 / 8.4 MB")
        XCTAssertEqual(MediaSizeText.text(.complete(total: 8_808_038)), "8.4 MB")
        XCTAssertEqual(MediaSizeText.text(.failed(done: 0, total: 860_160)), "840 KB")
        XCTAssertEqual(MediaSizeText.text(.downloading(done: 0, total: 860_160)), "0 B / 840 KB")
    }

    func testDurations() {
        XCTAssertEqual(MediaSizeText.duration(12.7), "0:12")
        XCTAssertEqual(MediaSizeText.duration(65), "1:05")
        XCTAssertEqual(MediaSizeText.duration(3903), "1:05:03")
    }

    func testContentRange() {
        XCTAssertEqual(ContentRange("bytes 0-1023/4096"), ContentRange("bytes 0-1023/4096"))
        XCTAssertEqual(ContentRange("bytes 10-19/100")?.start, 10)
        XCTAssertEqual(ContentRange("bytes 10-19/*")?.total, nil)
        XCTAssertNil(ContentRange("items 0-1/2"))
        XCTAssertEqual(try MediaPiece.http(status: 206, headers: ["Content-Range": "bytes 5-6/10"], body: Data([1, 2])), MediaPiece(offset: 5, data: Data([1, 2]), total: 10))
        XCTAssertEqual(try MediaPiece.http(status: 200, headers: [:], body: Data([1, 2])), MediaPiece(offset: 0, data: Data([1, 2]), total: 2))
        XCTAssertThrowsError(try MediaPiece.http(status: 404, headers: [:], body: Data()))
    }

    func testAutomaticDownloadDefaults() {
        let rules = MediaAutoDownload()
        XCTAssertTrue(rules.allows(.photos, size: nil))
        XCTAssertTrue(rules.allows(.photos, size: 3 * 1024 * 1024))
        XCTAssertTrue(rules.allows(.files, size: 900 * 1024))
        XCTAssertFalse(rules.allows(.files, size: 2 * 1024 * 1024))
        XCTAssertFalse(rules.allows(.files, size: nil))
        XCTAssertFalse(rules.allows(.videos, size: 1024))
        let defaults = UserDefaults(suiteName: "MediaTextTests-\(UUID().uuidString)")!
        var changed = rules
        changed.videos.enabled = true
        changed.save(defaults)
        XCTAssertEqual(MediaAutoDownload.load(defaults), changed)
    }
}
