import Foundation
import GRDB
import XCTest
@testable import HappyCore
@testable import HappyStore
import HappyWire

private final class DraftPresenceSQL: @unchecked Sendable {
    private let lock = NSLock()
    private var drafts = 0
    private var homes = 0
    private var textUpdates = 0
    private var updatesPrimaryKey = false
    private var onMain = false

    var counts: (drafts: Int, homes: Int, textUpdates: Int) {
        lock.withLock { (drafts, homes, textUpdates) }
    }
    var hasPrimaryKeyUpdate: Bool { lock.withLock { updatesPrimaryKey } }
    var fetchedOnMain: Bool { lock.withLock { onMain } }

    func trace(_ event: Database.TraceEvent) {
        let sql = event.description.lowercased()
        lock.withLock {
            if sql.contains("select sessionid from draft") {
                drafts += 1
                onMain = onMain || Thread.isMainThread
            }
            if sql.contains("select * from \"session\" order by") { homes += 1 }
            if sql.hasPrefix("update \"draft\" set "), let whereRange = sql.range(of: " where ") {
                textUpdates += 1
                updatesPrimaryKey = updatesPrimaryKey || sql[..<whereRange.lowerBound].contains("sessionid")
            }
        }
    }
}

private final class DraftPresenceValues: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [Set<String>] = []
    var values: [Set<String>] { lock.withLock { kept } }
    func take(_ value: Set<String>) { lock.withLock { kept.append(value) } }
}

private final class HeldDraftCallback: @unchecked Sendable {
    private let lock = NSLock()
    private var armed = false
    let release = DispatchSemaphore(value: 0)
    func arm() { lock.withLock { armed = true } }
    func take() -> Bool { lock.withLock { defer { armed = false }; return armed } }
}

private final class DraftPresenceInputs: @unchecked Sendable {
    private let lock = NSLock()
    private var stamp = -1
    private var hasDraft = false
    private var previousDrafts: Set<String> = []
    private var homeSeen = false
    private var initialRevisions = 0
    private var broadRevisions = 0
    private var narrowRevisions = 0
    private var emptyDerives = 0
    private var stamps: [Int] = []
    private var flips: [Set<String>] = []
    func take(_ input: HomeDerivation.Input) -> Int {
        let stamp = input.snapshot?.sessions.first(where: { $0.id == "session-0000" })?.metadata?["draftUpdatedAt"]?.numberValue ?? -1
        return lock.withLock {
            var consumed = false
            if !homeSeen, input.snapshot != nil {
                consumed = true
                homeSeen = true
                initialRevisions += 1
                stamps.append(Int(stamp))
            } else if Int(stamp) != self.stamp {
                consumed = true
                broadRevisions += 1
                stamps.append(Int(stamp))
            }
            if previousDrafts != input.draftSessionIds {
                consumed = true
                narrowRevisions += 1
                flips.append(input.draftSessionIds)
                previousDrafts = input.draftSessionIds
            }
            if !consumed { emptyDerives += 1 }
            self.stamp = Int(stamp)
            hasDraft = input.draftSessionIds.contains("session-0000")
            return narrowRevisions
        }
    }
    func matches(_ stamp: Int, hasDraft: Bool) -> Bool {
        lock.withLock { self.stamp == stamp && self.hasDraft == hasDraft }
    }
    var state: (stamp: Int, hasDraft: Bool) { lock.withLock { (stamp, hasDraft) } }
    var counts: (initial: Int, broad: Int, narrow: Int, empty: Int) {
        lock.withLock { (initialRevisions, broadRevisions, narrowRevisions, emptyDerives) }
    }
    var consumedStamps: [Int] { lock.withLock { stamps } }
    var consumedFlips: [Set<String>] { lock.withLock { flips } }
}

private struct DraftPresenceDerived: Sendable {
    let update: HomeUpdate
    let ids: Set<String>
    let revision: Int
}

/// A test-only read immediately follows each write on the same serial
/// writer, before this test issues its next write. This quoted oracle SQL
/// is distinct from the production membership SELECT counted above.
private final class DraftPresenceCommits: @unchecked Sendable {
    private let lock = NSLock()
    private var revisions: [Set<String>] = [[]]
    var values: [Set<String>] { lock.withLock { revisions } }
    @discardableResult
    func record(_ store: LocalStore) throws -> Set<String> {
        let ids = try store.writer.read { db in
            Set(try String.fetchAll(db, sql: "SELECT \"sessionId\" AS canonicalDraftId FROM \"draft\""))
        }
        lock.withLock { if revisions.last != ids { revisions.append(ids) } }
        return ids
    }
}

