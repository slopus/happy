import Foundation
import GRDB
import HappyWire

/// A lightweight observed value. Message bodies are fetched only after a
/// rowid cursor advances, not on every permission or outbox update.
public struct ChatStoreChange: Equatable, Sendable {
    public var session: SessionRecord?
    public var messageCount: Int
    public var lastRowId: Int64
    public var outbox: [OutboxRecord]
}

public struct ChatStorePage: Sendable {
    public var change: ChatStoreChange
    public var records: [MessageRecord]
}

extension LocalStore {
    public func chatPage(sessionId: String, afterRowId: Int64 = 0) throws -> ChatStorePage {
        try writer.read { db in
            ChatStorePage(
                change: try Self.fetchChatChange(db, sessionId: sessionId),
                // Rowid follows insertion, unlike seq: a socket record with
                // seq 500 may arrive before the missing delta at seq 499.
                records: try MessageRecord.fetchAll(db, sql: "SELECT * FROM message WHERE sessionId = ? AND rowid > ? ORDER BY seq, id", arguments: [sessionId, afterRowId])
            )
        }
    }

    public func chatChanges(sessionId: String) -> AsyncThrowingStream<ChatStoreChange, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let observation = ValueObservation.tracking { db in try Self.fetchChatChange(db, sessionId: sessionId) }
                    for try await change in observation.removeDuplicates().values(in: writer) {
                        continuation.yield(change)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func fetchChatChange(_ db: Database, sessionId: String) throws -> ChatStoreChange {
        let counts = try Row.fetchOne(db, sql: "SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS lastId FROM message WHERE sessionId = ?", arguments: [sessionId])!
        return ChatStoreChange(
            session: try SessionRecord.fetchOne(db, key: sessionId),
            messageCount: counts["count"], lastRowId: counts["lastId"],
            outbox: try OutboxRecord.filter(Column("sessionId") == sessionId).order(Column("createdAt"), Column("localId")).fetchAll(db)
        )
    }
}