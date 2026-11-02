import Foundation
import XCTest
@testable import HappyCore
import HappyStore
import HappyWire

private actor SleepLog {
    var total = Duration.zero
    var heardAfter: Duration?

    init(heardAfter: Duration?) { self.heardAfter = heardAfter }
    func sleep(_ duration: Duration) { total += duration }
    func heard() -> Int64? {
        guard let heardAfter, total >= heardAfter else { return nil }
        return 1
    }
}

/// A Happy CLI before 1.2.1 can lose a new session's first message, so the
/// phone waits to hear it first; Happy Agent and current CLIs are sent at once.
final class FirstMessageWaitTests: XCTestCase {
    func testWhichSessionsWait() {
        XCTAssertTrue(SessionDetails.waitsForCLIBeforeFirstMessage(["version": "0.10.0"]))
        XCTAssertTrue(SessionDetails.waitsForCLIBeforeFirstMessage(["version": "1.2.0"]))
        XCTAssertFalse(SessionDetails.waitsForCLIBeforeFirstMessage(["version": "1.2.1"]))
        XCTAssertFalse(SessionDetails.waitsForCLIBeforeFirstMessage(["version": "1.2.6"]))
        XCTAssertFalse(SessionDetails.waitsForCLIBeforeFirstMessage(["path": "/repo"]), "no version")
        XCTAssertFalse(SessionDetails.waitsForCLIBeforeFirstMessage(nil))
        XCTAssertFalse(SessionDetails.waitsForCLIBeforeFirstMessage(["version": "0.4.111", "client": ["id": "rig"]]), "Happy Agent")
    }

    func testWaitsForTheFirstHeartbeatThenSettles() async throws {
        let log = SleepLog(heardAfter: .seconds(3))
        let heard = try await SessionReadiness.awaitCLIHeard(heardAt: { await log.heard() }, sleep: { await log.sleep($0) })
        XCTAssertTrue(heard)
        let total = await log.total
        XCTAssertEqual(total, .milliseconds(4500), "3 s to be heard, 1.5 s to settle")
    }

    func testSendsAnywayWhenNeverHeard() async throws {
        let log = SleepLog(heardAfter: nil)
        let heard = try await SessionReadiness.awaitCLIHeard(heardAt: { await log.heard() }, sleep: { await log.sleep($0) })
        XCTAssertFalse(heard)
        let total = await log.total
        XCTAssertEqual(total, .seconds(15))
    }

    /// Newest first: an answer, the second message, the lost first one.
    /// Only an old CLI's first message keeps one check.
    func testAnOldCLIsUnansweredMessageKeepsOneCheck() {
        let rows = [false, true, true]
        XCTAssertEqual(MessageTaken.answered(rows, strict: false), [false, true, true])
        XCTAssertEqual(MessageTaken.answered(rows, strict: true), [false, true, false])
        XCTAssertEqual(MessageTaken.answered([true, false, true], strict: true), [false, false, true], "the newest waits")
        // Once it has answered, an answer stands for every message before it.
        XCTAssertEqual(MessageTaken.answered([false, true, true, false, true], strict: true), [false, true, true, false, true])
        XCTAssertEqual(MessageTaken.answered([false, true, true, false, true, true], strict: true), [false, true, true, false, true, false])
    }

    /// The first heartbeat of a session can come before its row.
    func testPresenceHearsASessionBeforeItsRow() async throws {
        let store = try LocalStore.inMemory()
        let presence = SessionPresence(store: store, now: { 42 })
        let unheard = await presence.heardAt("new")
        XCTAssertNil(unheard)
        await presence.activity(id: "new", active: false, activeAt: 1, thinking: false)
        let offline = await presence.heardAt("new")
        XCTAssertNil(offline)
        await presence.activity(id: "new", active: true, activeAt: 2, thinking: false)
        let heard = await presence.heardAt("new")
        XCTAssertEqual(heard, 42)
    }
}
