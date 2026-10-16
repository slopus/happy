import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyCrypto
import HappyStore
import HappyWire

/// A store that records every call, in order, and where it ran. A save can
/// be held at the gate until the test lets it go, or made to fail.
private final class ProbeStorage: ComposerStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var current: ComposerStoreValue
    private var calls: [String] = []
    private var mainThreadCalls = 0
    private var holdNextSave = false
    private var savesFail = false
    private var attempts = 0
    private let gate = DispatchSemaphore(value: 0)
    private let entered = DispatchSemaphore(value: 0)
    /// The writer the observation reports to, in the test's order.
    weak var writer: ComposerDraftWriter?

    init(_ value: ComposerStoreValue = ComposerStoreValue()) {
        current = value
    }

    var log: [String] { lock.withLock { calls } }
    var reads: Int { log.filter { $0 == "read" }.count }
    var saves: [String] { log.compactMap { $0.hasPrefix("save ") ? String($0.dropFirst(5)) : nil } }
    var callsOnMain: Int { lock.withLock { mainThreadCalls } }
    /// Saves tried, failed or not.
    var saveAttempts: Int { lock.withLock { attempts } }

    /// Every save throws until set back.
    func failSaves(_ fail: Bool) { lock.withLock { savesFail = fail } }
    var value: ComposerStoreValue { lock.withLock { current } }

    func record(_ call: String) {
        lock.withLock {
            calls.append(call)
            if Thread.isMainThread { mainThreadCalls += 1 }
        }
    }

    /// Another device (or the sync engine) changed the store.
    func change(_ edit: (inout ComposerStoreValue) -> Void) {
        let value = lock.withLock { () -> ComposerStoreValue in
            edit(&current)
            return current
        }
        writer?.observed(value)
    }

    /// The observation delivers `value`, which may be stale.
    func observe(_ value: ComposerStoreValue) { writer?.observed(value) }

    /// The next save blocks until `release()`; `waitForHeldSave()` returns
    /// once it has started.
    func holdTheNextSave() { lock.withLock { holdNextSave = true } }
    func waitForHeldSave() { entered.wait() }
    func release() { gate.signal() }

    func composerValue(sessionId: String) throws -> ComposerStoreValue {
        record("read")
        return value
    }

    func saveDraft(sessionId: String, text: String) throws {
        let hold = lock.withLock {
            defer { holdNextSave = false }
            return holdNextSave
        }
        if hold {
            entered.signal()
            gate.wait()
        }
        let fail = lock.withLock {
            attempts += 1
            return savesFail
        }
        if fail { throw ProbeError.diskFull }
        record("save \(text)")
        lock.withLock { current.draft = text }
    }

    /// The tests report observations themselves (`observe`, `change`).
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> { AsyncThrowingStream { _ in } }
}

private enum ProbeError: Error { case diskFull, offline }

/// The failures a writer reported.
private final class Failures: @unchecked Sendable {
    private let lock = NSLock()
    private var list: [ComposerDraftWriter.Failure.Operation] = []
    var operations: [ComposerDraftWriter.Failure.Operation] { lock.withLock { list } }
    func record(_ failure: ComposerDraftWriter.Failure) { lock.withLock { list.append(failure.operation) } }
}

/// Sends by logging into the storage's log, so order is visible; the send
/// can be held until released.
private final class ProbeSending: ChatSending, @unchecked Sendable {
    let storage: ProbeStorage
    private let lock = NSLock()
    private var held: CheckedContinuation<Void, Never>?
    private var holding = false
    private var waiting: CheckedContinuation<Void, Never>?
    private var count = 0
    private var failNext = false

    init(_ storage: ProbeStorage) { self.storage = storage }

    /// The next send is refused.
    func refuseNext() { lock.withLock { failNext = true } }

    func hold() { lock.withLock { holding = true } }

    /// Returns once a held send is waiting.
    func waitForHeldSend() async {
        await withCheckedContinuation { continuation in
            let ready = lock.withLock {
                if held != nil { return true }
                waiting = continuation
                return false
            }
            if ready { continuation.resume() }
        }
    }

    func release() {
        let continuation = lock.withLock {
            holding = false
            defer { held = nil }
            return held
        }
        continuation?.resume()
    }

    func send(_ message: OutgoingMessage, sessionId: String) async throws -> String {
        storage.record("send \(message.text) over \(storage.value.draft)")
        let refused = lock.withLock {
            defer { failNext = false }
            return failNext
        }
        if refused { throw ProbeError.offline }
        if lock.withLock({ holding }) {
            await withCheckedContinuation { continuation in
                let waiter = lock.withLock {
                    held = continuation
                    defer { waiting = nil }
                    return waiting
                }
                waiter?.resume()
            }
        }
        return lock.withLock {
            count += 1
            return "local-\(count)"
        }
    }

    func retry(localId: String) async throws {}
    func discard(localId: String) async throws {}
}

/// Collects deliveries on the main actor.
@MainActor
private final class Deliveries {
    var all: [ComposerStoreDelivery] = []
    var offMain = 0
    private var expected: (count: Int, expectation: XCTestExpectation)?

    func receive(_ delivery: ComposerStoreDelivery) {
        if !Thread.isMainThread { offMain += 1 }
        all.append(delivery)
        if let expected, all.count >= expected.count {
            expected.expectation.fulfill()
            self.expected = nil
        }
    }

    func expect(_ count: Int) -> XCTestExpectation {
        let expectation = XCTestExpectation(description: "\(count) deliveries")
        if all.count >= count { expectation.fulfill() } else { expected = (count, expectation) }
        return expectation
    }
}

@MainActor
final class ComposerDraftWriterTests: XCTestCase {
    private func writer(
        _ storage: ProbeStorage,
        retryDelays: [Duration] = ComposerDraftWriter.defaultRetryDelays,
        failures: Failures = Failures()
    ) -> (ComposerDraftWriter, ProbeSending, Deliveries) {
        let sending = ProbeSending(storage)
        let writer = ComposerDraftWriter(
            sessionId: "s", storage: storage, sending: sending, retryDelays: retryDelays, onFailure: failures.record
        )
        storage.writer = writer
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        return (writer, sending, deliveries)
    }

    /// Everything handed over before it has run.
    private func barrier(_ writer: ComposerDraftWriter) async throws {
        _ = try await writer.send(OutgoingMessage(text: "barrier")).value
    }

    func testOpeningReadsOnceOffTheMainThreadAndDeliversOnceOnIt() async throws {
        let storage = ProbeStorage(ComposerStoreValue(draft: "unsent", failedAttachments: 1))
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        // The observation's first value is the one just read.
        storage.observe(storage.value)
        try await barrier(writer)
        XCTAssertEqual(storage.reads, 1)
        XCTAssertEqual(storage.callsOnMain, 0)
        XCTAssertEqual(deliveries.all, [ComposerStoreDelivery(value: ComposerStoreValue(draft: "unsent", failedAttachments: 1), generation: 0)])
        XCTAssertEqual(deliveries.offMain, 0)
    }

