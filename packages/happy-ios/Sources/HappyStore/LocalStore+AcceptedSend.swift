import GRDB

extension LocalStore {
    /// Accepts files and text with the local activity stamp in one commit.
    /// A replayed localId, including one already echoed into the log, is not
    /// a new send and must not move the timestamp or resurrect its outbox row.
    public func enqueueAcceptedSend(_ items: [OutboxRecord], attachments: [AttachmentRecord],
                                    admitting: (@Sendable (SessionRecord?) -> String?)? = nil) throws {
        try performWrite { db in
            // The session as it stands in this transaction, not as a cache last saw it.
            if let admitting, let sessionId = items.last?.sessionId,
               let reason = admitting(try SessionRecord.fetchOne(db, key: sessionId)) {
                throw SessionRefusedSend(reason: reason)
            }
            for attachment in attachments { try attachment.insert(db, onConflict: .ignore) }
            for item in items {
                if try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM message WHERE sessionId = ? AND localId = ?)",
                                    arguments: [item.sessionId, item.localId]) == true { continue }
                try item.insert(db, onConflict: .ignore)
                guard db.changesCount > 0, item.kind == .message else { continue }
                try db.execute(sql: "UPDATE session SET lastMessageSentAt = ? WHERE id = ? AND lastMessageSentAt IS NOT ?",
                               arguments: [item.createdAt, item.sessionId, item.createdAt])
            }
        }
    }
}
/// `enqueueAcceptedSend`'s refusal: the session, read where the send is
/// kept, can't take it, and why.
public struct SessionRefusedSend: Error, Equatable, Sendable {
    public let reason: String
}

extension LocalStore {
    /// The records in the chat's window (the ones its reducer folds) that
    /// can leave a user message waiting for the daemon: user text asking
    /// for acceptance, a local copy, and the receipts that settle them.
    /// A text prefilter over the stored JSON; the reducer decides.
    public func acceptanceRecords(sessionId: String) throws -> [MessageRecord] {
        ThreadRules.assertOffMain()
        return try performRead { db in
            guard let session = try Row.fetchOne(
                db, sql: "SELECT seq, syncedMessageSeq FROM session WHERE id = ?", arguments: [sessionId]
            ) else { return [] }
            let lower = Self.chatWindowLowerBound(
                marker: try ChatHistoryMarker.fetchOne(db, key: sessionId),
                seq: session["seq"], syncedMessageSeq: session["syncedMessageSeq"])
            return try MessageRecord.fetchAll(
                db,
                sql: """
                    SELECT * FROM message WHERE sessionId = ? AND (? IS NULL OR seq <= 0 OR seq > ?)
                    AND (id = localId OR instr(content, 'expectsAcceptance') > 0 OR instr(content, 'user-message-') > 0)
                    ORDER BY seq, id
                    """,
                arguments: [sessionId, lower, lower])
        }
    }
}
