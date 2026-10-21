import Foundation
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

private actor ArchiveWriteGate {
    private var writes: [Bool] = []
    private var released = false
    private var parked: CheckedContinuation<Void, Never>?
    private let firstEntered: @Sendable () -> Void

    init(firstEntered: @escaping @Sendable () -> Void) { self.firstEntered = firstEntered }

    func persist(_ hidden: Bool) async -> Int {
        writes.append(hidden)
        if writes.count == 1, !released {
            await withCheckedContinuation { continuation in
                parked = continuation
                firstEntered()
            }
        }
        return 10
    }

    func release() { released = true; parked?.resume(); parked = nil }
    var values: [Bool] { writes }
}

final class HomeArchiveVisibilityTests: XCTestCase {
    func testRapidABAWhileWritingPersistsTheFinalIntentAndCloseDrainsIt() async throws {
        let entered = expectation(description: "first local write started")
        let gate = ArchiveWriteGate(firstEntered: { entered.fulfill() })
        let writer = ArchiveVisibilityWriter { await gate.persist($0) }
        let stream = writer.receipts()
        let lastReceipt = Task { () -> ArchiveVisibilityWriter.Receipt? in
            var last: ArchiveVisibilityWriter.Receipt?
            for await receipt in stream { last = receipt }
            return last
        }
        let first = try XCTUnwrap(writer.submit(hidden: false))
        await fulfillment(of: [entered], timeout: 5)
        _ = writer.submit(hidden: true)
        let latest = try XCTUnwrap(writer.submit(hidden: false))
        XCTAssertGreaterThan(latest.generation, first.generation)
        await gate.release()
        await writer.close()
        let persisted = await gate.values
        XCTAssertEqual(persisted.first, false)
        XCTAssertEqual(persisted.last, false)
        XCTAssertFalse(persisted.contains(true), "the intermediate choice must not overwrite the last tap")
        XCTAssertLessThanOrEqual(persisted.count, 2)
        let finalReceipt = await lastReceipt.value
        let receipt = try XCTUnwrap(finalReceipt)
        XCTAssertEqual(receipt.intent, latest)
        XCTAssertTrue(receipt.drained)
        XCTAssertEqual(receipt.baseline, 10)
        XCTAssertNil(writer.submit(hidden: true), "a closed account accepts no later write")
    }

    func testOlderEqualValueAndPendingSnapshotsDoNotAcknowledgeLatestIntent() {
        let first = ArchiveVisibilityWriter.Intent(generation: 1, hidden: false)
        let latest = ArchiveVisibilityWriter.Intent(generation: 3, hidden: false)
        let old = ArchiveVisibilityWriter.Receipt(intent: first, baseline: 10, drained: true)
        let current = ArchiveVisibilityWriter.Receipt(intent: latest, baseline: 10, drained: true)
        XCTAssertFalse(old.acknowledges(latest, settings: settings(version: 11, hidden: false)))
        XCTAssertFalse(current.acknowledges(latest, settings: settings(version: 10, hidden: false)), "an old A snapshot must not clear an A→B→A override")
        XCTAssertFalse(current.acknowledges(latest, settings: settings(version: 11, hidden: false, pending: true)))
        XCTAssertFalse(current.acknowledges(latest, settings: settings(version: 11, hidden: true)))
        XCTAssertFalse(ArchiveVisibilityWriter.Receipt(intent: latest, baseline: 10, drained: false).acknowledges(latest, settings: settings(version: 11, hidden: false)))
        XCTAssertFalse(ArchiveVisibilityWriter.Receipt(intent: latest, baseline: nil, drained: true).acknowledges(latest, settings: settings(version: 11, hidden: false)))
        XCTAssertTrue(current.acknowledges(latest, settings: settings(version: 11, hidden: false)))
    }

    func testFailedLocalWriteIsReportedAndDoesNotPreventTheNextChoice() async throws {
        let writer = ArchiveVisibilityWriter { hidden in
            guard hidden else { throw URLError(.cannotWriteToFile) }
            return 12
        }
        let stream = writer.receipts()
        let failedReceipt = Task { () -> ArchiveVisibilityWriter.Receipt? in
            var iterator = stream.makeAsyncIterator()
            return await iterator.next()
        }
        let failed = try XCTUnwrap(writer.submit(hidden: false))
        await writer.flush()
        let failedValue = await failedReceipt.value
        let receipt = try XCTUnwrap(failedValue)
        XCTAssertEqual(receipt.intent, failed)
        XCTAssertNil(receipt.baseline)
        let recoveryStream = writer.receipts()
        let latest = try XCTUnwrap(writer.submit(hidden: true))
        let recovered = Task { () -> ArchiveVisibilityWriter.Receipt? in
            for await receipt in recoveryStream where receipt.intent == latest { return receipt }
            return nil
        }
        await writer.flush()
        let recoveredValue = await recovered.value
        let recovery = try XCTUnwrap(recoveredValue)
        XCTAssertEqual(recovery.baseline, 12)
        await writer.close()
    }