    func testFastTypingCollapsesIntoTheNewestText() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.holdTheNextSave()
        writer.save("a", generation: 1)
        storage.waitForHeldSave()
        for (index, text) in ["ab", "abc", "abcd", "abcde", "abcdef"].enumerated() {
            writer.save(text, generation: index + 2)
        }
        storage.release()
        try await barrier(writer)
        XCTAssertEqual(storage.saves, ["a", "abcdef"], "one write in flight, then only the newest")
        XCTAssertEqual(storage.value.draft, "abcdef")
        XCTAssertEqual(storage.callsOnMain, 0)
    }

    func testASendWaitsForEarlierWritesAndHoldsBackLaterOnes() async throws {
        let storage = ProbeStorage()
        let (writer, sending, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.holdTheNextSave()
        writer.save("hello", generation: 1)
        storage.waitForHeldSave()
        sending.hold()
        let sent = writer.send(OutgoingMessage(text: "hello"))
        storage.release()
        await sending.waitForHeldSend()
        // Typing while the send is in flight.
        writer.save("hello again", generation: 2)
        sending.release()
        _ = try await sent.value
        try await barrier(writer)
        XCTAssertEqual(storage.log.filter { $0 != "read" }, [
            "save hello", "send hello over hello", "save hello again", "send barrier over hello again",
        ])
    }

    func testItsOwnWriteComingBackIsNeitherReadNorDelivered() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        for (index, text) in ["h", "he", "hel"].enumerated() {
            writer.save(text, generation: index + 1)
            try await barrier(writer)
            storage.observe(storage.value)
        }
        try await barrier(writer)
        XCTAssertEqual(storage.reads, 1, "only the opening read")
        XCTAssertEqual(deliveries.all.count, 1)
    }

    func testAStaleObservationIsReadAgainAndNotDelivered() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.save("a", generation: 1)
        writer.save("ab", generation: 2)
        try await barrier(writer)
        // The observation lags: it still shows the first write.
        storage.observe(ComposerStoreValue(draft: "a"))
        try await barrier(writer)
        XCTAssertEqual(storage.reads, 2)
        XCTAssertEqual(deliveries.all.count, 1)
    }

    func testARemoteEditIsDeliveredWithTheNewestCommittedWrite() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.save("mine", generation: 1)
        try await barrier(writer)
        storage.change { $0.draft = "from the laptop" }
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        XCTAssertEqual(deliveries.all.last, ComposerStoreDelivery(value: ComposerStoreValue(draft: "from the laptop"), generation: 1))
        // The edit back to what the composer last wrote is news too.
        storage.change { $0.draft = "mine" }
        await fulfillment(of: [deliveries.expect(3)], timeout: 5)
        XCTAssertEqual(deliveries.all.last?.value.draft, "mine")
    }

    func testPicksAndFailuresAreDeliveredOnlyWhenTheyMove() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.change { $0.picks = ComposerPicks(permissionMode: "plan") }
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        storage.observe(storage.value)
        storage.change { $0.failedAttachments = 2 }
        await fulfillment(of: [deliveries.expect(3)], timeout: 5)
        try await barrier(writer)
        XCTAssertEqual(deliveries.all.map(\.value), [
            ComposerStoreValue(),
            ComposerStoreValue(picks: ComposerPicks(permissionMode: "plan")),
            ComposerStoreValue(picks: ComposerPicks(permissionMode: "plan"), failedAttachments: 2),
        ])
    }

    func testRefreshDeliversEvenWhenNothingMoved() async throws {
        let storage = ProbeStorage(ComposerStoreValue(draft: "x"))
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.refresh()
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        XCTAssertEqual(deliveries.all[1], deliveries.all[0])
        XCTAssertEqual(storage.reads, 2)
    }

    func testClosingStopsReadsButTheTeardownFlushLands() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.close()
        writer.save("bye", generation: 1)
        writer.refresh()
        storage.change { $0.draft = "remote" }
        try await barrier(writer)
        XCTAssertEqual(storage.saves, ["bye"])
        XCTAssertEqual(storage.reads, 1)
        XCTAssertEqual(deliveries.all.count, 1)
    }

    func testAWriterOutlivesItsComposerUntilItsWritesLand() async throws {
        let storage = ProbeStorage()
        var writer: ComposerDraftWriter? = ComposerDraftWriter(sessionId: "s", storage: storage, sending: ProbeSending(storage))
        storage.holdTheNextSave()
        writer?.save("draft", generation: 1)
        writer?.close()
        weak let released = writer
        writer = nil
        storage.waitForHeldSave()
        XCTAssertNotNil(released, "held by its drain")
        storage.release()
        for _ in 0..<500 where released != nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNil(released)
        XCTAssertEqual(storage.saves, ["draft"])
    }
}

