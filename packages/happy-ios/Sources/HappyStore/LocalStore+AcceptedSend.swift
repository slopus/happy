import GRDB

extension LocalStore {
    /// Accepts files and text with the local activity stamp in one commit.
    /// A replayed localId, including one already echoed into the log, is not
    /// a new send and must not move the timestamp or resurrect its outbox row.
    public func enqueueAcceptedSend(_ items: [OutboxRecord], attachments: [AttachmentRecord]) throws {
        try performWrite { db in
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