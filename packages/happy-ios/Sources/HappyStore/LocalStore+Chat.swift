import Foundation
import GRDB
import HappyWire

/// A lightweight observed value. Message bodies are fetched only after a
/// rowid cursor advances, not on every permission or outbox update.
public struct ChatStoreChange: Equatable, Sendable {
    /// The fields used by the reducer and loaded-state check, without activity.
    public var session: ChatStoreSession?
    /// Number of persisted records, including invisible lifecycle markers.
    public var messageCount: Int
    /// Highest insertion cursor, independent of server sequence order.
    public var lastRowId: Int64
    /// Unsent items belonging to this session, oldest first.
    public var outbox: [OutboxRecord]
}

/// The session projection chat actually reads. Activity, unread and archive
/// state belong to home and do not invalidate a chat snapshot.
public struct ChatStoreSession: Equatable, Sendable {
    /// The server's message sequence and the last locally synchronized one.
    public var seq: Int
    public var syncedMessageSeq: Int
    /// Versioned permission requests and completed requests.
    public var agentStateVersion: Int
    public var agentState: JSONValue?
    /// Only client.id, rigMetadataVersion and capabilities.messageReceipts.
    public var metadata: JSONValue
}

/// A transactional picture of the projected session and its new records.
public struct ChatStorePage: Sendable {
    /// The projection and outbox read in the same transaction as the records.
    public var change: ChatStoreChange
    /// Records inserted after the caller's cursor, in server sequence order.
    public var records: [MessageRecord]
}

extension LocalStore {
    /// Reads appended plaintext records and the fields needed to render them.
    /// A rowid cursor catches lower-sequence records that arrive late.
    public func chatPage(sessionId: String, afterRowId: Int64 = 0) throws -> ChatStorePage {
        try performRead { db in
            ChatStorePage(
                change: try Self.fetchChatChange(db, sessionId: sessionId),
                // Rowid follows insertion, unlike seq: a socket record with
                // seq 500 may arrive before the missing delta at seq 499.
                records: try MessageRecord.fetchAll(
                    db, sql: "SELECT * FROM message WHERE sessionId = ? AND rowid > ? ORDER BY seq, id",
                    arguments: [sessionId, afterRowId])
            )
        }
    }

    /// Observes only changes relevant to chat. Activity ephemerals therefore
    /// do not produce new values. Cancellation stops the database observation.
    public func chatChanges(sessionId: String) -> AsyncThrowingStream<ChatStoreChange, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let observation = ValueObservation.tracking { db in
                        try Self.fetchChatChange(db, sessionId: sessionId)
                    }
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
        let counts = try Row.fetchOne(
            db,
            sql:
                "SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS lastId FROM message WHERE sessionId = ?",
            arguments: [sessionId])!
        let session = try Row.fetchOne(
            db,
            sql:
                "SELECT seq, syncedMessageSeq, agentStateVersion, agentState, metadata FROM session WHERE id = ?",
            arguments: [sessionId]
        ).map { row -> ChatStoreSession in
            let metadata: JSONValue? = row["metadata"]
            let receiptMetadata = JSONValue.object([
                "client": .object(["id": metadata?["client"]?["id"] ?? .null]),
                "rigMetadataVersion": metadata?["rigMetadataVersion"] ?? .null,
                "capabilities": .object([
                    "messageReceipts": metadata?["capabilities"]?["messageReceipts"] ?? .null
                ]),
            ])
            return ChatStoreSession(
                seq: row["seq"], syncedMessageSeq: row["syncedMessageSeq"],
                agentStateVersion: row["agentStateVersion"], agentState: row["agentState"],
                metadata: receiptMetadata
            )
        }
        return ChatStoreChange(
            session: session,
            messageCount: counts["count"], lastRowId: counts["lastId"],
            outbox: try OutboxRecord.filter(Column("sessionId") == sessionId).order(
                Column("createdAt"), Column("localId")
            ).fetchAll(db)
        )
    }
}
