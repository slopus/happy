import Foundation
import XCTest
import HappyStore
@testable import HappyCore

/// Home's stamps and headings follow the clock with no store change: home
/// is derived again only at the instants a label can change.
final class ApplyPerfClockTests: XCTestCase {
    /// The UTC midnight after `ApplyPerfFixtures.now` (08:00).
    static let midnight = Date(timeIntervalSince1970: 1_800_057_600)
    static let hour: Int64 = 3_600_000

    static func clock(_ date: Date) -> SessionList.Clock {
        var clock = ApplyPerfFixtures.clock
        clock.now = date
        return clock
    }

    /// Three chats last worked on at 10:00, two of them archived, shown.
    static func snapshot() -> HomeSnapshot {
        var snapshot = ApplyPerfFixtures.snapshot(3)
        let at = Int64(midnight.timeIntervalSince1970 * 1000) - 14 * hour
        snapshot.sessions = snapshot.sessions.map { ApplyPerfFixtures.active($0, at: at) }
        snapshot.sessions[1].active = false
        snapshot.sessions[2].active = false
        snapshot.settings = SettingsSnapshot(pending: ["hideInactiveSessions": .bool(false)])
        return snapshot
    }

    static func derive(_ snapshot: HomeSnapshot, at date: Date, after applied: HomeDerivation.Applied) -> (output: HomeUpdate, state: HomeDerivation.Applied)? {
        HomeDerivation.derive(HomeDerivation.Input(snapshot: snapshot, clock: clock(date)), applied: applied)
    }

    func testCrossingMidnightReconfiguresOnlyTheHeading() throws {
        let snapshot = Self.snapshot()
        let before = try XCTUnwrap(Self.derive(snapshot, at: Self.midnight - 60, after: .init())).state
        // Between boundaries the rows are the same rows.
        XCTAssertNil(Self.derive(snapshot, at: Self.midnight - 30, after: before))

        let after = try XCTUnwrap(Self.derive(snapshot, at: Self.midnight + 60, after: before)).output
        let list = try XCTUnwrap(after.content.list)
        let heading = try XCTUnwrap(list.ids.firstIndex(of: .day(0)))
        XCTAssertEqual(after.changeset, RowChangeset(reconfigures: [heading]))
        XCTAssertEqual(list.rows[heading], .flat(.dayHeader(.yesterday)))
    }

    func testTheNextBoundaryIsMidnightOrTheFirstStampToFlip() {
        let now = Date(timeIntervalSince1970: Double(ApplyPerfFixtures.now) / 1000)
        var snapshot = Self.snapshot()
        XCTAssertEqual(HomeClockBoundary.next(after: Self.clock(now), snapshot: snapshot), Self.midnight)

        // A chat from 23 hours ago turns from a time into a weekday in an hour.
        snapshot.sessions[0] = ApplyPerfFixtures.active(snapshot.sessions[0], at: ApplyPerfFixtures.now - 23 * Self.hour)
        XCTAssertEqual(HomeClockBoundary.next(after: Self.clock(now), snapshot: snapshot), now + 3600)

        // One from six days and 22 hours ago turns into a date in two.
        snapshot.sessions[0] = ApplyPerfFixtures.active(snapshot.sessions[0], at: ApplyPerfFixtures.now - 6 * 24 * Self.hour - 22 * Self.hour)
        XCTAssertEqual(HomeClockBoundary.next(after: Self.clock(now), snapshot: snapshot), now + 7200)

        // A date never turns into anything else before midnight.
        snapshot.sessions[0] = ApplyPerfFixtures.active(snapshot.sessions[0], at: ApplyPerfFixtures.now - 30 * 24 * Self.hour)
        XCTAssertEqual(HomeClockBoundary.next(after: Self.clock(now), snapshot: snapshot), Self.midnight)
    }

    /// The production pipeline at the real time: a stamp due to turn into a
    /// weekday wakes home once, with no store change, and touches that row.
    @MainActor
    func testAStampFlipWakesHomeWithNoStoreChange() async throws {
        let wake = ClockWake()
        let recorder = ApplyPerfRecorder<HomeUpdate>()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var snapshot = ApplyPerfFixtures.snapshot(2)
        snapshot.sessions[0] = ApplyPerfFixtures.active(snapshot.sessions[0], at: now)
        snapshot.sessions[1] = ApplyPerfFixtures.active(snapshot.sessions[1], at: now - 24 * Self.hour + 1000)
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(snapshot: snapshot),
            state: HomeDerivation.Applied(),
            derive: { HomeDerivation.derive($0, applied: $1, wake: wake) },
            apply: { recorder.take($0) }
        )
        wake.onWake { [weak pipeline] in pipeline?.update { _ in } }
        pipeline.update { _ in }

        await applyPerfWait { recorder.outputs.count == 2 }
        XCTAssertEqual(recorder.outputs.last?.changeset, RowChangeset(reconfigures: [1]))
        // Then nothing until the next boundary, hours away.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(recorder.outputs.count, 2)
        XCTAssertEqual(pipeline.counts.derivations, 2)
        XCTAssertNotNil(wake.deadline)

        pipeline.cancel()
        wake.cancel()
        XCTAssertNil(wake.deadline)
    }

    func testAWakeKeepsOnlyItsLatestDeadlineAndNeverFiresOnceCancelled() async throws {
        let fired = ApplyPerfClockCounter()
        let wake = ClockWake()
        wake.onWake { fired.add() }
        wake.schedule(Date() + 0.05)
        wake.schedule(Date() + 0.1)
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(fired.count, 1, "the replaced deadline never fires")
        XCTAssertNil(wake.deadline)

        wake.schedule(Date() + 0.05)
        wake.cancel()
        wake.schedule(Date() + 0.05)
        XCTAssertNil(wake.deadline, "nothing waits once cancelled")
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(fired.count, 1)
    }
}

final class ApplyPerfClockCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func add() { lock.withLock { value += 1 } }
    var count: Int { lock.withLock { value } }
}
