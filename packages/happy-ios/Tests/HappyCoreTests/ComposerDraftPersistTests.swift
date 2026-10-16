import Foundation
import XCTest
@testable import HappyCore

/// A draft store that counts what is written to it. The tests report the
/// store observation themselves (`change`).
final class CountingDraftStorage: ComposerStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var draft: String
    private var written: [String] = []
    private var holdNext = false
    private let gate = DispatchSemaphore(value: 0)
    private let entered = DispatchSemaphore(value: 0)
    weak var writer: ComposerDraftWriter?

    init(draft: String = "") {
        self.draft = draft
    }

    var saves: [String] { lock.withLock { written } }
    var stored: String { lock.withLock { draft } }

    /// The next save blocks, holding the writer's drain inside it, until
    /// `release()`; `waitForHeldSave()` returns once it has started. What is
    /// handed to the writer meanwhile waits as one run.
    func holdTheNextSave() { lock.withLock { holdNext = true } }
    func waitForHeldSave() { entered.wait() }
    func release() { gate.signal() }

    /// Another device wrote the draft.
    func change(_ text: String) {
        lock.withLock { draft = text }
        writer?.observed(ComposerStoreValue(draft: text))
    }

    func composerValue(sessionId: String) throws -> ComposerStoreValue {
        ComposerStoreValue(draft: stored)
    }

    func saveDraft(sessionId: String, text: String) throws {
        let hold = lock.withLock {
            defer { holdNext = false }
            return holdNext
        }
        if hold {
            entered.signal()
            gate.wait()
        }
        lock.withLock {
            draft = text
            written.append(text)
        }
    }

    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        AsyncThrowingStream { _ in }
    }
}

struct NoSending: ChatSending {
    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String { "sent" }
    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

/// Deliveries, on the main thread.
@MainActor
final class DeliveryLog {
    private(set) var all: [ComposerStoreDelivery] = []

    func receive(_ delivery: ComposerStoreDelivery) {
        all.append(delivery)
    }

    func waitFor(_ count: Int) async throws {
        for _ in 0..<1000 where all.count < count {
            try await Task.sleep(for: .milliseconds(2))
        }
        XCTAssertGreaterThanOrEqual(all.count, count, "deliveries")
    }
}

/// What the writer does with a write's text, off the main thread: read the
/// field's snapshot, and compare it with what is saved or stored.
@MainActor
final class ComposerDraftPersistTests: XCTestCase {
    private func start(_ storage: CountingDraftStorage) async throws -> (ComposerDraftWriter, DeliveryLog) {
        let writer = ComposerDraftWriter(sessionId: "s", storage: storage, sending: NoSending())
        storage.writer = writer
        let log = DeliveryLog()
        writer.start { log.receive($0) }
        try await log.waitFor(1)
        return (writer, log)
    }

    func testAnEditBackToTheSavedTextWritesNothing() async throws {
        let storage = CountingDraftStorage()
        let (writer, _) = try await start(storage)
        // "a" is being written; "ab" and back to "a" are typed meanwhile
        // and wait behind it as one run, which collapses to its newest.
        storage.holdTheNextSave()
        writer.save(.init(text: "a", generation: 1, persist: .unlessSaved))
        storage.waitForHeldSave()
        writer.save(.init(text: "ab", generation: 2, persist: .unlessSaved))
        writer.save(.init(text: "a", generation: 3, persist: .unlessSaved))
        storage.release()
        await writer.settle()
        XCTAssertEqual(storage.saves, ["a"], "the newest is what was saved")
        writer.save(.init(text: "", generation: 4, persist: .unlessSaved))
        await writer.settle()
        XCTAssertEqual(storage.saves, ["a", ""])
        writer.close()
    }

    /// Edits the drain reaches one by one are each written, in order: the
    /// store ends at the newest, never at one typed over.
    func testEditsLandingOneByOneAreWrittenInOrder() async throws {
        let storage = CountingDraftStorage()
        let (writer, _) = try await start(storage)
        for (index, text) in ["a", "ab", "a"].enumerated() {
            writer.save(.init(text: ComposerDraftText(text), generation: index + 1, persist: .unlessSaved))
            await writer.settle()
        }
        XCTAssertEqual(storage.saves, ["a", "ab", "a"])
        XCTAssertEqual(storage.stored, "a")
        writer.close()
    }

    func testACountedWriteIsNeverWrittenButIsTheSavedText() async throws {
        let storage = CountingDraftStorage(draft: "loaded")
        let (writer, log) = try await start(storage)
        XCTAssertEqual(log.all.first?.draftIsSaved, false, "nothing saved yet")
        writer.save(.init(text: "loaded", generation: 1, persist: .never))
        await writer.settle()
        XCTAssertEqual(storage.saves, [])
        // Its own text read back is not a remote edit; another is.
        writer.refresh()
        try await log.waitFor(2)
        XCTAssertEqual(log.all.last, ComposerStoreDelivery(value: ComposerStoreValue(draft: "loaded"), generation: 1, draftIsSaved: true))
        storage.change("from the laptop")
        try await log.waitFor(3)
        XCTAssertEqual(log.all.last, ComposerStoreDelivery(value: ComposerStoreValue(draft: "from the laptop"), generation: 1, draftIsSaved: false))
        writer.close()
    }

    func testAWriteUnlessStoredSkipsOnlyWhatTheStoreHolds() async throws {
        let storage = CountingDraftStorage(draft: "handed over")
        let (writer, _) = try await start(storage)
        writer.save(.init(text: "handed over", generation: 1, persist: .unlessStored))
        await writer.settle()
        XCTAssertEqual(storage.saves, [])
        writer.save(.init(text: "typed", generation: 2, persist: .unlessStored))
        await writer.settle()
        XCTAssertEqual(storage.saves, ["typed"])
        writer.close()
    }

    func testAlwaysWritesEvenWhatTheStoreHolds() async throws {
        let storage = CountingDraftStorage(draft: "same")
        let (writer, _) = try await start(storage)
        writer.save("same", generation: 1)
        await writer.settle()
        XCTAssertEqual(storage.saves, ["same"])
        writer.close()
    }

    /// The field's text is read when the writer gets to it, as it was at
    /// the write, whatever was typed since.
    func testAFieldSnapshotIsWrittenAsItWasAtTheWrite() async throws {
        let storage = CountingDraftStorage()
        let (writer, log) = try await start(storage)
        let mirror = ComposerTextMirror()
        mirror.replace(NSRange(location: 0, length: 0), with: "hello")
        writer.save(.init(text: ComposerDraftText(mirror.snapshot()), generation: 1, persist: .unlessSaved))
        mirror.replace(NSRange(location: 5, length: 0), with: " and more")
        await writer.settle()
        XCTAssertEqual(storage.saves, ["hello"])
        storage.change("hello")
        writer.refresh()
        try await log.waitFor(2)
        XCTAssertEqual(log.all.last?.draftIsSaved, true)
        writer.close()
    }
}
