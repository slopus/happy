import Foundation
import GRDB
import XCTest
@testable import HappyCore
import HappyStore

private final class ConditionalFeedProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var seen = 0
    var count: Int { lock.withLock { seen } }
    // Test-only acknowledgement, without re-entering the pipeline.
    func take() { lock.withLock { seen += 1 } }
}

private final class HeldHomeInputs: @unchecked Sendable {
    private let lock = NSLock()
    private var home: HomeSnapshot?
    private var drafts: Set<String> = []
    private var revision = 0
    private var empty = 0
    private var calls = 0
    var counts: (calls: Int, empty: Int, revision: Int) { lock.withLock { (calls, empty, revision) } }
    func take(_ input: HomeDerivation.Input) -> Int {
        lock.withLock {
            calls += 1
            if home == input.snapshot, drafts == input.draftSessionIds { empty += 1 }
            home = input.snapshot
            if drafts != input.draftSessionIds { revision += 1; drafts = input.draftSessionIds }
            return revision
        }
    }
}

private struct HeldHomeUpdate: Sendable {
    let update: HomeUpdate
    let ids: Set<String>
    let revision: Int
}

@MainActor
final class ApplyPipelineFeedTests: XCTestCase {
    func testConditionalFollowIgnoresEqualValuesAndSchedulesOneChangedValue() async {
        let channel = AsyncStream<Int>.makeStream()
        let seen = ConditionalFeedProbe()
        let recorder = ApplyPerfRecorder<Int>()
        let pipeline = ApplyPipeline<Int, Int, Int>(input: 0, state: 42,
            derive: { value, _ in (value, value) }, apply: { recorder.take($0) })
        pipeline.follow(ifChanged: channel.stream) { input, value in
            seen.take()
            guard input != value else { return false }
            input = value
            return true
        }
        channel.continuation.yield(0)
        channel.continuation.yield(0)
        await applyPerfWait { seen.count == 2 }
        XCTAssertEqual(pipeline.counts.wakeups, 0, "E2: equal values do not wake the worker")
        XCTAssertEqual(pipeline.counts.derivations, 0)
        XCTAssertEqual(pipeline.counts.applies, 0)
        XCTAssertEqual(pipeline.applied, 42)
        channel.continuation.yield(1)
        await applyPerfWait { recorder.outputs == [1] && pipeline.counts.applies == 1 }
        channel.continuation.yield(1)
        await applyPerfWait { seen.count == 4 }
        XCTAssertEqual(pipeline.counts.wakeups, 1)
        XCTAssertEqual(pipeline.counts.derivations, 1)
        XCTAssertEqual(pipeline.counts.applies, 1)
        XCTAssertEqual(pipeline.applied, 1)
        channel.continuation.finish()
        pipeline.cancel()
    }

    func testConditionalFollowFinishBeforeFirstValueAndCancellationDoNotScheduleWork() async {
        let ended = AsyncStream<Int>.makeStream()
        ended.continuation.finish()
        let pipeline = ApplyPipeline<Int, Int, Int>(input: 0, state: 0,
            derive: { value, _ in (value, value) }, apply: { _ in XCTFail("unexpected apply"); return true })
        pipeline.follow(ifChanged: ended.stream) { input, value in
            guard input != value else { return false }; input = value; return true
        }
        XCTAssertEqual(pipeline.counts.wakeups, 0)
        XCTAssertEqual(pipeline.counts.derivations, 0)
        let cancelled = AsyncStream<Int>.makeStream()
        let finished = expectation(description: "cancelled stream finished")
        cancelled.continuation.onTermination = { _ in finished.fulfill() }
        pipeline.follow(ifChanged: cancelled.stream) { input, value in
            guard input != value else { return false }; input = value; return true
        }
        pipeline.cancel()
        await fulfillment(of: [finished], timeout: 5)
        if case .terminated = cancelled.continuation.yield(1) {} else { XCTFail("stream still open") }
        XCTAssertEqual(pipeline.counts.wakeups, 0)
        XCTAssertEqual(pipeline.counts.derivations, 0)
        XCTAssertEqual(pipeline.counts.applies, 0)
    }

    func testExistingVoidFollowStillDerivesEqualValues() async {
        let channel = AsyncStream<Int>.makeStream()
        let recorder = ApplyPerfRecorder<Int>()
        let pipeline = ApplyPipeline<Int, Int, Int>(input: 0, state: 0,
            derive: { value, _ in (value, value) }, apply: { recorder.take($0) })
        pipeline.follow(channel.stream) { $0 = $1 }
        channel.continuation.yield(0)
        await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
        channel.continuation.yield(0)
        await applyPerfWait { recorder.outputs.count == 2 && pipeline.counts.applies == 2 }
        XCTAssertEqual(pipeline.counts.derivations, 2)
        XCTAssertEqual(pipeline.counts.applies, 2)
        // ApplyPipeline.swift:128 reuses a running worker. After :216's
        // delivery, the second value can arrive before or after :196-204's
        // final dirty check, so worker starts vary while work stays exact.
        XCTAssertGreaterThanOrEqual(pipeline.counts.wakeups, 1)
        XCTAssertLessThanOrEqual(pipeline.counts.wakeups, 2)
        channel.continuation.finish()
        pipeline.cancel()
    }