/// A write that doesn't land.
@MainActor
final class ComposerDraftWriterFailureTests: XCTestCase {
    private func writer(
        _ storage: ProbeStorage,
        retryDelays: [Duration] = [.seconds(60)],
        failures: Failures
    ) -> (ComposerDraftWriter, ProbeSending, Deliveries) {
        let sending = ProbeSending(storage)
        let writer = ComposerDraftWriter(
            sessionId: "s", storage: storage, sending: sending, retryDelays: retryDelays, onFailure: failures.record
        )
        storage.writer = writer
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        return (writer, sending, deliveries)
    }

    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<500 where !condition() {
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    func testAFailedWriteLeavesTheGenerationAndTheTextToTheComposer() async throws {
        let storage = ProbeStorage(ComposerStoreValue(draft: "before"))
        let failures = Failures()
        let (writer, _, deliveries) = writer(storage, failures: failures)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.failSaves(true)
        writer.save("typed", generation: 1)
        let settled = await writer.settle()
        XCTAssertFalse(settled, "not on disk")
        XCTAssertEqual(failures.operations, [.save, .save], "the write and the settle's retry")

        // Another device moves the picks, the draft and an upload fails.
        storage.change {
            $0.draft = "from the laptop"
            $0.picks = ComposerPicks(permissionMode: "plan")
            $0.failedAttachments = 1
        }
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        let late = try XCTUnwrap(deliveries.all.last)
        XCTAssertEqual(late.generation, 0, "the failed write doesn't count")
        // The composer still holds its typing; the rest is news.
        var model = ComposerDraftModel()
        _ = model.receive(deliveries.all[0], text: "", synced: true, composing: false)
        _ = model.textChanged("before", synced: true)
        XCTAssertEqual(model.textChanged("typed", synced: true).write?.generation, 2, "after the load's")
        let change = model.receive(late, text: "typed", synced: true, composing: false)
        XCTAssertNil(change.text, "unsaved typing isn't replaced")
        XCTAssertEqual(change.picks, ComposerPicks(permissionMode: "plan"))
        XCTAssertEqual(change.newlyFailedAttachments, 1)

        // Saved at last: it goes over the remote text, as typing would.
        storage.failSaves(false)
        let saved = await writer.settle()
        XCTAssertTrue(saved)
        XCTAssertEqual(storage.saves, ["typed"])
        storage.change { $0.draft = "edited again" }
        await fulfillment(of: [deliveries.expect(3)], timeout: 5)
        XCTAssertEqual(deliveries.all.last?.generation, 1)
    }

    func testRetriesAreBoundedAndANewerWriteReplacesTheFailedOne() async throws {
        let storage = ProbeStorage()
        let failures = Failures()
        let (writer, _, deliveries) = writer(storage, retryDelays: [.milliseconds(5), .milliseconds(5)], failures: failures)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.failSaves(true)
        writer.save("a", generation: 1)
        try await until { storage.saveAttempts == 3 }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(storage.saveAttempts, 3, "the write and two retries")
        XCTAssertEqual(failures.operations, [.save, .save, .save])
        storage.failSaves(false)
        writer.save("ab", generation: 2)
        let saved = await writer.settle()
        XCTAssertTrue(saved)
        XCTAssertEqual(storage.saves, ["ab"], "only the newest text")
    }

    func testASendBehindAWriteThatKeepsFailingIsRefusedAndTheTextKept() async throws {
        let storage = ProbeStorage()
        let failures = Failures()
        let (writer, _, deliveries) = writer(storage, retryDelays: [.milliseconds(5)], failures: failures)
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.failSaves(true)
        writer.save("hello", generation: 1)
        do {
            _ = try await writer.send(OutgoingMessage(text: "hello")).value
            XCTFail("the draft before it isn't on disk")
        } catch {
            XCTAssertTrue(error is ComposerDraftWriter.UnsavedDraftError)
        }
        XCTAssertFalse(storage.log.contains { $0.hasPrefix("send") }, "nothing reached the outbox")
        // Typing goes on, still unsaved.
        writer.save("hello, more", generation: 2)
        let stuck = await writer.settle()
        XCTAssertFalse(stuck)

        // The disk recovers: the newest text lands, then the send and its
        // clear, and no retry brings anything back.
        storage.failSaves(false)
        let saved = await writer.settle()
        XCTAssertTrue(saved)
        _ = try await writer.send(OutgoingMessage(text: "hello, more")).value
        writer.save("", generation: 3)
        let cleared = await writer.settle()
        XCTAssertTrue(cleared)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(storage.log.filter { $0 != "read" }, [
            "save hello, more", "send hello, more over hello, more", "save ",
        ])
        XCTAssertEqual(storage.value.draft, "")
    }

    func testAWriteThatRecoversBeforeTheSendGoesFirst() async throws {
        let storage = ProbeStorage()
        let (writer, _, deliveries) = writer(storage, failures: Failures())
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        storage.failSaves(true)
        writer.save("hello", generation: 1)
        _ = await writer.settle()
        storage.failSaves(false)
        _ = try await writer.send(OutgoingMessage(text: "hello")).value
        XCTAssertEqual(storage.log.filter { $0 != "read" }, ["save hello", "send hello over hello"])
        storage.change { $0.draft = "from the laptop" }
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        XCTAssertEqual(deliveries.all.last?.generation, 1)
    }

    func testASendTheOutboxRefusesLeavesTheDraftOnDisk() async throws {
        let storage = ProbeStorage()
        let (writer, sending, deliveries) = writer(storage, failures: Failures())
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.save("hello", generation: 1)
        sending.refuseNext()
        do {
            _ = try await writer.send(OutgoingMessage(text: "hello")).value
            XCTFail("refused")
        } catch {
            XCTAssertEqual(error as? ProbeError, .offline)
        }
        let settled = await writer.settle()
        XCTAssertTrue(settled)
        XCTAssertEqual(storage.value.draft, "hello")
    }

    func testAFailedReadIsReportedAndTheNextOneDelivers() async throws {
        let storage = FailingReads()
        let failures = Failures()
        let writer = ComposerDraftWriter(sessionId: "s", storage: storage, sending: ProbeSending(ProbeStorage()), onFailure: failures.record)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await writer.settle()
        XCTAssertEqual(failures.operations, [.read])
        XCTAssertTrue(deliveries.all.isEmpty)
        writer.refresh()
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        XCTAssertEqual(deliveries.all.first?.value.draft, "second look")
        writer.close()
    }
}

/// A chat that was being started arrives: one writer hands over to the next.
@MainActor
final class ComposerDraftHandoverTests: XCTestCase {
    func testTheNewWriterWaitsForTheOldOnesLastWrite() async throws {
        let pending = ProbeStorage()
        let old = ComposerDraftWriter(sessionId: "pending-chat:1", storage: pending, sending: ProbeSending(pending))
        pending.writer = old
        let oldDeliveries = Deliveries()
        old.start { oldDeliveries.receive($0) }
        await fulfillment(of: [oldDeliveries.expect(1)], timeout: 5)
        pending.holdTheNextSave()
        old.save("hello", generation: 3)
        pending.waitForHeldSave()
        old.close()

        let session = ProbeStorage(ComposerStoreValue(draft: "handed over"))
        let new = ComposerDraftWriter(sessionId: "s", storage: session, sending: ProbeSending(session), generation: 3, after: old)
        session.writer = new
        let deliveries = Deliveries()
        // Typed before the opening read is asked for, so the two land in
        // one order however the drain batches them.
        new.save("hello!", generation: 4)
        new.start { deliveries.receive($0) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(session.log.isEmpty, "nothing until the old write lands")
        XCTAssertTrue(deliveries.all.isEmpty)

        pending.release()
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        XCTAssertEqual(pending.saves, ["hello"])
        XCTAssertEqual(session.log, ["save hello!", "read"])
        XCTAssertEqual(deliveries.all, [ComposerStoreDelivery(value: ComposerStoreValue(draft: "hello!"), generation: 4, draftIsSaved: true)])
        XCTAssertEqual(oldDeliveries.all.count, 1, "the old writer delivers nothing more")
    }

    func testAnOldWriteThatStillFailedIsReportedBehindTheComposer() async throws {
        let pending = ProbeStorage()
        let old = ComposerDraftWriter(sessionId: "pending-chat:1", storage: pending, sending: ProbeSending(pending), retryDelays: [])
        let oldDeliveries = Deliveries()
        old.start { oldDeliveries.receive($0) }
        await fulfillment(of: [oldDeliveries.expect(1)], timeout: 5)
        old.save("old", generation: 1)
        _ = await old.settle()
        pending.failSaves(true)
        old.save("", generation: 2)
        old.close()

        let session = ProbeStorage(ComposerStoreValue(draft: "old"))
        let new = ComposerDraftWriter(sessionId: "s", storage: session, sending: ProbeSending(session), generation: 2, after: old)
        let deliveries = Deliveries()
        new.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        XCTAssertEqual(deliveries.all, [ComposerStoreDelivery(value: ComposerStoreValue(draft: "old"), generation: 1)],
                       "the newest write the old store holds")
        XCTAssertEqual(pending.saveAttempts, 3, "tried once more before the new writer read")
        // The composer writes the field here; its numbering is whole again.
        new.save("", generation: 3)
        new.refresh()
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        XCTAssertEqual(deliveries.all.last, ComposerStoreDelivery(value: ComposerStoreValue(draft: ""), generation: 3, draftIsSaved: true))
        let saved = await new.settle()
        XCTAssertTrue(saved)
        let oldSaved = await old.settle()
        XCTAssertFalse(oldSaved, "the old write is still the old writer's, unsaved")
    }

    func testTheNewWriterKeepsTheComposersNumbering() async throws {
        let session = ProbeStorage(ComposerStoreValue(draft: "hello"))
        let writer = ComposerDraftWriter(sessionId: "s", storage: session, sending: ProbeSending(session), generation: 7)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        XCTAssertEqual(deliveries.all.first?.generation, 7)
    }

    func testAnActorCanBeTheStorage() async throws {
        let record = PendingRecord()
        let writer = ComposerDraftWriter(sessionId: "pending-chat:1", storage: record, sending: ProbeSending(ProbeStorage()))
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        for (index, text) in ["h", "he", "hel"].enumerated() {
            writer.save(text, generation: index + 1)
        }
        let saved = await writer.settle()
        XCTAssertTrue(saved)
        let draft = await record.draft
        XCTAssertEqual(draft, "hel")
        writer.close()
    }
}

/// A chat's record held by an actor, as PendingChats holds it.
private actor PendingRecord: ComposerStorage {
    var draft = ""
    func composerValue(sessionId: String) async throws -> ComposerStoreValue { ComposerStoreValue(draft: draft) }
    func saveDraft(sessionId: String, text: String) async throws { draft = text }
    nonisolated func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> { AsyncThrowingStream { _ in } }
}

/// Fails the first read.
private final class FailingReads: ComposerStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0
    func composerValue(sessionId: String) throws -> ComposerStoreValue {
        let first = lock.withLock {
            reads += 1
            return reads == 1
        }
        if first { throw ProbeError.diskFull }
        return ComposerStoreValue(draft: "second look")
    }
    func saveDraft(sessionId: String, text: String) throws {}
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> { AsyncThrowingStream { _ in } }
}

private final class ThreadViolationLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ThreadRules.Requirement] = []
    var values: [ThreadRules.Requirement] { lock.withLock { recorded } }
    func append(_ value: ThreadRules.Requirement) { lock.withLock { recorded.append(value) } }
}

