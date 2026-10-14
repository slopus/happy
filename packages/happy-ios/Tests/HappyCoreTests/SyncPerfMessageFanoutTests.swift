import Foundation
import GRDB
import XCTest
import HappyCrypto
@testable import HappyStore
import HappyWire
@testable import HappyCore

private struct MessageFanoutRandom: RandomSource {
    func bytes(_ count: Int) -> Data { Data(repeating: 7, count: count) }
}

private final class MessageFanoutCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var sql = 0
    private var deliveries = 0
    private var publications = 0
    private var derivations = 0
    var values: [Int] { lock.withLock { [sql, deliveries, publications, derivations] } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.lowercased().contains("select * from \"session\" order by") {
            lock.withLock { sql += 1 }
        }
    }
    func delivered() { lock.withLock { deliveries += 1 } }
    func received() { lock.withLock { publications += 1 } }
    func derived() { lock.withLock { derivations += 1 } }
}

final class SyncPerfMessageFanoutTests: XCTestCase {
    func testThousandEncryptedSocketMessagesDoNotFetchPublishOrDeriveHome() async throws {
        let counts = MessageFanoutCounts()
        var configuration = Configuration()
        configuration.prepareDatabase { db in db.trace { counts.trace($0) } }
        let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
        let keys = try AccountKeys(secret: Data(repeating: 3, count: 32))
        let cipher = RecordCipher(key: Data(repeating: 5, count: 32))
        let wrapped = Base64.encode(try keys.wrapDataKey(Data(repeating: 5, count: 32), random: MessageFanoutRandom()))
        let decoder = RecordDecoder(keyRing: KeyRing(keys: keys))
        let rows = try (0..<1000).map { index in
            decoder.session(APISession(
                id: "s\(index)", seq: 0, createdAt: 1, updatedAt: 1000 + Int64(index),
                active: true, activeAt: ApplyPerfFixtures.now, metadata: try cipher.encrypt(.object([
                    "machineId": .string("computer"), "path": .string("/work/project\(index)"),
                    "summary": .object(["text": .string("Session \(index)")]),
                    "lastMeaningfulMessageAt": .number(Double(ApplyPerfFixtures.now - Int64(index) * 60_000)),
                ]), random: MessageFanoutRandom()), metadataVersion: 1, agentState: nil,
                agentStateVersion: 0, dataEncryptionKey: wrapped, projectId: nil
            ))
        }
        try store.upsertSessions(rows)
        try store.replaceMachines([ApplyPerfFixtures.machine])
        try store.setCursor(.machinesLastSync, 1)
        try store.setCursor(.sessionsChangedSince, 1)
        let http = FakeHTTP()
        let engine = SyncEngine(api: testAPI(http), store: store, keys: keys, now: { ApplyPerfFixtures.now })
        let initialHome = expectation(description: "home is subscribed and derived")
        let unexpectedHome = expectation(description: "message burst does not publish home")
        unexpectedHome.isInverted = true
        let sentinelHome = expectation(description: "watched settings write drains the Home observer")
        let rawHome = store.homeObservation.start(onError: { XCTFail("\($0)") }, onChange: { _ in
            XCTAssertFalse(Thread.isMainThread)
            counts.delivered()
        })
        defer { rawHome.cancel() }
        let homeTask = Task.detached {
            var applied = HomeDerivation.Applied()
            for await snapshot in HomeFeed(store: store).snapshots() {
                XCTAssertFalse(Thread.isMainThread)
                counts.received()
                counts.derived()
                if let result = ApplyPerfFixtures.derive(snapshot, after: applied) { applied = result.state }
                if snapshot.settings.pending["fanoutSentinel"] == .bool(true) { sentinelHome.fulfill() }
                else if counts.values[2] == 1 { initialHome.fulfill() }
                else { unexpectedHome.fulfill() }
            }
        }
        defer { homeTask.cancel() }
        let detailStream = SessionDetailFeed(store: store).snapshots(sessionId: "s0")
        let firstDetail = try await syncPerfNext(detailStream)
        let initialDetail = try XCTUnwrap(firstDetail)
        let troubleStream = store.troubleshootingSnapshots()
        let initialTrouble = try await syncPerfNext(troubleStream)
        XCTAssertEqual(initialTrouble?.recentSession?.path, "/work/project999")
        await fulfillment(of: [initialHome], timeout: 5)
        XCTAssertEqual(counts.values, [1, 1, 1, 1])
        let finalDetail = expectation(description: "Info receives the final sequence and timestamp")
        let detailTask = Task.detached {
            for await detail in detailStream where detail.session?.seq == 1000 {
                var before = SessionInfoInput(); before.detail = initialDetail
                var after = SessionInfoInput(); after.detail = detail
                let previous = SessionInfoDerivation.derive(before, applied: nil)?.state
                let update = SessionInfoDerivation.derive(after, applied: previous)
                XCTAssertEqual(update?.output.frame.model?.seq, 1000)
                XCTAssertEqual(update?.output.frame.model?.updatedAt, 4000)
                XCTAssertEqual(update?.output.changes.sequence, true)
                XCTAssertEqual(update?.output.changes.lastUpdated, true)
                XCTAssertEqual(update?.output.changes.rebuilt, [])
                finalDetail.fulfill()
                break
            }
        }
        defer { detailTask.cancel() }
        let finalTrouble = expectation(description: "Troubleshooting selects the newly active project")
        let troubleTask = Task.detached {
            for await snapshot in troubleStream where snapshot.recentSession?.path == "/work/project0" {
                XCTAssertEqual(snapshot.machines, initialTrouble?.machines)
                finalTrouble.fulfill()
                break
            }
        }
        defer { troubleTask.cancel() }
        let commits = SyncPerfCommits()
        store.writer.add(transactionObserver: commits)
        let start = ContinuousClock.now
        for seq in 1...1000 {
            let payload: JSONValue = .object([
                "role": .string("session"), "content": .object([
                    "id": .string("e\(seq)"), "time": .number(Double(seq)), "role": .string("agent"),
                    "ev": .object(["t": .string("text"), "text": .string("token \(seq)")]),
                ]),
            ])
            let message = SessionMessage(id: "m\(seq)", seq: seq, localId: nil,
                                         content: SessionMessageContent(c: try cipher.encrypt(payload, random: MessageFanoutRandom())),
                                         createdAt: 3000 + Int64(seq), updatedAt: 3000 + Int64(seq))
            await engine.handle(UpdateContainer(id: "u\(seq)", seq: seq,
                                                body: .newMessage(sessionId: "s0", message: message), createdAt: message.createdAt))
        }
        await fulfillment(of: [finalDetail, finalTrouble], timeout: 5)
        await fulfillment(of: [unexpectedHome], timeout: 0.05)
        XCTAssertEqual(counts.values, [1, 1, 1, 1], "zero burst Home SQL, raw deliveries, publications and real derivations")
        XCTAssertEqual(commits.value, 1000, "socket writes currently commit each message separately")
        let messages = try store.messages(sessionId: "s0", limit: 1001)
        XCTAssertEqual(messages.count, 1000)
        XCTAssertEqual(messages.map(\.seq), Array(1...1000))
        guard case .session(let envelope, _)? = messages.last?.content.map(MessageContent.init(decrypted:)) else {
            return XCTFail("the production socket path must decrypt the final chat message")
        }
        XCTAssertEqual(envelope.ev, .text(text: "token 1000", thinking: false))
        XCTAssertEqual(try store.session(id: "s0")?.syncedMessageSeq, 1000)
        XCTAssertTrue(http.requests.isEmpty, "contiguous socket messages do not need recovery requests")
        // This watched write also checks the observer remains live after the
        // burst. It must add exactly one fetch, publication and derivation.
        try store.addPendingSettings(["fanoutSentinel": .bool(true)])
        await fulfillment(of: [sentinelHome], timeout: 5)
        XCTAssertEqual(counts.values, [2, 2, 2, 2])
        print("SYNC_PERF encrypted-socket-1000: commits=1000 home_sql=0 home_raw_values=0 home_values=0 home_derivations=0 duration=\(start.duration(to: .now))")
        homeTask.cancel()
        rawHome.cancel()
        await store.stopSnapshotProducers()
        await engine.stop()
    }
}