    func testDifferentAccountsKeepIndependentAcceptedChoices() async throws {
        let firstGate = ArchiveWriteGate(firstEntered: {})
        let secondGate = ArchiveWriteGate(firstEntered: {})
        await firstGate.release(); await secondGate.release()
        let first = ArchiveVisibilityWriter { await firstGate.persist($0) }
        let second = ArchiveVisibilityWriter { await secondGate.persist($0) }
        _ = first.submit(hidden: false)
        _ = second.submit(hidden: true)
        await first.close(); await second.close()
        let firstValues = await firstGate.values, secondValues = await secondGate.values
        XCTAssertEqual(firstValues, [false])
        XCTAssertEqual(secondValues, [true])
    }

    func testReceiptConsumersCanCancelWhileTheWriterDrainsAndCloses() async {
        let completed = expectation(description: "cancelled subscribers and writer finish")
        Task.detached {
            for _ in 0..<40 {
                let writer = ArchiveVisibilityWriter { _ in 0 }
                let stream = writer.receipts()
                let consumer = Task {
                    for await _ in stream { if Task.isCancelled { break } }
                }
                _ = writer.submit(hidden: false)
                consumer.cancel()
                await writer.close()
                await consumer.value
                // A subscription after close must terminate, too.
                for await _ in writer.receipts() {}
            }
            completed.fulfill()
        }
        await fulfillment(of: [completed], timeout: 5)
    }

    func testPreparedVisibilityModelsMatchNormalDerivationForBothLayouts() throws {
        for grouping in ["flat", "project"] {
            for offline in [false, true] {
                var snapshot = ApplyPerfFixtures.snapshot(10)
                snapshot.machines.machines[0].active = !offline
                for index in snapshot.sessions.indices {
                    snapshot.sessions[index].active = index < 6
                    var metadata = snapshot.sessions[index].metadata?.objectValue ?? [:]
                    metadata["path"] = .string(index == 0 ? "/work/project" : "/work/project/.dev/worktree/w\(index)")
                    metadata["lastMeaningfulMessageAt"] = .number(Double(ApplyPerfFixtures.now - Int64(index) * 86_400_000))
                    snapshot.sessions[index].metadata = .object(metadata)
                }
                snapshot.settings.pending["sessionListGrouping"] = .string(grouping)
                let choices = offline ? MachineChoice.collect(snapshot.machines.machines) : nil
                let drafts: Set<String> = ["session-0001", "session-0006"]
                let first = try XCTUnwrap(HomeArchiveModels.make(snapshot: snapshot, expandedProjects: [], draftSessionIds: drafts, clock: ApplyPerfFixtures.clock, unknownMachine: "Unknown", offline: choices))
                let projects = Set(first.shown.rows.compactMap { row -> String? in
                    if case .project(.project(let project)) = row { return project.id }
                    return nil
                })
                for expanded in [Set<String>(), projects] {
                    let pair = try XCTUnwrap(HomeArchiveModels.make(snapshot: snapshot, expandedProjects: expanded, draftSessionIds: drafts, clock: ApplyPerfFixtures.clock, unknownMachine: "Unknown", offline: choices))
                    for hidden in [false, true] {
                        var expected = snapshot
                        expected.settings.pending["hideInactiveSessions"] = .bool(hidden)
                        let ordinary = HomeListModel(SessionList(expected, clock: ApplyPerfFixtures.clock, unknownMachine: "Unknown"), offline: choices, expandedProjects: expanded, draftSessionIds: drafts)
                        XCTAssertEqual(pair.model(hidden: hidden), ordinary, "\(grouping), offline=\(offline), hidden=\(hidden)")
                    }
                }
            }
        }
    }

    func testNoArchiveDoesNotCreateAnAlternateAndTableDoesNotOptIn() throws {
        let snapshot = ApplyPerfFixtures.snapshot(3)
        XCTAssertNil(HomeArchiveModels.make(snapshot: snapshot, expandedProjects: [], draftSessionIds: [], clock: ApplyPerfFixtures.clock, unknownMachine: "Unknown"))
        let input = HomeDerivation.Input(snapshot: snapshot, clock: ApplyPerfFixtures.clock)
        let result = try XCTUnwrap(HomeDerivation.derive(input, applied: .init()))
        XCTAssertNil(result.output.archiveModels)
        XCTAssertNil(result.output.archiveSettings)
        XCTAssertNil(HomeDerivation.derive(input, applied: result.state))
    }

    private func settings(version: Int, hidden: Bool, pending: Bool = false) -> HomeArchiveSettings {
        HomeArchiveSettings(SettingsSnapshot(
            synced: AccountSettingsRecord(version: version, cipher: nil, settings: .object(["hideInactiveSessions": .bool(hidden)])),
            pending: pending ? ["hideInactiveSessions": .bool(hidden)] : [:]
        ))
    }
}
