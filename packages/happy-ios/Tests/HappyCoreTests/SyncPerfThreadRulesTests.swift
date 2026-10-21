import Foundation
import XCTest
import HappyCrypto
import HappyStore
@testable import HappyCore

private final class ThreadViolations: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [ThreadRules.Requirement] = []
    var values: [ThreadRules.Requirement] { lock.withLock { recorded } }
    func append(_ value: ThreadRules.Requirement) { lock.withLock { recorded.append(value) } }
}

final class SyncPerfThreadRulesTests: XCTestCase {
    func testMainStoreReadAndWriteAreCaughtButActorSyncAndReducerRunOffMain() async throws {
        let store = try LocalStore.inMemory()
        let violations = ThreadViolations()
        let oldEnforcement = ThreadRules.isEnforced
        let oldHandler = ThreadRules.violationHandler
        ThreadRules.violationHandler = { violations.append($0) }
        ThreadRules.isEnforced = true
        defer {
            ThreadRules.isEnforced = oldEnforcement
            ThreadRules.violationHandler = oldHandler
        }

        try await MainActor.run {
            _ = try store.session(id: "missing")
            try store.markSessionRead(id: "missing")
            var reducer = ChatReducer()
            _ = reducer.reduce([])
            ThreadRules.assertOnMain()
        }
        XCTAssertEqual(violations.values, [.offMain, .offMain, .offMain])

        try await Task.detached {
            try store.upsertSessions([ChatRecords.storeSession("s")])
            let page = try store.chatPage(sessionId: "s")
            var reducer = FeedState(sessionId: "s")
            _ = reducer.apply(page)
            ThreadRules.assertOffMain()
        }.value
        let engine = SyncEngine(api: testAPI(FakeHTTP()), store: store, keys: try AccountKeys(secret: Data(repeating: 3, count: 32)))
        await engine.handle(.activity(sessionId: "s", active: true, activeAt: 1, thinking: false))
        await engine.stop()
        XCTAssertEqual(violations.values, [.offMain, .offMain, .offMain])
    }
}