import XCTest
@testable import HappyCore

@MainActor
final class SpawnChildScopeTests: XCTestCase {
    private let signature = SpawnRequests.Signature(machineId: "machine", agent: "claude", place: "~/private", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil)

    func testRoleIsPersistentAndItsRequestDoesNotReplaceTheHomeDraft() async {
        let root = SpawnRequests()
        let child = root.child(.pendingChats)
        XCTAssertTrue(root.child(.pendingChats) === child)
        XCTAssertTrue(child.child(.pendingChats) === child)
        let homeID = root.requestId(for: signature)
        let stripID = child.requestId(for: signature)
        XCTAssertNotEqual(homeID, stripID)
        var homeAbandoned = 0
        var stripAbandoned = 0
        root.remember(homeID, sessionId: "home", abandon: { homeAbandoned += 1 })
        child.remember(stripID, sessionId: "strip", abandon: { stripAbandoned += 1 })
        var changed = signature
        changed.place = "~/changed"
        _ = root.requestId(for: changed)
        XCTAssertEqual(homeAbandoned, 1)
        XCTAssertEqual(stripAbandoned, 0)
        XCTAssertEqual(child.requestId(for: signature), stripID)
        XCTAssertEqual(child.spawnedSessionId(stripID), "strip")
        _ = child.requestId(for: changed)
        XCTAssertEqual(stripAbandoned, 1)
        XCTAssertEqual(homeAbandoned, 1)
        root.close()
    }

    func testAccountReleaseFansOutToItsChildAndNeverAnotherAccount() async {
        let root = SpawnRequests(), other = SpawnRequests()
        let child = root.child(.pendingChats), otherChild = other.child(.pendingChats)
        let homeID = root.requestId(for: signature)
        let childID = child.requestId(for: signature)
        let otherID = otherChild.requestId(for: signature)
        var released = 0
        root.remember(homeID, sessionId: "home", abandon: {}, release: { XCTFail("a different session's Home draft was released") })
        child.remember(childID, sessionId: "same-server-id", abandon: { XCTFail("adopted child was abandoned") }, release: { released += 1 })
        otherChild.remember(otherID, sessionId: "same-server-id", abandon: {}, release: { XCTFail("another account was released") })
        root.release(sessionId: "same-server-id")
        root.release(sessionId: "same-server-id")
        XCTAssertEqual(released, 1)
        XCTAssertNil(child.spawnedSessionId(childID))
        XCTAssertEqual(root.spawnedSessionId(homeID), "home")
        XCTAssertEqual(otherChild.spawnedSessionId(otherID), "same-server-id")
        root.complete()
        otherChild.complete()
        root.close()
        other.close()
    }

    func testCloseCancelsEveryRoleOnceAndLateCallbacksCannotRecreateState() async {
        let root = SpawnRequests(), current = SpawnRequests()
        let child = root.child(.pendingChats)
        let homeID = root.requestId(for: signature), childID = child.requestId(for: signature)
        let currentID = current.child(.pendingChats).requestId(for: signature)
        var canceled = 0
        var abandoned = 0
        _ = root.registerAttempt { canceled += 1 }
        _ = child.registerAttempt { canceled += 1 }
        root.remember(homeID, sessionId: "home", abandon: { abandoned += 1 })
        child.remember(childID, sessionId: "strip", abandon: { abandoned += 1 })
        current.child(.pendingChats).remember(currentID, sessionId: "strip", abandon: { XCTFail("an old account affected the current account") })
        root.close()
        root.close()
        XCTAssertTrue(root.isClosed)
        XCTAssertTrue(child.isClosed)
        XCTAssertEqual(canceled, 2)
        XCTAssertEqual(abandoned, 2)
        let late = root.child(.pendingChats)
        XCTAssertTrue(late.isClosed)
        XCTAssertFalse(late === child, "the closed root releases its child registry")
        XCTAssertNil(late.registerAttempt { XCTFail("a stopped role admitted a new attempt") })
        child.remember(childID, sessionId: "late", abandon: { abandoned += 1 })
        XCTAssertEqual(abandoned, 3)
        XCTAssertNil(child.spawnedSessionId(childID))
        root.release(sessionId: "strip")
        XCTAssertEqual(current.child(.pendingChats).spawnedSessionId(currentID), "strip")
        current.child(.pendingChats).complete()
        current.close()
    }

    func testIndependentlyClosedRoleRemainsATombstoneWhileHomeStaysOpen() async {
        let root = SpawnRequests()
        let child = root.child(.pendingChats)
        child.close()
        XCTAssertTrue(root.child(.pendingChats) === child)
        XCTAssertTrue(root.child(.pendingChats).isClosed)
        XCTAssertFalse(root.isClosed)
        let id = root.requestId(for: signature)
        root.remember(id, sessionId: "home", abandon: {})
        XCTAssertEqual(root.spawnedSessionId(id), "home")
        root.complete()
        root.close()
    }
}