/// A real store whose draft writes can be made to fail.
private final class FlakyStorage: ComposerStorage, @unchecked Sendable {
    let base: OutboxSender
    private let lock = NSLock()
    private var fail = false
    var failing: Bool {
        get { lock.withLock { fail } }
        set { lock.withLock { fail = newValue } }
    }

    init(_ base: OutboxSender) { self.base = base }

    func composerValue(sessionId: String) throws -> ComposerStoreValue { try base.composerValue(sessionId: sessionId) }
    func saveDraft(sessionId: String, text: String) throws {
        if failing { throw ProbeError.diskFull }
        try base.saveDraft(sessionId: sessionId, text: text)
    }
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        base.composerValues(sessionId: sessionId)
    }
}

/// Counts the writer's own reads, apart from the observation's fetches.
private final class CountingStorage: ComposerStorage, @unchecked Sendable {
    let base: OutboxSender
    private let lock = NSLock()
    private var count = 0
    var reads: Int { lock.withLock { count } }

    init(_ base: OutboxSender) { self.base = base }

    func composerValue(sessionId: String) throws -> ComposerStoreValue {
        lock.withLock { count += 1 }
        return try base.composerValue(sessionId: sessionId)
    }
    func saveDraft(sessionId: String, text: String) throws { try base.saveDraft(sessionId: sessionId, text: text) }
    func composerValues(sessionId: String) -> AsyncThrowingStream<ComposerStoreValue, any Error> {
        base.composerValues(sessionId: sessionId)
    }
}

/// The writer over a real store: what wakes it, and what a send leaves.
@MainActor
final class ComposerDraftStoreTests: XCTestCase {
    private func rigMetadata() -> JSONValue {
        .object([
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "draftUpdatedAt": .number(10), "draft": .null,
            "lastMode": .object(["providerId": .string("p"), "modelId": .string("used")]),
        ])
    }

