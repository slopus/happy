import Foundation
import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

/// Fixed sessions, machine, clock and locale for the apply benchmarks: no
/// network, no randomness, the same rows every run.
enum ApplyPerfFixtures {
    static let now: Int64 = 1_800_000_000_000

    static var clock: SessionList.Clock {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return SessionList.Clock(now: Date(timeIntervalSince1970: Double(now) / 1000), calendar: calendar, locale: Locale(identifier: "en_US_POSIX"))
    }

    static let machine = MachineRecord(
        id: "computer", seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
        metadataVersion: 1, metadataCipher: "cipher", metadata: .object(["host": .string("Work")]),
        daemonStateVersion: 0, daemonStateCipher: nil, daemonState: nil, dataKeyCipher: "key", decryptable: true
    )

    static func session(_ index: Int) -> SessionRecord {
        SessionRecord(
            id: String(format: "session-%04d", index), seq: 1, createdAt: now - Int64(index) * 60_000,
            updatedAt: now, active: true, activeAt: now, projectId: nil,
            metadataVersion: 1, metadataCipher: "cipher",
            metadata: .object([
                "machineId": .string("computer"), "path": .string("/work/project"),
                "summary": .object(["text": .string("Session \(index)")]),
                "lastMeaningfulMessageAt": .number(Double(now - Int64(index) * 60_000)),
            ]),
            agentStateVersion: 0, agentStateCipher: nil, agentState: nil, dataKeyCipher: "key", decryptable: true
        )
    }

    static func snapshot(_ count: Int) -> HomeSnapshot {
        HomeSnapshot(machines: MachinesSnapshot(synced: true, machines: [machine]), sessions: (0..<count).map(session), sessionsSynced: true)
    }

    static func retitled(_ record: SessionRecord, _ title: String) -> SessionRecord {
        var record = record
        var metadata = record.metadata?.objectValue ?? [:]
        metadata["summary"] = .object(["text": .string(title)])
        record.metadata = .object(metadata)
        return record
    }

    /// What an unchanged heartbeat or a message cursor bump writes: nothing
    /// any screen draws.
    static func invisiblyTouched(_ record: SessionRecord, by step: Int64) -> SessionRecord {
        var record = record
        record.activeAt += step
        record.updatedAt += step
        record.seq += 1
        record.syncedMessageSeq += 1
        record.thinkingAt += step
        record.metadataVersion += 1
        record.metadataCipher += "+"
        return record
    }

    /// Session 1 leads by a millisecond, then session 0 overtakes it in the
    /// same minute: the order changes, every stamp reads the same.
    static func overtaking() -> (before: HomeSnapshot, after: HomeSnapshot) {
        var before = snapshot(50)
        before.sessions[1] = active(before.sessions[1], at: now + 1)
        var after = before
        after.sessions[0] = active(after.sessions[0], at: now + 2)
        return (before, after)
    }

    static func active(_ record: SessionRecord, at time: Int64) -> SessionRecord {
        var record = record
        var metadata = record.metadata?.objectValue ?? [:]
        metadata["lastMeaningfulMessageAt"] = .number(Double(time))
        record.metadata = .object(metadata)
        return record
    }

    static func derive(_ snapshot: HomeSnapshot, after applied: HomeDerivation.Applied?) -> (output: HomeUpdate, state: HomeDerivation.Applied)? {
        HomeDerivation.derive(HomeDerivation.Input(snapshot: snapshot, includesDock: true, clock: clock), applied: applied ?? .init())
    }
}

/// Blocks a derivation until the test lets it go, to make coalescing
/// deterministic.
final class ApplyPerfGate: @unchecked Sendable {
    private let entered = DispatchSemaphore(value: 0)
    private let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var armed = true

    /// Called by the derivation: the first call waits for `open`.
    func pass() {
        let wait: Bool = lock.withLock {
            defer { armed = false }
            return armed
        }
        guard wait else { return }
        entered.signal()
        release.wait()
    }

    func waitUntilHeld() { entered.wait() }
    func open() { release.signal() }
}

/// Lets an apply closure reach the pipeline it belongs to.
@MainActor
final class ApplyPerfPipelineBox<Pipeline: AnyObject> {
    var pipeline: Pipeline?
}

/// Counts what a main-thread apply closure was handed.
@MainActor
final class ApplyPerfRecorder<Output> {
    var outputs: [Output] = []
    /// Refuses every result, as a screen that moved on does.
    var refuses = false

    func take(_ output: Output) -> Bool {
        outputs.append(output)
        return !refuses
    }
}

/// Waits on the main actor for `condition`, polling, so a missing apply is a
/// failure rather than a hang.
@MainActor
func applyPerfWait(timeout: Double = 5, file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
    let deadline = ContinuousClock.now + .milliseconds(Int(timeout * 1000))
    while !condition() {
        if ContinuousClock.now > deadline {
            XCTFail("timed out", file: file, line: line)
            return
        }
        try? await Task.sleep(for: .milliseconds(2))
    }
}

/// The median of `runs` timings of `operation`, in milliseconds.
func applyPerfMedian(_ runs: Int = 7, _ operation: () throws -> Void) rethrows -> Double {
    var times: [Double] = []
    for _ in 0..<runs {
        let start = ContinuousClock.now
        try operation()
        times.append(start.duration(to: .now).milliseconds)
    }
    return times.sorted()[times.count / 2]
}