    private func heldPipeline(
        recorder: ApplyPerfRecorder<HeldHomeUpdate>, inputs: HeldHomeInputs,
        committed: Set<String> = [],
        hold: (@Sendable () -> Void)? = nil
    ) -> ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HeldHomeUpdate> {
        ApplyPipeline(input: .init(clock: ApplyPerfFixtures.clock), state: .init(), derive: { input, state in
            let revision = inputs.take(input)
            hold?()
            guard let result = HomeDerivation.derive(input, applied: state) else { return nil }
            return (HeldHomeUpdate(update: result.output, ids: input.draftSessionIds, revision: revision), result.state)
        }, apply: { value in
            XCTAssertEqual(value.ids, value.revision == 0 ? [] : committed, "K1: default or committed set")
            for row in value.update.content.list?.rows ?? [] {
                if case .flat(.session(let session)) = row {
                    XCTAssertEqual(session.hasDraft, value.ids.contains(session.id), "K1")
                }
            }
            XCTAssertGreaterThanOrEqual(value.revision, recorder.outputs.last?.revision ?? 0, "K2")
            return recorder.take(value)
        })
    }

    private func committedDrafts() async throws -> Set<String> {
        try await Task.detached {
            let store = try LocalStore.inMemory()
            try store.saveDraft(sessionId: "session-0000", text: "persisted", at: 1)
            return try store.writer.read { db in
                Set(try String.fetchAll(db, sql: "SELECT \"sessionId\" FROM \"draft\""))
            }
        }.value
    }

    private func assertQuiescent(_ recorder: ApplyPerfRecorder<HeldHomeUpdate>, committed: Set<String>) {
        guard let last = recorder.outputs.last else { return XCTFail("no apply") }
        let rows = last.update.content.list?.rows.compactMap { row -> SessionRow? in
            if case .flat(.session(let session)) = row { return session }; return nil
        } ?? []
        XCTAssertEqual(Set(rows.filter(\.hasDraft).map(\.id)), committed.intersection(rows.map(\.id)), "K3")
    }

    private func follow(
        _ channel: AsyncStream<Set<String>>,
        pipeline: ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HeldHomeUpdate>,
        seen: ConditionalFeedProbe
    ) {
        pipeline.follow(ifChanged: channel) { input, value in
            seen.take()
            guard input.draftSessionIds != value else { return false }
            input.draftSessionIds = value
            return true
        }
    }

    func testHeldInitialEmptySetBeforeAndAfterHomeCreatesNoExtraDerivation() async {
        for homeFirst in [false, true] {
            let home = AsyncStream<HomeSnapshot>.makeStream()
            let drafts = AsyncStream<Set<String>>.makeStream()
            let seen = ConditionalFeedProbe(), inputs = HeldHomeInputs()
            let recorder = ApplyPerfRecorder<HeldHomeUpdate>()
            let pipeline = heldPipeline(recorder: recorder, inputs: inputs)
            pipeline.follow(home.stream) { $0.snapshot = $1 }
            follow(drafts.stream, pipeline: pipeline, seen: seen)
            if homeFirst {
                home.continuation.yield(ApplyPerfFixtures.snapshot(3))
                await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
            }
            let before = pipeline.counts
            drafts.continuation.yield([])
            await applyPerfWait { seen.count == 1 }
            XCTAssertEqual(pipeline.counts, before, "E2: initial empty is consumed by the stream but leaves the pipeline untouched")
            if !homeFirst { home.continuation.yield(ApplyPerfFixtures.snapshot(3)) }
            await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
            drafts.continuation.yield([])
            await applyPerfWait { seen.count == 2 }
            XCTAssertEqual(pipeline.counts.derivations, 1)
            XCTAssertEqual(pipeline.counts.wakeups, 1)
            XCTAssertEqual(inputs.counts.empty, 0, "E1")
            XCTAssertEqual(inputs.counts.revision, 0)
            XCTAssertEqual(recorder.outputs[0].ids, [])
            assertQuiescent(recorder, committed: [])
            print("DRAFT_PRESENCE_HELD home_first=\(homeFirst) initial_empty_stream_suppressions=1 extra_derives=0 extra_wakeups=0")
            home.continuation.finish(); drafts.continuation.finish(); pipeline.cancel()
        }
    }

