import Foundation
import XCTest
@testable import HappyCore
import HappyWire

/// A computer or server that answers intents as told.
private actor FakeIntentServer {
    enum Answer { case ok, transient, refuse(String) }
    var answers: [String: [Answer]] = [:]
    private(set) var heard: [Intent] = []
    var gate: CheckedContinuation<Void, Never>?
    var holding = false

    func answer(_ target: String, _ list: [Answer]) { answers[target] = list }
    func hold() { holding = true }
    func release() { holding = false; gate?.resume(); gate = nil }

    func deliver(_ intent: Intent) async throws {
        heard.append(intent)
        if holding { await withCheckedContinuation { gate = $0 } }
        var list = answers[intent.target] ?? []
        let next = list.isEmpty ? Answer.ok : list.removeFirst()
        answers[intent.target] = list
        switch next {
        case .ok: return
        case .transient: throw URLError(.networkConnectionLost)
        case .refuse(let reason): throw IntentRefusal(reason)
        }
    }
}

final class IntentOutboxTests: XCTestCase {
    private func folder() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("intents-\(UUID().uuidString)") }

    private func eventually(_ seconds: Double = 3, _ condition: @escaping () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now + .seconds(seconds)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { return XCTFail("timed out", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Time that passes only as the outbox sleeps: a retry is due as soon
    /// as it waits for it.
    private final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var ms: Int64 = 1_000_000
        func now() -> Int64 { lock.lock(); defer { lock.unlock() }; return ms }
        func advance(_ duration: Duration) {
            lock.lock(); defer { lock.unlock() }
            ms += Int64(duration.components.seconds * 1000) + Int64(duration.components.attoseconds / 1_000_000_000_000_000)
        }
    }

    private func makeOutbox(_ storage: IntentStorage = MemoryIntentStorage()) -> IntentOutbox {
        let clock = Clock()
        return IntentOutbox(storage: storage, now: { clock.now() }, sleep: { clock.advance($0); await Task.yield() })
    }

    func testTabOpenRetryIdentitySurvivesOfflineReopenAndIsAccountLocal() async throws {
        let storage = MemoryIntentStorage()
        let first = makeOutbox(storage)
        let value: JSONValue = .object(["kind": "artifact", "id": "same"])
        let intent = try await first.enqueue(.tabOpen, target: "artifact:same", value: value)
        let repeatOpen = try await first.enqueue(.tabOpen, target: "artifact:same", value: value)
        XCTAssertEqual(repeatOpen.id, intent.id)
        let restored = makeOutbox(storage)
        let reopened = try await restored.enqueue(.tabOpen, target: "artifact:same", value: value)
        XCTAssertEqual(reopened.id, intent.id)
        let otherAccount = makeOutbox()
        let independent = try await otherAccount.enqueue(.tabOpen, target: "artifact:same", value: value)
        XCTAssertNotEqual(independent.id, intent.id)
        let pending = await restored.pending()
        XCTAssertEqual(pending, [intent])
    }

    func testANewerActionReplacesTheOneWaitingInItsSlot() async throws {
        let outbox = makeOutbox()
        try await outbox.enqueue(.rename, target: "t1", value: .object(["title": "First"]))
        try await outbox.enqueue(.read, target: "a1")
        try await outbox.enqueue(.rename, target: "t1", value: .object(["title": "Second"]))
        try await outbox.enqueue(.archive, target: "t2")
        try await outbox.enqueue(.unarchive, target: "t2")
        let pending = await outbox.pending()
        XCTAssertEqual(pending.map(\.kind), [.read, .rename, .unarchive])
        let overlay = IntentOverlay(pending)
        XCTAssertEqual(overlay.titles, ["t1": "Second"])
        XCTAssertEqual(overlay.read, ["a1"])
        XCTAssertEqual(overlay.removed, [])
        XCTAssertEqual(overlay.restored, ["t2"])
    }

    func testDeliveryGoesOldestFirstOnlyWhileOnlineAndEmptiesTheOutbox() async throws {
        let server = FakeIntentServer()
        let outbox = makeOutbox()
        await outbox.setDeliver { try await server.deliver($0) }
        try await outbox.enqueue(.read, target: "a1")
        try await outbox.enqueue(.archive, target: "t1")
        try await Task.sleep(for: .milliseconds(50))
        let offline = await server.heard
        XCTAssertEqual(offline, [], "sent while offline")
        await outbox.setOnline(true)
        try await eventually { await outbox.pending().isEmpty }
        let heard = await server.heard.map(\.target)
        XCTAssertEqual(heard, ["a1", "t1"])
    }

    /// The acknowledgement of an earlier action never takes away a newer
    /// one queued for the same thing while it was on its way.
    func testAnAckRemovesOnlyTheActionItAnswers() async throws {
        let server = FakeIntentServer()
        let storage = MemoryIntentStorage()
        let outbox = makeOutbox(storage)
        await outbox.setDeliver { try await server.deliver($0) }
        await server.hold()
        let first = try await outbox.enqueue(.rename, target: "t1", value: .object(["title": "First"]))
        await outbox.setOnline(true)
        try await eventually { await server.heard.count == 1 }
        let second = try await outbox.enqueue(.rename, target: "t1", value: .object(["title": "Second"]))
        await server.release()
        let firstTaken = await outbox.outcome(first.id)
        XCTAssertTrue(firstTaken)
        try await eventually { await outbox.pending().isEmpty }
        let heard = await server.heard.map { $0.value["title"]?.stringValue }
        XCTAssertEqual(heard, ["First", "Second"])
        let kept = await storage.intents()
        XCTAssertTrue(kept.isEmpty)
        XCTAssertNotEqual(first.id, second.id)
    }

    func testATransientFailureBacksOffAndLetsTheRestGo() async throws {
        let server = FakeIntentServer()
        await server.answer("a1", [.transient, .transient])
        let outbox = makeOutbox()
        await outbox.setDeliver { try await server.deliver($0) }
        let stuck = try await outbox.enqueue(.read, target: "a1")
        try await outbox.enqueue(.read, target: "a2")
        await outbox.setOnline(true)
        let taken = await outbox.outcome(stuck.id)
        XCTAssertTrue(taken)
        let heard = await server.heard.map(\.target)
        XCTAssertEqual(heard.first, "a1")
        XCTAssertEqual(heard.filter { $0 == "a1" }.count, 3, "tried again until it went")
        XCTAssertTrue(heard.firstIndex(of: "a2")! < heard.lastIndex(of: "a1")!, "one waiting held back the rest")
        XCTAssertEqual(IntentOutbox.backoff(1), 1000)
        XCTAssertEqual(IntentOutbox.backoff(3), 4000)
        XCTAssertEqual(IntentOutbox.backoff(9), 30000)
    }

    func testARefusalDropsTheActionAndSaysWhy() async throws {
        let server = FakeIntentServer()
        await server.answer("t1", [.refuse("Only its owner may archive it.")])
        let outbox = makeOutbox()
        await outbox.setDeliver { try await server.deliver($0) }
        let rejections = await outbox.rejections()
        let intent = try await outbox.enqueue(.archive, target: "t1")
        let shown = await outbox.pending()
        XCTAssertEqual(IntentOverlay(shown).removed, ["t1"])
        await outbox.setOnline(true)
        let taken = await outbox.outcome(intent.id)
        XCTAssertFalse(taken)
        var iterator = rejections.makeAsyncIterator()
        let rejection = await iterator.next()
        XCTAssertEqual(rejection?.reason, "Only its owner may archive it.")
        let after = await outbox.pending()
        XCTAssertTrue(IntentOverlay(after).removed.isEmpty, "the row came back")
    }

    /// Storage that takes a while to keep each action, so two asked for at
    /// once are both being kept at the same time.
    private actor SlowIntentStorage: IntentStorage {
        private let rows = MemoryIntentStorage()
        func intents() async throws -> [Intent] { await rows.intents() }
        func saveIntent(_ intent: Intent) async throws {
            try await Task.sleep(for: .milliseconds(30))
            await rows.saveIntent(intent)
        }
        func updateIntent(_ intent: Intent) async throws { await rows.updateIntent(intent) }
        func removeIntent(id: String) async throws { await rows.removeIntent(id: id) }
    }

    /// Two actions asked for together both wait: the second to be kept
    /// doesn't write back the list from before the first.
    func testActionsAskedForTogetherAreBothKept() async throws {
        let outbox = makeOutbox(SlowIntentStorage())
        async let first = outbox.enqueue(.read, target: "a1")
        async let second = outbox.enqueue(.rename, target: "t1", value: .object(["title": "Both"]))
        let ids = try await Set([first.id, second.id])
        let pending = await outbox.pending()
        XCTAssertEqual(Set(pending.map(\.id)), ids)
    }

    /// Kept in the account's database: a relaunch has every action still
    /// waiting, with its ID, and sends it then.
    func testPendingActionsSurviveAReopen() async throws {
        let directory = folder()
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("direct.sqlite")
        var storage: SyncStorage? = try await Task.detached { try SyncStorage(url: url) }.value
        var outbox: IntentOutbox? = IntentOutbox(storage: storage!)
        let read = try await outbox!.enqueue(.read, target: "a1")
        try await outbox!.enqueue(.rename, target: "t1", value: .object(["title": "Kept", "kind": "task"]))
        await outbox!.close()
        outbox = nil
        try await storage!.close()
        storage = nil

        let reopened = try await Task.detached { try SyncStorage(url: url) }.value
        let again = IntentOutbox(storage: reopened)
        let pending = await again.pending()
        XCTAssertEqual(pending.map(\.kind), [.read, .rename])
        XCTAssertEqual(pending.first?.id, read.id)
        let server = FakeIntentServer()
        await again.setDeliver { try await server.deliver($0) }
        await again.setOnline(true)
        try await eventually { await again.pending().isEmpty }
        let remaining = try await reopened.intents()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testTheOverlayClearsDotsRenamesAndTakesAwayWhatNestsUnder() {
        var task = Row(id: "task:t1", nodeId: "task:t1", kind: .space, label: "Old", unread: true, agentId: "a1")
        task.targetId = "t1"
        let child = Row(id: "session:c1", nodeId: "session:c1", kind: .session, depth: 1, label: "Child", unread: true, agentId: "c1")
        var bot = Row(id: "bot:b1", nodeId: "bot:b1", kind: .space, label: "Bot", unread: true, agentId: "a2")
        bot.targetId = "b1"
        let rows = [task, child, Row(id: "sep", nodeId: "sep", kind: .separator, label: ""), bot]

        var overlay = IntentOverlay()
        overlay.read = ["a1", "c1"]
        overlay.titles = ["t1": "New"]
        let shown = overlay.apply(rows)
        XCTAssertEqual(shown.map(\.unread), [false, false, false, true])
        XCTAssertEqual(shown.first?.label, "New")

        overlay.removed = ["t1"]
        XCTAssertEqual(overlay.apply(rows).map(\.id), ["sep", "bot:b1"])
        var subtask = IntentOverlay()
        subtask.removed = ["c1"]
        XCTAssertEqual(subtask.apply(rows).map(\.id), ["task:t1", "sep", "bot:b1"])
    }
}