    private func fixture(rig: Bool, writer: DatabaseQueue? = nil) async throws -> (LocalStore, SyncEngine, OutboxSender, URL) {
        let fixture = ServerFixture()
        let store = try writer.map { try LocalStore(writer: $0) } ?? LocalStore.inMemory()
        let sync = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: fixture.keys, now: { 100 })
        await sync.setBackgrounded(true)
        var session = RecordDecoder(keyRing: KeyRing(keys: fixture.keys)).session(fixture.session("s", updatedAt: 1))
        if rig { session.metadata = rigMetadata() }
        try store.upsertSessions([session], reconcileComposer: sync.modePushes.reconciliation)
        let files = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return (store, sync, OutboxSender(store: store, sync: sync, filesDirectory: files), files)
    }

    /// What each kind of commit costs: fetches by the background
    /// observation (three indexed lookups each), reads by the writer, and
    /// deliveries to the main thread.
    func testHeartbeatsCostNothingAndOtherSessionsOnlyABackgroundFetch() async throws {
        let counter = ComposerSQLCounter()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
        let (store, sync, sender, files) = try await fixture(rig: false, writer: DatabaseQueue(configuration: configuration))
        defer { try? FileManager.default.removeItem(at: files) }
        try store.saveDraft(sessionId: "s", text: "unsent", at: 1)
        counter.reset()
        let storage = CountingStorage(sender)
        let writer = ComposerDraftWriter(sessionId: "s", storage: storage, sending: sender)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        try await Task.sleep(for: .milliseconds(100))
        func costs() -> (fetches: Int, reads: Int, deliveries: Int) {
            XCTAssertEqual(counter.composerStateSelects, counter.draftSelects, "one of each per fetch")
            XCTAssertEqual(counter.outboxSelects, counter.draftSelects)
            return (counter.draftSelects - storage.reads, storage.reads, deliveries.all.count)
        }
        var cost = costs()
        // The observation's first fetch matches the opening read.
        XCTAssertEqual([cost.fetches, cost.reads, cost.deliveries], [1, 1, 1], "opening")

        for at in Int64(200)..<Int64(215) {
            try store.applySessionActivity(id: "s", active: true, activeAt: at)
        }
        try await Task.sleep(for: .milliseconds(100))
        cost = costs()
        XCTAssertEqual([cost.fetches, cost.reads, cost.deliveries], [1, 1, 1], "15 heartbeats: nothing")

        // The observed region is the whole draft, composerState and outbox
        // tables, so another session's row costs a background fetch, which
        // matches what the composer holds and goes no further.
        try store.saveDraft(sessionId: "other", text: "elsewhere", at: 2)
        try store.saveComposerState(ComposerStateRecord(sessionId: "other", values: .object(["permissionMode": .string("plan")])))
        for _ in 0..<400 where counter.draftSelects - storage.reads < 3 {
            try await Task.sleep(for: .milliseconds(5))
        }
        try await Task.sleep(for: .milliseconds(100))
        cost = costs()
        XCTAssertEqual([cost.fetches, cost.reads, cost.deliveries], [3, 1, 1], "another session: one fetch each, no read")

        try store.enqueue(OutboxRecord(localId: "f", kind: .file, sessionId: "s", payload: .null, createdAt: 1, state: .failed))
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        try await Task.sleep(for: .milliseconds(100))
        cost = costs()
        XCTAssertEqual([cost.fetches, cost.reads, cost.deliveries], [4, 2, 2], "a failed upload: a fetch, a read, a delivery")
        XCTAssertEqual(deliveries.all.map(\.value), [
            ComposerStoreValue(draft: "unsent"),
            ComposerStoreValue(draft: "unsent", failedAttachments: 1),
        ])
        XCTAssertEqual(deliveries.offMain, 0)
        writer.close()
        await sync.stop()
    }

    func testAFailedObservationIsReportedAndStartedAgain() async throws {
        let (store, sync, sender, files) = try await fixture(rig: false)
        defer { try? FileManager.default.removeItem(at: files) }
        let failures = Failures()
        let writer = ComposerDraftWriter(
            sessionId: "s", storage: sender, sending: sender, retryDelays: [.milliseconds(20)], onFailure: failures.record
        )
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        let schema = try await store.writer.read { db in
            try String.fetchOne(db, sql: "SELECT sql FROM sqlite_master WHERE name = 'composerState'")
        }
        try await store.writer.write { db in try db.execute(sql: "DROP TABLE composerState") }
        // The next fetch finds no table.
        try store.saveDraft(sessionId: "s", text: "while it was down", at: 2)
        for _ in 0..<200 where !failures.operations.contains(.observation) {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(failures.operations.contains(.observation))
        try await store.writer.write { db in try db.execute(sql: try XCTUnwrap(schema)) }
        // Started again, it catches up on what changed while it was down.
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        XCTAssertEqual(deliveries.all.last?.value.draft, "while it was down")
        try store.saveComposerState(ComposerStateRecord(sessionId: "s", values: .object(["permissionMode": .string("plan")])))
        await fulfillment(of: [deliveries.expect(3)], timeout: 5)
        XCTAssertEqual(deliveries.all.last?.value.picks, ComposerPicks(permissionMode: "plan"))
        writer.close()
        await sync.stop()
    }

    func testAHappyAgentSendWaitsOutAFailingDiskAndItsClearSticks() async throws {
        let (store, sync, sender, files) = try await fixture(rig: true)
        defer { try? FileManager.default.removeItem(at: files) }
        await sync.rigComposer.configure(transport: NeverAcknowledges())
        let storage = FlakyStorage(sender)
        let writer = ComposerDraftWriter(sessionId: "s", storage: storage, sending: sender, retryDelays: [.milliseconds(5)])
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        var model = ComposerDraftModel()
        _ = model.receive(deliveries.all[0], text: "", synced: true, composing: false)
        type("hello", into: &model, synced: true, writer: writer)
        await writer.settle()
        storage.failing = true
        type("hello there", into: &model, synced: true, writer: writer)
        do {
            _ = try await writer.send(OutgoingMessage(text: "hello there")).value
            XCTFail("the draft before it isn't on disk")
        } catch {
            XCTAssertTrue(error is ComposerDraftWriter.UnsavedDraftError)
        }
        XCTAssertTrue(try store.pendingOutbox().isEmpty, "nothing was accepted")
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "hello")

        storage.failing = false
        let saved = await writer.settle()
        XCTAssertTrue(saved)
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "hello there")
        let id = try await writer.send(OutgoingMessage(text: "hello there")).value
        XCTAssertEqual(model.clear(stored: false).persist, .never, "the send clears a Happy Agent draft")
        try await Task.sleep(for: .milliseconds(50))
        await writer.settle()
        XCTAssertNil(try store.draft(sessionId: "s"), "no retry brings the sent text back")
        XCTAssertEqual(try store.pendingOutbox().map(\.localId), [id])
        writer.close()
        await sync.stop()
    }

    /// With the thread checks on, the writer's whole round (open, observe,
    /// write, send, plan) passes them, and a read from main is caught.
    func testTheWritersStoreAccessPassesTheThreadChecks() async throws {
        let (store, sync, sender, files) = try await fixture(rig: false)
        defer { try? FileManager.default.removeItem(at: files) }
        let violations = ThreadViolationLog()
        let oldEnforcement = ThreadRules.isEnforced
        let oldHandler = ThreadRules.violationHandler
        ThreadRules.violationHandler = { violations.append($0) }
        ThreadRules.isEnforced = true
        defer {
            ThreadRules.isEnforced = oldEnforcement
            ThreadRules.violationHandler = oldHandler
        }
        let writer = ComposerDraftWriter(sessionId: "s", storage: sender, sending: sender)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        writer.save("hello", generation: 1)
        _ = try await writer.send(OutgoingMessage(text: "hello")).value
        writer.save("", generation: 2)
        await writer.settle()
        try await Task.detached { try store.saveDraft(sessionId: "s", text: "remote", at: 5) }.value
        await fulfillment(of: [deliveries.expect(2)], timeout: 5)
        _ = try await sender.attachmentPlan(for: OutgoingMessage(text: "hi"), sessionId: "s")
        await writer.settle()
        XCTAssertEqual(violations.values, [])

        _ = try sender.composerValue(sessionId: "s")
        XCTAssertEqual(violations.values, [.offMain], "a read on main")
        writer.close()
        await sync.stop()
    }

    func testTheAttachmentPlanReadsTheSessionOffTheMainThread() async throws {
        let (_, sync, sender, files) = try await fixture(rig: false)
        defer { try? FileManager.default.removeItem(at: files) }
        let picture = OutgoingAttachment(fileURL: files, name: "a.jpg", mimeType: "image/jpeg", size: 1, width: 1, height: 1)
        let plan = try await sender.attachmentPlan(for: OutgoingMessage(text: "hi", attachments: [picture]), sessionId: "s")
        XCTAssertEqual(plan.accepted, [picture])
        do {
            _ = try await sender.attachmentPlan(for: OutgoingMessage(text: "hi"), sessionId: "missing")
            XCTFail("an unknown session")
        } catch {
            XCTAssertEqual(error as? SendingError, .unknownSession)
        }
        await sync.stop()
    }

    /// The model and the writer together, as the composer drives them.
    private func type(_ text: String, into model: inout ComposerDraftModel, synced: Bool, writer: ComposerDraftWriter) {
        if let write = model.textChanged(text, synced: synced).write {
            writer.save(write)
        }
    }

    func testAnOldSaveCannotOutliveTheClearAfterASend() async throws {
        let (store, sync, sender, files) = try await fixture(rig: false)
        defer { try? FileManager.default.removeItem(at: files) }
        let writer = ComposerDraftWriter(sessionId: "s", storage: sender, sending: sender)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        var model = ComposerDraftModel()
        _ = model.receive(deliveries.all[0], text: "", synced: false, composing: false)
        type("h", into: &model, synced: false, writer: writer)
        type("hello", into: &model, synced: false, writer: writer)
        XCTAssertTrue(model.autosave.hasPending, "waiting for the debounce")
        // Send: the pending edit goes first, then the send, then the clear.
        if let write = model.flush(text: "hello") { writer.save(write) }
        let id = try await writer.send(OutgoingMessage(text: "hello")).value
        writer.save(model.clear(stored: true))
        await writer.settle()
        XCTAssertNil(try store.draft(sessionId: "s"))
        XCTAssertNotNil(try store.outbox(localId: id))
        XCTAssertEqual(model.generation, 3)
        writer.close()
        await sync.stop()
    }

    func testAHappyAgentSendClearsItsDraftAndTypingDuringItSurvives() async throws {
        let (store, sync, sender, files) = try await fixture(rig: true)
        defer { try? FileManager.default.removeItem(at: files) }
        await sync.rigComposer.configure(transport: NeverAcknowledges())
        let writer = ComposerDraftWriter(sessionId: "s", storage: sender, sending: sender)
        let deliveries = Deliveries()
        writer.start { deliveries.receive($0) }
        await fulfillment(of: [deliveries.expect(1)], timeout: 5)
        var model = ComposerDraftModel()
        _ = model.receive(deliveries.all[0], text: "", synced: true, composing: false)
        for text in ["h", "he", "hello"] { type(text, into: &model, synced: true, writer: writer) }
        // Queued at once: the send reads the stamp of the last keystroke's
        // write, so its clear goes through, and the next keystroke is
        // written after the clear.
        let sent = writer.send(OutgoingMessage(text: "hello"))
        type("hello again", into: &model, synced: true, writer: writer)
        _ = try await sent.value
        await writer.settle()
        XCTAssertEqual(try store.draft(sessionId: "s")?.text, "hello again")
        XCTAssertEqual(model.generation, 4)

        // Nothing typed during the send: the store is cleared and the
        // composer, clearing too, sees no remote edit.
        let (store2, sync2, sender2, files2) = try await fixture(rig: true)
        defer { try? FileManager.default.removeItem(at: files2) }
        await sync2.rigComposer.configure(transport: NeverAcknowledges())
        let writer2 = ComposerDraftWriter(sessionId: "s", storage: sender2, sending: sender2)
        let deliveries2 = Deliveries()
        writer2.start { deliveries2.receive($0) }
        await fulfillment(of: [deliveries2.expect(1)], timeout: 5)
        var model2 = ComposerDraftModel()
        _ = model2.receive(deliveries2.all[0], text: "", synced: true, composing: false)
        type("hello", into: &model2, synced: true, writer: writer2)
        _ = try await writer2.send(OutgoingMessage(text: "hello")).value
        XCTAssertEqual(model2.clear(stored: false), .init(text: "", generation: 2, persist: .never), "only counted")
        XCTAssertNil(try store2.draft(sessionId: "s"))
        await fulfillment(of: [deliveries2.expect(2)], timeout: 5)
        let cleared = try XCTUnwrap(deliveries2.all.last)
        XCTAssertEqual(cleared.value.draft, "")
        XCTAssertNil(model2.receive(cleared, text: "", synced: true, composing: false).text)

        writer.close()
        writer2.close()
        await sync.stop()
        await sync2.stop()
    }
}