    func testHeldNonemptySetBeforeHomeIsConsumedOnceAndFirstApplyAlreadyHasDraft() async throws {
        let committed = try await committedDrafts()
        let home = AsyncStream<HomeSnapshot>.makeStream()
        let drafts = AsyncStream<Set<String>>.makeStream()
        let seen = ConditionalFeedProbe(), inputs = HeldHomeInputs()
        let recorder = ApplyPerfRecorder<HeldHomeUpdate>()
        let pipeline = heldPipeline(recorder: recorder, inputs: inputs, committed: committed)
        pipeline.follow(home.stream) { $0.snapshot = $1 }
        follow(drafts.stream, pipeline: pipeline, seen: seen)
        drafts.continuation.yield(committed)
        await applyPerfWait { inputs.counts.calls == 1 && pipeline.counts.derivations == 1 }
        XCTAssertEqual(recorder.outputs.count, 0)
        home.continuation.yield(ApplyPerfFixtures.snapshot(3))
        await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
        XCTAssertEqual(recorder.outputs[0].ids, ["session-0000"])
        XCTAssertEqual(inputs.counts.revision, 1)
        XCTAssertEqual(inputs.counts.empty, 0)
        XCTAssertEqual(pipeline.counts.derivations, 2)
        XCTAssertEqual(seen.count, 1)
        assertQuiescent(recorder, committed: committed)
        home.continuation.finish(); drafts.continuation.finish(); pipeline.cancel()
    }

    func testHeldNonemptySetAfterHomeInitialApplyFlipsExactlyOnce() async throws {
        let committed = try await committedDrafts()
        let home = AsyncStream<HomeSnapshot>.makeStream()
        let drafts = AsyncStream<Set<String>>.makeStream()
        let seen = ConditionalFeedProbe(), inputs = HeldHomeInputs()
        let recorder = ApplyPerfRecorder<HeldHomeUpdate>()
        let pipeline = heldPipeline(recorder: recorder, inputs: inputs, committed: committed)
        pipeline.follow(home.stream) { $0.snapshot = $1 }
        follow(drafts.stream, pipeline: pipeline, seen: seen)
        home.continuation.yield(ApplyPerfFixtures.snapshot(3))
        await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
        XCTAssertEqual(recorder.outputs[0].ids, [], "the input default is valid before first set delivery")
        drafts.continuation.yield(committed)
        await applyPerfWait { recorder.outputs.count == 2 && pipeline.counts.applies == 2 }
        XCTAssertEqual(recorder.outputs[1].ids, ["session-0000"])
        XCTAssertEqual(recorder.outputs[1].update.changeset, RowChangeset(reconfigures: [0]))
        XCTAssertEqual(inputs.counts.revision, 1)
        XCTAssertEqual(inputs.counts.empty, 0)
        XCTAssertEqual(pipeline.counts.derivations, 2)
        XCTAssertEqual(seen.count, 1)
        assertQuiescent(recorder, committed: committed)
        home.continuation.finish(); drafts.continuation.finish(); pipeline.cancel()
    }

    func testChangedSetDuringHeldDerivationUsesExistingSupersessionAndOneRederive() async throws {
        let committed = try await committedDrafts()
        let home = AsyncStream<HomeSnapshot>.makeStream()
        let drafts = AsyncStream<Set<String>>.makeStream()
        let seen = ConditionalFeedProbe(), inputs = HeldHomeInputs()
        let started = expectation(description: "first Home derivation held")
        let release = DispatchSemaphore(value: 0)
        let recorder = ApplyPerfRecorder<HeldHomeUpdate>()
        let pipeline = heldPipeline(recorder: recorder, inputs: inputs, committed: committed, hold: {
            if inputs.counts.calls == 1 { started.fulfill(); _ = release.wait(timeout: .now() + 5) }
        })
        pipeline.follow(home.stream) { $0.snapshot = $1 }
        follow(drafts.stream, pipeline: pipeline, seen: seen)
        home.continuation.yield(ApplyPerfFixtures.snapshot(3))
        await fulfillment(of: [started], timeout: 5)
        drafts.continuation.yield([])
        await applyPerfWait { seen.count == 1 }
        XCTAssertEqual(pipeline.counts.wakeups, 1, "the equal in-flight value does not wake another worker")
        drafts.continuation.yield(committed)
        await applyPerfWait { seen.count == 2 }
        release.signal()
        await applyPerfWait { recorder.outputs.count == 1 && pipeline.counts.applies == 1 }
        XCTAssertEqual(recorder.outputs[0].ids, ["session-0000"])
        XCTAssertEqual(pipeline.counts.superseded, 1)
        XCTAssertEqual(pipeline.counts.derivations, 2)
        XCTAssertEqual(pipeline.counts.applies, 1)
        XCTAssertEqual(pipeline.counts.wakeups, 1, "the changed input reuses the running worker")
        XCTAssertEqual(inputs.counts.revision, 1)
        XCTAssertEqual(inputs.counts.empty, 0)
        assertQuiescent(recorder, committed: committed)
        print("DRAFT_PRESENCE_HELD in_flight false_result_superseded=1 true_applies=1 rederives=1")
        home.continuation.finish(); drafts.continuation.finish(); pipeline.cancel()
    }
}