private final class DraftPresenceApplications: @unchecked Sendable {
    private let lock = NSLock()
    private var applied: [DraftPresenceDerived] = []
    func take(_ value: DraftPresenceDerived) {
        for row in value.update.content.list?.rows ?? [] {
            if case .flat(.session(let session)) = row {
                XCTAssertEqual(session.hasDraft, value.ids.contains(session.id), "K1: flags use exactly the consumed set")
            }
        }
        lock.withLock {
            XCTAssertGreaterThanOrEqual(value.revision, applied.last?.revision ?? 0, "K2: applied membership revisions never go backwards")
            applied.append(value)
        }
    }
    func assertCommitted(_ commits: DraftPresenceCommits) {
        let committed = commits.values
        for value in lock.withLock({ applied }) {
            guard committed.indices.contains(value.revision) else { return XCTFail("uncommitted revision \(value.revision)") }
            XCTAssertEqual(value.ids, committed[value.revision], "K1: every consumed set is default revision 0 or an actually committed set")
        }
    }
    func assertQuiescent(_ ids: Set<String>) {
        let last = lock.withLock { applied.last }
        guard let last else { return XCTFail("no applied state") }
        let rows = last.update.content.list?.rows.compactMap { row -> SessionRow? in
            if case .flat(.session(let session)) = row { return session }; return nil
        } ?? []
        XCTAssertEqual(Set(rows.filter(\.hasDraft).map(\.id)), ids.intersection(rows.map(\.id)), "K3: persisted draft IDs intersect visible rows")
    }
}

@MainActor
final class DraftPresenceTests: XCTestCase {
    private func pipeline(_ recorder: ApplyPerfRecorder<HomeUpdate>, inputs: DraftPresenceInputs, applications: DraftPresenceApplications) -> ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, DraftPresenceDerived> {
        ApplyPipeline(input: .init(clock: ApplyPerfFixtures.clock), state: .init(), derive: { input, applied in
            let revision = inputs.take(input)
            guard let result = HomeDerivation.derive(input, applied: applied) else { return nil }
            return (DraftPresenceDerived(update: result.output, ids: input.draftSessionIds, revision: revision), result.state)
        }, apply: { value in
            applications.take(value)
            return recorder.take(value.update)
        })
    }