/// Counts the SELECTs of the composer's three lookups.
private final class ComposerSQLCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    var draftSelects: Int { lock.withLock { counts["draft", default: 0] } }
    var composerStateSelects: Int { lock.withLock { counts["composerState", default: 0] } }
    var outboxSelects: Int { lock.withLock { counts["outbox", default: 0] } }
    func reset() { lock.withLock { counts = [:] } }
    func trace(_ event: Database.TraceEvent) {
        let sql = event.description
        guard sql.hasPrefix("SELECT") else { return }
        for table in ["draft", "composerState", "outbox"] where sql.contains("FROM \"\(table)\"") {
            lock.withLock { counts[table, default: 0] += 1 }
        }
    }
}

/// A Happy Agent's metadata writer that never hears back, so the test's
/// drafts stay local.
private struct NeverAcknowledges: MetadataUpdateTransport {
    func updateMetadata(event: String, payload: JSONValue) async throws -> JSONValue {
        throw CancellationError()
    }
}

/// useDraft.ts over an asynchronous store.
final class ComposerDraftModelTests: XCTestCase {
    /// `saved`: the writer found the draft to be the text last saved.
    private func delivery(_ draft: String, _ generation: Int, saved: Bool = false, picks: ComposerPicks = ComposerPicks(), failed: Int = 0) -> ComposerStoreDelivery {
        ComposerStoreDelivery(value: ComposerStoreValue(draft: draft, picks: picks, failedAttachments: failed), generation: generation, draftIsSaved: saved)
    }

    func testTheOpeningDraftLoadsIntoAnUntouchedComposer() {
        var model = ComposerDraftModel()
        let change = model.receive(delivery("unsent", 0), text: "", synced: false, composing: false)
        XCTAssertEqual(change.text, "unsent")
        XCTAssertEqual(change.write, .init(text: "unsent", generation: 1, persist: .never), "counted as saved, not written")
        XCTAssertTrue(model.isLoaded)
        XCTAssertFalse(model.autosave.savedIsBlank)
        // The text view takes it, which writes nothing back.
        XCTAssertNil(model.textChanged("unsent", synced: false).write)
        XCTAssertEqual(model.generation, 1)
        // The person's next edit is theirs.
        XCTAssertEqual(model.textChanged("unsent!", synced: false).debounce, true)
    }

