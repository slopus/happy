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
    /// Excludes disconnected older cache islands, while keeping live newer rows.
    /// Local rows (seq <= 0) and the outbox always pass this boundary.
    public var lowerSeqExclusive: Int? = nil
    public var hasMoreOlder = false
    /// Oldest included raw server sequence, including invisible events.
    public var olderBoundary: Int? = nil
}

/// The session projection chat actually reads. Activity, unread and archive
/// state belong to home and do not invalidate a chat snapshot.
public struct ChatStoreSession: Equatable, Sendable {
    /// The server's message sequence and the last locally synchronized one.
    public var seq: Int
    public var syncedMessageSeq: Int
    /// A newest page, including an empty one, was downloaded successfully.
    public var newestHistoryLoaded = false
    /// Versioned permission requests and completed requests.
    public var agentStateVersion: Int
    public var agentState: JSONValue?
    /// Only client.id, rigMetadataVersion and capabilities.messageReceipts.
    public var metadata: JSONValue

    public var isLoaded: Bool {
        Self.messagesAreLoaded(seq: seq, syncedMessageSeq: syncedMessageSeq,
                               newestHistoryLoaded: newestHistoryLoaded)
    }

    public static func messagesAreLoaded(seq: Int, syncedMessageSeq: Int,
                                         newestHistoryLoaded: Bool) -> Bool {
        newestHistoryLoaded || syncedMessageSeq > 0 || seq == 0
    }
}

/// A transactional picture of the projected session and its new records.
public struct ChatStorePage: Sendable {
    /// The projection and outbox read in the same transaction as the records.
    public var change: ChatStoreChange
    /// Records inserted after the caller's cursor, in server sequence order.
    public var records: [MessageRecord]
}

extension LocalStore {
    /// The sequence the chat's records start after (exclusive), or nil for
    /// all of them: a newest page leaves disconnected older islands out.
    static func chatWindowLowerBound(marker: ChatHistoryMarker?, seq: Int, syncedMessageSeq: Int) -> Int? {
        guard let marker, marker.newestLoaded else { return nil }
        if let oldest = marker.oldestRawSeq {
            return syncedMessageSeq < oldest - 1 ? oldest - 1 : nil
        }
        // An empty newest page excludes older retained islands but still
        // admits a later socket message immediately.
        return syncedMessageSeq < seq ? marker.checkedThroughSeq : nil
    }

    /// Reads appended plaintext records and the fields needed to render them.
    /// A rowid cursor catches lower-sequence records that arrive late.
    public func chatPage(sessionId: String, afterRowId: Int64 = 0) throws -> ChatStorePage {
        let cached = latestHomeSnapshot?.sessions.first { $0.id == sessionId }
        return try performRead { db in
            let change = try Self.fetchChatChange(db, sessionId: sessionId, cachedSession: cached)
            return ChatStorePage(
                change: change,
                // Rowid follows insertion, unlike seq: a socket record with
                // seq 500 may arrive before the missing delta at seq 499.
                records: try MessageRecord.fetchAll(
                    db, sql: "SELECT * FROM message WHERE sessionId = ? AND rowid > ? AND (? IS NULL OR seq <= 0 OR seq > ?) ORDER BY seq, id",
                    arguments: [sessionId, afterRowId, change.lowerSeqExclusive, change.lowerSeqExclusive])
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
                        let cached = self.latestHomeSnapshot?.sessions.first { $0.id == sessionId }
                        return try Self.fetchChatChange(db, sessionId: sessionId, cachedSession: cached)
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

    static func fetchChatChange(_ db: Database, sessionId: String) throws -> ChatStoreChange {
        try fetchChatChange(db, sessionId: sessionId, cachedSession: nil)
    }

    static func fetchChatChange(_ db: Database, sessionId: String, cachedSession: SessionRecord?) throws -> ChatStoreChange {
        ThreadRules.assertOffMain()
        let marker = try ChatHistoryMarker.fetchOne(db, key: sessionId)
        let session = try Row.fetchOne(
            db,
            sql:
                "SELECT seq, syncedMessageSeq, agentStateVersion, agentStateCipher, agentState, metadata FROM session WHERE id = ?",
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
            let version: Int = row["agentStateVersion"]
            let cipher: String? = row["agentStateCipher"]
            let agentState = Self.chatAgentState(sessionId: sessionId, version: version, cipher: cipher, cached: cachedSession) {
                row["agentState"]
            }
            return ChatStoreSession(
                seq: row["seq"], syncedMessageSeq: row["syncedMessageSeq"],
                newestHistoryLoaded: marker?.newestLoaded ?? false,
                agentStateVersion: version, agentState: agentState,
                metadata: receiptMetadata
            )
        }
        let coverage = session.map {
            ChatHistoryCoverage(sessionId: sessionId, seq: $0.seq,
                                syncedMessageSeq: $0.syncedMessageSeq, marker: marker)
        }
        let lower = session.flatMap {
            chatWindowLowerBound(marker: marker, seq: $0.seq, syncedMessageSeq: $0.syncedMessageSeq)
        }
        let counts = try Row.fetchOne(
            db,
            sql: "SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS lastId, MIN(CASE WHEN seq > 0 THEN seq END) AS oldest FROM message WHERE sessionId = ? AND (? IS NULL OR seq <= 0 OR seq > ?)",
            arguments: [sessionId, lower, lower])!
        return ChatStoreChange(
            session: session,
            messageCount: counts["count"], lastRowId: counts["lastId"],
            outbox: try OutboxRecord.filter(Column("sessionId") == sessionId).order(
                Column("createdAt"), Column("localId")
            ).fetchAll(db),
            lowerSeqExclusive: lower, hasMoreOlder: coverage?.hasMore ?? false,
            olderBoundary: counts["oldest"]
        )
    }

    /// Home has already decoded the account's records. Reuse only a present
    /// payload with the transaction's same session, version and ciphertext.
    /// The cache comes from this store's own hub, never another account.
    /// Membership, metadata and message boundaries still come from the DB.
    static func chatAgentState(
        sessionId: String, version: Int, cipher: String?, cached: SessionRecord?,
        read: () -> JSONValue?
    ) -> JSONValue? {
        if let cached, cached.id == sessionId, cached.agentStateVersion == version,
           cached.agentStateCipher == cipher, let state = cached.agentState {
            return state
        }
        return read()
    }
}
