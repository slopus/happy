import Foundation
import GRDB

/// A fetched message page. Each page keeps its own final-page/gap cursor;
/// batching changes only the transaction boundary.
public struct MessagePageWrite: Sendable {
    public var sessionId: String
    public var messages: [MessageRecord]
    public var syncedThrough: Int?

    public init(sessionId: String, messages: [MessageRecord], syncedThrough: Int? = nil) {
        self.sessionId = sessionId
        self.messages = messages
        self.syncedThrough = syncedThrough
    }
}