    func testTypingBeforeTheFirstReadKeepsTheTyping() {
        var model = ComposerDraftModel()
        XCTAssertEqual(model.textChanged("x", synced: false).write, .init(text: "x", generation: 1, persist: .unlessSaved))
        let change = model.receive(delivery("stored", 0), text: "x", synced: false, composing: false)
        XCTAssertNil(change.text)
        XCTAssertNil(change.write)
        XCTAssertTrue(model.isLoaded)
        XCTAssertFalse(model.autosave.savedIsBlank)
        // Typed and deleted again: the write that emptied it still counts.
        var cleared = ComposerDraftModel()
        _ = cleared.textChanged("x", synced: false)
        _ = cleared.textChanged("", synced: false)
        XCTAssertNil(cleared.receive(delivery("stored", 0), text: "", synced: false, composing: false).text)
    }

    func testAnEditCarriesTheFieldWithoutReadingIt() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: true, composing: false)
        let mirror = ComposerTextMirror()
        mirror.replace(NSRange(location: 0, length: 0), with: "hello")
        let snapshot = mirror.snapshot()
        var asked = 0
        func field() -> ComposerDraftText {
            asked += 1
            return ComposerDraftText(snapshot)
        }
        XCTAssertEqual(model.textChanged(isBlank: false, synced: true, text: field()).write,
                       .init(text: ComposerDraftText(snapshot), generation: 1, persist: .unlessSaved))
        // An edit that waits, or writes nothing, never asks for the field.
        var local = ComposerDraftModel()
        _ = local.receive(delivery("", 0), text: "", synced: false, composing: false)
        XCTAssertNil(local.textChanged(isBlank: true, synced: false, text: field()).write, "blank to blank")
        XCTAssertNotNil(local.textChanged(isBlank: false, synced: false, text: field()).write, "blank to text")
        XCTAssertEqual(local.textChanged(isBlank: false, synced: false, text: field()).debounce, true)
        XCTAssertEqual(asked, 2, "the synced edit and the one that left the blank")
        // The flush asks for it then.
        XCTAssertEqual(local.flush(text: field())?.text, ComposerDraftText(snapshot))
        XCTAssertEqual(asked, 3)
    }

    func testAReadOlderThanTheNewestWriteIsNotARemoteEdit() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: true, composing: false)
        XCTAssertEqual(model.textChanged("a", synced: true).write?.generation, 1)
        XCTAssertEqual(model.textChanged("ab", synced: true).write?.generation, 2)
        XCTAssertNil(model.receive(delivery("a", 1), text: "ab", synced: true, composing: false).text)
        XCTAssertNil(model.receive(delivery("ab", 2, saved: true), text: "ab", synced: true, composing: false).text)
        let remote = model.receive(delivery("from the laptop", 2), text: "ab", synced: true, composing: false)
        XCTAssertEqual(remote.text, "from the laptop")
        XCTAssertEqual(remote.write, .init(text: "from the laptop", generation: 3, persist: .never))
        // Setting it is the model's own change; reads before its count are
        // not news, even showing it again.
        XCTAssertNil(model.textChanged("from the laptop", synced: true).write)
        XCTAssertNil(model.receive(delivery("from the laptop", 2), text: "from the laptop", synced: true, composing: false).text)
        XCTAssertNil(model.receive(delivery("from the laptop", 3, saved: true), text: "from the laptop", synced: true, composing: false).text)
    }

    func testOnlyHappyAgentDraftsTakeRemoteText() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: false, composing: false)
        XCTAssertNil(model.receive(delivery("elsewhere", 0), text: "", synced: false, composing: false).text)
    }

    func testARemoteEditWaitsForTheCompositionAndTheRefreshTakesIt() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: true, composing: false)
        _ = model.textChanged("a", synced: true)
        XCTAssertNil(model.receive(delivery("from the laptop", 1), text: "a", synced: true, composing: true).text)
        XCTAssertTrue(model.autosave.remoteDeferred)
        // The composition was cancelled; the refresh reads the same value.
        XCTAssertEqual(model.receive(delivery("from the laptop", 1), text: "a", synced: true, composing: false).text, "from the laptop")
        XCTAssertFalse(model.autosave.remoteDeferred)
    }

    func testACommittedCompositionWinsOverTheDeferredRemoteEdit() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: true, composing: false)
        _ = model.textChanged("a", synced: true)
        XCTAssertNil(model.receive(delivery("from the laptop", 1), text: "a", synced: true, composing: true).text)
        // The commit is written over the remote text, then the store read.
        XCTAssertEqual(model.textChanged("a日本", synced: true).write, .init(text: "a日本", generation: 2, persist: .unlessSaved))
        XCTAssertNil(model.receive(delivery("from the laptop", 1), text: "a日本", synced: true, composing: false).text, "read before the commit's write")
        XCTAssertTrue(model.autosave.remoteDeferred)
        XCTAssertNil(model.receive(delivery("a日本", 2, saved: true), text: "a日本", synced: true, composing: false).text)
        XCTAssertFalse(model.autosave.remoteDeferred)
    }

    func testTheGenerationKeepsCountingThroughASendsClear() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: false, composing: false)
        XCTAssertEqual(model.textChanged("hello", synced: false).write?.generation, 1)
        XCTAssertEqual(model.clear(stored: true), .init(text: "", generation: 2, persist: .always))
        XCTAssertNil(model.textChanged("", synced: false).write, "the field emptied after it")
        XCTAssertEqual(model.clear(stored: false), .init(text: "", generation: 3, persist: .never))
        XCTAssertNil(model.textChanged("", synced: true).write)
        XCTAssertEqual(model.textChanged("next", synced: false).write?.generation, 4)
        // A read from before the clear is not news.
        var synced = ComposerDraftModel()
        _ = synced.receive(delivery("", 0), text: "", synced: true, composing: false)
        _ = synced.textChanged("hello", synced: true)
        _ = synced.clear(stored: true)
        XCTAssertNil(synced.receive(delivery("hello", 1), text: "", synced: true, composing: false).text)
    }

    func testDebouncedEditsFlushOnce() {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: false, composing: false)
        _ = model.textChanged("h", synced: false)
        XCTAssertEqual(model.textChanged("he", synced: false).debounce, true)
        XCTAssertEqual(model.textChanged("hel", synced: false).debounce, true)
        XCTAssertEqual(model.flush(text: "hel"), .init(text: "hel", generation: 2, persist: .unlessSaved))
        XCTAssertNil(model.flush(text: "hel"))
    }

    /// A pending chat's composer: every keystroke written, nothing taken
    /// from its record, then moved to the session that arrived.
    private func pending(_ typed: [String]) -> ComposerDraftModel {
        var model = ComposerDraftModel()
        _ = model.receive(delivery("", 0), text: "", synced: false, composing: false)
        for text in typed { _ = model.textChanged(text, synced: true) }
        return model
    }

    func testARetargetedComposerKeepsItsTextAndWritesItWhereTheStoreDiffers() {
        var model = pending(["h", "hello"])
        XCTAssertEqual(model.generation, 2)
        model.retarget()
        XCTAssertFalse(model.isLoaded)
        // The handover wrote something else (an earlier queued message too).
        let change = model.receive(delivery("queued\n\nhello", 2), text: "hello", synced: false, composing: false)
        XCTAssertNil(change.text, "never reseeded over the field")
        XCTAssertEqual(change.write, .init(text: "hello", generation: 3, persist: .unlessStored))
        XCTAssertFalse(model.autosave.savedIsBlank)
    }

    func testARetargetedComposerLeavesAnAgreeingStoreToTheWriter() {
        var model = pending(["hello"])
        model.retarget()
        // The writer compares the field with the store off the main thread
        // and writes nothing when they agree; the write is still counted.
        XCTAssertEqual(model.receive(delivery("hello", 1), text: "hello", synced: true, composing: false),
                       .init(picks: ComposerPicks(), write: .init(text: "hello", generation: 2, persist: .unlessStored)))
        // A remote edit after that is news again.
        XCTAssertEqual(model.receive(delivery("from the laptop", 2), text: "hello", synced: true, composing: false).text, "from the laptop")
    }

    func testAnEmptyRetargetedComposerLoadsTheSessionsDraft() {
        var model = pending(["x", ""])
        model.retarget()
        let change = model.receive(delivery("queued", 2), text: "", synced: false, composing: false)
        XCTAssertEqual(change.text, "queued")
        XCTAssertEqual(change.write, .init(text: "queued", generation: 3, persist: .never))
    }

    func testTypingAfterTheRetargetIsLeftToItsOwnWrites() {
        var model = pending(["hello"])
        model.retarget()
        XCTAssertEqual(model.textChanged("hello!", synced: true).write?.generation, 2)
        let change = model.receive(delivery("hello!", 2, saved: true), text: "hello!", synced: true, composing: false)
        XCTAssertNil(change.write)
        XCTAssertNil(change.text)
        // Nor does an empty field take the session's draft once typed in.
        var cleared = pending(["x"])
        cleared.retarget()
        _ = cleared.textChanged("", synced: true)
        XCTAssertNil(cleared.receive(delivery("stored", 2), text: "", synced: false, composing: false).text)
    }

    func testARetargetedFirstReadDuringASendWaitsForIt() {
        var model = pending(["hello"])
        model.retarget()
        // The pending submit went; the field still shows what it sent.
        XCTAssertEqual(model.receive(delivery("", 1), text: "hello", synced: false, composing: false, sending: true), .init(),
                       "the sent text is not written to the session")
        XCTAssertFalse(model.isLoaded)
        XCTAssertEqual(model.generation, 1)
        XCTAssertEqual(model.clear(stored: false).persist, .never)
        XCTAssertNil(model.textChanged("", synced: false).write)
        XCTAssertTrue(model.sendReturned(), "the read is asked for again")
        XCTAssertFalse(model.sendReturned())
        XCTAssertEqual(model.receive(delivery("", 2), text: "", synced: false, composing: false), .init(picks: ComposerPicks()))
        XCTAssertTrue(model.isLoaded)
        // A refused submit keeps the text, which the handover wrote too:
        // the writer finds the store agrees.
        var refused = pending(["hello"])
        refused.retarget()
        _ = refused.receive(delivery("hello", 1), text: "hello", synced: false, composing: false, sending: true)
        XCTAssertTrue(refused.sendReturned())
        XCTAssertEqual(refused.receive(delivery("hello", 1), text: "hello", synced: false, composing: false).write?.persist, .unlessStored)
    }

    func testAnOpeningDuringASendIsNotPutOff() {
        var model = ComposerDraftModel()
        _ = model.textChanged("hi", synced: false)
        _ = model.receive(delivery("", 0), text: "hi", synced: false, composing: false, sending: true)
        XCTAssertTrue(model.isLoaded)
        XCTAssertFalse(model.sendReturned())
    }

    func testAStoreBehindTheFieldGetsTheFieldEvenEmpty() {
        // The old store's last write (clearing the field) failed: the
        // handover carried the text before it.
        var model = pending(["old", ""])
        model.retarget()
        let change = model.receive(delivery("old", 1), text: "", synced: false, composing: false)
        XCTAssertNil(change.text, "the deleted text is not loaded back")
        XCTAssertEqual(change.write, .init(text: "", generation: 3, persist: .always))
        // Agreeing text is written again, so the numbering catches up.
        var same = pending(["a", "ab"])
        same.retarget()
        XCTAssertEqual(same.receive(delivery("ab", 1), text: "ab", synced: true, composing: false).write, .init(text: "ab", generation: 3, persist: .always))
        XCTAssertEqual(same.receive(delivery("from the laptop", 3), text: "ab", synced: true, composing: false).text, "from the laptop")
    }

    func testARetargetStartsThePicksAndFailuresAfresh() {
        var model = ComposerDraftModel()
        let plan = ComposerPicks(permissionMode: "plan")
        _ = model.receive(delivery("", 0, picks: plan, failed: 2), text: "", synced: false, composing: false)
        model.retarget()
        let change = model.receive(delivery("", 0, picks: plan, failed: 5), text: "", synced: false, composing: false)
        XCTAssertEqual(change.picks, plan, "the new session's picks are shown")
        XCTAssertEqual(change.newlyFailedAttachments, 0, "its old failures are not news")
        XCTAssertEqual(model.receive(delivery("", 0, picks: plan, failed: 6), text: "", synced: false, composing: false).newlyFailedAttachments, 1)
    }

    func testPicksAndFailuresChangeOnlyWhenTheyMove() {
        var model = ComposerDraftModel()
        let plan = ComposerPicks(permissionMode: "plan")
        XCTAssertEqual(model.receive(delivery("", 0, picks: plan, failed: 1), text: "", synced: false, composing: false),
                       .init(picks: plan), "failures before opening are not news")
        XCTAssertEqual(model.receive(delivery("", 0, picks: plan, failed: 1), text: "", synced: false, composing: false), .init())
        XCTAssertEqual(model.receive(delivery("", 0, picks: plan, failed: 3), text: "", synced: false, composing: false),
                       .init(newlyFailedAttachments: 2))
        XCTAssertEqual(model.receive(delivery("", 0, picks: plan, failed: 0), text: "", synced: false, composing: false), .init())
        XCTAssertEqual(model.receive(delivery("", 0, failed: 1), text: "", synced: false, composing: false),
                       .init(picks: ComposerPicks(), newlyFailedAttachments: 1))
    }
}