    private func followDrafts(_ pipeline: ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, DraftPresenceDerived>, _ stream: AsyncStream<Set<String>>) -> DraftPresenceValues {
        let seen = DraftPresenceValues()
        let observed = AsyncStream<Set<String>> { continuation in
            let task = Task.detached {
                for await ids in stream { seen.take(ids); continuation.yield(ids) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        pipeline.follow(ifChanged: observed) { input, ids in
            guard input.draftSessionIds != ids else { return false }
            input.draftSessionIds = ids
            return true
        }
        return seen
    }

    private func store(_ counter: DraftPresenceSQL = DraftPresenceSQL()) async throws -> LocalStore {
        try await Task.detached {
            var configuration = Configuration()
            configuration.prepareDatabase { db in db.trace { counter.trace($0) } }
            let store = try LocalStore(writer: DatabaseQueue(configuration: configuration))
            try store.replaceMachines([ApplyPerfFixtures.machine])
            try store.upsertSessions((0..<3).map(ApplyPerfFixtures.session))
            return store
        }.value
    }

    func testUnsubscribedDraftObservationPerformsNoQueriesEvenWhenDraftsChange() async throws {
        let counter = DraftPresenceSQL()
        let store = try await store(counter)
        let feed = HomeFeed(store: store)
        try await Task.detached {
            try store.saveDraft(sessionId: "session-0000", text: "first", at: 1)
            for index in 1...100 {
                try store.saveDraft(sessionId: "session-0000", text: "edit \(index)", at: Int64(index + 1))
            }
            try store.saveDraft(sessionId: "session-0000", text: "", at: 102)
            _ = try store.writer.read { db in try Int.fetchOne(db, sql: "SELECT 1") }
        }.value
        XCTAssertEqual(counter.counts.drafts, 0, "creating the account feed does not start its shared observation")
        XCTAssertEqual(counter.counts.homes, 0)
        feed.stop()
        await store.stopSnapshotProducers()
    }

    func testSevenSubscribersShareOneQueryAnd100TextEditsDoNotQueryPublishOrDerive() async throws {
        let counter = DraftPresenceSQL()
        let store = try await store(counter)
        let feed = HomeFeed(store: store)
        let homeStream = feed.snapshots()
        let homeValue = try await syncPerfNext(homeStream)
        let home = try XCTUnwrap(homeValue)
        let streams = (0..<7).map { _ in feed.draftSessions() }
        for stream in streams {
            let initial = try await syncPerfNext(stream)
            XCTAssertEqual(initial, [])
        }
        let values = DraftPresenceValues()
        let observer = store.draftSessionsObservation.start(onError: { XCTFail("\($0)") }, onChange: { values.take($0) })
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let inputs = DraftPresenceInputs(), applications = DraftPresenceApplications(), commits = DraftPresenceCommits()
        let pipeline = pipeline(recorder, inputs: inputs, applications: applications)
        let draftFeed = followDrafts(pipeline, feed.draftSessions())
        pipeline.update { $0.snapshot = home }
        await applyPerfWait { recorder.outputs.count == 1 && draftFeed.values.first != nil }
        XCTAssertEqual(counter.counts.drafts, 1)
        XCTAssertEqual(counter.counts.homes, 1)
        XCTAssertEqual(values.values, [[]])
        applications.assertQuiescent([])

        try await Task.detached {
            try store.saveDraft(sessionId: "session-0000", text: "a", at: 1)
            try commits.record(store)
        }.value
        let first = try await syncPerfNext(streams[0])
        XCTAssertEqual(first, ["session-0000"])
        await applyPerfWait { recorder.outputs.count == 2 }
        let beforeEdits = pipeline.counts
        XCTAssertEqual(beforeEdits.derivations, 2, "initial and first membership flip")
        XCTAssertEqual(recorder.outputs.last?.changeset, RowChangeset(reconfigures: [0]))
        applications.assertQuiescent(commits.values.last!)
        try await Task.detached {
            let region = try store.writer.read { db in
                try SQLRequest<Row>(sql: "SELECT sessionId FROM draft").databaseRegion(db)
            }
            XCTAssertFalse(region.isModified(byEventsOfKind: .update(tableName: "draft", columnNames: ["text", "updatedAt"])))
            for index in 1...100 {
                try store.saveDraft(sessionId: "session-0000", text: "edit \(index)", at: Int64(index + 1))
                try commits.record(store)
            }
        }.value
        // The last-character deletion is a real membership fence through
        // that same observer, hub and pipeline, not a sleep after the edits.
        try await Task.detached {
            try store.saveDraft(sessionId: "session-0000", text: "", at: 102)
            try commits.record(store)
        }.value
        let cleared = try await syncPerfNext(streams[0])
        XCTAssertEqual(cleared, [])
        await applyPerfWait { recorder.outputs.count == 3 }
        XCTAssertEqual(counter.counts.drafts, 3, "initial, first character, last character; no SELECT per edit")
        XCTAssertEqual(counter.counts.homes, 1, "draft changes never refetch the session snapshot")
        XCTAssertEqual(counter.counts.textUpdates, 101, "100 edits plus GRDB's initial UPDATE miss before INSERT")
        XCTAssertFalse(counter.hasPrimaryKeyUpdate, "the actual GRDB save SQL excludes sessionId from SET")
        XCTAssertFalse(counter.fetchedOnMain)
        XCTAssertEqual(values.values, [[], ["session-0000"], []])
        XCTAssertEqual(pipeline.counts.derivations, beforeEdits.derivations + 1, "only membership clear derives after 100 edits")
        XCTAssertEqual(pipeline.counts.applies, beforeEdits.applies + 1)
        XCTAssertEqual(recorder.outputs.last?.changeset, RowChangeset(reconfigures: [0]))
        XCTAssertEqual(inputs.counts.empty, 0)
        XCTAssertEqual(draftFeed.values, [[], ["session-0000"], []], "one default-equal initial suppression; text-only commits emit no duplicate set")
        applications.assertCommitted(commits)
        applications.assertQuiescent(commits.values.last!)
        pipeline.cancel()
        observer.cancel()
        feed.stop()
        await store.stopSnapshotProducers()
    }

    func testLocalRigAndRemoteRigUseTheSameMembershipWithoutTextRefetches() async throws {
        let counter = DraftPresenceSQL()
        let store = try await store(counter)
        let stream = HomeFeed(store: store).draftSessions()
        let initial = try await syncPerfNext(stream)
        XCTAssertEqual(initial, [])
        let values = DraftPresenceValues()
        let observer = store.draftSessionsObservation.start(onError: { XCTFail("\($0)") }, onChange: { values.take($0) })
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let inputs = DraftPresenceInputs(), applications = DraftPresenceApplications(), commits = DraftPresenceCommits()
        let pipeline = pipeline(recorder, inputs: inputs, applications: applications)
        let draftFeed = followDrafts(pipeline, HomeFeed(store: store).draftSessions())
        pipeline.update { $0.snapshot = ApplyPerfFixtures.snapshot(3) }
        await applyPerfWait { recorder.outputs.count == 1 && draftFeed.values.first != nil }
        applications.assertQuiescent([])
        try await Task.detached {
            for index in 1...20 {
                try store.saveComposerState(ComposerStateRecord(sessionId: "session-0000", values: .object(["pick": .number(Double(index))])))
                try commits.record(store)
            }
        }.value
        applications.assertQuiescent(commits.values.last!)
        try await Task.detached {
            try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: "local", at: 1)
            try commits.record(store)
        }.value
        let local = try await syncPerfNext(stream)
        XCTAssertEqual(local, ["session-0000"])
        await applyPerfWait { recorder.outputs.count == 2 }
        let localDerivations = pipeline.counts.derivations
        XCTAssertEqual(localDerivations, 2, "composer-state writes add no derivation")
        applications.assertQuiescent(commits.values.last!)
        try await Task.detached {
            for index in 2...21 {
                try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: "local \(index)", at: Int64(index))
                try commits.record(store)
            }
            try store.saveRigComposer(ComposerStateRecord(sessionId: "session-0000"), text: nil, at: 22)
            try commits.record(store)
        }.value
        let cleared = try await syncPerfNext(stream)
        XCTAssertEqual(cleared, [])
        await applyPerfWait { recorder.outputs.count == 3 }
        XCTAssertEqual(counter.counts.drafts, 3)
        XCTAssertEqual(values.values, [[], ["session-0000"], []])
        XCTAssertEqual(pipeline.counts.derivations, localDerivations + 1, "composer picks and existing local Rig text add no draft-feed derivation")
        applications.assertQuiescent(commits.values.last!)
        try await Task.detached {
            var session = ApplyPerfFixtures.session(1)
            session.metadataVersion = 2
            session.metadata = .object(["client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
                "draftUpdatedAt": .number(1), "draft": .object(["text": .string("remote")])])
            try store.upsertSessions([session], reconcileComposer: SessionModePushCounters().reconciliation)
            try commits.record(store)
        }.value
        let remote = try await syncPerfNext(stream)
        XCTAssertEqual(remote, ["session-0001"])
        await applyPerfWait { recorder.outputs.count == 4 }
        let remoteDerivations = pipeline.counts.derivations
        XCTAssertEqual(remoteDerivations, 4, "initial, local insert/clear, remote insert")
        applications.assertQuiescent(commits.values.last!)
        try await Task.detached {
            let reconciliation = SessionModePushCounters().reconciliation
            for stamp in 2...21 {
                _ = try store.applySessionUpdate(id: "session-0001", metadata: .init(version: stamp + 1, cipher: "remote-\(stamp)", value: .object([
                    "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
                    "draftUpdatedAt": .number(Double(stamp)), "draft": .object(["text": .string("remote \(stamp)")])
                ])), agentState: nil, projectId: nil, reconcileComposer: reconciliation)
                try commits.record(store)
            }
            _ = try store.applySessionUpdate(id: "session-0001", metadata: .init(version: 23, cipher: "remote-clear", value: .object([
                "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
                "draftUpdatedAt": .number(22), "draft": .null
            ])), agentState: nil, projectId: nil, reconcileComposer: reconciliation)
            try commits.record(store)
        }.value
        let remoteCleared = try await syncPerfNext(stream)
        XCTAssertEqual(remoteCleared, [])
        await applyPerfWait { recorder.outputs.count == 5 }
        XCTAssertEqual(counter.counts.drafts, 5, "both local and remote inserts/deletes, no text-only membership query")
        XCTAssertEqual(values.values, [[], ["session-0000"], [], ["session-0001"], []])
        XCTAssertEqual(pipeline.counts.derivations, remoteDerivations + 1, "existing remote Rig text adds no draft-feed derivation")
        XCTAssertEqual(counter.counts.textUpdates, 42, "40 edits plus two initial UPDATE misses before INSERT")
        XCTAssertFalse(counter.hasPrimaryKeyUpdate)
        XCTAssertFalse(counter.fetchedOnMain)
        XCTAssertEqual(inputs.counts.empty, 0)
        XCTAssertEqual(draftFeed.values, [[], ["session-0000"], [], ["session-0001"], []])
        applications.assertCommitted(commits)
        applications.assertQuiescent(commits.values.last!)
        pipeline.cancel()
        observer.cancel()
        await store.stopSnapshotProducers()
    }

    func testLateSharedCallbackCannotPublishAfterTheHubStopsOrCancelItsRestart() async throws {
        let store = try await store()
        let held = HeldDraftCallback()
        let callbackHeld = expectation(description: "GRDB callback held")
        let observer = store.draftSessionsObservation.start(onError: { XCTFail("\($0)") }, onChange: { _ in
            if held.take() {
                callbackHeld.fulfill()
                _ = held.release.wait(timeout: .now() + 5)
            }
        })
        let hubStream = store.draftSessionIdsSnapshots()
        let hubInitial = expectation(description: "hub initial")
        let hubFinished = expectation(description: "hub stopped before late callback released")
        let values = DraftPresenceValues()
        let consumer = Task {
            for await value in hubStream { values.take(value); hubInitial.fulfill() }
            hubFinished.fulfill()
        }
        await fulfillment(of: [hubInitial], timeout: 5)
        held.arm()
        try await Task.detached { try store.saveDraft(sessionId: "session-0000", text: "held", at: 1) }.value
        await fulfillment(of: [callbackHeld], timeout: 5)
        let stopping = Task { await store.stopSnapshotProducers() }
        await fulfillment(of: [hubFinished], timeout: 5)
        held.release.signal()
        await stopping.value
        await consumer.value
        XCTAssertEqual(values.values, [[]], "the already running callback is refused after the stopped generation")
        let restarted = HomeFeed(store: store)
        let stream = restarted.draftSessions()
        let first = try await syncPerfNext(stream)
        XCTAssertEqual(first, ["session-0000"])
        try await Task.detached { try store.saveDraft(sessionId: "session-0000", text: "", at: 2) }.value
        let next = try await syncPerfNext(stream)
        XCTAssertEqual(next, [])
        observer.cancel()
        restarted.stop()
        await store.stopSnapshotProducers()
    }

    func testRemoteMembershipAndMetadataFeedsApplyEachGlyphFlipOnce() async throws {
        let counter = DraftPresenceSQL()
        let store = try await store(counter)
        let metadata: [String: JSONValue] = [
            "client": .object(["id": .string("rig")]), "rigMetadataVersion": .number(1),
            "machineId": .string("computer"), "path": .string("/work/project"),
            "summary": .object(["text": .string("Session 0")]),
            "lastMeaningfulMessageAt": .number(Double(ApplyPerfFixtures.now)),
            "draftUpdatedAt": .number(0), "draft": .null,
        ]
        try await Task.detached {
            var row = ApplyPerfFixtures.session(0)
            row.metadataVersion = 2
            row.metadata = .object(metadata)
            try store.upsertSessions([row])
        }.value
        let feed = HomeFeed(store: store)
        let inputs = DraftPresenceInputs()
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let applications = DraftPresenceApplications(), commits = DraftPresenceCommits()
        let pipeline = pipeline(recorder, inputs: inputs, applications: applications)
        pipeline.follow(feed.snapshots()) { $0.snapshot = $1 }
        let draftFeed = followDrafts(pipeline, feed.draftSessions())
        await applyPerfWait { inputs.matches(0, hasDraft: false) && recorder.outputs.count == 1 && draftFeed.values.first != nil }
        guard inputs.matches(0, hasDraft: false), recorder.outputs.count == 1 else {
            return XCTFail("initial inputs \(inputs.state), applies \(recorder.outputs.count)")
        }
        for stamp in 1...22 {
            try await Task.detached {
                var fields = metadata
                fields["draftUpdatedAt"] = .number(Double(stamp))
                fields["draft"] = stamp == 22 ? .null : .object(["text": .string("remote \(stamp)")])
                _ = try store.applySessionUpdate(id: "session-0000",
                    metadata: .init(version: stamp + 2, cipher: "remote-\(stamp)", value: .object(fields)),
                    agentState: nil, projectId: nil, reconcileComposer: SessionModePushCounters().reconciliation)
                try commits.record(store)
            }.value
            let expectedApplies = stamp == 22 ? 3 : 2
            await applyPerfWait { inputs.matches(stamp, hasDraft: stamp != 22) && recorder.outputs.count == expectedApplies }
            guard inputs.matches(stamp, hasDraft: stamp != 22), recorder.outputs.count == expectedApplies else {
                return XCTFail("stamp \(stamp), inputs \(inputs.state), applies \(recorder.outputs.count)")
            }
            XCTAssertEqual(recorder.outputs.count, expectedApplies)
            applications.assertQuiescent(commits.values.last!)
        }
        XCTAssertEqual(counter.counts.drafts, 3)
        XCTAssertEqual(counter.counts.homes, 23)
        XCTAssertEqual(inputs.counts.initial, 1, "Home's initial snapshot; the default-equal empty set is suppressed")
        XCTAssertEqual(inputs.counts.broad, 22)
        XCTAssertEqual(inputs.counts.narrow, 2)
        XCTAssertEqual(inputs.counts.empty, 0)
        XCTAssertEqual(inputs.consumedStamps, Array(0...22), "each metadata revision is consumed exactly once")
        XCTAssertEqual(inputs.consumedFlips, [["session-0000"], []], "each membership flip is consumed exactly once")
        XCTAssertEqual(recorder.outputs[1].changeset, RowChangeset(reconfigures: [0]))
        XCTAssertEqual(recorder.outputs[2].changeset, RowChangeset(reconfigures: [0]))
        guard case .flat(.session(let inserted))? = recorder.outputs[1].content.list?.rows[0],
              case .flat(.session(let cleared))? = recorder.outputs[2].content.list?.rows[0] else { return XCTFail("draft row") }
        XCTAssertTrue(inserted.hasDraft)
        XCTAssertFalse(cleared.hasDraft)
        applications.assertCommitted(commits)
        XCTAssertEqual(draftFeed.values, [[], ["session-0000"], []])
        let initialSuppression = draftFeed.values.first?.isEmpty == true ? 1 : 0
        XCTAssertEqual(initialSuppression, 1, "the stream is ready; its default-equal first value is suppressed by the adapter")
        XCTAssertLessThanOrEqual(pipeline.counts.wakeups, pipeline.counts.derivations)
        print("DRAFT_PRESENCE_COALESCING insert_applies=1 clear_applies=1 narrow_queries=\(counter.counts.drafts) broad_queries=\(counter.counts.homes) initial_revisions=\(inputs.counts.initial) broad_revisions=\(inputs.counts.broad) narrow_revisions=\(inputs.counts.narrow) empty_derives=\(inputs.counts.empty) derives=\(pipeline.counts.derivations) stream_initial_suppressions=\(initialSuppression) pipeline_wakeups=\(pipeline.counts.wakeups) (a combined derive consumes both revisions)")
        pipeline.cancel()
        feed.stop()
        await store.stopSnapshotProducers()
    }

    func testSessionReconciliationRetainsUnsentTextAndAccountEraseClearsMembership() async throws {
        for route in 0..<3 {
            let store = try await store()
            try await Task.detached {
                try store.saveDraft(sessionId: "session-0000", text: "unsent", at: 1)
            }.value
            let stream = HomeFeed(store: store).draftSessions()
            let first = try await syncPerfNext(stream)
            XCTAssertEqual(first, ["session-0000"])
            try await Task.detached {
                switch route {
                case 0: try store.deleteSession(id: "session-0000")
                case 1: _ = try store.retainSessions(ids: ["session-0001", "session-0002"], updatedAtOrBefore: Int64.max)
                default: try store.applySessionListBatch([], checkpoint: .init(changedSince: Int64.max, fullIDs: ["session-0001", "session-0002"]))
                }
                XCTAssertEqual(try store.draft(sessionId: "session-0000")?.text, "unsent")
                XCTAssertEqual(try store.draftSessionIdsSnapshot(), ["session-0000"])
                try store.upsertSessions([ApplyPerfFixtures.session(0)])
                XCTAssertEqual(try store.draft(sessionId: "session-0000")?.text, "unsent", "a missing server row may return")
                try store.eraseAll()
            }.value
            let next = try await syncPerfNext(stream)
            XCTAssertEqual(next, [])
            await store.stopSnapshotProducers()
        }
    }

    func testAccountStopClosesBothHomeStreamsAndRestartReadsCurrentMembership() async throws {
        func account(_ seed: UInt8) async throws -> AccountSession {
            try await Task.detached {
                try AccountSession(credentials: Credentials(token: "account", secret: Data(repeating: seed, count: 32)),
                    store: LocalStore.inMemory(), dependencies: .init(serverURL: URL(string: "https://test.invalid")!,
                    clientID: "ios/test", transport: FakeHTTP(), connector: FakeConnector()))
            }.value
        }
        let first = try await account(31), other = try await account(32)
        let oldDrafts = first.homeFeed.draftSessions(), oldHome = first.homeFeed.snapshots()
        let otherDrafts = other.homeFeed.draftSessions()
        _ = try await syncPerfNext(oldDrafts)
        _ = try await syncPerfNext(oldHome)
        _ = try await syncPerfNext(otherDrafts)
        try await Task.detached { try other.store.saveDraft(sessionId: "same-id", text: "other", at: 1) }.value
        let otherValue = try await syncPerfNext(otherDrafts)
        XCTAssertEqual(otherValue, ["same-id"])
        await first.stop()
        try await Task.detached { try first.store.saveDraft(sessionId: "same-id", text: "late first", at: 2) }.value
        let oldNext = try await syncPerfNext(oldDrafts), oldHomeNext = try await syncPerfNext(oldHome)
        let stoppedNext = try await syncPerfNext(first.homeFeed.draftSessions())
        XCTAssertNil(oldNext)
        XCTAssertNil(oldHomeNext)
        XCTAssertNil(stoppedNext)
        let restarted = HomeFeed(store: first.store)
        let restartedStream = restarted.draftSessions()
        let restartedValue = try await syncPerfNext(restartedStream)
        XCTAssertEqual(restartedValue, ["same-id"], "fresh account scope reads disk after the old producer stopped")
        try await Task.detached { try first.store.eraseAll() }.value
        let erased = try await syncPerfNext(restartedStream)
        XCTAssertEqual(erased, [])
        let otherStillPresent = try await Task.detached { try other.store.draftSessionIdsSnapshot() }.value
        XCTAssertEqual(otherStillPresent, ["same-id"])
        restarted.stop()
        await first.store.stopSnapshotProducers()
        await other.stop()
    }
}

final class DraftPresenceRowTests: XCTestCase {
    func testHomeFlatMembershipReconfiguresOnlyItsRowAndNeverChangesOrderOrDock() throws {
        let snapshot = ApplyPerfFixtures.snapshot(50)
        var input = HomeDerivation.Input(snapshot: snapshot, includesDock: true, clock: ApplyPerfFixtures.clock)
        let first = try XCTUnwrap(HomeDerivation.derive(input, applied: .init()))
        input.draftSessionIds = ["session-0020", "not-in-list"]
        let added = try XCTUnwrap(HomeDerivation.derive(input, applied: first.state))
        XCTAssertEqual(added.output.changeset, RowChangeset(reconfigures: [20]))
        XCTAssertNil(added.output.dock)
        XCTAssertFalse(added.output.kindChanged)
        XCTAssertEqual(added.state.content?.list?.ids, first.state.content?.list?.ids)
        guard case .flat(.session(let row))? = added.state.content?.list?.rows[20] else { return XCTFail("flat row") }
        XCTAssertTrue(row.hasDraft)
        XCTAssertNil(HomeDerivation.derive(input, applied: added.state))
        input.draftSessionIds = []
        let cleared = try XCTUnwrap(HomeDerivation.derive(input, applied: added.state))
        XCTAssertEqual(cleared.output.changeset, RowChangeset(reconfigures: [20]))
        XCTAssertEqual(cleared.state, first.state)
    }

