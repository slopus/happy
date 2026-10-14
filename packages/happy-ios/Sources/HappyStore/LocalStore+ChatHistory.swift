import Foundation
import GRDB

/// One downloaded contiguous tail, independent of forward recovery's prefix.
public struct ChatHistoryMarker: Codable, FetchableRecord, PersistableRecord, Equatable, Sendable {
    public static let databaseTableName = "chatHistory"
    public var sessionId: String
    public var newestLoaded: Bool
    public var oldestRawSeq: Int?
    public var newestRawSeq: Int?
    public var serverHasMore: Bool
    public var checkedThroughSeq: Int
}

/// Status observes scalars only: no session metadata or message payloads.
public struct ChatHistoryCoverage: Equatable, Sendable {
    public var sessionId: String
    public var seq: Int
    public var syncedMessageSeq: Int
    public var marker: ChatHistoryMarker?

    public var isLoaded: Bool {
        ChatStoreSession.messagesAreLoaded(seq: seq, syncedMessageSeq: syncedMessageSeq,
                                           newestHistoryLoaded: marker?.newestLoaded == true)
    }

    public var hasMore: Bool {
        guard let marker else { return syncedMessageSeq < seq }
        guard marker.serverHasMore, let oldest = marker.oldestRawSeq else { return false }
        return syncedMessageSeq < oldest - 1
    }
}

public enum ChatHistoryPage: Sendable {
    case newest(checkedThroughSeq: Int)
    case older(beforeSeq: Int)
}

public enum ChatHistoryStoreError: Error { case invalidPage, staleBackwardPage }

extension LocalStore {
    private static let historyQueue = DispatchQueue(label: "HappyStore.chatHistory", qos: .userInitiated)

    public func chatHistoryCoverage(sessionId: String) throws -> ChatHistoryCoverage? {
        try performRead { db in try Self.fetchChatHistoryCoverage(db, sessionId: sessionId) }
    }

    public func chatHistoryCoverageSnapshots(sessionId: String) -> AsyncStream<ChatHistoryCoverage?> {
        let writer = writer
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let cancellable = ValueObservation.tracking { db in
                ThreadRules.assertOffMain()
                return try Self.fetchChatHistoryCoverage(db, sessionId: sessionId)
            }.removeDuplicates().start(in: writer, scheduling: .async(onQueue: Self.historyQueue),
                                      onError: { _ in continuation.finish() },
                                      onChange: { continuation.yield($0) })
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    /// Backward downloads never advance syncedMessageSeq. Rows and the
    /// coverage marker commit together, including outbox echo reconciliation.
    @discardableResult
    public func applyChatHistoryPage(sessionId: String, messages: [MessageRecord],
                                     hasMore: Bool, page: ChatHistoryPage) throws -> ChatHistoryCoverage? {
        guard messages.allSatisfy({ $0.sessionId == sessionId && $0.seq > 0 }),
              !hasMore || !messages.isEmpty else { throw ChatHistoryStoreError.invalidPage }
        return try performWrite { db in
            guard let coverage = try Self.fetchChatHistoryCoverage(db, sessionId: sessionId) else { return nil }
            let previous = coverage.marker
            var next: ChatHistoryMarker
            switch page {
            case .newest(let checkedThrough):
                let oldest = messages.map(\.seq).min()
                let newest = messages.map(\.seq).max()
                next = ChatHistoryMarker(sessionId: sessionId, newestLoaded: true,
                                         oldestRawSeq: oldest, newestRawSeq: newest, serverHasMore: hasMore,
                                         checkedThroughSeq: max(checkedThrough, newest ?? 0))
                // Union only overlapping or numerically adjacent coverage.
                // A disjoint refresh must not hide the intervening gap.
                if let previous, let oldFirst = previous.oldestRawSeq, let oldLast = previous.newestRawSeq,
                   let first = oldest, let last = newest,
                   first <= oldLast + 1, oldFirst <= last + 1 {
                    next.oldestRawSeq = min(oldFirst, first)
                    next.newestRawSeq = max(oldLast, last)
                    next.checkedThroughSeq = max(previous.checkedThroughSeq, next.checkedThroughSeq)
                    next.serverHasMore = hasMore && previous.serverHasMore
                }
            case .older(let before):
                guard var marker = previous, marker.oldestRawSeq == before,
                      messages.allSatisfy({ $0.seq < before }) else { throw ChatHistoryStoreError.staleBackwardPage }
                if let oldest = messages.map(\.seq).min() { marker.oldestRawSeq = oldest }
                marker.serverHasMore = hasMore
                next = marker
            }
            for message in messages { try Self.insertMessage(message, db) }
            // Learning a higher server seq is safe; claiming its missing
            // prefix is not. Keep updatedAt authoritative to session updates.
            if let newest = messages.map(\.seq).max(), newest > coverage.seq {
                try db.execute(sql: "UPDATE session SET seq = ? WHERE id = ?", arguments: [newest, sessionId])
            }
            if let previous { _ = try next.updateChanges(db, from: previous) }
            else { try next.insert(db) }
            return try Self.fetchChatHistoryCoverage(db, sessionId: sessionId)
        }
    }

    private static func fetchChatHistoryCoverage(_ db: Database, sessionId: String) throws -> ChatHistoryCoverage? {
        guard let row = try Row.fetchOne(db, sql: "SELECT seq, syncedMessageSeq FROM session WHERE id = ?",
                                        arguments: [sessionId]) else { return nil }
        return ChatHistoryCoverage(sessionId: sessionId, seq: row["seq"], syncedMessageSeq: row["syncedMessageSeq"],
                                   marker: try ChatHistoryMarker.fetchOne(db, key: sessionId))
    }
}