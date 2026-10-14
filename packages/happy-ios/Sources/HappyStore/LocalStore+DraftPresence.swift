import Dispatch
import GRDB

extension LocalStore {
    /// Only membership: no draft text is fetched or delivered to home.
    public func draftSessionIdsSnapshot() throws -> Set<String> {
        try performRead { db in try Self.fetchDraftSessionIds(db) }
    }

    public func draftSessionIdsSnapshots() -> AsyncStream<Set<String>> {
        draftSessionsHub.snapshots()
    }

    static func fetchDraftSessionIds(_ db: Database) throws -> Set<String> {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        return Set(try String.fetchAll(db, sql: "SELECT sessionId FROM draft"))
    }
}