    func testPhoneProjectBotsAndArchiveIgnoreDraftMembershipTheyDoNotRender() throws {
        let snapshot = TabletGroupedListTests.snapshot()
        var input = HomeDerivation.Input(snapshot: snapshot, clock: ApplyPerfFixtures.clock)
        let first = try XCTUnwrap(HomeDerivation.derive(input, applied: .init()))
        let rows = try XCTUnwrap(first.state.content?.list?.rows)
        XCTAssertTrue(rows.contains { if case .project(.bot) = $0 { return true }; return false })
        XCTAssertTrue(rows.contains { if case .project(.archived) = $0 { return true }; return false })
        input.draftSessionIds = ["b1", "a1", "a2"]
        XCTAssertNil(HomeDerivation.derive(input, applied: first.state), "no apply or reconfigure for an unrendered draft flag")
    }

    func testTabletFlatAndGroupedOnlyReconfigureTheRenderedDraftRow() throws {
        for grouped in [false, true] {
            let snapshot = TabletGroupedListTests.snapshot(grouping: grouped ? "project" : "flat")
            let ids: Set<String> = grouped ? ["b1", "s1", "a1"] : ["s1"]
            var input = TabletSidebarInput(snapshot: snapshot)
            let first = try XCTUnwrap(TabletSidebarDerivation.derive(input, applied: .init(), clock: ApplyPerfFixtures.clock))
            input.draftSessionIds = ids
            let changed = try XCTUnwrap(TabletSidebarDerivation.derive(input, applied: first.state, clock: ApplyPerfFixtures.clock))
            let expected: [Int]
            if grouped {
                let rows = try XCTUnwrap(changed.state.grouped?.rows)
                expected = rows.indices.filter { rows[$0].sessionId.map(ids.contains) == true }
                for row in rows {
                    switch row {
                    case .bot(let row) where row.id == "b1": XCTAssertTrue(row.hasDraft)
                    case .chat(let row) where row.id == "s1": XCTAssertTrue(row.hasDraft)
                    case .archived(let row) where row.id == "a1": XCTAssertTrue(row.hasDraft)
                    default: break
                    }
                }
            } else {
                let rows = try XCTUnwrap(changed.state.list?.rows)
                expected = rows.indices.filter { rows[$0].sessionId.map(ids.contains) == true }
            }
            XCTAssertEqual(changed.output.changeset, RowChangeset(reconfigures: expected))
            input.draftSessionIds = []
            let cleared = try XCTUnwrap(TabletSidebarDerivation.derive(input, applied: changed.state, clock: ApplyPerfFixtures.clock))
            XCTAssertEqual(cleared.output.changeset, RowChangeset(reconfigures: expected))
            XCTAssertEqual(cleared.state, first.state)
        }
    }

