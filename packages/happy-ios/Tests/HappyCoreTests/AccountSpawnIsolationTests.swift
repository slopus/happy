import Foundation
import XCTest
@testable import HappyCore
import HappyStore

final class AccountSpawnIsolationTests: XCTestCase, @unchecked Sendable {
    func testAccountSessionOwnsSenderScopeAndClosesItOnStop() async throws {
        // Construction stays off the main actor, as it does when opening an
        // account store. Only request state and cancellation run on main.
        let first = try AccountSession(
            credentials: TokenStorageFixtures.typical,
            store: LocalStore.inMemory(),
            dependencies: .init(serverURL: ServerConfig.defaultServerURL, clientID: "test", transport: FakeHTTP(), connector: FakeConnector())
        )
        let second = try AccountSession(
            credentials: Credentials(token: "second", secret: Data(repeating: 7, count: 32)),
            store: LocalStore.inMemory(),
            dependencies: .init(serverURL: ServerConfig.defaultServerURL, clientID: "test", transport: FakeHTTP(), connector: FakeConnector())
        )
        XCTAssertTrue(first.sender.spawnRequests === first.spawnRequests)
        XCTAssertTrue(second.sender.spawnRequests === second.spawnRequests)
        XCTAssertFalse(first.spawnRequests === second.spawnRequests)
        let signature = SpawnRequests.Signature(machineId: "m", agent: "claude", place: "~/private", worktree: nil, modelKey: nil, permissionMode: nil, effort: nil)
        let ids = await MainActor.run {
            let a = first.spawnRequests.requestId(for: signature)
            let b = second.spawnRequests.requestId(for: signature)
            first.spawnRequests.remember(a, sessionId: "a", abandon: {})
            second.spawnRequests.remember(b, sessionId: "b", abandon: { XCTFail("stopping the first account abandoned the second") })
            return (a, b)
        }
        XCTAssertNotEqual(ids.0, ids.1)
        await first.stop()
        await MainActor.run {
            XCTAssertTrue(first.spawnRequests.isClosed)
            XCTAssertNil(first.spawnRequests.spawnedSessionId(ids.0))
            XCTAssertFalse(second.spawnRequests.isClosed)
            XCTAssertEqual(second.spawnRequests.spawnedSessionId(ids.1), "b")
            second.spawnRequests.complete()
        }
        await second.stop()
    }
}