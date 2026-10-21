import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

/// Kept compatible with f010601a so this exact test also measures the base.
/// No new draft-presence API is called: it counts the existing metadata path.
private final class DraftBroadCounts: @unchecked Sendable {
    private let lock = NSLock()
    private var fetches = 0
    private var derives = 0
    private var stamp = -1
    var counts: (fetches: Int, derives: Int, stamp: Int) { lock.withLock { (fetches, derives, stamp) } }
    func trace(_ event: Database.TraceEvent) {
        if event.description.lowercased().contains("select * from \"session\" order by") {
            lock.withLock { fetches += 1 }
        }
    }
    func derived(_ input: HomeDerivation.Input) {
        let stamp = input.snapshot?.sessions.first(where: { $0.id == "session-0000" })?.metadata?["draftUpdatedAt"]?.numberValue ?? -1
        lock.withLock { derives += 1; self.stamp = Int(stamp) }
    }
}

@MainActor
final class DraftPresenceBroadBaselineTests: XCTestCase {
    func testExistingBroadMetadataPathIsUnchangedByDraftPresenceObservation() async throws {
        let counts = DraftBroadCounts()
        let metadata: [String: JSONValue] = [
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "machineId": .string("computer"), "path": .string("/work/project"),
            "summary": .object(["text": .string("Session 0")]),
            "lastMeaningfulMessageAt": .number(Double(ApplyPerfFixtures.now)),
            "draftUpdatedAt": .number(0), "draft": .null,
        ]
        let store = try await Task.detached {
            var configuration = Configuration()
            configuration.prepareDatabase { db in db.trace { counts.trace($0) } }
            let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
            try store.replaceMachines([ApplyPerfFixtures.machine])
            try store.upsertSessions((0..<3).map(ApplyPerfFixtures.session))
            var row = ApplyPerfFixtures.session(0)
            row.metadataVersion = 2
            row.metadata = .object(metadata)
            try store.upsertSessions([row])
            return store
        }.value
        let feed = HomeFeed(store: store)
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: .init(clock: ApplyPerfFixtures.clock), state: .init(),
            derive: { input, state in counts.derived(input); return HomeDerivation.derive(input, applied: state) },
            apply: { recorder.take($0) })
        pipeline.follow(feed.snapshots()) { $0.snapshot = $1 }
        await applyPerfWait { recorder.outputs.count == 1 }
        XCTAssertEqual(counts.counts.fetches, 1)
        XCTAssertEqual(counts.counts.derives, 1)
        try await Task.detached {
            try store.saveDraft(sessionId: "session-0000", text: "first", at: 1)
            for index in 1...100 { try store.saveDraft(sessionId: "session-0000", text: "local \(index)", at: Int64(index + 1)) }
            try store.saveDraft(sessionId: "session-0000", text: "", at: 102)
            try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: "first", at: 103)
            for index in 1...20 { try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: "rig \(index)", at: Int64(index + 103)) }
            try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: nil, at: 124)
            for index in 1...20 { try store.saveComposerState(ComposerStateRecord(sessionId: "session-0000", values: .object(["pick": .number(Double(index))]))) }
        }.value
        for stamp in 1...22 {
            try await Task.detached {
                var fields = metadata
                fields["draftUpdatedAt"] = .number(Double(stamp))
                fields["draft"] = stamp == 22 ? .null : .object(["text": .string("remote \(stamp)")])
                _ = try store.applySessionUpdate(id: "session-0000",
                    metadata: .init(version: stamp + 2, cipher: "remote-\(stamp)", value: .object(fields)),
                    agentState: nil, projectId: nil, reconcileComposer: SessionModePushCounters().reconciliation)
            }.value
            // An observed metadata version is a fence; each write waits for
            // its real HomeFeed and derivation rather than assuming timing.
            await applyPerfWait { counts.counts.stamp == stamp }
            XCTAssertEqual(counts.counts.fetches, stamp + 1)
            XCTAssertEqual(counts.counts.derives, stamp + 1)
        }
        XCTAssertEqual(recorder.outputs.count, 1, "draft metadata is not rendered by the broad model")
        print("DRAFT_PRESENCE_B local100=0/0 rig20=0/0 composer20=0/0 remoteInsert=1/1 remoteText20=20/20 remoteClear=1/1 totalFetches=23 totalDerives=23 applies=1 (includes initial)")
        pipeline.cancel()
        feed.stop()
        await store.stopSnapshotProducers()
    }
}