    func testTabletThinkingUnreadAndDisconnectedChatDraftsProduceNoApply() throws {
        for mode in ["thinking", "unread", "disconnected"] {
            var snapshot = TabletGroupedListTests.snapshot()
            let index = try XCTUnwrap(snapshot.sessions.firstIndex { $0.id == "s1" })
            if mode == "thinking" { snapshot.sessions[index].thinking = true }
            if mode == "unread" { snapshot.sessions[index].unread = true }
            if mode == "disconnected" {
                snapshot.sessions[index].active = false
                var fields = snapshot.sessions[index].metadata?.objectValue ?? [:]
                fields["client"] = .object(["id": .string("rig")])
                snapshot.sessions[index].metadata = .object(fields)
            }
            var input = TabletSidebarInput(snapshot: snapshot)
            let first = try XCTUnwrap(TabletSidebarDerivation.derive(input, applied: .init(), clock: ApplyPerfFixtures.clock))
            input.draftSessionIds = ["s1"]
            XCTAssertNil(TabletSidebarDerivation.derive(input, applied: first.state, clock: ApplyPerfFixtures.clock), mode)
            input.draftSessionIds = []
            XCTAssertNil(TabletSidebarDerivation.derive(input, applied: first.state, clock: ApplyPerfFixtures.clock), mode)
        }
    }
}